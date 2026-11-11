// Package network owns the go-libp2p host and the G2 network capabilities:
// TCP/QUIC transports, Circuit Relay v2 client/service, DCUtR, AutoNAT v2,
// the independent Raminga Kademlia DHT, AutoRelay, an in-memory PeerStore with
// a bounded SQLite hint cache, and resource limits.
//
// The public library APIs are used directly. There is no UPnP/NAT-PMP, no STUN
// and no public IPFS bootstrap/DHT configuration path.
package network

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Raminga/raminga/internal/p2phttp" //nolint:depguard // network-owned HTTP-over-libp2p substrate
	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/event"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/host/autorelay"
	"github.com/libp2p/go-libp2p/p2p/host/eventbus"
	rcmgr "github.com/libp2p/go-libp2p/p2p/host/resource-manager"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	circuitv2proto "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	"github.com/libp2p/go-libp2p/p2p/protocol/holepunch"
	"github.com/libp2p/go-libp2p/p2p/protocol/identify"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2pquic "github.com/libp2p/go-libp2p/p2p/transport/quic"
	"github.com/libp2p/go-libp2p/p2p/transport/tcp"
	ma "github.com/multiformats/go-multiaddr"
)

// DefaultDialTimeout bounds one explicit dial.
const DefaultDialTimeout = 15 * time.Second

// ResourceLimits are the go-libp2p resource-manager limits exposed to config.
type ResourceLimits struct {
	MaxConnections int
	MaxStreams     int
	MaxMemoryBytes int64
	MaxFDs         int
}

// PeerCache is the small SQLite-backed hint cache owned by storage. The
// go-libp2p in-memory PeerStore remains the runtime source of truth.
type PeerCache interface {
	LoadPeerCache(ctx context.Context) ([]CachedPeer, error)
	UpsertPeerCache(ctx context.Context, peerID string, addrs []string, source string, ttl time.Duration, maxEntries int) error
	CountPeerCache(ctx context.Context) (int, error)
}

// CachedPeer is one restart hint. ExpiresAt zero means no expiry.
type CachedPeer struct {
	PeerID    string
	Addrs     []string
	Source    string
	UpdatedAt time.Time
	ExpiresAt time.Time
}

// Config constructs a Network.
type Config struct {
	PrivateKey      crypto.PrivKey
	ListenAddrs     []string
	AnnounceAddrs   []string
	PreferIPv6      bool
	UserAgent       string
	Logger          *slog.Logger
	EnableRelay     bool
	EnableDCUtR     bool
	DCUtRTimeout    time.Duration
	EnableAutoRelay bool
	EnableAutoNAT   bool
	Relay           RelayConfig
	DHT             DHTConfig
	Limits          ResourceLimits
	PeerCache       PeerCache
	PeerCacheTTL    time.Duration
	PeerCacheMax    int
	// PausedPeers seeds the in-memory pause set from persisted paused_peers.
	PausedPeers []string
	// Paused is the in-memory predicate; New replaces it with its own set.
	Paused func(peer.ID) bool
}

// ConnInfo is a snapshot of one connection.
type ConnInfo struct {
	PeerID      string
	RemoteAddr  string
	LocalAddr   string
	Direction   string
	Transport   string
	Route       string
	RelayPeerID string
	Direct      bool
	Limited     bool
	OpenedAt    time.Time
}

// PeerEntry merges current connections and restart hints. Online is true only
// for a currently connected peer; cached addresses never imply online.
type PeerEntry struct {
	PeerID        string
	Addrs         []string
	Sources       []string
	Online        bool
	Connectedness string
	Direction     string
	Route         string
	Transport     string
	Direct        bool
	Limited       bool
	RelayPeerID   string
	Paused        bool
	LastSeen      time.Time
}

// AutoNATStatus reports the real libp2p reachability plus Raminga probe-peer
// availability. State is "unknown" whenever no Raminga probe peer is connected.
type AutoNATStatus struct {
	Enabled      bool
	State        string
	LastChanged  time.Time
	ProbePeers   []string
	HasProbePeer bool
	UPNP         bool
	NATPMP       bool
	STUN         bool
}

// ResourceStatus is a point-in-time resource view.
type ResourceStatus struct {
	Limits          ResourceLimits
	OpenConnections int
	OpenStreams     int
	PeerstorePeers  int
	CacheEntries    int
	Goroutines      int
	HeapAllocBytes  int64
}

// addrState assembles advertised addresses and keeps relay addresses current.
type addrState struct {
	mu            sync.RWMutex
	base          []ma.Multiaddr
	preferIPv6    bool
	interfaceName func(net.IP) string
	relayed       map[peer.ID]ma.Multiaddr
	order         []peer.ID
}

func newAddrState(announce []string, preferIPv6 bool) (*addrState, error) {
	iface := newIfaceCache(ifaceCacheTTL)
	state := &addrState{preferIPv6: preferIPv6, interfaceName: iface.Name, relayed: make(map[peer.ID]ma.Multiaddr)}
	for _, raw := range announce {
		addr, err := ma.NewMultiaddr(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid announce address %q: %w", raw, err)
		}
		state.base = append(state.base, addr)
	}
	return state, nil
}

func (s *addrState) factory(listen []ma.Multiaddr) []ma.Multiaddr {
	s.mu.RLock()
	announce := append([]ma.Multiaddr(nil), s.base...)
	relayed := make([]ma.Multiaddr, 0, len(s.order))
	for _, id := range s.order {
		if addr, ok := s.relayed[id]; ok {
			relayed = append(relayed, addr)
		}
	}
	iface := s.interfaceName
	s.mu.RUnlock()

	budget := maxPublicIPv6 - announcedPublicIPv6(announce)
	if budget < 0 {
		budget = 0
	}
	filtered := filterListenAddrs(listen, iface, hasNonLoopbackAddr(announce), budget)
	// Public IPv6 selection must be deterministic even before the final sort.
	filtered = deterministicPublicIPv6(filtered)
	out := make([]ma.Multiaddr, 0, len(announce)+len(filtered)+len(relayed))
	out = append(out, announce...)
	out = append(out, filtered...)
	out = append(out, relayed...)
	return s.sortWithPrefix(out, len(announce))
}

func (s *addrState) sortWithPrefix(addrs []ma.Multiaddr, prefix int) []ma.Multiaddr {
	if prefix <= 0 || prefix > len(addrs) {
		return s.sort(addrs)
	}
	seen := make(map[string]struct{}, len(addrs))
	out := make([]ma.Multiaddr, 0, len(addrs))
	for _, addr := range addrs[:prefix] {
		if addr == nil {
			continue
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, addr)
	}
	rest := make([]ma.Multiaddr, 0, len(addrs)-prefix)
	for _, addr := range addrs[prefix:] {
		if addr == nil {
			continue
		}
		if _, ok := seen[addr.String()]; ok {
			continue
		}
		rest = append(rest, addr)
	}
	out = append(out, s.sort(rest)...)
	return out
}

func (s *addrState) setRelay(id peer.ID, advertised string, add bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !add || advertised == "" {
		if _, ok := s.relayed[id]; ok {
			delete(s.relayed, id)
			for i, existing := range s.order {
				if existing == id {
					s.order = append(s.order[:i], s.order[i+1:]...)
					break
				}
			}
		}
		return
	}
	addr, err := ma.NewMultiaddr(advertised)
	if err != nil {
		return
	}
	if _, exists := s.relayed[id]; !exists {
		s.order = append(s.order, id)
	}
	s.relayed[id] = addr
}

func (s *addrState) sort(addrs []ma.Multiaddr) []ma.Multiaddr {
	seen := make(map[string]struct{}, len(addrs))
	out := make([]ma.Multiaddr, 0, len(addrs))
	for _, addr := range addrs {
		if addr == nil {
			continue
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, addr)
	}
	if s.preferIPv6 {
		sort.SliceStable(out, func(i, j int) bool {
			i6, j6 := isIPv6(out[i]), isIPv6(out[j])
			if i6 != j6 {
				return i6
			}
			return out[i].String() < out[j].String()
		})
	} else {
		sort.SliceStable(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	}
	return out
}

func isIPv6(addr ma.Multiaddr) bool {
	for _, p := range addr.Protocols() {
		if p.Name == "ip6" || p.Name == "dns6" {
			return true
		}
	}
	return false
}

// Network wraps the go-libp2p host.
type Network struct {
	host       host.Host
	cfg        Config
	logger     *slog.Logger
	addrs      *addrState
	candidates *RelayCandidateSource
	paused     *pausedSet
	relay      *relayManager
	dht        *DHT
	tracer     *HolePunchTracer
	resLimits  ResourceLimits
	httpMux    *http.ServeMux
	httpServer *p2phttp.Server
	httpClient *p2phttp.Client

	mu               sync.Mutex
	dialMu           sync.Mutex
	reachability     network.Reachability
	reachChanged     time.Time
	reachSub         event.Subscription
	cacheLoaded      int
	cacheErr         string
	started          bool
	totalDialTimeout time.Duration
	knownDialBudget  time.Duration
	candidateTimeout time.Duration
	testDial         func(context.Context, peer.ID, ma.Multiaddr) error

	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	closeOnce sync.Once
}

// New creates the host and the static address/relay-candidate state. Start must
// be called to launch relay reservations, DHT and reachability tracking.
func New(cfg Config) (*Network, error) {
	if cfg.PrivateKey == nil {
		return nil, errors.New("network: private key is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	userAgent := cfg.UserAgent
	if userAgent == "" {
		userAgent = "raminga/0.1.0"
	}
	addrs, err := newAddrState(cfg.AnnounceAddrs, cfg.PreferIPv6)
	if err != nil {
		return nil, err
	}
	paused := newPausedSet(cfg.PausedPeers)
	cfg.Paused = paused.IsPaused
	cfg.Relay.Paused = paused.IsPaused
	cfg.DHT.Paused = paused.IsPaused
	candidates := NewRelayCandidateSource(len(cfg.Relay.KnownRelays) + 8)
	for _, raw := range cfg.Relay.KnownRelays {
		info, err := peer.AddrInfoFromString(raw)
		if err != nil {
			return nil, fmt.Errorf("network: invalid relay %q: %w", raw, err)
		}
		candidates.Add(*info, "config")
	}

	limits := cfg.Limits
	if limits.MaxConnections <= 0 {
		limits.MaxConnections = 256
	}
	if limits.MaxStreams <= 0 {
		limits.MaxStreams = 1024
	}
	if limits.MaxMemoryBytes <= 0 {
		limits.MaxMemoryBytes = 128 << 20
	}
	if limits.MaxFDs <= 0 {
		limits.MaxFDs = 256
	}
	if limits.MaxFDs < limits.MaxConnections {
		limits.MaxFDs = limits.MaxConnections
	}
	rm, err := newResourceManager(limits)
	if err != nil {
		return nil, err
	}

	var tracer *HolePunchTracer
	opts := []libp2p.Option{
		libp2p.Identity(cfg.PrivateKey),
		libp2p.UserAgent(userAgent),
		libp2p.Transport(tcp.NewTCPTransport),
		libp2p.Transport(libp2pquic.NewTransport),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Muxer(yamux.ID, yamux.DefaultTransport),
		libp2p.AddrsFactory(addrs.factory),
		libp2p.ResourceManager(rm),
		libp2p.ConnectionGater(&pauseGater{paused: paused}),
		libp2p.DisableMetrics(),
	}
	if len(cfg.ListenAddrs) == 0 {
		opts = append(opts, libp2p.NoListenAddrs)
	} else {
		opts = append(opts, libp2p.ListenAddrStrings(cfg.ListenAddrs...))
	}
	if cfg.EnableRelay {
		opts = append(opts, libp2p.EnableRelay())
	} else {
		opts = append(opts, libp2p.DisableRelay())
	}
	if cfg.EnableAutoRelay {
		if !cfg.EnableRelay {
			return nil, errors.New("network: AutoRelay requires the relay client")
		}
		opts = append(opts, libp2p.EnableAutoRelayWithPeerSource(
			candidates.PeerSource,
			autorelay.WithNumRelays(2),
			autorelay.WithMinCandidates(0),
			autorelay.WithMaxCandidates(len(cfg.Relay.KnownRelays)+8),
			autorelay.WithBootDelay(0),
			autorelay.WithBackoff(3*time.Second),
			autorelay.WithMaxCandidateAge(2*time.Minute),
			autorelay.WithMinInterval(5*time.Second),
		))
	}
	if cfg.EnableDCUtR {
		timeout := cfg.DCUtRTimeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		tracer = NewHolePunchTracer(timeout + 10*time.Second)
		opts = append(opts, libp2p.EnableHolePunching(
			holepunch.WithTracer(tracer),
			holepunch.DirectDialTimeout(timeout),
		))
	}
	if cfg.EnableAutoNAT {
		opts = append(opts, libp2p.EnableAutoNATv2())
	}

	h, err := libp2p.New(opts...)
	if err != nil {
		return nil, fmt.Errorf("create libp2p host: %w", err)
	}
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	httpClient, err := p2phttp.NewClient(h, p2phttp.ClientOptions{})
	if err != nil {
		_ = h.Close()
		return nil, err
	}
	n := &Network{
		host:             h,
		cfg:              cfg,
		logger:           logger,
		addrs:            addrs,
		candidates:       candidates,
		paused:           paused,
		tracer:           tracer,
		resLimits:        limits,
		totalDialTimeout: 30 * time.Second,
		knownDialBudget:  15 * time.Second,
		candidateTimeout: candidateDialTimeout,
		httpMux:          httpMux,
		httpClient:       httpClient,
	}
	n.httpClient = httpClient
	httpClient.SetDial(func(ctx context.Context, pid peer.ID) error {
		_, err := n.DialPeerByID(ctx, pid)
		return err
	})
	return n, nil
}

// Start launches relay reservations, the DHT and reachability tracking.
func (n *Network) Start(ctx context.Context) error {
	if n == nil || n.host == nil {
		return errors.New("network: not initialized")
	}
	n.mu.Lock()
	if n.started {
		n.mu.Unlock()
		return errors.New("network: already started")
	}
	n.ctx, n.cancel = context.WithCancel(ctx)
	n.started = true
	n.mu.Unlock()

	if n.cfg.PeerCache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		entries, err := n.cfg.PeerCache.LoadPeerCache(cacheCtx)
		cancel()
		if err != nil {
			n.mu.Lock()
			n.cacheErr = err.Error()
			n.mu.Unlock()
			n.logger.Warn("load peer cache failed", "error", err)
		} else {
			loaded := 0
			for _, entry := range entries {
				pid, err := peer.Decode(entry.PeerID)
				if err != nil || len(entry.Addrs) == 0 {
					continue
				}
				if !entry.ExpiresAt.IsZero() && entry.ExpiresAt.Before(time.Now()) {
					continue
				}
				addrs := parseMultiaddrs(entry.Addrs)
				if len(addrs) == 0 {
					continue
				}
				n.host.Peerstore().AddAddrs(pid, addrs, peerstore.PermanentAddrTTL)
				loaded++
			}
			n.mu.Lock()
			n.cacheLoaded = loaded
			n.mu.Unlock()
			n.logger.Info("loaded peer cache hints", "entries", loaded)
		}
	}

	relay, err := newRelayManager(n.host, n.cfg.Relay, n.addrs, n.cfg.PeerCache, n.cfg.PeerCacheTTL, n.cfg.PeerCacheMax, n.logger)
	if err != nil {
		return err
	}
	n.relay = relay
	if err := relay.Start(ctx); err != nil {
		return err
	}
	d, err := NewDHT(n.host, n.cfg.DHT, func(info peer.AddrInfo) bool {
		added := n.relay.AddDiscoveredRelay(info)
		if added {
			n.candidates.Add(info, "dht")
		}
		return added
	}, n.logger)
	if err != nil {
		_ = relay.Close()
		return err
	}
	n.dht = d
	if err := d.Start(ctx); err != nil {
		_ = relay.Close()
		return err
	}

	httpOpts := p2phttp.DefaultOptions()
	// Chat owns its dedupe-before-rate budget; other future routes can opt in
	// to the generic limiter explicitly.
	httpOpts.DisableRateLimit = true
	httpServer, err := p2phttp.NewServer(n.host, n.httpMux, httpOpts)
	if err != nil {
		_ = d.Close()
		_ = relay.Close()
		return err
	}
	if err := httpServer.Start(n.ctx); err != nil {
		_ = d.Close()
		_ = relay.Close()
		return err
	}
	n.httpServer = httpServer

	n.wg.Add(1)
	go n.trackReachability(n.ctx)
	n.wg.Add(1)
	go n.trackPeers(n.ctx)
	return nil
}

// trackPeers persists known-peer hints when a peer connects or is identified.
// The in-memory PeerStore stays authoritative; this only helps restart.
func (n *Network) trackPeers(ctx context.Context) {
	defer n.wg.Done()
	if n.cfg.PeerCache == nil {
		return
	}
	sub, err := n.host.EventBus().Subscribe([]any{
		new(event.EvtPeerConnectednessChanged),
		new(event.EvtPeerIdentificationCompleted),
	}, eventbus.BufSize(64))
	if err != nil {
		n.logger.Warn("subscribe peer cache events failed", "error", err)
		return
	}
	defer func() { _ = sub.Close() }()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-sub.Out():
			if !ok {
				return
			}
			var pid peer.ID
			switch evt := e.(type) {
			case event.EvtPeerConnectednessChanged:
				if evt.Connectedness != network.Connected {
					continue
				}
				pid = evt.Peer
			case event.EvtPeerIdentificationCompleted:
				pid = evt.Peer
			default:
				continue
			}
			if pid == n.host.ID() {
				continue
			}
			addrs := n.host.Peerstore().Addrs(pid)
			if len(addrs) == 0 {
				continue
			}
			cacheCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			err := n.cfg.PeerCache.UpsertPeerCache(cacheCtx, pid.String(), addrsToStrings(addrs), "known", n.cfg.PeerCacheTTL, n.cfg.PeerCacheMax)
			cancel()
			if err != nil {
				n.logger.Debug("cache connected peer failed", "peer_id", pid.String(), "error", err)
			}
		}
	}
}

func (n *Network) trackReachability(ctx context.Context) {
	defer n.wg.Done()
	sub, err := n.host.EventBus().Subscribe(new(event.EvtLocalReachabilityChanged), eventbus.BufSize(16))
	if err != nil {
		n.logger.Warn("subscribe reachability failed", "error", err)
		return
	}
	n.mu.Lock()
	n.reachSub = sub
	n.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-sub.Out():
			if !ok {
				return
			}
			evt := e.(event.EvtLocalReachabilityChanged)
			n.mu.Lock()
			n.reachability = evt.Reachability
			n.reachChanged = time.Now().UTC()
			n.mu.Unlock()
			n.logger.Info("reachability changed", "state", reachabilityString(evt.Reachability))
		}
	}
}

// Host returns the underlying host for protocol stream registration.
func (n *Network) Host() host.Host { return n.host }

// HTTPHandler is the mux served on /raminga/http/1.0.0. Chat/content routes can
// be registered here; the base layer only exposes GET /healthz.
func (n *Network) HTTPHandler() *http.ServeMux { return n.httpMux }

// HTTPLimiter applies the p2phttp per-peer rate limit to one route. The
// p2phttp server wrapper already applies per-peer/global concurrency limits.
func (n *Network) HTTPLimiter(next http.Handler) http.Handler {
	if n == nil || n.httpServer == nil {
		return next
	}
	return n.httpServer.RateLimit(next)
}

// HTTPClient is the HTTP-over-libp2p client. Its dial helper uses
// DialPeerByID, so address fallback and the pause gater stay in one path.
func (n *Network) HTTPClient() *p2phttp.Client { return n.httpClient }

// ListenAddrs returns actual libp2p listen multiaddrs.
func (n *Network) ListenAddrs() []string {
	addrs := n.host.Network().ListenAddresses()
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		if strings.Contains(a.String(), "p2p-circuit") {
			continue
		}
		out = append(out, a.String())
	}
	sort.Strings(out)
	return out
}

// AdvertisedAddrs returns the AddrsFactory output.
func (n *Network) AdvertisedAddrs() []string {
	return addrsToStrings(n.host.Addrs())
}

// LocalPeerID returns this host's Peer ID.
func (n *Network) LocalPeerID() peer.ID { return n.host.ID() }

// RestorePeer seeds a friend's stored addresses into the in-memory PeerStore.
// AddPeerHints adds untrusted listed addresses with a temporary TTL. Reading
// a friend list never dials; an explicit ConnectListedPeer uses these hints.
func (n *Network) AddPeerHints(pid peer.ID, addrs []ma.Multiaddr, ttl time.Duration) {
	if len(addrs) > 0 {
		n.host.Peerstore().AddAddrs(pid, addrs, ttl)
	}
}

func (n *Network) RestorePeer(pid peer.ID, addrs []string) {
	parsed := parseMultiaddrs(addrs)
	if len(parsed) > 0 {
		n.host.Peerstore().AddAddrs(pid, parsed, peerstore.PermanentAddrTTL)
	}
}

// PausePeer stops local relay/auto-relay work for a peer and closes its
// connections. The persisted pause is owned by the caller.
func (n *Network) PausePeer(pid peer.ID) error {
	n.paused.Set(pid, true)
	if n.relay != nil {
		n.relay.Pause(pid)
	}
	if n.candidates != nil {
		n.candidates.Remove(pid)
	}
	_ = n.host.Network().ClosePeer(pid)
	return nil
}

// ResumePeer clears the in-memory pause before an explicit dial.
func (n *Network) ResumePeer(pid peer.ID) { n.paused.Set(pid, false) }

// IsPaused reports the in-memory pause state.
func (n *Network) IsPaused(pid peer.ID) bool { return n.paused.IsPaused(pid) }

// PeerCapabilities reports relay-hop and Raminga-DHT protocol support. It waits
// for identify only when the peerstore does not know the protocols yet.
func (n *Network) PeerCapabilities(ctx context.Context, pid peer.ID) (relay, dht bool) {
	if pid == "" {
		return false, false
	}
	ps := n.host.Peerstore()
	check := func() (bool, bool) {
		r, _ := ps.SupportsProtocols(pid, circuitv2proto.ProtoIDv2Hop)
		d, _ := ps.SupportsProtocols(pid, protocol.ID("/raminga/kad/1.0.0"))
		return len(r) > 0, len(d) > 0
	}
	if r, d := check(); r || d {
		return r, d
	}
	idHost, ok := n.host.(interface{ IDService() identify.IDService })
	if !ok {
		return false, false
	}
	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for _, conn := range n.host.Network().ConnsToPeer(pid) {
		select {
		case <-idHost.IDService().IdentifyWait(conn):
		case <-waitCtx.Done():
			return false, false
		}
	}
	return check()
}

// Connect dials one explicit peer multiaddr, direct or relayed.
func (n *Network) Connect(ctx context.Context, raw string) (ConnInfo, error) {
	out, err := n.DialMultiaddr(ctx, raw)
	if err != nil {
		return ConnInfo{}, err
	}
	n.logger.Info("dial established",
		"peer_id", out.PeerID,
		"transport", out.Transport,
		"route", out.Route,
		"direct", out.Direct,
		"reused", out.Reused,
		"remote_addr", out.RemoteAddr)
	return out.ConnInfo, nil
}

// MaybeAddConnectRelay adds a peer reached by a user connect as an AutoRelay
// candidate when it advertises Circuit Relay v2 hop support. Identify can lag a
// successful dial, so this waits on go-libp2p's public IdentifyWait with a
// short bound; it never polls or writes config.
func (n *Network) MaybeAddConnectRelay(ctx context.Context, pid peer.ID) bool {
	if !n.cfg.EnableAutoRelay || n.relay == nil || pid == "" || pid == n.host.ID() {
		return false
	}
	relay, _ := n.PeerCapabilities(ctx, pid)
	if !relay {
		return false
	}
	return n.addConnectRelay(pid)
}

func (n *Network) addConnectRelay(pid peer.ID) bool {
	addrs := n.host.Peerstore().Addrs(pid)
	if len(addrs) == 0 {
		return false
	}
	info := peer.AddrInfo{ID: pid, Addrs: addrs}
	if n.relay.AddRelayCandidate(info, "connect") {
		n.candidates.Add(info, "connect")
		n.logger.Info("connected peer added as relay candidate", "peer_id", pid.String())
		return true
	}
	return false
}

// ConnectPeer dials peerID using the resolved PeerStore/cache/DHT candidates.
func (n *Network) ConnectPeer(ctx context.Context, pid peer.ID) (ConnInfo, error) {
	out, err := n.DialPeerByID(ctx, pid)
	if err != nil {
		return ConnInfo{}, err
	}
	return out.ConnInfo, nil
}

func (n *Network) connectionInfo(pid peer.ID) (ConnInfo, error) {
	conns := n.host.Network().ConnsToPeer(pid)
	if len(conns) == 0 {
		return ConnInfo{}, fmt.Errorf("no connection to peer %s", pid)
	}
	infos := make([]ConnInfo, 0, len(conns))
	for _, c := range conns {
		infos = append(infos, connInfo(c))
	}
	for _, info := range infos {
		if info.Direct {
			return info, nil
		}
	}
	return infos[0], nil
}

// Connections returns one snapshot per current connection.
func (n *Network) Connections() []ConnInfo {
	var out []ConnInfo
	for _, pid := range n.host.Network().Peers() {
		for _, c := range n.host.Network().ConnsToPeer(pid) {
			out = append(out, connInfo(c))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].PeerID == out[j].PeerID {
			return out[i].Route < out[j].Route
		}
		return out[i].PeerID < out[j].PeerID
	})
	return out
}

// ConnectionInfo returns a snapshot for one peer.
func (n *Network) ConnectionInfo(pid peer.ID) (ConnInfo, error) {
	return n.connectionInfo(pid)
}

// ConnInfo snapshots an already-open libp2p connection.
func (n *Network) ConnInfo(c network.Conn) ConnInfo { return connInfo(c) }

func connInfo(c network.Conn) ConnInfo {
	st := c.Stat()
	remote := c.RemoteMultiaddr()
	route, relayID := routeOfConn(remote)
	limited := st.Limited || route == "relay"
	return ConnInfo{
		PeerID:      c.RemotePeer().String(),
		RemoteAddr:  remote.String(),
		LocalAddr:   c.LocalMultiaddr().String(),
		Direction:   directionString(st.Direction),
		Transport:   transportOf(remote),
		Route:       route,
		RelayPeerID: relayID,
		Direct:      !limited,
		Limited:     limited,
		OpenedAt:    st.Opened,
	}
}

func routeOfConn(m ma.Multiaddr) (route string, relayID string) {
	protocols := m.Protocols()
	for i, p := range protocols {
		if p.Name != "p2p-circuit" {
			continue
		}
		for j := i - 1; j >= 0; j-- {
			if protocols[j].Name == "p2p" {
				if value, err := m.ValueForProtocol(protocols[j].Code); err == nil {
					relayID = value
				}
				break
			}
		}
		return "relay", relayID
	}
	return "direct", ""
}

func directionString(d network.Direction) string {
	if d == network.DirInbound {
		return "inbound"
	}
	return "outbound"
}

func transportOf(m ma.Multiaddr) string {
	for _, p := range m.Protocols() {
		switch p.Name {
		case "tcp":
			return "tcp"
		case "quic", "quic-v1":
			return "quic"
		}
	}
	return "unknown"
}

// RegisterStreamHandler registers a libp2p stream handler.
func (n *Network) RegisterStreamHandler(pid protocol.ID, handler network.StreamHandler) {
	n.host.SetStreamHandler(pid, handler)
}

// NewStream opens a stream to a peer. Chat streams explicitly allow limited
// relay connections; go-libp2p refuses them by default.
func (n *Network) NewStream(ctx context.Context, pid peer.ID, pidProto protocol.ID) (network.Stream, error) {
	return n.host.NewStream(ctx, pid, pidProto)
}

// OpenChatStream opens a stream and allows a limited Circuit Relay v2
// connection. It is used only for the application protocol, never for control.
func (n *Network) OpenChatStream(ctx context.Context, pid peer.ID, pidProto protocol.ID) (network.Stream, error) {
	return n.host.NewStream(network.WithAllowLimitedConn(ctx, "chat"), pid, pidProto)
}

// AddPeer adds a peer multiaddr to the in-memory PeerStore and SQLite hint
// cache. source is "manual", "bootstrap" or "known".
func (n *Network) AddPeer(ctx context.Context, raw, source string) (PeerEntry, error) {
	addr, err := ma.NewMultiaddr(raw)
	if err != nil {
		return PeerEntry{}, fmt.Errorf("invalid multiaddr: %w", err)
	}
	info, err := peer.AddrInfoFromP2pAddr(addr)
	if err != nil {
		return PeerEntry{}, fmt.Errorf("multiaddr must include /p2p/<peer-id>: %w", err)
	}
	n.host.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
	if n.cfg.PeerCache != nil {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := n.cfg.PeerCache.UpsertPeerCache(ctx, info.ID.String(), addrsToStrings(info.Addrs), source, n.cfg.PeerCacheTTL, n.cfg.PeerCacheMax); err != nil {
			n.logger.Warn("cache manually added peer failed", "peer_id", info.ID.String(), "error", err)
		}
	}
	if n.cfg.DHT.Enabled && n.dht != nil && source == "manual" {
		if _, err := n.dht.AddPeer(ctx, raw); err != nil {
			return PeerEntry{}, err
		}
	}
	return PeerEntry{
		PeerID:  info.ID.String(),
		Addrs:   addrsToStrings(info.Addrs),
		Sources: []string{source},
		Online:  false,
	}, nil
}

// SeedPeer adds a configured bootstrap/pinned peer before Start.
func (n *Network) SeedPeer(raw, source string) error {
	m, err := ma.NewMultiaddr(raw)
	if err != nil {
		return fmt.Errorf("invalid %s peer %q: %w", source, raw, err)
	}
	info, err := peer.AddrInfoFromP2pAddr(m)
	if err != nil {
		return fmt.Errorf("%s peer %q must include /p2p/<peer-id>: %w", source, raw, err)
	}
	if n.cfg.Paused != nil && n.cfg.Paused(info.ID) {
		return nil
	}
	n.host.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
	if n.cfg.PeerCache != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := n.cfg.PeerCache.UpsertPeerCache(ctx, info.ID.String(), addrsToStrings(info.Addrs), source, n.cfg.PeerCacheTTL, n.cfg.PeerCacheMax); err != nil {
			n.logger.Warn("cache seed peer failed", "peer_id", info.ID.String(), "error", err)
		}
	}
	return nil
}

// Peers merges live connections with cached restart hints. Cached entries are
// never marked online.
func (n *Network) Peers(ctx context.Context) ([]PeerEntry, error) {
	byID := make(map[string]*PeerEntry)
	for _, c := range n.Connections() {
		entry := byID[c.PeerID]
		if entry == nil {
			entry = &PeerEntry{PeerID: c.PeerID, Online: true, Connectedness: "connected"}
			byID[c.PeerID] = entry
		}
		entry.Addrs = append(entry.Addrs, c.RemoteAddr)
		if entry.Route == "" || (c.Direct && entry.Route != "direct") {
			entry.Route = c.Route
			entry.Direction = c.Direction
			entry.Transport = c.Transport
			entry.Direct = c.Direct
			entry.Limited = c.Limited
			entry.RelayPeerID = c.RelayPeerID
			entry.LastSeen = c.OpenedAt
		}
	}
	for _, pid := range n.host.Peerstore().Peers() {
		if pid == n.host.ID() {
			continue
		}
		key := pid.String()
		entry := byID[key]
		if entry == nil {
			entry = &PeerEntry{PeerID: key, Connectedness: "known"}
			byID[key] = entry
		}
		entry.Addrs = append(entry.Addrs, addrsToStrings(n.host.Peerstore().Addrs(pid))...)
	}
	if n.cfg.PeerCache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		entries, err := n.cfg.PeerCache.LoadPeerCache(cacheCtx)
		cancel()
		if err == nil {
			for _, cached := range entries {
				if !cached.ExpiresAt.IsZero() && cached.ExpiresAt.Before(time.Now()) {
					continue
				}
				entry := byID[cached.PeerID]
				if entry == nil {
					entry = &PeerEntry{PeerID: cached.PeerID, Connectedness: "cached"}
					byID[cached.PeerID] = entry
				}
				entry.Addrs = append(entry.Addrs, cached.Addrs...)
				entry.Sources = append(entry.Sources, cached.Source)
				if entry.LastSeen.IsZero() {
					entry.LastSeen = cached.UpdatedAt
				}
			}
		}
	}
	out := make([]PeerEntry, 0, len(byID))
	for _, entry := range byID {
		if n.cfg.Paused != nil {
			if pid, err := peer.Decode(entry.PeerID); err == nil {
				entry.Paused = n.cfg.Paused(pid)
			}
		}
		entry.Addrs = dedupeStrings(entry.Addrs)
		sortAddrsStrings(entry.Addrs, n.cfg.PreferIPv6)
		entry.Sources = dedupeStrings(entry.Sources)
		out = append(out, *entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PeerID < out[j].PeerID })
	return out, nil
}

// RelayReservations returns the real client reservation states.
func (n *Network) RelayReservations() []RelayReservation {
	if n.relay == nil {
		return []RelayReservation{}
	}
	return n.relay.Reservations()
}

// RelayProvider returns the provider quotas/status.
func (n *Network) RelayProvider() RelayProviderStatus {
	if n.relay == nil {
		return RelayProviderStatus{}
	}
	return n.relay.Provider()
}

// DHT returns the DHT facade.
func (n *Network) DHT() *DHT { return n.dht }

// RelayCandidates returns the bounded AutoRelay candidate count.
func (n *Network) RelayCandidates() int {
	if n.candidates == nil {
		return 0
	}
	return len(n.candidates.Snapshot())
}

// DCUtR returns the public tracer snapshot.
func (n *Network) DCUtR() DCUtRStatus {
	if n.tracer == nil {
		return DCUtRStatus{}
	}
	return n.tracer.Snapshot()
}

// AutoNAT returns real reachability gated on Raminga probe peers.
func (n *Network) AutoNAT() AutoNATStatus {
	probePeers := n.probePeers()
	n.mu.Lock()
	state := reachabilityString(n.reachability)
	changed := n.reachChanged
	n.mu.Unlock()
	if len(probePeers) == 0 {
		state = "unknown"
	}
	return AutoNATStatus{
		Enabled:      n.cfg.EnableAutoNAT,
		State:        state,
		LastChanged:  changed,
		ProbePeers:   probePeers,
		HasProbePeer: len(probePeers) > 0,
		UPNP:         false,
		NATPMP:       false,
		STUN:         false,
	}
}

func (n *Network) probePeers() []string {
	var out []string
	for _, pid := range n.host.Network().Peers() {
		supported, err := n.host.Peerstore().SupportsProtocols(pid, "/libp2p/autonat/2/dial-request")
		if err == nil && len(supported) > 0 {
			out = append(out, pid.String())
		}
	}
	sort.Strings(out)
	return out
}

// ResourceStatus returns limits and current usage.
func (n *Network) ResourceStatus(ctx context.Context) ResourceStatus {
	streams := 0
	for _, c := range n.host.Network().Conns() {
		streams += len(c.GetStreams())
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	status := ResourceStatus{
		Limits:          n.resLimits,
		OpenConnections: len(n.host.Network().Conns()),
		OpenStreams:     streams,
		PeerstorePeers:  len(n.host.Peerstore().Peers()),
		Goroutines:      runtime.NumGoroutine(),
		HeapAllocBytes:  int64(mem.HeapAlloc),
	}
	if n.cfg.PeerCache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if count, err := n.cfg.PeerCache.CountPeerCache(cacheCtx); err == nil {
			status.CacheEntries = count
		}
	}
	return status
}

// Disconnect closes all connections to a peer.
func (n *Network) Disconnect(pid peer.ID) error {
	if n.host.Network().Connectedness(pid) == network.NotConnected {
		return fmt.Errorf("peer %s is not connected", pid)
	}
	return n.host.Network().ClosePeer(pid)
}

// Close closes the DHT, relay manager, host and connections.
func (n *Network) Close() error {
	if n == nil || n.host == nil {
		return nil
	}
	var err error
	n.closeOnce.Do(func() {
		if n.cancel != nil {
			n.cancel()
		}
		n.mu.Lock()
		sub := n.reachSub
		n.reachSub = nil
		n.mu.Unlock()
		if sub != nil {
			_ = sub.Close()
		}
		done := make(chan struct{})
		go func() {
			n.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		if n.httpServer != nil {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = errors.Join(err, n.httpServer.Close(closeCtx))
			closeCancel()
		}
		if n.dht != nil {
			err = errors.Join(err, n.dht.Close())
		}
		if n.relay != nil {
			err = errors.Join(err, n.relay.Close())
		}
		err = errors.Join(err, n.host.Close())
	})
	return err
}

func newResourceManager(limits ResourceLimits) (network.ResourceManager, error) {
	cfg := rcmgr.DefaultLimits
	libp2p.SetDefaultServiceLimits(&cfg)
	cfg.SystemBaseLimit.Conns = limits.MaxConnections
	cfg.SystemBaseLimit.ConnsInbound = limits.MaxConnections
	cfg.SystemBaseLimit.Streams = limits.MaxStreams
	cfg.SystemBaseLimit.Memory = limits.MaxMemoryBytes
	cfg.SystemBaseLimit.FD = limits.MaxFDs
	cfg.SystemLimitIncrease = rcmgr.BaseLimitIncrease{}
	cfg.TransientBaseLimit.Conns = limits.MaxConnections
	cfg.TransientBaseLimit.Streams = limits.MaxStreams
	cfg.TransientBaseLimit.Memory = limits.MaxMemoryBytes
	cfg.TransientBaseLimit.FD = limits.MaxFDs
	cfg.TransientLimitIncrease = rcmgr.BaseLimitIncrease{}
	concrete := cfg.Scale(limits.MaxMemoryBytes, limits.MaxFDs)
	limiter := rcmgr.NewFixedLimiter(concrete)
	rm, err := rcmgr.NewResourceManager(limiter)
	if err != nil {
		return nil, fmt.Errorf("network: resource manager: %w", err)
	}
	return rm, nil
}

func sortAddrsStrings(addrs []string, preferIPv6 bool) {
	sort.SliceStable(addrs, func(i, j int) bool {
		if preferIPv6 {
			i6 := strings.Contains(addrs[i], "/ip6/") || strings.Contains(addrs[i], "/dns6/")
			j6 := strings.Contains(addrs[j], "/ip6/") || strings.Contains(addrs[j], "/dns6/")
			if i6 != j6 {
				return i6
			}
		}
		return addrs[i] < addrs[j]
	})
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func parseMultiaddrs(raw []string) []ma.Multiaddr {
	out := make([]ma.Multiaddr, 0, len(raw))
	for _, value := range raw {
		if addr, err := ma.NewMultiaddr(value); err == nil {
			out = append(out, addr)
		}
	}
	return out
}

func reachabilityString(r network.Reachability) string {
	switch r {
	case network.ReachabilityPublic:
		return "public"
	case network.ReachabilityPrivate:
		return "private"
	default:
		return "unknown"
	}
}

func withDefaultTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, d)
}
