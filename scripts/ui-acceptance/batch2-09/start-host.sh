#!/bin/sh
# Start the isolated second-batch item 7 DSH Web host. Never touches the user's
# DSH_HOME, ~/.raminga, the desktop, or another acceptance port.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${B9_HOST_PORT:-4406}
CONTROL_PORT=${B9_CONTROL_PORT:-4371}
DSH_HOME=${B9_DSH_HOME:-"$ROOT/.local/prototype-remediation/b2-09-human-avatar/dsh-home"}
HOME_DIR=${B9_HOME:-"$ROOT/.local/prototype-remediation/b2-09-human-avatar/home"}
DATA_DIR=${B9_DATA_DIR:-"$ROOT/.local/prototype-remediation/b2-09-human-avatar/node-a"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}
PIDFILE=${B9_PIDFILE:-"$ROOT/.local/prototype-remediation/b2-09-human-avatar/evidence/dsh-$PORT.pid"}

if [ ! -x "$RAMINGA_BIN" ]; then
  echo "missing executable $RAMINGA_BIN; run make build" >&2
  exit 2
fi
if [ ! -d "$DSH_HOME/profiles/web" ]; then
  echo "missing isolated DSH profile $DSH_HOME/profiles/web; run prepare.mjs" >&2
  exit 2
fi
mkdir -p "$HOME_DIR"
if [ ! -d "$DATA_DIR" ]; then
  echo "missing Raminga data directory $DATA_DIR; run prepare.mjs" >&2
  exit 2
fi

echo "BATCH2-09 host: port=$PORT control=$CONTROL_PORT"
echo "BATCH2-09 data=$DATA_DIR"
echo "BATCH2-09 HOME=$HOME_DIR"
echo "BATCH2-09 DSH_HOME=$DSH_HOME"
echo "BATCH2-09 RAMINGA_BIN=$RAMINGA_BIN"

mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"
printf '{"pid":%s,"port":%s,"controlPort":%s,"startedAt":"%s"}\n' "$$" "$PORT" "$CONTROL_PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PIDFILE.meta"

exec env -u DSH_PROFILE -u DSH_HOME \
  HOME="$HOME_DIR" \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  C1_CONTROL_PORT="$CONTROL_PORT" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
