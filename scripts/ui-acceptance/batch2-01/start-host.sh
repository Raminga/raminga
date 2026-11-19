#!/bin/sh
# Start one isolated DSH Web host for the second-batch item 1 fixture. It never
# touches the user's DSH_HOME, ~/.raminga, the real desktop, 4354 or 4321/4332.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${BATCH2_HOST_PORT:-4370}
DATA_DIR=${BATCH2_DATA_DIR:-"$ROOT/.local/prototype-remediation/b2-home/avatar-short"}
DSH_HOME=${BATCH2_DSH_HOME:-"$ROOT/.local/prototype-remediation/b2-home/dsh-home"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}
PIDFILE=${BATCH2_PIDFILE:-"$ROOT/.local/prototype-remediation/b2-home/dsh-$PORT.pid"}

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

echo "BATCH2-01 host: port=$PORT"
echo "BATCH2-01 data=$DATA_DIR"
echo "BATCH2-01 DSH_HOME=$DSH_HOME"
echo "BATCH2-01 RAMINGA_BIN=$RAMINGA_BIN"

mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
