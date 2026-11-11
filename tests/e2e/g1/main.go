// Command g1 runs the G1 Docker acceptance scenarios, writes evidence JSON and
// exits non-zero on any failure. It deliberately uses only the shipped CLI and
// the UDS Connect API inside containers.
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
	composeRel   = "tests/e2e/docker-compose.yml"
	projectName  = "raminga-g1-e2e"
	imageName    = "raminga-g1-e2e:local"
	defaultTCP   = "4001"
	evidenceNote = "No private keys or bearer tokens are included. Tokens are read inside containers and never written to evidence; command output is truncated and 64-hex tokens are redacted."
)

type evidence struct {
	GeneratedAt    string     `json:"generated_at"`
	Branch         string     `json:"branch"`
	Commit         string     `json:"commit"`
	GoVersion      string     `json:"go_version"`
	DockerVersion  string     `json:"docker_version"`
	ComposeVersion string     `json:"compose_version"`
	ModuleVersions []string   `json:"module_versions"`
	Image          string     `json:"image"`
	Scenarios      []scenario `json:"scenarios"`
	Overall        string     `json:"overall"`
	Note           string     `json:"note"`
}

type scenario struct {
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Checks   []check         `json:"checks"`
	Commands []commandRecord `json:"commands,omitempty"`
	Error    string          `json:"error,omitempty"`
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
	composeFile string
	project     string
	evidenceDir string
	keep        bool
	ev          evidence
	current     *scenario
	hexToken    *regexp.Regexp
}

func main() {
	os.Exit(run())
}

func run() int {
	var (
		project     = flag.String("project", projectName, "compose project name")
		evidenceDir = flag.String("evidence", "tests/e2e/evidence/g1", "evidence output directory")
		keep        = flag.Bool("keep", false, "keep compose containers and volumes")
		skipSetup   = flag.Bool("skip-setup", false, "reuse already-running compose services")
	)
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "g1: getwd: %v\n", err)
		return 1
	}
	r := &runner{
		root:        root,
		composeFile: filepath.Join(root, composeRel),
		project:     *project,
		evidenceDir: filepath.Join(root, *evidenceDir),
		keep:        *keep,
		hexToken:    regexp.MustCompile(`[0-9a-f]{64}`),
		ev: evidence{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Image:       imageName,
			Note:        evidenceNote,
		},
	}
	r.collectEnvironment()

	if !*skipSetup {
		if err := r.setup(); err != nil {
			r.newScenario("setup")
			r.addCheck("compose build and up", false, err.Error())
			r.finishScenario(err)
			_ = r.writeEvidence()
			if !r.keep {
				r.cleanup()
			}
			fmt.Fprintf(os.Stderr, "g1: setup failed: %v\n", err)
			return 1
		}
	}

	scenarios := []struct {
		name string
		fn   func() error
	}{
		{"lan-direct-chat", r.scenarioLAN},
		{"restart", r.scenarioRestart},
		{"single-instance", r.scenarioSingleInstance},
		{"api-boundary", r.scenarioAPIBoundary},
	}
	failed := false
	for _, sc := range scenarios {
		r.newScenario(sc.name)
		if err := sc.fn(); err != nil {
			failed = true
			r.finishScenario(err)
			fmt.Fprintf(os.Stderr, "g1: scenario %s FAIL: %v\n", sc.name, err)
			continue
		}
		r.finishScenario(nil)
		last := r.ev.Scenarios[len(r.ev.Scenarios)-1]
		if last.Status != "PASS" {
			failed = true
			_, _ = fmt.Fprintf(os.Stdout, "g1: scenario %s %s\n", sc.name, last.Status)
			continue
		}
		_, _ = fmt.Fprintf(os.Stdout, "g1: scenario %s PASS\n", sc.name)
	}

	r.ev.Overall = "PASS"
	if failed {
		r.ev.Overall = "FAIL"
	}
	for _, sc := range r.ev.Scenarios {
		if sc.Status != "PASS" {
			r.ev.Overall = "FAIL"
		}
	}
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g1: write evidence: %v\n", err)
		failed = true
	}
	if !r.keep {
		r.cleanup()
	}
	_, _ = fmt.Fprintf(os.Stdout, "g1: overall %s (evidence: %s)\n", r.ev.Overall, r.evidenceDir)
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
		"modernc.org/sqlite",
		"connectrpc.com/connect",
		"github.com/gofrs/flock",
		"github.com/pelletier/go-toml/v2",
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

func (r *runner) setup() error {
	if out, code := r.compose("down", "-v", "--remove-orphans"); code != 0 {
		return fmt.Errorf("compose down: %s", out)
	}
	if out, code := r.compose("--progress=plain", "build"); code != 0 {
		// A transient registry failure must not invalidate an already-built
		// local image. The scenarios still run against the real containers.
		if id := r.hostOutput("docker", "image", "inspect", "-f", "{{.Id}}", imageName); strings.TrimSpace(id) == "" || strings.Contains(id, "(") {
			return fmt.Errorf("compose build: %s", out)
		} else {
			_, _ = fmt.Fprintf(os.Stderr, "g1: compose build failed; reusing existing %s image: %s\n", imageName, strings.TrimSpace(id))
		}
	}
	if out, code := r.compose("up", "-d", "--wait", "--wait-timeout", "120"); code != 0 {
		return fmt.Errorf("compose up: %s", out)
	}
	for _, svc := range []string{"node-a", "node-b", "api-only", "api-test"} {
		if err := r.waitReady(svc, 60*time.Second); err != nil {
			return err
		}
	}
	return nil
}

func (r *runner) cleanup() {
	r.compose("down", "-v", "--remove-orphans")
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

func (r *runner) execDetached(service string, args ...string) (string, int) {
	full := []string{"compose", "-p", r.project, "-f", r.composeFile, "exec", "-T", "-d", service}
	full = append(full, args...)
	return r.recordCommand(service, "docker", full...)
}

func (r *runner) recordCommand(where, name string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.root
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
	if len(s) > 8000 {
		s = s[:8000] + "\n...[truncated]"
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

func (r *runner) quiet(service string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	full := []string{"compose", "-p", r.project, "-f", r.composeFile, "exec", "-T", service}
	full = append(full, args...)
	cmd := exec.CommandContext(ctx, "docker", full...)
	cmd.Dir = r.root
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

func (r *runner) redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = r.redact(a)
	}
	return out
}

func (r *runner) redact(s string) string {
	return r.hexToken.ReplaceAllString(s, "<redacted-64-hex>")
}

func (r *runner) newScenario(name string) {
	r.ev.Scenarios = append(r.ev.Scenarios, scenario{Name: name})
	r.current = &r.ev.Scenarios[len(r.ev.Scenarios)-1]
}

func (r *runner) addCheck(name string, pass bool, detail string) {
	if r.current == nil {
		return
	}
	r.current.Checks = append(r.current.Checks, check{Name: name, Pass: pass, Detail: r.redact(detail)})
}

func (r *runner) require(name string, err error) bool {
	if err != nil {
		r.addCheck(name, false, err.Error())
		return false
	}
	r.addCheck(name, true, "ok")
	return true
}

func (r *runner) finishScenario(err error) {
	if r.current == nil {
		return
	}
	pass := err == nil
	for _, c := range r.current.Checks {
		if !c.Pass {
			pass = false
		}
	}
	if pass {
		r.current.Status = "PASS"
	} else {
		r.current.Status = "FAIL"
	}
	if err != nil {
		r.current.Error = r.redact(err.Error())
	}
	r.current = nil
}

func (r *runner) waitReady(service string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		out, code := r.quiet(service, "raminga", "status", "--data-dir", "/data")
		if code == 0 {
			return nil
		}
		last = out
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("%s not ready: %s", service, strings.TrimSpace(last))
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

func (r *runner) send(service, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	args := []string{"raminga", "chat", "send", "--data-dir", "/data", "--text", text, "--json"}
	if peerID != "" {
		args = append(args, "--to", peerID)
	}
	if multiaddr != "" {
		args = append(args, "--multiaddr", multiaddr)
	}
	out, code := r.exec(service, args...)
	if code != 0 {
		return nil, fmt.Errorf("%s chat send exit %d: %s", service, code, out)
	}
	var res apiv1.SendChatResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s chat send decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) history(service string, limit uint32) (*apiv1.RecentMessagesResponse, error) {
	out, code := r.exec(service, "raminga", "chat", "history", "--data-dir", "/data", "--limit", fmt.Sprint(limit), "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s history exit %d: %s", service, code, out)
	}
	var res apiv1.RecentMessagesResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s history decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) containerIP(service string) (string, error) {
	out, code := r.compose("ps", "-q", service)
	id := strings.TrimSpace(out)
	if code != 0 || id == "" {
		return "", fmt.Errorf("compose ps -q %s exit %d: %s", service, code, out)
	}
	out, code = r.recordCommand("host", "docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id)
	ip := strings.TrimSpace(out)
	if code != 0 || ip == "" {
		return "", fmt.Errorf("inspect %s ip exit %d: %s", service, code, out)
	}
	return ip, nil
}

func peerMultiaddr(ip, peerID string) string {
	return "/ip4/" + ip + "/tcp/" + defaultTCP + "/p2p/" + peerID
}

func findMessage(msgs []*apiv1.StoredMessage, id string) *apiv1.StoredMessage {
	for _, m := range msgs {
		if m.GetMessageId() == id {
			return m
		}
	}
	return nil
}

func hasPeer(st *apiv1.StatusResponse, peerID string) *apiv1.PeerStatus {
	for _, p := range st.GetPeers() {
		if p.GetPeerId() == peerID {
			return p
		}
	}
	return nil
}

func (r *runner) startEvents(service, file string) error {
	script := fmt.Sprintf("rm -f %s; exec raminga chat events --data-dir /data --json --count 1 --timeout 30s > %s 2>&1", file, file)
	if out, code := r.execDetached(service, "sh", "-c", script); code != 0 {
		return fmt.Errorf("start events exit %d: %s", code, out)
	}
	time.Sleep(1500 * time.Millisecond)
	return nil
}

func (r *runner) waitEvent(service, file string) (*apiv1.EventsResponse, error) {
	deadline := time.Now().Add(25 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		out, code := r.quiet(service, "cat", file)
		last = out
		if code == 0 && strings.TrimSpace(out) != "" {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				var ev apiv1.EventsResponse
				if err := protojson.Unmarshal([]byte(line), &ev); err != nil {
					continue
				}
				if ev.GetChatReceived() != nil {
					return &ev, nil
				}
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil, fmt.Errorf("no chat event in %s: %s", file, strings.TrimSpace(last))
}

func (r *runner) scenarioLAN() error {
	stA, err := r.status("node-a")
	if !r.require("node-a status", err) {
		return err
	}
	stB, err := r.status("node-b")
	if !r.require("node-b status", err) {
		return err
	}
	r.addCheck("distinct peer IDs", stA.GetPeerId() != "" && stB.GetPeerId() != "" && stA.GetPeerId() != stB.GetPeerId(),
		"A="+stA.GetPeerId()+" B="+stB.GetPeerId())
	r.addCheck("distinct logical node IDs", stA.GetNodeId() != stB.GetNodeId() && stA.GetNodeId() != "",
		"A="+stA.GetNodeId()+" B="+stB.GetNodeId())

	ipA, err := r.containerIP("node-a")
	if !r.require("node-a container IP", err) {
		return err
	}
	ipB, err := r.containerIP("node-b")
	if !r.require("node-b container IP", err) {
		return err
	}
	maB := peerMultiaddr(ipB, stB.GetPeerId())
	maA := peerMultiaddr(ipA, stA.GetPeerId())
	r.addCheck("LAN multiaddr constructed", true, "B="+maB)

	// G1 originally proved TCP only. Dial QUIC first so the established
	// connection is unambiguously QUIC, then verify a direct non-limited path.
	quicB := "/ip4/" + ipB + "/udp/4001/quic-v1/p2p/" + stB.GetPeerId()
	quicConn, err := r.connect("node-a", quicB)
	if !r.require("node-a explicit QUIC dial node-b", err) {
		return err
	}
	r.addCheck("LAN QUIC direct non-limited", quicConn.GetDirect() && !quicConn.GetLimited() &&
		quicConn.GetTransport() == "quic" && strings.Contains(quicConn.GetRemoteMultiaddr(), "/udp/4001/quic-v1") &&
		!strings.Contains(quicConn.GetRemoteMultiaddr(), "p2p-circuit"),
		quicConn.GetRemoteMultiaddr())

	conn, err := r.connect("node-a", maB)
	if !r.require("node-a explicit dial node-b", err) {
		return err
	}
	r.addCheck("dialed correct Peer ID", conn.GetPeerId() == stB.GetPeerId(), conn.GetPeerId())
	r.addCheck("direct non-limited libp2p connection", conn.GetDirect() && !conn.GetLimited(), conn.GetRemoteMultiaddr())
	r.addCheck("transport is TCP or QUIC", conn.GetTransport() == "tcp" || conn.GetTransport() == "quic", conn.GetTransport())
	r.addCheck("not a relay address", !strings.Contains(conn.GetRemoteMultiaddr(), "p2p-circuit"), conn.GetRemoteMultiaddr())

	stA2, err := r.status("node-a")
	if r.require("node-a status after dial", err) {
		p := hasPeer(stA2, stB.GetPeerId())
		r.addCheck("node-a lists node-b as direct peer", p != nil && p.GetDirect() && !p.GetLimited(),
			fmt.Sprintf("peer=%v", p))
	}

	if err := r.startEvents("node-b", "/tmp/events-b.json"); !r.require("start node-b event stream", err) {
		return err
	}
	sendA, err := r.send("node-a", stB.GetPeerId(), "", "hello-lan-a-to-b")
	if !r.require("node-a sends HTTP chat", err) {
		return err
	}
	r.addCheck("node-a ACKed with matching message ID", sendA.GetAcked() && sendA.GetAckMessageId() == sendA.GetMessageId() && sendA.GetAckId() != "",
		sendA.GetMessageId()+" ack="+sendA.GetAckId())

	ev, err := r.waitEvent("node-b", "/tmp/events-b.json")
	if !r.require("node-b receives chat event stream", err) {
		return err
	}
	chat := ev.GetChatReceived()
	r.addCheck("streamed chat matches message ID and sender", chat.GetMessageId() == sendA.GetMessageId() && chat.GetFromPeerId() == stA.GetPeerId(),
		chat.GetMessageId()+" from="+chat.GetFromPeerId())
	r.addCheck("streamed chat text is correct", chat.GetText() == "hello-lan-a-to-b", chat.GetText())

	connB, err := r.connect("node-b", maA)
	if !r.require("node-b explicit dial node-a", err) {
		return err
	}
	r.addCheck("reverse dial direct and correct", connB.GetPeerId() == stA.GetPeerId() && connB.GetDirect() && !connB.GetLimited(),
		connB.GetRemoteMultiaddr())

	sendB, err := r.send("node-b", stA.GetPeerId(), "", "hello-lan-b-to-a")
	if !r.require("node-b sends HTTP chat", err) {
		return err
	}
	r.addCheck("node-b ACKed with matching message ID", sendB.GetAcked() && sendB.GetAckMessageId() == sendB.GetMessageId() && sendB.GetAckId() != "",
		sendB.GetMessageId()+" ack="+sendB.GetAckId())

	histA, err := r.history("node-a", 50)
	if !r.require("node-a history", err) {
		return err
	}
	histB, err := r.history("node-b", 50)
	if !r.require("node-b history", err) {
		return err
	}
	outA := findMessage(histA.GetMessages(), sendA.GetMessageId())
	inA := findMessage(histA.GetMessages(), sendB.GetMessageId())
	inB := findMessage(histB.GetMessages(), sendA.GetMessageId())
	outB := findMessage(histB.GetMessages(), sendB.GetMessageId())
	r.addCheck("node-a persisted outbound ACKed", outA != nil && outA.GetDirection() == "out" && outA.GetAcked(), fmt.Sprintf("%v", outA))
	r.addCheck("node-a persisted inbound reverse message", inA != nil && inA.GetDirection() == "in" && inA.GetText() == "hello-lan-b-to-a", fmt.Sprintf("%v", inA))
	r.addCheck("node-b persisted inbound message", inB != nil && inB.GetDirection() == "in" && inB.GetText() == "hello-lan-a-to-b", fmt.Sprintf("%v", inB))
	r.addCheck("node-b persisted outbound ACKed", outB != nil && outB.GetDirection() == "out" && outB.GetAcked(), fmt.Sprintf("%v", outB))
	return nil
}

func (r *runner) scenarioRestart() error {
	stA0, err := r.status("node-a")
	if !r.require("node-a status before restart", err) {
		return err
	}
	stB0, err := r.status("node-b")
	if !r.require("node-b status before restart", err) {
		return err
	}

	if out, code := r.compose("stop", "node-b"); !r.require("stop node-b", composeErr(out, code)) {
		return fmt.Errorf("stop node-b exit %d", code)
	}
	unacked, err := r.send("node-a", stB0.GetPeerId(), "", "unacked-before-restart")
	if !r.require("send while peer is down returns unacked", err) {
		return err
	}
	r.addCheck("down-peer message is not ACKed", !unacked.GetAcked(), unacked.GetError())
	r.addCheck("down-peer message has a message ID", unacked.GetMessageId() != "", unacked.GetMessageId())

	if out, code := r.compose("stop", "node-a"); !r.require("stop node-a", composeErr(out, code)) {
		return fmt.Errorf("stop node-a exit %d", code)
	}
	if out, code := r.compose("start", "node-a"); !r.require("start node-a", composeErr(out, code)) {
		return fmt.Errorf("start node-a exit %d", code)
	}
	if err := r.waitReady("node-a", 60*time.Second); !r.require("node-a ready after restart", err) {
		return err
	}
	stA1, err := r.status("node-a")
	if !r.require("node-a status after restart", err) {
		return err
	}
	r.addCheck("same Peer ID after restart", stA1.GetPeerId() == stA0.GetPeerId() && stA1.GetPeerId() != "", stA1.GetPeerId())
	r.addCheck("same logical Node ID after restart", stA1.GetNodeId() == stA0.GetNodeId(), stA1.GetNodeId())

	histA, err := r.history("node-a", 100)
	if !r.require("node-a history after restart", err) {
		return err
	}
	unackedAfter := findMessage(histA.GetMessages(), unacked.GetMessageId())
	r.addCheck("unacked message still unacked after restart", unackedAfter != nil && !unackedAfter.GetAcked(), fmt.Sprintf("%v", unackedAfter))

	if out, code := r.compose("start", "node-b"); !r.require("start node-b", composeErr(out, code)) {
		return fmt.Errorf("start node-b exit %d", code)
	}
	if err := r.waitReady("node-b", 60*time.Second); !r.require("node-b ready after restart", err) {
		return err
	}
	stB1, err := r.status("node-b")
	if !r.require("node-b status after restart", err) {
		return err
	}
	r.addCheck("node-b same Peer ID after restart", stB1.GetPeerId() == stB0.GetPeerId(), stB1.GetPeerId())

	ipB, err := r.containerIP("node-b")
	if !r.require("node-b IP after restart", err) {
		return err
	}
	if _, err := r.connect("node-a", peerMultiaddr(ipB, stB1.GetPeerId())); !r.require("node-a redial after restart", err) {
		return err
	}
	confirmed, err := r.send("node-a", stB1.GetPeerId(), "", "confirmed-after-restart")
	if !r.require("send after restart", err) {
		return err
	}
	r.addCheck("post-restart message ACKed with matching ID", confirmed.GetAcked() && confirmed.GetAckMessageId() == confirmed.GetMessageId(),
		confirmed.GetMessageId()+" ack="+confirmed.GetAckId())
	// G4 durable outbox: once node-b is reachable again the pre-restart
	// unacked message is auto-resent and gets a real ACK (never a fake one).
	deadline := time.Now().Add(30 * time.Second)
	var outboxAcked bool
	for time.Now().Before(deadline) {
		histA, err = r.history("node-a", 100)
		if err != nil {
			return err
		}
		unackedAfter = findMessage(histA.GetMessages(), unacked.GetMessageId())
		if unackedAfter != nil && unackedAfter.GetAcked() {
			outboxAcked = true
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	r.addCheck("unacked message auto-resent and ACKed after reconnect", outboxAcked, fmt.Sprintf("%v", unackedAfter))
	histB, err := r.history("node-b", 100)
	if !r.require("node-b history after outbox resend", err) {
		return err
	}
	delivered := 0
	for _, m := range histB.GetMessages() {
		if m.GetText() == "unacked-before-restart" && m.GetDirection() == "in" {
			delivered++
		}
	}
	r.addCheck("outbox resend stored exactly one receiver row", delivered == 1, fmt.Sprintf("rows=%d", delivered))
	confirmedAfter := findMessage(histA.GetMessages(), confirmed.GetMessageId())
	r.addCheck("confirmed message persisted ACKed", confirmedAfter != nil && confirmedAfter.GetAcked(), fmt.Sprintf("%v", confirmedAfter))
	return nil
}

func (r *runner) scenarioSingleInstance() error {
	stBefore, err := r.status("node-a")
	if !r.require("node-a status before second daemon", err) {
		return err
	}
	out, code := r.exec("node-a", "raminga", "daemon", "--data-dir", "/data")
	r.addCheck("second daemon exits non-zero", code != 0, fmt.Sprintf("exit=%d", code))
	r.addCheck("second daemon reports data-dir lock", strings.Contains(out, "locked by another raminga daemon"), strings.TrimSpace(out))

	stAfter, err := r.status("node-a")
	if !r.require("first daemon still serving status", err) {
		return err
	}
	r.addCheck("first daemon identity unchanged", stAfter.GetPeerId() == stBefore.GetPeerId(), stAfter.GetPeerId())

	lockInfo, code := r.exec("node-a", "stat", "-c", "%a %F", "/data/raminga.lock")
	r.addCheck("lock file intact with 0600", code == 0 && strings.HasPrefix(strings.TrimSpace(lockInfo), "600 "), strings.TrimSpace(lockInfo))

	if out, code := r.compose("restart", "node-a"); !r.require("restart node-a", composeErr(out, code)) {
		return fmt.Errorf("restart node-a exit %d", code)
	}
	if err := r.waitReady("node-a", 60*time.Second); !r.require("node-a ready after lock release", err) {
		return err
	}
	stFinal, err := r.status("node-a")
	if !r.require("status after lock release", err) {
		return err
	}
	r.addCheck("lock released cleanly on restart", stFinal.GetPeerId() == stBefore.GetPeerId(), stFinal.GetPeerId())
	return nil
}

func (r *runner) scenarioAPIBoundary() error {
	st, err := r.status("api-only")
	if !r.require("api-only status over UDS", err) {
		return err
	}
	r.addCheck("api-only has no libp2p listen addrs", len(st.GetListenAddrs()) == 0, fmt.Sprintf("%v", st.GetListenAddrs()))
	r.addCheck("test API disabled by default", !st.GetTestApiEnabled(), "false")

	ss, code := r.exec("api-only", "ss", "-H", "-ltnup")
	ok, detail := onlyDockerDNSListeners(ss)
	r.addCheck("no raminga TCP/UDP listener in api-only container", code == 0 && !strings.Contains(ss, "raminga"), strings.TrimSpace(ss))
	r.addCheck("only Docker embedded DNS listeners remain", code == 0 && ok, detail)

	perms, code := r.exec("api-only", "stat", "-c", "%a %F", "/data/api.sock", "/data/api.token")
	lines := strings.Split(strings.TrimSpace(perms), "\n")
	sockOK := len(lines) == 2 && strings.HasPrefix(lines[0], "600 socket")
	tokenOK := len(lines) == 2 && strings.HasPrefix(lines[1], "600 regular")
	r.addCheck("socket is 0600 Unix socket", code == 0 && sockOK, lines[0])
	r.addCheck("token file is 0600 regular file", code == 0 && tokenOK, lines[1])

	wrong, wrongBody, err := r.curlCall("api-only", "/raminga.api.v1.RamingaService/Status", "wrong", "{}")
	r.addCheck("wrong token rejected", err == nil && wrong == 401, fmt.Sprintf("http=%d body=%s", wrong, strings.TrimSpace(wrongBody)))
	missing, missingBody, err := r.curlCall("api-only", "/raminga.api.v1.RamingaService/Status", "missing", "{}")
	r.addCheck("missing token rejected", err == nil && missing == 401, fmt.Sprintf("http=%d body=%s", missing, strings.TrimSpace(missingBody)))
	valid, _, err := r.curlCall("api-only", "/raminga.api.v1.RamingaService/Status", "valid", "{}")
	r.addCheck("correct token accepted", err == nil && valid == 200, fmt.Sprintf("http=%d", valid))
	pingOff, pingOffBody, err := r.curlCall("api-only", "/raminga.api.v1.RamingaService/TestPing", "valid", `{"echo":"off"}`)
	r.addCheck("TestPing unavailable without --enable-test-api", err == nil && pingOff == 501, fmt.Sprintf("http=%d body=%s", pingOff, strings.TrimSpace(pingOffBody)))

	stTest, err := r.status("api-test")
	if !r.require("api-test status over UDS", err) {
		return err
	}
	r.addCheck("api-test has test API enabled", stTest.GetTestApiEnabled(), "true")
	ssTest, code := r.exec("api-test", "ss", "-H", "-ltnup")
	okTest, detailTest := onlyDockerDNSListeners(ssTest)
	r.addCheck("no raminga TCP/UDP listener in api-test container", code == 0 && !strings.Contains(ssTest, "raminga"), strings.TrimSpace(ssTest))
	r.addCheck("only Docker embedded DNS listeners remain in api-test", code == 0 && okTest, detailTest)
	pingOn, pingOnBody, err := r.curlCall("api-test", "/raminga.api.v1.RamingaService/TestPing", "valid", `{"echo":"on"}`)
	r.addCheck("TestPing available with --enable-test-api", err == nil && pingOn == 200 && strings.Contains(pingOnBody, `"on"`),
		fmt.Sprintf("http=%d body=%s", pingOn, strings.TrimSpace(pingOnBody)))
	return nil
}

func (r *runner) curlCall(service, path, tokenMode, body string) (int, string, error) {
	auth := ""
	switch tokenMode {
	case "valid":
		auth = `-H "Authorization: Bearer $TOKEN"`
	case "wrong":
		auth = `-H "Authorization: Bearer wrong-token"`
	case "missing":
	default:
		return 0, "", fmt.Errorf("bad token mode %q", tokenMode)
	}
	script := fmt.Sprintf(`TOKEN=$(cat /data/api.token)
code=$(curl -sS --max-time 5 --unix-socket /data/api.sock -o /tmp/api-body -w '%%{http_code}' \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' %s \
  -d '%s' 'http://unix%s')
printf '%%s\n' "$code"
cat /tmp/api-body`, auth, body, path)
	out, code := r.exec(service, "sh", "-c", script)
	if code != 0 {
		return 0, out, fmt.Errorf("curl %s exit %d: %s", path, code, out)
	}
	parts := strings.SplitN(out, "\n", 2)
	if len(parts) == 0 {
		return 0, "", fmt.Errorf("empty curl output")
	}
	httpCode := 0
	if _, err := fmt.Sscanf(strings.TrimSpace(parts[0]), "%d", &httpCode); err != nil {
		return 0, out, fmt.Errorf("parse http code: %w (%s)", err, out)
	}
	bodyOut := ""
	if len(parts) == 2 {
		bodyOut = parts[1]
	}
	return httpCode, bodyOut, nil
}

func onlyDockerDNSListeners(ss string) (bool, string) {
	var unexpected []string
	for _, line := range strings.Split(strings.TrimSpace(ss), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			unexpected = append(unexpected, line)
			continue
		}
		if strings.HasPrefix(fields[4], "127.0.0.11:") {
			continue
		}
		unexpected = append(unexpected, line)
	}
	if len(unexpected) > 0 {
		return false, strings.Join(unexpected, "\n")
	}
	return true, "only Docker embedded DNS at 127.0.0.11"
}

func composeErr(out string, code int) error {
	if code == 0 {
		return nil
	}
	return fmt.Errorf("exit %d: %s", code, strings.TrimSpace(out))
}

func (r *runner) writeEvidence() error {
	data, err := json.MarshalIndent(r.ev, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := evsum.WriteRaw(r.root, "g1", data); err != nil {
		return err
	}
	summary, err := evsum.Summarize(data, "g1")
	if err != nil {
		return err
	}
	path, err := evsum.Write(r.evidenceDir, "g1", summary)
	if err != nil {
		return err
	}
	if err := evsum.WritePointer(r.evidenceDir, filepath.Base(path)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(os.Stdout, "g1: wrote summary %s\n", path)
	return nil
}
