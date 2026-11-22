package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	presetPeerA = "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"
	presetPeerB = "12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR"
)

func presetAddr(port int, id string) string {
	return fmt.Sprintf("/ip4/127.0.0.1/tcp/%d/p2p/%s", port, id)
}

func presetTOML(addrs ...string) []byte {
	quoted := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		quoted = append(quoted, fmt.Sprintf("%q", addr))
	}
	return []byte("bootstrap_peers = [" + strings.Join(quoted, ", ") + "]\n")
}

func presetExecutable(t *testing.T) (dir, executable string) {
	t.Helper()
	dir = t.TempDir()
	executable = filepath.Join(dir, "raminga")
	if err := os.WriteFile(executable, []byte("test binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, executable
}

func writePresetSidecar(t *testing.T, executable string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(filepath.Dir(executable), BootstrapPresetFileName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrapPresetResolutionPrecedence(t *testing.T) {
	_, executable := presetExecutable(t)
	official := presetAddr(14001, presetPeerA)
	custom := presetAddr(14002, presetPeerB)
	writePresetSidecar(t, executable, presetTOML(official))

	t.Run("sidecar seeds a new init", func(t *testing.T) {
		cfg, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != official {
			t.Fatalf("bootstrap peers = %v, want sidecar preset", cfg.DHT.BootstrapPeers)
		}
		if cfg.DHT.BootstrapPreset == nil || !*cfg.DHT.BootstrapPreset {
			t.Fatalf("bootstrap preset = %v, want true", cfg.DHT.BootstrapPreset)
		}
	})
	t.Run("custom wins over sidecar and opt out", func(t *testing.T) {
		cfg, err := Init(t.TempDir(), InitOptions{
			TCPPort: 14001, QUICPort: 14001, BootstrapPeers: []string{custom},
			DisableBootstrapPreset: true, presetExecutable: executable,
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != custom {
			t.Fatalf("bootstrap peers = %v, want custom", cfg.DHT.BootstrapPeers)
		}
		if cfg.DHT.BootstrapPreset == nil || *cfg.DHT.BootstrapPreset {
			t.Fatalf("bootstrap preset = %v, want false when custom wins", cfg.DHT.BootstrapPreset)
		}
	})
	t.Run("explicit opt out never reads a broken sidecar", func(t *testing.T) {
		broken := filepath.Join(filepath.Dir(executable), "broken")
		if err := os.MkdirAll(broken, 0o755); err != nil {
			t.Fatal(err)
		}
		brokenExe := filepath.Join(broken, "raminga")
		if err := os.WriteFile(brokenExe, []byte("test"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(broken, BootstrapPresetFileName), 0o755); err != nil {
			t.Fatal(err)
		}
		cfg, err := Init(t.TempDir(), InitOptions{
			TCPPort: 14001, QUICPort: 14001, DisableBootstrapPreset: true, presetExecutable: brokenExe,
		})
		if err != nil {
			t.Fatalf("opt-out read the sidecar: %v", err)
		}
		if len(cfg.DHT.BootstrapPeers) != 0 || cfg.DHT.BootstrapPreset == nil || *cfg.DHT.BootstrapPreset {
			t.Fatalf("opt-out config = peers=%v preset=%v", cfg.DHT.BootstrapPeers, cfg.DHT.BootstrapPreset)
		}
	})
	t.Run("custom wins over a broken sidecar", func(t *testing.T) {
		brokenDir, brokenExe := presetExecutable(t)
		if err := os.Mkdir(filepath.Join(brokenDir, BootstrapPresetFileName), 0o755); err != nil {
			t.Fatal(err)
		}
		cfg, err := Init(t.TempDir(), InitOptions{
			TCPPort: 14001, QUICPort: 14001, BootstrapPeers: []string{custom}, presetExecutable: brokenExe,
		})
		if err != nil {
			t.Fatalf("custom list read the sidecar: %v", err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != custom {
			t.Fatalf("bootstrap peers = %v, want custom", cfg.DHT.BootstrapPeers)
		}
	})
}

func TestBootstrapPresetEmbeddedFallbackEmptyAndInvalid(t *testing.T) {
	previous := embeddedBootstrapPreset
	t.Cleanup(func() { embeddedBootstrapPreset = previous })
	embedded := presetAddr(14011, presetPeerB)
	embeddedBootstrapPreset = presetTOML(embedded)

	t.Run("missing sidecar falls back to embed", func(t *testing.T) {
		_, executable := presetExecutable(t)
		cfg, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != embedded {
			t.Fatalf("bootstrap peers = %v, want embedded preset", cfg.DHT.BootstrapPeers)
		}
	})
	t.Run("empty sidecar is an explicit opt out", func(t *testing.T) {
		_, executable := presetExecutable(t)
		writePresetSidecar(t, executable, presetTOML())
		cfg, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 0 || cfg.DHT.BootstrapPreset == nil || *cfg.DHT.BootstrapPreset {
			t.Fatalf("empty sidecar = peers=%v preset=%v", cfg.DHT.BootstrapPeers, cfg.DHT.BootstrapPreset)
		}
	})
	t.Run("invalid selected sidecar fails", func(t *testing.T) {
		_, executable := presetExecutable(t)
		writePresetSidecar(t, executable, []byte("bootstrap_peers = [\"not-a-multiaddr\"]\n"))
		if _, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable}); err == nil ||
			!strings.Contains(err.Error(), "bootstrap preset") {
			t.Fatalf("invalid sidecar error = %v", err)
		}
	})
	t.Run("missing list is not an implicit opt out", func(t *testing.T) {
		_, executable := presetExecutable(t)
		writePresetSidecar(t, executable, []byte("# no list\n"))
		if _, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable}); err == nil ||
			!strings.Contains(err.Error(), "missing bootstrap_peers") {
			t.Fatalf("missing list error = %v", err)
		}
	})
	t.Run("unreadable existing sidecar fails", func(t *testing.T) {
		dir, executable := presetExecutable(t)
		if err := os.Mkdir(filepath.Join(dir, BootstrapPresetFileName), 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable}); err == nil ||
			!strings.Contains(err.Error(), "read bootstrap preset") {
			t.Fatalf("unreadable sidecar error = %v", err)
		}
	})
	t.Run("sidecar is next to resolved executable not cwd", func(t *testing.T) {
		_, executable := presetExecutable(t)
		sidecar := presetAddr(14012, presetPeerA)
		writePresetSidecar(t, executable, presetTOML(sidecar))
		cwd := t.TempDir()
		writePath := filepath.Join(cwd, BootstrapPresetFileName)
		if err := os.WriteFile(writePath, presetTOML(presetAddr(14013, presetPeerB)), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Chdir(cwd)
		local, err := Init(t.TempDir(), InitOptions{TCPPort: 14001, QUICPort: 14001, presetExecutable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(local.DHT.BootstrapPeers) != 1 || local.DHT.BootstrapPeers[0] != sidecar {
			t.Fatalf("loaded cwd preset instead of executable sidecar: %v", local.DHT.BootstrapPeers)
		}
	})
}

func TestBootstrapPresetLoadAndRecovery(t *testing.T) {
	_, executable := presetExecutable(t)
	official := presetAddr(14031, presetPeerA)
	writePresetSidecar(t, executable, presetTOML(official))

	t.Run("missing config resolves sidecar once", func(t *testing.T) {
		dir := t.TempDir()
		cfg, err := LoadWithOptions(dir, LoadOptions{executable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != official {
			t.Fatalf("missing config bootstrap peers = %v", cfg.DHT.BootstrapPeers)
		}
		after, err := os.ReadFile(filepath.Join(dir, FileName))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(after), official) {
			t.Fatalf("written config lacks preset: %s", after)
		}
	})
	t.Run("existing config is never refilled or rewritten", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, FileName)
		raw := []byte("[dht]\nbootstrap_peers = []\n")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadWithOptions(dir, LoadOptions{executable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 0 || cfg.DHT.BootstrapPreset != nil {
			t.Fatalf("existing config changed: peers=%v preset=%v", cfg.DHT.BootstrapPeers, cfg.DHT.BootstrapPreset)
		}
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != string(raw) {
			t.Fatalf("Load rewrote existing config: %q", after)
		}
	})
	t.Run("pre-existing database recovery does not resolve sidecar", func(t *testing.T) {
		dir := t.TempDir()
		cfg, err := LoadWithOptions(dir, LoadOptions{ExistingDatabase: true, executable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 0 || cfg.DHT.BootstrapPreset == nil || *cfg.DHT.BootstrapPreset {
			t.Fatalf("pre-existing database config = peers=%v preset=%v", cfg.DHT.BootstrapPeers, cfg.DHT.BootstrapPreset)
		}
		after, err := os.ReadFile(filepath.Join(dir, FileName))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(after), official) {
			t.Fatalf("pre-existing database recovery absorbed the sidecar: %s", after)
		}
	})
	t.Run("imported marker recovery writes empty config without sidecar", func(t *testing.T) {
		dir := t.TempDir()
		cfg, err := LoadWithOptions(dir, LoadOptions{BootstrapImported: true, executable: executable})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.DHT.BootstrapPeers) != 0 || cfg.DHT.BootstrapPreset == nil || *cfg.DHT.BootstrapPreset {
			t.Fatalf("recovered config = peers=%v preset=%v", cfg.DHT.BootstrapPeers, cfg.DHT.BootstrapPreset)
		}
		after, err := os.ReadFile(filepath.Join(dir, FileName))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(after), official) {
			t.Fatalf("recovery absorbed the sidecar preset: %s", after)
		}
	})
	t.Run("dormant invalid bootstrap skips only bootstrap syntax", func(t *testing.T) {
		raw := []byte("[dht]\nbootstrap_peers = [\"not-a-multiaddr\"]\n")
		if _, err := Parse(raw); err == nil {
			t.Fatal("strict Parse accepted invalid bootstrap")
		}
		cfg, err := ParseWithOptions(raw, ParseOptions{AllowDormantBootstrap: true})
		if err != nil {
			t.Fatalf("dormant Parse: %v", err)
		}
		if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != "not-a-multiaddr" {
			t.Fatalf("dormant bootstrap = %v", cfg.DHT.BootstrapPeers)
		}
		if err := cfg.Validate(); err == nil {
			t.Fatal("Validate accepted dormant invalid bootstrap")
		}
		badOther := []byte("[dht]\nbootstrap_peers = [\"not-a-multiaddr\"]\n[log]\nlevel = \"verbose\"\n")
		if _, err := ParseWithOptions(badOther, ParseOptions{AllowDormantBootstrap: true}); err == nil {
			t.Fatal("dormant mode relaxed a non-bootstrap field")
		}
	})
}

func TestLoadDormantLegacyBootstrapOnlyAfterMarker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	raw := []byte("[dht]\nbootstrap_peers = [\"not-a-multiaddr\"]\n")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil {
		t.Fatal("strict Load accepted invalid bootstrap before the import marker")
	}
	cfg, err := LoadWithOptions(dir, LoadOptions{BootstrapImported: true})
	if err != nil {
		t.Fatalf("dormant Load: %v", err)
	}
	if len(cfg.DHT.BootstrapPeers) != 1 || cfg.DHT.BootstrapPeers[0] != "not-a-multiaddr" {
		t.Fatalf("dormant peers = %v", cfg.DHT.BootstrapPeers)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(raw) {
		t.Fatalf("dormant Load rewrote config: %q", after)
	}
	otherInvalid := []byte("[dht]\nbootstrap_peers = [\"not-a-multiaddr\"]\n[log]\nlevel = \"verbose\"\n")
	if err := os.WriteFile(path, otherInvalid, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadWithOptions(dir, LoadOptions{BootstrapImported: true}); err == nil {
		t.Fatal("dormant Load relaxed a non-bootstrap field")
	}
}
