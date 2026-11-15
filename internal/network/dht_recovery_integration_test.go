package network

import (
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

func startRecordTestNetwork(t *testing.T, ctx context.Context, key crypto.PrivKey, listenPort int, mode string, bootstrap, announce []string) *Network {
	t.Helper()
	listen := "/ip4/127.0.0.1/tcp/0"
	if listenPort > 0 {
		listen = "/ip4/127.0.0.1/tcp/" + strconv.Itoa(listenPort)
	}
	n, err := New(Config{
		PrivateKey:    key,
		ListenAddrs:   []string{listen},
		AnnounceAddrs: announce,
		DHT: DHTConfig{
			Enabled:         true,
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
	if err := n.Start(ctx); err != nil {
		_ = n.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = n.Close() })
	return n
}

func loopbackDialAddr(t *testing.T, n *Network) string {
	t.Helper()
	for _, addr := range n.Host().Network().ListenAddresses() {
		if strings.Contains(addr.String(), "/ip4/127.0.0.1/") {
			return addr.Encapsulate(ma.StringCast("/p2p/" + n.Host().ID().String())).String()
		}
	}
	t.Fatalf("no loopback listen address in %v", n.Host().Network().ListenAddresses())
	return ""
}

func waitUntil(t *testing.T, timeout time.Duration, description string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func newTestKey(t *testing.T) crypto.PrivKey {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// TestDHTRecordPublishWithTwoServers covers one client publishing its signed
// address record through a two-server Raminga DHT and reading it back from both
// servers.
func TestDHTRecordPublishWithTwoServers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()

	s1 := startRecordTestNetwork(t, ctx, newTestKey(t), 0, "server", nil, []string{"/ip4/1.1.1.1/tcp/4001"})
	s1Addr := loopbackDialAddr(t, s1)
	s2 := startRecordTestNetwork(t, ctx, newTestKey(t), 0, "server", []string{s1Addr}, []string{"/ip4/8.8.8.8/tcp/4001"})
	s2Addr := loopbackDialAddr(t, s2)
	c := startRecordTestNetwork(t, ctx, newTestKey(t), 0, "client", []string{s1Addr, s2Addr}, []string{"/ip4/9.9.9.9/tcp/4001"})

	waitUntil(t, 20*time.Second, "both servers and the client to populate routing tables", func() bool {
		return len(s1.dht.routingPeers()) > 0 && len(s2.dht.routingPeers()) > 0 && len(c.dht.routingPeers()) > 0
	})
	if st := s2.dht.Status(); st.BootstrapConnected != 1 || st.ConnectedPeers == 0 {
		t.Fatalf("s2 diagnostics connected=%d bootstrap_connected=%d, want >0/1", st.ConnectedPeers, st.BootstrapConnected)
	}

	// The publisher normally retries; call it directly once the routing table
	// is populated so this test exercises record propagation, not scheduling.
	var publishErr error
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		publishErr = c.dht.publishOnce(ctx)
		if publishErr == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if publishErr != nil {
		t.Fatalf("client address-record publish: %v (publishable=%v host_addrs=%v advertised=%v routing=%v)", publishErr, c.dht.publishAddresses(), c.Host().Addrs(), c.AdvertisedAddrs(), c.dht.routingPeers())
	}

	for name, server := range map[string]*Network{"s1": s1, "s2": s2} {
		var got []string
		waitUntil(t, 15*time.Second, name+" to read the client address record", func() bool {
			addrs, err := server.dht.AddressesFromDHT(ctx, c.Host().ID())
			if err == nil && len(addrs) > 0 {
				got = addrs
				return true
			}
			return false
		})
		if !containsString(got, "/ip4/9.9.9.9/tcp/4001") {
			t.Fatalf("%s record addresses = %v, want published client address", name, got)
		}
	}
}

// TestDHTLateBootstrapRecovery verifies the upstream two-minute fixLowPeers
// mechanism: a client started before its only bootstrap peer must recover and
// publish through the existing publisher retry, without a second Raminga
// bootstrap reconnect loop. It is opt-in because it takes roughly two minutes.
func TestDHTLateBootstrapRecovery(t *testing.T) {
	if os.Getenv("RAMINGA_DHT_LATE_BOOTSTRAP") != "1" {
		t.Skip("set RAMINGA_DHT_LATE_BOOTSTRAP=1 to run the two-minute recovery test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	serverKey := newTestKey(t)
	serverID, err := peer.IDFromPrivateKey(serverKey)
	if err != nil {
		t.Fatal(err)
	}
	serverAddr := fmt.Sprintf("/ip4/127.0.0.1/tcp/%d/p2p/%s", port, serverID)
	client := startRecordTestNetwork(t, ctx, newTestKey(t), 0, "client", []string{serverAddr}, []string{"/ip4/9.9.9.9/tcp/4001"})
	start := time.Now()
	if got := client.dht.Status().ActiveMode; got != "client" {
		t.Fatalf("client active mode = %q, want client", got)
	}

	// Let the initial bootstrap connect and the first publisher attempts fail.
	time.Sleep(3 * time.Second)
	if client.dht.Status().LastBootstrapAt.IsZero() {
		t.Fatal("last_bootstrap was not recorded for a configured bootstrap attempt")
	}
	server := startRecordTestNetwork(t, ctx, serverKey, port, "server", nil, nil)
	if got := server.dht.Status().ActiveMode; got != "server" {
		t.Fatalf("server active mode = %q, want server", got)
	}

	var publishedAt time.Time
	waitUntil(t, 3*time.Minute, "late bootstrap recovery and address-record publish", func() bool {
		publishedAt = client.dht.Status().LastPublishAt
		return !publishedAt.IsZero()
	})
	elapsed := time.Since(start)
	if elapsed < 90*time.Second {
		t.Fatalf("recovered in %s, before the upstream two-minute fixLowPeers tick", elapsed)
	}
	var addrs []string
	waitUntil(t, 20*time.Second, "server to read the recovered client record", func() bool {
		got, err := server.dht.AddressesFromDHT(ctx, client.Host().ID())
		if err == nil && len(got) > 0 {
			addrs = got
			return true
		}
		return false
	})
	if !containsString(addrs, "/ip4/9.9.9.9/tcp/4001") {
		t.Fatalf("recovered record addresses = %v", addrs)
	}
	t.Logf("late bootstrap recovered after %s (published at %s)", elapsed, publishedAt.Format(time.RFC3339))
}
