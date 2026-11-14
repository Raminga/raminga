package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
)

func TestInitCommandWritesPorts(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node-a")
	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--data-dir", dir, "--tcp-port", "14101", "--quic-port", "14102"})
	var out strings.Builder
	cmd.SetOut(&out)
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(cfg.Network.ListenAddrs, ",")
	if !strings.Contains(got, "/tcp/14101") || !strings.Contains(got, "/udp/14102/quic-v1") {
		t.Fatalf("listen addrs = %v", cfg.Network.ListenAddrs)
	}
	if !strings.Contains(got, "/ip6/::/tcp/14101") || !strings.Contains(got, "/ip6/::/udp/14102/quic-v1") {
		t.Fatalf("IPv6 listen addrs = %v", cfg.Network.ListenAddrs)
	}
	if !strings.Contains(out.String(), "  - /ip6/::/tcp/14101") {
		t.Fatalf("init output lacks IPv6 listen addr: %q", out.String())
	}
	if !strings.Contains(out.String(), "raminga daemon --data-dir") {
		t.Fatalf("init output lacks next step: %q", out.String())
	}
	for _, sub := range []string{"public", "public/profile", "public/posts"} {
		if fi, err := os.Stat(filepath.Join(dir, sub)); err != nil || !fi.IsDir() {
			t.Fatalf("init did not create %s: %v", sub, err)
		}
	}
}

func TestInitForceKeepsPeerID(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	run := func(args ...string) {
		t.Helper()
		cmd := newRootCmd()
		cmd.SetArgs(append([]string{"init", "--data-dir", dir}, args...))
		if err := cmd.ExecuteContext(context.Background()); err != nil {
			t.Fatalf("init %v: %v", args, err)
		}
	}
	run()
	id, err := identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	before := id.PeerID()
	if err := id.Close(); err != nil {
		t.Fatal(err)
	}
	run("--force", "--tcp-port", "14111", "--quic-port", "14112")
	id, err = identity.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = id.Close() }()
	if id.PeerID() != before {
		t.Fatalf("Peer ID changed after init --force: %s -> %s", before, id.PeerID())
	}
}

func TestInitCommandRejectsPortsWithListen(t *testing.T) {
	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--data-dir", t.TempDir(), "--tcp-port", "14101", "--listen", "/ip4/127.0.0.1/tcp/14201"})
	if err := cmd.ExecuteContext(context.Background()); err == nil {
		t.Fatal("combined --listen and --tcp-port unexpectedly succeeded")
	}
}

func TestRunDaemonRejectsLongSocketPath(t *testing.T) {
	longDir := filepath.Join(t.TempDir(), strings.Repeat("x", 120))
	err := runDaemon(context.Background(), longDir, false, "", false)
	if err == nil {
		t.Fatal("daemon with long socket path unexpectedly started")
	}
	for _, want := range []string{"unix socket path is too long", "shorter --data-dir"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
}

func TestDefaultDataDirUsesEnvAndHelpMentionsIt(t *testing.T) {
	t.Setenv("RAMINGA_DATA_DIR", "/data")
	if got := defaultDataDir(); got != "/data" {
		t.Fatalf("defaultDataDir = %q, want /data", got)
	}
	flag := newRootCmd().PersistentFlags().Lookup("data-dir")
	if flag == nil {
		t.Fatal("--data-dir flag missing")
	}
	if !strings.Contains(flag.Usage, "RAMINGA_DATA_DIR") {
		t.Fatalf("--data-dir usage does not document RAMINGA_DATA_DIR: %q", flag.Usage)
	}
}

func TestInitCommandNetworkFlags(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	peerA := "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"
	peerB := "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"
	cmd := newRootCmd()
	cmd.SetArgs([]string{
		"init", "--data-dir", dir,
		"--relay-provider",
		"--announce", "/ip4/203.0.113.1/tcp/4001",
		"--announce", "/ip6/2001:db8::1/udp/4001/quic-v1",
		"--known-relay", "/ip4/203.0.113.2/tcp/4001/p2p/" + peerA,
		"--bootstrap", "/ip4/203.0.113.3/tcp/4001/p2p/" + peerB,
	})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Relay.Provider {
		t.Fatal("relay provider not enabled")
	}
	if cfg.Relay.MaxReservations <= 0 || cfg.Relay.MaxReservationsPerIP <= 0 || cfg.Relay.ReservationDataLimitBytes <= 0 {
		t.Fatalf("relay quotas not set: %+v", cfg.Relay)
	}
	if len(cfg.Network.AnnounceAddrs) != 2 {
		t.Fatalf("announce addrs = %v", cfg.Network.AnnounceAddrs)
	}
	if len(cfg.Relay.KnownRelays) != 1 || len(cfg.DHT.BootstrapPeers) != 1 {
		t.Fatalf("relays=%v bootstrap=%v", cfg.Relay.KnownRelays, cfg.DHT.BootstrapPeers)
	}
}

func TestInitCommandRejectsInvalidNetworkFlags(t *testing.T) {
	peerA := "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"known relay without p2p", []string{"--known-relay", "/ip4/203.0.113.2/tcp/4001"}, "must include /p2p"},
		{"known relay circuit", []string{"--known-relay", "/ip4/203.0.113.2/tcp/4001/p2p/" + peerA + "/p2p-circuit/p2p/" + peerA}, "must be a direct relay address"},
		{"public known relay", []string{"--known-relay", "/dnsaddr/bootstrap.libp2p.io/p2p/" + peerA}, "public IPFS/libp2p service"},
		{"announce with p2p", []string{"--announce", "/ip4/203.0.113.1/tcp/4001/p2p/" + peerA}, "must not contain /p2p"},
		{"announce without transport", []string{"--announce", "/ip4/203.0.113.1"}, "has no TCP or QUIC transport"},
		{"bootstrap without p2p", []string{"--bootstrap", "/ip4/203.0.113.3/tcp/4001"}, "must include /p2p"},
		{"public bootstrap", []string{"--bootstrap", "/dnsaddr/bootstrap.libp2p.io/p2p/" + peerA}, "public IPFS/libp2p bootstrap"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := newRootCmd()
			args := append([]string{"init", "--data-dir", t.TempDir()}, tc.args...)
			cmd.SetArgs(args)
			err := cmd.ExecuteContext(context.Background())
			if err == nil {
				t.Fatal("invalid init unexpectedly succeeded")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

func TestInitRelayProviderDefaultsOff(t *testing.T) {
	dir := t.TempDir()
	cmd := newRootCmd()
	cmd.SetArgs([]string{"init", "--data-dir", dir})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Relay.Provider {
		t.Fatal("relay provider must be off unless --relay-provider is passed")
	}
}
