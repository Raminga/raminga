#!/bin/bash
# Automated TUI walkthrough against the real dualnat / ipv6fw lab daemons.
#
# The real `raminga tui` binary runs inside the container on a pty (`script`)
# and drives the shared UDS Connect API. Host-side steps stop the relays while
# the TUI observes whether the direct path survives. A background second TUI on
# the peer sends the reverse direction, so both ACK paths are exercised.
set -euo pipefail

lab="${1:?usage: tui-lab-verify.sh <lan|onesided|symmetric|dualnat|ipv6fw>}"
peer_a_name=""
peer_b_name=""
expect_con="已经中继"
expect_up="已升级为"
stop_flow=1
do_report=1
require_stop=1
require_upgrade=1
require_direct=1
min_acks=2
start_b=1
blocked_service=""
blocked_peer=""
case "$lab" in
  lan)     a_service=a4; b_service=b4; relay_services=(); peer_a_name=b4; peer_b_name=a4; expect_con="已建立直连"; expect_up=none; stop_flow=0; require_stop=0; require_upgrade=0; min_acks=1 ;;
  onesided) a_service=peer; b_service=pub; relay_services=(); peer_a_name=pub; peer_b_name=peer; expect_con="已建立直连"; expect_up=none; stop_flow=0; require_stop=0; require_upgrade=0; min_acks=1; blocked_service=pub; blocked_peer=peer ;;
  symmetric) a_service=a; b_service=b; relay_services=(relay); peer_a_name=b; peer_b_name=a; expect_con="已经中继"; expect_up=none; stop_flow=0; require_stop=0; require_upgrade=0; require_direct=0; min_acks=1 ;;
  dualnat) a_service=a-quic; b_service=b-quic; relay_services=(r1 r2); peer_a_name=b-quic; peer_b_name=a-quic ;;
  ipv6fw)  a_service=a-quic; b_service=b-quic; relay_services=(relay); peer_a_name=b-quic; peer_b_name=a-quic ;;
  *) echo "FAIL: unsupported TUI lab '$lab' (want lan|onesided|symmetric|dualnat|ipv6fw)" >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for TUI lab verification" >&2; exit 2; }
root="$(cd "$(dirname "$0")/../../.." && pwd)"
evidence="$root/tests/e2e/evidence/g45"
runid="$(date -u +%Y%m%dT%H%M%SZ)"
outdir="$root/.local/evidence/g45/${lab}-${runid}"
mkdir -p "$outdir"
project="raminga-lab-$lab"

apid=""
bpid=""
cleanup() {
  for pid in "$apid" "$bpid"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for service in "$a_service" "$b_service"; do
    c="$(container_name "$service" 2>/dev/null || true)"
    [ -n "$c" ] && docker exec "$c" pkill -f 'raminga tui' 2>/dev/null || true
  done
  ( cd "$root" && make lab-down LAB="$lab" >/dev/null 2>&1 ) || true
}
trap cleanup EXIT

container_name() {
  local service="$1"
  docker ps -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" | head -n1
}

echo "tui-lab-verify: starting $lab (log: $outdir/lab-up.log)"
if ! ( cd "$root" && make lab-up LAB="$lab" ) >"$outdir/lab-up.log" 2>&1; then
  echo "FAIL $lab: make lab-up failed; see $outdir/lab-up.log" >&2
  tail -20 "$outdir/lab-up.log" >&2 || true
  exit 1
fi

a="$(container_name "$a_service")"
b="$(container_name "$b_service")"
if [ -z "$a" ] || [ -z "$b" ]; then
  echo "FAIL $lab: lab containers not found" >&2
  exit 1
fi
if ! docker exec "$a" sh -c 'command -v raminga >/dev/null'; then
  echo "FAIL $lab: the lab image lacks raminga; rebuild with make lab-up" >&2
  exit 1
fi
a_peer="$(docker exec "$a" raminga status --json | jq -r .peerId)"
b_peer="$(docker exec "$b" raminga status --json | jq -r .peerId)"
if [ -z "$a_peer" ] || [ -z "$b_peer" ]; then
  echo "FAIL $lab: could not discover peers (a=$a_peer b=$b_peer)" >&2
  exit 1
fi

cat >"$outdir/a-keys.txt" <<KEYS
# Real interactive keys sent by tests/e2e/tuiwalk on a pty:
/connect $peer_a_name
/chat $peer_a_name
g45-tui-a-to-b
(wait for host to stop relays)
/mark 已停中继
g45-tui-a-still-direct
(wait for B pty driver ACK marker)
/report
/quit
KEYS
cat >"$outdir/b-keys.txt" <<KEYS
# Real interactive keys on a pty after relays stop:
/chat $peer_b_name
g45-tui-b-to-a
/quit
KEYS
docker exec "$a" sh -c 'rm -rf /data/report /data/tui-phase1 /data/tui-relays-stopped /data/tui-b-acked /data/tui-auto-error'
docker exec "$b" sh -c 'rm -f /data/tui-auto-error'

arch="$(docker exec "$a" uname -m)"
case "$arch" in
  aarch64|arm64) goarch=arm64 ;;
  x86_64|amd64) goarch=amd64 ;;
  *) echo "FAIL $lab: unsupported container arch $arch" >&2; exit 1 ;;
esac
( cd "$root" && CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" go build -o "$outdir/tuiwalk" ./tests/e2e/tuiwalk )
docker cp "$outdir/tuiwalk" "$a:/tmp/tuiwalk" >/dev/null
docker cp "$outdir/tuiwalk" "$b:/tmp/tuiwalk" >/dev/null

if [ -n "$blocked_service" ]; then
  bcont="$(container_name "$blocked_service")"
  echo "tui-lab-verify: expected BLOCKED /connect on $blocked_service"
  if ! docker exec "$bcont" /tmp/tuiwalk -role blocked -bin /usr/local/bin/raminga -data-dir /data \
      -peer "$blocked_peer" >"$outdir/blocked-tui.log" 2>&1; then
    echo "FAIL $lab: expected BLOCKED step did not fail cleanly" >&2
    tail -20 "$outdir/blocked-tui.log" >&2 || true
    exit 1
  fi
fi
echo "tui-lab-verify: interactive pty TUI on $a_service using name $peer_a_name"
docker exec "$a" /tmp/tuiwalk -role a -bin /usr/local/bin/raminga -data-dir /data \
  -peer "$peer_a_name" -phase-file /data/tui-phase1 \
  -stop-file /data/tui-relays-stopped -b-acked-file /data/tui-b-acked -report-dir /data/report \
  -expect-connect "$expect_con" -expect-upgrade "$expect_up" -stop-flow=$stop_flow -report=$do_report \
  >"$outdir/a-tui.log" 2>&1 &
apid=$!

ready=0
for _ in $(seq 1 240); do
  if docker exec "$a" test -f /data/tui-phase1 2>/dev/null; then ready=1; break; fi
  if ! kill -0 "$apid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL $lab: TUI did not reach direct + first ACK" >&2
  tail -30 "$outdir/a-tui.log" >&2 || true
  docker exec "$a" cat /data/tui-auto-error >&2 2>/dev/null || true
  exit 1
fi

if [ "$stop_flow" -eq 1 ]; then
  echo "tui-lab-verify: stopping relays: ${relay_services[*]}"
  for service in "${relay_services[@]}"; do
    rc="$(container_name "$service")"
    docker stop "$rc" >>"$outdir/relay-stop.log" 2>&1
  done
  docker exec "$a" sh -c 'touch /data/tui-relays-stopped'
fi

bpid=""
if [ "$start_b" -eq 1 ]; then
  echo "tui-lab-verify: reverse interactive pty TUI on $b_service"
  docker exec "$b" /tmp/tuiwalk -role b -bin /usr/local/bin/raminga -data-dir /data \
    -peer "$peer_b_name" -b-acked-file /data/tui-b-acked \
    >"$outdir/b-tui.log" 2>&1 &
  bpid=$!
fi

arc=0; brc=0
if [ -n "$bpid" ]; then
  wait "$bpid" || brc=$?
  bpid=""
  if [ "$brc" -ne 0 ]; then
    echo "FAIL $lab: reverse TUI exit=$brc" >&2
    tail -30 "$outdir/b-tui.log" >&2 || true
    exit 1
  fi
  if [ "$stop_flow" -eq 1 ]; then
    docker exec "$a" sh -c 'touch /data/tui-b-acked'
  fi
fi
wait "$apid" || arc=$?
apid=""
if [ "$arc" -ne 0 ]; then
  echo "FAIL $lab: TUI exit codes a=$arc b=$brc" >&2
  tail -30 "$outdir/a-tui.log" >&2 || true
  tail -30 "$outdir/b-tui.log" >&2 || true
  docker exec "$a" cat /data/tui-auto-error >&2 2>/dev/null || true
  docker exec "$b" cat /data/tui-auto-error >&2 2>/dev/null || true
  exit 1
fi

docker exec "$a" cat /data/report/test-report.json >"$outdir/test-report.json"
docker exec "$a" cat /data/report/test-report.md >"$outdir/test-report.md"

( cd "$root" && go run ./tests/e2e/g45 \
    -report "${outdir#"$root"/}/test-report.json" \
    -schema docs/schemas/test-report.schema.json \
    -forbid "g45-tui-a-to-b,g45-tui-a-still-direct,g45-tui-b-to-a" \
    -summary "$outdir/validation.json" \
    -min-acks "$min_acks" -require-still-direct=$require_stop -require-relay-upgrade=$require_upgrade -require-direct=$require_direct \
    -lab "$lab" )

# Convert raw validation to the compact tracked summary; full reports/logs/
# keystrokes and the tuiwalk binary stay under .local/evidence.
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
branch="$(cd "$root" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
commit="$(cd "$root" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
gover="$(go version 2>/dev/null | awk '{print $3}')"
dockerver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
jq -n --arg lab "$lab" --arg ts "$now" --arg branch "$branch" --arg commit "$commit" --arg go "$gover" --arg docker "$dockerver" \
  --slurpfile v "$outdir/validation.json" \
  '{generated_at:$ts,branch:$branch,commit:$commit,go_version:$go,docker_version:$docker,topology:$lab,lab:$lab,result:$v[0].result,report:$v[0].report,checks:($v[0].checks|to_entries|map({name:.key,pass:.value,detail:""}))}' \
  >"$outdir/summary-input.json"
summary="$(cd "$root" && go run ./tests/e2e/evsummary -in "$outdir/summary-input.json" -phase g45 -base "$lab" -out "$evidence" -root "$root" -pointer=false)"
summary_name="$(basename "$summary")"
tmp="$evidence/LATEST.tmp"
if [ -f "$evidence/LATEST" ]; then
  grep -E '^[a-z0-9-]+=' "$evidence/LATEST" | grep -v "^$lab=" >"$tmp" || true
fi
echo "$lab=$summary_name" >>"$tmp"
mv "$tmp" "$evidence/LATEST"
{
  echo "TUI_LAB_VERIFY_PASS lab=$lab at=$now"
  echo "summary=${summary#"$root"/}"
  echo "raw=${outdir#"$root"/}"
} >"$outdir/result.txt"
echo "PASS tui-lab-verify $lab (summary: $summary; raw: ${outdir#"$root"/})"
