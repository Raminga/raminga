// Command g3 runs the G3 Docker test-infrastructure acceptance suite.
//
// It drives only the shipped CLI/local API inside containers, records a
// facility self-check before each facility's business scenarios, and writes
// honest PASS/FAIL/BLOCKED/NOT_TESTED evidence. Docker is a simulation, not
// real-world M6 evidence.
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
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	evsum "github.com/Raminga/raminga/tests/e2e/internal/evidence"
)

const (
	imageName    = "raminga-g3-e2e:local"
	evidenceNote = "Docker simulation only; not public-network M6. Facilities are self-checked before business scenarios. No private keys or bearer tokens are included; 64-hex token-shaped strings are redacted."
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
	Stacks         []stackEvidence     `json:"stacks"`
	Facilities     []*facilityEvidence `json:"facilities"`
	Scenarios      []*scenarioEvidence `json:"scenarios"`
	NATMapping     []*natMapping       `json:"nat01_nat13_mapping"`
	Overall        string              `json:"overall"`
	Note           string              `json:"note"`
}

type stackEvidence struct {
	Name        string `json:"name"`
	ComposeFile string `json:"compose_file"`
	Project     string `json:"project"`
	Facility    string `json:"facility"`
}

type facilityEvidence struct {
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Checks   []check         `json:"checks"`
	Commands []commandRecord `json:"commands,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type scenarioEvidence struct {
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	Accepted bool            `json:"accepted"`
	Checks   []check         `json:"checks"`
	Commands []commandRecord `json:"commands,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type natMapping struct {
	ID       string `json:"id"`
	Scenario string `json:"scenario"`
	Status   string `json:"status"`
	Detail   string `json:"detail"`
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

type stackInfo struct {
	name        string
	composeRel  string
	project     string
	configDir   string
	base        []string
	wait        []string
	nonNode     map[string]bool
	facilities  []facilityDef
	scenarioFns []scenarioDef
}

type facilityDef struct {
	name string
	fn   func() (string, error)
}

type scenarioDef struct {
	name         string
	allowBlocked bool
	fn           func() (string, error)
}

type runner struct {
	root           string
	evidenceDir    string
	prefix         string
	keep           bool
	skipBuild      bool
	only           map[string]bool
	scenarioFilter map[string]bool
	hexToken       *regexp.Regexp
	extraArgs      string
	lab            string
	ids            map[string]string
	stack          *stackInfo
	ev             evidence
	current        *scenarioEvidence
	facility       *facilityEvidence
	nat            map[string]*natMapping
}

func main() { os.Exit(run()) }

func run() int {
	var (
		evidenceDir = flag.String("evidence", "tests/e2e/evidence/g3", "evidence output directory")
		prefix      = flag.String("prefix", "raminga-g3", "compose project prefix")
		keep        = flag.Bool("keep", false, "keep compose containers/volumes")
		skipBuild   = flag.Bool("skip-build", false, "reuse the already-built image")
		only        = flag.String("only", "", "comma-separated stacks: lan,onesided,symmetric,dualnat")
		scenarios   = flag.String("scenarios", "", "comma-separated scenario names to run (manual debugging)")
		labName     = flag.String("lab", "", "manual lab mode: lan,onesided,symmetric,dualnat")
		labUp       = flag.Bool("up", false, "lab mode: build if needed, generate configs, start and self-check")
		labDown     = flag.Bool("down", false, "lab mode: stop and remove containers/networks/volumes")
		labStatus   = flag.Bool("status", false, "lab mode: show compose and node status")
		labRebuild  = flag.Bool("rebuild", false, "lab mode: force an image rebuild")
	)
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "g3: getwd: %v\n", err)
		return 1
	}
	r := &runner{
		root:           root,
		evidenceDir:    filepath.Join(root, *evidenceDir),
		prefix:         *prefix,
		keep:           *keep,
		skipBuild:      *skipBuild,
		only:           parseOnly(*only),
		scenarioFilter: parseOnly(*scenarios),
		hexToken:       regexp.MustCompile(`[0-9a-f]{64}`),
		extraArgs:      "--enable-test-api",
		ids:            make(map[string]string),
		nat:            make(map[string]*natMapping),
		ev: evidence{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Image:       imageName,
			Note:        evidenceNote,
		},
	}
	if *labName != "" {
		r.lab = *labName
		r.extraArgs = ""
		return r.runLab(labAction{up: *labUp, down: *labDown, status: *labStatus, rebuild: *labRebuild})
	}

	r.collectEnvironment()

	stacks := r.stacks()
	failed := false
	if !r.skipBuild {
		var lastOut string
		built := false
		for attempt := 1; attempt <= 2; attempt++ {
			out, code := r.recordCommand("host", "docker", "build", "--progress=plain", "-t", imageName, "-f", "tests/e2e/Dockerfile", ".")
			if code == 0 {
				built = true
				break
			}
			lastOut = out
			if attempt < 2 {
				_, _ = fmt.Fprintf(os.Stderr, "g3: docker build attempt %d failed, retrying: %s\n", attempt, out)
				time.Sleep(2 * time.Second)
			}
		}
		if built {
			r.ev.ImageBuild = "built from tests/e2e/Dockerfile"
		} else {
			// A transient registry/network failure must not invalidate a run
			// when a complete local image already exists. Record the reuse and
			// the exact build error instead of silently claiming a rebuild.
			id := r.hostOutput("docker", "image", "inspect", "-f", "{{.Id}}", imageName)
			if strings.TrimSpace(id) != "" && !strings.Contains(id, "(") {
				r.ev.ImageBuild = "build failed; reused existing local image " + strings.TrimSpace(id) + ": " + r.redact(lastOut)
				_, _ = fmt.Fprintf(os.Stderr, "g3: docker build failed; reusing existing %s image: %s\n", imageName, strings.TrimSpace(id))
			} else {
				r.beginFacility("image-build")
				r.addCheckToFacility("g3 image build", false, lastOut)
				r.finishFacility("FAIL", fmt.Errorf("docker build failed and no local image is available"))
				r.ev.Overall = "FAIL"
				_ = r.writeEvidence()
				fmt.Fprintf(os.Stderr, "g3: docker build failed: %s\n", lastOut)
				return 1
			}
		}
	}

	for _, st := range stacks {
		if len(r.only) > 0 && !r.only[st.name] {
			continue
		}
		r.stack = st
		r.ev.Stacks = append(r.ev.Stacks, stackEvidence{Name: st.name, ComposeFile: st.composeRel, Project: st.project, Facility: st.name})
		_, _ = fmt.Fprintf(os.Stdout, "g3: stack %s: setup\n", st.name)
		if !r.keep {
			_, _ = r.compose(st, "down", "-v", "--remove-orphans")
		}
		if err := r.setupStack(st); err != nil {
			r.beginFacility(st.name + "-setup")
			r.addCheckToFacility(st.name+" setup", false, err.Error())
			r.finishFacility("FAIL", err)
			r.ev.Overall = "FAIL"
			failed = true
			if !r.keep {
				r.teardownStack(st)
			}
			fmt.Fprintf(os.Stderr, "g3: stack %s setup failed: %v\n", st.name, err)
			continue
		}
		for _, facility := range st.facilities {
			_, _ = fmt.Fprintf(os.Stdout, "g3: stack %s: facility %s self-check\n", st.name, facility.name)
			r.beginFacility(facility.name)
			status, err := facility.fn()
			r.finishFacility(status, err)
			cur := r.ev.Facilities[len(r.ev.Facilities)-1]
			if cur.Status != "PASS" {
				failed = true
			}
			_, _ = fmt.Fprintf(os.Stdout, "g3: facility %s %s\n", facility.name, cur.Status)
		}
		for _, def := range st.scenarioFns {
			if len(r.scenarioFilter) > 0 && !r.scenarioFilter[def.name] {
				continue
			}
			r.beginScenario(def.name)
			status, err := def.fn()
			r.finishScenario(status, err, def.allowBlocked)
			sc := r.ev.Scenarios[len(r.ev.Scenarios)-1]
			if !sc.Accepted {
				failed = true
			}
			_, _ = fmt.Fprintf(os.Stdout, "g3: scenario %s %s accepted=%t\n", def.name, sc.Status, sc.Accepted)
		}
		if !r.keep {
			r.teardownStack(st)
		}
	}

	r.buildNATMapping()
	for id, m := range r.nat {
		if m.Status == "FAIL" || m.Status == "NOT_TESTED" {
			failed = true
			fmt.Fprintf(os.Stderr, "g3: NAT mapping %s is %s\n", id, m.Status)
		}
	}
	r.ev.Overall = "PASS"
	if failed {
		r.ev.Overall = "FAIL"
	}
	if err := r.writeEvidence(); err != nil {
		fmt.Fprintf(os.Stderr, "g3: write evidence: %v\n", err)
		failed = true
	}
	_, _ = fmt.Fprintf(os.Stdout, "g3: overall %s (evidence: %s)\n", r.ev.Overall, r.evidenceDir)
	if failed || r.ev.Overall != "PASS" {
		return 1
	}
	return 0
}

func parseOnly(raw string) map[string]bool {
	out := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out[part] = true
		}
	}
	return out
}

func (r *runner) stacks() []*stackInfo {
	return []*stackInfo{
		{
			name:       "lan",
			composeRel: "tests/e2e/g3/docker-compose.lan.yml",
			project:    r.prefix + "-lan",
			configDir:  filepath.Join(r.root, ".local", "g3-configs", "lan"),
			wait:       []string{"a4", "b4", "a6", "b6", "a6only", "b6only", "tcp-a", "tcp-b", "udp-a", "udp-b", "loss-a", "loss-b", "q6-a", "q6-b", "id-a", "id-b", "fb-a", "fb-b"},
			facilities: []facilityDef{
				{name: "ipv6-ula-ip6tables", fn: r.facilityIPv6},
				{name: "protocol-blocks", fn: r.facilityProtocolBlocks},
				{name: "tc-netem", fn: r.facilityNetem},
			},
			scenarioFns: []scenarioDef{
				{name: "lan-ipv4-direct", fn: r.scenarioLANIPv4},
				{name: "lan-ipv6-direct", fn: r.scenarioLANIPv6},
				{name: "ipv6-reachable-ipv4-unreachable", fn: r.scenarioIPv6Only},
				{name: "udp-blocked-only", fn: r.scenarioUDPBlocked},
				{name: "tcp-blocked-only", fn: r.scenarioTCPBlocked},
				{name: "netem-loss-latency", fn: r.scenarioNetem},
				{name: "peer-id-address-selection", fn: r.scenarioPeerIDSelection},
			},
		},
		{
			name:       "onesided",
			composeRel: "tests/e2e/g3/docker-compose.onesided.yml",
			project:    r.prefix + "-onesided",
			configDir:  filepath.Join(r.root, ".local", "g3-configs", "onesided"),
			wait:       []string{"pub", "peer"},
			nonNode:    map[string]bool{"nat": true},
			facilities: []facilityDef{
				{name: "one-sided", fn: r.facilityOneSided},
			},
			scenarioFns: []scenarioDef{
				{name: "one-sided-reachability", fn: r.scenarioOneSided},
			},
		},
		{
			name:       "symmetric",
			composeRel: "tests/e2e/g3/docker-compose.symmetric.yml",
			project:    r.prefix + "-symmetric",
			configDir:  filepath.Join(r.root, ".local", "g3-configs", "symmetric"),
			base:       []string{"relay"},
			wait:       []string{"relay", "a", "b"},
			nonNode:    map[string]bool{"nat-a": true, "nat-b": true},
			facilities: []facilityDef{
				{name: "symmetric-nat", fn: r.facilitySymmetric},
			},
			scenarioFns: []scenarioDef{
				{name: "symmetric-nat-relay-only", fn: r.scenarioSymmetric},
			},
		},
		{
			name:       "dualnat",
			composeRel: "tests/e2e/g3/docker-compose.dualnat.yml",
			project:    r.prefix + "-dualnat",
			configDir:  filepath.Join(r.root, ".local", "g3-configs", "dualnat"),
			base:       []string{"r1", "r2", "wan-probe"},
			wait:       []string{"r1", "r2", "a-quic", "b-quic", "a-tcp", "b-tcp", "a-relay", "b-relay"},
			nonNode:    map[string]bool{"nat-a": true, "nat-b": true, "wan-probe": true},
			facilities: []facilityDef{
				{name: "dual-nat-strict", fn: r.facilityDualNAT},
				{name: "nat13-wan-filter", fn: r.facilityNAT13},
			},
			scenarioFns: []scenarioDef{
				{name: "dual-nat-quic-direct-stop-relays", fn: r.scenarioDualNATQUIC},
				{name: "dual-nat-tcp", allowBlocked: true, fn: r.scenarioDualNATTCP},
				{name: "relay-failover-recovery", fn: r.scenarioRelayFailover},
			},
		},
		{
			name:       "ipv6fw",
			composeRel: "tests/e2e/g3/docker-compose.ipv6fw.yml",
			project:    r.prefix + "-ipv6fw",
			configDir:  filepath.Join(r.root, ".local", "g3-configs", "ipv6fw"),
			base:       []string{"relay", "wan-probe", "fw-a", "fw-b"},
			wait:       []string{"relay", "wan-probe", "a-quic", "b-quic", "a-tcp", "b-tcp", "a-relay", "b-relay", "one-a", "one-b"},
			nonNode:    map[string]bool{"fw-a": true, "fw-b": true},
			facilities: []facilityDef{
				{name: "ipv6-stateful-firewall", fn: r.facilityIPv6Firewall},
			},
			scenarioFns: []scenarioDef{
				{name: "ipv6fw-unsolicited-inbound-blocked", fn: r.scenarioIPv6FWUnsolicited},
				{name: "ipv6fw-tcp-direct", allowBlocked: true, fn: r.scenarioIPv6FWTCP},
				{name: "ipv6fw-relay-quic-direct-stop-relay", fn: r.scenarioIPv6FWDirect},
				{name: "ipv6fw-one-sided-firewall", fn: r.scenarioIPv6FWOneSided},
			},
		},
	}
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
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = r.root
	out, err := cmd.CombinedOutput()
	if err != nil {
		return strings.TrimSpace(string(out)) + " (" + err.Error() + ")"
	}
	return strings.TrimSpace(string(out))
}

func (r *runner) composeEnv() []string {
	if r.stack == nil {
		return os.Environ()
	}
	extra := r.extraArgs
	if r.lab != "" {
		if v := os.Getenv("G3_LAB_EXTRA_ARGS"); v != "" {
			extra = v
		}
	}
	return append(os.Environ(), "G3_CONFIG_DIR="+r.stack.configDir, "G3_EXTRA_ARGS="+extra)
}

func (r *runner) compose(st *stackInfo, args ...string) (string, int) {
	full := append([]string{"compose", "-p", st.project, "-f", st.composeRel}, args...)
	return r.recordCommand("host", "docker", full...)
}

func (r *runner) exec(service string, args ...string) (string, int) {
	full := []string{"compose", "-p", r.stack.project, "-f", r.stack.composeRel, "exec", "-T", service}
	full = append(full, args...)
	return r.recordCommand(service, "docker", full...)
}

func (r *runner) quiet(service string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	full := []string{"compose", "-p", r.stack.project, "-f", r.stack.composeRel, "exec", "-T", service}
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
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
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
	rec := commandRecord{
		At:     time.Now().UTC().Format(time.RFC3339),
		Where:  where,
		Args:   r.redactArgs(args),
		Code:   code,
		Output: s,
	}
	if r.current != nil {
		r.current.Commands = append(r.current.Commands, rec)
	}
	if r.facility != nil {
		r.facility.Commands = append(r.facility.Commands, rec)
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

func (r *runner) redact(s string) string { return r.hexToken.ReplaceAllString(s, "<redacted-64-hex>") }

func (r *runner) beginScenario(name string) {
	r.ev.Scenarios = append(r.ev.Scenarios, &scenarioEvidence{Name: name})
	r.current = r.ev.Scenarios[len(r.ev.Scenarios)-1]
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

func (r *runner) finishScenario(status string, err error, allowBlocked bool) {
	if r.current == nil {
		return
	}
	pass := status == "PASS" || (allowBlocked && status == "BLOCKED")
	for _, c := range r.current.Checks {
		if !c.Pass {
			pass = false
		}
	}
	if err != nil || !pass {
		r.current.Status = "FAIL"
	} else {
		r.current.Status = status
	}
	if err != nil {
		r.current.Error = r.redact(err.Error())
	}
	r.current.Accepted = r.current.Status == "PASS" || (allowBlocked && r.current.Status == "BLOCKED")
	r.current = nil
}

func (r *runner) beginFacility(name string) {
	r.ev.Facilities = append(r.ev.Facilities, &facilityEvidence{Name: name})
	r.facility = r.ev.Facilities[len(r.ev.Facilities)-1]
}

func (r *runner) addCheckToFacility(name string, pass bool, detail string) {
	if r.facility == nil {
		return
	}
	r.facility.Checks = append(r.facility.Checks, check{Name: name, Pass: pass, Detail: r.redact(detail)})
}

func (r *runner) requireFacility(name string, err error) bool {
	if err != nil {
		r.addCheckToFacility(name, false, err.Error())
		return false
	}
	r.addCheckToFacility(name, true, "ok")
	return true
}

func (r *runner) finishFacility(status string, err error) {
	if r.facility == nil {
		return
	}
	pass := status == "PASS" || status == "BLOCKED"
	for _, c := range r.facility.Checks {
		if !c.Pass {
			pass = false
		}
	}
	if err != nil || !pass {
		r.facility.Status = "FAIL"
	} else {
		r.facility.Status = status
	}
	if err != nil {
		r.facility.Error = r.redact(err.Error())
	}
	r.facility = nil
}

func (r *runner) natSet(id, scenario, status, detail string) {
	if r.nat == nil {
		r.nat = make(map[string]*natMapping)
	}
	r.nat[id] = &natMapping{ID: id, Scenario: scenario, Status: status, Detail: r.redact(detail)}
}

func (r *runner) buildNATMapping() {
	if len(r.only) == 0 && len(r.ev.Stacks) >= 4 {
		r.natSet("NAT12", "make e2e-g3", "PASS", "one automated entry; -only/-keep reuse the same compose files, runner and cleanup path")
	}
	ids := []string{"NAT01", "NAT02", "NAT03", "NAT04", "NAT05", "NAT06", "NAT07", "NAT08", "NAT09", "NAT10", "NAT11", "NAT12", "NAT13"}
	if len(r.only) > 0 {
		r.ev.NATMapping = nil
		for _, id := range ids {
			if m, ok := r.nat[id]; ok {
				r.ev.NATMapping = append(r.ev.NATMapping, m)
			}
		}
		return
	}
	for _, id := range ids {
		m, ok := r.nat[id]
		if !ok {
			m = &natMapping{ID: id, Scenario: "not-run", Status: "NOT_TESTED", Detail: "not exercised in this run"}
		}
		r.ev.NATMapping = append(r.ev.NATMapping, m)
	}
	sort.Slice(r.ev.NATMapping, func(i, j int) bool { return r.ev.NATMapping[i].ID < r.ev.NATMapping[j].ID })
}

func (r *runner) writeConfig(service, cfg string) error {
	path := filepath.Join(r.stack.configDir, service+".toml")
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		return err
	}
	return nil
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

func (r *runner) connectPeer(service, peerID string) (*apiv1.ConnectResponse, error) {
	out, code := r.exec(service, "raminga", "connect", peerID, "--data-dir", "/data", "--json")
	if code != 0 {
		return nil, fmt.Errorf("%s connect %s exit %d: %s", service, peerID, code, out)
	}
	var res apiv1.ConnectResponse
	if err := protojson.Unmarshal([]byte(out), &res); err != nil {
		return nil, fmt.Errorf("%s connect peer decode: %w (%s)", service, err, out)
	}
	return &res, nil
}

func (r *runner) peersAdd(service, multiaddr string) error {
	out, code := r.exec(service, "raminga", "peers", "add", multiaddr, "--data-dir", "/data")
	if code != 0 {
		return fmt.Errorf("%s peers add exit %d: %s", service, code, out)
	}
	return nil
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

func (r *runner) waitPeerOffline(service, peerID string, timeout time.Duration) error {
	_, err := r.waitFor("peer offline "+peerID, timeout, func() (bool, string, error) {
		st, err := r.status(service)
		if err != nil {
			return false, "", err
		}
		for _, c := range st.GetConnections() {
			if c.GetPeerId() == peerID {
				return false, fmt.Sprintf("connection still present: %s", c.GetRemoteMultiaddr()), nil
			}
		}
		p := peerIn(st, peerID)
		return true, fmt.Sprintf("no connection; peer=%v", p), nil
	})
	return err
}

func (r *runner) conntrack(service, proto, port string) (string, error) {
	out, code := r.exec(service, "sh", "-c", fmt.Sprintf("conntrack -L -p %s 2>/dev/null | grep -E 'sport=%s|dport=%s' || true", proto, port, port))
	if code != 0 {
		return "", fmt.Errorf("%s conntrack exit %d: %s", service, code, out)
	}
	return out, nil
}

func (r *runner) iptables(service string) (string, error) {
	out, code := r.exec(service, "sh", "-c", "iptables -w 5 -t nat -S; echo ---; iptables -w 5 -S FORWARD")
	if code != 0 {
		return "", fmt.Errorf("%s iptables exit %d: %s", service, code, out)
	}
	return out, nil
}

func (r *runner) ip6tables(service string) (string, error) {
	out, code := r.exec(service, "sh", "-c", "ip6tables -w 5 -S; echo ---; ip6tables -w 5 -S INPUT")
	if code != 0 {
		return "", fmt.Errorf("%s ip6tables exit %d: %s", service, code, out)
	}
	return out, nil
}

func (r *runner) composeLogs(service string) string {
	out, _ := r.compose(r.stack, "logs", "--no-color", "--tail", "400", service)
	return out
}

func (r *runner) writeEvidence() error {
	data, err := json.MarshalIndent(r.ev, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := evsum.WriteRaw(r.root, "g3", data); err != nil {
		return err
	}
	summary, err := evsum.Summarize(data, "g3")
	if err != nil {
		return err
	}
	path, err := evsum.Write(r.evidenceDir, "g3", summary)
	if err != nil {
		return err
	}
	if err := evsum.WritePointer(r.evidenceDir, filepath.Base(path)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(os.Stdout, "g3: wrote summary %s\n", path)
	return nil
}

func peerIn(st *apiv1.StatusResponse, peerID string) *apiv1.PeerStatus {
	for _, p := range st.GetPeers() {
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

func boolError(ok bool, detail string) error {
	if ok {
		return nil
	}
	return fmt.Errorf("%s", detail)
}

func (r *runner) facilityPassed() bool {
	if r.facility == nil {
		return false
	}
	for _, c := range r.facility.Checks {
		if !c.Pass {
			return false
		}
	}
	return true
}

func (r *runner) scenarioPassed() bool {
	if r.current == nil {
		return false
	}
	for _, c := range r.current.Checks {
		if !c.Pass {
			return false
		}
	}
	return true
}
