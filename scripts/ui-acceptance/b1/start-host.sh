#!/bin/sh
# Start the isolated first-batch-B DSH Web host in the foreground. It never
# touches the user's DSH_HOME, ~/.raminga, the real desktop, 4354 or 4321/4332.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${B1_HOST_PORT:-4362}
CONTROL_PORT=${B1_CONTROL_PORT:-4336}
DSH_HOME=${B1_DSH_HOME:-"$ROOT/.local/prototype-remediation/b1/dsh-home"}
RAMINGA_DATA_DIR=${B1_DATA_DIR:-"$ROOT/.local/prototype-remediation/b1/node-a"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}

if [ ! -x "$RAMINGA_BIN" ]; then
  echo "missing executable $RAMINGA_BIN; run make build" >&2
  exit 2
fi
if [ ! -d "$DSH_HOME/profiles/web" ]; then
  echo "missing isolated DSH profile $DSH_HOME/profiles/web; run prepare.mjs" >&2
  exit 2
fi
if [ ! -d "$RAMINGA_DATA_DIR" ]; then
  echo "missing Raminga data directory $RAMINGA_DATA_DIR" >&2
  exit 2
fi

echo "B1 host: port=$PORT control=$CONTROL_PORT"
echo "B1 DSH_HOME=$DSH_HOME"
echo "B1 RAMINGA_DATA_DIR=$RAMINGA_DATA_DIR"
echo "B1 RAMINGA_BIN=$RAMINGA_BIN"

PIDFILE="$ROOT/.local/prototype-remediation/b1/dsh-$PORT.pid"
mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$RAMINGA_DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  B1_CONTROL_PORT="$CONTROL_PORT" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
