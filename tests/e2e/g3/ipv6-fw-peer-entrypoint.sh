#!/bin/sh
# Test-only peer entrypoint for the G3.1 IPv6 firewall topology. The site
# router (not the peer) owns the stateful firewall. The peer only uses the
# router as its IPv6 default gateway so direct dials traverse the firewall.
set -eu

LAN_IF="${LAN_IF:-lan0}"
LAN_GATEWAY="${LAN_GATEWAY:?LAN_GATEWAY is required}"
GLOBAL_LAN_IP="${GLOBAL_LAN_IP:?GLOBAL_LAN_IP is required}"

# Add the global documentation-prefix address on the same site interface.
# DCUtR needs a public address; this is not NAT or a second route.
ip -6 addr add "$GLOBAL_LAN_IP/64" dev "$LAN_IF" 2>/dev/null || true
ip -6 route replace default via "$LAN_GATEWAY" dev "$LAN_IF"
exec /usr/local/bin/entrypoint.sh
