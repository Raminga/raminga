#!/bin/sh
# Test-only peer entrypoint: put the peer behind its LAN router and prevent a
# Docker host route from becoming an accidental direct path.
set -eu

LAN_IF="${LAN_IF:-lan0}"
LAN_GATEWAY="${LAN_GATEWAY:?LAN_GATEWAY is required}"
OTHER_LAN_SUBNET="${OTHER_LAN_SUBNET:?OTHER_LAN_SUBNET is required}"

ip route replace default via "$LAN_GATEWAY" dev "$LAN_IF"
ip route replace blackhole "$OTHER_LAN_SUBNET"
exec /usr/local/bin/entrypoint.sh
