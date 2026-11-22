//go:build !windows

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/storage"
)

func TestDaemonLegacyBootstrapValidationAndMarkerRecovery(t *testing.T) {
	requireCLI(t)
	dir := shortTempDir(t)
	configPath := config.Path(dir)
	valid := "/ip4/127.0.0.1/tcp/45999/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"
	validPeer := "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"

	// An invalid first input must fail before a marker is written.
	if err := os.WriteFile(configPath, []byte("[dht]\nbootstrap_peers = [\"not-a-multiaddr\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err == nil {
		t.Fatalf("invalid first bootstrap input unexpectedly started:\n%s", stderr)
	}
	store, err := storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	imported, err := store.BootstrapImported(context.Background())
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if imported {
		_ = store.Close()
		t.Fatal("invalid first import wrote the marker")
	}
	_ = store.Close()

	// A valid multiaddress imports exactly once and becomes a saved role.
	cfg := config.Default()
	cfg.Network.ListenAddrs = []string{"/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/udp/0/quic-v1"}
	cfg.Network.AnnounceAddrs = nil
	cfg.DHT.Mode = "client"
	cfg.DHT.BootstrapPeers = []string{valid}
	cfg.DHT.RefreshInterval = "10s"
	raw, err := config.RenderTOML(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	stopCleanup(t, dir)
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("valid first bootstrap input failed: %v\n%s", err, stderr)
	}
	stdout, stderr, err := runCLI(t, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: ["+valid+"]") {
		t.Fatalf("valid role not listed:\n%s", stdout)
	}

	// Remove the role, leave the old TOML address invalid, then restart. The
	// committed marker makes the legacy string dormant; the daemon must start,
	// expose an empty role list, and never rewrite the existing TOML.
	if _, stderr, err := runCLI(t, nil, "stop", "--data-dir", dir); err != nil {
		t.Fatalf("stop: %v\n%s", err, stderr)
	}
	store, err = storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if removed, err := store.RemoveBootstrapPeer(context.Background(), validPeer); err != nil || !removed {
		_ = store.Close()
		t.Fatalf("remove role = %t, %v", removed, err)
	}
	_ = store.Close()

	edited := bytes.Replace(raw, []byte(valid), []byte("not-a-multiaddr"), 1)
	if bytes.Equal(edited, raw) {
		t.Fatal("test config did not contain the valid bootstrap address")
	}
	if err := os.WriteFile(configPath, edited, 0o600); err != nil {
		t.Fatal(err)
	}
	beforeRestart, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("restart with dormant invalid old bootstrap string: %v\n%s", err, stderr)
	}
	stdout, stderr, err = runCLI(t, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status after restart: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: []") {
		t.Fatalf("removed role was resurrected:\n%s", stdout)
	}
	if _, stderr, err := runCLI(t, nil, "stop", "--data-dir", dir); err != nil {
		t.Fatalf("stop after restart: %v\n%s", err, stderr)
	}
	afterRestart, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeRestart, afterRestart) {
		t.Fatal("daemon rewrote config.toml with the dormant old bootstrap string")
	}

	// Missing-config recovery must read the marker before resolving a preset.
	// A non-empty sidecar is placed next to the daemon binary so a regression
	// would visibly refill config.toml; the marker must win instead.
	sidecar := filepath.Join(testCLIDir, config.BootstrapPresetFileName)
	sidecarAddr := "/ip4/127.0.0.1/tcp/45998/p2p/12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR"
	if err := os.WriteFile(sidecar, []byte("bootstrap_peers = [\""+sidecarAddr+"\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(sidecar) })
	if err := os.Remove(configPath); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLI(t, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("missing-config recovery failed: %v\n%s", err, stderr)
	}
	stdout, stderr, err = runCLI(t, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status after recovery: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: []") {
		t.Fatalf("missing-config recovery refilled the role:\n%s", stdout)
	}
	if _, stderr, err := runCLI(t, nil, "stop", "--data-dir", dir); err != nil {
		t.Fatalf("stop after recovery: %v\n%s", err, stderr)
	}
	recovered, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(recovered, []byte(sidecarAddr)) {
		t.Fatalf("recovered config absorbed the sidecar preset:\n%s", recovered)
	}
	if !strings.Contains(string(recovered), "bootstrap_peers = []") {
		t.Fatalf("recovered config is not explicitly empty:\n%s", recovered)
	}
	store, err = storage.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if imported, err := store.BootstrapImported(context.Background()); err != nil || !imported {
		t.Fatalf("marker after recovery = %t, %v", imported, err)
	}
	if roles, err := store.ListBootstrapPeers(context.Background()); err != nil || len(roles) != 0 {
		t.Fatalf("roles after recovery = %+v, %v", roles, err)
	}
}

func TestNewDataDirValidatesPresetBeforeDatabaseAndRecoveryIgnoresInvalid(t *testing.T) {
	requireCLI(t)
	binDir := shortTempDir(t)
	bin := filepath.Join(binDir, "raminga")
	rawBin, err := os.ReadFile(testCLIBin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, rawBin, 0o755); err != nil {
		t.Fatal(err)
	}
	sidecar := filepath.Join(binDir, config.BootstrapPresetFileName)
	malformedSidecar := []byte("bootstrap_peers = [\"not-a-multiaddr\"]\n")
	if err := os.WriteFile(sidecar, malformedSidecar, 0o644); err != nil {
		t.Fatal(err)
	}

	dir := shortTempDir(t)
	databasePath := filepath.Join(dir, storage.FileName)
	// Both attempts must fail during preset validation and leave no SQLite
	// file. A leftover database would turn the next attempt into recovery and
	// hide the malformed preset instead of failing loudly.
	for attempt := 1; attempt <= 2; attempt++ {
		_, stderr, err := runCLIAt(t, bin, nil, "restart", "--data-dir", dir)
		if err == nil {
			t.Fatalf("attempt %d with malformed selected preset started:\n%s", attempt, stderr)
		}
		if _, statErr := os.Stat(databasePath); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("attempt %d created SQLite before preset validation: %v", attempt, statErr)
		}
		if _, statErr := os.Stat(config.Path(dir)); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("attempt %d wrote config before preset validation: %v", attempt, statErr)
		}
	}

	validPeer := "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"
	validAddr := "/ip4/127.0.0.1/tcp/45997/p2p/" + validPeer
	validSidecar := []byte("bootstrap_peers = [\"" + validAddr + "\"]\n")
	if err := os.WriteFile(sidecar, validSidecar, 0o644); err != nil {
		t.Fatal(err)
	}
	stopCleanupAt(t, bin, dir)
	if _, stderr, err := runCLIAt(t, bin, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("corrected preset did not import: %v\n%s", err, stderr)
	}
	stdout, stderr, err := runCLIAt(t, bin, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: ["+validAddr+"]") {
		t.Fatalf("corrected preset role not listed:\n%s", stdout)
	}
	if _, stderr, err := runCLIAt(t, bin, nil, "stop", "--data-dir", dir); err != nil {
		t.Fatalf("stop: %v\n%s", err, stderr)
	}

	// An existing import marker is recovery: a malformed sidecar must be
	// ignored and the committed role must survive a missing config.
	if err := os.WriteFile(sidecar, malformedSidecar, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(config.Path(dir)); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := runCLIAt(t, bin, nil, "restart", "--data-dir", dir); err != nil {
		t.Fatalf("marker recovery read the malformed sidecar: %v\n%s", err, stderr)
	}
	stdout, stderr, err = runCLIAt(t, bin, nil, "dht", "status", "--data-dir", dir)
	if err != nil {
		t.Fatalf("dht status after marker recovery: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: ["+validAddr+"]") {
		t.Fatalf("marker recovery lost the committed role:\n%s", stdout)
	}
	if _, stderr, err := runCLIAt(t, bin, nil, "stop", "--data-dir", dir); err != nil {
		t.Fatalf("stop after marker recovery: %v\n%s", err, stderr)
	}
	recovered, err := os.ReadFile(config.Path(dir))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(recovered), validAddr) || !strings.Contains(string(recovered), "bootstrap_peers = []") {
		t.Fatalf("marker recovery absorbed the preset:\n%s", recovered)
	}

	// A database that predates the import marker is also recovery. It must
	// ignore the malformed selected sidecar instead of failing or reseeding.
	preMarkerDir := shortTempDir(t)
	store, err := storage.Open(context.Background(), preMarkerDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	stopCleanupAt(t, bin, preMarkerDir)
	if _, stderr, err := runCLIAt(t, bin, nil, "restart", "--data-dir", preMarkerDir); err != nil {
		t.Fatalf("pre-marker database recovery read the malformed sidecar: %v\n%s", err, stderr)
	}
	stdout, stderr, err = runCLIAt(t, bin, nil, "dht", "status", "--data-dir", preMarkerDir)
	if err != nil {
		t.Fatalf("dht status after pre-marker recovery: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "bootstrap: []") {
		t.Fatalf("pre-marker recovery seeded the malformed preset:\n%s", stdout)
	}
	if _, stderr, err := runCLIAt(t, bin, nil, "stop", "--data-dir", preMarkerDir); err != nil {
		t.Fatalf("stop after pre-marker recovery: %v\n%s", err, stderr)
	}
	store, err = storage.Open(context.Background(), preMarkerDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if imported, err := store.BootstrapImported(context.Background()); err != nil || !imported {
		t.Fatalf("pre-marker recovery marker = %t, %v", imported, err)
	}
	preMarkerConfig, err := os.ReadFile(config.Path(preMarkerDir))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(preMarkerConfig), validAddr) || !strings.Contains(string(preMarkerConfig), "bootstrap_peers = []") {
		t.Fatalf("pre-marker recovery absorbed the preset:\n%s", preMarkerConfig)
	}
}

func stopCleanupAt(t *testing.T, bin, dir string) {
	t.Helper()
	t.Cleanup(func() {
		_, _, _ = runCLIAt(t, bin, nil, "stop", "--data-dir", dir)
	})
}
