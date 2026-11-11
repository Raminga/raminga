// Command g4 runs the G4 security and stability acceptance suite.
//
// It builds a test-only attacker alongside the normal daemon, drives both over
// the real libp2p wire and the local UDS API, and records PASS/FAIL/BLOCKED/
// NOT_TESTED/NOT_IMPLEMENTED with the pre-defined thresholds in
// docs/testing.md.
//
// Docker is a simulation, not public-network security evidence.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	evsum "github.com/Raminga/raminga/tests/e2e/internal/evidence"
)

const (
	imageName    = "raminga-g4-e2e:local"
	composeRel   = "tests/e2e/g4/docker-compose.yml"
	evidenceNote = "Docker simulation only; not public-network M6 or production security. The attacker is test-only. No private keys or bearer tokens are included; 64-hex token-shaped strings are redacted."
)

type evidence struct {
	GeneratedAt    string              `json:"generated_at"`
	Branch         string              `json:"branch"`
	Commit         string              `json:"commit"`
	GoVersion      string              `json:"go_version"`
	DockerVersion  string              `json:"docker_version"`
	ComposeVersion string              `json:"compose_version"`
	ModuleVersions []string            `json:"module_versions"`
	Image          string              `json:"image"`
	ImageBuild     string              `json:"image_build"`
	System         string              `json:"system"`
	Thresholds     string              `json:"thresholds_doc"`
	Scenarios      []*scenarioEvidence `json:"scenarios"`
	Soak           *soakEvidence       `json:"soak,omitempty"`
	Overall        string              `json:"overall"`
	Note           string              `json:"note"`
}

type scenarioEvidence struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Accepted   bool            `json:"accepted"`
	Checks     []check         `json:"checks"`
	Commands   []commandRecord `json:"commands,omitempty"`
	Error      string          `json:"error,omitempty"`
	DurationMS int64           `json:"duration_ms"`
}

type check struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail"`
}

type commandRecord struct {
	At     string   `json:"at"`
	Where  string   `json:"where"`
	Args   []string `json:"args"`
	Code   int      `json:"exit_code"`
	Output string   `json:"output,omitempty"`
}

type runner struct {
	root        string
	evidenceDir string
	configDir   string
	project     string
	keep        bool
	skipBuild   bool
	only        map[string]bool
	soak        bool
	soakDur     time.Duration
	soakSkipUp  bool
	ids         map[string]string
	redact      *regexp.Regexp
	ev          evidence
	mu          sync.Mutex
}

func main() { os.Exit(run()) }

func run() int {
	var (
		evidenceDir = flag.String("evidence", "tests/e2e/evidence/g4", "evidence output directory")
		prefix      = flag.String("project", "raminga-g4-e2e", "compose project prefix")
		keep        = flag.Bool("keep", false, "keep compose containers/volumes")
		skipBuild   = flag.Bool("skip-build", false, "reuse the already-built image")
		only        = flag.String("only", "", "comma-separated scenario IDs (S01,S04,...)")
		soak        = flag.Bool("soak", false, "run only the dual-NAT QUIC soak")
		soakDur     = flag.Duration("soak-duration", 30*time.Minute, "soak duration")
		soakSkipUp  = flag.Bool("soak-skip-up", false, "reuse an already-running g3 lab dualnat")
		mergeSoak   = flag.Bool("merge-soak", false, "merge soak-latest.json into latest.json without rerunning scenarios")
		mergeTools  = flag.Bool("merge-tools", false, "merge fuzz/vuln/licenses evidence into latest.json")
	)
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "g4: getwd: %v\n", err)
		return 1
	}
	r := &runner{
		root:        root,
		evidenceDir: filepath.Join(root, *evidenceDir),
		configDir:   filepath.Join(root, ".local", "g4-configs"),
		project:     *prefix,
		keep:        *keep,
		skipBuild:   *skipBuild,
		only:        parseList(*only),
		soak:        *soak,
		soakDur:     *soakDur,
		soakSkipUp:  *soakSkipUp,
		ids:         make(map[string]string),
		redact:      regexp.MustCompile(`[0-9a-f]{64}`),
		ev: evidence{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Image:       imageName,
			Note:        evidenceNote,
			Thresholds:  "docs/testing.md",
		},
	}
	r.collectEnvironment()
	if *mergeSoak {
		return r.mergeSoakEvidence()
	}
	if *mergeTools {
		return r.mergeToolEvidence()
	}
	if err := os.MkdirAll(r.evidenceDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "g4: create evidence dir: %v\n", err)
		return 1
	}
	if r.soak {
		return r.runSoak()
	}
	code := r.runSecurity()
	if code == 0 && os.Getenv("G4_SOAK") == "1" {
		return r.runSoak()
	}
	return code
}

func (r *runner) mergeToolEvidence() int {
	raw, err := evsum.ReadRawLatest(r.root, "g4")
	if err != nil {
		fmt.Fprintf(os.Stderr, "g4: read latest evidence: %v\n", err)
		return 1
	}
	var prev evidence
	if err := json.Unmarshal(raw, &prev); err != nil {
		fmt.Fprintf(os.Stderr, "g4: parse latest evidence: %v\n", err)
		return 1
	}
	r.ev = prev
	r.ev.Scenarios = r.ev.Scenarios[:0]
	for _, sc := range prev.Scenarios {
		if sc.ID != "S19" && sc.ID != "S20" {
			r.ev.Scenarios = append(r.ev.Scenarios, sc)
		}
	}
	r.addFuzzResult()
	r.addSupplyChainResult()
	r.ev.Overall = overall(r.ev.Scenarios)
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g4: write merged evidence: %v\n", err)
		return 1
	}
	printSummary(r.ev.Scenarios)
	return 0
}

func (r *runner) mergeSoakEvidence() int {
	raw, err := evsum.ReadRawLatest(r.root, "g4")
	if err != nil {
		fmt.Fprintf(os.Stderr, "g4: read latest evidence: %v\n", err)
		return 1
	}
	var prev evidence
	if err := json.Unmarshal(raw, &prev); err != nil {
		fmt.Fprintf(os.Stderr, "g4: parse latest evidence: %v\n", err)
		return 1
	}
	r.ev = prev
	r.ev.Scenarios = r.ev.Scenarios[:0]
	for _, sc := range prev.Scenarios {
		if sc.ID != "S18" {
			r.ev.Scenarios = append(r.ev.Scenarios, sc)
		}
	}
	if !r.addSoakFromEvidence() {
		fmt.Fprintln(os.Stderr, "g4: soak-latest.json is not a completed 30-minute PASS")
		return 1
	}
	r.ev.Overall = overall(r.ev.Scenarios)
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g4: write merged evidence: %v\n", err)
		return 1
	}
	printSummary(r.ev.Scenarios)
	return 0
}

func (r *runner) runSecurity() int {
	if !r.skipBuild {
		if err := r.buildImage(); err != nil {
			r.ev.Overall = "FAIL"
			fmt.Fprintf(os.Stderr, "g4: %v\n", err)
			_ = r.writeEvidence()
			return 1
		}
	}
	if err := r.setup(); err != nil {
		r.ev.Overall = "FAIL"
		fmt.Fprintf(os.Stderr, "g4: setup: %v\n", err)
		_ = r.writeEvidence()
		if !r.keep {
			r.teardown()
		}
		return 1
	}
	defer func() {
		if !r.keep {
			r.teardown()
		}
	}()

	scenarios := []struct {
		id   string
		name string
		fn   func() (string, error)
	}{
		{"S01", "identity-spoof-mismatch", r.scenarioSpoof},
		{"S02", "unknown-peer-policy", r.scenarioUnknownPolicy},
		{"S03", "node-id-peer-id-binding", r.scenarioNodeBinding},
		{"S04", "malformed-input-matrix", r.scenarioMalformed},
		{"S05", "oversize-frame", r.scenarioOversize},
		{"S06", "duplicate-message-ids", r.scenarioDuplicates},
		{"S07", "forged-ack", r.scenarioForgedAck},
		{"S08", "slowloris-streams", r.scenarioSlowloris},
		{"S09", "single-peer-flood", r.scenarioFlood},
		{"S10", "many-peer-flood", r.scenarioManyPeers},
		{"S11", "relay-reservation-flood", r.scenarioRelayFlood},
		{"S12", "disk-growth-bound", r.scenarioDiskGrowth},
		{"S13", "api-isolation", r.scenarioAPI},
		{"S14", "control-chars-log-redaction", r.scenarioLogs},
		{"S15", "kill9-crash-recovery", r.scenarioCrash},
		{"S16", "sqlite-busy-locked", r.scenarioBusy},
		{"S17", "network-flap-recovery", r.scenarioFlap},
		{"S21", "durable-outbox-unit", r.scenarioOutboxUnit},
		{"S22", "outbox-down-up", r.scenarioOutboxDownUp},
		{"S23", "outbox-expiry", r.scenarioOutboxExpiry},
	}
	for _, sc := range scenarios {
		if len(r.only) > 0 && !r.only[sc.id] {
			continue
		}
		r.runScenario(sc.id, sc.name, sc.fn)
	}
	r.runQUICScenarios()
	if len(r.only) == 0 {
		if !r.addSoakFromEvidence() {
			r.addStaticNotTested("S18", "dualnat-quic-soak", "Run with G4_SOAK=1 or make soak; the 30-minute soak uses the G3 dual-NAT lab.")
		}
		r.addFuzzResult()
		r.addSupplyChainResult()
		// S24–S26 are added by the QUIC stability runner.
	}
	r.ev.Overall = overall(r.ev.Scenarios)
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g4: write evidence: %v\n", err)
		return 1
	}
	printSummary(r.ev.Scenarios)
	if r.ev.Overall != "PASS" {
		return 1
	}
	return 0
}

// addSoakFromEvidence reuses a real, completed 30-minute soak if soak-latest.json
// exists. A short run is never accepted as the 30-minute acceptance soak.
func (r *runner) addSoakFromEvidence() bool {
	raw, err := os.ReadFile(filepath.Join(evsum.RawDir(r.root, "g4"), "soak-latest.json"))
	if err != nil {
		return false
	}
	var se soakEvidence
	if err := json.Unmarshal(raw, &se); err != nil || se.Status != "PASS" || parseDuration(se.DurationActual) < 29*time.Minute {
		return false
	}
	sc := &scenarioEvidence{
		ID: "S18", Name: "dualnat-quic-soak", Status: "PASS", Accepted: true,
		Checks: se.Checks, DurationMS: int64(parseDuration(se.DurationActual) / time.Millisecond),
	}
	sc.Checks = append(sc.Checks, check{Name: "soak evidence", Pass: true,
		Detail: fmt.Sprintf("started=%s finished=%s actual=%s file=soak-latest.json", se.StartedAt, se.FinishedAt, se.DurationActual)})
	r.ev.Scenarios = append(r.ev.Scenarios, sc)
	return true
}

func (r *runner) addFuzzResult() {
	sc := &scenarioEvidence{ID: "S19", Name: "native-fuzzing", Status: "NOT_TESTED"}
	raw, err := os.ReadFile(filepath.Join(r.evidenceDir, "fuzz.txt"))
	if err != nil || !strings.Contains(string(raw), "FUZZ_ALL_PASS") {
		sc.Checks = []check{{Name: "bounded native fuzzing", Pass: false, Detail: "fuzz.txt missing or incomplete; run make fuzz"}}
	} else {
		sc.Status = "PASS"
		sc.Checks = []check{{Name: "bounded native fuzzing", Pass: true, Detail: strings.TrimSpace(string(raw))}}
	}
	r.ev.Scenarios = append(r.ev.Scenarios, sc)
}

func (r *runner) addSupplyChainResult() {
	sc := &scenarioEvidence{ID: "S20", Name: "supply-chain", Status: "NOT_TESTED"}
	vuln, errV := os.ReadFile(filepath.Join(r.evidenceDir, "vuln.txt"))
	lic, errL := os.ReadFile(filepath.Join(r.evidenceDir, "licenses-shipped.txt"))
	disp, _ := os.ReadFile(filepath.Join(r.root, "docs", "supply-chain", "vuln-disposition.md"))
	vulnOK := errV == nil && (strings.Contains(string(vuln), "No vulnerabilities found") ||
		strings.Contains(string(vuln), "0 vulnerabilities") ||
		(strings.Contains(string(vuln), "GO-2024-3218") && strings.Contains(string(disp), "GO-2024-3218") &&
			strings.Contains(strings.ToLower(string(disp)), "accepted")))
	licOK := errL == nil && len(strings.TrimSpace(string(lic))) > 0 &&
		!containsAny(strings.ToLower(string(lic)), "gpl-3", "gplv3", "agpl", "sspl")
	if vulnOK && licOK {
		sc.Status = "PASS"
	}
	sc.Checks = []check{
		{Name: "govulncheck no unaddressed reachable vulnerabilities", Pass: vulnOK, Detail: strings.TrimSpace(lastLines(string(vuln), 3))},
		{Name: "go-licenses shipped set permissive", Pass: licOK, Detail: fmt.Sprintf("report bytes=%d", len(lic))},
	}
	r.ev.Scenarios = append(r.ev.Scenarios, sc)
}

func lastLines(raw string, n int) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

func (r *runner) addStaticNotTested(id, name, detail string) {
	r.ev.Scenarios = append(r.ev.Scenarios, &scenarioEvidence{
		ID: id, Name: name, Status: "NOT_TESTED",
		Checks: []check{{Name: name, Pass: false, Detail: detail}},
	})
}

func (r *runner) runScenario(id, name string, fn func() (string, error)) {
	fmt.Printf("\n=== %s %s ===\n", id, name)
	sc := &scenarioEvidence{ID: id, Name: name, Status: "PASS"}
	r.mu.Lock()
	r.ev.Scenarios = append(r.ev.Scenarios, sc)
	r.mu.Unlock()
	start := time.Now()
	detail, err := fn()
	sc.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		if errors.Is(err, errNotImplemented) {
			sc.Status = "NOT_IMPLEMENTED"
		} else if errors.Is(err, errBlocked) {
			sc.Status = "BLOCKED"
		} else {
			sc.Status = "FAIL"
		}
		sc.Error = r.redactText(err.Error())
	}
	if detail != "" {
		sc.Checks = append(sc.Checks, check{Name: "scenario", Pass: err == nil, Detail: detail})
	}
	fmt.Printf("%s: %s (%.1fs) %s\n", id, sc.Status, float64(sc.DurationMS)/1000, sc.Error)
}

var (
	errNotImplemented = errors.New("not implemented")
	errBlocked        = errors.New("blocked")
)

func overall(scenarios []*scenarioEvidence) string {
	failed := false
	for _, sc := range scenarios {
		if sc.Status == "FAIL" {
			failed = true
		}
	}
	if failed {
		return "FAIL"
	}
	return "PASS"
}

func printSummary(scenarios []*scenarioEvidence) {
	fmt.Printf("\n== G4 summary ==\n")
	for _, sc := range scenarios {
		fmt.Printf("%-3s %-11s %s\n", sc.ID, sc.Status, sc.Name)
	}
}

func (r *runner) collectEnvironment() {
	r.ev.Branch = r.hostOutput("git", "rev-parse", "--abbrev-ref", "HEAD")
	r.ev.Commit = r.hostOutput("git", "rev-parse", "--short", "HEAD")
	r.ev.GoVersion = r.hostOutput("go", "version")
	r.ev.DockerVersion = r.hostOutput("docker", "version", "--format", "{{.Server.Version}}")
	r.ev.ComposeVersion = r.hostOutput("docker", "compose", "version", "--short")
	r.ev.System = r.hostOutput("sh", "-c", "uname -s && uname -m")
	out := r.hostOutput("go", "list", "-m", "-f", "{{.Path}} {{.Version}}",
		"github.com/libp2p/go-libp2p",
		"github.com/libp2p/go-libp2p-kad-dht",
		"github.com/ipfs/go-datastore",
		"modernc.org/sqlite",
		"connectrpc.com/connect")
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) != "" {
			r.ev.ModuleVersions = append(r.ev.ModuleVersions, strings.TrimSpace(line))
		}
	}
}

func (r *runner) buildImage() error {
	var last string
	for attempt := 1; attempt <= 2; attempt++ {
		out, code := r.recordCommand("host", "docker", "build", "--progress=plain", "-t", imageName, "-f", "tests/e2e/g4/Dockerfile", ".")
		if code == 0 {
			r.ev.ImageBuild = "built from tests/e2e/g4/Dockerfile"
			return nil
		}
		last = out
		time.Sleep(2 * time.Second)
	}
	id := r.hostOutput("docker", "image", "inspect", "-f", "{{.Id}}", imageName)
	if strings.TrimSpace(id) != "" && !strings.Contains(id, "(") {
		r.ev.ImageBuild = "build failed; reused existing local image " + strings.TrimSpace(id) + ": " + r.redactText(last)
		fmt.Fprintf(os.Stderr, "g4: docker build failed; reusing existing %s image\n", imageName)
		return nil
	}
	return fmt.Errorf("docker build failed and no local image is available: %s", last)
}

func (r *runner) composeEnv() []string {
	return append(os.Environ(), "G4_CONFIG_DIR="+r.configDir)
}

func (r *runner) compose(args ...string) (string, int) {
	full := append([]string{"compose", "-p", r.project, "-f", composeRel}, args...)
	return r.command("host", r.composeEnv(), "docker", full...)
}

// composeRaw returns unredacted stdout for container IDs (never logged).
func (r *runner) composeRaw(args ...string) string {
	full := append([]string{"compose", "-p", r.project, "-f", composeRel}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", full...)
	cmd.Dir = r.root
	cmd.Env = r.composeEnv()
	out, _ := cmd.Output()
	return strings.TrimSpace(string(out))
}

func (r *runner) exec(service string, args ...string) (string, int) {
	full := append([]string{"compose", "-p", r.project, "-f", composeRel, "exec", "-T", service}, args...)
	return r.command(service, r.composeEnv(), "docker", full...)
}

func (r *runner) command(where string, env []string, name string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.root
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	text := r.redactText(string(out))
	r.recordCommandRaw(where, name, args, code, text)
	return text, code
}

func (r *runner) hostOutput(name string, args ...string) string {
	cmd := exec.Command(name, args...)
	cmd.Dir = r.root
	out, _ := cmd.CombinedOutput()
	return strings.TrimSpace(string(out))
}

func (r *runner) recordCommand(where, name string, args ...string) (string, int) {
	return r.command(where, os.Environ(), name, args...)
}

func (r *runner) recordCommandRaw(where, name string, args []string, code int, output string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(args) > 0 {
		redacted := append([]string(nil), args...)
		for i, a := range redacted {
			if len(a) > 500 {
				redacted[i] = a[:500] + "…"
			}
		}
		args = redacted
	}
	if len(output) > 4000 {
		output = output[len(output)-4000:]
	}
	rec := commandRecord{
		At: time.Now().UTC().Format(time.RFC3339), Where: where,
		Args: args, Code: code, Output: output,
	}
	if len(r.ev.Scenarios) == 0 {
		return
	}
	sc := r.ev.Scenarios[len(r.ev.Scenarios)-1]
	sc.Commands = append(sc.Commands, rec)
}

func (r *runner) redactText(s string) string {
	return r.redact.ReplaceAllString(s, "[redacted-64hex]")
}

func (r *runner) writeEvidence() error {
	data, err := json.MarshalIndent(r.ev, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := evsum.WriteRaw(r.root, "g4", data); err != nil {
		return err
	}
	summary, err := evsum.Summarize(data, "g4")
	if err != nil {
		return err
	}
	path, err := evsum.Write(r.evidenceDir, "g4", summary)
	if err != nil {
		return err
	}
	if err := evsum.WritePointer(r.evidenceDir, filepath.Base(path)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(os.Stdout, "g4: wrote summary %s\n", path)
	return nil
}

// setup builds the two-phase stack: friend/provider first, then configs that
// embed their Peer IDs (strict allow list, normal relay client).
func (r *runner) setup() error {
	if err := os.RemoveAll(r.configDir); err != nil {
		return err
	}
	if err := os.MkdirAll(r.configDir, 0o700); err != nil {
		return err
	}
	initial := r.initialConfigs()
	for name, cfg := range initial {
		if err := r.writeConfig(name, cfg); err != nil {
			return err
		}
	}
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "240",
		"friend", "victim-open", "crash", "busy", "disk", "late", "expiry", "flap-a", "flap-b",
		"relay-provider", "attacker", "badack"); code != 0 {
		return fmt.Errorf("compose up initial: %s", out)
	}
	services := []string{"friend", "victim-open", "crash", "busy", "disk", "late", "expiry", "flap-a", "flap-b", "relay-provider"}
	for _, svc := range services {
		if err := r.waitReady(svc, 120*time.Second); err != nil {
			return err
		}
	}
	if code := r.waitFile("badack", "/data/ready.json", 60*time.Second); code != nil {
		return code
	}
	friendID := r.ids["friend"]
	providerID := r.ids["relay-provider"]
	if friendID == "" || providerID == "" {
		return errors.New("friend/relay-provider Peer ID missing")
	}
	if err := r.writeConfig("victim-strict", r.strictConfig(friendID)); err != nil {
		return err
	}
	if err := r.writeConfig("relay-normal", r.relayNormalConfig(providerID)); err != nil {
		return err
	}
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "180", "victim-strict", "relay-normal"); code != 0 {
		return fmt.Errorf("compose up strict/relay-normal: %s", out)
	}
	for _, svc := range []string{"victim-strict", "relay-normal"} {
		if err := r.waitReady(svc, 120*time.Second); err != nil {
			return err
		}
	}
	return nil
}

func (r *runner) waitFile(service, path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, code := r.exec(service, "test", "-f", path); code == 0 {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("%s did not create %s within %s", service, path, timeout)
}

func (r *runner) waitReady(service string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		st, err := r.status(service)
		if err == nil && st.GetPeerId() != "" {
			r.ids[service] = st.GetPeerId()
			return nil
		}
		if err != nil {
			last = err.Error()
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("%s not ready within %s: %s", service, timeout, last)
}

func (r *runner) status(service string) (*apiv1.StatusResponse, error) {
	out, code := r.exec(service, "raminga", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("status %s: %s", service, strings.TrimSpace(out))
	}
	var st apiv1.StatusResponse
	if err := protojson.Unmarshal([]byte(out), &st); err != nil {
		return nil, fmt.Errorf("parse status %s: %w", service, err)
	}
	return &st, nil
}

func (r *runner) addr(service string) string {
	ip := map[string]string{
		"friend": "10.251.0.12", "victim-open": "10.251.0.10", "victim-strict": "10.251.0.11",
		"crash": "10.251.0.13", "busy": "10.251.0.14", "disk": "10.251.0.15",
		"late": "10.251.0.16", "expiry": "10.251.0.17",
		"attacker": "10.251.0.20", "badack": "10.251.0.21",
		"relay-provider": "10.251.0.30", "relay-normal": "10.251.0.31",
		"flap-a": "10.251.0.40", "flap-b": "10.251.0.41",
	}[service]
	if ip == "" {
		return ""
	}
	id := r.ids[service]
	if id == "" {
		if st, err := r.status(service); err == nil {
			id = st.GetPeerId()
			r.ids[service] = id
		}
	}
	return "/ip4/" + ip + "/tcp/4001/p2p/" + id
}

func (r *runner) teardown() {
	_, _ = r.compose("down", "-v", "--remove-orphans")
}

func parseList(raw string) map[string]bool {
	out := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out[strings.ToUpper(part)] = true
		}
	}
	return out
}

func mustAtoi(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	return n
}

func containsAny(s string, values ...string) bool {
	for _, v := range values {
		if strings.Contains(s, v) {
			return true
		}
	}
	return false
}

var _ = context.Background
