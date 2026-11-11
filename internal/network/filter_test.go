package network

import (
	"fmt"
	"net"
	"strings"
	"testing"

	ma "github.com/multiformats/go-multiaddr"
)

func TestFilterListenAddrsRules(t *testing.T) {
	iface := func(ip net.IP) string {
		switch ip.String() {
		case "10.9.9.9":
			return "docker0"
		case "172.18.0.1":
			return "eth0"
		case "192.168.137.1":
			return "vEthernet (Shared)"
		case "192.168.1.10":
			return "eth0"
		case "10.1.1.1":
			return "en0"
		}
		return ""
	}
	cases := []struct {
		name  string
		addrs []string
		want  []string
	}{
		{"hard drops", []string{"/ip4/169.254.1.1/tcp/1", "/ip6/fe80::1/tcp/1", "/ip4/0.0.0.0/tcp/1", "/ip6/::/tcp/1", "/ip4/224.0.0.1/tcp/1", "/ip6/ff02::1/tcp/1"}, nil},
		{"loopback removed when nonloopback", []string{"/ip4/127.0.0.1/tcp/1", "/ip6/::1/tcp/1", "/ip4/10.1.1.1/tcp/1"}, []string{"/ip4/10.1.1.1/tcp/1"}},
		{"loopback only kept", []string{"/ip4/127.0.0.1/tcp/1", "/ip6/::1/tcp/1"}, []string{"/ip6/::1/tcp/1", "/ip4/127.0.0.1/tcp/1"}},
		{"private kept", []string{"/ip4/10.1.1.1/tcp/1", "/ip4/172.18.0.1/tcp/1", "/ip4/192.168.1.10/tcp/1", "/ip6/fc00::1/tcp/1"}, []string{"/ip6/fc00::1/tcp/1", "/ip4/10.1.1.1/tcp/1", "/ip4/172.18.0.1/tcp/1", "/ip4/192.168.1.10/tcp/1"}},
		{"virtual names dropped, eth0 kept", []string{"/ip4/10.9.9.9/tcp/1", "/ip4/192.168.137.1/tcp/1", "/ip4/192.168.1.10/tcp/1"}, []string{"/ip4/192.168.1.10/tcp/1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addrs := make([]ma.Multiaddr, 0, len(tc.addrs))
			for _, raw := range tc.addrs {
				addrs = append(addrs, mustMA(t, raw))
			}
			got := addrsToStrings(filterListenAddrs(addrs, iface, false, maxPublicIPv6))
			want := append([]string(nil), tc.want...)
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("got %v, want %v", got, want)
			}
		})
	}
}

func TestFilterPublicIPv6Cap(t *testing.T) {
	var addrs []ma.Multiaddr
	for i := 0; i < 10; i++ {
		addrs = append(addrs, mustMA(t, fmt.Sprintf("/ip6/2606:4700:4700::%x/tcp/1", i+1)))
	}
	got := filterListenAddrs(addrs, nil, false, maxPublicIPv6)
	if len(got) != maxPublicIPv6 {
		t.Fatalf("public IPv6 = %d, want %d", len(got), maxPublicIPv6)
	}
	got0 := filterListenAddrs(addrs, nil, false, 0)
	if len(got0) != 0 {
		t.Fatalf("public IPv6 with zero budget = %d", len(got0))
	}
}

func TestAddrFactoryAnnounceFirstAndUnfiltered(t *testing.T) {
	state, err := newAddrState([]string{"/ip4/169.254.1.1/tcp/1", "/ip4/10.9.9.9/tcp/2"}, false)
	if err != nil {
		t.Fatal(err)
	}
	state.interfaceName = func(ip net.IP) string {
		if ip.String() == "10.9.9.9" {
			return "docker0"
		}
		return ""
	}
	got := addrsToStrings(state.factory([]ma.Multiaddr{mustMA(t, "/ip4/192.168.1.10/tcp/3"), mustMA(t, "/ip4/169.254.2.2/tcp/4")}))
	if len(got) != 3 || got[2] != "/ip4/192.168.1.10/tcp/3" ||
		!containsString(got[:2], "/ip4/169.254.1.1/tcp/1") ||
		!containsString(got[:2], "/ip4/10.9.9.9/tcp/2") {
		t.Fatalf("factory announce order/result = %v", got)
	}
}

func TestAddrFactoryCircuitAlwaysKept(t *testing.T) {
	state, _ := newAddrState(nil, false)
	relay := "/ip4/10.0.0.1/tcp/1/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6/p2p-circuit/p2p/12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq"
	got := addrsToStrings(state.factory([]ma.Multiaddr{mustMA(t, relay)}))
	if len(got) != 1 || got[0] != relay {
		t.Fatalf("circuit filtered: %v", got)
	}
}

func TestAddrFactoryAnnouncePublicIPv6Budget(t *testing.T) {
	var announce []string
	for i := 0; i < maxPublicIPv6; i++ {
		announce = append(announce, fmt.Sprintf("/ip6/2606:4700:4700::%x/tcp/1", i+1))
	}
	state, err := newAddrState(announce, true)
	if err != nil {
		t.Fatal(err)
	}
	var listen []ma.Multiaddr
	for i := 0; i < maxPublicIPv6+2; i++ {
		listen = append(listen, mustMA(t, fmt.Sprintf("/ip6/2606:4700:4700::%x/tcp/1", i+100)))
	}
	got := state.factory(listen)
	count := 0
	for _, addr := range got {
		if isIPv6(addr) {
			count++
		}
	}
	if count != maxPublicIPv6 {
		t.Fatalf("public IPv6 count = %d, want %d: %v", count, maxPublicIPv6, addrsToStrings(got))
	}
}
