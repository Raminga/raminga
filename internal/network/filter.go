package network

import (
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

const (
	maxPublicIPv6 = 8
	ifaceCacheTTL = 30 * time.Second
)

var virtualInterfacePrefixes = []string{
	"docker", "br-", "veth", "vmnet", "vboxnet", "vethernet", "utun", "tun", "tap", "zt", "wg",
}

func virtualInterface(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, prefix := range virtualInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func multiaddrIP(addr ma.Multiaddr) net.IP {
	naddr, err := manet.ToNetAddr(addr)
	if err != nil {
		return nil
	}
	switch v := naddr.(type) {
	case *net.TCPAddr:
		return v.IP
	case *net.UDPAddr:
		return v.IP
	case *net.IPAddr:
		return v.IP
	default:
		return nil
	}
}

// filterListenAddrs is pure: interfaceName is injected so tests can exercise
// the virtual-adapter rule without touching host interfaces.
func filterListenAddrs(addrs []ma.Multiaddr, interfaceName func(net.IP) string, hasNonLoopback bool, publicV6Budget int) []ma.Multiaddr {
	addrs = append([]ma.Multiaddr(nil), addrs...)
	sort.SliceStable(addrs, func(i, j int) bool { return addrs[i].String() < addrs[j].String() })
	anyNonLoopback := hasNonLoopback
	if !anyNonLoopback {
		for _, addr := range addrs {
			if addr != nil && !manet.IsIPLoopback(addr) {
				anyNonLoopback = true
				break
			}
		}
	}
	out := make([]ma.Multiaddr, 0, len(addrs))
	publicV6 := 0
	for _, addr := range addrs {
		if addr == nil {
			continue
		}
		if strings.Contains(addr.String(), "/p2p-circuit") {
			out = append(out, addr)
			continue
		}
		ip := multiaddrIP(addr)
		if ip == nil {
			out = append(out, addr)
			continue
		}
		if ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		if manet.IsIPLoopback(addr) {
			if anyNonLoopback {
				continue
			}
			out = append(out, addr)
			continue
		}
		anyNonLoopback = true
		if interfaceName != nil {
			if name := interfaceName(ip); name != "" && virtualInterface(name) {
				continue
			}
		}
		if isIPv6(addr) && manet.IsPublicAddr(addr) {
			if publicV6Budget <= publicV6 || publicV6 >= maxPublicIPv6 {
				continue
			}
			publicV6++
		}
		out = append(out, addr)
	}
	return out
}

func usableDialAddr(addr ma.Multiaddr) bool {
	if addr == nil {
		return false
	}
	ip := multiaddrIP(addr)
	if ip == nil {
		return true
	}
	return !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
}

func announcedPublicIPv6(addrs []ma.Multiaddr) int {
	n := 0
	for _, addr := range addrs {
		if isIPv6(addr) && manet.IsPublicAddr(addr) {
			n++
		}
	}
	return n
}

func hasNonLoopbackAddr(addrs []ma.Multiaddr) bool {
	for _, addr := range addrs {
		if addr == nil || manet.IsIPLoopback(addr) {
			continue
		}
		return true
	}
	return false
}

// ifaceCache maps IP -> interface name with a short TTL. Lookup failure returns
// "" so the caller keeps the address.
type ifaceCache struct {
	mu   sync.Mutex
	at   time.Time
	name map[string]string
	ttl  time.Duration
}

func newIfaceCache(ttl time.Duration) *ifaceCache {
	if ttl <= 0 {
		ttl = ifaceCacheTTL
	}
	return &ifaceCache{ttl: ttl}
}

func (c *ifaceCache) Name(ip net.IP) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.name == nil || time.Since(c.at) > c.ttl {
		c.name = interfaceNamesByIP()
		c.at = time.Now()
	}
	return c.name[ip.String()]
}

func interfaceNamesByIP() map[string]string {
	out := make(map[string]string)
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, raw := range addrs {
			ipnet, ok := raw.(*net.IPNet)
			if !ok || ipnet.IP == nil {
				continue
			}
			out[ipnet.IP.String()] = iface.Name
		}
	}
	return out
}

// deterministicPublicIPv6 orders public IPv6 candidates before cap selection.
func deterministicPublicIPv6(addrs []ma.Multiaddr) []ma.Multiaddr {
	sort.SliceStable(addrs, func(i, j int) bool { return addrs[i].String() < addrs[j].String() })
	return addrs
}
