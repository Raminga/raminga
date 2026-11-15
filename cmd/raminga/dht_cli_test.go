//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/config"
)

func assertTextLine(t *testing.T, out, want string) {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if line == want {
			return
		}
	}
	t.Fatalf("output lacks line %q:\n%s", want, out)
}

func TestDHTTextStatusKeepsLegacyModeAndShowsActiveMode(t *testing.T) {
	bin := requireCLI(t)
	dir := initNodeDir(t, bin)
	stopCleanup(t, dir)

	// Configured server but disabled: active_mode must differ from the
	// compatibility mode field, so an implementation that echoes the
	// configured value as the active role cannot pass this assertion.
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.DHT.Enabled = false
	cfg.DHT.Mode = "server"
	raw, err := config.RenderTOML(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.Path(dir), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("restart: %v\nstderr=%s", err, stderr)
	}

	stdout, stderr, err := runCLI(t, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status: %v\nstderr=%s", err, stderr)
	}
	assertTextLine(t, stdout, "mode: server")
	assertTextLine(t, stdout, "configured_mode: server")
	assertTextLine(t, stdout, "active_mode: disabled")

	stdout, stderr, err = runCLI(t, nil, "network", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("network status: %v\nstderr=%s", err, stderr)
	}
	for _, want := range []string{" mode=server ", " configured_mode=server ", " active_mode=disabled "} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("network status lacks %q:\n%s", want, stdout)
		}
	}
}
