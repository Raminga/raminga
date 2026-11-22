#!/bin/sh
# Start the isolated second-batch item 3 DSH Web host. Never touches the user's
# DSH_HOME, ~/.raminga, the real desktop, 4374/4341 or their data.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${B3_HOST_PORT:-4376}
DATA_DIR=${B3_DATA_DIR:-"$ROOT/.local/prototype-remediation/b3-contact-profile/node-a"}
DSH_HOME=${B3_DSH_HOME:-"$ROOT/.local/prototype-remediation/b3-contact-profile/dsh-home"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}
PIDFILE=${B3_PIDFILE:-"$ROOT/.local/prototype-remediation/b3-contact-profile/dsh-$PORT.pid"}

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

echo "BATCH2-03 host: port=$PORT"
echo "BATCH2-03 data=$DATA_DIR"
echo "BATCH2-03 DSH_HOME=$DSH_HOME"
echo "BATCH2-03 RAMINGA_BIN=$RAMINGA_BIN"

mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"
printf '{"pid":%s,"port":%s,"startedAt":"%s"}\n' "$$" "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PIDFILE.meta"

exec env -u DSH_PROFILE -u DSH_HOME \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
