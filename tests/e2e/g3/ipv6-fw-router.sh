#!/bin/sh
# Test-only IPv6 stateful-firewall site router for the G3.1 lab.
#
# Two IPv6 ULA subnets are routed through this container (no NAT, no NPTv6).
# The closed mode installs an INPUT/FORWARD default-DROP policy with only
# conntrack ESTABLISHED,RELATED return traffic and essential ICMPv6 errors.
# There is deliberately NO allow rule for Raminga's TCP/UDP 4001 ports and no
# static DNAT: a direct connection can only appear after both peers open
# conntrack state by sending outbound packets (a real hole punch).
#
# This file runs only inside a disposable test container. It is not a Raminga
# runtime service and Docker is not a real internet firewall.
set -eu

WAN_IF="${WAN_IF:-wan0}"
LAN_IF="${LAN_IF:-lan0}"
WAN_GATEWAY="${WAN_GATEWAY:?WAN_GATEWAY is required}"
WAN_PEER="${WAN_PEER:?WAN_PEER is required}"
LAN_SUBNET="${LAN_SUBNET:?LAN_SUBNET is required}"
OTHER_LAN_SUBNET="${OTHER_LAN_SUBNET:?OTHER_LAN_SUBNET is required}"
GLOBAL_LAN_IP="${GLOBAL_LAN_IP:?GLOBAL_LAN_IP is required}"
GLOBAL_LAN_SUBNET="${GLOBAL_LAN_SUBNET:?GLOBAL_LAN_SUBNET is required}"
GLOBAL_OTHER_LAN_SUBNET="${GLOBAL_OTHER_LAN_SUBNET:?GLOBAL_OTHER_LAN_SUBNET is required}"
MODE="${MODE:-closed}"

fail() {
  echo "IPV6_FW_FAIL: $*" >&2
  exit 1
}

ip link show "$WAN_IF" >/dev/null 2>&1 || fail "missing WAN interface $WAN_IF"
ip link show "$LAN_IF" >/dev/null 2>&1 || fail "missing LAN interface $LAN_IF"

[ "$(cat /proc/sys/net/ipv6/conf/all/forwarding)" = "1" ] || fail "net.ipv6.conf.all.forwarding is not 1"

echo "IPV6_FW_ROUTER mode=${MODE} wan_if=${WAN_IF} lan_if=${LAN_IF} lan=${LAN_SUBNET} other=${OTHER_LAN_SUBNET} global_lan=${GLOBAL_LAN_SUBNET} global_other=${GLOBAL_OTHER_LAN_SUBNET}"

# Force the WAN default; Docker may otherwise pick the LAN bridge gateway.
ip -6 route replace default via "$WAN_GATEWAY" dev "$WAN_IF"
# Keep the ULA site subnet and add a documentation-prefix global address so
# go-libp2p's DCUtR public-address filter can initiate a hole punch. This is an
# extra address on the same routed site, not NAT/NPTv6.
ip -6 addr add "$GLOBAL_LAN_IP/64" dev "$LAN_IF" 2>/dev/null || true

# The other site (ULA and global test prefix) is reachable through the other
# site router on the WAN.
ip -6 route replace "$OTHER_LAN_SUBNET" via "$WAN_PEER" dev "$WAN_IF"
ip -6 route replace "$GLOBAL_OTHER_LAN_SUBNET" via "$WAN_PEER" dev "$WAN_IF"

ip6tables -w 5 -F INPUT
ip6tables -w 5 -F FORWARD
ip6tables -w 5 -F OUTPUT
ip6tables -w 5 -P INPUT DROP
ip6tables -w 5 -P OUTPUT ACCEPT
ip6tables -w 5 -P FORWARD DROP

# Router-local traffic: loopback, replies to router-initiated flows and the
# ICMPv6 types needed for neighbor discovery and path MTU. No 4001 allow rule.
ip6tables -w 5 -A INPUT -i lo -j ACCEPT
ip6tables -w 5 -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 1 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 2 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 3 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 4 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 133 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 134 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 135 -j ACCEPT
ip6tables -w 5 -A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 136 -j ACCEPT

if [ "$MODE" = "open" ]; then
  # One-sided lab variant: this site explicitly accepts inbound forwarding.
  ip6tables -w 5 -P FORWARD ACCEPT
  ip6tables -w 5 -A FORWARD -j ACCEPT
else
  # Stateful closed site. Outbound LAN->WAN NEW flows are allowed; WAN->LAN is
  # only allowed when conntrack already has a matching ESTABLISHED/RELATED
  # state, i.e. the other direction was initiated by this site.
  ip6tables -w 5 -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -w 5 -A FORWARD -p ipv6-icmp -m icmp6 --icmpv6-type 1 -j ACCEPT
  ip6tables -w 5 -A FORWARD -p ipv6-icmp -m icmp6 --icmpv6-type 2 -j ACCEPT
  ip6tables -w 5 -A FORWARD -p ipv6-icmp -m icmp6 --icmpv6-type 3 -j ACCEPT
  ip6tables -w 5 -A FORWARD -p ipv6-icmp -m icmp6 --icmpv6-type 4 -j ACCEPT
  ip6tables -w 5 -A FORWARD -i "$LAN_IF" -o "$WAN_IF" -s "$LAN_SUBNET" -j ACCEPT
  ip6tables -w 5 -A FORWARD -i "$LAN_IF" -o "$WAN_IF" -s "$GLOBAL_LAN_SUBNET" -j ACCEPT
  # Explicit final drop gives the test a visible counter for unsolicited WAN
  # traffic instead of relying only on the policy.
  ip6tables -w 5 -A FORWARD -i "$WAN_IF" -o "$LAN_IF" -d "$LAN_SUBNET" -j DROP
  ip6tables -w 5 -A FORWARD -i "$WAN_IF" -o "$LAN_IF" -d "$GLOBAL_LAN_SUBNET" -j DROP
fi

echo "IPV6_FW_ROUTES"
ip -6 addr show
ip -6 route

echo "IPV6_FW_RULES"
ip6tables -w 5 -S

touch /run/fw-ready
echo "IPV6_FW_READY mode=${MODE}"
exec tail -f /dev/null
