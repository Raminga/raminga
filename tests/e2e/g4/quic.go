package main

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

func (r *runner) g3Exec(service string, args ...string) (string, int) {
	env := append(os.Environ(),
		"G3_CONFIG_DIR="+r.root+"/.local/lab/dualnat/configs",
		"G3_EXTRA_ARGS=--enable-test-api",
	)
	full := append([]string{"compose", "-p", soakProject, "-f", "tests/e2e/g3/docker-compose.dualnat.yml", "exec", "-T", service}, args...)
	return r.command(service, env, "docker", full...)
}

func (r *runner) g3ClearDrop(service string, extra ...string) {
	args := append([]string{"iptables", "-D", "FORWARD"}, extra...)
	args = append(args, "-j", "DROP")
	for i := 0; i < 10; i++ {
		if _, code := r.g3Exec(service, args...); code != 0 {
			return
		}
	}
}

func (r *runner) g3Status(service string) (*apiv1.StatusResponse, error) {
	out, code := r.g3Exec(service, "raminga", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("status %s: %s", service, out)
	}
	var st apiv1.StatusResponse
	if err := protojson.Unmarshal([]byte(out), &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (r *runner) g3Chat(service, peerID, text string) (*apiv1.SendChatResponse, time.Duration, error) {
	start := time.Now()
	out, code := r.g3Exec(service, "raminga", "chat", "send", "--data-dir", "/data", "--to", peerID, "--text", text, "--json")
	elapsed := time.Since(start)
	var res apiv1.SendChatResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, elapsed, fmt.Errorf("chat %s exit=%d: %s", service, code, out)
	}
	return &res, elapsed, nil
}

func (r *runner) g3Outbox(service string) (*apiv1.OutboxListResponse, error) {
	out, code := r.g3Exec(service, "raminga", "chat", "outbox", "--data-dir", "/data", "--limit", "500", "--json")
	if code != 0 {
		return nil, fmt.Errorf("outbox %s: %s", service, out)
	}
	var res apiv1.OutboxListResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (r *runner) g3FindOutbox(service, textPrefix string) (*apiv1.OutboxEntry, error) {
	res, err := r.g3Outbox(service)
	if err != nil {
		return nil, err
	}
	for _, e := range res.GetEntries() {
		if strings.Contains(e.GetText(), textPrefix) {
			return e, nil
		}
	}
	return nil, fmt.Errorf("g3 outbox entry %q not found", textPrefix)
}

func (r *runner) g3WaitOutbox(service, messageID, want string, timeout time.Duration) (*apiv1.OutboxEntry, error) {
	deadline := time.Now().Add(timeout)
	var last *apiv1.OutboxEntry
	for time.Now().Before(deadline) {
		res, err := r.g3Outbox(service)
		if err == nil {
			for _, e := range res.GetEntries() {
				if e.GetMessageId() == messageID {
					last = e
					if e.GetStatus() == want {
						return e, nil
					}
				}
			}
		}
		time.Sleep(time.Second)
	}
	if last == nil {
		return nil, fmt.Errorf("g3 outbox entry %s not found", messageID)
	}
	return last, fmt.Errorf("g3 outbox entry %s is %s, want %s", messageID, last.GetStatus(), want)
}

func g3RouteTo(st *apiv1.StatusResponse, peerID string) (direct bool, route, transport string) {
	for _, c := range st.GetConnections() {
		if c.GetPeerId() != peerID {
			continue
		}
		route, transport = c.GetRoute(), c.GetTransport()
		if c.GetDirect() && c.GetTransport() == "quic" && !c.GetLimited() {
			return true, route, transport
		}
	}
	return false, route, transport
}

func (r *runner) g3WaitDirect(a, b string, timeout time.Duration) (time.Duration, error) {
	start := time.Now()
	for time.Since(start) < timeout {
		st, err := r.g3Status(a)
		if err == nil {
			if ok, _, _ := g3RouteTo(st, r.ids[b]); ok {
				return time.Since(start), nil
			}
		}
		time.Sleep(2 * time.Second)
	}
	return time.Since(start), fmt.Errorf("no direct QUIC %s->%s within %s", a, b, timeout)
}

func (r *runner) g3WaitDirectAny(a, b string, timeout time.Duration) (time.Duration, string, error) {
	start := time.Now()
	for time.Since(start) < timeout {
		st, err := r.g3Status(a)
		if err == nil {
			for _, c := range st.GetConnections() {
				if c.GetPeerId() == r.ids[b] && c.GetDirect() && !c.GetLimited() {
					return time.Since(start), c.GetTransport(), nil
				}
			}
		}
		time.Sleep(2 * time.Second)
	}
	return time.Since(start), "", fmt.Errorf("no direct %s->%s within %s", a, b, timeout)
}

func (r *runner) g3WaitNoDirect(a, b string, timeout time.Duration) (time.Duration, error) {
	start := time.Now()
	var lastRoute, lastTransport string
	for time.Since(start) < timeout {
		st, err := r.g3Status(a)
		if err == nil {
			hasDirect := false
			for _, c := range st.GetConnections() {
				if c.GetPeerId() == r.ids[b] {
					lastRoute, lastTransport = c.GetRoute(), c.GetTransport()
					if c.GetDirect() && !c.GetLimited() {
						hasDirect = true
					}
				}
			}
			if !hasDirect {
				return time.Since(start), nil
			}
		}
		time.Sleep(time.Second)
	}
	return time.Since(start), fmt.Errorf("direct did not break within %s (last route=%s transport=%s)", timeout, lastRoute, lastTransport)
}

func (r *runner) g3WaitNoQUICDirect(a, b string, timeout time.Duration) (time.Duration, error) {
	start := time.Now()
	for time.Since(start) < timeout {
		st, err := r.g3Status(a)
		if err == nil {
			hasQUIC := false
			for _, c := range st.GetConnections() {
				if c.GetPeerId() == r.ids[b] && c.GetDirect() && !c.GetLimited() && c.GetTransport() == "quic" {
					hasQUIC = true
				}
			}
			if !hasQUIC {
				return time.Since(start), nil
			}
		}
		time.Sleep(time.Second)
	}
	return time.Since(start), fmt.Errorf("QUIC direct did not break within %s", timeout)
}

// setupQUICLab builds/starts the real G3 dual-NAT lab with the current daemon
// binary and establishes a relay path followed by a real QUIC DCUtR direct
// connection.
func (r *runner) setupQUICLab() error {
	labEnv := append(os.Environ(), "G3_LAB_EXTRA_ARGS=--enable-test-api")
	if out, code := r.command("host", labEnv, "go", "run", "./tests/e2e/g3", "-lab", "dualnat", "-up", "-rebuild"); code != 0 {
		return fmt.Errorf("g3 dualnat lab start: %s", out)
	}
	for _, svc := range []string{"a-quic", "b-quic", "r1", "r2"} {
		deadline := time.Now().Add(180 * time.Second)
		for {
			st, err := r.g3Status(svc)
			if err == nil && st.GetPeerId() != "" {
				r.ids[svc] = st.GetPeerId()
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("%s not ready: %v", svc, err)
			}
			time.Sleep(2 * time.Second)
		}
	}
	relayAddr, err := r.waitRelayAddrSoak("b-quic", r.ids["r1"], 120*time.Second)
	if err != nil {
		return err
	}
	if out, code := r.g3Exec("a-quic", "raminga", "connect", "--data-dir", "/data", relayAddr); code != 0 {
		return fmt.Errorf("initial relay connect: %s", out)
	}
	if _, err := r.g3WaitDirect("a-quic", "b-quic", 120*time.Second); err != nil {
		return err
	}
	return nil
}

func (r *runner) runQUICScenarios() {
	wanted := len(r.only) == 0 || r.only["S24"] || r.only["S25"] || r.only["S26"]
	if !wanted {
		return
	}
	fmt.Printf("\n=== QUIC stability lab (S24-S26) ===\n")
	if err := r.setupQUICLab(); err != nil {
		for _, sc := range []struct{ id, name string }{
			{"S24", "quic-idle-keepalive"}, {"S25", "quic-network-change"}, {"S26", "quic-udp-blocked"},
		} {
			r.ev.Scenarios = append(r.ev.Scenarios, &scenarioEvidence{
				ID: sc.id, Name: sc.name, Status: "BLOCKED",
				Checks: []check{{Name: sc.name, Pass: false, Detail: err.Error()}},
				Error:  r.redactText(err.Error()),
			})
		}
		return
	}
	defer func() {
		if !r.keep {
			_, _ = r.recordCommand("host", "go", "run", "./tests/e2e/g3", "-lab", "dualnat", "-down")
		}
	}()
	if len(r.only) == 0 || r.only["S24"] {
		r.runScenario("S24", "quic-idle-keepalive", r.scenarioQUICIdle)
	}
	if len(r.only) == 0 || r.only["S25"] {
		r.runScenario("S25", "quic-network-change", r.scenarioQUICNetworkChange)
	}
	if len(r.only) == 0 || r.only["S26"] {
		r.runScenario("S26", "quic-udp-blocked", r.scenarioQUICUDPBlocked)
	}
}

func (r *runner) scenarioQUICIdle() (string, error) {
	c := &checker{r: r}
	if _, err := r.g3WaitDirect("a-quic", "b-quic", 120*time.Second); err != nil {
		return "", err
	}
	udpA, _ := r.g3Exec("nat-a", "sysctl", "-n", "net.netfilter.nf_conntrack_udp_timeout")
	udpB, _ := r.g3Exec("nat-b", "sysctl", "-n", "net.netfilter.nf_conntrack_udp_timeout")
	c.check("NAT UDP conntrack timeout is 30s", strings.TrimSpace(udpA) == "30" && strings.TrimSpace(udpB) == "30",
		fmt.Sprintf("nat-a=%s nat-b=%s", strings.TrimSpace(udpA), strings.TrimSpace(udpB)))
	const idleFor = 180 * time.Second
	deadline := time.Now().Add(idleFor)
	directSamples, samples := 0, 0
	for time.Now().Before(deadline) {
		time.Sleep(30 * time.Second)
		st, err := r.g3Status("a-quic")
		if err != nil {
			continue
		}
		samples++
		if ok, _, _ := g3RouteTo(st, r.ids["b-quic"]); ok {
			directSamples++
		}
	}
	c.check("direct QUIC held >=95% of idle samples", samples > 0 && directSamples*100/samples >= 95,
		fmt.Sprintf("%d/%d after %s idle", directSamples, samples, idleFor))
	sendA, latA, err := r.g3Chat("a-quic", r.ids["b-quic"], fmt.Sprintf("g4-quic-idle-a-%d", time.Now().UnixNano()))
	if err != nil {
		return "", err
	}
	sendB, latB, err := r.g3Chat("b-quic", r.ids["a-quic"], fmt.Sprintf("g4-quic-idle-b-%d", time.Now().UnixNano()))
	if err != nil {
		return "", err
	}
	lats := []time.Duration{latA, latB}
	sort.Slice(lats, func(i, j int) bool { return lats[i] < lats[j] })
	c.check("post-idle bidirectional ACK", sendA.GetAcked() && sendB.GetAcked() && lats[len(lats)-1] <= 10*time.Second,
		fmt.Sprintf("a=%t/%s b=%t/%s", sendA.GetAcked(), latA, sendB.GetAcked(), latB))
	return fmt.Sprintf("direct=%d/%d ack=%s/%s", directSamples, samples, latA, latB), c.err()
}

func (r *runner) scenarioQUICNetworkChange() (string, error) {
	c := &checker{r: r}
	if _, err := r.g3WaitDirect("a-quic", "b-quic", 120*time.Second); err != nil {
		return "", err
	}
	if out, code := r.g3Exec("nat-a", "conntrack", "-F"); code != 0 {
		return "", fmt.Errorf("flush nat-a: %s", out)
	}
	if out, code := r.g3Exec("nat-b", "conntrack", "-F"); code != 0 {
		return "", fmt.Errorf("flush nat-b: %s", out)
	}
	// A conntrack flush alone can be reseeded with the same external 4-tuple by
	// the 15 s QUIC keepalive, so the real network-change leg also drops all
	// forwarded traffic for 60 s (> break detection + 20 s send deadline).
	for _, svc := range []string{"nat-a", "nat-b"} {
		if out, code := r.g3Exec(svc, "iptables", "-I", "FORWARD", "1", "-j", "DROP"); code != 0 {
			return "", fmt.Errorf("network-change drop on %s: %s", svc, out)
		}
	}
	restore := make(chan struct{})
	go func() {
		time.Sleep(60 * time.Second)
		for _, svc := range []string{"nat-a", "nat-b"} {
			r.g3ClearDrop(svc)
		}
		close(restore)
	}()
	defer func() {
		for _, svc := range []string{"nat-a", "nat-b"} {
			r.g3ClearDrop(svc)
		}
	}()
	time.Sleep(time.Second)
	breakAfter, breakErr := r.g3WaitNoDirect("a-quic", "b-quic", 45*time.Second)
	if breakErr != nil {
		return "", breakErr
	}
	prefix := fmt.Sprintf("g4-quic-flush-%d", time.Now().UnixNano())
	send, _, sendErr := r.g3Chat("a-quic", r.ids["b-quic"], prefix)
	if sendErr != nil {
		c.check("outage send fails without fake ACK", true, sendErr.Error())
	} else {
		c.check("outage send reports acked=false", !send.GetAcked(), fmt.Sprintf("acked=%t", send.GetAcked()))
	}
	select {
	case <-restore:
	case <-time.After(40 * time.Second):
		return "", errors.New("network-change rules were not restored")
	}
	c.check("direct breaks after the network change", breakAfter <= 60*time.Second, breakAfter.String())
	entry, err := r.g3FindOutbox("a-quic", prefix)
	if err != nil {
		return "", err
	}
	c.check("outbox pending during QUIC outage", entry.GetStatus() == "pending", entry.GetStatus())
	relaySeen := false
	directAfter, directTransport := time.Duration(0), ""
	waitStart := time.Now()
	for time.Since(waitStart) < 180*time.Second {
		st, serr := r.g3Status("a-quic")
		if serr == nil {
			for _, c := range st.GetConnections() {
				if c.GetPeerId() != r.ids["b-quic"] {
					continue
				}
				if c.GetRoute() == "relay" || c.GetLimited() {
					relaySeen = true
				}
				if c.GetDirect() && !c.GetLimited() {
					directAfter = time.Since(waitStart)
					directTransport = c.GetTransport()
				}
			}
		}
		if directAfter > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if directAfter == 0 {
		return "", fmt.Errorf("DCUtR direct not restored within 180s (relay_seen=%t)", relaySeen)
	}
	c.check("relay path observed during recovery", relaySeen, fmt.Sprintf("relay_seen=%t", relaySeen))
	c.check("DCUtR direct restored within 180s", directAfter <= 180*time.Second,
		fmt.Sprintf("%s transport=%s", directAfter, directTransport))
	acked, err := r.g3WaitOutbox("a-quic", entry.GetMessageId(), "acked", 60*time.Second)
	if err != nil {
		return "", err
	}
	c.check("outbox auto-delivers after recovery", acked.GetStatus() == "acked", fmt.Sprintf("attempts=%d", acked.GetAttempts()))
	// Count receiver rows through the real API.
	rx, err := r.g3History("b-quic")
	if err != nil {
		return "", err
	}
	count := 0
	for _, m := range rx.GetMessages() {
		if strings.Contains(m.GetText(), prefix) {
			count++
		}
	}
	c.check("receiver stores exactly one row", count == 1, fmt.Sprintf("rows=%d", count))
	return fmt.Sprintf("break=%s direct_restore=%s attempts=%d", breakAfter, directAfter+breakAfter, acked.GetAttempts()), c.err()
}

func (r *runner) g3History(service string) (*apiv1.RecentMessagesResponse, error) {
	out, code := r.g3Exec(service, "raminga", "chat", "history", "--data-dir", "/data", "--limit", "500", "--json")
	if code != 0 {
		return nil, fmt.Errorf("history %s: %s", service, out)
	}
	var res apiv1.RecentMessagesResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (r *runner) scenarioQUICUDPBlocked() (string, error) {
	c := &checker{r: r}
	if _, err := r.g3WaitDirect("a-quic", "b-quic", 120*time.Second); err != nil {
		return "", err
	}
	for _, svc := range []string{"nat-a", "nat-b"} {
		if out, code := r.g3Exec(svc, "iptables", "-I", "FORWARD", "1", "-p", "udp", "-j", "DROP"); code != 0 {
			return "", fmt.Errorf("drop udp on %s: %s", svc, out)
		}
	}
	defer func() {
		for _, svc := range []string{"nat-a", "nat-b"} {
			r.g3ClearDrop(svc, "-p", "udp")
		}
	}()
	breakAfter, err := r.g3WaitNoQUICDirect("a-quic", "b-quic", 90*time.Second)
	if err != nil {
		return "", err
	}
	c.check("QUIC direct breaks when UDP is dropped", breakAfter <= 90*time.Second, breakAfter.String())
	send, lat, err := r.g3Chat("a-quic", r.ids["b-quic"], fmt.Sprintf("g4-quic-udpdrop-%d", time.Now().UnixNano()))
	if err != nil {
		return "", err
	}
	c.check("chat ACKs through fallback within 15s", send.GetAcked() && lat <= 15*time.Second,
		fmt.Sprintf("acked=%t elapsed=%s error=%q route=%s transport=%s", send.GetAcked(), lat, send.GetError(), send.GetRoute(), send.GetTransport()))
	c.check("fallback exposes a relay/TCP route (never a false QUIC direct)", send.GetRoute() == "relay" || send.GetTransport() == "tcp",
		fmt.Sprintf("route=%s transport=%s", send.GetRoute(), send.GetTransport()))
	for _, svc := range []string{"nat-a", "nat-b"} {
		r.g3ClearDrop(svc, "-p", "udp")
	}
	// If an existing relay connection stays healthy, libp2p has no new relayed
	// connection event to trigger another DCUtR attempt. Try passive recovery
	// first, then make one explicit relayed reconnect (a normal user action).
	directAfter, directTransport, err := r.g3WaitDirectAny("a-quic", "b-quic", 60*time.Second)
	reconnectUsed := false
	if err != nil {
		relayAddr, rerr := r.waitRelayAddrSoak("b-quic", r.ids["r1"], 60*time.Second)
		if rerr != nil {
			return "", rerr
		}
		// The first disconnect may already drop the other side's connection, so
		// "not connected" is an expected, benign result here.
		_, _ = r.g3Exec("b-quic", "raminga", "test", "disconnect", "--data-dir", "/data", r.ids["a-quic"])
		_, _ = r.g3Exec("a-quic", "raminga", "test", "disconnect", "--data-dir", "/data", r.ids["b-quic"])
		if out, code := r.g3Exec("a-quic", "raminga", "connect", "--data-dir", "/data", relayAddr); code != 0 {
			return "", fmt.Errorf("reconnect after UDP unblock: %s", out)
		}
		directAfter, directTransport, err = r.g3WaitDirectAny("a-quic", "b-quic", 120*time.Second)
		reconnectUsed = true
		if err != nil {
			return "", err
		}
	}
	c.check("direct restored after UDP unblocked", directAfter <= 180*time.Second,
		fmt.Sprintf("%s transport=%s reconnect_used=%t", directAfter, directTransport, reconnectUsed))
	return fmt.Sprintf("break=%s ack=%s direct_restore=%s transport=%s reconnect=%t",
		breakAfter, lat, directAfter, directTransport, reconnectUsed), c.err()
}
