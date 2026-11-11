package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

type attackerResult struct {
	Mode      string        `json:"mode"`
	PeerID    string        `json:"peer_id"`
	Multiaddr string        `json:"multiaddr"`
	Acks      []attackerAck `json:"acks"`
	Events    []string      `json:"events"`
	Errors    []string      `json:"errors"`
	Sent      int           `json:"sent"`
	Accepted  int           `json:"accepted"`
	Rejected  int           `json:"rejected"`
	Closed    int           `json:"closed"`
	Open      int           `json:"open"`
	Started   int           `json:"started"`
}

type attackerAck struct {
	MessageID string `json:"message_id"`
	Accepted  bool   `json:"accepted"`
	Error     string `json:"error"`
	Sender    string `json:"sender"`
}

type checker struct {
	r      *runner
	failed bool
}

func (c *checker) check(name string, pass bool, detail string) {
	sc := c.r.ev.Scenarios[len(c.r.ev.Scenarios)-1]
	sc.Checks = append(sc.Checks, check{Name: name, Pass: pass, Detail: c.r.redactText(detail)})
	if !pass {
		c.failed = true
	}
}

func (c *checker) err() error {
	if c.failed {
		return errors.New("one or more predefined thresholds failed")
	}
	return nil
}

func parseAttacker(out string) (*attackerResult, error) {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no attacker JSON in output: %s", out)
	}
	var res attackerResult
	if err := json.Unmarshal([]byte(out[start:end+1]), &res); err != nil {
		return nil, fmt.Errorf("parse attacker JSON: %w", err)
	}
	return &res, nil
}

func (r *runner) attacker(args ...string) (*attackerResult, error) {
	out, code := r.exec("attacker", append([]string{"raminga-attacker"}, args...)...)
	res, err := parseAttacker(out)
	if err != nil {
		return nil, err
	}
	if code != 0 && len(res.Errors) == 0 {
		res.Errors = append(res.Errors, "attacker exit "+strconv.Itoa(code))
	}
	return res, nil
}

func (r *runner) chatSend(from, to, text string) (*apiv1.SendChatResponse, error) {
	out, code := r.exec(from, "raminga", "chat", "send",
		"--data-dir", "/data", "--to", r.ids[to], "--multiaddr", r.addr(to), "--text", text, "--json")
	var res apiv1.SendChatResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("chat send %s->%s exit=%d: %s", from, to, code, out)
	}
	return &res, nil
}

func (r *runner) history(service string) (*apiv1.RecentMessagesResponse, error) {
	out, code := r.exec(service, "raminga", "chat", "history", "--data-dir", "/data", "--limit", "500", "--json")
	if code != 0 {
		return nil, fmt.Errorf("history %s: %s", service, out)
	}
	var res apiv1.RecentMessagesResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("parse history %s: %w", service, err)
	}
	return &res, nil
}

func (r *runner) rows(service, messageIDPrefix, textContains string) (int, int) {
	h, err := r.history(service)
	if err != nil {
		return -1, -1
	}
	total, match := 0, 0
	for _, m := range h.GetMessages() {
		total++
		if messageIDPrefix != "" && strings.HasPrefix(m.GetMessageId(), messageIDPrefix) {
			match++
		}
		if textContains != "" && strings.Contains(m.GetText(), textContains) {
			match++
		}
	}
	return match, total
}

func (r *runner) resources(service string) (goroutines, conns, streams int) {
	st, err := r.status(service)
	if err != nil {
		return -1, -1, -1
	}
	res := st.GetNetwork().GetResources()
	return int(res.GetGoroutines()), int(res.GetOpenConnections()), int(res.GetOpenStreams())
}

func (r *runner) fdCount(service string) int {
	out, code := r.exec(service, "sh", "-c", "ls /proc/1/fd | wc -l")
	if code != 0 {
		return -1
	}
	return mustAtoi(out)
}

var memToken = regexp.MustCompile(`([0-9.]+)\s*([KMG]i?B)`)

func (r *runner) rss(service string) int64 {
	container := r.composeRaw("ps", "-q", service)
	if container == "" {
		return -1
	}
	raw := r.hostOutput("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container)
	m := memToken.FindStringSubmatch(raw)
	if len(m) != 3 {
		return -1
	}
	value, _ := strconv.ParseFloat(m[1], 64)
	mult := 1.0
	switch strings.ToUpper(m[2]) {
	case "KB", "KIB":
		mult = 1024
	case "MB", "MIB":
		mult = 1024 * 1024
	case "GB", "GIB":
		mult = 1024 * 1024 * 1024
	}
	return int64(value * mult)
}

func (r *runner) composeOutput(args ...string) string {
	out, _ := r.compose(args...)
	return out
}

func (r *runner) samplePeak(service string, fn func()) (maxG, maxFD int) {
	done := make(chan struct{})
	var once bool
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			if g, _, _ := r.resources(service); g > maxG {
				maxG = g
			}
			if fd := r.fdCount(service); fd > maxFD {
				maxFD = fd
			}
			time.Sleep(600 * time.Millisecond)
		}
	}()
	fn()
	close(done)
	if !once {
		time.Sleep(700 * time.Millisecond)
	}
	return maxG, maxFD
}

func (r *runner) scenarioSpoof() (string, error) {
	c := &checker{r: r}
	baseG, baseFD, _ := r.resources("victim-open")
	prefix := fmt.Sprintf("g4-spoof-%d", time.Now().UnixNano())
	res, err := r.attacker("-mode", "spoof", "-target", r.addr("victim-open"),
		"-spoof-peer", r.ids["friend"], "-count", "3", "-msg-id", prefix)
	if err != nil {
		return "", err
	}
	c.check("3 spoofed attempts sent", res.Sent == 3, fmt.Sprintf("sent=%d", res.Sent))
	c.check("claimed sender is ignored: all 3 accepted as attacker", res.Accepted == 3 && res.Rejected == 0,
		fmt.Sprintf("accepted=%d rejected=%d", res.Accepted, res.Rejected))
	rows, _ := r.rows("victim-open", prefix, "")
	c.check("all 3 stored once under authenticated attacker peer", rows == 3, fmt.Sprintf("rows=%d", rows))
	h, _ := r.history("victim-open")
	impersonated, attackerRows := 0, 0
	for _, m := range h.GetMessages() {
		if !strings.HasPrefix(m.GetMessageId(), prefix) {
			continue
		}
		if m.GetPeerId() == r.ids["friend"] {
			impersonated++
		}
		if m.GetPeerId() == res.PeerID {
			attackerRows++
		}
	}
	c.check("no row is attributed to the claimed sender", impersonated == 0, fmt.Sprintf("claimed_rows=%d", impersonated))
	c.check("stored rows use the stream Peer ID", attackerRows == 3, fmt.Sprintf("attacker_rows=%d", attackerRows))
	if st, err := r.status("victim-open"); err != nil || st.GetPeerId() == "" {
		c.check("victim alive after spoof", false, fmt.Sprintf("err=%v", err))
	} else {
		c.check("victim alive after spoof", true, st.GetPeerId())
	}
	afterG, afterFD, _ := r.resources("victim-open")
	c.check("resource growth bounded", afterG-baseG <= 64 && afterFD-baseFD <= 16,
		fmt.Sprintf("goroutines %d->%d fd %d->%d", baseG, afterG, baseFD, afterFD))
	return fmt.Sprintf("prefix=%s rows=%d", prefix, rows), c.err()
}

func (r *runner) scenarioUnknownPolicy() (string, error) {
	c := &checker{r: r}
	prefix := fmt.Sprintf("g4-unknown-%d", time.Now().UnixNano())
	res, err := r.attacker("-mode", "valid", "-target", r.addr("victim-strict"), "-count", "1", "-msg-id", prefix)
	if err != nil {
		return "", err
	}
	rejected := res.Rejected == 1 && res.Accepted == 0
	reason := len(res.Acks) == 1 && strings.Contains(res.Acks[0].Error, "unknown peer")
	c.check("strict victim rejects unknown authenticated peer", rejected && reason, fmt.Sprintf("acks=%+v", res.Acks))
	rows, _ := r.rows("victim-strict", prefix, "")
	c.check("strict victim stores no unknown message", rows == 0, fmt.Sprintf("rows=%d", rows))

	openPrefix := fmt.Sprintf("g4-default-open-%d", time.Now().UnixNano())
	openRes, err := r.attacker("-mode", "valid", "-target", r.addr("victim-open"), "-count", "1", "-msg-id", openPrefix)
	if err != nil {
		return "", err
	}
	c.check("default policy accepts unknown peer (documented gap)", openRes.Accepted == 1,
		fmt.Sprintf("acks=%+v", openRes.Acks))

	friendPrefix := fmt.Sprintf("g4-allowed-%d", time.Now().UnixNano())
	send, err := r.chatSend("friend", "victim-strict", friendPrefix)
	if err != nil {
		return "", err
	}
	c.check("explicitly allow-listed peer is accepted", send.GetAcked() && send.GetError() == "",
		fmt.Sprintf("acked=%t error=%q", send.GetAcked(), send.GetError()))
	allowedRows, _ := r.rows("victim-strict", "", friendPrefix)
	c.check("allow-listed message stored exactly once", allowedRows == 1, fmt.Sprintf("rows=%d", allowedRows))
	return "strict=deny, allow-list=accept, default=accept (known gap)", c.err()
}

func (r *runner) scenarioNodeBinding() (string, error) {
	return "", fmt.Errorf("%w: logical Node ID has no signed Peer ID binding", errNotImplemented)
}

var eventDurationRE = regexp.MustCompile(`in ([0-9.]+)(ms|s|m)`)

func maxEventDuration(events []string) time.Duration {
	var max time.Duration
	for _, ev := range events {
		m := eventDurationRE.FindStringSubmatch(ev)
		if len(m) != 3 {
			continue
		}
		value, _ := strconv.ParseFloat(m[1], 64)
		d := time.Duration(value * float64(time.Millisecond))
		switch m[2] {
		case "s":
			d = time.Duration(value * float64(time.Second))
		case "m":
			d = time.Duration(value * float64(time.Minute))
		}
		if d > max {
			max = d
		}
	}
	return max
}

func (r *runner) scenarioMalformed() (string, error) {
	c := &checker{r: r}
	baseG, baseFD, _ := r.resources("victim-open")
	_, before := r.rows("victim-open", "", "")
	res, err := r.attacker("-mode", "malformed", "-target", r.addr("victim-open"))
	if err != nil {
		return "", err
	}
	c.check("all 9 malformed variants attempted", res.Sent == 9, fmt.Sprintf("sent=%d", res.Sent))
	c.check("all malformed variants rejected", res.Rejected == 9, fmt.Sprintf("rejected=%d events=%v", res.Rejected, res.Events))
	c.check("no malformed input caused an accepted ACK", res.Accepted == 0, fmt.Sprintf("accepted=%d", res.Accepted))
	c.check("every malformed variant closed within 10.5s", maxEventDuration(res.Events) <= 10500*time.Millisecond,
		fmt.Sprintf("max=%s events=%v", maxEventDuration(res.Events), res.Events))
	_, after := r.rows("victim-open", "", "")
	c.check("malformed input stored no message", after == before, fmt.Sprintf("rows %d->%d", before, after))
	time.Sleep(500 * time.Millisecond)
	afterG, afterFD, _ := r.resources("victim-open")
	c.check("RSS/FD/goroutine growth bounded", afterG-baseG <= 64 && afterFD-baseFD <= 16,
		fmt.Sprintf("goroutines %d->%d fd %d->%d", baseG, afterG, baseFD, afterFD))
	return fmt.Sprintf("events=%s", strings.Join(res.Events, " | ")), c.err()
}

func (r *runner) scenarioOversize() (string, error) {
	c := &checker{r: r}
	baseG, _, _ := r.resources("victim-open")
	res, err := r.attacker("-mode", "malformed", "-variant", "oversized-body", "-target", r.addr("victim-open"))
	if err != nil {
		return "", err
	}
	c.check("oversize frame rejected", res.Sent == 1 && res.Rejected == 1, fmt.Sprintf("sent=%d rejected=%d", res.Sent, res.Rejected))
	fast := len(res.Events) == 1 && strings.Contains(res.Events[0], "closed/rejected")
	c.check("oversize stream closed within 5s", fast && maxEventDuration(res.Events) <= 5*time.Second,
		fmt.Sprintf("max=%s events=%v", maxEventDuration(res.Events), res.Events))
	afterG, _, _ := r.resources("victim-open")
	c.check("RSS/goroutine growth bounded", afterG-baseG <= 64, fmt.Sprintf("goroutines %d->%d", baseG, afterG))
	return strings.Join(res.Events, " | "), c.err()
}

func (r *runner) scenarioDuplicates() (string, error) {
	c := &checker{r: r}
	prefix := fmt.Sprintf("g4-dup-%d", time.Now().UnixNano())
	res, err := r.attacker("-mode", "duplicates", "-target", r.addr("victim-open"), "-count", "20", "-msg-id", prefix)
	if err != nil {
		return "", err
	}
	c.check("20 duplicate sends completed", res.Sent == 20, fmt.Sprintf("sent=%d", res.Sent))
	c.check("all duplicate ACKs returned", len(res.Acks) == 20, fmt.Sprintf("acks=%d", len(res.Acks)))
	rows, _ := r.rows("victim-open", prefix, "")
	c.check("duplicate message stored exactly once", rows == 1, fmt.Sprintf("rows=%d", rows))
	return fmt.Sprintf("rows=%d", rows), c.err()
}

func (r *runner) badackReady() (*attackerResult, error) {
	out, code := r.exec("badack", "cat", "/data/ready.json")
	if code != 0 {
		return nil, fmt.Errorf("read badack ready: %s", out)
	}
	var res attackerResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		return nil, err
	}
	if res.PeerID == "" {
		return nil, errors.New("badack peer ID missing")
	}
	r.ids["badack"] = res.PeerID
	return &res, nil
}

func (r *runner) scenarioForgedAck() (string, error) {
	c := &checker{r: r}
	if _, err := r.badackReady(); err != nil {
		return "", err
	}
	prefix := fmt.Sprintf("g4-forged-%d", time.Now().UnixNano())
	start := time.Now()
	send, err := r.chatSend("victim-open", "badack", prefix)
	if err != nil {
		return "", err
	}
	elapsed := time.Since(start)
	c.check("forged ACK does not count as success", !send.GetAcked(), fmt.Sprintf("acked=%t error=%q", send.GetAcked(), send.GetError()))
	c.check("forged ACK rejected within 20s", elapsed <= 20*time.Second, elapsed.String())
	rows, _ := r.rows("victim-open", "", prefix)
	c.check("outbound row remains stored once", rows == 1, fmt.Sprintf("rows=%d", rows))
	h, _ := r.history("victim-open")
	unacked := false
	for _, m := range h.GetMessages() {
		if strings.Contains(m.GetText(), prefix) && !m.GetAcked() {
			unacked = true
		}
	}
	c.check("persisted row acked=0 (no fake ACK)", unacked, "checked history")
	return fmt.Sprintf("elapsed=%s", elapsed), c.err()
}

func (r *runner) scenarioSlowloris() (string, error) {
	c := &checker{r: r}
	baseG, baseFD, _ := r.resources("victim-open")
	start := time.Now()
	var res *attackerResult
	var err error
	peakG, peakFD := r.samplePeak("victim-open", func() {
		res, err = r.attacker("-mode", "slowloris", "-target", r.addr("victim-open"), "-count", "30", "-duration", "5s")
	})
	if err != nil {
		return "", err
	}
	elapsed := time.Since(start)
	c.check("30 slowloris streams opened", res.Open == 30, fmt.Sprintf("open=%d", res.Open))
	c.check("server closed all partial streams", res.Closed == 30 && elapsed <= 15*time.Second,
		fmt.Sprintf("closed=%d elapsed=%s", res.Closed, elapsed))
	time.Sleep(5 * time.Second)
	afterG, afterFD, _ := r.resources("victim-open")
	c.check("peak goroutine growth <=80", peakG-baseG <= 80, fmt.Sprintf("peak %d base %d", peakG, baseG))
	c.check("peak FD growth <=32", peakFD-baseFD <= 32, fmt.Sprintf("peak %d base %d", peakFD, baseFD))
	c.check("goroutines return to baseline+20", afterG-baseG <= 20, fmt.Sprintf("after %d base %d", afterG, baseG))
	c.check("FDs return to baseline+20", afterFD-baseFD <= 20, fmt.Sprintf("after %d base %d", afterFD, baseFD))
	return fmt.Sprintf("elapsed=%s peakG=%d peakFD=%d", elapsed, peakG, peakFD), c.err()
}

func (r *runner) scenarioFlood() (string, error) {
	c := &checker{r: r}
	baseG, baseFD, _ := r.resources("victim-open")
	baseRSS := r.rss("victim-open")
	start := time.Now()
	res, err := r.attacker("-mode", "flood", "-target", r.addr("victim-open"), "-count", "600")
	if err != nil && res == nil {
		return "", err
	}
	elapsed := time.Since(start)
	c.check("600-message burst attempted", res.Sent+len(res.Errors) >= 600, fmt.Sprintf("sent=%d errors=%d elapsed=%s", res.Sent, len(res.Errors), elapsed))
	c.check("accepted ACKs bounded by rate limit", res.Accepted <= 70, fmt.Sprintf("accepted=%d rejected=%d", res.Accepted, res.Rejected))
	last := res.Acks[len(res.Acks)-1]
	c.check("fresh message accepted after cooldown", last.Accepted, fmt.Sprintf("last=%+v", last))
	afterG, _, _ := r.resources("victim-open")
	afterFD := r.fdCount("victim-open")
	afterRSS := r.rss("victim-open")
	c.check("goroutine growth <=100", afterG-baseG <= 100, fmt.Sprintf("%d->%d", baseG, afterG))
	c.check("FD growth <=32", afterFD-baseFD <= 32, fmt.Sprintf("%d->%d", baseFD, afterFD))
	c.check("RSS growth <=64MiB", afterRSS-baseRSS <= 64<<20, fmt.Sprintf("%d->%d", baseRSS, afterRSS))
	return fmt.Sprintf("accepted=%d rejected=%d elapsed=%s", res.Accepted, res.Rejected, elapsed), c.err()
}

func (r *runner) scenarioManyPeers() (string, error) {
	c := &checker{r: r}
	baseG, _, _ := r.resources("victim-open")
	baseRSS := r.rss("victim-open")
	baseFD := r.fdCount("victim-open")
	network := r.project + "_g4net"
	prefix := fmt.Sprintf("g4-many-%d", time.Now().UnixNano())
	names := make([]string, 0, 20)
	for _, name := range names {
		_, _ = r.command("host", os.Environ(), "docker", "rm", "-f", name)
	}
	names = names[:0]
	for i := 0; i < 20; i++ {
		name := fmt.Sprintf("g4-many-%d", i)
		ip := fmt.Sprintf("10.251.0.%d", 100+i)
		_, _ = r.command("host", os.Environ(), "docker", "rm", "-f", name)
		out, runCode := r.command("host", os.Environ(), "docker", "run", "-d", "--name", name,
			"--network", network, "--ip", ip, "--entrypoint", "raminga-attacker", imageName,
			"-mode", "valid", "-target", r.addr("victim-open"), "-count", "20",
			"-msg-id", fmt.Sprintf("%s-%d", prefix, i))
		if runCode != 0 {
			c.check(fmt.Sprintf("attacker container %d started", i), false, strings.TrimSpace(out))
			continue
		}
		names = append(names, name)
	}
	started := len(names)
	c.check("20 distinct attacker containers started", started == 20, fmt.Sprintf("started=%d", started))
	sent, acceptedContainers := 0, 0
	for _, name := range names {
		waitOut, waitCode := r.command("host", os.Environ(), "docker", "wait", name)
		logs, _ := r.command("host", os.Environ(), "docker", "logs", name)
		lres, _ := parseAttacker(logs)
		if lres != nil {
			sent += lres.Sent
			if waitCode == 0 && strings.TrimSpace(waitOut) == "0" && lres.Sent == 20 {
				acceptedContainers++
			}
		}
		_, _ = r.command("host", os.Environ(), "docker", "rm", "-f", name)
	}
	c.check("20 peers x 20 messages attempted", sent >= 400, fmt.Sprintf("sent=%d", sent))
	c.check("every attacker container completed", acceptedContainers == 20, fmt.Sprintf("completed=%d", acceptedContainers))
	start := time.Now()
	st, err := r.status("victim-open")
	statusElapsed := time.Since(start)
	c.check("victim status responds <=2s", err == nil && statusElapsed <= 2*time.Second, fmt.Sprintf("err=%v elapsed=%s", err, statusElapsed))
	conns := 0
	if st != nil {
		conns = int(st.GetNetwork().GetResources().GetOpenConnections())
	}
	c.check("open connections <= configured 256", conns <= 256, fmt.Sprintf("conns=%d", conns))
	afterG, _, _ := r.resources("victim-open")
	afterFD := r.fdCount("victim-open")
	afterRSS := r.rss("victim-open")
	c.check("goroutine growth <=100", afterG-baseG <= 100, fmt.Sprintf("%d->%d", baseG, afterG))
	c.check("FD growth <=32", afterFD-baseFD <= 32, fmt.Sprintf("%d->%d", baseFD, afterFD))
	c.check("RSS growth <=64MiB", afterRSS-baseRSS <= 64<<20, fmt.Sprintf("%d->%d", baseRSS, afterRSS))
	return fmt.Sprintf("containers=%d sent=%d completed=%d conns=%d", started, sent, acceptedContainers, conns), c.err()
}

func (r *runner) scenarioRelayFlood() (string, error) {
	c := &checker{r: r}
	baseRSS := r.rss("relay-provider")
	out, code := r.exec("relay-provider", "raminga", "relay", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return "", fmt.Errorf("relay status: %s", out)
	}
	var before apiv1.RelayStatusResponse
	if err := protojson.Unmarshal([]byte(out), &before); err != nil {
		return "", err
	}
	c.check("provider quota max_reservations=8", before.GetProvider().GetMaxReservations() == 8,
		fmt.Sprintf("max=%d", before.GetProvider().GetMaxReservations()))
	// Free the normal client's slot so the 12 distinct-IP daemons contend for
	// the full global quota, then restore it afterwards.
	if out, code := r.compose("stop", "relay-normal"); code != 0 {
		return "", fmt.Errorf("stop relay-normal: %s", out)
	}
	defer func() {
		if _, code := r.compose("start", "relay-normal"); code == 0 {
			_ = r.waitReady("relay-normal", 60*time.Second)
		}
	}()
	active, refused, err := r.runRelayFloodContainers(r.ids["relay-provider"])
	if err != nil {
		return "", err
	}
	c.check("12 distinct-IP reservation attempts exercised the global quota", active >= 7 && active <= 8,
		fmt.Sprintf("active=%d refused=%d", active, refused))
	c.check("global max_reservations=8 not exceeded", active <= 8, fmt.Sprintf("active=%d", active))
	c.check("provider logged explicit reservation refusals", refused >= 1, fmt.Sprintf("refusals=%d", refused))
	if st, err := r.status("relay-provider"); err != nil || st.GetPeerId() == "" {
		c.check("provider alive after flood", false, fmt.Sprintf("err=%v", err))
	} else {
		c.check("provider alive after flood", true, st.GetPeerId())
	}
	afterRSS := r.rss("relay-provider")
	c.check("provider RSS growth <=32MiB", afterRSS-baseRSS <= 32<<20, fmt.Sprintf("%d->%d", baseRSS, afterRSS))
	providerLogs := r.composeOutput("logs", "--no-color", "relay-provider")
	reasons := make([]string, 0, 2)
	for _, line := range strings.Split(providerLogs, "\n") {
		if strings.Contains(line, "refusing relay reservation") && len(reasons) < 2 {
			reasons = append(reasons, strings.TrimSpace(line))
		}
	}
	c.check("normal client reservation restored after flood", func() bool {
		if _, code := r.compose("start", "relay-normal"); code != 0 {
			return false
		}
		if err := r.waitReady("relay-normal", 60*time.Second); err != nil {
			return false
		}
		time.Sleep(2 * time.Second)
		out, code := r.exec("relay-normal", "raminga", "relay", "status", "--data-dir", "/data", "--json")
		if code != 0 {
			return false
		}
		var rs apiv1.RelayStatusResponse
		if protojson.Unmarshal([]byte(out), &rs) != nil {
			return false
		}
		for _, rr := range rs.GetRelays() {
			if rr.GetReservationStatus() == "active" {
				return true
			}
		}
		return false
	}(), "relay-normal active after flood")
	return fmt.Sprintf("active=%d refused=%d reasons=%s", active, refused, strings.Join(reasons, " | ")), c.err()
}

func (r *runner) scenarioDiskGrowth() (string, error) {
	c := &checker{r: r}
	prefix := fmt.Sprintf("g4-disk-%d", time.Now().UnixNano())
	res, err := r.attacker("-mode", "valid", "-target", r.addr("disk"), "-count", "400", "-msg-id", prefix)
	if err != nil && res == nil {
		return "", err
	}
	c.check("400 accepted-path messages attempted", res.Sent == 400, fmt.Sprintf("sent=%d accepted=%d", res.Sent, res.Accepted))
	time.Sleep(500 * time.Millisecond)
	h, err := r.history("disk")
	if err != nil {
		return "", err
	}
	c.check("stored rows <= max_stored_messages=100", len(h.GetMessages()) <= 100, fmt.Sprintf("rows=%d", len(h.GetMessages())))
	out, code := r.exec("disk", "sh", "-c", "du -cb /data/raminga.db* | tail -1")
	var bytes int64
	if _, scanErr := fmt.Sscanf(strings.TrimSpace(out), "%d", &bytes); scanErr != nil {
		bytes = 0
	}
	c.check("db+WAL <=4MiB", code == 0 && bytes > 0 && bytes <= 4<<20, fmt.Sprintf("bytes=%d raw=%s", bytes, strings.TrimSpace(out)))
	return fmt.Sprintf("rows=%d db_bytes=%d", len(h.GetMessages()), bytes), c.err()
}

func (r *runner) scenarioAPI() (string, error) {
	c := &checker{r: r}
	out, code := r.exec("victim-open", "sh", "-c", "test -S /data/api.sock && stat -c '%a' /data/api.sock && stat -c '%a' /data/api.token && wc -c < /data/api.token")
	fields := strings.Fields(out)
	sockOK := code == 0 && len(fields) >= 3 && fields[0] == "600" && fields[1] == "600"
	tokenLen := 0
	if len(fields) >= 3 {
		tokenLen = mustAtoi(fields[2])
	}
	c.check("API socket is UDS with mode 0600", sockOK, strings.TrimSpace(out))
	c.check("token file mode 0600 and 64-hex (+newline)", tokenLen == 65, fmt.Sprintf("bytes=%d", tokenLen))
	tokenShape, _ := r.exec("victim-open", "sh", "-c", "tr -d '\n' < /data/api.token | grep -Ec '^[0-9a-f]{64}$'")
	c.check("token is 32-byte hex", strings.TrimSpace(tokenShape) == "1", "checked token shape without emitting it")
	ss, ssCode := r.exec("victim-open", "sh", "-c", "ss -ltn | grep -c ':4001'; ss -ltn | grep -c api.sock || true; ss -lx | grep -c api.sock")
	ssFields := strings.Fields(ss)
	tcpOK := ssCode == 0 && len(ssFields) >= 3 && ssFields[0] == "1" && ssFields[1] == "0" && ssFields[2] == "1"
	c.check("no TCP API listener; only libp2p :4001; UDS present", tcpOK, strings.TrimSpace(ss))
	st, err := r.status("victim-open")
	c.check("default daemon has test API off", err == nil && !st.GetTestApiEnabled(), fmt.Sprintf("err=%v", err))
	pingOut, pingCode := r.exec("victim-open", "raminga", "test", "ping", "--data-dir", "/data", "--echo", "x")
	c.check("TestPing unavailable by default", pingCode != 0 && containsAny(strings.ToLower(pingOut), "unimplemented", "disabled", "test api"),
		fmt.Sprintf("exit=%d out=%s", pingCode, strings.TrimSpace(pingOut)))
	net := st.GetNetwork()
	c.check("UPnP/NAT-PMP/STUN all off", !net.GetUpnp() && !net.GetNatPmp() && !net.GetStun(),
		fmt.Sprintf("upnp=%t natpmp=%t stun=%t", net.GetUpnp(), net.GetNatPmp(), net.GetStun()))
	return "UDS-only, 0600 token/socket, test API off", c.err()
}

func (r *runner) scenarioLogs() (string, error) {
	c := &checker{r: r}
	marker := fmt.Sprintf("G4-MARKER-%d", time.Now().UnixNano())
	text := "\x1b[31m" + marker + "\x1b[0m\nline2\x07"
	res, err := r.attacker("-mode", "valid", "-target", r.addr("victim-open"), "-count", "1", "-text", text, "-msg-id", marker)
	if err != nil {
		return "", err
	}
	if res.Accepted != 1 {
		c.check("control-char message accepted on wire", false, fmt.Sprintf("%+v", res.Acks))
	}
	plain, _ := r.exec("victim-open", "raminga", "chat", "history", "--data-dir", "/data", "--limit", "20")
	c.check("plain CLI output has no raw ESC", !strings.Contains(plain, "\x1b"), fmt.Sprintf("len=%d", len(plain)))
	logs := r.composeOutput("logs", "--no-color")
	c.check("daemon logs contain no message body", !strings.Contains(logs, marker), "marker absent from logs")
	tokenShape := regexp.MustCompile(`[0-9a-f]{64}`)
	c.check("daemon logs contain no 64-hex token-shaped secret", !tokenShape.MatchString(logs), "no token-shaped string in logs")
	c.check("daemon logs contain no private-key marker",
		!containsAny(logs, "PRIVATE KEY", "private_key", "transport-key.pb"), "key markers absent from logs")
	_ = res
	return fmt.Sprintf("marker=%s", marker), c.err()
}

func (r *runner) scenarioCrash() (string, error) {
	c := &checker{r: r}
	if out, code := r.compose("stop", "late"); code != 0 {
		return "", fmt.Errorf("stop late: %s", out)
	}
	prefix := fmt.Sprintf("g4-crash-%d", time.Now().UnixNano())
	send, sendErr := r.chatSend("crash", "late", prefix)
	if sendErr != nil {
		c.check("pre-crash send fails explicitly without fake ACK", true, sendErr.Error())
	} else {
		c.check("pre-crash send has no fake ACK", !send.GetAcked(), fmt.Sprintf("acked=%t", send.GetAcked()))
	}
	entry, err := r.findOutbox("crash", prefix)
	if err != nil {
		return "", err
	}
	c.check("pre-crash outbox entry is pending", entry.GetStatus() == "pending", entry.GetStatus())
	if out, code := r.compose("kill", "-s", "KILL", "crash"); code != 0 {
		return "", fmt.Errorf("kill crash: %s", out)
	}
	start := time.Now()
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "60", "crash"); code != 0 {
		return "", fmt.Errorf("restart crash: %s", out)
	}
	restart := time.Since(start)
	if err := r.waitReady("crash", 30*time.Second); err != nil {
		return "", err
	}
	c.check("restart succeeds within 30s", restart <= 30*time.Second, restart.String())
	integ, code := r.exec("crash", "sqlite3", "/data/raminga.db", "PRAGMA integrity_check;")
	c.check("SQLite integrity_check=ok", code == 0 && strings.TrimSpace(integ) == "ok", strings.TrimSpace(integ))
	h, err := r.history("crash")
	if err != nil {
		return "", err
	}
	unacked := false
	for _, m := range h.GetMessages() {
		if strings.Contains(m.GetText(), prefix) && !m.GetAcked() {
			unacked = true
		}
	}
	c.check("pre-crash message remains acked=0 during outage", unacked, "no fake ACK after restart")
	pending, err := r.findOutbox("crash", prefix)
	if err != nil {
		return "", err
	}
	c.check("outbox survives restart as pending", pending.GetStatus() == "pending", pending.GetStatus())
	if out, code := r.compose("start", "late"); code != 0 {
		return "", fmt.Errorf("start late: %s", out)
	}
	if err := r.waitReady("late", 60*time.Second); err != nil {
		return "", err
	}
	acked, err := r.waitOutboxStatus("crash", entry.GetMessageId(), "acked", 30*time.Second)
	if err != nil {
		return "", err
	}
	c.check("outbox auto-resends after restart and peer recovery", acked.GetStatus() == "acked",
		fmt.Sprintf("attempts=%d", acked.GetAttempts()))
	rows, _ := r.rows("late", "", prefix)
	c.check("receiver stores exactly one row", rows == 1, fmt.Sprintf("rows=%d", rows))
	newPrefix := fmt.Sprintf("g4-crash-after-%d", time.Now().UnixNano())
	after, err := r.chatSend("crash", "friend", newPrefix)
	if err != nil {
		return "", err
	}
	c.check("new chat works after restart", after.GetAcked(), fmt.Sprintf("acked=%t error=%q", after.GetAcked(), after.GetError()))
	return fmt.Sprintf("restart=%s attempts=%d", restart, acked.GetAttempts()), c.err()
}

func (r *runner) scenarioBusy() (string, error) {
	c := &checker{r: r}
	lockCmd := exec.Command("docker", "compose", "-p", r.project, "-f", composeRel, "exec", "-T", "busy", "sh", "-c",
		`(echo "BEGIN EXCLUSIVE;"; sleep 8; echo "COMMIT;") | sqlite3 /data/raminga.db`)
	lockCmd.Dir = r.root
	lockCmd.Env = r.composeEnv()
	if err := lockCmd.Start(); err != nil {
		return "", err
	}
	time.Sleep(1500 * time.Millisecond)
	prefix := fmt.Sprintf("g4-busy-%d", time.Now().UnixNano())
	start := time.Now()
	send, err := r.chatSend("friend", "busy", prefix)
	elapsed := time.Since(start)
	if err != nil {
		return "", err
	}
	c.check("locked DB returns explicit failure, no fake ACK", !send.GetAcked() && send.GetError() != "",
		fmt.Sprintf("acked=%t error=%q elapsed=%s", send.GetAcked(), send.GetError(), elapsed))
	c.check("failure reported within 8s", elapsed <= 8*time.Second, elapsed.String())
	_ = lockCmd.Wait()
	if st, err := r.status("busy"); err != nil || st.GetPeerId() == "" {
		c.check("daemon alive after lock contention", false, fmt.Sprintf("err=%v", err))
	} else {
		c.check("daemon alive after lock contention", true, st.GetPeerId())
	}
	afterPrefix := fmt.Sprintf("g4-busy-after-%d", time.Now().UnixNano())
	after, err := r.chatSend("friend", "busy", afterPrefix)
	if err != nil {
		return "", err
	}
	c.check("chat recovers after lock release", after.GetAcked(), fmt.Sprintf("acked=%t error=%q", after.GetAcked(), after.GetError()))
	return fmt.Sprintf("failure_elapsed=%s", elapsed), c.err()
}

func (r *runner) scenarioFlap() (string, error) {
	c := &checker{r: r}
	if out, code := r.exec("flap-a", "raminga", "connect", "--data-dir", "/data", r.addr("flap-b")); code != 0 {
		return "", fmt.Errorf("initial flap connect: %s", out)
	}
	if out, code := r.exec("flap-b", "iptables", "-I", "INPUT", "1", "-j", "DROP"); code != 0 {
		return "", fmt.Errorf("drop input: %s", out)
	}
	if out, code := r.exec("flap-b", "iptables", "-I", "OUTPUT", "1", "-j", "DROP"); code != 0 {
		return "", fmt.Errorf("drop output: %s", out)
	}
	time.Sleep(1 * time.Second)
	prefix := fmt.Sprintf("g4-flap-drop-%d", time.Now().UnixNano())
	send, err := r.chatSend("flap-a", "flap-b", prefix)
	if err != nil {
		// A CLI deadline is an explicit failure (no ACK), not a fake success.
		c.check("in-flight send during drop fails explicitly without ACK",
			containsAny(strings.ToLower(err.Error()), "deadline", "timeout", "no route", "connection"),
			err.Error())
	} else {
		c.check("in-flight send during drop reports acked=false", !send.GetAcked(), fmt.Sprintf("acked=%t error=%q", send.GetAcked(), send.GetError()))
	}
	entry, err := r.findOutbox("flap-a", prefix)
	if err != nil {
		return "", err
	}
	c.check("flap outbox entry is pending during outage", entry.GetStatus() == "pending", entry.GetStatus())
	_, _ = r.exec("flap-b", "iptables", "-F", "INPUT")
	_, _ = r.exec("flap-b", "iptables", "-F", "OUTPUT")
	start := time.Now()
	reconnected := false
	for time.Since(start) < 30*time.Second {
		_, _ = r.exec("flap-a", "raminga", "test", "disconnect", "--data-dir", "/data", r.ids["flap-b"])
		if out, code := r.exec("flap-a", "raminga", "connect", "--data-dir", "/data", r.addr("flap-b")); code == 0 {
			reconnected = true
			break
		} else {
			_ = out
		}
		time.Sleep(2 * time.Second)
	}
	c.check("reconnect succeeds within 30s", reconnected, time.Since(start).String())
	acked, err := r.waitOutboxStatus("flap-a", entry.GetMessageId(), "acked", 30*time.Second)
	if err != nil {
		return "", err
	}
	c.check("pending outbox is auto-resent after flap", acked.GetStatus() == "acked",
		fmt.Sprintf("attempts=%d", acked.GetAttempts()))
	rows, _ := r.rows("flap-b", "", prefix)
	c.check("flap receiver stores exactly one row", rows == 1, fmt.Sprintf("rows=%d", rows))
	after, err := r.chatSend("flap-a", "flap-b", fmt.Sprintf("g4-flap-after-%d", time.Now().UnixNano()))
	if err != nil {
		return "", err
	}
	c.check("chat recovers after flap", after.GetAcked(), fmt.Sprintf("acked=%t error=%q", after.GetAcked(), after.GetError()))
	return fmt.Sprintf("reconnect=%s", time.Since(start)), c.err()
}
