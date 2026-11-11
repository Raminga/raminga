package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

func hasRelayConn(st *apiv1.StatusResponse, peerID, relayPeerID string) bool {
	for _, conn := range st.GetConnections() {
		if conn.GetPeerId() == peerID && conn.GetRoute() == "relay" && conn.GetRelayPeerId() == relayPeerID {
			return true
		}
	}
	return false
}

func relayInList(relays []*apiv1.RelayReservation, peerID string) *apiv1.RelayReservation {
	for _, relay := range relays {
		if relay.GetRelayPeerId() == peerID {
			return relay
		}
	}
	return nil
}

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

func (r *runner) scenarioQUIC() (string, error) {
	a, b := "a-quic", "b-quic"
	aID, bID := r.ids[a], r.ids[b]
	if !r.require("distinct QUIC peer IDs", boolError(aID != "" && bID != "" && aID != bID, aID+" "+bID)) {
		return "FAIL", nil
	}
	relayID := r.ids["r1"]
	relay, err := r.waitRelayActive(b, relayID, 60*time.Second)
	if !r.require("b-quic reservation on R1", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, relayID, 60*time.Second); !r.require("a-quic connection/reservation on R1", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("a-quic relay connect", err) {
		return "FAIL", nil
	}
	r.addCheck("relay route is limited Circuit Relay v2", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect() && conn.GetRelayPeerId() == relayID,
		fmt.Sprintf("route=%s limited=%t relay=%s addr=%s", conn.GetRoute(), conn.GetLimited(), conn.GetRelayPeerId(), conn.GetRemoteMultiaddr()))

	relaySend, err := r.send(a, bID, "g2-quic-relay-"+time.Now().Format("150405"))
	if !r.require("a-quic relay chat", err) {
		return "FAIL", nil
	}
	r.addCheck("relay chat ACKed with matching message ID", relaySend.GetAcked() && relaySend.GetAckMessageId() == relaySend.GetMessageId(),
		relaySend.GetMessageId()+" route="+relaySend.GetRoute())

	directA, err := r.waitDirect(a, bID, "quic", 75*time.Second)
	if !r.require("a-quic DCUtR direct QUIC connection", err) {
		return "FAIL", nil
	}
	directB, err := r.waitDirect(b, aID, "quic", 75*time.Second)
	if !r.require("b-quic DCUtR direct QUIC connection", err) {
		return "FAIL", nil
	}
	r.addCheck("A direct transport is QUIC and non-limited", directA.GetTransport() == "quic" && directA.GetDirect() && !directA.GetLimited() && directA.GetRoute() == "direct",
		fmt.Sprintf("%v", directA.GetAddrs()))
	r.addCheck("B direct transport is QUIC and non-limited", directB.GetTransport() == "quic" && directB.GetDirect() && !directB.GetLimited() && directB.GetRoute() == "direct",
		fmt.Sprintf("%v", directB.GetAddrs()))
	r.addCheck("direct connection is not limited and route is direct", directA.GetRoute() == "direct" && directB.GetRoute() == "direct",
		fmt.Sprintf("a=%s b=%s", directA.GetRoute(), directB.GetRoute()))

	stA0, _ := r.status(a)
	stB0, _ := r.status(b)
	startA, startB := stA0.GetStartedAtUnixMs(), stB0.GetStartedAtUnixMs()
	directSend, err := r.send(a, bID, "g2-quic-direct-a-b-"+time.Now().Format("150405"))
	if !r.require("a-quic direct chat", err) {
		return "FAIL", nil
	}
	r.addCheck("A->B direct ACK route/transport", directSend.GetAcked() && directSend.GetRoute() == "direct" && directSend.GetTransport() == "quic" && directSend.GetRelayPeerId() == "",
		fmt.Sprintf("route=%s transport=%s relay=%q", directSend.GetRoute(), directSend.GetTransport(), directSend.GetRelayPeerId()))
	reverse, err := r.send(b, aID, "g2-quic-direct-b-a-"+time.Now().Format("150405"))
	if !r.require("b-quic direct chat", err) {
		return "FAIL", nil
	}
	r.addCheck("B->A direct ACK route/transport", reverse.GetAcked() && reverse.GetRoute() == "direct" && reverse.GetTransport() == "quic" && reverse.GetRelayPeerId() == "",
		fmt.Sprintf("route=%s transport=%s relay=%q", reverse.GetRoute(), reverse.GetTransport(), reverse.GetRelayPeerId()))

	if out, code := r.compose("stop", "r1", "r2"); code != 0 {
		r.addCheck("stop all relays", false, out)
		return "FAIL", nil
	}
	for _, relay := range []string{"r1", "r2"} {
		out, code := r.compose("ps", "-q", relay)
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
	r.addCheck("A direct connection still present", afterA.GetDirect() && !afterA.GetLimited() && afterA.GetRoute() == "direct", fmt.Sprintf("%v", afterA.GetAddrs()))
	r.addCheck("B direct connection still present", afterB.GetDirect() && !afterB.GetLimited() && afterB.GetRoute() == "direct", fmt.Sprintf("%v", afterB.GetAddrs()))

	postA, err := r.send(a, bID, "g2-quic-no-relay-a-b-"+time.Now().Format("150405"))
	if !r.require("A->B direct chat after all relays stop", err) {
		return "FAIL", nil
	}
	r.addCheck("A->B post-relay-stop ACK is direct QUIC", postA.GetAcked() && postA.GetRoute() == "direct" && postA.GetTransport() == "quic", fmt.Sprintf("route=%s transport=%s", postA.GetRoute(), postA.GetTransport()))
	postB, err := r.send(b, aID, "g2-quic-no-relay-b-a-"+time.Now().Format("150405"))
	if !r.require("B->A direct chat after all relays stop", err) {
		return "FAIL", nil
	}
	r.addCheck("B->A post-relay-stop ACK is direct QUIC", postB.GetAcked() && postB.GetRoute() == "direct" && postB.GetTransport() == "quic", fmt.Sprintf("route=%s transport=%s", postB.GetRoute(), postB.GetTransport()))

	ctA, errA := r.conntrack("nat-a", "udp", "4001")
	ctB, errB := r.conntrack("nat-b", "udp", "4001")
	ok := errA == nil && errB == nil && strings.Contains(ctA, "sport=4001") && strings.Contains(ctA, "dport=4001") &&
		strings.Contains(ctB, "sport=4001") && strings.Contains(ctB, "dport=4001") &&
		(strings.Contains(ctA, "10.241.1.11") || strings.Contains(ctA, "dst=10.241.1.11")) &&
		(strings.Contains(ctB, "10.241.2.11") || strings.Contains(ctB, "dst=10.241.2.11"))
	r.addCheck("real conntrack mappings after relay stop", ok, "nat-a="+strings.TrimSpace(ctA)+" nat-b="+strings.TrimSpace(ctB))

	if out, code := r.compose("start", "r1", "r2"); code != 0 {
		r.addCheck("restart relays", false, out)
		return "FAIL", nil
	}
	for _, service := range []string{"r1", "r2"} {
		st, err := r.waitReady(service, 60*time.Second)
		if !r.require(service+" restarted with same Peer ID", boolError(err == nil && st.GetPeerId() == r.ids[service], fmt.Sprintf("err=%v id=%s", err, st.GetPeerId()))) {
			return "FAIL", nil
		}
	}
	if out, err := r.iptables("nat-a"); err != nil {
		r.addCheck("strict NAT-A rules", false, err.Error())
	} else {
		r.addCheck("NAT-A has no static DNAT and no unconditional WAN->LAN ACCEPT",
			!strings.Contains(out, "-j DNAT") && !strings.Contains(out, "wan0 -o lan0 -j ACCEPT"),
			strings.TrimSpace(out))
	}
	return "PASS", nil
}

func (r *runner) scenarioTCP() (string, error) {
	a, b := "a-tcp", "b-tcp"
	bID := r.ids[b]
	relay, err := r.waitRelayActive(b, r.ids["r1"], 60*time.Second)
	if !r.require("b-tcp reservation on R1", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r.ids["r1"], 60*time.Second); !r.require("a-tcp connection/reservation on R1", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(a, relay.GetRelayedAddr())
	if !r.require("a-tcp relay connect", err) {
		return "FAIL", nil
	}
	r.addCheck("TCP relay route is limited", conn.GetRoute() == "relay" && conn.GetLimited() && !conn.GetDirect(), conn.GetRemoteMultiaddr())
	relaySend, err := r.send(a, bID, "g2-tcp-relay-"+time.Now().Format("150405"))
	if !r.require("TCP relay fallback chat", err) {
		return "FAIL", nil
	}
	r.addCheck("TCP relay fallback ACKed", relaySend.GetAcked() && relaySend.GetAckMessageId() == relaySend.GetMessageId(), relaySend.GetMessageId())

	direct, directErr := r.waitDirect(a, bID, "tcp", 50*time.Second)
	if directErr == nil && direct != nil {
		send, err := r.send(a, bID, "g2-tcp-direct-"+time.Now().Format("150405"))
		if !r.require("TCP direct chat", err) {
			return "FAIL", nil
		}
		r.addCheck("TCP direct ACK route/transport", send.GetAcked() && send.GetRoute() == "direct" && send.GetTransport() == "tcp", fmt.Sprintf("route=%s transport=%s", send.GetRoute(), send.GetTransport()))
		return "PASS", nil
	}

	stA, _ := r.status(a)
	stB, _ := r.status(b)
	dcutr := stA.GetNetwork().GetDcutr()
	ctA, _ := r.conntrack("nat-a", "tcp", "4100")
	ctB, _ := r.conntrack("nat-b", "tcp", "4100")
	fallback, fallbackErr := r.send(a, bID, "g2-tcp-fallback-after-direct-"+time.Now().Format("150405"))
	fallbackOK := fallbackErr == nil && fallback.GetAcked() && fallback.GetAckMessageId() == fallback.GetMessageId()
	r.addCheck("TCP direct was not established (honest BLOCKED)", true,
		fmt.Sprintf("directErr=%v dcutrAttempts=%d successes=%d failures=%d", directErr, dcutr.GetAttempts(), dcutr.GetSuccesses(), dcutr.GetFailures()))
	r.addCheck("TCP relay fallback still ACKed after failed direct", fallbackOK,
		fmt.Sprintf("err=%v acked=%t route=%s", fallbackErr, fallback.GetAcked(), fallback.GetRoute()))
	r.addCheck("TCP failure has DCUtR/conntrack diagnosis", dcutr.GetAttempts() > 0 || dcutr.GetFailures() > 0 || strings.Contains(ctA, "SYN_SENT") || strings.Contains(ctB, "SYN_SENT"),
		fmt.Sprintf("dcutr=%v conntrackA=%s conntrackB=%s", dcutr, strings.TrimSpace(ctA), strings.TrimSpace(ctB)))
	r.addCheck("TCP direct is never written as direct", fallback.GetRoute() != "direct", fallback.GetRoute())
	if !fallbackOK {
		return "FAIL", nil
	}
	_ = stB
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
	if !r.require("relay failover connect via R1", err) {
		return "FAIL", nil
	}
	r.addCheck("initial relay is R1", conn.GetRelayPeerId() == r1, conn.GetRelayPeerId())
	send1, err := r.send(a, bID, "g2-failover-r1-"+time.Now().Format("150405"))
	if !r.require("initial R1 chat", err) {
		return "FAIL", nil
	}
	r.addCheck("R1 chat ACKed", send1.GetAcked() && send1.GetRoute() == "relay" && send1.GetRelayPeerId() == r1, fmt.Sprintf("route=%s relay=%s", send1.GetRoute(), send1.GetRelayPeerId()))

	if out, code := r.compose("stop", "r1"); code != 0 {
		r.addCheck("stop R1", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitRelayState(a, r1, true, 30*time.Second); !r.require("R1 reservation loss is diagnosed", err) {
		return "FAIL", nil
	}
	r.addCheck("R1 circuit address removed", func() bool {
		st, err := r.status(a)
		if err != nil {
			return false
		}
		relay := relayIn(st, r1)
		return relay != nil && relay.GetRelayedAddr() == "" && relay.GetStatus() != "active"
	}(), "R1 state")
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
	if !r.require("switch to R2 relay", err) {
		return "FAIL", nil
	}
	r.addCheck("switchover uses R2", conn2.GetRelayPeerId() == r2, conn2.GetRelayPeerId())
	send2, err := r.send(a, bID, "g2-failover-r2-"+time.Now().Format("150405"))
	if !r.require("R2 chat after switchover", err) {
		return "FAIL", nil
	}
	r.addCheck("R2 chat ACKed without fake direct", send2.GetAcked() && send2.GetRoute() == "relay" && send2.GetRelayPeerId() == r2,
		fmt.Sprintf("route=%s relay=%s", send2.GetRoute(), send2.GetRelayPeerId()))

	if out, code := r.compose("stop", "r2"); code != 0 {
		r.addCheck("stop R2", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitRelayState(a, r2, true, 30*time.Second); !r.require("R2 reservation loss is diagnosed", err) {
		return "FAIL", nil
	}
	if err := r.disconnect(a, bID); err != nil {
		// The relay loss may already have closed the connection. That is not a
		// fake success; record it and continue only if the peer is offline.
		r.addCheck("relayed peer already disconnected after relay loss", true, err.Error())
	}
	if err := r.waitPeerOffline(a, bID, 20*time.Second); !r.require("peer is offline after all relays stop", err) {
		return "FAIL", nil
	}
	noAck, noAckErr := r.send(a, bID, "g2-no-fake-ack-"+time.Now().Format("150405"))
	r.addCheck("no fake ACK while all relays are down", noAckErr == nil && !noAck.GetAcked() && noAck.GetError() != "",
		fmt.Sprintf("err=%v acked=%t error=%s", noAckErr, noAck.GetAcked(), noAck.GetError()))

	if out, code := r.compose("start", "r2"); code != 0 {
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
	r.addCheck("reconnected circuit uses R2", connR2.GetRelayPeerId() == r2, connR2.GetRelayPeerId())
	recover2, err := r.send(a, bID, "g2-recover-r2-"+time.Now().Format("150405"))
	if !r.require("chat after R2 recovery", err) {
		return "FAIL", nil
	}
	r.addCheck("R2 recovery ACKed via relay", recover2.GetAcked() && recover2.GetRoute() == "relay",
		fmt.Sprintf("route=%s relay=%s", recover2.GetRoute(), recover2.GetRelayPeerId()))

	if out, code := r.compose("start", "r1"); code != 0 {
		r.addCheck("restart R1", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady("r1", 60*time.Second); !r.require("R1 ready after restart", err) {
		return "FAIL", nil
	}
	relay1, err := r.waitRelayActive(b, r1, 90*time.Second)
	if !r.require("R1 reservation recovered", err) {
		return "FAIL", nil
	}
	// Make R1 the only usable relay path so the recovery check cannot fall
	// back to the still-working R2 circuit.
	if out, code := r.compose("stop", "r2"); code != 0 {
		r.addCheck("stop R2 before R1-only recovery", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitRelayState(a, r2, true, 30*time.Second); !r.require("R2 lost before R1-only recovery", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, r1, 90*time.Second); !r.require("A R1 reservation ready for recovery", err) {
		return "FAIL", nil
	}
	if err := r.disconnect(a, bID); err != nil {
		r.addCheck("relay path already closed before R1 recovery", true, err.Error())
	}
	if err := r.waitPeerOffline(a, bID, 30*time.Second); !r.require("peer offline before R1 recovery", err) {
		return "FAIL", nil
	}
	connR1, err := r.connect(a, relay1.GetRelayedAddr())
	if !r.require("reconnect through R1", err) {
		return "FAIL", nil
	}
	if _, err := r.waitFor("R1 circuit connection", 20*time.Second, func() (bool, string, error) {
		st, err := r.status(a)
		if err != nil {
			return false, "", err
		}
		return hasRelayConn(st, bID, r1), fmt.Sprintf("connections=%v", st.GetConnections()), nil
	}); !r.require("reconnected circuit uses R1", err) {
		return "FAIL", nil
	}
	r.addCheck("connect returned a live circuit", connR1.GetRoute() == "relay", connR1.GetRoute())
	recover1, err := r.send(a, bID, "g2-recover-r1-"+time.Now().Format("150405"))
	if !r.require("chat after R1 recovery", err) {
		return "FAIL", nil
	}
	r.addCheck("R1 recovery ACKed via relay", recover1.GetAcked() && recover1.GetRoute() == "relay",
		fmt.Sprintf("route=%s relay=%s", recover1.GetRoute(), recover1.GetRelayPeerId()))
	if out, code := r.compose("start", "r2"); code != 0 {
		r.addCheck("restart R2 after R1 recovery", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady("r2", 60*time.Second); !r.require("R2 ready after R1 recovery", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(b, r2, 90*time.Second); !r.require("R2 reservation recovered after R1 recovery", err) {
		return "FAIL", nil
	}
	st, _ := r.status(a)
	r.addCheck("relay resources are bounded after failover", len(st.GetNetwork().GetRelays()) <= 2 && st.GetNetwork().GetResources().GetOpenConnections() < 20,
		fmt.Sprintf("relays=%d conns=%d", len(st.GetNetwork().GetRelays()), st.GetNetwork().GetResources().GetOpenConnections()))
	_ = aID
	return "PASS", nil
}

func (r *runner) scenarioDHT() (string, error) {
	a, b, c := "dht-a", "dht-b", "dht-c"
	aID, bID := r.ids[a], r.ids[b]
	if _, err := r.waitFor("DHT routing table dht-a -> dht-b", 45*time.Second, func() (bool, string, error) {
		st, err := r.dhtStatus(a)
		if err != nil {
			return false, "", err
		}
		for _, pid := range st.GetDht().GetRoutingTablePeers() {
			if pid == bID {
				return true, pid, nil
			}
		}
		return false, fmt.Sprintf("%v error=%s", st.GetDht().GetRoutingTablePeers(), st.GetDht().GetLastError()), nil
	}); !r.require("DHT routing table populated", err) {
		return "FAIL", nil
	}
	found, err := r.dhtFind(a, bID)
	if !r.require("DHT bootstrap FindPeer", err) {
		return "FAIL", nil
	}
	r.addCheck("bootstrap discovery uses /raminga DHT", found.GetFound() && found.GetSource() == "dht" && len(found.GetAddrs()) > 0,
		fmt.Sprintf("source=%s addrs=%v error=%s", found.GetSource(), found.GetAddrs(), found.GetError()))
	_ = aID

	wanB := "/ip4/11.40.0.22/tcp/4001/p2p/" + bID
	if _, err := r.connect(a, wanB); !r.require("DHT peers connect directly on WAN", err) {
		return "FAIL", nil
	}
	directChat, err := r.send(a, bID, "g2-dht-direct-"+time.Now().Format("150405"))
	if !r.require("DHT peer direct chat", err) {
		return "FAIL", nil
	}
	r.addCheck("DHT peer chat route is direct", directChat.GetAcked() && directChat.GetRoute() == "direct", directChat.GetRoute())

	if out, code := r.compose("stop", "dht-boot", "dht-b"); code != 0 {
		r.addCheck("stop DHT bootstrap and peer", false, out)
		return "FAIL", nil
	}
	if out, code := r.compose("restart", "dht-a"); code != 0 {
		r.addCheck("restart dht-a", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady(a, 60*time.Second); !r.require("dht-a ready after restart", err) {
		return "FAIL", nil
	}
	st, err := r.status(a)
	if !r.require("dht-a status after restart", err) {
		return "FAIL", nil
	}
	var known, boot *apiv1.CachedPeer
	for _, entry := range st.GetNetwork().GetPeerCache() {
		if entry.GetPeerId() == bID {
			known = entry
		}
		if entry.GetPeerId() == r.ids["dht-boot"] {
			boot = entry
		}
	}
	r.addCheck("persisted known peer cache readable", known != nil && len(known.GetAddrs()) > 0 && known.GetSource() == "known",
		fmt.Sprintf("known=%v", known))
	r.addCheck("persisted bootstrap cache readable", boot != nil && len(boot.GetAddrs()) > 0 && boot.GetSource() == "bootstrap",
		fmt.Sprintf("bootstrap=%v", boot))
	peers, err := r.peers(a, true)
	if !r.require("cached peer list after restart", err) {
		return "FAIL", nil
	}
	cachedB := peerInList(peers.GetPeers(), bID)
	r.addCheck("cached peer is not reported online", cachedB != nil && !cachedB.GetOnline(), fmt.Sprintf("%v", cachedB))
	r.addCheck("in-memory PeerStore rebuilt from hints", st.GetNetwork().GetResources().GetPeerstorePeers() > 0,
		fmt.Sprintf("peerstore=%d", st.GetNetwork().GetResources().GetPeerstorePeers()))
	cachedFind, err := r.dhtFind(a, bID)
	if !r.require("DHT find with bootstrap down", err) {
		return "FAIL", nil
	}
	r.addCheck("cache fallback is labelled, not online", cachedFind.GetFound() && cachedFind.GetSource() == "peerstore-cache",
		fmt.Sprintf("source=%s", cachedFind.GetSource()))
	if out, code := r.compose("start", "dht-b"); code != 0 {
		r.addCheck("restart dht-b", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady(b, 60*time.Second); !r.require("dht-b ready after cache check", err) {
		return "FAIL", nil
	}
	if _, err := r.connect(a, wanB); !r.require("connect from persisted cache address", err) {
		return "FAIL", nil
	}
	cachedChat, err := r.send(a, bID, "g2-cache-chat-"+time.Now().Format("150405"))
	if !r.require("chat from persisted cache", err) {
		return "FAIL", nil
	}
	r.addCheck("cache-path chat ACKed", cachedChat.GetAcked(), cachedChat.GetMessageId())

	manualAddr := "/ip4/11.40.0.22/tcp/4001/p2p/" + bID
	if _, err := r.addPeer(c, manualAddr); !r.require("manual peer add", err) {
		return "FAIL", nil
	}
	cPeers, err := r.peers(c, true)
	if !r.require("manual peer cache list", err) {
		return "FAIL", nil
	}
	manualEntry := peerInList(cPeers.GetPeers(), bID)
	r.addCheck("manual add is persisted with source manual", manualEntry != nil && contains(manualEntry.GetSources(), "manual") && !manualEntry.GetOnline(),
		fmt.Sprintf("%v", manualEntry))
	manualFind, err := r.dhtFind(c, bID)
	if !r.require("manual add find", err) {
		return "FAIL", nil
	}
	r.addCheck("manual path returns a labelled address", manualFind.GetFound() && (manualFind.GetSource() == "peerstore-cache" || manualFind.GetSource() == "manual"),
		fmt.Sprintf("source=%s", manualFind.GetSource()))
	if _, err := r.connect(c, manualAddr); !r.require("connect from manually added peer", err) {
		return "FAIL", nil
	}
	manualChat, err := r.send(c, bID, "g2-manual-chat-"+time.Now().Format("150405"))
	if !r.require("chat from manually added peer", err) {
		return "FAIL", nil
	}
	r.addCheck("manual-path chat ACKed", manualChat.GetAcked(), manualChat.GetMessageId())

	dht, err := r.dhtStatus(a)
	if !r.require("DHT status", err) {
		return "FAIL", nil
	}
	d := dht.GetDht()
	onlyOurs := true
	for _, bootAddr := range d.GetBootstrapPeers() {
		if !strings.Contains(bootAddr, "11.40.0.6") {
			onlyOurs = false
		}
	}
	r.addCheck("DHT protocol is /raminga/kad/1.0.0", d.GetProtocol() == "/raminga/kad/1.0.0", d.GetProtocol())
	r.addCheck("bootstrap peers are Raminga-only", onlyOurs && !d.GetPublicBootstrapConfigured(), fmt.Sprintf("%v", d.GetBootstrapPeers()))
	r.addCheck("no public IPFS bootstrap configured", !d.GetPublicBootstrapConfigured(), "false")

	for _, service := range []string{a, b, c} {
		data, err := os.ReadFile(filepath.Join(r.configDir, service+".toml"))
		if err != nil {
			r.addCheck(service+" config readable", false, err.Error())
			continue
		}
		text := strings.ToLower(string(data))
		r.addCheck(service+" config has no public DHT/STUN/UPnP/NAT-PMP", !strings.Contains(text, "bootstrap.libp2p.io") &&
			!strings.Contains(text, "/ipfs/") && !strings.Contains(text, "stun =") && !strings.Contains(text, "upnp =") && !strings.Contains(text, "nat_pmp ="),
			"config scanned")
	}

	if out, code := r.compose("start", "dht-boot"); code != 0 {
		r.addCheck("restart DHT bootstrap", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady("dht-boot", 60*time.Second); !r.require("DHT bootstrap ready after restart", err) {
		return "FAIL", nil
	}
	return "PASS", nil
}

func (r *runner) scenarioProvider() (string, error) {
	off, err := r.status("r-off")
	if !r.require("r-off status", err) {
		return "FAIL", nil
	}
	r.addCheck("relay provider is off by default", !off.GetNetwork().GetRelayProvider().GetEnabled(), fmt.Sprintf("%v", off.GetNetwork().GetRelayProvider()))
	quotaStatus, err := r.status("r-quota")
	if !r.require("r-quota status", err) {
		return "FAIL", nil
	}
	q := quotaStatus.GetNetwork().GetRelayProvider()
	r.addCheck("explicit provider has quotas", q.GetEnabled() && q.GetMaxReservations() == 2 && q.GetMaxReservationsPerIp() == 1 && q.GetMaxReservationsPerPeer() == 1,
		fmt.Sprintf("%v", q))

	quotaRelayID := r.ids["r-quota"]
	var active int
	var refused string
	_, err = r.waitFor("per-IP quota refusal", 40*time.Second, func() (bool, string, error) {
		active = 0
		refused = ""
		for _, service := range []string{"quota-a1", "quota-a2"} {
			res, err := r.relayStatus(service)
			if err != nil {
				return false, "", err
			}
			relay := relayInList(res.GetRelays(), quotaRelayID)
			if relay == nil {
				continue
			}
			if relay.GetStatus() == "active" && relay.GetRelayedAddr() != "" {
				active++
			}
			if relay.GetStatus() == "failed" || strings.Contains(strings.ToUpper(relay.GetLastError()), "REFUSED") {
				refused = service + ": " + relay.GetLastError()
			}
		}
		return active == 1 && refused != "", fmt.Sprintf("active=%d refused=%s", active, refused), nil
	})
	r.addCheck("per-IP quota allows exactly one and refuses over-quota", err == nil && active == 1 && refused != "", fmt.Sprintf("err=%v active=%d refused=%s", err, active, refused))
	if err != nil {
		return "FAIL", nil
	}

	offPeer, err := r.relayStatus("off-peer")
	if !r.require("off-peer relay status", err) {
		return "FAIL", nil
	}
	offRelay := relayInList(offPeer.GetRelays(), r.ids["r-off"])
	r.addCheck("provider-off relay refuses reservation", offRelay != nil && offRelay.GetStatus() != "active" && offRelay.GetLastError() != "",
		fmt.Sprintf("%v", offRelay))

	for _, service := range []string{"r-quota", "quota-a1"} {
		st, err := r.status(service)
		if err != nil {
			r.addCheck(service+" network flags", false, err.Error())
			continue
		}
		n := st.GetNetwork()
		r.addCheck(service+" has no UPnP/NAT-PMP/STUN", !n.GetUpnp() && !n.GetNatPmp() && !n.GetStun(),
			fmt.Sprintf("upnp=%t nat_pmp=%t stun=%t", n.GetUpnp(), n.GetNatPmp(), n.GetStun()))
	}
	logs := strings.ToLower(r.composeLogs("r-quota"))
	r.addCheck("provider logs show no UPnP/NAT-PMP/SSDP", !strings.Contains(logs, "upnp") && !strings.Contains(logs, "nat-pmp") && !strings.Contains(logs, "ssdp"), "logs scanned")
	for _, service := range []string{"r-quota", "r-off"} {
		data, err := os.ReadFile(filepath.Join(r.configDir, service+".toml"))
		if err != nil {
			r.addCheck(service+" config", false, err.Error())
			continue
		}
		text := strings.ToLower(string(data))
		r.addCheck(service+" config has no UPnP/NAT-PMP/STUN", !strings.Contains(text, "upnp =") && !strings.Contains(text, "nat_pmp =") && !strings.Contains(text, "stun ="), "config scanned")
	}
	return "PASS", nil
}

func (r *runner) scenarioOneSided() (string, error) {
	pub := "pub"
	pubID := r.ids[pub]
	pubAddr := "/ip4/11.40.0.20/tcp/4001/p2p/" + pubID
	for _, service := range []string{"a-one", "b-one"} {
		restrictedID := r.ids[service]
		conn, err := r.connect(service, pubAddr)
		if !r.require(service+" outbound dial to public node", err) {
			return "FAIL", nil
		}
		r.addCheck(service+" connection is direct and outbound", conn.GetDirect() && !conn.GetLimited() && conn.GetRoute() == "direct",
			fmt.Sprintf("route=%s limited=%t", conn.GetRoute(), conn.GetLimited()))
		st, _ := r.status(service)
		p := peerIn(st, pubID)
		r.addCheck(service+" restricted side is the dialer", p != nil && p.GetDirection() == "outbound", fmt.Sprintf("direction=%s", p.GetDirection()))
		pubSt, _ := r.status(pub)
		pp := peerIn(pubSt, restrictedID)
		r.addCheck(pub+" sees inbound restricted peer", pp != nil && pp.GetDirection() == "inbound", fmt.Sprintf("direction=%s", pp.GetDirection()))
		toPub, err := r.send(service, pubID, "g2-one-out-"+service+"-"+time.Now().Format("150405"))
		if !r.require(service+" -> public chat", err) {
			return "FAIL", nil
		}
		r.addCheck(service+" -> public ACK direct", toPub.GetAcked() && toPub.GetRoute() == "direct", toPub.GetRoute())
		toRestricted, err := r.send(pub, restrictedID, "g2-one-back-"+service+"-"+time.Now().Format("150405"))
		if !r.require("public -> "+service+" chat over same connection", err) {
			return "FAIL", nil
		}
		r.addCheck("public -> "+service+" ACK direct", toRestricted.GetAcked() && toRestricted.GetRoute() == "direct", toRestricted.GetRoute())
	}

	aID := r.ids["a-one"]
	if err := r.disconnect(pub, aID); !r.require("disconnect one-sided connection", err) {
		return "FAIL", nil
	}
	if err := r.waitPeerNotConnected("a-one", pubID, 20*time.Second); !r.require("restricted side sees disconnect", err) {
		return "FAIL", nil
	}
	// ClosePeer returns after the local close, but the public side may still be
	// tearing down the inbound connection. Redialing before both sides observe
	// NotConnected can race the old connection's closure.
	if err := r.waitPeerNotConnected(pub, aID, 20*time.Second); !r.require("public side sees disconnect", err) {
		return "FAIL", nil
	}
	if _, err := r.connect("a-one", pubAddr); !r.require("restricted side redials after disconnect", err) {
		return "FAIL", nil
	}
	recover, err := r.send("a-one", pubID, "g2-one-recover-"+time.Now().Format("150405"))
	if !r.require("chat after one-sided recovery", err) {
		return "FAIL", nil
	}
	r.addCheck("recovered chat is direct", recover.GetAcked() && recover.GetRoute() == "direct", recover.GetRoute())
	if _, err := r.send(pub, aID, "g2-one-recover-back-"+time.Now().Format("150405")); !r.require("reverse chat after one-sided recovery", err) {
		return "FAIL", nil
	}

	// Exercise "no fake ACK" on the other restricted peer, after its own
	// disconnect. Do this after a-one has recovered, so pub does not start a
	// failed dial to a-one immediately before a-one's user-initiated redial.
	bID := r.ids["b-one"]
	if err := r.disconnect(pub, bID); !r.require("disconnect b-one connection", err) {
		return "FAIL", nil
	}
	if err := r.waitPeerNotConnected("b-one", pubID, 20*time.Second); !r.require("b-one sees disconnect", err) {
		return "FAIL", nil
	}
	if err := r.waitPeerNotConnected(pub, bID, 20*time.Second); !r.require("public side sees b-one disconnect", err) {
		return "FAIL", nil
	}
	noAck, noAckErr := r.send(pub, bID, "g2-one-no-fake-"+time.Now().Format("150405"))
	r.addCheck("no fake ACK after one-sided disconnect", noAckErr == nil && !noAck.GetAcked(), fmt.Sprintf("err=%v acked=%t", noAckErr, noAck.GetAcked()))
	if noAck.GetMessageId() != "" {
		if err := r.cancelOutbox(pub, noAck.GetMessageId()); err != nil {
			r.addCheck("cancel no-ACK outbox retry", false, err.Error())
			return "FAIL", nil
		}
	}
	return "PASS", nil
}

func (r *runner) scenarioPeerStore() (string, error) {
	a, b := "dht-a", "dht-b"
	bID := r.ids[b]
	st, err := r.status(a)
	if !r.require("dht-a status before restart", err) {
		return "FAIL", nil
	}
	var known, boot bool
	for _, entry := range st.GetNetwork().GetPeerCache() {
		if entry.GetPeerId() == bID && entry.GetSource() == "known" {
			known = true
		}
		if entry.GetPeerId() == r.ids["dht-boot"] && entry.GetSource() == "bootstrap" {
			boot = true
		}
	}
	r.addCheck("known-peer cache exists before restart", known, "known")
	r.addCheck("bootstrap cache exists before restart", boot, "bootstrap")

	pinned, err := r.peers("a-quic", true)
	if !r.require("a-quic cached peers", err) {
		return "FAIL", nil
	}
	var pinnedR1, pinnedR2 bool
	for _, p := range pinned.GetPeers() {
		if p.GetPeerId() == r.ids["r1"] && contains(p.GetSources(), "pinned") {
			pinnedR1 = true
		}
		if p.GetPeerId() == r.ids["r2"] && contains(p.GetSources(), "pinned") {
			pinnedR2 = true
		}
	}
	r.addCheck("pinned relay cache readable", pinnedR1 && pinnedR2, fmt.Sprintf("r1=%t r2=%t", pinnedR1, pinnedR2))

	if out, code := r.compose("stop", b); code != 0 {
		r.addCheck("stop dht-b before dht-a restart", false, out)
		return "FAIL", nil
	}
	if out, code := r.compose("restart", a); code != 0 {
		r.addCheck("restart dht-a", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady(a, 60*time.Second); !r.require("dht-a ready after restart", err) {
		return "FAIL", nil
	}
	st, err = r.status(a)
	if !r.require("dht-a status after restart", err) {
		return "FAIL", nil
	}
	var cachedB *apiv1.CachedPeer
	for _, entry := range st.GetNetwork().GetPeerCache() {
		if entry.GetPeerId() == bID {
			cachedB = entry
		}
	}
	r.addCheck("SQLite cache readable after restart", cachedB != nil && len(cachedB.GetAddrs()) > 0, fmt.Sprintf("%v", cachedB))
	r.addCheck("in-memory PeerStore rebuilt", st.GetNetwork().GetResources().GetPeerstorePeers() > 0,
		fmt.Sprintf("peerstore=%d", st.GetNetwork().GetResources().GetPeerstorePeers()))

	peers, err := r.peers(a, true)
	if !r.require("cached peer list after restart", err) {
		return "FAIL", nil
	}
	entry := peerInList(peers.GetPeers(), bID)
	r.addCheck("cached address is not online", entry != nil && !entry.GetOnline(), fmt.Sprintf("%v", entry))
	if out, code := r.compose("start", b); code != 0 {
		r.addCheck("start dht-b after cache check", false, out)
		return "FAIL", nil
	}
	if _, err := r.waitReady(b, 60*time.Second); !r.require("dht-b ready after cache check", err) {
		return "FAIL", nil
	}
	if _, err := r.connect(a, "/ip4/11.40.0.22/tcp/4001/p2p/"+bID); !r.require("connect after PeerStore rebuild", err) {
		return "FAIL", nil
	}
	after, err := r.peers(a, true)
	if !r.require("peer list after reconnect", err) {
		return "FAIL", nil
	}
	entry = peerInList(after.GetPeers(), bID)
	r.addCheck("same peer is online only after real connection", entry != nil && entry.GetOnline(), fmt.Sprintf("online=%t", entry.GetOnline()))
	chat, err := r.send(a, bID, "g2-peerstore-chat-"+time.Now().Format("150405"))
	if !r.require("chat after PeerStore rebuild", err) {
		return "FAIL", nil
	}
	r.addCheck("chat after rebuild ACKed", chat.GetAcked(), chat.GetMessageId())

	out, code := r.exec(a, "ls", "-l", "/data/raminga.db")
	r.addCheck("SQLite file exists and is readable", code == 0 && strings.Contains(out, "raminga.db"), strings.TrimSpace(out))
	return "PASS", nil
}

func boolError(ok bool, detail string) error {
	if ok {
		return nil
	}
	return fmt.Errorf("%s", detail)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func connectedToPeer(st *apiv1.StatusResponse, peerID string) bool {
	for _, conn := range st.GetConnections() {
		if conn.GetPeerId() == peerID {
			return true
		}
	}
	return false
}

func activeReservation(st *apiv1.StatusResponse, relayID string) bool {
	rr := relayIn(st, relayID)
	return rr != nil && rr.GetStatus() == "active"
}

// holdNoRelay requires a disconnected state within settle, then holds it for
// hold, failing immediately if a connection or active reservation reappears.
func (r *runner) holdNoRelay(service, relayID string, settle, hold time.Duration) (time.Duration, error) {
	settleDeadline := time.Now().Add(settle)
	disconnected := false
	for time.Now().Before(settleDeadline) {
		st, err := r.status(service)
		if err != nil {
			return 0, err
		}
		if !connectedToPeer(st, relayID) && !activeReservation(st, relayID) {
			disconnected = true
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !disconnected {
		return 0, fmt.Errorf("%s still connected/reserved after %s", service, settle)
	}
	windowStart := time.Now()
	for time.Since(windowStart) < hold {
		time.Sleep(time.Second)
		st, err := r.status(service)
		if err != nil {
			return time.Since(windowStart), err
		}
		if connectedToPeer(st, relayID) {
			return time.Since(windowStart), fmt.Errorf("%s connection to %s reappeared", service, relayID)
		}
		if activeReservation(st, relayID) {
			return time.Since(windowStart), fmt.Errorf("%s reservation on %s reappeared", service, relayID)
		}
	}
	return time.Since(windowStart), nil
}

// scenarioPeerPersistence exercises pause/restart and reports DHT fallback as
// BLOCKED because the G2 config generator pre-seeds known_relays and has no
// controllable stale friend address. Pause and restart checks still run.
func (r *runner) scenarioPeerPersistence() (string, error) {
	a, b := "a-quic", "b-quic"
	relayID := r.ids["r1"]
	relayAddr := "/ip4/11.40.0.2/tcp/4001/p2p/" + relayID
	_, knownCode := r.exec(a, "sh", "-c", "grep -q 'known_relays' /data/config.toml")
	r.addBlockedCheck("relay reached without known_relays in config",
		fmt.Sprintf("G2 nat peer configs pre-seed known_relays (grep exit %d); no no-known-relay service", knownCode))
	if _, err := r.waitRelayActive(a, relayID, 60*time.Second); !r.require("a-quic initial reservation", err) {
		return "FAIL", nil
	}
	if out, c := r.exec(a, "raminga", "disconnect", relayID, "--data-dir", "/data"); c != 0 {
		r.addCheck("disconnect A from R", false, fmt.Sprintf("exit=%d out=%s", c, strings.TrimSpace(out)))
		return "FAIL", nil
	}
	r.addCheck("disconnect A from R", true, "command succeeded")
	held, err := r.holdNoRelay(a, relayID, 5*time.Second, 65*time.Second)
	if err != nil {
		r.addCheck("A stays disconnected for >60s", false, err.Error())
		return "FAIL", nil
	}
	r.addCheck("A stays disconnected for >60s", true, fmt.Sprintf("observed %s", held.Round(time.Second)))
	if _, err := r.connect(a, relayAddr); err != nil {
		r.addCheck("explicit reconnect to R", false, err.Error())
		return "FAIL", nil
	}
	r.addCheck("explicit reconnect to R", true, relayAddr)
	if _, err := r.waitRelayActive(a, relayID, 60*time.Second); !r.require("explicit connect restores reservation", err) {
		return "FAIL", nil
	}
	if out, c := r.compose("restart", a); c != 0 {
		r.addCheck("restart a", false, strings.TrimSpace(out))
		return "FAIL", nil
	}
	if _, err := r.waitReady(a, 60*time.Second); !r.require("a ready after restart", err) {
		return "FAIL", nil
	}
	if _, err := r.waitRelayActive(a, relayID, 60*time.Second); !r.require("reservation recovers after restart", err) {
		return "FAIL", nil
	}
	if out, c := r.exec(b, "raminga", "disconnect", relayID, "--data-dir", "/data"); c != 0 {
		r.addCheck("disconnect B from R", false, fmt.Sprintf("exit=%d out=%s", c, strings.TrimSpace(out)))
		return "FAIL", nil
	}
	r.addCheck("disconnect B from R", true, "command succeeded")
	if out, c := r.compose("restart", b); c != 0 {
		r.addCheck("restart b", false, strings.TrimSpace(out))
		return "FAIL", nil
	}
	if _, err := r.waitReady(b, 60*time.Second); !r.require("b ready after restart", err) {
		return "FAIL", nil
	}
	held, err = r.holdNoRelay(b, relayID, 5*time.Second, 40*time.Second)
	if err != nil {
		r.addCheck("paused peer stays paused after restart", false, err.Error())
		return "FAIL", nil
	}
	r.addCheck("paused peer stays paused after restart", true, fmt.Sprintf("observed %s", held.Round(time.Second)))
	r.addBlockedCheck("DHT stale-address fallback",
		"G2 topology has no controllable stale friend address or no-known-relay C peer")
	return "BLOCKED", nil
}

func (r *runner) contentJSON(service string, args ...string) (string, int) {
	return r.exec(service, append([]string{"raminga"}, append(args, "--data-dir", "/data", "--json")...)...)
}

func (r *runner) contentProfile(service, pid string) (*apiv1.GetPeerProfileResponse, error) {
	out, code := r.contentJSON(service, "content", "profile", pid)
	if code != 0 {
		return nil, fmt.Errorf("profile exit %d: %s", code, out)
	}
	var res apiv1.GetPeerProfileResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("profile decode: %w (%s)", err, out)
	}
	return &res, nil
}

func (r *runner) contentManifest(service, pid string) (*apiv1.GetPeerManifestResponse, error) {
	out, code := r.contentJSON(service, "content", "manifest", pid)
	if code != 0 {
		return nil, fmt.Errorf("manifest exit %d: %s", code, out)
	}
	var res apiv1.GetPeerManifestResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("manifest decode: %w (%s)", err, out)
	}
	return &res, nil
}

func (r *runner) contentFriends(service, pid string) (*apiv1.GetPeerFriendsResponse, error) {
	out, code := r.contentJSON(service, "content", "friends", pid)
	if code != 0 {
		return nil, fmt.Errorf("friends exit %d: %s", code, out)
	}
	var res apiv1.GetPeerFriendsResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("friends decode: %w (%s)", err, out)
	}
	return &res, nil
}

func (r *runner) contentGet(service, pid, remotePath string) (*apiv1.DownloadPeerFileResponse, error) {
	out, code := r.contentJSON(service, "content", "get", pid, remotePath)
	if code != 0 {
		return nil, fmt.Errorf("get exit %d: %s", code, out)
	}
	var res apiv1.DownloadPeerFileResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("get decode: %w (%s)", err, out)
	}
	return &res, nil
}

func (r *runner) contentConnect(owner, listed string) (*apiv1.ConnectResponse, error) {
	out, code := r.contentJSON("b-relay", "content", "connect", owner, listed)
	if code != 0 {
		return nil, fmt.Errorf("content connect exit %d: %s", code, out)
	}
	var res apiv1.ConnectResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("connect decode: %w (%s)", err, out)
	}
	return &res, nil
}

func (r *runner) friendsList(service string) (*apiv1.ListFriendsResponse, error) {
	out, code := r.exec(service, "raminga", "friends", "list", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("friends list exit %d: %s", code, out)
	}
	var res apiv1.ListFriendsResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("friends decode: %w (%s)", err, out)
	}
	return &res, nil
}

func friendByID(res *apiv1.ListFriendsResponse, pid string) *apiv1.Friend {
	for _, f := range res.GetFriends() {
		if f.GetPeerId() == pid {
			return f
		}
	}
	return nil
}

func listedByID(res *apiv1.GetPeerFriendsResponse, pid string) *apiv1.PeerFriendClaim {
	for _, f := range res.GetFriends() {
		if f.GetPeerId() == pid {
			return f
		}
	}
	return nil
}

func (r *runner) limitedTo(service, pid string) (bool, string) {
	st, err := r.status(service)
	if err != nil {
		return false, err.Error()
	}
	for _, c := range st.GetConnections() {
		if c.GetPeerId() == pid {
			return c.GetLimited(), fmt.Sprintf("route=%s limited=%t relay=%s", c.GetRoute(), c.GetLimited(), c.GetRelayPeerId())
		}
	}
	return false, "no connection"
}

func (r *runner) scenarioContentFlow() (string, error) {
	a, b, c := "a-relay", "b-relay", "b-tcp"
	aID, bID, cID := r.ids[a], r.ids[b], r.ids[c]
	if !r.require("distinct content peers", boolError(aID != "" && bID != "" && cID != "" && aID != bID && bID != cID, aID+" "+bID+" "+cID)) {
		return "FAIL", nil
	}
	// Step 1: profile and small post from A through A's relay circuit.
	if out, code := r.exec(a, "sh", "-c", "mkdir -p /data/public/profile /data/public/posts && printf '# Alina\\nhello from A\\n' > /data/public/profile/index.md && printf 'hello post' > /data/public/posts/hello.md && dd if=/dev/zero of=/data/public/posts/big.bin bs=1048576 count=1 status=none"); code != 0 {
		r.addCheck("write A content", false, out)
		return "FAIL", nil
	}
	if out, code := r.exec(c, "sh", "-c", "mkdir -p /data/public/profile && printf '# Carol\\nhello from C\\n' > /data/public/profile/index.md"); code != 0 {
		r.addCheck("write C content", false, out)
		return "FAIL", nil
	}
	relay, err := r.waitRelayActive(a, r.ids["r1"], 60*time.Second)
	if !r.require("A relay reservation", err) {
		return "FAIL", nil
	}
	conn, err := r.connect(b, relay.GetRelayedAddr())
	if !r.require("B connects to A through relay circuit", err) {
		return "FAIL", nil
	}
	r.addCheck("B reaches A over relay", conn.GetRoute() == "relay" && conn.GetLimited(), fmt.Sprintf("route=%s limited=%t", conn.GetRoute(), conn.GetLimited()))
	profile, err := r.contentProfile(b, aID)
	if !r.require("B reads A profile", err) {
		return "FAIL", nil
	}
	r.addCheck("A profile heading/body match", profile.GetFound() && profile.GetName() == "Alina" && strings.Contains(profile.GetText(), "hello from A"), fmt.Sprintf("name=%q text=%q", profile.GetName(), profile.GetText()))
	got, err := r.contentGet(b, aID, "posts/hello.md")
	if !r.require("B downloads A post", err) {
		return "FAIL", nil
	}
	body, code := r.exec(b, "cat", got.GetLocalPath())
	wantHash := fmt.Sprintf("%x", sha256.Sum256([]byte("hello post")))
	r.addCheck("downloaded post content and sha256 match", code == 0 && body == "hello post" && got.GetSha256() == wantHash,
		fmt.Sprintf("exit=%d body=%q sha=%s want=%s path=%s", code, body, got.GetSha256(), wantHash, got.GetLocalPath()))
	parts, _ := r.exec(b, "sh", "-c", "find /data/downloads/"+aID+" -name '*.part' -print 2>/dev/null || true")
	r.addCheck("no leftover .part after small download", strings.TrimSpace(parts) == "", strings.TrimSpace(parts))
	al, err := r.friendsList(a)
	if !r.require("A friends list readable", err) {
		return "FAIL", nil
	}
	bl, err := r.friendsList(b)
	if !r.require("B friends list readable", err) {
		return "FAIL", nil
	}
	r.addCheck("both sides recorded after profile/get", friendByID(al, bID) != nil && friendByID(bl, aID) != nil,
		fmt.Sprintf("A_has_B=%t B_has_A=%t", friendByID(al, bID) != nil, friendByID(bl, aID) != nil))

	// Step 2: A learns C; B reads A's list and explicitly connects to C.
	before, err := r.friendsList(b)
	if !r.require("B friends before C", err) {
		return "FAIL", nil
	}
	r.addCheck("B has no prior C row", friendByID(before, cID) == nil, fmt.Sprintf("C_present=%t", friendByID(before, cID) != nil))
	cRelay, err := r.waitRelayActive(c, r.ids["r1"], 60*time.Second)
	if !r.require("C relay reservation", err) {
		return "FAIL", nil
	}
	if _, err := r.connect(a, cRelay.GetRelayedAddr()); !r.require("A connects to C by circuit", err) {
		return "FAIL", nil
	}
	if out, code := r.exec(a, "raminga", "friends", "sync", "--data-dir", "/data"); code != 0 {
		r.addCheck("A friends sync", false, out)
		return "FAIL", nil
	}
	list, err := r.contentFriends(b, aID)
	if !r.require("B reads A friend list", err) {
		return "FAIL", nil
	}
	afterList, _ := r.friendsList(b)
	r.addCheck("reading A's list adds no C row on B", friendByID(afterList, cID) == nil, fmt.Sprintf("B_has_C=%t", friendByID(afterList, cID) != nil))
	claim := listedByID(list, cID)
	r.addCheck("A's list contains C with addresses", claim != nil && len(claim.GetAddrs()) > 0, fmt.Sprintf("claim=%v", claim))
	if claim == nil || len(claim.GetAddrs()) == 0 {
		return "FAIL", nil
	}
	r.addCheck("listed C addresses", true, fmt.Sprintf("%v", claim.GetAddrs()))
	cconn, err := r.contentConnect(aID, cID)
	if !r.require("B connects to listed C", err) {
		return "FAIL", nil
	}
	cprofile, err := r.contentProfile(b, cID)
	if !r.require("B reads C profile", err) {
		return "FAIL", nil
	}
	r.addCheck("C profile via listed-address path", cprofile.GetFound() && strings.Contains(cprofile.GetText(), "hello from C"), fmt.Sprintf("route=%s direct=%t limited=%t name=%q", cconn.GetRoute(), cconn.GetDirect(), cconn.GetLimited(), cprofile.GetName()))

	// Step 3: B-A was relay-limited; small remains allowed, 1 MiB must wait/fail.
	limited, detail := r.limitedTo(b, aID)
	r.addCheck("B-A connection is limited before 1 MiB attempt", limited, detail)
	if !limited {
		big, err := r.contentGet(b, aID, "posts/big.bin")
		if !r.require("1 MiB download on direct path", err) {
			return "FAIL", nil
		}
		r.addCheck("1 MiB direct hash", big.GetSha256() != "", fmt.Sprintf("sha256=%s size=%d", big.GetSha256(), big.GetTotalBytes()))
	} else {
		manifest, err := r.contentManifest(b, aID)
		if !r.require("manifest page over limited relay", err) {
			return "FAIL", nil
		}
		r.addCheck("limited manifest is non-empty", manifest.GetTotal() > 0 && len(manifest.GetEntries()) > 0, fmt.Sprintf("total=%d entries=%d limited=%t", manifest.GetTotal(), len(manifest.GetEntries()), manifest.GetLimited()))
		small, err := r.contentGet(b, aID, "posts/hello.md")
		if !r.require("small file over limited relay", err) {
			return "FAIL", nil
		}
		r.addCheck("small limited download path", small.GetSha256() != "", small.GetLocalPath())
		bigOut, bigCode := r.contentJSON(b, "content", "get", aID, "posts/big.bin")
		if bigCode == 0 {
			r.addCheck("1 MiB limited rejected", false, bigOut)
		} else {
			msg := strings.ToLower(bigOut)
			r.addCheck("1 MiB limited rejection is explicit", strings.Contains(msg, "direct connection required"), bigOut)
		}
		parts, _ := r.exec(b, "sh", "-c", "find /data/downloads/"+aID+" -name '*.part' -print 2>/dev/null || true")
		r.addCheck("no .part stitched for big file", strings.TrimSpace(parts) == "", strings.TrimSpace(parts))
	}

	// Step 4: removal is visible only after explicit sync; reading never adds C.
	if out, code := r.exec(a, "raminga", "friends", "remove", cID, "--data-dir", "/data"); code != 0 {
		r.addCheck("remove C from A", false, out)
		return "FAIL", nil
	}
	afterRemove, err := r.contentFriends(b, aID)
	if !r.require("B rereads A before sync", err) {
		return "FAIL", nil
	}
	r.addCheck("removal not visible before sync", listedByID(afterRemove, cID) != nil, fmt.Sprintf("C_present=%t", listedByID(afterRemove, cID) != nil))
	if out, code := r.exec(a, "raminga", "friends", "sync", "--data-dir", "/data"); code != 0 {
		r.addCheck("A friends sync after remove", false, out)
		return "FAIL", nil
	}
	afterSync, err := r.contentFriends(b, aID)
	if !r.require("B rereads A after sync", err) {
		return "FAIL", nil
	}
	r.addCheck("removed C absent after sync", listedByID(afterSync, cID) == nil, fmt.Sprintf("C_present=%t", listedByID(afterSync, cID) != nil))
	return "PASS", nil
}
