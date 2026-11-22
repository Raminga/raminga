#!/bin/sh
# Start the isolated third-batch DSH Web host. Only this fixture's HOME,
# DSH_HOME, data directory and loopback port are used.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PORT=${B3_HOST_PORT:-44744}
DSH_HOME=${B3_DSH_HOME:-"$ROOT/.local/prototype-remediation/b3-01-bootstrap/dsh-home"}
HOME_DIR=${B3_HOME:-"$ROOT/.local/prototype-remediation/b3-01-bootstrap/home"}
DATA_DIR=${B3_DATA_DIR:-"$ROOT/.local/prototype-remediation/b3-01-bootstrap/node-a"}
RAMINGA_BIN=${RAMINGA_BIN:-"$ROOT/bin/raminga"}
PIDFILE=${B3_PIDFILE:-"$ROOT/.local/prototype-remediation/b3-01-bootstrap/evidence/dsh-$PORT.pid"}

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
mkdir -p "$HOME_DIR" "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"
printf '{"pid":%s,"port":%s,"startedAt":"%s"}\n' "$$" "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PIDFILE.meta"
exec env -u DSH_PROFILE -u DSH_HOME \
  HOME="$HOME_DIR" \
  DSH_HOME="$DSH_HOME" \
  RAMINGA_DATA_DIR="$DATA_DIR" \
  RAMINGA_BIN="$RAMINGA_BIN" \
  dsh web --no-open --host 127.0.0.1 --port "$PORT"
