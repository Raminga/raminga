#!/bin/sh
# Start the isolated second-batch item 5 DSH Web host. Never touches the user's
# DSH_HOME, ~/.raminga, the real desktop, or other acceptance ports.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${B5_HOST_PORT:-4386}
DATA_DIR=${B5_DATA_DIR:-"$ROOT/.local/prototype-remediation/b2-05-feed-editor/node-a"}
DSH_HOME=${B5_DSH_HOME:-"$ROOT/.local/prototype-remediation/b2-05-feed-editor/dsh-home"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}
PIDFILE=${B5_PIDFILE:-"$ROOT/.local/prototype-remediation/b2-05-feed-editor/evidence/dsh-$PORT.pid"}

if [ ! -x "$RAMINGA_BIN" ]; then
  echo "missing executable $RAMINGA_BIN; run make build" >&2
  exit 2
fi
if [ ! -d "$DSH_HOME/profiles/web" ]; then
  echo "missing isolated DSH profile $DSH_HOME/profiles/web; run prepare.mjs" >&2
  exit 2
fi
if [ ! -d "$DATA_DIR" ]; then
  echo "missing Raminga data directory $DATA_DIR; run prepare.mjs" >&2
  exit 2
fi

echo "BATCH2-05 host: port=$PORT"
echo "BATCH2-05 data=$DATA_DIR"
echo "BATCH2-05 DSH_HOME=$DSH_HOME"
echo "BATCH2-05 RAMINGA_BIN=$RAMINGA_BIN"

mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"
printf '{"pid":%s,"port":%s,"startedAt":"%s"}\n' "$$" "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PIDFILE.meta"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
