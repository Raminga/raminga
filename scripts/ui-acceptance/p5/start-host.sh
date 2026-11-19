#!/bin/sh
# Start the isolated P5 DSH Web host in the foreground. This script never
# backgrounds a process and never touches the user's DSH_HOME or ~/.raminga.
# It is intentionally separate from ports 4321 and 4332.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${P5_HOST_PORT:-${PORT:-4344}}
CONTROL_PORT=${P5_CONTROL_PORT:-4346}
DSH_HOME=${P5_DSH_HOME:-"$ROOT/.local/ui-refresh-20261117/p5/dsh-home"}
RAMINGA_DATA_DIR=${P5_DATA_DIR:-"$ROOT/.local/ui-refresh-20261117/p5/node-a"}
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

echo "P5 host: port=$PORT control=$CONTROL_PORT"
echo "P5 DSH_HOME=$DSH_HOME"
echo "P5 RAMINGA_DATA_DIR=$RAMINGA_DATA_DIR"
echo "P5 RAMINGA_BIN=$RAMINGA_BIN"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$RAMINGA_DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  P5_CONTROL_PORT="$CONTROL_PORT" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
