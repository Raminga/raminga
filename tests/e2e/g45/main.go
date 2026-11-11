// Command g45 validates a TUI-exported test report for the G4.5 lab
// walkthrough. It is evidence tooling, not part of the shipped node.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Raminga/raminga/internal/report"
)

var tokenPattern = regexp.MustCompile(`\b[0-9a-f]{64}\b`)

func main() {
	var (
		reportPath     = flag.String("report", "", "report JSON to validate")
		schemaPath     = flag.String("schema", "docs/schemas/test-report.schema.json", "JSON Schema path")
		forbid         = flag.String("forbid", "", "comma-separated text markers that must not appear")
		summary        = flag.String("summary", "", "write a JSON validation summary here")
		lab            = flag.String("lab", "", "lab name for the summary")
		minACKs        = flag.Int("min-acks", 2, "minimum ACK rows")
		requireStop    = flag.Bool("require-still-direct", true, "require still_direct_after_relay_stop=true")
		requireUpgrade = flag.Bool("require-relay-upgrade", true, "require relay timeline and relay->direct change")
		requireDirect  = flag.Bool("require-direct", true, "require a direct timeline event")
	)
	flag.Parse()
	if *reportPath == "" {
		fmt.Fprintln(os.Stderr, "g45: -report is required")
		os.Exit(2)
	}
	if err := run(*reportPath, *schemaPath, *forbid, *summary, *lab, *minACKs, *requireStop, *requireUpgrade, *requireDirect); err != nil {
		fmt.Fprintf(os.Stderr, "FAIL g45 validation: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("PASS g45 report validation")
}

func run(path, schemaPath, forbid, summaryPath, lab string, minACKs int, requireStop, requireUpgrade, requireDirect bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read report: %w", err)
	}
	if err := report.ValidateFile(raw, schemaPath); err != nil {
		return err
	}
	var doc struct {
		SchemaVersion       string `json:"schema_version"`
		MessageTextIncluded bool   `json:"message_text_included"`
		StillDirect         *bool  `json:"still_direct_after_relay_stop"`
		StillSeconds        int    `json:"still_direct_observation_seconds"`
		Timeline            []struct {
			Kind  string `json:"kind"`
			Route string `json:"route"`
		} `json:"connection_timeline"`
		RouteChanges []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"route_changes"`
		ACKs []struct {
			Acked bool `json:"acked"`
		} `json:"acks"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("decode report: %w", err)
	}
	checks := map[string]bool{
		"schema":                        true,
		"text_redacted":                 !doc.MessageTextIncluded,
		"still_direct_after_relay_stop": !requireStop || (doc.StillDirect != nil && *doc.StillDirect),
		"direct_observed_at_least_10s":  !requireStop || doc.StillSeconds >= 10,
		"relay_timeline_observed":       !requireUpgrade,
		"direct_timeline_observed":      !requireDirect,
		"relay_to_direct_change":        !requireUpgrade,
		"acks_all_true":                 len(doc.ACKs) >= minACKs,
	}
	for _, e := range doc.Timeline {
		switch e.Route {
		case "relay":
			checks["relay_timeline_observed"] = true
		case "direct":
			checks["direct_timeline_observed"] = true
		}
	}
	for _, c := range doc.RouteChanges {
		if c.From == "relay" && c.To == "direct" {
			checks["relay_to_direct_change"] = true
		}
	}
	for _, a := range doc.ACKs {
		if !a.Acked {
			checks["acks_all_true"] = false
		}
	}
	for _, marker := range strings.Split(forbid, ",") {
		marker = strings.TrimSpace(marker)
		if marker != "" && strings.Contains(string(raw), marker) {
			checks["text_redacted"] = false
		}
	}
	if tokenPattern.Match(raw) {
		checks["text_redacted"] = false
	}
	for _, marker := range []string{"BEGIN PRIVATE KEY", "PRIVATE KEY", "api_token", "Bearer ", `"text":`} {
		if strings.Contains(string(raw), marker) {
			checks["text_redacted"] = false
		}
	}
	var failed []string
	for name, ok := range checks {
		if !ok {
			failed = append(failed, name)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("failed checks: %s", strings.Join(failed, ", "))
	}
	if summaryPath != "" {
		if err := os.MkdirAll(filepath.Dir(summaryPath), 0o755); err != nil {
			return err
		}
		out := map[string]any{
			"result":         "PASS",
			"lab":            lab,
			"validated_at":   time.Now().UTC().Format(time.RFC3339),
			"report":         path,
			"schema_version": doc.SchemaVersion,
			"checks":         checks,
		}
		b, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(summaryPath, append(b, '\n'), 0o644); err != nil {
			return err
		}
	}
	return nil
}
