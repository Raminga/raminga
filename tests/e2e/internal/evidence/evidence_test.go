package evidence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummarizeDropsCommandsAndTruncates(t *testing.T) {
	raw := []byte(`{
	  "generated_at":"2026-10-31T07:05:00Z","branch":"b","commit":"c","go_version":"go1.27.3",
	  "overall":"PASS","scenarios":[{"name":"s","status":"PASS","checks":[{"name":"direct addr","pass":true,"detail":"` + strings.Repeat("x", 1000) + `"}]}],
	  "commands":[{"args":["status"],"output":"` + strings.Repeat("secret ", 10000) + `"}]
	}`)
	s, err := Summarize(raw, "g1")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Scenarios) != 1 || len(s.Scenarios[0].Checks) != 1 || len(s.Scenarios[0].Checks[0].Detail) > MaxDetail+len("…") {
		t.Fatalf("summary shape: %+v", s)
	}
	b, _ := json.Marshal(s)
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "commands") {
		t.Fatalf("raw command output leaked: %s", b)
	}
	if len(b) > MaxSummary {
		t.Fatalf("summary too large: %d", len(b))
	}
}

func TestWritePointerAndCheckText(t *testing.T) {
	dir := t.TempDir()
	s := Summary{SchemaVersion: SchemaVersion, Phase: "g2", GeneratedAt: "2026-10-31T07:25:25Z", Overall: "PASS"}
	path, err := Write(dir, "g2", s)
	if err != nil {
		t.Fatal(err)
	}
	if err := WritePointer(dir, filepath.Base(path)); err != nil {
		t.Fatal(err)
	}
	got, err := ReadPointer(dir)
	if err != nil || got != filepath.Base(path) {
		t.Fatalf("pointer = %q %v", got, err)
	}
	bin := filepath.Join(dir, "tuiwalk")
	if err := os.WriteFile(bin, []byte("ELF\x00binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CheckText(bin); err == nil {
		t.Fatal("binary file passed CheckText")
	}
}
