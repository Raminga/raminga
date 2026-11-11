#!/bin/bash
# Run the real interactive pty test. On a normal macOS shell this uses the
# host /dev/ptmx. Restricted sandboxes that deny openpty fall back to the same
# test inside Linux Docker, with a clear notice (never silently skip).
set -uo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/raminga-interactive.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

hostlog="$tmp/host.log"
if ( cd "$root" && RAMINGA_INTERACTIVE_TUI=1 go test ./tests/e2e/interactive -run '^TestInteractiveTUI$' -count=1 -v ) >"$hostlog" 2>&1; then
  cat "$hostlog"
  exit 0
fi
if ! grep -q "operation not permitted" "$hostlog"; then
  cat "$hostlog" >&2
  exit 1
fi
echo "interactive-tui-test: host pty unavailable (sandbox openpty EPERM); running Linux Docker pty test" >&2

image="raminga-g45-smoke:local"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" -f "$root/tests/e2e/Dockerfile" "$root" >"$tmp/build.log" 2>&1 || { tail -20 "$tmp/build.log" >&2; exit 1; }
fi
arch="$(docker run --rm --entrypoint uname "$image" -m)"
case "$arch" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo "unsupported container arch: $arch" >&2; exit 1 ;;
esac
( cd "$root" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go test -c ./tests/e2e/interactive -o "$tmp/interactive.test" )
( cd "$root" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o "$tmp/raminga-linux" ./cmd/raminga )
docker run --rm -v "$root:/src:ro" -v "$tmp:/in:ro" \
  -e RAMINGA_INTERACTIVE_TUI=1 \
  -e RAMINGA_TEST_BINARY=/in/raminga-linux \
  -e RAMINGA_REPO_ROOT=/src \
  --entrypoint /in/interactive.test "$image" -test.run '^TestInteractiveTUI$' -test.v
