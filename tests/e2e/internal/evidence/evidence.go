// Package evidence converts verbose e2e output into compact committed
// summaries while keeping raw command output under .local/evidence.
package evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	SchemaVersion = "raminga.e2e-summary/1"
	MaxDetail     = 300
	MaxSummary    = 100 * 1024
)

// Check is one named assertion with a short, human-readable detail.
type Check struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
}

// Scenario is one compact scenario result.
type Scenario struct {
	Name     string            `json:"name"`
	Status   string            `json:"status"`
	Accepted *bool             `json:"accepted,omitempty"`
	Checks   []Check           `json:"checks,omitempty"`
	Facts    map[string]string `json:"facts,omitempty"`
}

// Summary is the only JSON written under tests/e2e/evidence.
type Summary struct {
	SchemaVersion  string            `json:"schema_version"`
	Phase          string            `json:"phase"`
	GeneratedAt    string            `json:"generated_at"`
	Branch         string            `json:"branch,omitempty"`
	Commit         string            `json:"commit,omitempty"`
	GoVersion      string            `json:"go_version,omitempty"`
	DockerVersion  string            `json:"docker_version,omitempty"`
	ComposeVersion string            `json:"compose_version,omitempty"`
	Image          string            `json:"image,omitempty"`
	Topology       string            `json:"topology,omitempty"`
	Overall        string            `json:"overall"`
	Note           string            `json:"note,omitempty"`
	Scenarios      []Scenario        `json:"scenarios"`
	Facilities     []Scenario        `json:"facilities,omitempty"`
	Facts          map[string]string `json:"facts,omitempty"`
}

type genericCheck struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	OK     *bool  `json:"ok"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Msg    string `json:"message"`
}

type genericScenario struct {
	Name     string         `json:"name"`
	ID       string         `json:"id"`
	Status   string         `json:"status"`
	Result   string         `json:"result"`
	Accepted *bool          `json:"accepted"`
	Checks   []genericCheck `json:"checks"`
}

type genericRaw struct {
	GeneratedAt    string                     `json:"generated_at"`
	ValidatedAt    string                     `json:"validated_at"`
	Branch         string                     `json:"branch"`
	Commit         string                     `json:"commit"`
	GoVersion      string                     `json:"go_version"`
	DockerVersion  string                     `json:"docker_version"`
	ComposeVersion string                     `json:"compose_version"`
	Image          string                     `json:"image"`
	Topology       any                        `json:"topology"`
	Overall        string                     `json:"overall"`
	Note           string                     `json:"note"`
	Scenarios      []genericScenario          `json:"scenarios"`
	Facilities     []genericScenario          `json:"facilities"`
	Checks         []genericCheck             `json:"checks"`
	Lab            string                     `json:"lab"`
	Result         string                     `json:"result"`
	Report         string                     `json:"report"`
	Schema         string                     `json:"schema_version"`
	Mapping        any                        `json:"nat01_nat13_mapping"`
	Thresholds     string                     `json:"thresholds_doc"`
	Extra          map[string]json.RawMessage `json:"-"`
}

// Summarize turns a raw evidence JSON blob into a bounded summary. Unknown
// fields are ignored; command output is never included.
func Summarize(raw []byte, phase string) (Summary, error) {
	var g genericRaw
	if err := json.Unmarshal(raw, &g); err != nil {
		return Summary{}, fmt.Errorf("parse raw evidence: %w", err)
	}
	s := Summary{SchemaVersion: SchemaVersion, Phase: phase, Branch: g.Branch, Commit: g.Commit,
		GoVersion: g.GoVersion, DockerVersion: g.DockerVersion, ComposeVersion: g.ComposeVersion,
		Image: g.Image, Overall: g.Overall, Note: Truncate(g.Note, 400)}
	if g.GeneratedAt != "" {
		s.GeneratedAt = g.GeneratedAt
	} else if g.ValidatedAt != "" {
		s.GeneratedAt = g.ValidatedAt
	} else {
		s.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if s.Overall == "" {
		s.Overall = g.Result
	}
	if g.Topology != nil {
		if b, err := json.Marshal(g.Topology); err == nil {
			s.Topology = Truncate(string(b), 400)
		}
	}
	if g.Lab != "" {
		s.Phase = g.Lab
	}
	s.Scenarios = compactScenarios(g.Scenarios)
	s.Facilities = compactScenarios(g.Facilities)
	if g.Lab != "" && len(s.Scenarios) == 0 && len(g.Checks) > 0 {
		s.Scenarios = []Scenario{{Name: g.Lab, Status: s.Overall, Checks: compactChecks(g.Checks)}}
	}
	s.Facts = map[string]string{}
	if g.Mapping != nil {
		if b, err := json.Marshal(g.Mapping); err == nil {
			s.Facts["nat01_nat13_mapping"] = Truncate(string(b), 900)
		}
	}
	if g.Thresholds != "" {
		s.Facts["thresholds_doc"] = Truncate(g.Thresholds, 300)
	}
	if g.Report != "" {
		s.Facts["report"] = Truncate(g.Report, 300)
	}
	if len(s.Facts) == 0 {
		s.Facts = nil
	}
	return s, nil
}

func compactScenarios(in []genericScenario) []Scenario {
	out := make([]Scenario, 0, len(in))
	for _, sc := range in {
		name := sc.Name
		if name == "" {
			name = sc.ID
		}
		status := sc.Status
		if status == "" {
			status = sc.Result
		}
		s := Scenario{Name: Truncate(name, 160), Status: Truncate(status, 40), Accepted: sc.Accepted}
		s.Checks = compactChecks(sc.Checks)
		s.Facts = selectFacts(sc.Checks)
		out = append(out, s)
	}
	return out
}

func compactChecks(in []genericCheck) []Check {
	out := make([]Check, 0, len(in))
	for _, c := range in {
		pass := c.Pass
		if c.OK != nil {
			pass = *c.OK
		}
		detail := c.Detail
		if detail == "" {
			detail = c.Msg
		}
		out = append(out, Check{Name: Truncate(c.Name, 160), Pass: pass, Detail: Truncate(detail, MaxDetail)})
	}
	return out
}

func selectFacts(checks []genericCheck) map[string]string {
	keys := []string{"direct", "route", "transport", "ack", "dcutr", "relay", "threshold", "multiaddr", "conntrack", "peer"}
	facts := map[string]string{}
	for _, c := range checks {
		low := strings.ToLower(c.Name)
		match := false
		for _, k := range keys {
			if strings.Contains(low, k) {
				match = true
				break
			}
		}
		if !match || len(facts) >= 10 {
			continue
		}
		detail := c.Detail
		if detail == "" {
			detail = c.Msg
		}
		if detail == "" || detail == "ok" {
			continue
		}
		facts[Truncate(c.Name, 100)] = Truncate(detail, MaxDetail)
	}
	if len(facts) == 0 {
		return nil
	}
	return facts
}

// Fit shrinks a summary until its JSON is under MaxSummary.
func Fit(s Summary) Summary {
	for _, limit := range []int{MaxDetail, 120, 60, 30} {
		for i := range s.Scenarios {
			for j := range s.Scenarios[i].Checks {
				s.Scenarios[i].Checks[j].Detail = Truncate(s.Scenarios[i].Checks[j].Detail, limit)
			}
			for k, v := range s.Scenarios[i].Facts {
				s.Scenarios[i].Facts[k] = Truncate(v, limit)
			}
		}
		b, _ := json.MarshalIndent(s, "", "  ")
		if len(b) <= MaxSummary {
			return s
		}
	}
	return s
}

// Write writes a summary named <base>-summary-<stamp>.json and returns the path.
func Write(dir, base string, s Summary) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	s = Fit(s)
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return "", err
	}
	b = append(b, '\n')
	at, err := time.Parse(time.RFC3339, s.GeneratedAt)
	if err != nil {
		at = time.Now().UTC()
	}
	name := fmt.Sprintf("%s-summary-%s.json", base, at.UTC().Format("20060102T150405Z"))
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// WritePointer writes the tiny LATEST pointer (summary filename only).
func WritePointer(dir, filename string) error {
	if filename == "" {
		return errors.New("empty pointer")
	}
	return os.WriteFile(filepath.Join(dir, "LATEST"), []byte(filename+"\n"), 0o644)
}

// ReadPointer returns the summary filename from LATEST.
func ReadPointer(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "LATEST"))
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(string(b))
	if name == "" || strings.ContainsAny(name, `/\`) {
		return "", fmt.Errorf("invalid LATEST pointer %q", name)
	}
	return name, nil
}

// RawDir is the gitignored raw evidence root for a phase.
func RawDir(root, phase string) string { return filepath.Join(root, ".local", "evidence", phase) }

// WriteRaw stores full output under .local/evidence/<phase>/<stamp>/evidence.json
// and updates <phase>/latest-raw.json for merge modes.
func WriteRaw(root, phase string, raw []byte) (string, error) {
	dir := RawDir(root, phase)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	runDir := filepath.Join(dir, stamp)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(runDir, "evidence.json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "latest-raw.json"), raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// ReadRawLatest reads the merge-mode raw evidence.
func ReadRawLatest(root, phase string) ([]byte, error) {
	return os.ReadFile(filepath.Join(RawDir(root, phase), "latest-raw.json"))
}

// Truncate collapses control whitespace and caps a string.
func Truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	if n <= 0 {
		return ""
	}
	return s[:n] + "…"
}

// CheckText rejects binary/NUL files before they are copied to evidence.
func CheckText(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if bytes.IndexByte(b, 0) >= 0 {
		return fmt.Errorf("%s is binary (NUL byte)", path)
	}
	return nil
}

// SortedNames returns sorted map keys (useful for deterministic pointers).
func SortedNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
