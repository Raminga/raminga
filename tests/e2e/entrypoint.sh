#!/bin/sh
set -eu

DATA_DIR="${RAMINGA_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ -n "${RAMINGA_CONFIG_TEMPLATE:-}" ] && [ ! -f "$DATA_DIR/config.toml" ]; then
  cp "$RAMINGA_CONFIG_TEMPLATE" "$DATA_DIR/config.toml"
  chmod 600 "$DATA_DIR/config.toml"
fi

exec /usr/local/bin/raminga daemon \
  --data-dir "$DATA_DIR" \
  --log-level "${RAMINGA_LOG_LEVEL:-info}" \
  ${RAMINGA_EXTRA_ARGS:-}
