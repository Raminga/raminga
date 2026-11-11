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
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	circuitv2proto "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	ma "github.com/multiformats/go-multiaddr"
)

// DHTConfig configures the independent Raminga Kademlia DHT.
type DHTConfig struct {
	Enabled         bool
	Mode            string
	ProtocolPrefix  string
	BootstrapPeers  []string
	RefreshInterval time.Duration
	QueryTimeout    time.Duration
	MaxRecords      int
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
	Enabled                   bool
	Mode                      string
	Protocol                  string
	BootstrapPeers            []string
	PublicBootstrapConfigured bool
	RoutingTablePeers         []string
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
	h      host.Host
	cfg    DHTConfig
	logger *slog.Logger
	d      *dht.IpfsDHT
	relay  func(peer.AddrInfo) bool

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

	boot, err := parseAddrInfos(cfg.BootstrapPeers)
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
	if len(boot) > 0 {
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
	return &DHT{h: h, cfg: cfg, logger: logger, d: impl, relay: relay}, nil
}

func (d *DHT) Start(ctx context.Context) error {
	if d == nil || d.d == nil {
		return nil
	}
	d.ctx, d.cancel = context.WithCancel(ctx)
	d.started = time.Now()
	boot, _ := parseAddrInfos(d.cfg.BootstrapPeers)
	for _, info := range boot {
		if d.cfg.Paused != nil && d.cfg.Paused(info.ID) {
			continue
		}
		d.h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
		connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := d.h.Connect(connectCtx, info); err != nil {
			d.setError(fmt.Errorf("bootstrap %s: %w", info.ID, err))
			d.logger.Warn("DHT bootstrap connect failed", "peer_id", info.ID.String(), "error", err)
		}
		cancel()
	}
	d.mu.Lock()
	d.lastBoot = time.Now().UTC()
	d.mu.Unlock()
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
	hasBootstrap := len(d.cfg.BootstrapPeers) > 0
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
		d.logger.Info(infoMsg, "peers", live, "bootstrap_peers", len(d.cfg.BootstrapPeers))
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

// Status returns DHT diagnostics, including discovery failures.
func (d *DHT) Status() DHTStatus {
	if d == nil {
		return DHTStatus{Mode: "disabled"}
	}
	d.mu.Lock()
	lastBoot, lastRefr, lastErr, lastQuery := d.lastBoot, d.lastRefr, d.lastErr, d.lastQuery
	lastPublish, publishErr := d.lastPublish, d.publishErr
	d.mu.Unlock()
	status := DHTStatus{
		Enabled:                   d.cfg.Enabled,
		Mode:                      d.cfg.Mode,
		Protocol:                  "/raminga/kad/1.0.0",
		BootstrapPeers:            append([]string(nil), d.cfg.BootstrapPeers...),
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
	if d.d != nil {
		for _, pid := range d.d.RoutingTable().ListPeers() {
			status.RoutingTablePeers = append(status.RoutingTablePeers, pid.String())
		}
		sort.Strings(status.RoutingTablePeers)
	}
	return status
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
	for _, address := range raw {
		m, err := ma.NewMultiaddr(address)
		if err != nil {
			return nil, fmt.Errorf("invalid multiaddr %q: %w", address, err)
		}
		info, err := peer.AddrInfoFromP2pAddr(m)
		if err != nil {
			return nil, fmt.Errorf("multiaddr %q must include /p2p/<peer-id>: %w", address, err)
		}
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
