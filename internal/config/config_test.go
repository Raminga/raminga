package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDefault(t *testing.T) {
	cfg, err := Parse([]byte(DefaultTOML))
	if err != nil {
		t.Fatalf("Parse(default): %v", err)
	}
	def := Default()
	if len(cfg.Network.ListenAddrs) != len(def.Network.ListenAddrs) {
		t.Fatalf("listen addrs = %v", cfg.Network.ListenAddrs)
	}
	if cfg.Limits != def.Limits {
		t.Fatalf("limits = %+v, want %+v", cfg.Limits, def.Limits)
	}
}

func TestParsePartialKeepsDefaults(t *testing.T) {
	cfg, err := Parse([]byte("[log]\nlevel = \"debug\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Log.Level != "debug" {
		t.Fatalf("level = %q", cfg.Log.Level)
	}
	if cfg.Limits.MaxMessageBytes != DefaultMaxMessageBytes {
		t.Fatalf("defaults not applied: %+v", cfg.Limits)
	}
}

func TestUnknownKeyFails(t *testing.T) {
	_, err := Parse([]byte("[network]\nlisten_addrs = []\nfoo = 1\n"))
	if err == nil || !strings.Contains(err.Error(), "unknown config key") {
		t.Fatalf("error = %v, want unknown-key failure", err)
	}
}

func TestDangerousKeysFailClearly(t *testing.T) {
	for _, input := range []string{
		"[upnp]\nenabled = true\n",
		"[network]\nlisten_addrs = []\nnat_pmp = true\n",
		"[stun]\nserver = \"stun.example\"\n",
	} {
		_, err := Parse([]byte(input))
		if err == nil || !strings.Contains(err.Error(), "not supported") {
			t.Fatalf("input %q error = %v, want unsupported-key failure", input, err)
		}
	}
}

func TestValidation(t *testing.T) {
	cases := []string{
		"[network]\nlisten_addrs = [\"/ip4/127.0.0.1/udp/1/quic-v1/p2p-circuit\"]\n",
		"[network]\nlisten_addrs = [\"not-a-multiaddr\"]\n",
		"[network]\nlisten_addrs = [\"/ip4/127.0.0.1/tcp/0/p2p/12D3KooW\"]\n",
		"[limits]\nmax_message_bytes = 10\n",
		"[limits]\nmax_chat_text_bytes = 1000000\n",
		"[log]\nlevel = \"verbose\"\n",
	}
	for _, input := range cases {
		if _, err := Parse([]byte(input)); err == nil {
			t.Fatalf("input %q unexpectedly passed validation", input)
		}
	}
}

func TestEmptyListenAddrsAllowed(t *testing.T) {
	cfg, err := Parse([]byte("[network]\nlisten_addrs = []\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Network.ListenAddrs) != 0 {
		t.Fatalf("listen addrs = %v, want empty", cfg.Network.ListenAddrs)
	}
}

func TestLoadWritesDefault0600(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Log.Level != "info" {
		t.Fatalf("level = %q", cfg.Log.Level)
	}
	info, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config permissions = %o, want 600", perm)
	}
}

func TestG2DefaultsAreConservative(t *testing.T) {
	cfg := Default()
	if cfg.Relay.Provider {
		t.Fatal("relay provider must be off by default")
	}
	if len(cfg.Relay.KnownRelays) != 0 || len(cfg.DHT.BootstrapPeers) != 0 {
		t.Fatalf("no public/default helpers may be configured: relay=%v bootstrap=%v", cfg.Relay.KnownRelays, cfg.DHT.BootstrapPeers)
	}
	if cfg.DHT.ProtocolPrefix != "/raminga" || cfg.Relay.MaxReservationsPerIP <= 0 || cfg.Relay.MaxReservationsPerPeer <= 0 {
		t.Fatalf("unexpected G2 defaults: %+v", cfg)
	}
}

func TestG2DHTAndBootstrapValidation(t *testing.T) {
	for _, input := range []string{
		"[dht]\nprotocol_prefix = \"/ipfs\"\n",
		"[dht]\nbootstrap_peers = [\"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN\"]\n",
		"[relay]\nknown_relays = [\"/ip4/127.0.0.1/tcp/4001\"]\n",
	} {
		if _, err := Parse([]byte(input)); err == nil {
			t.Fatalf("input %q unexpectedly passed", input)
		}
	}
}

func TestInitWritesPortsAndValidatesStrictly(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Init(dir, InitOptions{TCPPort: 14001, QUICPort: 14002})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	want := []string{"/ip4/0.0.0.0/tcp/14001", "/ip4/0.0.0.0/udp/14002/quic-v1", "/ip6/::/tcp/14001", "/ip6/::/udp/14002/quic-v1"}
	if strings.Join(cfg.Network.ListenAddrs, ",") != strings.Join(want, ",") {
		t.Fatalf("listen addrs = %v, want %v", cfg.Network.ListenAddrs, want)
	}
	loaded, err := Load(dir)
	if err != nil {
		t.Fatalf("Load after Init: %v", err)
	}
	if strings.Join(loaded.Network.ListenAddrs, ",") != strings.Join(want, ",") {
		t.Fatalf("loaded listen addrs = %v, want %v", loaded.Network.ListenAddrs, want)
	}
	info, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config permissions = %o, want 600", perm)
	}
}

func TestInitListenOverridesPorts(t *testing.T) {
	cfg, err := Init(t.TempDir(), InitOptions{ListenAddrs: []string{"/ip4/127.0.0.1/tcp/15001"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Network.ListenAddrs) != 1 || cfg.Network.ListenAddrs[0] != "/ip4/127.0.0.1/tcp/15001" {
		t.Fatalf("listen addrs = %v", cfg.Network.ListenAddrs)
	}
}

func TestInitRefusesExistingWithoutForce(t *testing.T) {
	dir := t.TempDir()
	if _, err := Init(dir, InitOptions{TCPPort: 14001, QUICPort: 14001}); err != nil {
		t.Fatal(err)
	}
	if _, err := Init(dir, InitOptions{TCPPort: 14003, QUICPort: 14003}); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("second Init error = %v, want --force hint", err)
	}
	cfg, err := Init(dir, InitOptions{TCPPort: 14003, QUICPort: 14003, Force: true})
	if err != nil {
		t.Fatalf("forced Init: %v", err)
	}
	if !strings.Contains(strings.Join(cfg.Network.ListenAddrs, ","), "14003") {
		t.Fatalf("forced listen addrs = %v", cfg.Network.ListenAddrs)
	}
}

func TestInitRejectsInvalidPortAndListen(t *testing.T) {
	for _, opts := range []InitOptions{
		{TCPPort: 0, QUICPort: 70000},
		{TCPPort: -1, QUICPort: 4001},
		{ListenAddrs: []string{"/ip4/127.0.0.1/udp/4001/quic-v1/p2p-circuit"}},
		{ListenAddrs: []string{"not-a-multiaddr"}},
	} {
		if _, err := Init(t.TempDir(), opts); err == nil {
			t.Fatalf("Init(%+v) unexpectedly succeeded", opts)
		}
	}
}

func TestRenderTOMLRoundTrips(t *testing.T) {
	raw, err := RenderTOML(Default())
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse(RenderTOML): %v", err)
	}
	if cfg.Limits != Default().Limits || strings.Join(cfg.Network.ListenAddrs, ",") != strings.Join(Default().Network.ListenAddrs, ",") {
		t.Fatalf("round-trip changed config: %+v", cfg)
	}
}

func TestChatPolicyValidation(t *testing.T) {
	base := string(DefaultTOML)
	good := strings.Replace(base, "allowed_peer_ids = []", `allowed_peer_ids = ["12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"]`, 1)
	if _, err := Parse([]byte(good)); err != nil {
		t.Fatalf("valid allow list rejected: %v", err)
	}
	bad := strings.Replace(base, "allowed_peer_ids = []", `allowed_peer_ids = ["not-a-peer-id"]`, 1)
	if _, err := Parse([]byte(bad)); err == nil {
		t.Fatal("invalid allowed_peer_ids accepted")
	}
	overlap := strings.Replace(base, "denied_peer_ids = []", `denied_peer_ids = ["12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"]`, 1)
	overlap = strings.Replace(overlap, "allowed_peer_ids = []", `allowed_peer_ids = ["12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"]`, 1)
	if _, err := Parse([]byte(overlap)); err == nil {
		t.Fatal("overlapping allow/deny peer IDs accepted")
	}
}

func TestContentLimitsDefaultsAndValidation(t *testing.T) {
	cfg := Default()
	if cfg.Content.MaxFileBytes != 100<<20 || cfg.Content.MaxPostsBytes != 1<<30 || cfg.Content.MaxProfileBytes != 10<<20 {
		t.Fatalf("content defaults=%+v", cfg.Content)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.Content.MaxFileBytes = 0
	if err := cfg.Validate(); err == nil {
		t.Fatal("zero content limit accepted")
	}
}
