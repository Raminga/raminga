#!/bin/bash
# G4.5 platform smoke: macOS host and Linux Docker.
#
# It builds the real binary, starts real daemons with local UDP/TCP listeners,
# drives the CLI (status/connect/chat) and runs the TUI on a pty. This is a
# smoke test, not public-network M6. Windows is cross-built only and is
# explicitly NOT_TESTED here.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/raminga-smoke.XXXXXX")"
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

# Docker Desktop may keep its buildx activity under ~/.docker, which a
# restricted CI sandbox can deny. Use a workspace-local CLI config (the same
# fallback as the Makefile) while keeping the user's docker context.
if [ -z "${DOCKER_CONFIG:-}" ] && ! ( : >"${HOME}/.docker/buildx/.activity-probe" ) 2>/dev/null; then
  export DOCKER_CONFIG="$root/.local/docker-config"
  mkdir -p "$DOCKER_CONFIG"
  ln -sfn "${HOME}/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
  export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.docker/run/docker.sock}"
fi

export GOMODCACHE="${GOMODCACHE:-$root/.local/go-mod}"
export GOCACHE="${GOCACHE:-$root/.local/go-cache}"
export GOPATH="${GOPATH:-$root/.local/go}"

bin="$tmp/raminga"
echo "platform-smoke: building host binary"
CGO_ENABLED=0 go build -trimpath -o "$bin" ./cmd/raminga

wait_status() {
  local dir="$1" tries=120
  while [ "$tries" -gt 0 ]; do
    if "$bin" status --data-dir "$dir" >/dev/null 2>&1; then return 0; fi
    tries=$((tries - 1))
    sleep 0.1
  done
  return 1
}

run_tui_pty() {
  # $1 = data dir, $2 = log path
  local dir="$1" log="$2"
  printf '/status
/report
/quit
' >"$dir/tui-script"
  if [ "$(uname -s)" = "Darwin" ]; then
    # The macOS host automation path has no pty in restricted CI shells; the
    # --pipe mode still runs the real model/client. Linux uses the pty below.
    "$bin" tui --data-dir "$dir" --plain --pipe --script "$dir/tui-script" --report-dir "$dir/reports" >"$log" 2>&1
  else
    script -q -e -c "$bin tui --data-dir $dir --plain --script $dir/tui-script --report-dir $dir/reports" /dev/null >"$log" 2>&1
  fi
  test -f "$dir/reports/test-report.json" || { echo "TUI did not export a report" >&2; tail -20 "$log" >&2; return 1; }
}

host_smoke() {
  echo "platform-smoke: macOS host (two real daemons + CLI + TUI pty)"
  local a="$tmp/host-a" b="$tmp/host-b"
  "$bin" init --data-dir "$a" --listen /ip4/127.0.0.1/tcp/24101 --listen /ip4/127.0.0.1/udp/24101/quic-v1 >/dev/null
  "$bin" init --data-dir "$b" --listen /ip4/127.0.0.1/tcp/24102 --listen /ip4/127.0.0.1/udp/24102/quic-v1 >/dev/null
  "$bin" daemon --data-dir "$a" --log-level error >"$tmp/host-a.log" 2>&1 &
  pids+=($!)
  "$bin" daemon --data-dir "$b" --log-level error >"$tmp/host-b.log" 2>&1 &
  pids+=($!)
  wait_status "$a" && wait_status "$b" || { echo "host daemons failed" >&2; tail -20 "$tmp/host-a.log" "$tmp/host-b.log" >&2; return 1; }
  local a_peer a_addr b_peer
  a_peer="$("$bin" status --data-dir "$a" --json | jq -r .peerId)"
  b_peer="$("$bin" status --data-dir "$b" --json | jq -r .peerId)"
  a_addr="$("$bin" status --data-dir "$a" --json | jq -r '.listenAddrs[] | select(contains("/tcp/"))' | head -n1)"
  "$bin" connect "$a_addr/p2p/$a_peer" --data-dir "$b" >"$tmp/host-connect.txt"
  "$bin" chat send --to "$a_peer" --text "g45 platform smoke host" --data-dir "$b" >"$tmp/host-chat.txt"
  grep -q 'acked: true' "$tmp/host-chat.txt"
  run_tui_pty "$a" "$tmp/host-tui.log"
  echo "PASS platform-smoke macOS host: CLI connect/chat ACK, TUI automation (no pty) + report ($b_peer -> $a_peer)"
}

linux_smoke() {
  echo "platform-smoke: Linux Docker (real daemon + CLI + TUI pty)"
  local image="raminga-g45-smoke:local"
  # Always rebuild from the current tree (Docker layer cache keeps it cheap) so
  # the image cannot silently contain an older binary without the TUI.
  docker build -t "$image" -f tests/e2e/Dockerfile . >"$tmp/linux-build.log" 2>&1 || {
    echo "Linux smoke image build failed; see $tmp/linux-build.log" >&2
    tail -20 "$tmp/linux-build.log" >&2
    return 1
  }
  docker run --rm --entrypoint /bin/sh -v "$root/docs/schemas:/schemas:ro" "$image" -c '
    set -eu
    export RAMINGA_DATA_DIR=/tmp/smoke
    raminga init --data-dir /tmp/smoke >/dev/null
    raminga daemon --data-dir /tmp/smoke --log-level error >/tmp/daemon.log 2>&1 &
    pid=$!
    trap "kill $pid 2>/dev/null || true" EXIT
    i=0; while [ $i -lt 120 ]; do raminga status --data-dir /tmp/smoke >/dev/null 2>&1 && break; i=$((i+1)); sleep 0.1; done
    raminga status --data-dir /tmp/smoke >/tmp/status.txt
    printf "/status\n/report\n/quit\n" >/tmp/smoke/tui-script
    script -q -e -c "raminga tui --data-dir /tmp/smoke --plain --script /tmp/smoke/tui-script --report-dir /tmp/smoke/reports" /dev/null >/tmp/tui.log 2>&1
    test -f /tmp/smoke/reports/test-report.json
    grep -q "peer_id" /tmp/status.txt
    echo "PASS platform-smoke Linux Docker: daemon + CLI + TUI pty + report"
  '
  # Real interactive pty: two daemons + real TUI, connect -> views -> chat ->
  # ACK -> report -> q. This is the same test as make interactive-tui-test.
  local arch testbin nodebin
  arch="$(docker run --rm --entrypoint uname "$image" -m)"
  case "$arch" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) echo "unsupported Linux smoke arch: $arch" >&2; return 1 ;;
  esac
  testbin="$tmp/interactive.test"
  nodebin="$tmp/raminga-linux"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go test -c ./tests/e2e/interactive -o "$testbin"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o "$nodebin" ./cmd/raminga
  docker run --rm -v "$root:/src:ro" -v "$tmp:/in:ro" \
    -e RAMINGA_INTERACTIVE_TUI=1 \
    -e RAMINGA_TEST_BINARY=/in/raminga-linux \
    -e RAMINGA_REPO_ROOT=/src \
    --entrypoint /in/interactive.test "$image" -test.run '^TestInteractiveTUI$' -test.v
  echo "PASS platform-smoke Linux Docker: interactive pty connect/chat/ACK/report/q"
}

host_smoke
linux_smoke
