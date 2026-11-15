package network

import (
	"context"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/event"
	corenet "github.com/libp2p/go-libp2p/core/network"
)

func startDHTStatusTestNetwork(t *testing.T, mode string, bootstrap, announce []string, enabled bool) *Network {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	n, err := New(Config{
		PrivateKey:    key,
		ListenAddrs:   []string{"/ip4/127.0.0.1/tcp/0"},
		AnnounceAddrs: announce,
		DHT: DHTConfig{
			Enabled:         enabled,
			Mode:            mode,
			ProtocolPrefix:  "/raminga",
			BootstrapPeers:  bootstrap,
			RefreshInterval: 2 * time.Second,
			QueryTimeout:    2 * time.Second,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	if err := n.Start(ctx); err != nil {
		_ = n.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = n.Close() })
	return n
}

func TestDHTStatusConfiguredAndActiveMode(t *testing.T) {
	for _, tc := range []struct {
		configured string
		active     string
	}{
		{"client", "client"},
		{"server", "server"},
		{"auto", "client"},
	} {
		t.Run(tc.configured, func(t *testing.T) {
			n := startDHTStatusTestNetwork(t, tc.configured, nil, nil, true)
			st := n.DHT().Status()
			if !st.Enabled {
				t.Fatal("DHT unexpectedly disabled")
			}
			if st.Mode != tc.configured {
				t.Fatalf("configured mode = %q, want %q", st.Mode, tc.configured)
			}
			if st.ActiveMode != tc.active {
				t.Fatalf("active mode = %q, want %q; host protocols=%v", st.ActiveMode, tc.active, n.Host().Mux().Protocols())
			}
			wantUpstream := map[string]dht.ModeOpt{"client": dht.ModeClient, "server": dht.ModeServer, "auto": dht.ModeAuto}[tc.configured]
			if got := n.DHT().d.Mode(); got != wantUpstream {
				t.Fatalf("libp2p Mode() = %v, want configured option %v", got, wantUpstream)
			}
			if st.LastBootstrapAt != (time.Time{}) {
				t.Fatalf("last_bootstrap = %s with no configured bootstrap peers", st.LastBootstrapAt)
			}
			if st.ConnectedPeers != 0 || st.BootstrapConnected != 0 {
				t.Fatalf("connected=%d bootstrap_connected=%d, want 0/0", st.ConnectedPeers, st.BootstrapConnected)
			}
		})
	}
}

func TestDHTStatusDisabledIsNotReportedAsActiveMode(t *testing.T) {
	n := startDHTStatusTestNetwork(t, "auto", nil, nil, false)
	st := n.DHT().Status()
	if st.Enabled {
		t.Fatal("DHT unexpectedly enabled")
	}
	if st.ActiveMode != "disabled" {
		t.Fatalf("active mode = %q, want disabled", st.ActiveMode)
	}
	if st.Mode != "auto" {
		t.Fatalf("configured mode = %q, want auto", st.Mode)
	}
}

func TestDHTEmptyRoutingTablePublishIsExplicit(t *testing.T) {
	n := startDHTStatusTestNetwork(t, "client", nil, []string{"/ip4/9.9.9.9/tcp/4001"}, true)
	err := n.DHT().publishOnce(context.Background())
	if err == nil {
		t.Fatal("publish with an empty routing table unexpectedly succeeded")
	}
	for _, want := range []string{"routing table is empty", "not published"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("publish error %q missing %q", err, want)
		}
	}
}

func TestDHTActiveModeTracksAutoReachability(t *testing.T) {
	n := startDHTStatusTestNetwork(t, "auto", nil, nil, true)
	emitter, err := n.Host().EventBus().Emitter(new(event.EvtLocalReachabilityChanged))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = emitter.Close() }()
	emit := func(reachability corenet.Reachability) {
		t.Helper()
		if err := emitter.Emit(event.EvtLocalReachabilityChanged{Reachability: reachability}); err != nil {
			t.Fatal(err)
		}
	}
	if got := n.DHT().Status().ActiveMode; got != "client" {
		t.Fatalf("initial active mode = %q, want client", got)
	}
	emit(corenet.ReachabilityPublic)
	waitUntil(t, 5*time.Second, "auto DHT to become server", func() bool {
		return n.DHT().Status().ActiveMode == "server"
	})
	emit(corenet.ReachabilityPrivate)
	waitUntil(t, 5*time.Second, "auto DHT to return to client", func() bool {
		return n.DHT().Status().ActiveMode == "client"
	})
}
