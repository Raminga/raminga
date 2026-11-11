package network

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/p2phttp" //nolint:depguard // network-owned HTTP substrate
	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	ma "github.com/multiformats/go-multiaddr"
)

func TestRouteOfConn(t *testing.T) {
	cases := []struct {
		addr    string
		route   string
		relayID string
	}{
		{"/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6", "direct", ""},
		{"/ip4/11.40.0.2/tcp/4001/p2p/12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6/p2p-circuit/p2p/12D3KooWLaHQeWmPbiVnVe7Bgu2HbXcCQPBV8ioP5XgpQFPJPSEq", "relay", "12D3KooWJ6jZ9uCQX6rHJCMkdMEL1JEoMo4fLh7eUR4b26GVjfz6"},
	}
	for _, tc := range cases {
		addr, err := ma.NewMultiaddr(tc.addr)
		if err != nil {
			t.Fatal(err)
		}
		route, relay := routeOfConn(addr)
		if route != tc.route || relay != tc.relayID {
			t.Fatalf("%s => %s/%s, want %s/%s", tc.addr, route, relay, tc.route, tc.relayID)
		}
	}
}

func TestAddressSortIPv6First(t *testing.T) {
	addrs := []string{"/ip4/1.2.3.4/tcp/1", "/ip6/::1/tcp/1", "/dns4/example/tcp/1", "/dns6/example/tcp/1"}
	sortAddrsStrings(addrs, true)
	if !strings.Contains(addrs[0], "/ip6/") && !strings.Contains(addrs[0], "/dns6/") {
		t.Fatalf("IPv6 address not first: %v", addrs)
	}
	if !strings.Contains(addrs[1], "/ip6/") && !strings.Contains(addrs[1], "/dns6/") {
		t.Fatalf("second address is not IPv6: %v", addrs)
	}
	if strings.Contains(addrs[2], "/ip6/") || strings.Contains(addrs[2], "/dns6/") {
		t.Fatalf("IPv4 address before IPv6: %v", addrs)
	}
}

func TestAutoNATUnknownWithoutProbePeer(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(crand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	n, err := New(Config{PrivateKey: key, EnableAutoNAT: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = n.Close() }()
	status := n.AutoNAT()
	if status.State != "unknown" || status.HasProbePeer {
		t.Fatalf("AutoNAT without probe peer = %+v, want unknown/no probe", status)
	}
	if status.UPNP || status.NATPMP || status.STUN {
		t.Fatalf("NAT helpers must be off: %+v", status)
	}
}

func TestUnavailableIPv6ListenerDoesNotAbortIPv4(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(crand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	n, err := New(Config{
		PrivateKey: key,
		// The IPv6 address is deliberately not assigned on the test host.
		ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0", "/ip6/2001:db8::1/tcp/0"},
	})
	if err != nil {
		t.Fatalf("New with unavailable IPv6: %v", err)
	}
	if err := n.Start(context.Background()); err != nil {
		t.Fatalf("Start with unavailable IPv6: %v", err)
	}
	defer func() { _ = n.Close() }()
	found := false
	for _, a := range n.Host().Addrs() {
		if strings.Contains(a.String(), "/ip4/127.0.0.1/tcp/") {
			found = true
		}
	}
	if !found {
		t.Fatalf("IPv4 listener missing after IPv6 failure: %v", n.Host().Addrs())
	}
}

func TestEmptyDHTLogsOnceAtInfoWithoutWarn(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	key, _, err := crypto.GenerateEd25519Key(crand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h, err := libp2p.New(libp2p.Identity(key), libp2p.NoListenAddrs)
	if err != nil {
		t.Fatal(err)
	}
	d, err := NewDHT(h, DHTConfig{
		Enabled:         true,
		Mode:            "client",
		ProtocolPrefix:  "/raminga",
		RefreshInterval: 50 * time.Millisecond,
		QueryTimeout:    300 * time.Millisecond,
	}, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := d.Start(ctx); err != nil {
		cancel()
		t.Fatal(err)
	}
	time.Sleep(2600 * time.Millisecond)
	cancel()
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	logs := buf.String()
	if strings.Contains(logs, "level=WARN") {
		t.Fatalf("empty DHT emitted WARN: %s", logs)
	}
	want := "DHT has no peers yet; configure dht.bootstrap_peers or add peers"
	if got := strings.Count(logs, want); got != 1 {
		t.Fatalf("info log count = %d, want 1; logs: %s", got, logs)
	}
	if errText := d.Status().LastError; errText != "" {
		t.Fatalf("benign empty state persisted as error: %q", errText)
	}
}

func TestAddrFactoryAnnounceAppendsPublicListenAddrs(t *testing.T) {
	state, err := newAddrState([]string{"/ip4/203.0.113.10/tcp/4001"}, false)
	if err != nil {
		t.Fatal(err)
	}
	listen := []ma.Multiaddr{
		mustMA(t, "/ip4/203.0.113.10/tcp/4001"),
		mustMA(t, "/ip6/2606:4700:4700::1111/tcp/4001"),
		mustMA(t, "/ip4/10.0.0.2/tcp/4001"),
		mustMA(t, "/ip4/127.0.0.1/tcp/4001"),
		mustMA(t, "/ip6/::1/tcp/4001"),
		mustMA(t, "/ip6/fe80::1/tcp/4001"),
		mustMA(t, "/ip4/0.0.0.0/tcp/4001"),
	}
	got := addrsToStrings(state.factory(listen))
	if len(got) != 3 || !containsString(got, "/ip4/203.0.113.10/tcp/4001") ||
		!containsString(got, "/ip6/2606:4700:4700::1111/tcp/4001") ||
		!containsString(got, "/ip4/10.0.0.2/tcp/4001") {
		t.Fatalf("factory = %v, want announce + public IPv6 + LAN", got)
	}
}

func TestAddrFactoryNoAnnounceKeepsListenSet(t *testing.T) {
	state, err := newAddrState(nil, true)
	if err != nil {
		t.Fatal(err)
	}
	listen := []ma.Multiaddr{
		mustMA(t, "/ip4/10.0.0.2/tcp/4001"),
		mustMA(t, "/ip4/127.0.0.1/tcp/4001"),
		mustMA(t, "/ip6/::1/tcp/4001"),
	}
	got := addrsToStrings(state.factory(listen))
	if len(got) != 1 || got[0] != "/ip4/10.0.0.2/tcp/4001" {
		t.Fatalf("factory = %v, want LAN only (loopback removed)", got)
	}
}

func containsString(values []string, want string) bool {
	for _, got := range values {
		if got == want {
			return true
		}
	}
	return false
}

func mustMA(t *testing.T, raw string) ma.Multiaddr {
	t.Helper()
	addr, err := ma.NewMultiaddr(raw)
	if err != nil {
		t.Fatal(err)
	}
	return addr
}

func TestConnectRelayCandidateGetsReservation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	provider, err := libp2p.New(libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = provider.Close() }()
	if _, err := relayv2.New(provider); err != nil {
		t.Fatal(err)
	}
	key, _, err := crypto.GenerateEd25519Key(crand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client, err := New(Config{
		PrivateKey:      key,
		ListenAddrs:     []string{"/ip4/127.0.0.1/tcp/0"},
		EnableRelay:     true,
		EnableAutoRelay: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Close() }()
	relayAddrs, err := peer.AddrInfoToP2pAddrs(&peer.AddrInfo{ID: provider.ID(), Addrs: provider.Addrs()})
	if err != nil || len(relayAddrs) == 0 {
		t.Fatalf("provider addrs: %v, %v", relayAddrs, err)
	}
	if _, err := client.DialMultiaddr(ctx, relayAddrs[0].String()); err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	if !client.MaybeAddConnectRelay(ctx, provider.ID()) {
		t.Fatal("connected relay not added as candidate")
	}
	waitActive := func() bool {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			for _, r := range client.RelayReservations() {
				if r.RelayPeerID == provider.ID().String() && r.Status == "active" && strings.Contains(r.AdvertisedAddr, "/p2p-circuit") {
					return true
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		return false
	}
	if !waitActive() {
		t.Fatalf("no active circuit reservation: %+v; advertised=%v", client.RelayReservations(), client.AdvertisedAddrs())
	}
	paused := true
	client.relay.cfg.Paused = func(pid peer.ID) bool { return paused && pid == provider.ID() }
	if err := client.PausePeer(provider.ID()); err != nil {
		t.Fatal(err)
	}
	if len(client.RelayReservations()) != 0 {
		t.Fatalf("pause left reservation state: %+v", client.RelayReservations())
	}
	paused = false
	client.ResumePeer(provider.ID())
	if _, err := client.DialMultiaddr(ctx, relayAddrs[0].String()); err != nil {
		t.Fatal(err)
	}
	if !client.MaybeAddConnectRelay(ctx, provider.ID()) {
		t.Fatal("resume did not add relay candidate")
	}
	if !waitActive() {
		t.Fatalf("resume did not restore reservation: %+v", client.RelayReservations())
	}
}

func TestReserveACLNotifiesWithoutBlocking(t *testing.T) {
	got := make(chan string, 1)
	acl := newReserveACL(func(_ peer.ID, addr string) { got <- addr })
	defer acl.Close()
	addr := mustMA(t, "/ip4/203.0.113.1/tcp/4001")
	start := time.Now()
	if !acl.AllowReserve("peer-b", addr) {
		t.Fatal("AllowReserve must not deny")
	}
	select {
	case value := <-got:
		if value != addr.String() {
			t.Fatalf("callback addr = %q", value)
		}
	case <-time.After(time.Second):
		t.Fatal("reservation callback missing")
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatalf("AllowReserve blocked for %s", time.Since(start))
	}
}

func TestReserveACLOverflowDoesNotBlock(t *testing.T) {
	blocked := make(chan struct{})
	acl := newReserveACL(func(peer.ID, string) { <-blocked })
	addr := mustMA(t, "/ip4/203.0.113.1/tcp/4001")
	start := time.Now()
	for i := 0; i < reserveQueueSize+32; i++ {
		if !acl.AllowReserve("peer-b", addr) {
			t.Fatal("AllowReserve must not deny")
		}
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("overflow blocked for %s", time.Since(start))
	}
	close(blocked)
	acl.Close()
}

func TestPauseGaterBlocksDHTAndReservationRecovers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	keyR, _, _ := crypto.GenerateEd25519Key(crand.Reader)
	R, err := New(Config{
		PrivateKey:  keyR,
		ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"},
		Relay: RelayConfig{
			Provider: true, MaxReservations: 8, ReservationTTL: time.Hour,
			MaxReservationsPerIP: 8, MaxReservationsPerPeer: 1, MaxCircuits: 8,
			ReservationDataLimit: 1 << 20, ReservationDurationLimit: 2 * time.Minute,
		},
		DHT: DHTConfig{Enabled: true, Mode: "server", ProtocolPrefix: "/raminga", RefreshInterval: 2 * time.Second, QueryTimeout: 2 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = R.Close() }()
	if err := R.Start(ctx); err != nil {
		t.Fatal(err)
	}
	raddr := R.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + R.Host().ID().String())).String()
	keyA, _, _ := crypto.GenerateEd25519Key(crand.Reader)
	A, err := New(Config{
		PrivateKey: keyA, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"},
		EnableRelay: true, EnableAutoRelay: true,
		Relay: RelayConfig{KnownRelays: []string{raddr}},
		DHT: DHTConfig{Enabled: true, Mode: "client", ProtocolPrefix: "/raminga",
			BootstrapPeers: []string{raddr}, RefreshInterval: 2 * time.Second, QueryTimeout: 2 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = A.Close() }()
	if err := A.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitActive := func() bool {
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			for _, r := range A.RelayReservations() {
				if r.RelayPeerID == R.Host().ID().String() && r.Status == "active" {
					return true
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		return false
	}
	if !waitActive() {
		t.Fatalf("initial reservation not active: %+v", A.RelayReservations())
	}
	// Pause and wait longer than two DHT refresh periods.
	if err := A.PausePeer(R.Host().ID()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(9 * time.Second)
	if conns := A.Host().Network().ConnsToPeer(R.Host().ID()); len(conns) != 0 {
		t.Fatalf("paused peer reconnected via DHT/relay: %+v", conns)
	}
	// Inbound from the paused peer is not rejected.
	if err := R.Host().Connect(ctx, peer.AddrInfo{ID: A.Host().ID(), Addrs: A.Host().Addrs()}); err != nil {
		t.Fatalf("inbound connect from paused peer: %v", err)
	}
	if conns := A.Host().Network().ConnsToPeer(R.Host().ID()); len(conns) == 0 {
		t.Fatal("inbound connection from paused peer was rejected")
	}
	// Explicit resume clears the gater, dials and restores the reservation.
	if err := A.PausePeer(R.Host().ID()); err != nil {
		t.Fatal(err)
	}
	A.ResumePeer(R.Host().ID())
	if _, err := A.DialMultiaddr(ctx, raddr); err != nil {
		t.Fatalf("explicit dial after resume: %v", err)
	}
	if !A.MaybeAddConnectRelay(ctx, R.Host().ID()) {
		t.Fatal("resume did not add relay candidate")
	}
	if !waitActive() {
		t.Fatalf("reservation did not recover after resume: %+v", A.RelayReservations())
	}
}

func TestNetworkHTTPHealthAndIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	mk := func() *Network {
		key, _, err := crypto.GenerateEd25519Key(crand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		n, err := New(Config{PrivateKey: key, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"}})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return n
	}
	a, b := mk(), mk()
	defer func() { _ = a.Close() }()
	defer func() { _ = b.Close() }()
	if err := a.Host().Connect(ctx, peer.AddrInfo{ID: b.Host().ID(), Addrs: b.Host().Addrs()}); err != nil {
		t.Fatal(err)
	}
	b.HTTPHandler().HandleFunc("GET /who", func(w http.ResponseWriter, r *http.Request) {
		pid, _ := p2phttp.PeerID(r.Context())
		_, _ = w.Write([]byte(pid.String()))
	})
	mux, err := http.NewRequest("GET", "http://"+b.Host().ID().String()+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := a.HTTPClient().Do(ctx, b.Host().ID(), mux, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Response.Body.Close() }()
	if res.Response.StatusCode != http.StatusOK {
		t.Fatalf("health status=%d", res.Response.StatusCode)
	}
	who, err := http.NewRequest("GET", "http://"+b.Host().ID().String()+"/who", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := a.HTTPClient().Do(ctx, b.Host().ID(), who, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Response.Body.Close() }()
	body, _ := io.ReadAll(resp.Response.Body)
	if string(body) != a.Host().ID().String() {
		t.Fatalf("who=%q want %s", body, a.Host().ID())
	}
}

func TestNetworkHTTPPausedPeerStaysDenied(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	keyA, _, _ := crypto.GenerateEd25519Key(crand.Reader)
	keyB, _, _ := crypto.GenerateEd25519Key(crand.Reader)
	a, err := New(Config{PrivateKey: keyA, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = a.Close() }()
	b, err := New(Config{PrivateKey: keyB, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = b.Close() }()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.Host().Connect(ctx, peer.AddrInfo{ID: b.Host().ID(), Addrs: b.Host().Addrs()}); err != nil {
		t.Fatal(err)
	}
	if err := a.PausePeer(b.Host().ID()); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", "http://"+b.Host().ID().String()+"/healthz", nil)
	if _, err := a.HTTPClient().DoWithDial(ctx, b.Host().ID(), req, 1<<20); err == nil {
		t.Fatal("paused peer dial unexpectedly succeeded")
	}
	if len(a.Host().Network().ConnsToPeer(b.Host().ID())) != 0 {
		t.Fatal("paused peer connection remains")
	}
}
