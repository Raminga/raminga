// Command g2 runs the G2 Docker acceptance scenarios. It drives only the
// shipped CLI/local API inside containers and writes honest PASS/FAIL/BLOCKED
// evidence. Docker is a simulation, not real-world M6 evidence.
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
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	evsum "github.com/Raminga/raminga/tests/e2e/internal/evidence"
)

const (
	composeRel   = "tests/e2e/g2/docker-compose.yml"
	projectName  = "raminga-g2-e2e"
	imageName    = "raminga-g2-e2e:local"
	evidenceNote = "Docker simulation only; not public-network M6. No private keys or bearer tokens are included. Tokens are read inside containers and never written to evidence; 64-hex token-shaped strings are redacted."
)

var serviceIPs = map[string]string{
	"r1": "11.40.0.2", "r2": "11.40.0.3", "r-off": "11.40.0.5", "dht-boot": "11.40.0.6",
	"r-quota": "11.40.0.7", "nat-a": "11.40.0.10", "nat-b": "11.40.0.11",
	"pub": "11.40.0.20", "dht-a": "11.40.0.21", "dht-b": "11.40.0.22", "dht-c": "11.40.0.23",
	"a-quic": "10.241.1.11", "b-quic": "10.241.2.11", "a-tcp": "10.241.1.10", "b-tcp": "10.241.2.10",
	"a-relay": "10.241.1.12", "b-relay": "10.241.2.12", "quota-a1": "10.241.1.30",
	"quota-a2": "10.241.1.31", "off-peer": "10.241.1.32", "a-one": "10.241.1.13", "b-one": "10.241.2.13",
}

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
	ComposeFile    string              `json:"compose_file"`
	Topology       map[string]string   `json:"topology"`
	Scenarios      []*scenarioEvidence `json:"scenarios"`
	Overall        string              `json:"overall"`
	Note           string              `json:"note"`
}

type scenarioEvidence struct {
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Accepted bool            `json:"accepted"`
	Checks   []check         `json:"checks"`
	Commands []commandRecord `json:"commands,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type check struct {
	Name    string `json:"name"`
	Pass    bool   `json:"pass"`
	Blocked bool   `json:"blocked,omitempty"`
	Detail  string `json:"detail"`
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
	reuseImage  bool
	composeFile string
	project     string
	configDir   string
	evidenceDir string
	keep        bool
	ev          evidence
	current     *scenarioEvidence
	hexToken    *regexp.Regexp
	ids         map[string]string
}

func main() { os.Exit(run()) }

func run() int {
	var (
		project     = flag.String("project", projectName, "compose project name")
		evidenceDir = flag.String("evidence", "tests/e2e/evidence/g2", "evidence output directory")
		keep        = flag.Bool("keep", false, "keep compose containers/volumes")
		skipSetup   = flag.Bool("skip-setup", false, "reuse an already-running topology")
		reuseImage  = flag.Bool("reuse-image", false, "allow reusing the existing image when docker build fails")
		only        = flag.String("only", "", "comma-separated scenario names (debug)")
	)
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "g2: getwd: %v\n", err)
		return 1
	}
	r := &runner{
		root:        root,
		composeFile: filepath.Join(root, composeRel),
		project:     *project,
		configDir:   filepath.Join(root, ".local", "g2-configs"),
		evidenceDir: filepath.Join(root, *evidenceDir),
		keep:        *keep,
		reuseImage:  *reuseImage,
		hexToken:    regexp.MustCompile(`[0-9a-f]{64}`),
		ids:         make(map[string]string),
		ev: evidence{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Image:       imageName,
			ImageBuild:  "not-built",
			ComposeFile: composeRel,
			Topology: map[string]string{
				"wan":                     "11.40.0.0/24 Docker bridge (not the public internet)",
				"lanA":                    "10.241.1.0/24",
				"lanB":                    "10.241.2.0/24",
				"natA":                    "11.40.0.10 / 10.241.1.2 strict conntrack NAT",
				"natB":                    "11.40.0.11 / 10.241.2.2 strict conntrack NAT",
				"relays":                  "R1 11.40.0.2, R2 11.40.0.3; R-off 11.40.0.5 provider off; R-quota 11.40.0.7 provider quotas",
				"sharedManagementNetwork": "false",
				"publishedHostPorts":      "false",
				"dockerIsNotRealNAT":      "true",
			},
			Note: evidenceNote,
		},
	}
	r.collectEnvironment()

	if !*skipSetup {
		if err := r.setup(); err != nil {
			r.newScenario("setup")
			r.addCheck("compose build/up", false, err.Error())
			r.finishScenario("FAIL", err)
			_ = r.writeEvidence()
			if !r.keep {
				r.cleanup()
			}
			fmt.Fprintf(os.Stderr, "g2: setup failed: %v\n", err)
			return 1
		}
	} else {
		r.ev.ImageBuild = "reused-existing-topology"
		for service := range serviceIPs {
			if st, err := r.status(service); err == nil {
				r.ids[service] = st.GetPeerId()
			}
		}
	}

	type sc struct {
		name         string
		allowBlocked bool
		fn           func() (string, error)
	}
	scenarios := []sc{
		{"dual-nat-quic-direct", false, r.scenarioQUIC},
		{"dual-nat-tcp", true, r.scenarioTCP},
		{"relay-failover", false, r.scenarioRelayFailover},
		{"dht-discovery", false, r.scenarioDHT},
		{"relay-provider-quota", false, r.scenarioProvider},
		{"one-sided-reachability", false, r.scenarioOneSided},
		{"peerstore-restart", false, r.scenarioPeerStore},
		{"peer-persistence", true, r.scenarioPeerPersistence},
		{"content-flow", true, r.scenarioContentFlow},
	}
	failed := false
	onlySet := parseOnly(*only)
	for _, item := range scenarios {
		if len(onlySet) > 0 && !onlySet[item.name] {
			continue
		}
		r.newScenario(item.name)
		status, err := item.fn()
		if err != nil {
			status = "FAIL"
		}
		r.finishScenario(status, err)
		current := r.ev.Scenarios[len(r.ev.Scenarios)-1]
		current.Accepted = current.Status == "PASS" || (item.allowBlocked && current.Status == "BLOCKED")
		if !current.Accepted {
			failed = true
		}
		_, _ = fmt.Fprintf(os.Stdout, "g2: scenario %s %s accepted=%t\n", item.name, current.Status, current.Accepted)
	}

	r.ev.Overall = "PASS"
	if failed {
		r.ev.Overall = "FAIL"
	}
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g2: write evidence: %v\n", err)
		failed = true
	}
	if !r.keep {
		r.cleanup()
	}
	_, _ = fmt.Fprintf(os.Stdout, "g2: overall %s (evidence: %s)\n", r.ev.Overall, r.evidenceDir)
	if failed || r.ev.Overall != "PASS" {
		return 1
	}
	return 0
}

func (r *runner) collectEnvironment() {
	r.ev.Branch = r.hostOutput("git", "rev-parse", "--abbrev-ref", "HEAD")
	r.ev.Commit = r.hostOutput("git", "rev-parse", "--short", "HEAD")
	r.ev.GoVersion = r.hostOutput("go", "version")
	r.ev.DockerVersion = r.hostOutput("docker", "version", "--format", "{{.Server.Version}}")
	r.ev.ComposeVersion = r.hostOutput("docker", "compose", "version", "--short")
	out := r.hostOutput("go", "list", "-m", "-f", "{{.Path}} {{.Version}}",
		"github.com/libp2p/go-libp2p",
		"github.com/libp2p/go-libp2p-kad-dht",
		"github.com/ipfs/go-datastore",
		"modernc.org/sqlite",
		"connectrpc.com/connect",
		"golang.org/x/time",
	)
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			r.ev.ModuleVersions = append(r.ev.ModuleVersions, strings.TrimSpace(line))
		}
	}
}

func (r *runner) hostOutput(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.root
	out, err := cmd.CombinedOutput()
	if err != nil {
		return strings.TrimSpace(string(out)) + " (" + err.Error() + ")"
	}
	return strings.TrimSpace(string(out))
}

func parseOnly(raw string) map[string]bool {
	out := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out[part] = true
		}
	}
	return out
}

func (r *runner) setup() error {
	if err := os.RemoveAll(r.configDir); err != nil {
		return err
	}
	if err := os.MkdirAll(r.configDir, 0o700); err != nil {
		return err
	}
	for service, cfg := range r.baseConfigs() {
		if err := r.writeConfig(service, cfg); err != nil {
			return err
		}
	}
	if out, code := r.compose("down", "-v", "--remove-orphans"); code != 0 {
		fmt.Fprintf(os.Stderr, "g2: compose down: %s\n", out)
	}
	if out, code := r.recordCommand("host", "docker", "build", "--progress=plain", "-t", imageName, "-f", "tests/e2e/Dockerfile", "."); code != 0 {
		if !r.reuseImage {
			r.ev.ImageBuild = "failed"
			return fmt.Errorf("docker build failed (rerun with -reuse-image only if you intentionally accept the existing image): %s", out)
		}
		id := r.hostOutput("docker", "image", "inspect", "-f", "{{.Id}}", imageName)
		if strings.TrimSpace(id) == "" || strings.Contains(id, "(") {
			r.ev.ImageBuild = "failed"
			return fmt.Errorf("docker build failed and -reuse-image found no existing %s: %s", imageName, out)
		}
		r.ev.ImageBuild = "reused " + strings.TrimSpace(id)
		_, _ = fmt.Fprintf(os.Stderr, "g2: docker build failed; -reuse-image explicitly reuses %s: %s\n", imageName, strings.TrimSpace(id))
	} else {
		r.ev.ImageBuild = "built"
	}
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "240", "r1", "r2", "r-off", "r-quota", "dht-boot"); code != 0 {
		return fmt.Errorf("compose up base: %s", out)
	}
	for _, service := range []string{"r1", "r2", "r-off", "r-quota", "dht-boot"} {
		st, err := r.waitReady(service, 90*time.Second)
		if err != nil {
			return err
		}
		r.ids[service] = st.GetPeerId()
	}
	for service, cfg := range r.peerConfigs() {
		if err := r.writeConfig(service, cfg); err != nil {
			return err
		}
	}
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "300"); code != 0 {
		return fmt.Errorf("compose up all: %s", out)
	}
	for service := range serviceIPs {
		if strings.HasPrefix(service, "nat-") {
			continue
		}
		st, err := r.waitReady(service, 120*time.Second)
		if err != nil {
			return err
		}
		r.ids[service] = st.GetPeerId()
	}
	return nil
}

func (r *runner) cleanup() {
	_, _ = r.compose("down", "-v", "--remove-orphans")
}

func (r *runner) compose(args ...string) (string, int) {
	full := append([]string{"compose", "-p", r.project, "-f", r.composeFile}, args...)
	return r.recordCommand("host", "docker", full...)
}

func (r *runner) exec(service string, args ...string) (string, int) {
	full := []string{"compose", "-p", r.project, "-f", r.composeFile, "exec", "-T", service}
	full = append(full, args...)
	return r.recordCommand(service, "docker", full...)
}

func (r *runner) quiet(service string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	full := []string{"compose", "-p", r.project, "-f", r.composeFile, "exec", "-T", service}
	full = append(full, args...)
	cmd := exec.CommandContext(ctx, "docker", full...)
	cmd.Dir = r.root
	cmd.Env = r.composeEnv()
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	return string(out), code
}

func (r *runner) recordCommand(where, name string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.root
	cmd.Env = r.composeEnv()
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = -1
			out = append(out, []byte("\n"+err.Error())...)
		}
	}
	s := r.redact(string(out))
	if len(s) > 12000 {
		s = s[:12000] + "\n...[truncated]"
	}
	if r.current != nil {
		r.current.Commands = append(r.current.Commands, commandRecord{
			At:     time.Now().UTC().Format(time.RFC3339),
			Where:  where,
			Args:   r.redactArgs(args),
			Code:   code,
			Output: s,
		})
	}
	return string(out), code
}

func (r *runner) composeEnv() []string {
	return append(os.Environ(), "G2_CONFIG_DIR="+r.configDir)
}

func (r *runner) redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = r.redact(a)
	}
	return out
}

func (r *runner) redact(s string) string { return r.hexToken.ReplaceAllString(s, "<redacted-64-hex>") }

func (r *runner) newScenario(name string) {
	r.ev.Scenarios = append(r.ev.Scenarios, &scenarioEvidence{Name: name})
	r.current = r.ev.Scenarios[len(r.ev.Scenarios)-1]
}

func (r *runner) addCheck(name string, pass bool, detail string) {
	if r.current == nil {
		return
	}
	r.current.Checks = append(r.current.Checks, check{Name: name, Pass: pass, Detail: r.redact(detail)})
}

func (r *runner) addBlockedCheck(name, detail string) {
	if r.current == nil {
		return
	}
	r.current.Checks = append(r.current.Checks, check{Name: name, Pass: false, Blocked: true, Detail: r.redact(detail)})
}

func (r *runner) require(name string, err error) bool {
	if err != nil {
		r.addCheck(name, false, err.Error())
		return false
	}
	r.addCheck(name, true, "ok")
	return true
}

func (r *runner) finishScenario(status string, err error) {
	if r.current == nil {
		return
	}
	realFail := false
	blocked := status == "BLOCKED"
	for _, c := range r.current.Checks {
		if c.Blocked {
			blocked = true
			continue
		}
		if !c.Pass {
			realFail = true
		}
	}
	if err != nil || realFail {
		r.current.Status = "FAIL"
	} else if blocked {
		r.current.Status = "BLOCKED"
	} else {
		r.current.Status = status
	}
	if err != nil {
		r.current.Error = r.redact(err.Error())
	}
	r.current = nil
}
func (r *runner) waitReady(service string, timeout time.Duration) (*apiv1.StatusResponse, error) {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		out, code := r.quiet(service, "raminga", "status", "--data-dir", "/data", "--json")
		if code == 0 {
			var st apiv1.StatusResponse
			if err := protojson.Unmarshal([]byte(out), &st); err == nil {
				return &st, nil
			}
			last = out
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("%s not ready: %s", service, strings.TrimSpace(last))
}

func (r *runner) status(service string) (*apiv1.StatusResponse, error) {
	out, code := r.exec(service, "raminga", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s status exit %d: %s", service, code, out)
	}
	var st apiv1.StatusResponse
	if err := protojson.Unmarshal([]byte(out), &st); err != nil {
		return nil, fmt.Errorf("%s status decode: %w (%s)", service, err, out)
	}
	return &st, nil
}

func (r *runner) peers(service string, cached bool) (*apiv1.PeersResponse, error) {
	args := []string{"raminga", "peers", "--data-dir", "/data", "--json"}
	if cached {
		args = append(args, "--cached")
	}
	out, code := r.exec(service, args...)
	if code != 0 {
		return nil, fmt.Errorf("%s peers exit %d: %s", service, code, out)
	}
	var res apiv1.PeersResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s peers decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) relayStatus(service string) (*apiv1.RelayStatusResponse, error) {
	out, code := r.exec(service, "raminga", "relay", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s relay status exit %d: %s", service, code, out)
	}
	var res apiv1.RelayStatusResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s relay decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) dhtStatus(service string) (*apiv1.DhtStatusResponse, error) {
	out, code := r.exec(service, "raminga", "dht", "status", "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s dht status exit %d: %s", service, code, out)
	}
	var res apiv1.DhtStatusResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s dht decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) dhtFind(service, peerID string) (*apiv1.DhtPeer, error) {
	out, code := r.exec(service, "raminga", "dht", "find", peerID, "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s dht find exit %d: %s", service, code, out)
	}
	var res apiv1.DhtFindPeerResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s dht find decode: %w (%s)", service, err, out)
	}
	return res.GetPeer(), nil
}

func (r *runner) connect(service, multiaddr string) (*apiv1.ConnectResponse, error) {
	out, code := r.exec(service, "raminga", "connect", multiaddr, "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s connect exit %d: %s", service, code, out)
	}
	var res apiv1.ConnectResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s connect decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) send(service, peerID, text string) (*apiv1.SendChatResponse, error) {
	out, code := r.exec(service, "raminga", "chat", "send", "--to", peerID, "--text", text, "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s send exit %d: %s", service, code, out)
	}
	var res apiv1.SendChatResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s send decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) disconnect(service, peerID string) error {
	out, code := r.exec(service, "raminga", "test", "disconnect", peerID, "--data-dir", "/data", "--json")
	if code != 0 {
		return fmt.Errorf("%s disconnect exit %d: %s", service, code, out)
	}
	return nil
}

func (r *runner) cancelOutbox(service, messageID string) error {
	out, code := r.exec(service, "raminga", "chat", "cancel", messageID, "--data-dir", "/data", "--json")
	if code != 0 {
		return fmt.Errorf("%s outbox cancel exit %d: %s", service, code, out)
	}
	return nil
}

func (r *runner) addPeer(service, multiaddr string) (*apiv1.DhtPeer, error) {
	out, code := r.exec(service, "raminga", "peers", "add", multiaddr, "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s peers add exit %d: %s", service, code, out)
	}
	var res apiv1.DhtAddPeerResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s peers add decode: %w (%s)", service, err, out)
	}
	return res.GetPeer(), nil
}

func (r *runner) waitFor(desc string, timeout time.Duration, fn func() (bool, string, error)) (string, error) {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		ok, detail, err := fn()
		if err != nil {
			return "", err
		}
		last = detail
		if ok {
			return detail, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return last, fmt.Errorf("timeout waiting for %s: %s", desc, last)
}

func peerIn(st *apiv1.StatusResponse, peerID string) *apiv1.PeerStatus {
	for _, p := range st.GetPeers() {
		if p.GetPeerId() == peerID {
			return p
		}
	}
	return nil
}

func peerInList(peers []*apiv1.PeerEntry, peerID string) *apiv1.PeerEntry {
	for _, p := range peers {
		if p.GetPeerId() == peerID {
			return p
		}
	}
	return nil
}

func relayIn(st *apiv1.StatusResponse, relayPeerID string) *apiv1.RelayReservation {
	for _, relay := range st.GetNetwork().GetRelays() {
		if relay.GetRelayPeerId() == relayPeerID {
			return relay
		}
	}
	return nil
}

func (r *runner) waitRelayActive(service, relayPeerID string, timeout time.Duration) (*apiv1.RelayReservation, error) {
	var found *apiv1.RelayReservation
	_, err := r.waitFor("relay active "+relayPeerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		relay := relayIn(st, relayPeerID)
		if relay == nil {
			return false, "relay state missing", nil
		}
		if relay.GetStatus() == "active" && relay.GetRelayedAddr() != "" {
			found = relay
			return true, relay.GetRelayedAddr(), nil
		}
		return false, fmt.Sprintf("status=%s error=%s", relay.GetStatus(), relay.GetLastError()), nil
	})
	return found, err
}

func (r *runner) waitDirect(service, peerID, transport string, timeout time.Duration) (*apiv1.PeerStatus, error) {
	var found *apiv1.PeerStatus
	_, err := r.waitFor("direct "+transport+" "+peerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		p := peerIn(st, peerID)
		if p == nil {
			return false, "peer missing", nil
		}
		if p.GetOnline() && p.GetDirect() && !p.GetLimited() && p.GetRoute() == "direct" && p.GetTransport() == transport {
			found = p
			return true, fmt.Sprintf("route=%s transport=%s addrs=%v", p.GetRoute(), p.GetTransport(), p.GetAddrs()), nil
		}
		return false, fmt.Sprintf("online=%t direct=%t limited=%t route=%s transport=%s", p.GetOnline(), p.GetDirect(), p.GetLimited(), p.GetRoute(), p.GetTransport()), nil
	})
	return found, err
}

func (r *runner) waitPeerNotConnected(service, peerID string, timeout time.Duration) error {
	_, err := r.waitFor("peer not connected "+peerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		p := peerIn(st, peerID)
		online := p != nil && p.GetOnline()
		conns := 0
		for _, c := range st.GetConnections() {
			if c.GetPeerId() == peerID {
				conns++
			}
		}
		return !online && conns == 0, fmt.Sprintf("online=%t connections=%d", online, conns), nil
	})
	return err
}

func (r *runner) waitPeerOffline(service, peerID string, timeout time.Duration) error {
	_, err := r.waitFor("peer offline "+peerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		p := peerIn(st, peerID)
		return p == nil || !p.GetOnline(), fmt.Sprintf("peer=%v", p), nil
	})
	return err
}

func (r *runner) conntrack(router, proto, port string) (string, error) {
	out, code := r.exec(router, "sh", "-c", fmt.Sprintf("conntrack -L -p %s 2>/dev/null | grep -E 'sport=%s|dport=%s' || true", proto, port, port))
	if code != 0 {
		return "", fmt.Errorf("%s conntrack exit %d: %s", router, code, out)
	}
	return out, nil
}

func (r *runner) iptables(router string) (string, error) {
	out, code := r.exec(router, "sh", "-c", "iptables -w 5 -t nat -S; echo ---; iptables -w 5 -S FORWARD")
	if code != 0 {
		return "", fmt.Errorf("%s iptables exit %d: %s", router, code, out)
	}
	return out, nil
}

func (r *runner) composeLogs(service string) string {
	out, _ := r.compose("logs", "--no-color", "--tail", "400", service)
	return out
}

func (r *runner) writeConfig(service string, cfg string) error {
	path := filepath.Join(r.configDir, service+".toml")
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		return err
	}
	return nil
}

func (r *runner) writeEvidence() error {
	data, err := json.MarshalIndent(r.ev, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := evsum.WriteRaw(r.root, "g2", data); err != nil {
		return err
	}
	summary, err := evsum.Summarize(data, "g2")
	if err != nil {
		return err
	}
	path, err := evsum.Write(r.evidenceDir, "g2", summary)
	if err != nil {
		return err
	}
	if err := evsum.WritePointer(r.evidenceDir, filepath.Base(path)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(os.Stdout, "g2: wrote summary %s\n", path)
	return nil
}
