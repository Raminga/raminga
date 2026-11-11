package network

import (
	"context"
	"crypto/rand"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
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
	// Give B eight stale stored addresses. The injectable short timeouts force
	// the known phase to consume its reserved budget before DHT fallback.
	B.totalDialTimeout = 20 * time.Second
	B.knownDialBudget = time.Second
	B.candidateTimeout = 100 * time.Millisecond
	B.testDial = func(dctx context.Context, _ peer.ID, addr ma.Multiaddr) error {
		if strings.HasPrefix(addr.String(), "/ip4/192.0.2.") {
			<-dctx.Done()
			return dctx.Err()
		}
		// candidateTimeout exists to expire the stale addresses above. A real
		// relayed handshake can take longer than that on a busy CI runner.
		realCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return B.Host().Connect(realCtx, peer.AddrInfo{ID: C.Host().ID()})
	}
	for i := 0; i < 8; i++ {
		B.Host().Peerstore().AddAddrs(C.Host().ID(), []ma.Multiaddr{mustMA(t, "/ip4/192.0.2."+strconv.Itoa(i+1)+"/tcp/1")}, peerstore.PermanentAddrTTL)
	}
	startDial := time.Now()
	out, err := B.DialPeerByID(ctx, C.Host().ID())
	if err != nil {
		t.Fatalf("DHT fallback dial: %v", err)
	}
	if out.Source != sourceDHT {
		t.Fatalf("dial source = %q, want dht (attempts=%+v)", out.Source, out.Attempts)
	}
	if time.Since(startDial) < 800*time.Millisecond {
		t.Fatalf("known phase did not consume budget (elapsed=%s)", time.Since(startDial))
	}
	if len(B.Host().Network().ConnsToPeer(C.Host().ID())) == 0 {
		t.Fatal("no connection after DHT fallback")
	}
}
