#!/usr/bin/env bash
# Raminga Phase 5 test-only NAT router.
#
# Adapted from the libp2p unified-testing hole-punch Linux router:
#   https://github.com/libp2p/unified-testing/blob/master/hole-punch/images/linux/run.sh
#   commit 4ade567bfea81d291278a272825a7d35e73b40dd
#   License: Apache-2.0 OR MIT (see LICENSE-APACHE / LICENSE-MIT upstream).
#
# The upstream rules are intentionally kept: a DROP forwarding policy, the
# unsolicited-WAN-INPUT drop that prevents RSTs during a simultaneous open,
# MASQUERADE on the LAN->WAN path, and conntrack-established return traffic.
# Raminga adds explicit cross-LAN and hairpin drops so the two private LANs
# cannot meet through the WAN bridge or an accidental Docker host route. This
# file runs only inside a disposable test container; it is not a Raminga
# runtime service or a claim that Docker equals a real ISP NAT.
set -euo pipefail

WAN_IF="${WAN_IF:-wan0}"
LAN_IF="${LAN_IF:-lan0}"
WAN_IP="${WAN_IP:?WAN_IP is required}"
WAN_GATEWAY="${WAN_GATEWAY:?WAN_GATEWAY is required}"
WAN_SUBNET="${WAN_SUBNET:?WAN_SUBNET is required}"
LAN_IP="${LAN_IP:?LAN_IP is required}"
LAN_SUBNET="${LAN_SUBNET:?LAN_SUBNET is required}"
OTHER_LAN_SUBNET="${OTHER_LAN_SUBNET:?OTHER_LAN_SUBNET is required}"

fail() {
  echo "NAT_ROUTER_FAIL: $*" >&2
  exit 1
}

ip link show "$WAN_IF" >/dev/null 2>&1 || fail "missing WAN interface $WAN_IF"
ip link show "$LAN_IF" >/dev/null 2>&1 || fail "missing LAN interface $LAN_IF"

# Docker Desktop must allow these namespaced sysctls. Compose sets them; if a
# platform refuses them the router fails loudly instead of pretending to NAT.
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = "1" ] || fail "net.ipv4.ip_forward is not 1"
[ "$(cat /proc/sys/net/ipv4/conf/all/forwarding)" = "1" ] || fail "net.ipv4.conf.all.forwarding is not 1"
[ "$(cat /proc/sys/net/ipv4/conf/all/rp_filter)" = "0" ] || fail "net.ipv4.conf.all.rp_filter is not 0"

echo "NAT_ROUTER_CONFIG wan_if=${WAN_IF} wan_ip=${WAN_IP} wan_subnet=${WAN_SUBNET} lan_if=${LAN_IF} lan_ip=${LAN_IP} lan_subnet=${LAN_SUBNET} other_lan=${OTHER_LAN_SUBNET}"

# Only this disposable network namespace is touched.
iptables -w 5 -t nat -F
iptables -w 5 -t filter -F
iptables -w 5 -t mangle -F
iptables -w 5 -P FORWARD DROP
iptables -w 5 -P INPUT ACCEPT
iptables -w 5 -P OUTPUT ACCEPT

# Force the WAN as the router default. Compose can otherwise pick the LAN
# bridge gateway depending on attachment order; the WAN gateway is the only
# external next hop this test router should use.
ip route replace default via "$WAN_GATEWAY" dev "$WAN_IF"

# No route exists for the other private LAN; a blackhole also prevents the
# Docker host gateway from becoming an accidental transit path.
ip route replace blackhole "$OTHER_LAN_SUBNET"

# Reject cross-LAN traffic in either direction and never accept it on WAN.
iptables -w 5 -A INPUT -i "$WAN_IF" -s "$OTHER_LAN_SUBNET" -j DROP
iptables -w 5 -A INPUT -i "$WAN_IF" -d "$OTHER_LAN_SUBNET" -j DROP
iptables -w 5 -A FORWARD -s "$OTHER_LAN_SUBNET" -j DROP
iptables -w 5 -A FORWARD -d "$OTHER_LAN_SUBNET" -j DROP

# Upstream rule: unsolicited WAN input must not answer with a RST. A legitimate
# simultaneous-open packet is translated by conntrack in PREROUTING and then
# hits FORWARD, not INPUT, so this does not block a real hole punch.
iptables -w 5 -A INPUT -i "$WAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w 5 -A INPUT -i "$WAN_IF" -j DROP

# Real source NAT for the private LAN's WAN traffic. MASQUERADE_RANDOM_FULLY=1
# selects a random external source port for each new mapping, which makes the
# mapping destination-dependent (port-restricted / symmetric-like). It is still
# real conntrack NAT; no static DNAT or port forwarding is added.
if [ "${MASQUERADE_RANDOM_FULLY:-0}" = "1" ]; then
  iptables -w 5 -t nat -A POSTROUTING -s "$LAN_SUBNET" -o "$WAN_IF" -j MASQUERADE --random-fully
else
  iptables -w 5 -t nat -A POSTROUTING -s "$LAN_SUBNET" -o "$WAN_IF" -j MASQUERADE
fi

# Forwarding policy. The upstream topology ended with an unconditional
# WAN->LAN ACCEPT because a hole-punch SYN is translated before FORWARD. That
# is too broad: it accepts every unsolicited WAN->LAN NEW packet even when no
# mapping exists, and on Docker Desktop host bridge isolation can hide the
# mistake. Scope every WAN->LAN acceptance to conntrack instead:
#   * ESTABLISHED,RELATED covers replies to LAN-initiated flows, including the
#     reverse translation of a dynamic MASQUERADE mapping.
#   * DNAT covers a packet that conntrack has already DNATed to this LAN (a
#     real inbound mapping / port-forward). It does not create a mapping.
#   * SNAT covers the reverse direction of an existing dynamic SNAT mapping
#     (e.g. a TCP simultaneous-open SYN before the reply is marked ESTABLISHED).
#     It still requires a matching conntrack entry; unsolicited NEW with no
#     mapping matches none of these states and falls through to the explicit
#     WAN->LAN DROP below.
# Check the actual kernel semantics with `iptables -m conntrack --ctstate ...`
# and conntrack evidence; do not replace this with a static DNAT to fake a
# punch-through.
iptables -w 5 -A FORWARD -s "$LAN_SUBNET" -i "$LAN_IF" -o "$WAN_IF" -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT
iptables -w 5 -A FORWARD -d "$LAN_SUBNET" -i "$WAN_IF" -o "$LAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w 5 -A FORWARD -d "$LAN_SUBNET" -i "$WAN_IF" -o "$LAN_IF" -m conntrack --ctstate DNAT,SNAT -j ACCEPT
# Explicit final WAN->LAN drop gives the test a router-local counter for
# unsolicited private-LAN attempts instead of relying on the FORWARD policy.
iptables -w 5 -A FORWARD -d "$LAN_SUBNET" -i "$WAN_IF" -o "$LAN_IF" -j DROP
iptables -w 5 -A FORWARD -i "$WAN_IF" -o "$WAN_IF" -j DROP
iptables -w 5 -A FORWARD -i "$LAN_IF" -o "$LAN_IF" -j DROP
echo "NAT_ROUTER_WAN_TO_LAN_POLICY=conntrack-ESTABLISHED,RELATED+DNAT,SNAT;unsolicited-NEW-DROP"

echo "NAT_ROUTER_ROUTES"
ip -br addr
ip route

echo "NAT_ROUTER_NAT_RULES"
iptables -w 5 -t nat -S
echo "NAT_ROUTER_FILTER_RULES"
iptables -w 5 -S

# A marker read by the Compose healthcheck only after all rules are installed.
touch /run/nat-ready
echo "NAT_ROUTER_READY"
exec tail -f /dev/null
