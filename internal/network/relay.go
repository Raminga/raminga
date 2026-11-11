package network

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/event"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	relayv2client "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/client"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	ma "github.com/multiformats/go-multiaddr"
)

// RelayConfig configures the Circuit Relay v2 client and provider.
type RelayConfig struct {
	Provider                 bool
	KnownRelays              []string
	MaxReservations          int
	ReservationTTL           time.Duration
	MaxReservationsPerIP     int
	MaxReservationsPerPeer   int
	MaxCircuits              int
	ReservationDataLimit     int64
	ReservationDurationLimit time.Duration
	// OnReserve observes accepted reservation requests. It runs asynchronously
	// and must not block or change the allow/deny decision.
	OnReserve func(peer.ID, string)
	// Paused reports a persistent local pause.
	Paused func(peer.ID) bool
}

// RelayReservation is the real reservation state observed from the relay
// client. Attempts/failures are tracked separately from successes.
type RelayReservation struct {
	RelayPeerID       string
	RelayAddr         string
	Status            string // connecting|reserving|active|failed|lost|stopped
	ReservationStatus string // active|failed|lost|none
	Attempts          int
	Successes         int
	Failures          int
	ExpiresAt         time.Time
	RelayedAddr       string
	AdvertisedAddr    string
	LimitDuration     time.Duration
	LimitData         uint64
	LastError         string
	UpdatedAt         time.Time
}

// RelayProviderStatus describes the optional relay service and its quotas. The
// public relay API does not expose per-reservation counters; quotas are
// enforced by go-libp2p's relay service.
type RelayProviderStatus struct {
	Enabled                  bool
	MaxReservations          int
	ReservationTTL           time.Duration
	MaxReservationsPerIP     int
	MaxReservationsPerPeer   int
	MaxCircuits              int
	ReservationDataLimit     int64
	ReservationDurationLimit time.Duration
	Error                    string
}

const reserveQueueSize = 64

type reserveEvent struct {
	peer peer.ID
	addr string
}

// reserveACL is a non-blocking callback bridge. A single worker performs the
// best-effort callback; the queue is bounded and overflow is dropped.
type reserveACL struct {
	onReserve func(peer.ID, string)
	queue     chan reserveEvent
	done      chan struct{}
	wg        sync.WaitGroup
	once      sync.Once
}

func newReserveACL(onReserve func(peer.ID, string)) *reserveACL {
	acl := &reserveACL{
		onReserve: onReserve,
		queue:     make(chan reserveEvent, reserveQueueSize),
		done:      make(chan struct{}),
	}
	acl.wg.Add(1)
	go acl.worker()
	return acl
}

func (a *reserveACL) worker() {
	defer a.wg.Done()
	for {
		select {
		case <-a.done:
			return
		case ev := <-a.queue:
			a.onReserve(ev.peer, ev.addr)
		}
	}
}

func (a *reserveACL) AllowReserve(p peer.ID, addr ma.Multiaddr) bool {
	if a == nil || a.onReserve == nil {
		return true
	}
	raw := ""
	if addr != nil {
		raw = addr.String()
	}
	select {
	case a.queue <- reserveEvent{peer: p, addr: raw}:
	case <-a.done:
	default:
		// Best effort: a slow SQLite write must not affect reservations.
	}
	return true
}

func (a *reserveACL) Close() {
	if a == nil {
		return
	}
	a.once.Do(func() { close(a.done) })
	a.wg.Wait()
}

func (a *reserveACL) AllowConnect(peer.ID, ma.Multiaddr, peer.ID) bool { return true }

type relayManager struct {
	host    host.Host
	cfg     RelayConfig
	logger  *slog.Logger
	addrs   *addrState
	cache   PeerCache
	ttl     time.Duration
	max     int
	self    peer.ID
	started time.Time

	mu       sync.Mutex
	states   map[peer.ID]*RelayReservation
	loops    map[peer.ID]context.CancelFunc
	provider io.Closer
	acl      *reserveACL
	provStat RelayProviderStatus

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func newRelayManager(h host.Host, cfg RelayConfig, addrs *addrState, cache PeerCache, ttl time.Duration, maxEntries int, logger *slog.Logger) (*relayManager, error) {
	if logger == nil {
		logger = slog.Default()
	}
	m := &relayManager{
		host:    h,
		cfg:     cfg,
		logger:  logger,
		addrs:   addrs,
		cache:   cache,
		ttl:     ttl,
		max:     maxEntries,
		self:    h.ID(),
		started: time.Now(),
		states:  make(map[peer.ID]*RelayReservation),
		loops:   make(map[peer.ID]context.CancelFunc),
	}
	if cfg.Provider {
		resources := relayv2.DefaultResources()
		resources.Limit = &relayv2.RelayLimit{
			Duration: cfg.ReservationDurationLimit,
			Data:     cfg.ReservationDataLimit,
		}
		resources.ReservationTTL = cfg.ReservationTTL
		resources.MaxReservations = cfg.MaxReservations
		resources.MaxReservationsPerIP = cfg.MaxReservationsPerIP
		// MaxReservationsPerPeer is deprecated upstream (one reservation per peer),
		// but it is the public quota knob and is still enforced by relayv2.
		resources.MaxReservationsPerPeer = cfg.MaxReservationsPerPeer //nolint:staticcheck
		resources.MaxCircuits = cfg.MaxCircuits
		opts := []relayv2.Option{relayv2.WithResources(resources)}
		if cfg.OnReserve != nil {
			m.acl = newReserveACL(cfg.OnReserve)
			opts = append(opts, relayv2.WithACL(m.acl))
		}
		svc, err := relayv2.New(h, opts...)
		if err != nil {
			m.acl.Close()
			return nil, fmt.Errorf("start relay provider: %w", err)
		}
		m.provider = svc
		m.provStat = RelayProviderStatus{
			Enabled:                  true,
			MaxReservations:          cfg.MaxReservations,
			ReservationTTL:           cfg.ReservationTTL,
			MaxReservationsPerIP:     cfg.MaxReservationsPerIP,
			MaxReservationsPerPeer:   cfg.MaxReservationsPerPeer,
			MaxCircuits:              cfg.MaxCircuits,
			ReservationDataLimit:     cfg.ReservationDataLimit,
			ReservationDurationLimit: cfg.ReservationDurationLimit,
		}
		logger.Info("relay provider enabled",
			"max_reservations", cfg.MaxReservations,
			"max_reservations_per_ip", cfg.MaxReservationsPerIP,
			"max_reservations_per_peer", cfg.MaxReservationsPerPeer,
			"reservation_ttl", cfg.ReservationTTL.String())
	}
	return m, nil
}

func (m *relayManager) Start(ctx context.Context) error {
	m.ctx, m.cancel = context.WithCancel(ctx)
	for _, raw := range m.cfg.KnownRelays {
		info, err := peer.AddrInfoFromString(raw)
		if err != nil {
			m.logger.Warn("invalid configured relay", "addr", raw, "error", err)
			continue
		}
		if m.cfg.Paused != nil && m.cfg.Paused(info.ID) {
			continue
		}
		m.addRelay(*info, "config")
		m.cachePeer(*info, "pinned")
	}
	m.wg.Add(1)
	go m.watchRelayDisconnects(m.ctx)
	return nil
}

func (m *relayManager) addRelay(info peer.AddrInfo, source string) {
	if info.ID == "" {
		return
	}
	m.mu.Lock()
	if _, exists := m.states[info.ID]; exists {
		m.mu.Unlock()
		return
	}
	m.states[info.ID] = &RelayReservation{
		RelayPeerID:       info.ID.String(),
		RelayAddr:         firstAddrString(info.Addrs),
		Status:            "pending",
		ReservationStatus: "none",
		UpdatedAt:         time.Now().UTC(),
	}
	loopCtx, cancel := context.WithCancel(m.ctx)
	m.loops[info.ID] = cancel
	m.mu.Unlock()

	m.wg.Add(1)
	go m.reserveLoop(loopCtx, info, source)
}

// AddRelayCandidate adds a Raminga relay candidate from config, DHT or a user
// connect. The set is bounded by the configured known-relay budget plus a
// small discovery budget.
func (m *relayManager) AddRelayCandidate(info peer.AddrInfo, source string) bool {
	if info.ID == "" || len(info.Addrs) == 0 {
		return false
	}
	if m.cfg.Paused != nil && m.cfg.Paused(info.ID) {
		return false
	}
	m.mu.Lock()
	_, exists := m.states[info.ID]
	count := len(m.states)
	m.mu.Unlock()
	if exists {
		return false
	}
	if count >= len(m.cfg.KnownRelays)+8 {
		return false
	}
	m.addRelay(info, source)
	m.cachePeer(info, "known")
	return true
}

// AddDiscoveredRelay adds a DHT-discovered relay candidate.
func (m *relayManager) AddDiscoveredRelay(info peer.AddrInfo) bool {
	return m.AddRelayCandidate(info, "dht")
}

func (m *relayManager) reserveLoop(ctx context.Context, info peer.AddrInfo, source string) {
	defer m.wg.Done()
	relayID := info.ID
	backoff := time.Second
	for {
		if ctx.Err() != nil || (m.cfg.Paused != nil && m.cfg.Paused(relayID)) {
			return
		}
		m.update(relayID, func(s *RelayReservation) {
			s.Status = "connecting"
			s.Attempts++
			s.UpdatedAt = time.Now().UTC()
		})
		connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := m.host.Connect(connectCtx, peer.AddrInfo{ID: info.ID, Addrs: info.Addrs})
		cancel()
		if err != nil {
			m.fail(relayID, fmt.Errorf("connect relay: %w", err), false)
			if !sleepContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		m.update(relayID, func(s *RelayReservation) {
			s.Status = "reserving"
			s.UpdatedAt = time.Now().UTC()
		})
		reserveCtx, reserveCancel := context.WithTimeout(ctx, 30*time.Second)
		res, err := relayv2client.Reserve(reserveCtx, m.host, peer.AddrInfo{ID: info.ID, Addrs: info.Addrs})
		reserveCancel()
		if err != nil {
			m.fail(relayID, fmt.Errorf("relay reservation: %w", err), true)
			if !sleepContext(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		advertised, dialable := m.relayedAddrs(info, res)
		m.update(relayID, func(s *RelayReservation) {
			s.Status = "active"
			s.ReservationStatus = "active"
			s.Successes++
			s.LastError = ""
			s.ExpiresAt = res.Expiration.UTC()
			s.RelayedAddr = dialable
			s.AdvertisedAddr = advertised
			s.LimitDuration = res.LimitDuration
			s.LimitData = res.LimitData
			s.UpdatedAt = time.Now().UTC()
		})
		m.addrs.setRelay(relayID, advertised, true)
		m.logger.Info("relay reservation active",
			"relay_peer_id", relayID.String(),
			"relayed_addr", dialable,
			"expires_at", res.Expiration.UTC().Format(time.RFC3339Nano),
			"limit_duration", res.LimitDuration.String(),
			"limit_data", res.LimitData)
		m.cachePeer(info, "pinned")

		refresh := time.Until(res.Expiration) - 20*time.Second
		if refresh > 30*time.Second {
			// Refresh often enough to notice a relay loss and switch relays
			// without waiting for a long reservation TTL.
			refresh = 30 * time.Second
		}
		if refresh < 5*time.Second {
			refresh = 5 * time.Second
		}
		if !sleepContext(ctx, refresh) {
			return
		}
	}
}

func (m *relayManager) relayedAddrs(info peer.AddrInfo, res *relayv2client.Reservation) (advertised, dialable string) {
	// The relay's own address is the circuit prefix. Reservation.Addrs are
	// vouched addresses of the reserving peer, not the relay, so never use
	// them as the prefix. Strip any accidental /p2p suffix to avoid doubling
	// the relay Peer ID (/p2p/R/p2p/R/p2p-circuit).
	base := firstAddrString(info.Addrs)
	if base == "" {
		for _, addr := range res.Addrs {
			if addr == nil || strings.Contains(addr.String(), "/p2p-circuit") {
				continue
			}
			base = addr.String()
			break
		}
	}
	if base == "" {
		return "", ""
	}
	if idx := strings.Index(base, "/p2p/"); idx >= 0 {
		base = base[:idx]
	}
	base = strings.TrimSuffix(base, "/")
	relayPart := fmt.Sprintf("%s/p2p/%s", base, info.ID.String())
	advertised = relayPart + "/p2p-circuit"
	dialable = advertised + "/p2p/" + m.self.String()
	return advertised, dialable
}

func (m *relayManager) fail(relayID peer.ID, err error, reservation bool) {
	m.update(relayID, func(s *RelayReservation) {
		s.Status = "failed"
		if reservation {
			s.ReservationStatus = "failed"
		}
		s.Failures++
		s.LastError = err.Error()
		s.RelayedAddr = ""
		s.AdvertisedAddr = ""
		s.UpdatedAt = time.Now().UTC()
	})
	m.addrs.setRelay(relayID, "", false)
	m.logger.Warn("relay reservation failed", "relay_peer_id", relayID.String(), "error", err)
}

func (m *relayManager) markLost(relayID peer.ID) {
	m.update(relayID, func(s *RelayReservation) {
		if s.Status == "active" {
			s.Status = "lost"
			s.ReservationStatus = "lost"
			s.LastError = "relay connection closed; reservation lost"
			s.RelayedAddr = ""
			s.AdvertisedAddr = ""
			s.UpdatedAt = time.Now().UTC()
		}
	})
	m.addrs.setRelay(relayID, "", false)
}

func (m *relayManager) update(relayID peer.ID, mutate func(*RelayReservation)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if state := m.states[relayID]; state != nil {
		mutate(state)
	}
}

func (m *relayManager) watchRelayDisconnects(ctx context.Context) {
	defer m.wg.Done()
	sub, err := m.host.EventBus().Subscribe(new(event.EvtPeerConnectednessChanged))
	if err != nil {
		m.logger.Warn("subscribe relay connectedness failed", "error", err)
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
			evt := e.(event.EvtPeerConnectednessChanged)
			if evt.Connectedness != network.NotConnected {
				continue
			}
			m.mu.Lock()
			_, known := m.states[evt.Peer]
			m.mu.Unlock()
			if known {
				m.markLost(evt.Peer)
			}
		}
	}
}

func (m *relayManager) cachePeer(info peer.AddrInfo, source string) {
	if m.cache == nil {
		return
	}
	addrs := make([]string, 0, len(info.Addrs))
	for _, addr := range info.Addrs {
		addrs = append(addrs, addr.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := m.cache.UpsertPeerCache(ctx, info.ID.String(), addrs, source, m.ttl, m.max); err != nil {
		m.logger.Debug("cache relay peer failed", "peer_id", info.ID.String(), "error", err)
	}
}

// Reservations returns all configured/discovered relay states.
func (m *relayManager) Reservations() []RelayReservation {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]RelayReservation, 0, len(m.states))
	for _, state := range m.states {
		out = append(out, *state)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RelayPeerID < out[j].RelayPeerID })
	return out
}

// Provider returns the provider status.
func (m *relayManager) Provider() RelayProviderStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.provStat
}

// ActiveRelayedAddrs returns advertised circuit addresses currently active.
func (m *relayManager) ActiveRelayedAddrs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, state := range m.states {
		if state.Status == "active" && state.AdvertisedAddr != "" {
			out = append(out, state.AdvertisedAddr)
		}
	}
	sort.Strings(out)
	return out
}

// Pause stops the relay loop immediately and drops the candidate so AutoRelay
// cannot redial it. A later explicit connect can add it again from scratch.
func (m *relayManager) Pause(pid peer.ID) {
	m.mu.Lock()
	cancel := m.loops[pid]
	delete(m.loops, pid)
	delete(m.states, pid)
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.addrs.setRelay(pid, "", false)
}

func (m *relayManager) Close() error {
	if m == nil {
		return nil
	}
	if m.cancel != nil {
		m.cancel()
	}
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		m.logger.Warn("relay manager shutdown timed out")
	}
	var err error
	if m.provider != nil {
		err = m.provider.Close()
	}
	m.acl.Close()
	return err
}

func firstAddrString(addrs []ma.Multiaddr) string {
	if len(addrs) == 0 {
		return ""
	}
	return addrs[0].String()
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 10*time.Second {
		next = 10 * time.Second
	}
	return next
}
