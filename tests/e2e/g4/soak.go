package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	evsum "github.com/Raminga/raminga/tests/e2e/internal/evidence"
)

type soakEvidence struct {
	StartedAt      string          `json:"started_at"`
	FinishedAt     string          `json:"finished_at"`
	DurationTarget string          `json:"duration_target"`
	DurationActual string          `json:"duration_actual"`
	Topology       string          `json:"topology"`
	Status         string          `json:"status"`
	DirectSamples  int             `json:"direct_samples"`
	TotalSamples   int             `json:"total_samples"`
	DirectRatio    float64         `json:"direct_ratio"`
	Sent           int             `json:"sent"`
	Acked          int             `json:"acked"`
	Failed         int             `json:"failed_after_warmup"`
	WarmupFailures int             `json:"warmup_failures"`
	P95ACKMS       int64           `json:"p95_ack_ms"`
	MaxACKMS       int64           `json:"max_ack_ms"`
	RSSStartBytes  int64           `json:"rss_start_bytes"`
	RSSLastBytes   int64           `json:"rss_last_bytes"`
	RSSGrowthBytes int64           `json:"rss_growth_bytes"`
	FDStart        int             `json:"fd_start"`
	FDLast         int             `json:"fd_last"`
	GoStart        int             `json:"goroutines_start"`
	GoLast         int             `json:"goroutines_last"`
	RSSDriftBytes  int64           `json:"rss_drift_last10_bytes"`
	FDDrift        int             `json:"fd_drift_last10"`
	GoDrift        int             `json:"goroutines_drift_last10"`
	Samples        []soakSample    `json:"samples"`
	Checks         []check         `json:"checks"`
	Commands       []commandRecord `json:"commands,omitempty"`
	Error          string          `json:"error,omitempty"`
}

type soakSample struct {
	At         string `json:"at"`
	RSSBytes   int64  `json:"rss_bytes"`
	FD         int    `json:"fd"`
	Goroutines int    `json:"goroutines"`
	Conns      int    `json:"connections"`
	Direct     bool   `json:"direct_quic"`
	Route      string `json:"route"`
	Transport  string `json:"transport"`
}

const soakProject = "raminga-lab-dualnat"

func (r *runner) soakExec(service string, args ...string) (string, int) {
	env := append(os.Environ(),
		"G3_CONFIG_DIR="+filepath.Join(r.root, ".local", "lab", "dualnat", "configs"),
		"G3_EXTRA_ARGS=--enable-test-api",
	)
	full := append([]string{"compose", "-p", soakProject, "-f", "tests/e2e/g3/docker-compose.dualnat.yml", "exec", "-T", service}, args...)
	return r.command(service, env, "docker", full...)
}

func (r *runner) soakStatus(service string) (*apiv1.StatusResponse, error) {
	out, code := r.soakExec(service, "raminga", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("status %s: %s", service, out)
	}
	var st apiv1.StatusResponse
	if err := protojson.Unmarshal([]byte(out), &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (r *runner) soakRSS(service string) int64 {
	container := r.hostOutput("docker", "ps", "-q",
		"--filter", "label=com.docker.compose.project="+soakProject,
		"--filter", "label=com.docker.compose.service="+service)
	if container == "" {
		return -1
	}
	raw := r.hostOutput("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container)
	m := memToken.FindStringSubmatch(raw)
	if len(m) != 3 {
		return -1
	}
	value, _ := parseFloat(m[1])
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

func parseFloat(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(s, "%f", &f)
	return f, err
}

func (r *runner) soakFD(service string) int {
	out, code := r.soakExec(service, "sh", "-c", "ls /proc/1/fd | wc -l")
	if code != 0 {
		return -1
	}
	return mustAtoi(out)
}

func directTo(st *apiv1.StatusResponse, peerID string) (direct bool, route, transport string) {
	best := ""
	for _, c := range st.GetConnections() {
		if c.GetPeerId() != peerID {
			continue
		}
		route, transport = c.GetRoute(), c.GetTransport()
		if c.GetDirect() && c.GetTransport() == "quic" && !c.GetLimited() {
			return true, route, transport
		}
		best = c.GetRoute()
	}
	if best != "" {
		route = best
	}
	return false, route, transport
}

func (r *runner) runSoak() int {
	// Merge into the existing security evidence so a soak run never erases
	// S01-S17 results.
	if raw, err := evsum.ReadRawLatest(r.root, "g4"); err == nil {
		var prev evidence
		if json.Unmarshal(raw, &prev) == nil && len(prev.Scenarios) > 0 {
			r.ev.Scenarios = prev.Scenarios[:0]
			for _, sc := range prev.Scenarios {
				if sc.ID != "S18" {
					r.ev.Scenarios = append(r.ev.Scenarios, sc)
				}
			}
		}
	}
	se := &soakEvidence{
		StartedAt:      time.Now().UTC().Format(time.RFC3339),
		DurationTarget: r.soakDur.String(),
		Topology:       "G3 dualnat lab: A/B behind strict NAT, QUIC DCUtR direct, relays R1/R2 kept up",
		Status:         "FAIL",
	}
	finish := func() int {
		se.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		r.ev.Soak = se
		r.ev.Scenarios = append(r.ev.Scenarios, &scenarioEvidence{
			ID: "S18", Name: "dualnat-quic-soak", Status: se.Status,
			Checks: se.Checks, Error: se.Error, DurationMS: int64(r.soakDur / time.Millisecond),
			Commands: se.Commands,
		})
		r.ev.Overall = se.Status
		if err := r.writeSoakEvidence(se); err != nil {
			fmt.Fprintf(os.Stderr, "g4: write soak evidence: %v\n", err)
		}
		printSummary(r.ev.Scenarios)
		if se.Status == "PASS" {
			return 0
		}
		return 1
	}

	if !r.soakSkipUp {
		_, _ = fmt.Fprintf(os.Stdout, "g4 soak: starting g3 dualnat lab (%s)\n", r.soakDur)
		out, code := r.recordCommand("host", "go", "run", "./tests/e2e/g3", "-lab", "dualnat", "-up", "-rebuild")
		if code != 0 {
			se.Status = "BLOCKED"
			se.Error = "g3 dualnat lab start failed: " + out
			return finish()
		}
		defer func() {
			if !r.keep {
				_, _ = r.recordCommand("host", "go", "run", "./tests/e2e/g3", "-lab", "dualnat", "-down")
			}
		}()
	} else {
		_, _ = fmt.Fprintln(os.Stdout, "g4 soak: reusing already-running g3 dualnat lab")
	}

	if err := r.waitReadySoak("a-quic", 120*time.Second); err != nil {
		se.Status = "BLOCKED"
		se.Error = err.Error()
		return finish()
	}
	if err := r.waitReadySoak("b-quic", 120*time.Second); err != nil {
		se.Status = "BLOCKED"
		se.Error = err.Error()
		return finish()
	}
	aID, bID := r.ids["a-quic"], r.ids["b-quic"]
	if err := r.waitReadySoak("r1", 180*time.Second); err != nil {
		se.Status = "BLOCKED"
		se.Error = err.Error()
		return finish()
	}
	relayAddr, err := r.waitRelayAddrSoak("b-quic", r.ids["r1"], 120*time.Second)
	if err != nil {
		se.Status = "BLOCKED"
		se.Error = err.Error()
		return finish()
	}
	if out, code := r.soakExec("a-quic", "raminga", "connect", "--data-dir", "/data", relayAddr); code != 0 {
		se.Status = "BLOCKED"
		se.Error = "relay connect failed: " + out
		return finish()
	}
	directDeadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(directDeadline) {
		sa, err := r.soakStatus("a-quic")
		if err == nil {
			if ok, _, _ := directTo(sa, bID); ok {
				break
			}
		}
		time.Sleep(3 * time.Second)
	}
	sa, err := r.soakStatus("a-quic")
	if err != nil {
		se.Status = "BLOCKED"
		se.Error = "status before soak: " + err.Error()
		return finish()
	}
	if ok, route, transport := directTo(sa, bID); !ok {
		se.Status = "FAIL"
		se.Error = fmt.Sprintf("no direct QUIC connection before soak (route=%s transport=%s)", route, transport)
		se.Checks = append(se.Checks, check{Name: "direct QUIC before soak", Pass: false, Detail: se.Error})
		return finish()
	}
	se.Checks = append(se.Checks, check{Name: "direct QUIC before soak", Pass: true, Detail: "a-quic reports direct QUIC to b-quic"})

	start := time.Now()
	sampleEvery := 30 * time.Second
	deadline := start.Add(r.soakDur)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	sampleTicker := time.NewTicker(sampleEvery)
	defer sampleTicker.Stop()
	var latencies []int64
	iteration := 0
	warmup := start.Add(2 * time.Minute)
	var lastSample soakSample
	sample := func() {
		sa, err := r.soakStatus("a-quic")
		if err != nil {
			return
		}
		smp := soakSample{
			At: time.Now().UTC().Format(time.RFC3339), RSSBytes: r.soakRSS("a-quic"),
			FD: r.soakFD("a-quic"), Goroutines: int(sa.GetNetwork().GetResources().GetGoroutines()),
			Conns: int(sa.GetNetwork().GetResources().GetOpenConnections()),
		}
		smp.Direct, smp.Route, smp.Transport = directTo(sa, bID)
		se.Samples = append(se.Samples, smp)
		lastSample = smp
		if smp.Direct {
			se.DirectSamples++
		}
		se.TotalSamples++
	}
	sample()
	for {
		select {
		case <-ticker.C:
			if time.Now().After(deadline) {
				goto done
			}
			iteration++
			msgA := fmt.Sprintf("g4-soak-a-%05d", iteration)
			t0 := time.Now()
			resA, errA := r.soakChat("a-quic", bID, msgA)
			latA := time.Since(t0).Milliseconds()
			se.Sent++
			if errA == nil && resA.GetAcked() {
				se.Acked++
				latencies = append(latencies, latA)
			} else {
				if time.Now().After(warmup) {
					se.Failed++
				} else {
					se.WarmupFailures++
				}
			}
			msgB := fmt.Sprintf("g4-soak-b-%05d", iteration)
			t1 := time.Now()
			resB, errB := r.soakChat("b-quic", aID, msgB)
			latB := time.Since(t1).Milliseconds()
			se.Sent++
			if errB == nil && resB.GetAcked() {
				se.Acked++
				latencies = append(latencies, latB)
			} else {
				if time.Now().After(warmup) {
					se.Failed++
				} else {
					se.WarmupFailures++
				}
			}
			fmt.Printf("g4 soak: iteration=%d a=%t/%dms b=%t/%dms\n", iteration, resA.GetAcked(), latA, resB.GetAcked(), latB)
		case <-sampleTicker.C:
			sample()
			fmt.Printf("g4 soak: sample rss=%d fd=%d goroutines=%d direct=%t\n",
				lastSample.RSSBytes, lastSample.FD, lastSample.Goroutines, lastSample.Direct)
		}
	}
done:
	se.DurationActual = time.Since(start).Round(time.Second).String()
	sample()
	if len(se.Samples) > 0 {
		first := se.Samples[0]
		se.RSSStartBytes, se.FDStart, se.GoStart = first.RSSBytes, first.FD, first.Goroutines
		last := se.Samples[len(se.Samples)-1]
		se.RSSLastBytes, se.FDLast, se.GoLast = last.RSSBytes, last.FD, last.Goroutines
		se.RSSGrowthBytes = last.RSSBytes - first.RSSBytes
		minRSS, maxRSS := last.RSSBytes, last.RSSBytes
		minFD, maxFD := last.FD, last.FD
		minGo, maxGo := last.Goroutines, last.Goroutines
		tail := se.Samples
		if len(tail) > 10 {
			tail = tail[len(tail)-10:]
		}
		for _, s := range tail {
			if s.RSSBytes < minRSS {
				minRSS = s.RSSBytes
			}
			if s.RSSBytes > maxRSS {
				maxRSS = s.RSSBytes
			}
			if s.FD < minFD {
				minFD = s.FD
			}
			if s.FD > maxFD {
				maxFD = s.FD
			}
			if s.Goroutines < minGo {
				minGo = s.Goroutines
			}
			if s.Goroutines > maxGo {
				maxGo = s.Goroutines
			}
		}
		se.RSSDriftBytes = maxRSS - minRSS
		se.FDDrift = maxFD - minFD
		se.GoDrift = maxGo - minGo
	}
	if se.TotalSamples > 0 {
		se.DirectRatio = float64(se.DirectSamples) / float64(se.TotalSamples)
	}
	if len(latencies) > 0 {
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		idx := int(float64(len(latencies)) * 0.95)
		if idx >= len(latencies) {
			idx = len(latencies) - 1
		}
		se.P95ACKMS = latencies[idx]
		se.MaxACKMS = latencies[len(latencies)-1]
	}

	c := &checker{r: r}
	// Use a temporary scenario entry so the shared checker records here.
	temp := &scenarioEvidence{ID: "S18", Name: "dualnat-quic-soak", Status: "PASS"}
	r.ev.Scenarios = append(r.ev.Scenarios, temp)
	c.check("soak ran for the requested duration", se.DurationActual == "" || parseDuration(se.DurationActual) >= r.soakDur-30*time.Second, se.DurationActual)
	c.check("direct QUIC held >=95% of samples", se.DirectRatio >= 0.95, fmt.Sprintf("%.3f (%d/%d)", se.DirectRatio, se.DirectSamples, se.TotalSamples))
	c.check("ACK p95 <=5s", se.P95ACKMS <= 5000, fmt.Sprintf("p95=%dms max=%dms", se.P95ACKMS, se.MaxACKMS))
	c.check("ACK max <=15s", se.MaxACKMS <= 15000, fmt.Sprintf("max=%dms", se.MaxACKMS))
	c.check("zero failed ACKs after 2-minute warm-up", se.Failed == 0, fmt.Sprintf("failed=%d warmup=%d", se.Failed, se.WarmupFailures))
	rssLimit := int64(64 << 20)
	if se.RSSStartBytes > 0 && se.RSSStartBytes/5 > rssLimit {
		rssLimit = se.RSSStartBytes / 5
	}
	c.check("RSS growth <= max(64MiB,20%)", se.RSSLastBytes-se.RSSStartBytes <= rssLimit,
		fmt.Sprintf("%d->%d limit=%d", se.RSSStartBytes, se.RSSLastBytes, rssLimit))
	c.check("FD growth <=16", se.FDLast-se.FDStart <= 16, fmt.Sprintf("%d->%d", se.FDStart, se.FDLast))
	c.check("goroutine growth <=64", se.GoLast-se.GoStart <= 64, fmt.Sprintf("%d->%d", se.GoStart, se.GoLast))
	c.check("last-10 RSS drift <=8MiB", se.RSSDriftBytes <= 8<<20, fmt.Sprintf("%d", se.RSSDriftBytes))
	c.check("last-10 FD drift <=8", se.FDDrift <= 8, fmt.Sprintf("%d", se.FDDrift))
	c.check("last-10 goroutine drift <=16", se.GoDrift <= 16, fmt.Sprintf("%d", se.GoDrift))
	minSent := int(r.soakDur/(5*time.Second)) * 2 * 80 / 100
	c.check("bidirectional traffic actually ran", se.Sent >= minSent && se.Acked >= minSent,
		fmt.Sprintf("sent=%d acked=%d min=%d", se.Sent, se.Acked, minSent))

	se.Checks = temp.Checks
	r.ev.Scenarios = r.ev.Scenarios[:len(r.ev.Scenarios)-1]
	if c.failed {
		se.Status = "FAIL"
		se.Error = "one or more soak thresholds failed"
	} else {
		se.Status = "PASS"
	}
	return finish()
}

func (r *runner) waitRelayAddrSoak(service, relayID string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		st, err := r.soakStatus(service)
		if err == nil {
			for _, rr := range st.GetNetwork().GetRelays() {
				if rr.GetRelayPeerId() == relayID && rr.GetReservationStatus() == "active" && rr.GetRelayedAddr() != "" {
					return rr.GetRelayedAddr(), nil
				}
				last = fmt.Sprintf("relay=%s status=%s reservation=%s error=%s",
					rr.GetRelayPeerId(), rr.GetStatus(), rr.GetReservationStatus(), rr.GetLastError())
			}
		}
		time.Sleep(2 * time.Second)
	}
	return "", fmt.Errorf("%s has no active R1 reservation within %s: %s", service, timeout, last)
}

func (r *runner) waitReadySoak(service string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		st, err := r.soakStatus(service)
		if err == nil && st.GetPeerId() != "" {
			r.ids[service] = st.GetPeerId()
			return nil
		}
		last = err
		time.Sleep(time.Second)
	}
	return fmt.Errorf("%s not ready within %s: %v", service, timeout, last)
}

func (r *runner) soakChat(service, peerID, text string) (*apiv1.SendChatResponse, error) {
	out, code := r.soakExec(service, "raminga", "chat", "send", "--data-dir", "/data", "--to", peerID, "--text", text, "--json")
	var res apiv1.SendChatResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("chat %s exit=%d: %s", service, code, out)
	}
	return &res, nil
}

func parseDuration(s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return d
}

func (r *runner) writeSoakEvidence(se *soakEvidence) error {
	raw, err := json.MarshalIndent(se, "", "  ")
	if err != nil {
		return err
	}
	dir := evsum.RawDir(r.root, "g4")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "soak-latest.json"), raw, 0o644); err != nil {
		return err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	return os.WriteFile(filepath.Join(dir, "soak-"+stamp+".json"), raw, 0o644)
}

var _ = exec.Command
