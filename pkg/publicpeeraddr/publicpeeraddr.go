// Package publicpeeraddr validates routable dial hints carried in contact cards
// and returned by public peer discovery.
package publicpeeraddr

import (
	"net/netip"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

var (
	globalIPv6 = netip.MustParsePrefix("2000::/3")
	specialIPs = []netip.Prefix{
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("3fff::/20"),
	}
)

// Normalize accepts only a supported IP transport, optionally through one
// public Circuit Relay. It removes a matching final target ID for swarm use.
func Normalize(addr ma.Multiaddr, target peer.ID) ma.Multiaddr {
	addr, transportEnd := normalizeTransport(addr, target)
	if transportEnd == 0 {
		return nil
	}
	ip, ok := netip.AddrFromSlice(addr[0].RawValue())
	if !ok || ip.Is4In6() || !manet.IsPublicAddr(addr[:1]) || (ip.Is6() && !globalIPv6.Contains(ip)) {
		return nil
	}
	for _, blocked := range specialIPs {
		if blocked.Contains(ip) {
			return nil
		}
	}
	if len(addr) == transportEnd {
		return addr
	}
	if len(addr) != transportEnd+2 || addr[transportEnd].Protocol().Code != ma.P_P2P ||
		addr[transportEnd+1].Protocol().Code != ma.P_CIRCUIT {
		return nil
	}
	relay, err := peer.Decode(addr[transportEnd].Value())
	if err != nil || relay == target {
		return nil
	}
	return addr
}

// NormalizeLAN accepts direct TCP or QUIC on RFC 1918 and IPv6 ULA addresses.
// LAN hints are only for explicit card import, never for public discovery.
func NormalizeLAN(addr ma.Multiaddr, target peer.ID) ma.Multiaddr {
	addr, transportEnd := normalizeTransport(addr, target)
	if transportEnd == 0 || len(addr) != transportEnd {
		return nil
	}
	ip, ok := netip.AddrFromSlice(addr[0].RawValue())
	if !ok || ip.Is4In6() || !ip.IsPrivate() {
		return nil
	}
	return addr
}

func normalizeTransport(addr ma.Multiaddr, target peer.ID) (ma.Multiaddr, int) {
	if len(addr) < 2 || (addr[0].Protocol().Code != ma.P_IP4 && addr[0].Protocol().Code != ma.P_IP6) {
		return nil, 0
	}
	if addr[1].Value() == "0" {
		return nil, 0
	}
	transportEnd := 2
	switch addr[1].Protocol().Code {
	case ma.P_TCP:
	case ma.P_UDP:
		if len(addr) < 3 || addr[2].Protocol().Code != ma.P_QUIC_V1 {
			return nil, 0
		}
		transportEnd = 3
	default:
		return nil, 0
	}
	if len(addr) > transportEnd && addr[len(addr)-1].Protocol().Code == ma.P_P2P {
		pid, err := peer.Decode(addr[len(addr)-1].Value())
		if err != nil || pid != target {
			return nil, 0
		}
		addr = addr[:len(addr)-1]
	}
	return addr, transportEnd
}
