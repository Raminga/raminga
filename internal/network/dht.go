package network

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ipfs/go-datastore"
	dssync "github.com/ipfs/go-datastore/sync"
	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/host"
	corenet "github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/core/protocol"
	circuitv2proto "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	ma "github.com/multiformats/go-multiaddr"
)

// DHTConfig configures the independent Raminga Kademlia DHT.
type DHTConfig struct {
	Enabled        bool
	Mode           string
	ProtocolPrefix string
	BootstrapPeers []string
	// BootstrapPeersFunc, when set, is the live operator-managed bootstrap
	// role list. It lets add/remove take effect without rebuilding the DHT.
	// The function returns complete multiaddrs including /p2p/<peer-id>.
	BootstrapPeersFunc func() []string
	RefreshInterval    time.Duration
	QueryTimeout       time.Duration
	MaxRecords         int
	// Paused reports a persistent local pause; paused bootstrap peers are not
	// seeded or dialled by this package.
	Paused func(peer.ID) bool
}

// DHTPeer is one peer address result.
type DHTPeer struct {
	PeerID  string
	Addrs   []string
	Found   bool
	Source  string
	Error   string
	Elapsed time.Duration
}

// DHTStatus is a point-in-time diagnostic view.
type DHTStatus struct {
	Enabled bool
	// Mode is the mode configured in config.toml: client, server or auto.
	Mode string
	// ActiveMode is the mode the host is actually serving now: client, server,
	// unknown, or disabled. It is derived from registered stream handlers, not
	// from the configured value; libp2p's Mode() returns the configured option.
	ActiveMode                string
	Protocol                  string
	BootstrapPeers            []string
	PublicBootstrapConfigured bool
	RoutingTablePeers         []string
	ConnectedPeers            int
	BootstrapConnected        int
	RelayCandidates           int
	LastBootstrapAt           time.Time
	LastRefreshAt             time.Time
	LastError                 string
	LastLookup                DHTPeer
	LastPublishAt             time.Time
	LastPublishError          string
}

// DHT wraps go-libp2p-kad-dht with a fixed Raminga prefix and no public
// bootstrap defaults.
type DHT struct {
	h         host.Host
	cfg       DHTConfig
	logger    *slog.Logger
	d         *dht.IpfsDHT
	relay     func(peer.AddrInfo) bool
	bootstrap func() []string

	mu          sync.Mutex
	lastBoot    time.Time
	lastRefr    time.Time
	lastErr     string
	lastQuery   DHTPeer
	started     time.Time
	emptyLogged bool
	hadPeers    bool
	lastWarn    string
	lastPublish time.Time
	publishErr  string

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewDHT(h host.Host, cfg DHTConfig, relay func(peer.AddrInfo) bool, logger *slog.Logger) (*DHT, error) {
	if !cfg.Enabled {
		return &DHT{h: h, cfg: cfg, relay: relay, logger: logger}, nil
	}
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.ProtocolPrefix == "" {
		cfg.ProtocolPrefix = "/raminga"
	}
	if cfg.ProtocolPrefix != "/raminga" {
		return nil, fmt.Errorf("dht: protocol prefix must be /raminga, got %q", cfg.ProtocolPrefix)
	}
	var mode dht.ModeOpt
	switch cfg.Mode {
	case "client":
		mode = dht.ModeClient
	case "server":
		mode = dht.ModeServer
	case "auto", "":
		mode = dht.ModeAuto
	default:
		return nil, fmt.Errorf("dht: unknown mode %q", cfg.Mode)
	}

	// Keep the DHT's own bootstrap option live too: routing-table restore and
	// refresh consult this function instead of a construction-time snapshot.
	bootstrap := func() []string {
		if cfg.BootstrapPeersFunc != nil {
			return cfg.BootstrapPeersFunc()
		}
		return cfg.BootstrapPeers
	}
	boot, err := parseAddrInfos(bootstrap())
	if err != nil {
		return nil, err
	}
	if cfg.Paused != nil {
		filtered := boot[:0]
		for _, info := range boot {
			if !cfg.Paused(info.ID) {
				filtered = append(filtered, info)
			}
		}
		boot = filtered
	}
	opts := []dht.Option{
		dht.ProtocolPrefix("/raminga"),
		dht.Mode(mode),
		dht.DisableProviders(),
		dht.MaxRecordAge(6 * time.Hour),
		dht.NamespacedValidator(addrNamespace, addrRecordValidator{}),
		dht.Datastore(newBoundedDatastore(dssync.MutexWrap(datastore.NewMapDatastore()), cfg.MaxRecords)),
		dht.BootstrapOrder(dht.BootstrapFirst),
	}
	if cfg.BootstrapPeersFunc != nil {
		opts = append(opts, dht.BootstrapPeersFunc(func() []peer.AddrInfo {
			infos, parseErr := parseAddrInfos(cfg.BootstrapPeersFunc())
			if parseErr != nil {
				if logger != nil {
					logger.Warn("ignore invalid live bootstrap peer", "error", parseErr)
				}
				return nil
			}
			if cfg.Paused == nil {
				return infos
			}
			filtered := infos[:0]
			for _, info := range infos {
				if !cfg.Paused(info.ID) {
					filtered = append(filtered, info)
				}
			}
			return filtered
		}))
	} else if len(boot) > 0 {
		opts = append(opts, dht.BootstrapPeers(boot...))
	}
	if cfg.RefreshInterval > 0 {
		opts = append(opts, dht.RoutingTableRefreshPeriod(cfg.RefreshInterval))
	}
	if cfg.QueryTimeout > 0 {
		opts = append(opts, dht.RoutingTableRefreshQueryTimeout(cfg.QueryTimeout))
	}
	impl, err := dht.New(h, opts...)
	if err != nil {
		return nil, fmt.Errorf("dht: create Raminga DHT: %w", err)
	}
	return &DHT{h: h, cfg: cfg, logger: logger, d: impl, relay: relay, bootstrap: bootstrap}, nil
}

func (d *DHT) Start(ctx context.Context) error {
	if d == nil || d.d == nil {
		return nil
	}
	d.ctx, d.cancel = context.WithCancel(ctx)
	d.started = time.Now()
	boot := d.bootstrapAddrInfos()
	attempted := false
	for _, info := range boot {
		if d.cfg.Paused != nil && d.cfg.Paused(info.ID) {
			continue
		}
		attempted = true
		d.h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
		connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := d.h.Connect(connectCtx, info); err != nil {
			d.setError(fmt.Errorf("bootstrap %s: %w", info.ID, err))
			d.logger.Warn("DHT bootstrap connect failed", "peer_id", info.ID.String(), "error", err)
		}
		cancel()
	}
	if attempted {
		// last_bootstrap means an attempted bootstrap dial. With no configured
		// peers (or only paused peers) no attempt happened and the timestamp
		// must stay zero instead of implying one.
		d.mu.Lock()
		d.lastBoot = time.Now().UTC()
		d.mu.Unlock()
	}
	if err := d.d.Bootstrap(ctx); err != nil {
		d.setError(fmt.Errorf("bootstrap DHT: %w", err))
	}
	d.wg.Add(1)
	go d.refreshLoop()
	d.startPublisher(ctx)
	return nil
}

func (d *DHT) refreshLoop() {
	defer d.wg.Done()
	interval := d.cfg.RefreshInterval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	// First discovery can happen quickly after bootstrap.
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-timer.C:
			d.refresh()
			timer.Reset(interval)
		}
	}
}

func (d *DHT) refresh() {
	ctx, cancel := context.WithTimeout(d.ctx, d.cfg.QueryTimeout)
	defer cancel()
	var refreshErr error
	select {
	case err := <-d.d.RefreshRoutingTable():
		if err != nil && !errors.Is(err, context.Canceled) {
			refreshErr = fmt.Errorf("refresh routing table: %w", err)
		}
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			refreshErr = fmt.Errorf("refresh routing table: %w", ctx.Err())
		}
	}

	peers := d.d.RoutingTable().ListPeers()
	sort.Slice(peers, func(i, j int) bool { return peers[i].String() < peers[j].String() })
	live := 0
	for _, pid := range peers {
		if pid != d.h.ID() {
			live++
		}
	}

	// An empty routing table without configured bootstrap peers is a normal
	// initial state, not an error: Kademlia's self-refresh reports "failed to
	// find any peer in table" every interval, which should not become a WARN
	// each time. Log it once at INFO and keep LastError for real failures.
	var infoMsg string
	var warnErr error
	hasBootstrap := len(d.bootstrapAddrInfos()) > 0
	d.mu.Lock()
	d.lastRefr = time.Now().UTC()
	switch {
	case live == 0 && !hasBootstrap:
		if !d.emptyLogged {
			d.emptyLogged = true
			infoMsg = "DHT has no peers yet; configure dht.bootstrap_peers or add peers"
		}
		d.hadPeers = false
		d.lastErr = ""
		d.lastWarn = ""
	case live == 0:
		d.hadPeers = false
		if refreshErr != nil {
			d.lastErr = refreshErr.Error()
			if d.lastWarn != d.lastErr {
				d.lastWarn = d.lastErr
				warnErr = refreshErr
			}
		}
	default:
		if !d.hadPeers {
			infoMsg = "DHT routing table has peers"
		}
		d.hadPeers = true
		d.emptyLogged = false
		if refreshErr != nil {
			d.lastErr = refreshErr.Error()
			if d.lastWarn != d.lastErr {
				d.lastWarn = d.lastErr
				warnErr = refreshErr
			}
		} else {
			d.lastErr = ""
			d.lastWarn = ""
		}
	}
	d.mu.Unlock()
	if infoMsg != "" {
		d.logger.Info(infoMsg, "peers", live, "bootstrap_peers", len(d.bootstrapAddrInfos()))
	}
	if warnErr != nil {
		d.logger.Warn("DHT error", "error", warnErr)
	}

	for _, pid := range peers {
		if pid == d.h.ID() {
			continue
		}
		if d.relay == nil {
			continue
		}
		supported, err := d.h.Peerstore().SupportsProtocols(pid, circuitv2proto.ProtoIDv2Hop)
		if err != nil || len(supported) == 0 {
			continue
		}
		addrs := d.h.Peerstore().Addrs(pid)
		if len(addrs) == 0 {
			continue
		}
		if d.relay(peer.AddrInfo{ID: pid, Addrs: addrs}) {
			d.logger.Info("DHT discovered Raminga relay", "peer_id", pid.String(), "addrs", len(addrs))
		}
	}
}

func (d *DHT) FindPeer(ctx context.Context, pid peer.ID) DHTPeer {
	started := time.Now()
	result := DHTPeer{PeerID: pid.String(), Found: false, Source: "dht"}
	if d == nil || d.d == nil {
		result.Error = "DHT is disabled"
		result.Elapsed = time.Since(started)
		return result
	}
	if d.cfg.QueryTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d.cfg.QueryTimeout)
		defer cancel()
	}
	// With no routing peers, a restart can only use the bounded PeerStore
	// hint cache. Label that explicitly rather than pretending DHT discovery.
	if len(d.d.RoutingTable().ListPeers()) == 0 {
		if cached := d.h.Peerstore().Addrs(pid); len(cached) > 0 {
			result.Found = true
			result.Source = "peerstore-cache"
			result.Addrs = addrsToStrings(cached)
			result.Elapsed = time.Since(started)
			d.mu.Lock()
			d.lastQuery = result
			d.mu.Unlock()
			return result
		}
	}
	info, err := d.d.FindPeer(ctx, pid)
	if err == nil && len(info.Addrs) > 0 {
		result.Found = true
		result.Source = "dht"
		result.Addrs = addrsToStrings(info.Addrs)
		result.Elapsed = time.Since(started)
	} else {
		if err != nil {
			result.Error = err.Error()
		}
		// A cached address is a hint, not an online claim. Return it only with
		// an explicit source so callers cannot mistake it for live discovery.
		if cached := d.h.Peerstore().Addrs(pid); len(cached) > 0 {
			result.Found = true
			result.Source = "peerstore-cache"
			result.Addrs = addrsToStrings(cached)
		}
		result.Elapsed = time.Since(started)
	}
	d.mu.Lock()
	d.lastQuery = result
	d.mu.Unlock()
	return result
}

// AddPeer performs a manual PeerStore add with a persistent hint.
func (d *DHT) AddPeer(_ context.Context, raw string) (DHTPeer, error) {
	addr, err := ma.NewMultiaddr(raw)
	if err != nil {
		return DHTPeer{}, fmt.Errorf("invalid multiaddr: %w", err)
	}
	info, err := peer.AddrInfoFromP2pAddr(addr)
	if err != nil {
		return DHTPeer{}, fmt.Errorf("multiaddr must include /p2p/<peer-id>: %w", err)
	}
	d.h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
	return DHTPeer{
		PeerID: info.ID.String(),
		Addrs:  addrsToStrings(info.Addrs),
		Found:  true,
		Source: "manual",
	}, nil
}

// configuredBootstrap returns the current operator-managed list. Read-only
// callers use it for diagnostics; DHT dialing always goes through
// bootstrapAddrInfos so the persistent pause state is applied.
func (d *DHT) configuredBootstrap() []string {
	if d == nil {
		return nil
	}
	if d.bootstrap != nil {
		return append([]string(nil), d.bootstrap()...)
	}
	return append([]string(nil), d.cfg.BootstrapPeers...)
}

// bootstrapAddrInfos parses the live list and removes peers paused by an
// explicit local disconnect. Invalid live entries are skipped with a warning;
// the write path validates before storing, so this only protects diagnostics.
func (d *DHT) bootstrapAddrInfos() []peer.AddrInfo {
	if d == nil {
		return nil
	}
	infos, err := parseAddrInfos(d.configuredBootstrap())
	if err != nil {
		if d.logger != nil {
			d.logger.Warn("ignore invalid bootstrap peer", "error", err)
		}
		return nil
	}
	if d.cfg.Paused == nil {
		return infos
	}
	filtered := infos[:0]
	for _, info := range infos {
		if !d.cfg.Paused(info.ID) {
			filtered = append(filtered, info)
		}
	}
	return filtered
}

// AddBootstrapPeer applies a newly saved role to the live DHT. It adds the
// address to the PeerStore and makes one real bootstrap dial in the background;
// callers return after persistence and never treat dial success as save
// success. Paused peers are not dialed.
func (d *DHT) AddBootstrapPeer(ctx context.Context, info peer.AddrInfo) {
	if d == nil || d.d == nil || info.ID == "" || len(info.Addrs) == 0 {
		return
	}
	if d.cfg.Paused != nil && d.cfg.Paused(info.ID) {
		return
	}
	d.h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
	d.mu.Lock()
	d.lastBoot = time.Now().UTC()
	d.mu.Unlock()
	go func() {
		base := d.ctx
		if base == nil {
			base = context.Background()
		}
		dialCtx, cancel := context.WithTimeout(base, 10*time.Second)
		defer cancel()
		if err := d.h.Connect(dialCtx, info); err != nil {
			d.setError(fmt.Errorf("bootstrap %s: %w", info.ID, err))
			d.logger.Warn("DHT bootstrap connect failed", "peer_id", info.ID.String(), "error", err)
			return
		}
		if d.d != nil {
			_ = d.d.Bootstrap(dialCtx)
		}
	}()
}

// RefreshBootstrap asks the DHT to refresh from the current live list (used
// after removing a role). It never dials a removed peer.
func (d *DHT) RefreshBootstrap(ctx context.Context) {
	if d == nil || d.d == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	_ = d.d.Bootstrap(ctx)
}

// Status returns DHT diagnostics, including discovery failures.
func (d *DHT) Status() DHTStatus {
	if d == nil {
		return DHTStatus{Mode: "disabled", ActiveMode: "disabled"}
	}
	d.mu.Lock()
	lastBoot, lastRefr, lastErr, lastQuery := d.lastBoot, d.lastRefr, d.lastErr, d.lastQuery
	lastPublish, publishErr := d.lastPublish, d.publishErr
	d.mu.Unlock()
	configured := d.cfg.Mode
	if configured == "" {
		configured = "auto"
	}
	bootstrapPeers := append([]string(nil), d.configuredBootstrap()...)
	sort.Strings(bootstrapPeers)
	status := DHTStatus{
		Enabled:                   d.cfg.Enabled,
		Mode:                      configured,
		ActiveMode:                d.activeMode(),
		Protocol:                  "/raminga/kad/1.0.0",
		BootstrapPeers:            bootstrapPeers,
		PublicBootstrapConfigured: false,
		LastBootstrapAt:           lastBoot,
		LastRefreshAt:             lastRefr,
		LastError:                 lastErr,
		LastLookup:                lastQuery,
		LastPublishAt:             lastPublish,
		LastPublishError:          publishErr,
	}
	if len(status.BootstrapPeers) == 0 {
		status.BootstrapPeers = []string{}
	}
	for _, pid := range d.routingPeers() {
		status.RoutingTablePeers = append(status.RoutingTablePeers, pid.String())
	}
	sort.Strings(status.RoutingTablePeers)
	if d.h != nil {
		status.ConnectedPeers = len(d.h.Network().Peers())
		for _, info := range d.bootstrapAddrInfos() {
			if d.h.Network().Connectedness(info.ID) == corenet.Connected {
				status.BootstrapConnected++
			}
		}
	}
	return status
}

// activeMode derives the mode the host is actually serving. libp2p's
// IpfsDHT.Mode() reports the configured option (auto stays auto), so it cannot
// answer this question. A DHT server registers the Kademlia stream handler;
// a client removes it. When that handler is unexpectedly absent for an
// explicitly configured server, report unknown instead of guessing client.
func (d *DHT) activeMode() string {
	if d == nil || !d.cfg.Enabled {
		return "disabled"
	}
	if d.d == nil || d.h == nil {
		return "unknown"
	}
	prefix := d.cfg.ProtocolPrefix
	if prefix == "" {
		prefix = "/raminga"
	}
	serverProtocol := protocol.ID(prefix + "/kad/1.0.0")
	for _, p := range d.h.Mux().Protocols() {
		if p == serverProtocol {
			return "server"
		}
	}
	if d.cfg.Mode == "server" {
		return "unknown"
	}
	return "client"
}

// routingPeers returns non-self peers currently in the Kademlia routing table.
func (d *DHT) routingPeers() []peer.ID {
	if d == nil || d.d == nil || d.h == nil {
		return nil
	}
	peers := d.d.RoutingTable().ListPeers()
	out := make([]peer.ID, 0, len(peers))
	for _, pid := range peers {
		if pid != d.h.ID() {
			out = append(out, pid)
		}
	}
	return out
}

// SetRelayCandidateCount is filled by Network.Status.
func (d *DHT) ProtocolID() string {
	if d == nil || d.d == nil {
		return ""
	}
	return "/raminga/kad/1.0.0"
}

func (d *DHT) setError(err error) {
	if err == nil {
		return
	}
	d.mu.Lock()
	d.lastErr = err.Error()
	d.mu.Unlock()
	d.logger.Warn("DHT error", "error", err)
}

func (d *DHT) Close() error {
	if d == nil {
		return nil
	}
	if d.cancel != nil {
		d.cancel()
	}
	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	if d.d != nil {
		return d.d.Close()
	}
	return nil
}

func parseAddrInfos(raw []string) ([]peer.AddrInfo, error) {
	out := make([]peer.AddrInfo, 0, len(raw))
	index := make(map[peer.ID]int, len(raw))
	for _, address := range raw {
		m, err := ma.NewMultiaddr(address)
		if err != nil {
			return nil, fmt.Errorf("invalid multiaddr %q: %w", address, err)
		}
		info, err := peer.AddrInfoFromP2pAddr(m)
		if err != nil {
			return nil, fmt.Errorf("multiaddr %q must include /p2p/<peer-id>: %w", address, err)
		}
		// One Peer can have several addresses. Bootstrap connectivity and
		// `bootstrap_connected` count peers, not addresses.
		if at, ok := index[info.ID]; ok {
			out[at].Addrs = dedupeMultiaddrs(append(out[at].Addrs, info.Addrs...))
			continue
		}
		index[info.ID] = len(out)
		out = append(out, *info)
	}
	return out, nil
}

func addrsToStrings(addrs []ma.Multiaddr) []string {
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		out = append(out, addr.String())
	}
	sort.Slice(out, func(i, j int) bool { return compareAddrString(out[i], out[j]) < 0 })
	return out
}

func compareAddrString(a, b string) int {
	a6, b6 := strings.Contains(a, "/ip6/"), strings.Contains(b, "/ip6/")
	if a6 != b6 {
		if a6 {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}
