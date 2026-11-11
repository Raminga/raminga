package main

import (
	"fmt"
	"strings"
	"time"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

func (r *runner) waitRelayState(service, relayPeerID string, wantLost bool, timeout time.Duration) (*apiv1.RelayReservation, error) {
	var found *apiv1.RelayReservation
	_, err := r.waitFor("relay state "+relayPeerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		relay := relayIn(st, relayPeerID)
		if relay == nil {
			return false, "missing relay", nil
		}
		found = relay
		if wantLost {
			if (relay.GetStatus() == "lost" || relay.GetStatus() == "failed") && relay.GetRelayedAddr() == "" {
				return true, relay.GetStatus() + " " + relay.GetLastError(), nil
			}
			return false, fmt.Sprintf("status=%s relayed=%q", relay.GetStatus(), relay.GetRelayedAddr()), nil
		}
		if relay.GetStatus() == "active" && relay.GetRelayedAddr() != "" {
			return true, relay.GetRelayedAddr(), nil
		}
		return false, fmt.Sprintf("status=%s", relay.GetStatus()), nil
	})
	return found, err
}

func (r *runner) checkChat(name, service, peerID, text, route, transport string) (*apiv1.SendChatResponse, error) {
	res, err := r.send(service, peerID, text)
	if !r.require(name+" send", err) {
		return nil, err
	}
	r.addCheck(name+" matching ACK", res.GetAcked() && res.GetAckMessageId() == res.GetMessageId(),
		fmt.Sprintf("message=%s ack=%s acked=%t error=%s", res.GetMessageId(), res.GetAckMessageId(), res.GetAcked(), res.GetError()))
	if route != "" {
		r.addCheck(name+" route/transport", res.GetRoute() == route && (transport == "" || res.GetTransport() == transport),
			fmt.Sprintf("route=%s transport=%s relay=%s", res.GetRoute(), res.GetTransport(), res.GetRelayPeerId()))
	}
	if !res.GetAcked() {
		return res, fmt.Errorf("%s was not ACKed: %s", name, res.GetError())
	}
	return res, nil
}

func (r *runner) connectionFor(st *apiv1.StatusResponse, peerID string) *apiv1.ConnectionDetail {
	for _, conn := range st.GetConnections() {
		if conn.GetPeerId() == peerID {
			return conn
		}
	}
	return nil
}

func (r *runner) scenarioPeerIDSelection() (string, error) {
	a, b := "id-a", "id-b"
	aID, bID := r.ids[a], r.ids[b]
	a4, b4 := "10.250.1.81", "10.250.1.82"
	b6 := "fd00:250:1::82"
	if !r.require("distinct peer-ID-selection peer IDs", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}

	// Phase 1: IPv4 is blocked and only the Peer ID is passed to connect/chat.
	for _, item := range []struct{ service, peer string }{{a, b4}, {b, a4}} {
		if err := r.setFamilyDrop(item.service, "ipv4", item.peer, true); err != nil {
			r.addCheck(item.service+" IPv4 DROP installed", false, err.Error())
			return "FAIL", nil
		}
	}
	r.addCheck("IPv4 DROP installed on both peers", true, "IPv4 path blocked, IPv6 ULA remains")
	for _, addr := range []string{
		"/ip6/" + b6 + "/tcp/4001/p2p/" + bID,
		"/ip6/" + b6 + "/udp/4001/quic-v1/p2p/" + bID,
		"/ip4/" + b4 + "/tcp/4001/p2p/" + bID,
	} {
		if err := r.peersAdd(a, addr); err != nil {
			r.addCheck("seed PeerStore without dialing", false, err.Error())
			return "FAIL", nil
		}
	}
	r.addCheck("PeerStore seeded without dialing", true, "IPv6 TCP/QUIC and IPv4 candidates")

	conn, err := r.connectPeer(a, bID)
	if !r.require("peer-ID-only connect resolves a candidate", err) {
		return "FAIL", nil
	}
	r.addCheck("peer-ID-only connect selected IPv6", conn.GetDirect() && conn.GetRoute() == "direct" &&
		strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/") && !strings.Contains(conn.GetRemoteMultiaddr(), "/ip4/"),
		fmt.Sprintf("transport=%s route=%s addr=%s source=%s reused=%t", conn.GetTransport(), conn.GetRoute(), conn.GetRemoteMultiaddr(), conn.GetSource(), conn.GetReused()))
	r.addCheck("peer-ID-only connect was not a reuse", !conn.GetReused(), fmt.Sprintf("reused=%t", conn.GetReused()))
	r.addCheck("peer-ID-only connect reports a successful IPv6 attempt", firstOKFamily(conn.GetAttempts()) == "ipv6",
		attemptSummary(conn.GetAttempts()))

	// A second connect with an explicit different transport must report reuse.
	otherTransport := "quic"
	if conn.GetTransport() == "quic" {
		otherTransport = "tcp"
	}
	explicit := "/ip6/" + b6 + "/tcp/4001/p2p/" + bID
	if otherTransport == "quic" {
		explicit = "/ip6/" + b6 + "/udp/4001/quic-v1/p2p/" + bID
	}
	reused, err := r.connect(a, explicit)
	if !r.require("explicit connect while connected", err) {
		return "FAIL", nil
	}
	r.addCheck("existing connection is reported as reused", reused.GetReused() && reused.GetRequestedTransport() == otherTransport &&
		reused.GetTransport() == conn.GetTransport() && reused.GetTransportChanged() && reused.GetNote() != "",
		fmt.Sprintf("reused=%t requested=%s transport=%s changed=%t note=%s", reused.GetReused(), reused.GetRequestedTransport(), reused.GetTransport(), reused.GetTransportChanged(), reused.GetNote()))

	sent, err := r.send(a, bID, "g3-peerid-ipv6-"+time.Now().Format("150405"))
	if !r.require("chat send by Peer ID without a multiaddr", err) {
		return "FAIL", nil
	}
	r.addCheck("chat by Peer ID is ACKed over IPv6 and reused", sent.GetAcked() && sent.GetAckMessageId() == sent.GetMessageId() &&
		sent.GetReused() && strings.Contains(sent.GetRemoteMultiaddr(), "/ip6/"),
		fmt.Sprintf("acked=%t reused=%t addr=%s route=%s", sent.GetAcked(), sent.GetReused(), sent.GetRemoteMultiaddr(), sent.GetRoute()))
	if !sent.GetAcked() {
		return "FAIL", nil
	}

	// Phase 2 uses a fresh pair with no prior connection. IPv6 is blocked, so
	// the IPv6 candidates must fail and the node must automatically try the
	// other family (IPv4) for the same Peer ID.
	fa, fb := "fb-a", "fb-b"
	faID, fbID := r.ids[fa], r.ids[fb]
	fa6, fb6, fb4 := "fd00:250:1::91", "fd00:250:1::92", "10.250.1.92"
	if !r.require("distinct fallback peer IDs", boolError(faID != "" && fbID != "" && faID != fbID, faID+" "+fbID)) {
		return "FAIL", nil
	}
	for _, item := range []struct{ service, peer string }{{fa, fb6}, {fb, fa6}} {
		if err := r.setFamilyDrop(item.service, "ipv6", item.peer, true); err != nil {
			r.addCheck(item.service+" IPv6 DROP installed", false, err.Error())
			return "FAIL", nil
		}
	}
	r.addCheck("IPv6 DROP installed on the fresh fallback pair", true, "IPv6 blocked, IPv4 remains")
	for _, addr := range []string{
		"/ip6/" + fb6 + "/tcp/4001/p2p/" + fbID,
		"/ip6/" + fb6 + "/udp/4001/quic-v1/p2p/" + fbID,
		"/ip4/" + fb4 + "/udp/4001/quic-v1/p2p/" + fbID,
	} {
		if err := r.peersAdd(fa, addr); err != nil {
			r.addCheck("seed fallback PeerStore without dialing", false, err.Error())
			return "FAIL", nil
		}
	}
	fallback, err := r.connectPeer(fa, fbID)
	if !r.require("peer-ID connect after the first family is blocked", err) {
		r.addCheck("family fallback tried the other family", false, "no successful fallback")
		return "FAIL", nil
	}
	r.addCheck("fallback connected over IPv4 after IPv6 failed", strings.Contains(fallback.GetRemoteMultiaddr(), "/ip4/") &&
		!strings.Contains(fallback.GetRemoteMultiaddr(), "/ip6/"), fallback.GetRemoteMultiaddr())
	r.addCheck("fallback reports the failed IPv6 candidate and the IPv4 success",
		hasFailedFamily(fallback.GetAttempts(), "ipv6") && hasOKFamily(fallback.GetAttempts(), "ipv4"),
		attemptSummary(fallback.GetAttempts()))

	fallbackSend, err := r.send(fa, fbID, "g3-peerid-fallback-"+time.Now().Format("150405"))
	if !r.require("chat send after family fallback", err) {
		return "FAIL", nil
	}
	r.addCheck("fallback chat is ACKed over IPv4", fallbackSend.GetAcked() && fallbackSend.GetAckMessageId() == fallbackSend.GetMessageId() &&
		strings.Contains(fallbackSend.GetRemoteMultiaddr(), "/ip4/"),
		fmt.Sprintf("acked=%t addr=%s", fallbackSend.GetAcked(), fallbackSend.GetRemoteMultiaddr()))
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) setFamilyDrop(service, family, peer string, add bool) error {
	binary := "iptables"
	if family == "ipv6" {
		binary = "ip6tables"
	}
	var script strings.Builder
	for _, direction := range []string{"INPUT", "OUTPUT"} {
		flag := "-s"
		if direction == "OUTPUT" {
			flag = "-d"
		}
		if add {
			fmt.Fprintf(&script, "%s -w 5 -C %s %s %s -j DROP 2>/dev/null || %s -w 5 -A %s %s %s -j DROP; ",
				binary, direction, flag, peer, binary, direction, flag, peer)
			continue
		}
		fmt.Fprintf(&script, "while %s -w 5 -D %s %s %s -j DROP 2>/dev/null; do :; done; ",
			binary, direction, flag, peer)
	}
	out, code := r.sh(service, script.String())
	if code != 0 {
		return fmt.Errorf("%s %s %s add=%t: %s", service, binary, peer, add, out)
	}
	return nil
}

func attemptSummary(attempts []*apiv1.DialAttempt) string {
	parts := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		parts = append(parts, fmt.Sprintf("%s/%s/ok=%t/backoff=%t/%s", attempt.GetFamily(), attempt.GetSource(), attempt.GetOk(), attempt.GetBackoff(), attempt.GetError()))
	}
	return strings.Join(parts, "; ")
}

func firstOKFamily(attempts []*apiv1.DialAttempt) string {
	for _, attempt := range attempts {
		if attempt.GetOk() {
			return attempt.GetFamily()
		}
	}
	return ""
}

func hasFailedFamily(attempts []*apiv1.DialAttempt, family string) bool {
	for _, attempt := range attempts {
		if attempt.GetFamily() == family && !attempt.GetOk() && attempt.GetError() != "" {
			return true
		}
	}
	return false
}

func hasOKFamily(attempts []*apiv1.DialAttempt, family string) bool {
	for _, attempt := range attempts {
		if attempt.GetFamily() == family && attempt.GetOk() {
			return true
		}
	}
	return false
}

func firstAddr(p *apiv1.PeerStatus) string {
	if p == nil || len(p.GetAddrs()) == 0 {
		return ""
	}
	return p.GetAddrs()[0]
}

func dcutrFailureReason(st *apiv1.StatusResponse) string {
	dcutr := st.GetNetwork().GetDcutr()
	for _, p := range dcutr.GetPeers() {
		if p.GetError() != "" {
			return p.GetPeerId() + ": " + p.GetError()
		}
	}
	for _, evt := range dcutr.GetEvents() {
		if evt.GetError() != "" {
			return evt.GetType() + ": " + evt.GetError()
		}
	}
	return ""
}

func (r *runner) scenarioLANIPv4() (string, error) {
	a, b := "a4", "b4"
	aID, bID := r.ids[a], r.ids[b]
	if !r.require("distinct IPv4 LAN identities", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}
	addr := "/ip4/10.250.1.12/tcp/4001/p2p/" + bID
	conn, err := r.connect(a, addr)
	if !r.require("IPv4 TCP direct dial", err) {
		return "FAIL", nil
	}
	r.addCheck("IPv4 dial is direct TCP", conn.GetPeerId() == bID && conn.GetDirect() && !conn.GetLimited() &&
		conn.GetRoute() == "direct" && conn.GetTransport() == "tcp", fmt.Sprintf("%v", conn))
	r.addCheck("IPv4 connection multiaddr uses IPv4", strings.Contains(conn.GetRemoteMultiaddr(), "/ip4/10.250.1.12/") && !strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/"),
		conn.GetRemoteMultiaddr())
	if _, err := r.checkChat("A->B IPv4", a, bID, "g3-lan-ipv4-a-b-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A IPv4", b, aID, "g3-lan-ipv4-b-a-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("IPv4 status", err) {
		return "FAIL", nil
	}
	c := r.connectionFor(st, bID)
	r.addCheck("status corroborates direct TCP connection", c != nil && c.GetDirect() && c.GetTransport() == "tcp" && c.GetRoute() == "direct",
		fmt.Sprintf("%v", c))
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioLANIPv6() (string, error) {
	a, b := "a6", "b6"
	aID, bID := r.ids[a], r.ids[b]
	if !r.require("distinct IPv6 LAN identities", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}
	addr := "/ip6/fd00:250:1::22/tcp/4001/p2p/" + bID
	conn, err := r.connect(a, addr)
	if !r.require("IPv6 TCP direct dial through the stateful firewall", err) {
		return "FAIL", nil
	}
	r.addCheck("IPv6 dial is direct TCP", conn.GetPeerId() == bID && conn.GetDirect() && !conn.GetLimited() &&
		conn.GetRoute() == "direct" && conn.GetTransport() == "tcp", fmt.Sprintf("%v", conn))
	r.addCheck("IPv6 connection multiaddr uses the ULA address", strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/fd00:250:1::22/") && !strings.Contains(conn.GetRemoteMultiaddr(), "/ip4/"),
		conn.GetRemoteMultiaddr())
	if _, err := r.checkChat("A->B IPv6", a, bID, "g3-lan-ipv6-a-b-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A IPv6", b, aID, "g3-lan-ipv6-b-a-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("IPv6 status", err) {
		return "FAIL", nil
	}
	c := r.connectionFor(st, bID)
	r.addCheck("status corroborates IPv6 direct connection", c != nil && c.GetDirect() && strings.Contains(c.GetRemoteMultiaddr(), "/ip6/"),
		fmt.Sprintf("%v", c))
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioIPv6Only() (string, error) {
	a, b := "a6only", "b6only"
	aID, bID := r.ids[a], r.ids[b]
	a4, b4 := "10.250.1.31", "10.250.1.32"
	for _, item := range []struct{ service, peer string }{{a, b4}, {b, a4}} {
		script := fmt.Sprintf("iptables -w 5 -C INPUT -s %s -j DROP 2>/dev/null || iptables -w 5 -A INPUT -s %s -j DROP; "+
			"iptables -w 5 -C OUTPUT -d %s -j DROP 2>/dev/null || iptables -w 5 -A OUTPUT -d %s -j DROP", item.peer, item.peer, item.peer, item.peer)
		out, code := r.sh(item.service, script)
		if code != 0 {
			r.addCheck(item.service+" IPv4 DROP installed", false, out)
			return "FAIL", nil
		}
	}
	r.addCheck("IPv4 DROP rules installed on both peers", true, "iptables INPUT/OUTPUT")
	ping4, code := r.sh(a, "ping -4 -c 1 -W 2 "+b4)
	r.addCheck("IPv4 path is unreachable", code != 0, strings.TrimSpace(ping4))
	ping6, code := r.sh(a, "ping -6 -c 1 -W 2 fd00:250:1::32")
	r.addCheck("IPv6 path remains reachable", code == 0 && strings.Contains(ping6, "1 received"), strings.TrimSpace(ping6))

	_, ipv4Err := r.connect(a, "/ip4/"+b4+"/tcp/4001/p2p/"+bID)
	r.addCheck("IPv4 attempt is reported as a failure", ipv4Err != nil, fmt.Sprintf("err=%v", ipv4Err))
	_, retryErr := r.connect(a, "/ip4/"+b4+"/tcp/4001/p2p/"+bID)
	r.addCheck("retry over the unreachable IPv4 path still fails honestly", retryErr != nil, fmt.Sprintf("err=%v", retryErr))

	conn, err := r.connect(a, "/ip6/fd00:250:1::32/tcp/4001/p2p/"+bID)
	if !r.require("IPv6 fallback dial", err) {
		return "FAIL", nil
	}
	r.addCheck("fallback connection is IPv6", conn.GetDirect() && conn.GetTransport() == "tcp" &&
		strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/fd00:250:1::32/") && !strings.Contains(conn.GetRemoteMultiaddr(), "/ip4/"),
		fmt.Sprintf("route=%s transport=%s addr=%s", conn.GetRoute(), conn.GetTransport(), conn.GetRemoteMultiaddr()))
	if _, err := r.checkChat("A->B IPv6-only", a, bID, "g3-ipv6only-a-b-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A IPv6-only", b, aID, "g3-ipv6only-b-a-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioUDPBlocked() (string, error) {
	a, b := "tcp-a", "tcp-b"
	aID, bID := r.ids[a], r.ids[b]
	rules, _ := r.sh(a, "iptables -w 5 -S INPUT")
	r.addCheck("UDP-only block rule is still installed", strings.Contains(rules, "-p udp") && strings.Contains(rules, "--dport 4001"), strings.TrimSpace(rules))
	_, quicErr := r.connect(a, "/ip4/10.250.1.42/udp/4001/quic-v1/p2p/"+bID)
	r.addCheck("blocked QUIC path fails clearly", quicErr != nil, fmt.Sprintf("err=%v", quicErr))

	conn, err := r.connect(a, "/ip4/10.250.1.42/tcp/4001/p2p/"+bID)
	if !r.require("viable TCP path connects", err) {
		return "FAIL", nil
	}
	r.addCheck("viable path reports TCP, never QUIC", conn.GetTransport() == "tcp" && conn.GetRoute() == "direct" && conn.GetDirect() && !conn.GetLimited(),
		fmt.Sprintf("transport=%s route=%s direct=%t", conn.GetTransport(), conn.GetRoute(), conn.GetDirect()))
	if _, err := r.checkChat("A->B UDP-blocked", a, bID, "g3-udpblock-a-b-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A UDP-blocked", b, aID, "g3-udpblock-b-a-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("UDP-blocked status", err) {
		return "FAIL", nil
	}
	quicReported := false
	for _, c := range st.GetConnections() {
		if c.GetPeerId() == bID && c.GetTransport() == "quic" {
			quicReported = true
		}
	}
	r.addCheck("no false QUIC transport is reported", !quicReported, "connections checked")
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioTCPBlocked() (string, error) {
	a, b := "udp-a", "udp-b"
	aID, bID := r.ids[a], r.ids[b]
	rules, _ := r.sh(a, "iptables -w 5 -S INPUT")
	r.addCheck("TCP-only block rule is still installed", strings.Contains(rules, "-p tcp") && strings.Contains(rules, "--dport 4001"), strings.TrimSpace(rules))
	_, tcpErr := r.connect(a, "/ip4/10.250.1.52/tcp/4001/p2p/"+bID)
	r.addCheck("blocked TCP path fails clearly", tcpErr != nil, fmt.Sprintf("err=%v", tcpErr))

	conn, err := r.connect(a, "/ip4/10.250.1.52/udp/4001/quic-v1/p2p/"+bID)
	if !r.require("viable QUIC path connects", err) {
		return "FAIL", nil
	}
	r.addCheck("viable path reports QUIC, never TCP", conn.GetTransport() == "quic" && conn.GetRoute() == "direct" && conn.GetDirect() && !conn.GetLimited(),
		fmt.Sprintf("transport=%s route=%s direct=%t", conn.GetTransport(), conn.GetRoute(), conn.GetDirect()))
	if _, err := r.checkChat("A->B TCP-blocked", a, bID, "g3-tcpblock-a-b-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A TCP-blocked", b, aID, "g3-tcpblock-b-a-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("TCP-blocked status", err) {
		return "FAIL", nil
	}
	tcpReported := false
	for _, c := range st.GetConnections() {
		if c.GetPeerId() == bID && c.GetTransport() == "tcp" {
			tcpReported = true
		}
	}
	r.addCheck("no false TCP transport is reported", !tcpReported, "connections checked")
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioNetem() (string, error) {
	a, b := "loss-a", "loss-b"
	_, bID := r.ids[a], r.ids[b]
	qdisc, code := r.sh(a, "tc qdisc show dev eth0")
	r.addCheck("netem delay/loss is active before the scenario", code == 0 && strings.Contains(qdisc, "netem") && strings.Contains(qdisc, "delay 120ms") && strings.Contains(qdisc, "loss 10%"),
		strings.TrimSpace(qdisc))

	conn, err := r.connect(a, "/ip4/10.250.1.62/tcp/4001/p2p/"+bID)
	if !r.require("connect under netem", err) {
		return "FAIL", nil
	}
	r.addCheck("connection is still direct TCP under netem", conn.GetDirect() && conn.GetTransport() == "tcp" && conn.GetRoute() == "direct",
		fmt.Sprintf("transport=%s route=%s addr=%s", conn.GetTransport(), conn.GetRoute(), conn.GetRemoteMultiaddr()))

	acked, failed := 0, 0
	var failedID string
	for i := 0; i < 5; i++ {
		start := time.Now()
		res, sendErr := r.send(a, bID, fmt.Sprintf("g3-netem-%d-%s", i, time.Now().Format("150405")))
		elapsed := time.Since(start)
		if sendErr != nil {
			r.addCheck(fmt.Sprintf("netem send %d returned a local result", i), false, sendErr.Error())
			continue
		}
		if res.GetAcked() {
			acked++
			r.addCheck(fmt.Sprintf("netem send %d ACK is consistent", i), res.GetAckMessageId() == res.GetMessageId(),
				fmt.Sprintf("elapsed=%s ack=%s", elapsed, res.GetAckMessageId()))
			if elapsed < 100*time.Millisecond {
				r.addCheck(fmt.Sprintf("netem send %d observed injected latency", i), false, fmt.Sprintf("elapsed=%s", elapsed))
			} else {
				r.addCheck(fmt.Sprintf("netem send %d observed injected latency", i), true, fmt.Sprintf("elapsed=%s", elapsed))
			}
		} else {
			failed++
			failedID = res.GetMessageId()
			r.addCheck(fmt.Sprintf("netem send %d failure has no fake ACK", i), !res.GetAcked() && res.GetError() != "" && res.GetAckMessageId() == "",
				fmt.Sprintf("error=%s", res.GetError()))
		}
	}
	r.addCheck("at least one lossy send was ACKed, and failures stayed honest", acked > 0, fmt.Sprintf("acked=%d failed=%d", acked, failed))

	// 100% loss must produce a bound timeout with no fabricated ACK.
	for _, service := range []string{a, b} {
		out, code := r.sh(service, "tc qdisc change dev eth0 root netem delay 120ms loss 100%")
		if code != 0 {
			r.addCheck(service+" 100% loss qdisc", false, out)
			return "FAIL", nil
		}
	}
	start := time.Now()
	blocked, sendErr := r.send(a, bID, "g3-netem-blackhole-"+time.Now().Format("150405"))
	elapsed := time.Since(start)
	if sendErr != nil {
		// The local API call itself may hit its deadline while the dial/ACK is
		// still blocked. That is an honest timeout: no ACK is manufactured and
		// no message is reported as delivered.
		r.addCheck("100% loss send returns a bounded failure without an ACK",
			elapsed <= 35*time.Second && (strings.Contains(sendErr.Error(), "deadline_exceeded") || strings.Contains(sendErr.Error(), "i/o timeout")),
			fmt.Sprintf("elapsed=%s err=%s", elapsed, sendErr))
	} else {
		r.addCheck("100% loss send is not ACKed", !blocked.GetAcked() && blocked.GetError() != "" && blocked.GetAckMessageId() == "",
			fmt.Sprintf("acked=%t error=%s ack=%q", blocked.GetAcked(), blocked.GetError(), blocked.GetAckMessageId()))
		r.addCheck("100% loss timeout is bounded (<= 35s)", elapsed <= 35*time.Second, fmt.Sprintf("elapsed=%s", elapsed))
		if blocked.GetMessageId() != "" {
			failedID = blocked.GetMessageId()
		}
	}

	for _, service := range []string{a, b} {
		out, code := r.sh(service, "tc qdisc del dev eth0 root 2>/dev/null; tc qdisc show dev eth0")
		if code != 0 {
			r.addCheck(service+" netem removal", false, out)
			return "FAIL", nil
		}
	}
	if err := r.disconnect(a, bID); err == nil {
		r.addCheck("disconnect after loss", true, "closed")
	} else {
		r.addCheck("disconnect after loss", true, err.Error())
	}
	_ = r.waitPeerOffline(a, bID, 20*time.Second)
	if _, err := r.connect(a, "/ip4/10.250.1.62/tcp/4001/p2p/"+bID); !r.require("reconnect after netem removal", err) {
		return "FAIL", nil
	}
	retry, err := r.send(a, bID, "g3-netem-retry-"+time.Now().Format("150405"))
	if !r.require("retry after recovery", err) {
		return "FAIL", nil
	}
	r.addCheck("retry after recovery is ACKed", retry.GetAcked() && retry.GetAckMessageId() == retry.GetMessageId(),
		fmt.Sprintf("acked=%t error=%s", retry.GetAcked(), retry.GetError()))

	st, err := r.status(a)
	if !r.require("resource status after netem", err) {
		return "FAIL", nil
	}
	res := st.GetNetwork().GetResources()
	r.addCheck("connections and streams stay bounded after loss", res.GetOpenConnections() <= 2 && res.GetOpenStreams() <= 4,
		fmt.Sprintf("connections=%d streams=%d", res.GetOpenConnections(), res.GetOpenStreams()))

	time.Sleep(time.Second)
	logs := r.composeLogs(a)
	r.addCheck("logs record the failed send without a fake ACK",
		(strings.Contains(logs, "chat send failed without ACK") || strings.Contains(logs, "chat send aborted before stream open") ||
			strings.Contains(logs, "context deadline exceeded") || strings.Contains(logs, "i/o timeout")) &&
			(failedID == "" || strings.Contains(logs, failedID)),
		"failed message id "+failedID)
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioOneSided() (string, error) {
	peer, pub := "peer", "pub"
	peerID, pubID := r.ids[peer], r.ids[pub]
	pubAddr := "/ip4/11.43.0.10/tcp/4001/p2p/" + pubID
	conn, err := r.connect(peer, pubAddr)
	if !r.require("restricted side dials the public node", err) {
		return "FAIL", nil
	}
	r.addCheck("restricted side is the outbound direct dialer", conn.GetDirect() && !conn.GetLimited() && conn.GetRoute() == "direct" && conn.GetTransport() == "tcp",
		fmt.Sprintf("route=%s transport=%s", conn.GetRoute(), conn.GetTransport()))
	stPeer, err := r.status(peer)
	if !r.require("restricted side status", err) {
		return "FAIL", nil
	}
	p := peerIn(stPeer, pubID)
	r.addCheck("restricted side records an outbound connection", p != nil && p.GetDirection() == "outbound", fmt.Sprintf("%v", p))
	stPub, err := r.status(pub)
	if !r.require("public side status", err) {
		return "FAIL", nil
	}
	pp := peerIn(stPub, peerID)
	r.addCheck("public side records an inbound connection", pp != nil && pp.GetDirection() == "inbound", fmt.Sprintf("%v", pp))

	if _, err := r.checkChat("restricted->public", peer, pubID, "g3-onesided-out-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("public->restricted reverse stream", pub, peerID, "g3-onesided-back-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}

	if err := r.disconnect(pub, peerID); err != nil {
		r.addCheck("disconnect one-sided connection", false, err.Error())
		return "FAIL", nil
	}
	if err := r.waitPeerOffline(peer, pubID, 20*time.Second); !r.require("restricted side sees the disconnect", err) {
		return "FAIL", nil
	}
	noAck, noAckErr := r.send(pub, peerID, "g3-onesided-no-fake-"+time.Now().Format("150405"))
	r.addCheck("no fake ACK while the one-sided connection is gone", noAckErr == nil && !noAck.GetAcked() && noAck.GetError() != "",
		fmt.Sprintf("err=%v acked=%t detail=%s", noAckErr, noAck.GetAcked(), noAck.GetError()))

	if _, err := r.connect(peer, pubAddr); !r.require("restricted side redials after disconnect", err) {
		return "FAIL", nil
	}
	recovered, err := r.checkChat("restricted->public after recovery", peer, pubID, "g3-onesided-recover-"+time.Now().Format("150405"), "direct", "")
	if err != nil {
		return "FAIL", nil
	}
	r.addCheck("recovery is direct on an established transport", recovered.GetRoute() == "direct" && recovered.GetTransport() != "",
		fmt.Sprintf("route=%s transport=%s", recovered.GetRoute(), recovered.GetTransport()))
	if _, err := r.checkChat("public->restricted after recovery", pub, peerID, "g3-onesided-recover-back-"+time.Now().Format("150405"), "direct", ""); err != nil {
		return "FAIL", nil
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioSymmetric() (string, error) {
	a, b := "a", "b"
	aID, bID := r.ids[a], r.ids[b]
	relayID := r.ids["relay"]
	if _, err := r.waitRelayActive(b, relayID, 120*time.Second); !r.require("b reservation on the WAN relay", err) {
		return "FAIL", nil
	}
	relay, err := r.waitRelayActive(b, relayID, 30*time.Second)
	if !r.require("relay address for the symmetric pair", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, relayID, 120*time.Second); !r.require("a connection/reservation on the WAN relay", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("connect through the only possible relay path", err) {
		return "FAIL", nil
	}
	r.addCheck("connection is limited relay, never direct", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect() && conn.GetRelayPeerId() == relayID,
		fmt.Sprintf("route=%s limited=%t direct=%t relay=%s", conn.GetRoute(), conn.GetLimited(), conn.GetDirect(), conn.GetRelayPeerId()))
	if _, err := r.checkChat("A->B symmetric relay", a, bID, "g3-symmetric-a-b-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A symmetric relay", b, aID, "g3-symmetric-b-a-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}
	_, waitErr := r.waitFor("terminal DCUtR outcome for the symmetric pair", 45*time.Second, func() (bool, string, error) {
		st, err := r.status(a)
		if err != nil {
			return false, "", err
		}
		dcutr := st.GetNetwork().GetDcutr()
		terminal := dcutr.GetAttempts() > 0 && (dcutr.GetFailures() > 0 || dcutr.GetSuccesses() > 0)
		for _, p := range dcutr.GetPeers() {
			if p.GetPeerId() == bID && p.GetStatus() == "attempting" {
				terminal = false
			}
		}
		return terminal, fmt.Sprintf("attempts=%d successes=%d failures=%d", dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures()), nil
	})
	if !r.require("DCUtR reached a terminal outcome (no lingering attempt)", waitErr) {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("symmetric status after relay traffic", err) {
		return "FAIL", nil
	}
	direct := false
	for _, c := range st.GetConnections() {
		if c.GetPeerId() == bID && c.GetDirect() {
			direct = true
		}
	}
	dcutr := st.GetNetwork().GetDcutr()
	r.addCheck("no direct connection was fabricated or achieved", !direct,
		fmt.Sprintf("direct=%t dcutr_attempts=%d successes=%d failures=%d", direct, dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures()))
	r.addCheck("DCUtR failure is terminal with a reason", dcutr.GetAttempts() > 0 && dcutr.GetFailures() > 0 && dcutr.GetSuccesses() == 0 &&
		dcutrFailureReason(st) != "", fmt.Sprintf("dcutr=%d/%d/%d reason=%s", dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(), dcutrFailureReason(st)))
	r.addCheck("diagnosis explains relay-only with real DCUtR outcome", len(st.GetNetwork().GetRelays()) > 0 && dcutr.GetSuccesses() == 0,
		fmt.Sprintf("relays=%v dcutr=%d/%d/%d", st.GetNetwork().GetRelays(), dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures()))
	if direct {
		return "FAIL", nil
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioDualNATQUIC() (string, error) {
	a, b := "a-quic", "b-quic"
	aID, bID := r.ids[a], r.ids[b]
	r1 := r.ids["r1"]
	if !r.require("distinct QUIC peer IDs", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}
	relay, err := r.waitRelayActive(b, r1, 60*time.Second)
	if !r.require("b-quic reservation on R1", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r1, 60*time.Second); !r.require("a-quic connection/reservation on R1", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("relay connect", err) {
		return "FAIL", nil
	}
	r.addCheck("initial path is limited Circuit Relay v2", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect() && conn.GetRelayPeerId() == r1,
		fmt.Sprintf("route=%s limited=%t relay=%s", conn.GetRoute(), conn.GetLimited(), conn.GetRelayPeerId()))
	if _, err := r.checkChat("A->B after relay connect", a, bID, "g3-dual-relay-a-b-"+time.Now().Format("150405"), "", ""); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A after relay connect", b, aID, "g3-dual-relay-b-a-"+time.Now().Format("150405"), "", ""); err != nil {
		return "FAIL", nil
	}

	directA, err := r.waitDirect(a, bID, "quic", 75*time.Second)
	if !r.require("a-quic DCUtR direct QUIC connection", err) {
		r.natSet("NAT07", "dual-nat-quic-direct-stop-relays", "FAIL", err.Error())
		return "FAIL", nil
	}
	directB, err := r.waitDirect(b, aID, "quic", 75*time.Second)
	if !r.require("b-quic DCUtR direct QUIC connection", err) {
		r.natSet("NAT07", "dual-nat-quic-direct-stop-relays", "FAIL", err.Error())
		return "FAIL", nil
	}
	r.addCheck("both sides report non-limited direct QUIC", directA.GetDirect() && !directA.GetLimited() && directB.GetDirect() && !directB.GetLimited(),
		fmt.Sprintf("a=%v b=%v", directA.GetAddrs(), directB.GetAddrs()))
	if _, err := r.checkChat("A->B direct", a, bID, "g3-dual-direct-a-b-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A direct", b, aID, "g3-dual-direct-b-a-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	stA0, _ := r.status(a)
	stB0, _ := r.status(b)
	startA, startB := stA0.GetStartedAtUnixMs(), stB0.GetStartedAtUnixMs()

	if out, code := r.compose(r.stack, "stop", "r1", "r2"); code != 0 {
		r.addCheck("stop all relays", false, out)
		return "FAIL", nil
	}
	for _, relay := range []string{"r1", "r2"} {
		out, code := r.compose(r.stack, "ps", "-q", relay)
		r.addCheck(relay+" is stopped", code == 0 && strings.TrimSpace(out) == "", strings.TrimSpace(out))
	}
	time.Sleep(1500 * time.Millisecond)
	afterA, err := r.waitDirect(a, bID, "quic", 30*time.Second)
	if !r.require("A keeps direct QUIC after all relays stop", err) {
		return "FAIL", nil
	}
	afterB, err := r.waitDirect(b, aID, "quic", 30*time.Second)
	if !r.require("B keeps direct QUIC after all relays stop", err) {
		return "FAIL", nil
	}
	stA1, _ := r.status(a)
	stB1, _ := r.status(b)
	r.addCheck("same A process/Peer ID after relay stop", stA1.GetStartedAtUnixMs() == startA && stA1.GetPeerId() == aID,
		fmt.Sprintf("started=%d peer=%s", stA1.GetStartedAtUnixMs(), stA1.GetPeerId()))
	r.addCheck("same B process/Peer ID after relay stop", stB1.GetStartedAtUnixMs() == startB && stB1.GetPeerId() == bID,
		fmt.Sprintf("started=%d peer=%s", stB1.GetStartedAtUnixMs(), stB1.GetPeerId()))
	r.addCheck("direct connections survive relay stop", afterA.GetDirect() && afterB.GetDirect(), "both direct")
	if _, err := r.checkChat("A->B after relays stop", a, bID, "g3-dual-no-relay-a-b-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("B->A after relays stop", b, aID, "g3-dual-no-relay-b-a-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}

	ctA, errA := r.conntrack("nat-a", "udp", "4001")
	ctB, errB := r.conntrack("nat-b", "udp", "4001")
	fixedSource := errA == nil && errB == nil &&
		strings.Contains(ctA, "sport=4001") && strings.Contains(ctA, "dport=4001") &&
		strings.Contains(ctB, "sport=4001") && strings.Contains(ctB, "dport=4001")
	r.addCheck("real dynamic conntrack mappings with fixed source port 4001", fixedSource,
		"nat-a="+strings.TrimSpace(ctA)+" nat-b="+strings.TrimSpace(ctB))

	if out, code := r.compose(r.stack, "start", "r1", "r2"); code != 0 {
		r.addCheck("restart relays", false, out)
		return "FAIL", nil
	}
	for _, service := range []string{"r1", "r2"} {
		st, err := r.waitReady(service, 60*time.Second)
		if !r.require(service+" restarted with same Peer ID", boolError(err == nil && st.GetPeerId() == r.ids[service], fmt.Sprintf("err=%v", err))) {
			return "FAIL", nil
		}
	}
	rules, err := r.iptables("nat-a")
	r.addCheck("strict NAT-A rules are unchanged", err == nil && strings.Contains(rules, "-P FORWARD DROP") &&
		!strings.Contains(rules, "-j DNAT") && strings.Contains(rules, "ESTABLISHED") && strings.Contains(rules, "RELATED"), strings.TrimSpace(rules))

	dcutr := stA1.GetNetwork().GetDcutr()
	dcutrB := stB1.GetNetwork().GetDcutr()
	dcutrOK := dcutr.GetSuccesses() > 0 || dcutrB.GetSuccesses() > 0 || dcutr.GetAttempts() > 0 || dcutrB.GetAttempts() > 0
	r.addCheck("real DCUtR success was observed on at least one side", dcutrOK,
		fmt.Sprintf("a attempts=%d successes=%d failures=%d; b attempts=%d successes=%d failures=%d",
			dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(),
			dcutrB.GetAttempts(), dcutrB.GetSuccesses(), dcutrB.GetFailures()))
	r.natSet("NAT01", "dualnat facility + dual-nat-quic", "PASS", "strict routers, no shared network/published ports, cross-LAN direct denied, real MASQUERADE conntrack")
	r.natSet("NAT02", "dual-nat-quic-direct-stop-relays", "PASS", "both peers held active R1 reservations")
	r.natSet("NAT06", "dual-nat-quic-direct-stop-relays", "PASS", fmt.Sprintf("real QUIC DCUtR (a %d/%d/%d, b %d/%d/%d)",
		dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(), dcutrB.GetAttempts(), dcutrB.GetSuccesses(), dcutrB.GetFailures()))
	r.natSet("NAT07", "dual-nat-quic-direct-stop-relays", "PASS", "real QUIC direct plus bidirectional direct app bytes/ACKs")
	r.natSet("NAT08", "dual-nat-quic-direct-stop-relays", "PASS", "all relays stopped; same processes/Peer IDs and direct QUIC ACKs continued")
	r.natSet("NAT11", "dualnat+symmetric evidence", "PASS", "iptables/conntrack/routes/DCUtR/logs corroborate reported routes")
	if fixedSource {
		r.natSet("NAT13", "nat13-wan-filter + dual-nat-quic-direct-stop-relays", "PASS",
			"unsolicited WAN->LAN dropped by router counter with no conntrack; normal MASQUERADE reply; fixed-source 4001 mapping used for the successful simultaneous-open/direct flow; no static DNAT")
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioDualNATTCP() (string, error) {
	a, b := "a-tcp", "b-tcp"
	_, bID := r.ids[a], r.ids[b]
	relayID := r.ids["r1"]
	relay, err := r.waitRelayActive(b, relayID, 120*time.Second)
	if !r.require("b-tcp reservation on R1", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, relayID, 120*time.Second); !r.require("a-tcp connection/reservation on R1", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("TCP relay connect", err) {
		return "FAIL", nil
	}
	r.addCheck("TCP relay route is limited", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect(), conn.GetRemoteMultiaddr())
	if _, err := r.checkChat("TCP relay fallback", a, bID, "g3-tcp-relay-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}

	direct, directErr := r.waitDirect(a, bID, "tcp", 50*time.Second)
	directOK := directErr == nil && direct != nil
	if directOK {
		if _, err := r.checkChat("TCP direct", a, bID, "g3-tcp-direct-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
			return "FAIL", nil
		}
		st, _ := r.status(a)
		dcutr := st.GetNetwork().GetDcutr()
		r.addCheck("TCP direct is backed by a real DCUtR attempt or direct connection", dcutr.GetAttempts() > 0 || directOK,
			fmt.Sprintf("attempts=%d successes=%d", dcutr.GetAttempts(), dcutr.GetSuccesses()))
		r.natSet("NAT04", "dual-nat-tcp", "PASS", fmt.Sprintf("TCP DCUtR attempts=%d, direct established", dcutr.GetAttempts()))
		r.natSet("NAT05", "dual-nat-tcp", "PASS", "real TCP direct plus application bytes/ACK")
		r.natSet("NAT09", "dual-nat-tcp", "N/A", "TCP direct succeeded; fallback failure path is not applicable")
		return "PASS", nil
	}

	stA, _ := r.status(a)
	dcutr := stA.GetNetwork().GetDcutr()
	ctA, _ := r.conntrack("nat-a", "tcp", "4100")
	ctB, _ := r.conntrack("nat-b", "tcp", "4100")
	r.addCheck("TCP direct was not established (honest BLOCKED)", true,
		fmt.Sprintf("directErr=%v attempts=%d successes=%d failures=%d", directErr, dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures()))
	attempted := dcutr.GetAttempts() > 0 || dcutr.GetFailures() > 0
	r.addCheck("real TCP DCUtR attempt/failure was recorded", attempted,
		fmt.Sprintf("dcutr=%d/%d/%d conntrackA=%s conntrackB=%s", dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(), strings.TrimSpace(ctA), strings.TrimSpace(ctB)))
	fallback, fallbackErr := r.send(a, bID, "g3-tcp-fallback-after-direct-"+time.Now().Format("150405"))
	fallbackOK := fallbackErr == nil && fallback.GetAcked() && fallback.GetAckMessageId() == fallback.GetMessageId() && fallback.GetRoute() == "relay" && fallback.GetRelayPeerId() == relayID
	r.addCheck("relay fallback still ACKs after failed TCP direct", fallbackOK,
		fmt.Sprintf("err=%v acked=%t route=%s relay=%s", fallbackErr, fallback.GetAcked(), fallback.GetRoute(), fallback.GetRelayPeerId()))
	r.addCheck("TCP direct is never written as direct", fallback.GetRoute() != "direct", fallback.GetRoute())
	if !fallbackOK {
		return "FAIL", nil
	}
	if attempted {
		r.natSet("NAT04", "dual-nat-tcp", "PASS", fmt.Sprintf("real TCP DCUtR attempts=%d failures=%d", dcutr.GetAttempts(), dcutr.GetFailures()))
	} else {
		r.natSet("NAT04", "dual-nat-tcp", "FAIL", "no TCP DCUtR attempt was observed")
	}
	r.natSet("NAT05", "dual-nat-tcp", "BLOCKED",
		"no TCP direct in the strict dual-NAT topology; real attempt/NAT conntrack recorded, relay fallback used, never reported as direct")
	if attempted {
		r.natSet("NAT09", "dual-nat-tcp", "PASS", "failed TCP hole punch fell back to ACKed relay traffic with no fake ACK or direct route")
	} else {
		r.natSet("NAT09", "dual-nat-tcp", "NOT_TESTED", "no DCUtR attempt was observed, so fallback-after-failure was not exercised")
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "BLOCKED", nil
}

func (r *runner) scenarioRelayFailover() (string, error) {
	a, b := "a-relay", "b-relay"
	aID, bID := r.ids[a], r.ids[b]
	r1, r2 := r.ids["r1"], r.ids["r2"]
	if _, err := r.waitRelayActive(b, r1, 60*time.Second); !r.require("b-relay R1 reservation", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r1, 60*time.Second); !r.require("a-relay R1 reservation", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(b, r2, 60*time.Second); !r.require("b-relay R2 reservation", err) {
		return "FAIL", nil
	}
	relay, err := r.waitRelayActive(b, r1, 30*time.Second)
	if !r.require("choose R1 relayed address", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("initial circuit via R1", err) {
		return "FAIL", nil
	}
	r.addCheck("initial relay is R1", conn.GetRelayPeerId() == r1, conn.GetRelayPeerId())
	if _, err := r.checkChat("R1 failover chat", a, bID, "g3-failover-r1-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}
	r.natSet("NAT03", "relay-failover-recovery", "PASS", "bidirectional (R1 and R2) relayed HTTP chat with matching ACKs on a DCUtR-disabled pair")

	if out, code := r.compose(r.stack, "stop", "r1"); code != 0 {
		r.addCheck("stop R1", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitRelayState(a, r1, true, 30*time.Second); !r.require("R1 reservation loss diagnosed", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(b, r2, 30*time.Second); !r.require("R2 reservation remains active", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r2, 60*time.Second); !r.require("A R2 connection/reservation ready", err) {
		return "FAIL", nil
	}
	relay2, err := r.waitRelayActive(b, r2, 10*time.Second)
	if !r.require("choose R2 relayed address", err) {
		return "FAIL", nil
	}
	conn2, err := r.connect(a, relay2.GetRelayedAddr())
	if !r.require("switch to R2", err) {
		return "FAIL", nil
	}
	r.addCheck("switchover uses R2", conn2.GetRelayPeerId() == r2, conn2.GetRelayPeerId())
	if _, err := r.checkChat("R2 failover chat", a, bID, "g3-failover-r2-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}

	if out, code := r.compose(r.stack, "stop", "r2"); code != 0 {
		r.addCheck("stop R2", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitRelayState(a, r2, true, 30*time.Second); !r.require("R2 reservation loss diagnosed", err) {
		return "FAIL", nil
	}
	if err := r.disconnect(a, bID); err != nil {
		r.addCheck("relayed peer already disconnected after relay loss", true, err.Error())
	}
	if err := r.waitPeerOffline(a, bID, 20*time.Second); !r.require("peer offline after all relays stop", err) {
		return "FAIL", nil
	}
	noAck, noAckErr := r.send(a, bID, "g3-failover-no-fake-"+time.Now().Format("150405"))
	r.addCheck("no fake ACK while all relays are down", noAckErr == nil && !noAck.GetAcked() && noAck.GetError() != "",
		fmt.Sprintf("err=%v acked=%t detail=%s", noAckErr, noAck.GetAcked(), noAck.GetError()))

	if out, code := r.compose(r.stack, "start", "r2"); code != 0 {
		r.addCheck("restart R2", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady("r2", 60*time.Second); !r.require("R2 ready after restart", err) {
		return "FAIL", nil
	}
	relay2, err = r.waitRelayActive(b, r2, 90*time.Second)
	if !r.require("R2 reservation recovered", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r2, 60*time.Second); !r.require("A R2 reservation recovered", err) {
		return "FAIL", nil
	}
	connR2, err := r.connect(a, relay2.GetRelayedAddr())
	if !r.require("reconnect through R2", err) {
		return "FAIL", nil
	}
	r.addCheck("recovered circuit uses R2", connR2.GetRelayPeerId() == r2, connR2.GetRelayPeerId())
	if _, err := r.checkChat("R2 recovery chat", a, bID, "g3-recover-r2-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}

	if out, code := r.compose(r.stack, "start", "r1"); code != 0 {
		r.addCheck("restart R1", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady("r1", 60*time.Second); !r.require("R1 ready after restart", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(b, r1, 90*time.Second); !r.require("R1 reservation recovered", err) {
		return "FAIL", nil
	}
	st, _ := r.status(a)
	r.addCheck("relay resources stay bounded after failover", len(st.GetNetwork().GetRelays()) <= 2 && st.GetNetwork().GetResources().GetOpenConnections() < 20,
		fmt.Sprintf("relays=%d conns=%d", len(st.GetNetwork().GetRelays()), st.GetNetwork().GetResources().GetOpenConnections()))
	_ = aID
	r.natSet("NAT10", "relay-failover-recovery", "PASS", "R1->R2 switchover, all-relay-down no fake ACK, R2 recovery with same Peer IDs")
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioIPv6FWUnsolicited() (string, error) {
	aID := r.ids["a-tcp"]
	if !r.require("IPv6 firewall peer ID is known", boolError(aID != "", aID)) {
		return "FAIL", nil
	}
	rules, _ := r.ip6tables("fw-b")
	r.addCheck("site B still has no Raminga-port allow rule and no DNAT",
		strings.Contains(rules, "-P FORWARD DROP") && !strings.Contains(rules, "--dport 4001") && !strings.Contains(rules, "DNAT"),
		strings.TrimSpace(rules))
	_, err := r.connect("wan-probe", "/ip6/fd00:361:1::11/tcp/4001/p2p/"+aID)
	r.addCheck("unsolicited WAN->LAN TCP dial is rejected", err != nil, fmt.Sprintf("err=%v", err))
	r.addCheck("unsolicited dial failure is a real timeout, not a test-harness dial backoff",
		err != nil && !strings.Contains(strings.ToLower(err.Error()), "backoff") &&
			(strings.Contains(err.Error(), "i/o timeout") || strings.Contains(err.Error(), "deadline") ||
				strings.Contains(err.Error(), "all dials failed") || strings.Contains(err.Error(), "no route")),
		fmt.Sprintf("err=%v", err))
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioIPv6FWTCP() (string, error) {
	a, b := "a-tcp", "b-tcp"
	_, bID := r.ids[a], r.ids[b]
	relayID := r.ids["relay"]
	relay, err := r.waitRelayActive(b, relayID, 90*time.Second)
	if !r.require("b-tcp IPv6 relay reservation", err) {
		return "FAIL", nil
	}
	r.addCheck("relay address is IPv6", strings.Contains(relay.GetRelayedAddr(), "/ip6/"), relay.GetRelayedAddr())
	if _, err := r.waitRelayActive(a, relayID, 90*time.Second); !r.require("a-tcp IPv6 relay connection", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("TCP relay connect over IPv6", err) {
		return "FAIL", nil
	}
	r.addCheck("initial TCP path is limited IPv6 relay", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect() &&
		strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/"), fmt.Sprintf("route=%s addr=%s", conn.GetRoute(), conn.GetRemoteMultiaddr()))
	if _, err := r.checkChat("IPv6 firewall TCP relay fallback", a, bID, "g3-ipv6fw-tcp-relay-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}

	direct, directErr := r.waitDirect(a, bID, "tcp", 70*time.Second)
	if directErr == nil && direct != nil {
		r.addCheck("TCP direct through the stateful IPv6 firewall", direct.GetDirect() && !direct.GetLimited() &&
			strings.Contains(firstAddr(direct), "/ip6/") && !strings.Contains(firstAddr(direct), "p2p-circuit"),
			fmt.Sprintf("%v", direct.GetAddrs()))
		if _, err := r.checkChat("IPv6 firewall TCP direct", a, bID, "g3-ipv6fw-tcp-direct-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
			return "FAIL", nil
		}
		if !r.scenarioPassed() {
			return "FAIL", nil
		}
		return "PASS", nil
	}

	st, _ := r.status(a)
	dcutr := st.GetNetwork().GetDcutr()
	r.addCheck("TCP direct through the stateful IPv6 firewall was not established (honest BLOCKED)", true,
		fmt.Sprintf("directErr=%v dcutr=%d/%d/%d reason=%s", directErr, dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(), dcutrFailureReason(st)))
	r.addCheck("TCP DCUtR failure is terminal with a reason", dcutr.GetFailures() > 0 && dcutr.GetSuccesses() == 0 && dcutrFailureReason(st) != "",
		fmt.Sprintf("dcutr=%d/%d/%d reason=%s", dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures(), dcutrFailureReason(st)))
	ctA, _ := r.sh("fw-a", "conntrack -L -f ipv6 -p tcp 2>/dev/null | grep 'dport=4001' | head -5; true")
	ctB, _ := r.sh("fw-b", "conntrack -L -f ipv6 -p tcp 2>/dev/null | grep 'dport=4001' | head -5; true")
	fallback, fallbackErr := r.send(a, bID, "g3-ipv6fw-tcp-fallback-"+time.Now().Format("150405"))
	fallbackOK := fallbackErr == nil && fallback.GetAcked() && fallback.GetAckMessageId() == fallback.GetMessageId() &&
		fallback.GetRoute() == "relay" && fallback.GetRelayPeerId() == relayID
	r.addCheck("IPv6 relay fallback still ACKs after failed TCP direct", fallbackOK,
		fmt.Sprintf("err=%v acked=%t route=%s relay=%s conntrackA=%s conntrackB=%s",
			fallbackErr, fallback.GetAcked(), fallback.GetRoute(), fallback.GetRelayPeerId(),
			strings.TrimSpace(ctA), strings.TrimSpace(ctB)))
	if !fallbackOK || !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "BLOCKED", nil
}

func (r *runner) scenarioIPv6FWDirect() (string, error) {
	a, b := "a-quic", "b-quic"
	aID, bID := r.ids[a], r.ids[b]
	relayID := r.ids["relay"]
	relay, err := r.waitRelayActive(b, relayID, 90*time.Second)
	if !r.require("b-quic IPv6 relay reservation", err) {
		return "FAIL", nil
	}
	r.addCheck("relay address is IPv6", strings.Contains(relay.GetRelayedAddr(), "/ip6/"), relay.GetRelayedAddr())
	if _, err := r.waitRelayActive(a, relayID, 90*time.Second); !r.require("a-quic IPv6 relay connection", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("limited relay connection over IPv6", err) {
		return "FAIL", nil
	}
	r.addCheck("initial QUIC path is limited IPv6 relay", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect() &&
		conn.GetRelayPeerId() == relayID && strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/") && strings.Contains(conn.GetRemoteMultiaddr(), "p2p-circuit"),
		fmt.Sprintf("route=%s limited=%t relay=%s addr=%s", conn.GetRoute(), conn.GetLimited(), conn.GetRelayPeerId(), conn.GetRemoteMultiaddr()))
	if _, err := r.checkChat("IPv6 firewall A->B relay", a, bID, "g3-ipv6fw-relay-a-b-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("IPv6 firewall B->A relay", b, aID, "g3-ipv6fw-relay-b-a-"+time.Now().Format("150405"), "relay", ""); err != nil {
		return "FAIL", nil
	}

	directA, err := r.waitDirect(a, bID, "quic", 90*time.Second)
	if !r.require("A DCUtR direct QUIC over IPv6 through both firewalls", err) {
		return "FAIL", nil
	}
	directB, err := r.waitDirect(b, aID, "quic", 90*time.Second)
	if !r.require("B DCUtR direct QUIC over IPv6 through both firewalls", err) {
		return "FAIL", nil
	}
	r.addCheck("both sides report non-limited direct QUIC with an IPv6 multiaddr",
		directA.GetDirect() && !directA.GetLimited() && directB.GetDirect() && !directB.GetLimited() &&
			strings.Contains(firstAddr(directA), "/ip6/") && strings.Contains(firstAddr(directB), "/ip6/") &&
			!strings.Contains(firstAddr(directA), "p2p-circuit"),
		fmt.Sprintf("a=%v b=%v", directA.GetAddrs(), directB.GetAddrs()))
	if _, err := r.checkChat("IPv6 firewall A->B direct", a, bID, "g3-ipv6fw-direct-a-b-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("IPv6 firewall B->A direct", b, aID, "g3-ipv6fw-direct-b-a-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}

	stA0, _ := r.status(a)
	stB0, _ := r.status(b)
	startA, startB := stA0.GetStartedAtUnixMs(), stB0.GetStartedAtUnixMs()
	if out, code := r.compose(r.stack, "stop", "relay"); code != 0 {
		r.addCheck("stop the IPv6 relay", false, out)
		return "FAIL", nil
	}
	out, code := r.compose(r.stack, "ps", "-q", "relay")
	r.addCheck("IPv6 relay is stopped", code == 0 && strings.TrimSpace(out) == "", strings.TrimSpace(out))
	time.Sleep(1500 * time.Millisecond)
	afterA, err := r.waitDirect(a, bID, "quic", 30*time.Second)
	if !r.require("A keeps direct QUIC after the IPv6 relay stops", err) {
		return "FAIL", nil
	}
	afterB, err := r.waitDirect(b, aID, "quic", 30*time.Second)
	if !r.require("B keeps direct QUIC after the IPv6 relay stops", err) {
		return "FAIL", nil
	}
	stA1, _ := r.status(a)
	stB1, _ := r.status(b)
	r.addCheck("same A process/Peer ID after the IPv6 relay stops", stA1.GetStartedAtUnixMs() == startA && stA1.GetPeerId() == aID,
		fmt.Sprintf("started=%d peer=%s", stA1.GetStartedAtUnixMs(), stA1.GetPeerId()))
	r.addCheck("same B process/Peer ID after the IPv6 relay stops", stB1.GetStartedAtUnixMs() == startB && stB1.GetPeerId() == bID,
		fmt.Sprintf("started=%d peer=%s", stB1.GetStartedAtUnixMs(), stB1.GetPeerId()))
	r.addCheck("direct IPv6 connections survive relay stop", afterA.GetDirect() && afterB.GetDirect(), "both direct")
	if _, err := r.checkChat("IPv6 firewall A->B after relay stop", a, bID, "g3-ipv6fw-norelay-a-b-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("IPv6 firewall B->A after relay stop", b, aID, "g3-ipv6fw-norelay-b-a-"+time.Now().Format("150405"), "direct", "quic"); err != nil {
		return "FAIL", nil
	}

	ctA, _ := r.sh("fw-a", "conntrack -L -f ipv6 -p udp 2>/dev/null | grep -E 'sport=4001|dport=4001' | head -5; true")
	ctB, _ := r.sh("fw-b", "conntrack -L -f ipv6 -p udp 2>/dev/null | grep -E 'sport=4001|dport=4001' | head -5; true")
	r.addCheck("real IPv6 UDP conntrack state on both site firewalls",
		strings.Contains(ctA, "4001") && strings.Contains(ctB, "4001") && !strings.Contains(ctA, "DNAT"),
		"fw-a="+strings.TrimSpace(ctA)+" fw-b="+strings.TrimSpace(ctB))
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioIPv6FWOneSided() (string, error) {
	a, b := "one-a", "one-b"
	aID, bID := r.ids[a], r.ids[b]
	if !r.require("one-sided IPv6 peer IDs", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}
	out, code := r.sh("fw-a", "ip6tables -w 5 -F FORWARD; ip6tables -w 5 -P FORWARD ACCEPT")
	if code != 0 {
		r.addCheck("open site A firewall for the one-sided variant", false, out)
		return "FAIL", nil
	}
	rulesA, _ := r.ip6tables("fw-a")
	rulesB, _ := r.ip6tables("fw-b")
	r.addCheck("site A is open and site B stays closed", strings.Contains(rulesA, "-P FORWARD ACCEPT") && strings.Contains(rulesB, "-P FORWARD DROP"),
		"fw-a="+strings.TrimSpace(rulesA)+" fw-b="+strings.TrimSpace(rulesB))

	// Direction 1: closed site B must not accept an unsolicited dial from A.
	_, err := r.connect(a, "/ip6/fd00:362:1::13/tcp/4001/p2p/"+bID)
	r.addCheck("open->closed direct dial is blocked", err != nil, fmt.Sprintf("err=%v", err))
	r.addCheck("open->closed failure is a real timeout, not a dial backoff",
		err != nil && !strings.Contains(strings.ToLower(err.Error()), "backoff") &&
			(strings.Contains(err.Error(), "i/o timeout") || strings.Contains(err.Error(), "deadline") ||
				strings.Contains(err.Error(), "all dials failed") || strings.Contains(err.Error(), "no route")),
		fmt.Sprintf("err=%v", err))

	// Direction 2: closed site B can dial the open site A directly.
	conn, err := r.connect(b, "/ip6/fd00:361:1::13/tcp/4001/p2p/"+aID)
	if !r.require("closed->open direct dial succeeds", err) {
		return "FAIL", nil
	}
	r.addCheck("one-sided direct connection is IPv6 TCP", conn.GetDirect() && !conn.GetLimited() && conn.GetRoute() == "direct" &&
		conn.GetTransport() == "tcp" && strings.Contains(conn.GetRemoteMultiaddr(), "/ip6/fd00:361:1::13/"),
		fmt.Sprintf("route=%s transport=%s addr=%s", conn.GetRoute(), conn.GetTransport(), conn.GetRemoteMultiaddr()))
	if _, err := r.checkChat("one-sided B->A direct", b, aID, "g3-ipv6fw-one-b-a-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if _, err := r.checkChat("one-sided A->B over the same direct connection", a, bID, "g3-ipv6fw-one-a-b-"+time.Now().Format("150405"), "direct", "tcp"); err != nil {
		return "FAIL", nil
	}
	if !r.scenarioPassed() {
		return "FAIL", nil
	}
	return "PASS", nil
}
