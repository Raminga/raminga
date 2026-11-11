#!/bin/bash
# Literal cheat-sheet self-test for a running manual lab.
#
# Usage: tests/e2e/g3/lab-verify.sh <lan|onesided|symmetric|dualnat|ipv6fw>
#
# It extracts every `docker exec`, `docker stop` and `docker start` line from
# the ```sh``` fences of .local/lab/<lab>.md and runs it as-is, except that:
#   - `docker exec -it` becomes `docker exec` (no TTY in automation);
#   - `raminga chat events` runs in the background with `--timeout 45s`.
# Commands are executed in document order, including stop/start commands. A
# non-zero status, a missing chat ACK, empty event output or missing chat text
# fails the lab.
set -u

lab="${1:?usage: lab-verify.sh <lan|onesided|symmetric|dualnat|ipv6fw>}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
md="$root/.local/lab/$lab.md"
if [ ! -f "$md" ]; then
  echo "FAIL $lab: missing $md (run make lab-up LAB=$lab first)" >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/raminga-lab-verify.XXXXXX")"
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
pids=()
logs=()
commands=()
awk '
  /^```(sh|bash)$/ { inblock=1; next }
  /^```$/          { inblock=0; next }
  inblock          { print }
' "$md" | grep -E '^docker (exec|stop|start) ' > "$tmp/commands" || true

if [ ! -s "$tmp/commands" ]; then
  echo "FAIL $lab: no executable docker commands found in $md" >&2
  exit 1
fi

# Every multiaddr listed under a node's "实际多地址" section must end in that
# node's own Peer ID. This catches a cheat sheet that copied another node's
# address (the onesided sheet used to list pub's address under peer).
awk -F'|' '
  /^\| [A-Za-z0-9_-]+ \| `raminga-lab-/ {
    service=$2; gsub(/^[ \t]+|[ \t]+$/, "", service);
    peer=$4; gsub(/[ \t`]/, "", peer);
    if (service != "" && peer != "") print service, peer;
  }
' "$md" > "$tmp/node-peers"
awk '
  /^\*\*[A-Za-z0-9_-]+\*\* \(`raminga-lab-/ {
    line=$0; sub(/^\*\*/, "", line); sub(/\*\*.*/, "", line);
    service=line; inblock=0; next
  }
  /^```text$/ { if (service != "") inblock=1; next }
  /^```$/ { inblock=0; next }
  inblock && service != "" && $0 ~ /\/p2p\// { print service, $0 }
' "$md" > "$tmp/node-addrs"
addr_checked=0
while read -r service addr; do
  [ -n "$service" ] || continue
  want="$(awk -v s="$service" '$1 == s {print $2; exit}' "$tmp/node-peers")"
  if [ -z "$want" ]; then
    echo "FAIL $lab: multiaddr listed under unknown node '$service': $addr" >&2
    exit 1
  fi
  got="$(printf '%s\n' "$addr" | sed -n 's#.*/p2p/\([^/]*\)$#\1#p')"
  if [ "$got" != "$want" ]; then
    echo "FAIL $lab: address does not belong to $service (want $want, got '${got:-none}'): $addr" >&2
    exit 1
  fi
  addr_checked=$((addr_checked + 1))
done < "$tmp/node-addrs"

fail=0
run_no=0
while IFS= read -r line; do
  run_no=$((run_no + 1))
  cmd="${line/docker exec -it /docker exec }"
  if [[ "$cmd" == *"raminga chat events"* ]]; then
    log="$tmp/events-$run_no.log"
    echo "START $run_no: $cmd --timeout 45s"
    bash -c "$cmd --timeout 45s" >"$log" 2>&1 &
    pids+=($!)
    logs+=("$log")
    continue
  fi
  echo "RUN   $run_no: $cmd"
  out="$(bash -c "$cmd" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL $lab command $run_no exit=$rc" >&2
    printf '%s\n' "$out" | tail -8 >&2
    fail=$((fail + 1))
    continue
  fi
  if [[ "$cmd" == *"raminga chat send"* ]] && ! grep -q 'acked: true' <<<"$out"; then
    echo "FAIL $lab command $run_no did not report acked: true" >&2
    printf '%s\n' "$out" | tail -8 >&2
    fail=$((fail + 1))
  fi
  if [[ "$cmd" == *"expected-BLOCKED"* ]] && ! grep -q 'expected-BLOCKED' <<<"$out"; then
    echo "FAIL $lab command $run_no did not report expected-BLOCKED" >&2
    printf '%s\n' "$out" | tail -8 >&2
    fail=$((fail + 1))
  fi
  if [[ "$cmd" == *"expected-BLOCKED"* ]] && grep -qiE 'dial backoff|backing off' <<<"$out"; then
    echo "FAIL $lab command $run_no expected a real timeout but hit dial backoff (lab-up self-check must not dial first)" >&2
    printf '%s\n' "$out" | tail -8 >&2
    fail=$((fail + 1))
  fi
  if [[ "$cmd" == *"expected-BLOCKED"* ]] && grep -q 'expected-BLOCKED' <<<"$out"; then
    printf '  BLOCKED evidence: %s\n' "$(printf '%s\n' "$out" | grep -v '^expected-BLOCKED$' | tail -3 | tr '\n' ' ')"
  fi
  if [ "$lab" = "onesided" ] && [[ "$cmd" == *"connect /ip4/10.252.1.10"* ]] && ! grep -qE 'i/o timeout|deadline exceeded' <<<"$out"; then
    echo "FAIL $lab command $run_no did not show a real timeout for the reverse dial" >&2
    printf '%s\n' "$out" | tail -8 >&2
    fail=$((fail + 1))
  fi
done < "$tmp/commands"

text_found=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}"
  rc=$?
  log="${logs[$i]}"
  if [ "$rc" -ne 0 ]; then
    echo "FAIL $lab event stream $((i + 1)) exit=$rc" >&2
    tail -8 "$log" >&2 || true
    fail=$((fail + 1))
    continue
  fi
  if [ ! -s "$log" ]; then
    echo "FAIL $lab event stream $((i + 1)) produced no output" >&2
    fail=$((fail + 1))
    continue
  fi
  if grep -q 'text="' "$log"; then
    text_found=1
  fi
done

if [ "$text_found" -ne 1 ]; then
  echo "FAIL $lab: no event stream showed chat text" >&2
  fail=$((fail + 1))
fi

if [ "$fail" -ne 0 ]; then
  echo "FAIL $lab: $fail failure(s), $run_no commands executed, $addr_checked node multiaddrs checked, events text_found=$text_found"
  exit 1
fi
echo "PASS $lab: $run_no commands executed literally, $addr_checked node multiaddrs owned correctly, events text_found=$text_found"
