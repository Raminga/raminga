#!/bin/sh
# Test-only WAN probe for the G3.1 IPv6 firewall topology. It is a real
# Raminga node on the WAN segment with explicit routes to both site LANs, so
# an unsolicited dial to a firewalled peer is a genuine WAN->LAN attempt.
set -eu

WAN_IF="${WAN_IF:-wan0}"
SITE_A_SUBNET="${SITE_A_SUBNET:?SITE_A_SUBNET is required}"
SITE_B_SUBNET="${SITE_B_SUBNET:?SITE_B_SUBNET is required}"
GLOBAL_SITE_A_SUBNET="${GLOBAL_SITE_A_SUBNET:?GLOBAL_SITE_A_SUBNET is required}"
GLOBAL_SITE_B_SUBNET="${GLOBAL_SITE_B_SUBNET:?GLOBAL_SITE_B_SUBNET is required}"
SITE_A_ROUTER="${SITE_A_ROUTER:?SITE_A_ROUTER is required}"
SITE_B_ROUTER="${SITE_B_ROUTER:?SITE_B_ROUTER is required}"

ip -6 route replace "$SITE_A_SUBNET" via "$SITE_A_ROUTER" dev "$WAN_IF"
ip -6 route replace "$SITE_B_SUBNET" via "$SITE_B_ROUTER" dev "$WAN_IF"
ip -6 route replace "$GLOBAL_SITE_A_SUBNET" via "$SITE_A_ROUTER" dev "$WAN_IF"
ip -6 route replace "$GLOBAL_SITE_B_SUBNET" via "$SITE_B_ROUTER" dev "$WAN_IF"
exec /usr/local/bin/entrypoint.sh
