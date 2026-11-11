package main

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (r *runner) sh(service, script string) (string, int) {
	return r.exec(service, "sh", "-c", script)
}

func (r *runner) facilityIPv6() (string, error) {
	a, b := "a6", "b6"
	a6, b6 := "fd00:250:1::21", "fd00:250:1::22"

	addr, code := r.sh(a, "ip -6 addr show; echo ---; ip -6 route")
	r.addCheckToFacility("IPv6 ULA address and route exist", code == 0 && strings.Contains(addr, a6) && strings.Contains(addr, "fd00:250:1::/64"),
		strings.TrimSpace(addr))
	addrB, code := r.sh(b, "ip -6 addr show; echo ---; ip -6 route")
	r.addCheckToFacility("both peers have ULA IPv6 addresses", code == 0 && strings.Contains(addrB, b6), strings.TrimSpace(addrB))

	ping, code := r.sh(a, "ping -6 -c 1 -W 2 "+b6)
	r.addCheckToFacility("IPv6 on-link probe succeeds before firewall", code == 0 && strings.Contains(ping, "1 received"), strings.TrimSpace(ping))

	rules := "ip6tables -w 5 -F INPUT; ip6tables -w 5 -P INPUT DROP; " +
		"ip6tables -w 5 -A INPUT -i lo -j ACCEPT; " +
		"ip6tables -w 5 -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; " +
		"ip6tables -w 5 -A INPUT -p ipv6-icmp -j ACCEPT; " +
		"ip6tables -w 5 -A INPUT -p tcp -s " + b6 + " --dport 4001 -j ACCEPT; " +
		"ip6tables -w 5 -A INPUT -p udp -s " + b6 + " --dport 4001 -j ACCEPT"
	outA, codeA := r.sh(a, rules)
	outB, codeB := r.sh(b, strings.ReplaceAll(rules, b6, a6))
	r.addCheckToFacility("stateful ip6tables INPUT installed on both peers", codeA == 0 && codeB == 0,
		fmt.Sprintf("a=%s b=%s", outA, outB))
	ruleDump, err := r.ip6tables(a)
	r.requireFacility("ip6tables policy and conntrack rule present",
		boolError(err == nil && strings.Contains(ruleDump, "-P INPUT DROP") && strings.Contains(ruleDump, "--ctstate") &&
			strings.Contains(ruleDump, "ESTABLISHED") && strings.Contains(ruleDump, "RELATED"), fmt.Sprintf("%v %s", err, ruleDump)))

	ping6, code := r.sh(a, "ping -6 -c 2 -W 2 "+b6)
	r.addCheckToFacility("IPv6 probe still works through stateful firewall", code == 0 && strings.Contains(ping6, "2 received"), strings.TrimSpace(ping6))

	ctOut, ctCode := r.sh(b, "conntrack -L -f ipv6 2>/dev/null | head -20; true")
	r.addCheckToFacility("IPv6 conntrack state is observable", ctCode == 0 && strings.Contains(strings.ToLower(ctOut), "icmpv6"),
		strings.TrimSpace(ctOut))

	v4, v4code := r.sh(a, "ip -4 addr show; echo ---; ip -4 route")
	r.addCheckToFacility("IPv4 address coexists on the dual-stack LAN", v4code == 0 && strings.Contains(v4, "10.250.1.21") && strings.Contains(v4, "10.250.1.0/24"),
		strings.TrimSpace(v4))

	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("IPv6/ip6tables facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) iptablesDropCounter(service, proto, port string) (int, error) {
	script := fmt.Sprintf("iptables -w 5 -vnL INPUT | awk '$0 ~ /%s/ && $0 ~ /dpt:%s/ && $0 ~ /DROP/ {s+=$1} END {print s+0}'; "+
		"iptables -w 5 -vnL OUTPUT | awk '$0 ~ /%s/ && $0 ~ /dpt:%s/ && $0 ~ /DROP/ {s+=$1} END {print s+0}'", proto, port, proto, port)
	out, code := r.sh(service, script)
	if code != 0 {
		return 0, fmt.Errorf("%s counter exit %d: %s", service, code, out)
	}
	total := 0
	for _, line := range strings.Fields(out) {
		n, err := strconv.Atoi(line)
		if err == nil {
			total += n
		}
	}
	return total, nil
}

func (r *runner) installDrop(service, proto, port string) error {
	script := fmt.Sprintf("iptables -w 5 -C INPUT -p %s --dport %s -j DROP 2>/dev/null || iptables -w 5 -A INPUT -p %s --dport %s -j DROP; "+
		"iptables -w 5 -C OUTPUT -p %s --dport %s -j DROP 2>/dev/null || iptables -w 5 -A OUTPUT -p %s --dport %s -j DROP",
		proto, port, proto, port, proto, port, proto, port)
	out, code := r.sh(service, script)
	if code != 0 {
		return fmt.Errorf("%s install %s DROP: %s", service, proto, out)
	}
	return nil
}

func (r *runner) facilityProtocolBlocks() (string, error) {
	// UDP-only blocked pair: both directions, destination QUIC port.
	for _, service := range []string{"tcp-a", "tcp-b"} {
		if err := r.installDrop(service, "udp", "4001"); err != nil {
			r.addCheckToFacility(service+" UDP drop installed", false, err.Error())
			return "FAIL", err
		}
	}
	udpRules, udpCode := r.sh("tcp-a", "iptables -w 5 -S INPUT; echo ---; iptables -w 5 -S OUTPUT")
	r.requireFacility("UDP-only DROP rules installed",
		boolError(udpCode == 0 && strings.Contains(udpRules, "-p udp") && strings.Contains(udpRules, "--dport 4001") && strings.Contains(udpRules, "-j DROP"), fmt.Sprintf("exit=%d %s", udpCode, udpRules)))

	before, _ := r.iptablesDropCounter("tcp-a", "udp", "4001")
	_, dialErr := r.connect("tcp-a", "/ip4/10.250.1.42/udp/4001/quic-v1/p2p/"+r.ids["tcp-b"])
	r.addCheckToFacility("blocked QUIC dial is rejected, not silently downgraded", dialErr != nil, fmt.Sprintf("err=%v", dialErr))
	time.Sleep(500 * time.Millisecond)
	after, _ := r.iptablesDropCounter("tcp-a", "udp", "4001")
	r.addCheckToFacility("UDP DROP counter increased", after > before, fmt.Sprintf("before=%d after=%d", before, after))

	// TCP-only blocked pair: both directions, destination TCP port.
	for _, service := range []string{"udp-a", "udp-b"} {
		if err := r.installDrop(service, "tcp", "4001"); err != nil {
			r.addCheckToFacility(service+" TCP drop installed", false, err.Error())
			return "FAIL", err
		}
	}
	tcpRules, tcpCode := r.sh("udp-a", "iptables -w 5 -S INPUT; echo ---; iptables -w 5 -S OUTPUT")
	r.requireFacility("TCP-only DROP rules installed",
		boolError(tcpCode == 0 && strings.Contains(tcpRules, "-p tcp") && strings.Contains(tcpRules, "--dport 4001") && strings.Contains(tcpRules, "-j DROP"), fmt.Sprintf("exit=%d %s", tcpCode, tcpRules)))

	before, _ = r.iptablesDropCounter("udp-a", "tcp", "4001")
	_, dialErr = r.connect("udp-a", "/ip4/10.250.1.52/tcp/4001/p2p/"+r.ids["udp-b"])
	r.addCheckToFacility("blocked TCP dial is rejected, not silently downgraded", dialErr != nil, fmt.Sprintf("err=%v", dialErr))
	time.Sleep(500 * time.Millisecond)
	after, _ = r.iptablesDropCounter("udp-a", "tcp", "4001")
	r.addCheckToFacility("TCP DROP counter increased", after > before, fmt.Sprintf("before=%d after=%d", before, after))

	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("protocol-block facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) qdisc(service string) (string, error) {
	out, code := r.sh(service, "tc qdisc show dev eth0")
	if code != 0 {
		return "", fmt.Errorf("%s tc qdisc exit %d: %s", service, code, out)
	}
	return out, nil
}

func (r *runner) facilityNetem() (string, error) {
	for _, service := range []string{"loss-a", "loss-b"} {
		out, code := r.sh(service, "tc qdisc replace dev eth0 root netem delay 120ms 20ms loss 10%")
		if code != 0 {
			r.addCheckToFacility(service+" netem installed", false, out)
			return "FAIL", fmt.Errorf("tc netem: %s", out)
		}
	}
	for _, service := range []string{"loss-a", "loss-b"} {
		out, err := r.qdisc(service)
		r.requireFacility(service+" netem qdisc visible",
			boolError(err == nil && strings.Contains(out, "netem") && strings.Contains(out, "delay 120ms") && strings.Contains(out, "loss 10%"), fmt.Sprintf("%v %s", err, out)))
	}
	ping, code := r.sh("loss-a", "ping -c 4 -W 2 10.250.1.62")
	rtt := maxPingRTT(ping)
	r.addCheckToFacility("netem latency is measurable on the wire", code == 0 && rtt >= 80,
		fmt.Sprintf("max_rtt_ms=%.1f output=%s", rtt, strings.TrimSpace(ping)))
	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("tc netem facility self-check failed")
	}
	return "PASS", nil
}

func maxPingRTT(out string) float64 {
	re := regexp.MustCompile(`time=([0-9.]+) ms`)
	max := 0.0
	for _, match := range re.FindAllStringSubmatch(out, -1) {
		if v, err := strconv.ParseFloat(match[1], 64); err == nil && v > max {
			max = v
		}
	}
	return max
}

func (r *runner) facilityOneSided() (string, error) {
	peerIP, pubIP := "10.252.1.10", "11.43.0.10"
	if out, code := r.sh("pub", "ip route replace blackhole 10.252.1.0/24; ip route"); code != 0 {
		r.addCheckToFacility("public node cannot route to the private LAN", false, out)
		return "FAIL", fmt.Errorf("pub blackhole: %s", out)
	}
	route, code := r.sh("peer", "ip route")
	r.addCheckToFacility("restricted peer default route goes through the NAT router", code == 0 && strings.Contains(route, "default via 10.252.1.2"), strings.TrimSpace(route))

	rules, err := r.iptables("nat")
	r.requireFacility("NAT router keeps strict conntrack rules",
		boolError(err == nil && strings.Contains(rules, "MASQUERADE") && !strings.Contains(rules, "-j DNAT") &&
			strings.Contains(rules, "-P FORWARD DROP") && strings.Contains(rules, "ESTABLISHED") && strings.Contains(rules, "RELATED"), fmt.Sprintf("%v %s", err, rules)))

	ping, code := r.sh("peer", "ping -c 1 -W 2 "+pubIP)
	r.addCheckToFacility("restricted side can reach the public node outbound", code == 0 && strings.Contains(ping, "1 received"), strings.TrimSpace(ping))
	pingBack, code := r.sh("pub", "ping -c 1 -W 2 "+peerIP)
	r.addCheckToFacility("public side has no route into the private LAN", code != 0, strings.TrimSpace(pingBack))

	ct, ctCode := r.sh("nat", "conntrack -L 2>/dev/null | grep '10.252.1.10' | head -20; true")
	r.addCheckToFacility("real MASQUERADE/conntrack mapping exists", ctCode == 0 && strings.Contains(ct, "10.252.1.10") && strings.Contains(ct, "11.43.0.10"),
		strings.TrimSpace(ct))

	_, dialErr := r.connect("pub", "/ip4/"+peerIP+"/tcp/4001/p2p/"+r.ids["peer"])
	r.addCheckToFacility("unsolicited public-to-private dial fails", dialErr != nil, fmt.Sprintf("err=%v", dialErr))

	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("one-sided facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) mappedUDPPort(service, dstIP, dport string) (string, string) {
	out, code := r.sh(service, "conntrack -L -p udp 2>/dev/null | grep 'dst="+dstIP+"' | grep 'dport="+dport+"' | head -5; true")
	if code != 0 {
		return "", ""
	}
	re := regexp.MustCompile(`dport=([0-9]+)`)
	ports := re.FindAllStringSubmatch(out, -1)
	if len(ports) == 0 {
		return "", out
	}
	// The reply tuple's dport is the external mapped port. It is the last
	// dport on the matched line; the original tuple's dport is dstIP's port.
	return ports[len(ports)-1][1], out
}

func (r *runner) facilitySymmetric() (string, error) {
	natRules, natCode := r.sh("nat-a", "iptables -w 5 -t nat -S POSTROUTING; echo ---; iptables -w 5 -t nat -S")
	r.requireFacility("symmetric mapping uses MASQUERADE --random-fully and no static DNAT",
		boolError(natCode == 0 && strings.Contains(natRules, "--random-fully") && !strings.Contains(natRules, "-j DNAT"), fmt.Sprintf("exit=%d %s", natCode, natRules)))

	ping, code := r.sh("a", "ping -c 1 -W 2 11.42.0.2")
	r.addCheckToFacility("both NATed peers can reach the WAN relay", code == 0 && strings.Contains(ping, "1 received"), strings.TrimSpace(ping))

	route, code := r.sh("a", "ip route")
	r.addCheckToFacility("peer default route goes through its NAT router", code == 0 && strings.Contains(route, "default via 10.254.1.2"), strings.TrimSpace(route))

	for _, port := range []string{"5101", "5102"} {
		out, code := r.sh("a", "timeout 1 bash -c 'exec 3<>/dev/udp/11.42.0.2/"+port+"; echo probe >&3' 2>/dev/null; true")
		if code != 0 {
			r.addCheckToFacility("UDP mapping probe to port "+port, false, out)
		}
	}
	p1, raw1 := r.mappedUDPPort("nat-a", "11.42.0.2", "5101")
	p2, raw2 := r.mappedUDPPort("nat-a", "11.42.0.2", "5102")
	r.addCheckToFacility("two destinations get different external source ports", p1 != "" && p2 != "" && p1 != p2,
		fmt.Sprintf("5101_mapped=%s 5102_mapped=%s raw1=%s raw2=%s", p1, p2, strings.TrimSpace(raw1), strings.TrimSpace(raw2)))

	_, dialErr := r.connect("a", "/ip4/11.42.0.11/udp/4001/quic-v1/p2p/"+r.ids["b"])
	r.addCheckToFacility("inbound direct dial to the other symmetric peer fails", dialErr != nil, fmt.Sprintf("err=%v", dialErr))

	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("symmetric NAT facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) ip6ForwardDropCounter(service string) (int, error) {
	out, code := r.sh(service, "ip6tables -w 5 -vnL FORWARD | awk '$0 ~ /DROP/ {s+=$1} END {print s+0}'")
	if code != 0 {
		return 0, fmt.Errorf("%s ip6 forward counter exit %d: %s", service, code, out)
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("%s ip6 forward counter parse %q: %w", service, out, err)
	}
	return n, nil
}

func canonicalIP6(value string) string {
	if ip, err := netip.ParseAddr(value); err == nil {
		return ip.String()
	}
	if prefix, err := netip.ParsePrefix(value); err == nil {
		return prefix.String()
	}
	return value
}

func (r *runner) facilityIPv6Firewall() (string, error) {
	for _, item := range []struct {
		service string
		wan     string
		lan     string
		other   string
		peer    string
	}{
		{"fw-a", "fd00:360:0::10", "fd00:361:1::2", "fd00:362:1::/64", "fd00:360:0::11"},
		{"fw-b", "fd00:360:0::11", "fd00:362:1::2", "fd00:361:1::/64", "fd00:360:0::10"},
	} {
		addr, code := r.sh(item.service, "ip -6 addr show; echo ---; ip -6 route")
		r.addCheckToFacility(item.service+" has both IPv6 ULA sites and a route to the other site",
			code == 0 && strings.Contains(addr, canonicalIP6(item.wan)) && strings.Contains(addr, canonicalIP6(item.lan)) &&
				strings.Contains(addr, canonicalIP6(item.other)) && strings.Contains(addr, "via "+canonicalIP6(item.peer)),
			strings.TrimSpace(addr))
		rules, err := r.ip6tables(item.service)
		r.requireFacility(item.service+" stateful INPUT/FORWARD DROP with conntrack only",
			boolError(err == nil && strings.Contains(rules, "-P INPUT DROP") && strings.Contains(rules, "-P FORWARD DROP") &&
				strings.Contains(rules, "ESTABLISHED") && strings.Contains(rules, "RELATED") &&
				!strings.Contains(rules, "--dport 4001") && !strings.Contains(rules, "DNAT"), fmt.Sprintf("%v %s", err, rules)))
	}

	route, code := r.sh("a-quic", "ip -6 route get fd00:362:1::10")
	r.addCheckToFacility("site A peer routes the other ULA site via its site router",
		code == 0 && strings.Contains(route, "via "+canonicalIP6("fd00:361:1::2")), strings.TrimSpace(route))
	routeB, codeB := r.sh("b-quic", "ip -6 route get fd00:361:1::10")
	r.addCheckToFacility("site B peer routes the other ULA site via its site router",
		codeB == 0 && strings.Contains(routeB, "via "+canonicalIP6("fd00:362:1::2")), strings.TrimSpace(routeB))

	relayPing, code := r.sh("a-quic", "ping -6 -c 1 -W 2 fd00:360:0::2")
	r.addCheckToFacility("IPv6 WAN relay is reachable through the closed firewall", code == 0 && strings.Contains(relayPing, "1 received"), strings.TrimSpace(relayPing))
	relayPingB, codeB := r.sh("b-quic", "ping -6 -c 1 -W 2 fd00:360:0::2")
	r.addCheckToFacility("both sites reach the IPv6 relay", codeB == 0 && strings.Contains(relayPingB, "1 received"), strings.TrimSpace(relayPingB))

	for _, item := range []struct {
		service string
		global  string
		other   string
		peer    string
	}{
		{"fw-a", "2001:4860:361:1::2", "2001:4860:362:1::/64", "fd00:360:0::11"},
		{"fw-b", "2001:4860:362:1::2", "2001:4860:361:1::/64", "fd00:360:0::10"},
	} {
		out, code := r.sh(item.service, "ip -6 addr show; echo ---; ip -6 route")
		r.addCheckToFacility(item.service+" has a global test address and route for DCUtR",
			code == 0 && strings.Contains(out, canonicalIP6(item.global)) &&
				strings.Contains(out, canonicalIP6(item.other)) && strings.Contains(out, "via "+canonicalIP6(item.peer)),
			strings.TrimSpace(out))
	}
	globalRoute, globalCode := r.sh("a-quic", "ip -6 route get 2001:4860:362:1::10")
	r.addCheckToFacility("site A global test address routes through its site firewall",
		globalCode == 0 && strings.Contains(globalRoute, "via "+canonicalIP6("fd00:361:1::2")), strings.TrimSpace(globalRoute))

	before, _ := r.ip6ForwardDropCounter("fw-a")
	probe, probeCode := r.sh("wan-probe", "ping -6 -c 1 -W 2 fd00:361:1::10")
	r.addCheckToFacility("unsolicited WAN->site ping is dropped", probeCode != 0, strings.TrimSpace(probe))
	_, dialErr := r.connect("wan-probe", "/ip6/fd00:361:1::10/udp/4001/quic-v1/p2p/"+r.ids["a-quic"])
	r.addCheckToFacility("unsolicited WAN->site QUIC dial fails", dialErr != nil, fmt.Sprintf("err=%v", dialErr))
	time.Sleep(500 * time.Millisecond)
	after, _ := r.ip6ForwardDropCounter("fw-a")
	r.addCheckToFacility("site A firewall WAN->LAN DROP counter increased", after > before, fmt.Sprintf("before=%d after=%d", before, after))

	ct, _ := r.sh("fw-a", "conntrack -L -f ipv6 2>/dev/null | head -20; true")
	r.addCheckToFacility("IPv6 conntrack state is observable", strings.Contains(strings.ToLower(ct), "icmpv6"), strings.TrimSpace(ct))

	// A successful on-link flow creates a real conntrack entry on the site
	// router; this is what later admits ESTABLISHED return traffic, not a
	// static 4001 allow rule.
	onlink, onlinkCode := r.sh("a-quic", "ping -6 -c 1 -W 2 fd00:360:0::2")
	if onlinkCode == 0 && strings.Contains(onlink, "1 received") {
		time.Sleep(300 * time.Millisecond)
		realCT, _ := r.sh("fw-a", "conntrack -L -f ipv6 2>/dev/null | head -20; true")
		r.addCheckToFacility("real IPv6 conntrack mapping exists for an allowed flow", strings.Contains(strings.ToLower(realCT), "icmpv6"), strings.TrimSpace(realCT))
	}
	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("IPv6 stateful firewall facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) facilityDualNAT() (string, error) {
	for _, router := range []string{"nat-a", "nat-b"} {
		rules, err := r.iptables(router)
		r.requireFacility(router+" keeps strict conntrack rules (no static DNAT, no unconditional WAN->LAN ACCEPT)",
			boolError(err == nil && strings.Contains(rules, "MASQUERADE") && !strings.Contains(rules, "-j DNAT") &&
				strings.Contains(rules, "-P FORWARD DROP") && strings.Contains(rules, "ESTABLISHED") && strings.Contains(rules, "RELATED"), fmt.Sprintf("%v %s", err, rules)))
	}
	route, code := r.sh("a-quic", "ip route; echo ---; ip route get 11.41.0.2")
	r.addCheckToFacility("NATed peer routes WAN traffic through its router", code == 0 && strings.Contains(route, "default via 10.249.1.2") && strings.Contains(route, "11.41.0.2"),
		strings.TrimSpace(route))
	ping, code := r.sh("a-quic", "ping -c 1 -W 2 10.249.2.10")
	r.addCheckToFacility("cross-LAN peer address is not directly reachable", code != 0, strings.TrimSpace(ping))
	relayPing, code := r.sh("a-quic", "ping -c 1 -W 2 11.41.0.2")
	r.addCheckToFacility("WAN relay is reachable through the NAT router", code == 0 && strings.Contains(relayPing, "1 received"), strings.TrimSpace(relayPing))
	_, dialErr := r.connect("a-quic", "/ip4/11.41.0.11/udp/4001/quic-v1/p2p/"+r.ids["b-quic"])
	r.addCheckToFacility("inbound direct dial to the other WAN address fails (no mapping)", dialErr != nil, fmt.Sprintf("err=%v", dialErr))
	ports, _ := r.compose(r.stack, "ps", "--format", "{{.Service}} {{.Ports}}")
	r.addCheckToFacility("no host-published ports", !strings.Contains(ports, "0.0.0.0:") && !strings.Contains(ports, "->"), strings.TrimSpace(ports))
	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("dual-NAT facility self-check failed")
	}
	return "PASS", nil
}

func (r *runner) forwardDropCounter(router string) (int, error) {
	out, code := r.sh(router, "iptables -w 5 -vnL FORWARD | awk '$0 ~ /10.249.1.0\\/24/ && $0 ~ /DROP/ {print $1; exit}'")
	if code != 0 {
		return 0, fmt.Errorf("%s forward counter exit %d: %s", router, code, out)
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(out)
	if err != nil {
		return 0, fmt.Errorf("%s forward counter parse %q: %w", router, out, err)
	}
	return n, nil
}

func (r *runner) facilityNAT13() (string, error) {
	if out, code := r.sh("wan-probe", "ip route replace 10.249.1.0/24 via 11.41.0.10; ip route get 10.249.1.10"); code != 0 {
		r.addCheckToFacility("WAN-only probe route points at the NAT router", false, out)
		return "FAIL", fmt.Errorf("wan-probe route: %s", out)
	}
	before, _ := r.forwardDropCounter("nat-a")
	ping, code := r.sh("wan-probe", "ping -c 1 -W 2 10.249.1.10")
	r.addCheckToFacility("unsolicited WAN->LAN probe is dropped", code != 0, strings.TrimSpace(ping))
	time.Sleep(500 * time.Millisecond)
	after, _ := r.forwardDropCounter("nat-a")
	r.addCheckToFacility("router-local WAN->LAN DROP counter increased", after > before, fmt.Sprintf("before=%d after=%d", before, after))

	ct, _ := r.sh("nat-a", "conntrack -L -p icmp 2>/dev/null | grep 'dst=10.249.1.10' | head -5; true")
	r.addCheckToFacility("no conntrack mapping was created for the unsolicited probe", !strings.Contains(ct, "11.41.0.20"), strings.TrimSpace(ct))

	reply, code := r.sh("a-quic", "ping -c 1 -W 2 11.41.0.20")
	r.addCheckToFacility("normal outbound probe and MASQUERADE reply work", code == 0 && strings.Contains(reply, "1 received"), strings.TrimSpace(reply))
	ctReply, _ := r.sh("nat-a", "conntrack -L -p icmp 2>/dev/null | grep '10.249.1.10' | grep '11.41.0.20' | head -5; true")
	r.addCheckToFacility("real conntrack mapping exists for the normal flow", strings.Contains(ctReply, "10.249.1.10") && strings.Contains(ctReply, "11.41.0.20"), strings.TrimSpace(ctReply))

	natRules, _ := r.sh("nat-a", "iptables -w 5 -t nat -S")
	r.addCheckToFacility("no static DNAT in the NAT router", !strings.Contains(natRules, "-j DNAT"), strings.TrimSpace(natRules))

	_, _ = r.sh("wan-probe", "ip route del 10.249.1.0/24 2>/dev/null; true")
	if !r.facilityPassed() {
		return "FAIL", fmt.Errorf("NAT13 facility self-check failed")
	}
	return "PASS", nil
}
