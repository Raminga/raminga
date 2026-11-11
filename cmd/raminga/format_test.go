package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
)

func TestHumanBytes(t *testing.T) {
	if got := humanBytes(16); got != "16 B" {
		t.Fatalf("humanBytes(16) = %q", got)
	}
	if got := humanBytes(1536); got != "1.5 KiB" {
		t.Fatalf("humanBytes(1536) = %q", got)
	}
}

func TestWriteSizedRowsAlignsByDisplayWidth(t *testing.T) {
	var buf bytes.Buffer
	writeSizedRows(&buf, []sizeRow{
		{Path: "posts/a.md", Size: 16, Extra: "  modified=1 sha256=aa"},
		{Path: "中文.md", Size: 1024, Extra: "  modified=2 sha256=bb"},
	}, "  ")
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %q", buf.String())
	}
	for _, line := range lines {
		if !strings.Contains(line, "16 B") && !strings.Contains(line, "1.0 KiB") {
			t.Fatalf("size not human-readable: %q", line)
		}
		if !strings.HasPrefix(line, "  ") {
			t.Fatalf("indent missing: %q", line)
		}
	}
	// Both size columns start at the same display cell after the widest path.
	first := strings.Index(lines[0], "16 B")
	second := strings.Index(lines[1], "1.0 KiB")
	if first < 0 || second < 0 || ansi.StringWidth(lines[0][:first]) != ansi.StringWidth(lines[1][:second]) {
		t.Fatalf("size columns misaligned:\n%s\n%s", lines[0], lines[1])
	}
}

func TestCLIErrTextStripsConnectCodePrefix(t *testing.T) {
	err := connect.NewError(connect.CodeUnavailable, errors.New("dial failed"))
	if got := cliErrText(err); got != "dial failed" {
		t.Fatalf("cliErrText = %q", got)
	}
	if got := cliErrText(errors.New("plain")); got != "plain" {
		t.Fatalf("cliErrText plain = %q", got)
	}
}
