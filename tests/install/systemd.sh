#!/bin/sh
# Run the isolated install.sh --service tests. The tests need a Linux kernel,
# root inside a disposable container, and a real raminga binary; they do NOT
# need real systemd. systemctl/journalctl are replaced by test stand-ins in
# tests/install/fakebin, so this verifies the installer's logic and the real
# local API, not systemd's own unit parser or restart semantics.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
IMAGE=${RAMINGA_INSTALL_TEST_IMAGE:-alpine:3.22}

if ! command -v docker >/dev/null 2>&1; then
	printf 'install-test: BLOCKED: Docker is required (not found in PATH).\n' >&2
	exit 2
fi
if ! docker info >/dev/null 2>&1; then
	printf 'install-test: BLOCKED: Docker daemon is not reachable.\n' >&2
	exit 2
fi

DOCKER_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || true)
case "$DOCKER_ARCH" in
x86_64 | amd64) GOARCH=amd64 ;;
aarch64 | arm64) GOARCH=arm64 ;;
*)
	printf 'install-test: BLOCKED: unsupported Docker architecture %s.\n' "$DOCKER_ARCH" >&2
	exit 2
	;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/raminga-install-test.XXXXXX")
cleanup() {
	rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TMP/archive"
cp "$ROOT/scripts/install.sh" "$TMP/archive/install.sh"
chmod 0755 "$TMP/archive/install.sh"
# Keep the archive root-only: the non-root test must exercise install.sh's
# safe staging path instead of relying on the service user reading this mount.
chmod 0700 "$TMP/archive"

# Keep Go caches inside the repository when the caller did not configure them.
: "${GOCACHE:=$ROOT/.local/go-cache}"
: "${GOMODCACHE:=$ROOT/.local/go-mod}"
: "${GOPATH:=$ROOT/.local/go}"
export GOCACHE GOMODCACHE GOPATH
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH"

printf 'install-test: building linux/%s test binary\n' "$GOARCH"
(
	cd "$ROOT"
	CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
		go build -trimpath -ldflags '-s -w' -o "$TMP/archive/raminga" ./cmd/raminga
)
chmod 0755 "$TMP/archive/raminga"

printf 'install-test: running in Linux container (stub systemctl; real systemd NOT_TESTED)\n'
if docker run --rm --init --network none --platform "linux/$GOARCH" \
	-v "$TMP/archive:/archive:ro" \
	-v "$ROOT/tests/install:/tests:ro" \
	"$IMAGE" /bin/sh /tests/systemd-inner.sh /archive/install.sh /archive/raminga /tests/fakebin; then
	printf 'install-test: PASS (Linux container, stub systemctl; real systemd NOT_TESTED)\n'
else
	printf 'install-test: FAIL\n' >&2
	exit 1
fi
