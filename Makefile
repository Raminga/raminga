SHELL := /bin/sh
GO ?= go

# Keep module/build/buf caches inside the repo workspace so checks are
# reproducible and do not require global tool installs.
export GOMODCACHE ?= $(CURDIR)/.local/go-mod
export GOCACHE ?= $(CURDIR)/.local/go-cache
export GOPATH ?= $(CURDIR)/.local/go
export BUF_CACHE_DIR ?= $(CURDIR)/.local/buf-cache
export GOLANGCI_LINT_CACHE ?= $(CURDIR)/.local/golangci-cache
export GOFLAGS ?= -mod=readonly

# Docker buildx needs a writable CLI config dir. Some restricted sandboxes
# mount ~/.docker read-only; fall back to a workspace-local config there while
# leaving normal user configuration untouched otherwise.
ifeq ($(origin DOCKER_CONFIG),undefined)
ifeq ($(shell test -w $(HOME)/.docker && echo yes),yes)
else
DOCKER_CONFIG := $(CURDIR)/.local/docker-config
ifeq ($(shell uname -s),Darwin)
DOCKER_HOST ?= unix://$(HOME)/.docker/run/docker.sock
else
DOCKER_HOST ?= unix:///var/run/docker.sock
endif
export DOCKER_CONFIG DOCKER_HOST
$(shell mkdir -p $(DOCKER_CONFIG) && ln -sfn $(HOME)/.docker/cli-plugins $(DOCKER_CONFIG)/cli-plugins)
endif
endif

.PHONY: check vet lint buf-lint test fuzz-seed genplugins-check fuzz vuln licenses generate build install cross e2e e2e-g1 e2e-g2 e2e-g3 e2e-g4 e2e-plugins soak lab-up lab-down lab-status lab-verify tui-lab-verify interactive-tui-test dist dist-check dist-verify platform-smoke clean

check: vet lint buf-lint test fuzz-seed genplugins-check

vet:
	$(GO) vet ./...

lint:
	$(GO) tool golangci-lint run ./...

buf-lint:
	$(GO) tool buf lint

test:
	$(GO) test -race ./...

# Seed-corpus execution only; long fuzzing is a G4 activity.
fuzz-seed:
	$(GO) test ./internal/protocol -run '^Fuzz' -count=1
	$(GO) test ./internal/api -run '^Fuzz' -count=1

genplugins-check:
	$(GO) run ./scripts/genplugins -root . -check

FUZZ_TIME ?= 60s

# Bounded native fuzzing. Each target gets its own process so a crash keeps the
# regression seed and the remaining targets still run.
fuzz:
	@echo "fuzz FuzzDecodeChatRequest $(FUZZ_TIME)"
	@$(GO) test ./internal/protocol -run '^$$' -fuzz '^FuzzDecodeChatRequest$$' -fuzztime $(FUZZ_TIME)
	@echo "fuzz FuzzAPIRequestDecoding $(FUZZ_TIME)"
	@$(GO) test ./internal/api -run '^$$' -fuzz '^FuzzAPIRequestDecoding$$' -fuzztime $(FUZZ_TIME)
	@mkdir -p $(G4_EVIDENCE)
	@echo "FUZZ_ALL_PASS targets=2 fuzztime=$(FUZZ_TIME) at=$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > $(G4_EVIDENCE)/fuzz.txt

G4_EVIDENCE ?= tests/e2e/evidence/g4

vuln:
	@mkdir -p $(G4_EVIDENCE)
	@$(GO) tool govulncheck ./... > $(G4_EVIDENCE)/vuln.txt 2>&1; code=$$?; cat $(G4_EVIDENCE)/vuln.txt; \
	if [ $$code -eq 0 ]; then exit 0; fi; \
	ids=$$(grep -o 'GO-[0-9-]*' $(G4_EVIDENCE)/vuln.txt | sort -u); \
	if [ -z "$$ids" ]; then exit $$code; fi; \
	for id in $$ids; do \
	  grep -q "$$id" docs/supply-chain/vuln-disposition.md || { echo "vuln: $$id has no documented disposition" >&2; exit $$code; }; \
	done; \
	echo "vuln: all reachable vulnerability IDs have a documented disposition (docs/supply-chain/vuln-disposition.md)"

licenses:
	@mkdir -p $(G4_EVIDENCE)
	@$(GO) tool go-licenses report ./... > $(G4_EVIDENCE)/licenses.txt 2> $(G4_EVIDENCE)/licenses.err || true
	@$(GO) tool go-licenses report ./cmd/raminga > $(G4_EVIDENCE)/licenses-shipped.txt 2>> $(G4_EVIDENCE)/licenses.err || true
	@cat $(G4_EVIDENCE)/licenses-shipped.txt
	@if grep -Eiq 'GPL-3|GPLv3|AGPL|SSPL' $(G4_EVIDENCE)/licenses-shipped.txt; then \
	  echo "licenses: non-permissive license in shipped dependency set" >&2; exit 1; \
	fi
	@unknowns=$$(awk -F, '$$3=="Unknown"{print $$1}' $(G4_EVIDENCE)/licenses-shipped.txt); \
	for m in $$unknowns; do \
	  grep -q "^$$m," docs/supply-chain/license-allowlist.txt || { echo "licenses: Unknown license for $$m is not allowlisted" >&2; exit 1; }; \
	done
	@echo "licenses: shipped dependency set has no GPL-3/AGPL/SSPL entries; Unknown entries are documented (report: $(G4_EVIDENCE)/licenses.txt)"

generate:
	$(GO) tool buf generate

build:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w" -o bin/raminga ./cmd/raminga

PREFIX ?=
install: build
	@if [ -n "$(PREFIX)" ]; then sh scripts/install.sh --prefix "$(PREFIX)"; else sh scripts/install.sh; fi

cross:
	@set -e; for os in darwin linux windows; do \
	  for arch in amd64 arm64; do \
	    out="$(CURDIR)/.local/cross/$$os-$$arch/raminga"; \
	    mkdir -p "$$(dirname "$$out")"; \
	    echo "build $$os/$$arch"; \
	    CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -o "$$out" ./cmd/raminga; \
	  done; \
	done

E2E_SUITES ?= g1,g2,g3
SOAK_DURATION ?= 30m

e2e:
	$(GO) run ./tests/e2e -suites $(E2E_SUITES)

e2e-g1:
	$(GO) run ./tests/e2e/g1 -project raminga-g1-e2e

e2e-g2:
	$(GO) run ./tests/e2e/g2 -project raminga-g2-e2e

e2e-g3:
	$(GO) run ./tests/e2e/g3

e2e-g4:
	$(GO) run ./tests/e2e/g4

# The soak uses the G3 dual-NAT QUIC topology plus R1/R2 and must be run for
# G4 acceptance. It is separate so routine e2e stays short.
soak:
	$(GO) run ./tests/e2e/g4 -soak -soak-duration $(SOAK_DURATION)

LAB ?=
lab-up:
	@test -n "$(LAB)" || (echo "LAB is required: make lab-up LAB=<lan|onesided|symmetric|dualnat|ipv6fw>" >&2; exit 2)
	$(GO) run ./tests/e2e/g3 -lab $(LAB) -up

lab-down:
	@test -n "$(LAB)" || (echo "LAB is required: make lab-down LAB=<lan|onesided|symmetric|dualnat|ipv6fw>" >&2; exit 2)
	$(GO) run ./tests/e2e/g3 -lab $(LAB) -down

lab-status:
	@test -n "$(LAB)" || (echo "LAB is required: make lab-status LAB=<lan|onesided|symmetric|dualnat|ipv6fw>" >&2; exit 2)
	$(GO) run ./tests/e2e/g3 -lab $(LAB) -status

lab-verify:
	@test -n "$(LAB)" || (echo "LAB is required: make lab-verify LAB=<lan|onesided|symmetric|dualnat|ipv6fw>" >&2; exit 2)
	./tests/e2e/g3/lab-verify.sh $(LAB)

# G4.5.1: the real TUI binary is driven on a pty inside the running lab with
# slash commands; dualnat/ipv6fw also stop relays and verify still-direct.
tui-lab-verify:
	@test -n "$(LAB)" || (echo "LAB is required: make tui-lab-verify LAB=<lan|onesided|symmetric|dualnat|ipv6fw>" >&2; exit 2)
	tests/e2e/g45/tui-lab-verify.sh $(LAB)

# GoReleaser is pinned and runs from its own module graph. Adding it as a
# go.mod tool would pull its large dependency set into the node's go.mod/go.sum
# and risk conflicts with the pinned libp2p/lint graph; `go run pkg@version`
# keeps the node build graph unchanged and is still reproducible. Snapshot is
# unsigned and produces six CGO_ENABLED=0 archives + SHA256SUMS.
dist:
	CGO_ENABLED=0 $(GO) run github.com/goreleaser/goreleaser/v2@v2.19.0 release --snapshot --clean
	@test -f dist/SHA256SUMS || (echo "dist: SHA256SUMS missing" >&2; exit 1)

# Same release pipeline as `make dist`, but into a throwaway dist directory so
# the checked-in/ignored dist/ tree is never modified. The repo-local module
# cache is preferred; | falls back to the network on a fresh cache.
DIST_GOPROXY ?= file://$(GOMODCACHE)/cache/download|https://proxy.golang.org,direct
dist-check:
	@set -e; \
	tmp="$$(mktemp -d "$${TMPDIR:-/tmp}/raminga-dist-check.XXXXXX")"; \
	trap 'rm -rf "$$tmp"' EXIT HUP INT TERM; \
	cfg="$$tmp/goreleaser.yaml"; \
	cp .goreleaser.yaml "$$cfg"; \
	printf '\ndist: "%s"\n' "$$tmp/out" >> "$$cfg"; \
	GOPROXY="$(DIST_GOPROXY)" CGO_ENABLED=0 $(GO) run github.com/goreleaser/goreleaser/v2@v2.19.0 release --snapshot --clean -f "$$cfg"; \
	test -f "$$tmp/out/SHA256SUMS" || { echo "dist-check: SHA256SUMS missing" >&2; exit 1; }; \
	echo "dist-check: PASS ($$tmp/out/SHA256SUMS)"

dist-verify:
	@test -f dist/SHA256SUMS || (echo "dist: run make dist first" >&2; exit 1)
	sh scripts/verify-dist.sh dist

# Real pty test on the host: two real daemons, interactive keystrokes
# (connect -> switch views -> chat -> ACK -> report -> q). Requires a normal
# terminal/ptmx; restricted CI sandboxes may block openpty.
interactive-tui-test:
	tests/e2e/interactive/run.sh

platform-smoke:
	tests/e2e/platform-smoke.sh

# Plugin-shell MCP smoke: launcher -> stdio JSON-RPC -> tools/status/agent_init,
# plus the only-bin default data dir and no-identity agent_init scenarios.
# Temporary HOME/RAMINGA_DATA_DIR only; the daemon is stopped before exit.
e2e-plugins: build
	$(GO) run ./tests/e2e/plugins -root .

clean:
	rm -rf bin .local/cross
