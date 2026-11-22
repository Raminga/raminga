package network

import (
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peerstore"
	ma "github.com/multiformats/go-multiaddr"
)

func TestDHTRecordPublishReadAndDialFallback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	hostIP := func() string {
		addrs, _ := net.InterfaceAddrs()
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				if ip := ipnet.IP.To4(); ip != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
					return ip.String()
				}
			}
		}
		t.Skip("no non-loopback IPv4")
		return ""
	}()
	newKey := func() crypto.PrivKey { k, _, _ := crypto.GenerateEd25519Key(rand.Reader); return k }
	// S is the only DHT server. R is only a relay provider.
	S, err := New(Config{PrivateKey: newKey(), ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"},
		DHT: DHTConfig{Enabled: true, Mode: "server", ProtocolPrefix: "/raminga", RefreshInterval: 2 * time.Second, QueryTimeout: 2 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = S.Close() }()
	if err := S.Start(ctx); err != nil {
		t.Fatal(err)
	}
	R, err := New(Config{PrivateKey: newKey(), ListenAddrs: []string{"/ip4/" + hostIP + "/tcp/0"},
		Relay: RelayConfig{Provider: true, MaxReservations: 8, ReservationTTL: time.Hour,
			MaxReservationsPerIP: 8, MaxReservationsPerPeer: 1, MaxCircuits: 8,
			ReservationDataLimit: 1 << 20, ReservationDurationLimit: 2 * time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = R.Close() }()
	if err := R.Start(ctx); err != nil {
		t.Fatal(err)
	}
	saddr := S.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + S.Host().ID().String())).String()
	raddr := R.Host().Addrs()[0].Encapsulate(ma.StringCast("/p2p/" + R.Host().ID().String())).String()
	mkClient := func(knownRelay string) *Network {
		n, err := New(Config{PrivateKey: newKey(), ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"},
			EnableRelay: true, EnableAutoRelay: knownRelay != "",
			Relay: RelayConfig{KnownRelays: func() []string {
				if knownRelay == "" {
					return nil
				}
				return []string{knownRelay}
			}()},
			DHT: DHTConfig{Enabled: true, Mode: "client", ProtocolPrefix: "/raminga",
				BootstrapPeers: []string{saddr}, RefreshInterval: 2 * time.Second, QueryTimeout: 2 * time.Second}})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return n
	}
	C := mkClient(raddr)
	defer func() { _ = C.Close() }()
	B := mkClient("")
	defer func() { _ = B.Close() }()
	waitReservation := func() bool {
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			for _, r := range C.RelayReservations() {
				if r.RelayPeerID == R.Host().ID().String() && r.Status == "active" {
					return true
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		return false
	}
	if !waitReservation() {
		t.Fatalf("C reservation not active: %+v", C.RelayReservations())
	}
	t.Logf("publish addrs=%v", addrsToStrings(C.dht.publishAddresses()))
	if err := C.dht.publishOnce(ctx); err != nil {
		t.Fatalf("publish: %v", err)
	}
	var addrs []string
	deadline := time.Now().Add(10 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		got, getErr := B.dht.AddressesFromDHT(ctx, C.Host().ID())
		if getErr == nil && len(got) > 0 {
			addrs = got
			break
		}
		lastErr = getErr
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil {
		t.Logf("last DHT read error: %v", lastErr)
	}
	if len(addrs) == 0 {
		t.Fatal("B did not read C's signed DHT record")
	}
	foundCircuit := false
	for _, a := range addrs {
		if strings.Contains(a, "/p2p-circuit") {
			foundCircuit = true
		}
	}
	if !foundCircuit {
		t.Fatalf("record addresses lack circuit: %v", addrs)
	}
	// A real TCP listener that never answers the security handshake keeps
	// the known direct dial pending while the DHT contributes a relay.
	stalled, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stalled.Close() }()
	accepted := make(chan struct{})
	go func() {
		conn, err := stalled.Accept()
		if err == nil {
			defer func() { _ = conn.Close() }()
			close(accepted)
			var buf [1]byte
			for {
				if _, err := conn.Read(buf[:]); err != nil {
					return
				}
			}
		}
	}()

	B.totalDialTimeout = 8 * time.Second
	B.knownDialBudget = 4 * time.Second
	addr := mustMA(t, fmt.Sprintf("/ip4/127.0.0.1/tcp/%d", stalled.Addr().(*net.TCPAddr).Port))
	B.Host().Peerstore().AddAddr(C.Host().ID(), addr, peerstore.PermanentAddrTTL)
	startDial := time.Now()
	out, err := B.DialPeerByID(ctx, C.Host().ID())
	if err != nil {
		t.Fatalf("DHT fallback dial: %v", err)
	}
	if out.Source != sourceDHT || out.Route != "relay" || !out.Limited || out.Reused {
		t.Fatalf("expected a new DHT relay connection, got %+v", out)
	}
	select {
	case <-accepted:
	default:
		t.Fatal("the direct address never received an initial attempt")
	}
	if elapsed := time.Since(startDial); elapsed >= B.knownDialBudget {
		t.Fatalf("relay waited for the slow direct dial: %s", elapsed)
	}
	if len(B.Host().Network().ConnsToPeer(C.Host().ID())) == 0 {
		t.Fatal("no connection after DHT fallback")
	}
}
