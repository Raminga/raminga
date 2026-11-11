// Command e2e is the unified entry point for the G1, G2 and G3 Docker suites.
//
// Each suite is an independent runner that writes tests/e2e/evidence/<suite>/
// LATEST + summary. This command runs them in order, keeps full logs under
// .local/e2e/, and prints one compact per-suite summary. It does not publish
// host ports or share Docker networks across suites.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type suiteEvidence struct {
	Overall   string `json:"overall"`
	Scenarios []struct {
		Name     string `json:"name"`
		Status   string `json:"status"`
		Accepted bool   `json:"accepted"`
	} `json:"scenarios"`
	Facilities []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"facilities"`
}

type suiteResult struct {
	Name       string
	ExitCode   int
	Evidence   suiteEvidence
	LogPath    string
	LogTail    []string
	Passed     int
	Failed     int
	Blocked    int
	NotTested  int
	Facilities int
	FacPassed  int
}

func main() { os.Exit(run()) }

func run() int {
	var (
		suites = flag.String("suites", "g1,g2,g3", "comma-separated suites to run")
		keep   = flag.Bool("keep", false, "keep compose containers/volumes")
	)
	flag.Parse()

	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: getwd: %v\n", err)
		return 1
	}
	logDir := filepath.Join(root, ".local", "e2e")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: create log dir: %v\n", err)
		return 1
	}
	var results []*suiteResult
	for _, name := range splitList(*suites) {
		results = append(results, runSuite(root, logDir, name, *keep))
	}
	failed := printSummary(results)
	if failed {
		return 1
	}
	return 0
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func runSuite(root, logDir, name string, keep bool) *suiteResult {
	res := &suiteResult{Name: name}
	logPath := filepath.Join(logDir, name+".log")
	res.LogPath = logPath
	logFile, err := os.Create(logPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: create %s log: %v\n", name, err)
		return res
	}
	defer func() { _ = logFile.Close() }()

	args := []string{"run", "./tests/e2e/" + name}
	if keep {
		args = append(args, "-keep")
	}
	_, _ = fmt.Fprintf(os.Stdout, "\n=== %s: go %s ===\n", strings.ToUpper(name), strings.Join(args, " "))
	cmd := exec.Command("go", args...)
	cmd.Dir = root
	cmd.Stdout = io.MultiWriter(os.Stdout, logFile)
	cmd.Stderr = io.MultiWriter(os.Stderr, logFile)
	err = cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
		} else {
			res.ExitCode = -1
		}
	}
	readEvidence(filepath.Join(root, "tests", "e2e", "evidence", name), &res.Evidence)
	for _, sc := range res.Evidence.Scenarios {
		switch sc.Status {
		case "PASS":
			res.Passed++
		case "FAIL":
			res.Failed++
		case "BLOCKED":
			res.Blocked++
		default:
			res.NotTested++
		}
	}
	res.Facilities = len(res.Evidence.Facilities)
	for _, f := range res.Evidence.Facilities {
		if f.Status == "PASS" || f.Status == "BLOCKED" {
			res.FacPassed++
		}
	}
	if res.ExitCode != 0 || res.Evidence.Overall != "PASS" {
		data, _ := os.ReadFile(logPath)
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) > 60 {
			lines = lines[len(lines)-60:]
		}
		res.LogTail = lines
	}
	return res
}

func readEvidence(dir string, out *suiteEvidence) {
	ptr, err := os.ReadFile(filepath.Join(dir, "LATEST"))
	if err != nil {
		return
	}
	name := strings.TrimSpace(string(ptr))
	if name == "" || strings.ContainsAny(name, `/\`) {
		return
	}
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, out)
}

func printSummary(results []*suiteResult) bool {
	_, _ = fmt.Fprintf(os.Stdout, "\n== make e2e summary ==\n")
	failed := false
	for _, res := range results {
		status := res.Evidence.Overall
		if status == "" {
			status = "FAIL"
		}
		if res.ExitCode != 0 || status != "PASS" {
			failed = true
			status = "FAIL"
		}
		total := res.Passed + res.Failed + res.Blocked + res.NotTested
		detail := fmt.Sprintf("%d/%d scenarios", res.Passed, total)
		if res.Blocked > 0 {
			detail += fmt.Sprintf(", %d BLOCKED accepted", res.Blocked)
		}
		if res.Failed > 0 || res.NotTested > 0 {
			detail += fmt.Sprintf(", failed=%d not_tested=%d", res.Failed, res.NotTested)
		}
		if res.Facilities > 0 {
			detail += fmt.Sprintf("; facilities %d/%d PASS", res.FacPassed, res.Facilities)
		}
		_, _ = fmt.Fprintf(os.Stdout, "%-3s %-5s %s\n", strings.ToUpper(res.Name), status, detail)
		if res.LogTail != nil {
			_, _ = fmt.Fprintf(os.Stdout, "    log: %s\n", res.LogPath)
			for _, line := range res.LogTail {
				_, _ = fmt.Fprintf(os.Stdout, "    | %s\n", line)
			}
		}
	}
	if failed {
		_, _ = fmt.Fprintf(os.Stdout, "overall FAIL\n")
		return true
	}
	_, _ = fmt.Fprintf(os.Stdout, "overall PASS\n")
	return false
}
