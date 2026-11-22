#!/bin/sh
# Start the isolated A1 DSH Web host in the foreground. It never touches the
# user's DSH_HOME, ~/.raminga, 4321/4332 or the p5 4344 host.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${A1_HOST_PORT:-4354}
DSH_HOME=${A1_DSH_HOME:-"$ROOT/.local/ui-refresh-20261117/a1/dsh-home"}
RAMINGA_DATA_DIR=${A1_DATA_DIR:-"$ROOT/.local/ui-refresh-20261117/a1/node-a"}
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

echo "A1 host: port=$PORT"
echo "A1 DSH_HOME=$DSH_HOME"
echo "A1 RAMINGA_DATA_DIR=$RAMINGA_DATA_DIR"
echo "A1 RAMINGA_BIN=$RAMINGA_BIN"

PIDFILE="$ROOT/.local/ui-refresh-20261117/a1/dsh-$PORT.pid"
mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$RAMINGA_DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
