// Package config loads and validates <dataDir>/config.toml.
//
// G2 adds explicit relay, DCUtR, AutoNAT v2, Raminga-only Kademlia DHT,
// AutoRelay, PeerStore-cache and resource-manager knobs. Every network helper
// is opt-in: the relay provider is off by default, there are no public
// bootstrap/relay defaults, and UPnP/NAT-PMP cannot be enabled at all.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
	"github.com/pelletier/go-toml/v2"
)

const (
	// FileName is the config file inside the data directory.
	FileName = "config.toml"

	// DefaultMaxMessageBytes bounds one JSON chat request body.
	DefaultMaxMessageBytes = 1 << 20
	// DefaultMaxChatTextBytes bounds UTF-8 chat text.
	DefaultMaxChatTextBytes = 4096
	// MinMaxMessageBytes is the smallest accepted envelope limit.
	MinMaxMessageBytes = 1024
	// MaxMaxMessageBytes is the largest accepted envelope limit.
	MaxMaxMessageBytes = 16 << 20

	// DHTProtocolPrefix is the only accepted Raminga DHT prefix. The final
	// wire protocol is /raminga/kad/1.0.0.
	DHTProtocolPrefix = "/raminga"
)

// Config is the complete node configuration.
type Config struct {
	Network   Network   `toml:"network"`
	Relay     Relay     `toml:"relay"`
	DHT       DHT       `toml:"dht"`
	AutoNAT   AutoNAT   `toml:"autonat"`
	PeerStore PeerStore `toml:"peerstore"`
	Limits    Limits    `toml:"limits"`
	Chat      Chat      `toml:"chat"`
	Storage   Storage   `toml:"storage"`
	Outbox    Outbox    `toml:"outbox"`
	Content   Content   `toml:"content"`
	Log       Log       `toml:"log"`
}

// Chat is the inbound chat authorization policy. Transport authentication is
// not authorization: an authenticated peer is only a contact when local policy
// says so. The default keeps the G1-G3 behaviour (any authenticated peer may
// send) and is documented as a known G4 gap.
type Chat struct {
	// AllowUnknownPeers allows peers that are not in AllowedPeerIDs. It is true
	// by default for development; set false to require an explicit allow list.
	AllowUnknownPeers bool `toml:"allow_unknown_peers"`
	// AllowedPeerIDs is an explicit contact allow list (libp2p Peer IDs).
	AllowedPeerIDs []string `toml:"allowed_peer_ids"`
	// DeniedPeerIDs always wins over the allow list and the default.
	DeniedPeerIDs []string `toml:"denied_peer_ids"`
}

// Content bounds published public content. Only these three knobs exist.
type Content struct {
	MaxFileBytes    int64 `toml:"max_file_bytes"`
	MaxPostsBytes   int64 `toml:"max_posts_bytes"`
	MaxProfileBytes int64 `toml:"max_profile_bytes"`
}

// Storage bounds durable message growth. Development data may be rebuilt, but a
// remote peer must not be able to grow the database without limit.
type Storage struct {
	// MaxStoredMessages caps rows in the messages table (oldest pruned first).
	MaxStoredMessages int `toml:"max_stored_messages"`
}

// Outbox bounds and retries durable unacknowledged outbound messages.
type Outbox struct {
	MaxEntries   int    `toml:"max_entries"`
	MaxBytes     int64  `toml:"max_bytes"`
	TTL          string `toml:"ttl"`
	RetryInitial string `toml:"retry_initial"`
	RetryMax     string `toml:"retry_max"`
	SweepEvery   string `toml:"sweep_interval"`
}

// Network holds libp2p listen/announce and direct-connection policy.
type Network struct {
	// ListenAddrs may be empty to run without any inbound libp2p listener.
	ListenAddrs []string `toml:"listen_addrs"`
	// AnnounceAddrs overrides the advertised addresses when non-empty. This is
	// how a NATed node announces its WAN address; it does not create any NAT
	// mapping or port forwarding.
	AnnounceAddrs []string `toml:"announce_addrs"`
	// PreferIPv6 sorts candidate addresses IPv6-first.
	PreferIPv6 bool `toml:"prefer_ipv6"`
	// EnableDCUtR enables the go-libp2p hole-punch/DCUtR service.
	EnableDCUtR bool `toml:"enable_dcutr"`
	// DcutrTimeout bounds one direct-dial attempt.
	DcutrTimeout string `toml:"dcutr_timeout"`
	// EnableRelayClient enables the Circuit Relay v2 client transport.
	EnableRelayClient bool `toml:"enable_relay_client"`
	// EnableAutoRelay enables go-libp2p AutoRelay with Raminga relay candidates.
	EnableAutoRelay bool `toml:"enable_auto_relay"`
}

// Relay configures the Circuit Relay v2 client and optional provider service.
type Relay struct {
	// Provider is the relay service. It is off by default and must be enabled
	// explicitly on a publicly reachable node.
	Provider bool `toml:"provider"`
	// KnownRelays are explicit Raminga relay multiaddrs used for reservations.
	KnownRelays []string `toml:"known_relays"`
	// MaxReservations bounds total active reservations (provider).
	MaxReservations int `toml:"max_reservations"`
	// ReservationTTL is the provider reservation lifetime.
	ReservationTTL string `toml:"reservation_ttl"`
	// MaxReservationsPerIP bounds reservations from one source IP.
	MaxReservationsPerIP int `toml:"max_reservations_per_ip"`
	// MaxReservationsPerPeer bounds reservations from one peer.
	MaxReservationsPerPeer int `toml:"max_reservations_per_peer"`
	// MaxCircuits bounds concurrent relayed connections per peer.
	MaxCircuits int `toml:"max_circuits"`
	// ReservationDataLimitBytes bounds relayed bytes per direction.
	ReservationDataLimitBytes int64 `toml:"reservation_data_limit_bytes"`
	// ReservationDurationLimit bounds one relayed connection lifetime.
	ReservationDurationLimit string `toml:"reservation_duration_limit"`
}

// DHT configures the independent Raminga Kademlia DHT.
type DHT struct {
	Enabled bool `toml:"enabled"`
	// Mode is "client", "server" or "auto". NATed peers use "client"; relays
	// and publicly reachable Raminga nodes use "server".
	Mode string `toml:"mode"`
	// ProtocolPrefix is fixed to /raminga (never /ipfs).
	ProtocolPrefix string `toml:"protocol_prefix"`
	// BootstrapPeers are explicit Raminga bootstrap multiaddrs. Empty means no
	// bootstrap peers; the libp2p public IPFS defaults are never used.
	BootstrapPeers []string `toml:"bootstrap_peers"`
	// RefreshInterval controls routing-table refresh and relay discovery.
	RefreshInterval string `toml:"refresh_interval"`
	// QueryTimeout bounds one FindPeer call.
	QueryTimeout string `toml:"query_timeout"`
}

// AutoNAT configures go-libp2p AutoNAT v2. With no probe peer the status is
// reported as unknown, never automatically as unreachable.
type AutoNAT struct {
	Enabled bool `toml:"enabled"`
}

// PeerStore configures the bounded SQLite cache that backs the in-memory
// go-libp2p PeerStore across restarts. It is a hint cache, not an online state.
type PeerStore struct {
	CacheEnabled    bool   `toml:"cache_enabled"`
	CacheMaxEntries int    `toml:"cache_max_entries"`
	CacheTTL        string `toml:"cache_ttl"`
}

// Limits bounds untrusted wire input and libp2p resources.
type Limits struct {
	MaxMessageBytes  int   `toml:"max_message_bytes"`
	MaxChatTextBytes int   `toml:"max_chat_text_bytes"`
	MaxConnections   int   `toml:"max_connections"`
	MaxStreams       int   `toml:"max_streams"`
	MaxMemoryBytes   int64 `toml:"max_memory_bytes"`
	MaxFDs           int   `toml:"max_fds"`
	// AppMessagesPerSecond is the per-peer inbound chat token bucket rate.
	AppMessagesPerSecond float64 `toml:"app_messages_per_second"`
	AppBurst             int     `toml:"app_burst"`
}

// Log configures the slog level.
type Log struct {
	Level string `toml:"level"`
}

// Default returns the G2 defaults. The relay provider is off; there are no
// public bootstrap peers, relays, STUN servers or NAT port mappings.
func Default() Config {
	return Config{
		Network: Network{
			ListenAddrs: []string{
				"/ip4/0.0.0.0/tcp/4001",
				"/ip4/0.0.0.0/udp/4001/quic-v1",
				"/ip6/::/tcp/4001",
				"/ip6/::/udp/4001/quic-v1",
			},
			AnnounceAddrs:     nil,
			PreferIPv6:        true,
			EnableDCUtR:       true,
			DcutrTimeout:      "10s",
			EnableRelayClient: true,
			EnableAutoRelay:   true,
		},
		Relay: Relay{
			Provider:                  false,
			KnownRelays:               nil,
			MaxReservations:           128,
			ReservationTTL:            "1h",
			MaxReservationsPerIP:      8,
			MaxReservationsPerPeer:    1,
			MaxCircuits:               16,
			ReservationDataLimitBytes: 128 << 10,
			ReservationDurationLimit:  "2m",
		},
		DHT: DHT{
			Enabled:         true,
			Mode:            "auto",
			ProtocolPrefix:  DHTProtocolPrefix,
			BootstrapPeers:  nil,
			RefreshInterval: "30s",
			QueryTimeout:    "20s",
		},
		AutoNAT: AutoNAT{Enabled: true},
		PeerStore: PeerStore{
			CacheEnabled:    true,
			CacheMaxEntries: 512,
			CacheTTL:        "168h",
		},
		Limits: Limits{
			MaxMessageBytes:      DefaultMaxMessageBytes,
			MaxChatTextBytes:     DefaultMaxChatTextBytes,
			MaxConnections:       256,
			MaxStreams:           1024,
			MaxMemoryBytes:       128 << 20,
			MaxFDs:               256,
			AppMessagesPerSecond: 5,
			AppBurst:             10,
		},
		Chat: Chat{
			AllowUnknownPeers: true,
			AllowedPeerIDs:    nil,
			DeniedPeerIDs:     nil,
		},
		Storage: Storage{MaxStoredMessages: 50000},
		Outbox: Outbox{
			MaxEntries:   1000,
			MaxBytes:     8 << 20,
			TTL:          "24h",
			RetryInitial: "1s",
			RetryMax:     "1m",
			SweepEvery:   "2s",
		},
		Content: Content{
			MaxFileBytes:    100 << 20,
			MaxPostsBytes:   1 << 30,
			MaxProfileBytes: 10 << 20,
		},
		Log: Log{Level: "info"},
	}
}

// Path returns the config path in dataDir.
func Path(dataDir string) string {
	return filepath.Join(dataDir, FileName)
}

// Load reads config.toml. If it does not exist, Default is written first. The
// decoder rejects unknown keys; dangerous G1 keys get a dedicated error.
func Load(dataDir string) (Config, error) {
	path := Path(dataDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return Config{}, fmt.Errorf("create data directory: %w", err)
		}
		raw = []byte(DefaultTOML)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return Config{}, fmt.Errorf("write default config %q: %w", path, err)
		}
	} else if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}

	cfg, err := Parse(raw)
	if err != nil {
		return Config{}, fmt.Errorf("config %q: %w", path, err)
	}
	return cfg, nil
}

// Parse validates TOML bytes with defaults applied.
func Parse(raw []byte) (Config, error) {
	if err := rejectDangerousKeys(raw); err != nil {
		return Config{}, err
	}

	cfg := Default()
	dec := toml.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("invalid TOML: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate checks every field independently of TOML decoding.
func (c Config) Validate() error {
	if c.Limits.MaxMessageBytes < MinMaxMessageBytes || c.Limits.MaxMessageBytes > MaxMaxMessageBytes {
		return fmt.Errorf("limits.max_message_bytes must be between %d and %d, got %d",
			MinMaxMessageBytes, MaxMaxMessageBytes, c.Limits.MaxMessageBytes)
	}
	if c.Limits.MaxChatTextBytes <= 0 || c.Limits.MaxChatTextBytes > c.Limits.MaxMessageBytes/2 {
		return fmt.Errorf("limits.max_chat_text_bytes must be in 1..%d, got %d",
			c.Limits.MaxMessageBytes/2, c.Limits.MaxChatTextBytes)
	}
	if c.Limits.MaxConnections <= 0 || c.Limits.MaxStreams <= 0 || c.Limits.MaxFDs <= 0 || c.Limits.MaxMemoryBytes <= 0 {
		return errors.New("limits.max_connections, max_streams, max_fds and max_memory_bytes must be positive")
	}
	if c.Limits.MaxFDs < c.Limits.MaxConnections {
		return fmt.Errorf("limits.max_fds (%d) must be >= limits.max_connections (%d)", c.Limits.MaxFDs, c.Limits.MaxConnections)
	}
	if c.Limits.AppMessagesPerSecond <= 0 {
		return errors.New("limits.app_messages_per_second must be positive")
	}
	if c.Limits.AppBurst <= 0 {
		return errors.New("limits.app_burst must be positive")
	}
	if c.Content.MaxFileBytes <= 0 || c.Content.MaxPostsBytes <= 0 || c.Content.MaxProfileBytes <= 0 {
		return errors.New("content.max_file_bytes, max_posts_bytes and max_profile_bytes must be positive")
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log.level must be one of debug|info|warn|error, got %q", c.Log.Level)
	}
	for _, addr := range c.Network.ListenAddrs {
		if err := validateListenAddr(addr); err != nil {
			return err
		}
	}
	for _, addr := range c.Network.AnnounceAddrs {
		if err := validateAnnounceAddr(addr); err != nil {
			return err
		}
	}
	if _, err := time.ParseDuration(c.Network.DcutrTimeout); err != nil {
		return fmt.Errorf("network.dcutr_timeout: %w", err)
	}
	for _, addr := range c.Relay.KnownRelays {
		if err := validateRelayAddr(addr); err != nil {
			return err
		}
	}
	if c.Relay.MaxReservations <= 0 || c.Relay.MaxReservationsPerIP <= 0 || c.Relay.MaxReservationsPerPeer <= 0 || c.Relay.MaxCircuits <= 0 {
		return errors.New("relay reservation/circuit limits must be positive")
	}
	if _, err := time.ParseDuration(c.Relay.ReservationTTL); err != nil {
		return fmt.Errorf("relay.reservation_ttl: %w", err)
	}
	if _, err := time.ParseDuration(c.Relay.ReservationDurationLimit); err != nil {
		return fmt.Errorf("relay.reservation_duration_limit: %w", err)
	}
	if c.Relay.ReservationDataLimitBytes <= 0 {
		return errors.New("relay.reservation_data_limit_bytes must be positive")
	}
	switch c.DHT.Mode {
	case "client", "server", "auto":
	default:
		return fmt.Errorf("dht.mode must be client|server|auto, got %q", c.DHT.Mode)
	}
	if c.DHT.ProtocolPrefix != DHTProtocolPrefix {
		return fmt.Errorf("dht.protocol_prefix must be %q (public IPFS DHT is never used), got %q", DHTProtocolPrefix, c.DHT.ProtocolPrefix)
	}
	for _, addr := range c.DHT.BootstrapPeers {
		if err := validateBootstrapAddr(addr); err != nil {
			return err
		}
	}
	if _, err := time.ParseDuration(c.DHT.RefreshInterval); err != nil {
		return fmt.Errorf("dht.refresh_interval: %w", err)
	}
	if _, err := time.ParseDuration(c.DHT.QueryTimeout); err != nil {
		return fmt.Errorf("dht.query_timeout: %w", err)
	}
	if c.PeerStore.CacheMaxEntries <= 0 || c.PeerStore.CacheMaxEntries > 4096 {
		return fmt.Errorf("peerstore.cache_max_entries must be in 1..4096, got %d", c.PeerStore.CacheMaxEntries)
	}
	if _, err := time.ParseDuration(c.PeerStore.CacheTTL); err != nil {
		return fmt.Errorf("peerstore.cache_ttl: %w", err)
	}
	if c.Storage.MaxStoredMessages <= 0 || c.Storage.MaxStoredMessages > 10_000_000 {
		return fmt.Errorf("storage.max_stored_messages must be in 1..10000000, got %d", c.Storage.MaxStoredMessages)
	}
	if c.Outbox.MaxEntries <= 0 || c.Outbox.MaxEntries > 100_000 {
		return fmt.Errorf("outbox.max_entries must be in 1..100000, got %d", c.Outbox.MaxEntries)
	}
	if c.Outbox.MaxBytes <= 0 || c.Outbox.MaxBytes > 1<<30 {
		return fmt.Errorf("outbox.max_bytes must be in 1..1073741824, got %d", c.Outbox.MaxBytes)
	}
	for name, raw := range map[string]string{
		"outbox.ttl":            c.Outbox.TTL,
		"outbox.retry_initial":  c.Outbox.RetryInitial,
		"outbox.retry_max":      c.Outbox.RetryMax,
		"outbox.sweep_interval": c.Outbox.SweepEvery,
	} {
		if d, err := time.ParseDuration(raw); err != nil || d <= 0 {
			return fmt.Errorf("%s must be a positive duration, got %q", name, raw)
		}
	}
	if c.OutboxRetryMax() < c.OutboxRetryInitial() {
		return errors.New("outbox.retry_max must be >= outbox.retry_initial")
	}
	allowed, err := validatePeerIDList("chat.allowed_peer_ids", c.Chat.AllowedPeerIDs)
	if err != nil {
		return err
	}
	denied, err := validatePeerIDList("chat.denied_peer_ids", c.Chat.DeniedPeerIDs)
	if err != nil {
		return err
	}
	for id := range allowed {
		if _, both := denied[id]; both {
			return fmt.Errorf("chat: peer %s is in both allowed_peer_ids and denied_peer_ids", id)
		}
	}
	return nil
}

func validatePeerIDList(name string, values []string) (map[string]struct{}, error) {
	out := make(map[string]struct{}, len(values))
	for _, raw := range values {
		if strings.TrimSpace(raw) != raw || raw == "" {
			return nil, fmt.Errorf("%s contains an empty or padded peer ID", name)
		}
		pid, err := peer.Decode(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: invalid peer ID %q: %w", name, raw, err)
		}
		out[pid.String()] = struct{}{}
	}
	return out, nil
}

// Duration helpers parse validated duration strings.
func (c Config) DcutrTimeout() time.Duration   { return mustDuration(c.Network.DcutrTimeout) }
func (c Config) ReservationTTL() time.Duration { return mustDuration(c.Relay.ReservationTTL) }
func (c Config) ReservationDurationLimit() time.Duration {
	return mustDuration(c.Relay.ReservationDurationLimit)
}
func (c Config) DHTRefreshInterval() time.Duration { return mustDuration(c.DHT.RefreshInterval) }
func (c Config) DHTQueryTimeout() time.Duration    { return mustDuration(c.DHT.QueryTimeout) }
func (c Config) PeerStoreCacheTTL() time.Duration  { return mustDuration(c.PeerStore.CacheTTL) }
func (c Config) OutboxTTL() time.Duration          { return mustDuration(c.Outbox.TTL) }
func (c Config) OutboxRetryInitial() time.Duration { return mustDuration(c.Outbox.RetryInitial) }
func (c Config) OutboxRetryMax() time.Duration     { return mustDuration(c.Outbox.RetryMax) }
func (c Config) OutboxSweepInterval() time.Duration {
	return mustDuration(c.Outbox.SweepEvery)
}

func mustDuration(s string) time.Duration {
	d, _ := time.ParseDuration(s)
	return d
}

func validateListenAddr(addr string) error {
	if strings.TrimSpace(addr) != addr || addr == "" {
		return fmt.Errorf("network.listen_addrs contains an empty or padded address")
	}
	m, err := ma.NewMultiaddr(addr)
	if err != nil {
		return fmt.Errorf("network.listen_addrs: invalid multiaddr %q: %w", addr, err)
	}
	hasTransport := false
	for _, p := range m.Protocols() {
		switch p.Name {
		case "p2p-circuit", "p2p", "webtransport", "webrtc", "ws", "wss":
			return fmt.Errorf("network.listen_addrs: %q is not a direct listen address (%s is unsupported)", addr, p.Name)
		case "tcp", "quic", "quic-v1":
			hasTransport = true
		case "ip4", "ip6", "dns", "dns4", "dns6":
		default:
			// Other framing protocols are allowed only if a transport follows.
		}
	}
	if !hasTransport {
		return fmt.Errorf("network.listen_addrs: %q has no TCP or QUIC transport", addr)
	}
	return nil
}

func validateAnnounceAddr(addr string) error {
	if strings.TrimSpace(addr) != addr || addr == "" {
		return fmt.Errorf("network.announce_addrs contains an empty or padded address")
	}
	m, err := ma.NewMultiaddr(addr)
	if err != nil {
		return fmt.Errorf("network.announce_addrs: invalid multiaddr %q: %w", addr, err)
	}
	hasTransport := false
	for _, p := range m.Protocols() {
		switch p.Name {
		case "p2p", "p2p-circuit":
			return fmt.Errorf("network.announce_addrs: %q must not contain /%s", addr, p.Name)
		case "tcp", "quic", "quic-v1":
			hasTransport = true
		}
	}
	if !hasTransport {
		return fmt.Errorf("network.announce_addrs: %q has no TCP or QUIC transport", addr)
	}
	return nil
}

func validateRelayAddr(addr string) error {
	if strings.TrimSpace(addr) != addr || addr == "" {
		return fmt.Errorf("relay.known_relays contains an empty or padded address")
	}
	if isPublicBootstrap(addr) {
		return fmt.Errorf("relay.known_relays: %q is a public IPFS/libp2p service; use a Raminga relay", addr)
	}
	m, err := ma.NewMultiaddr(addr)
	if err != nil {
		return fmt.Errorf("relay.known_relays: invalid multiaddr %q: %w", addr, err)
	}
	info, err := peerAddrInfo(m)
	if err != nil {
		return fmt.Errorf("relay.known_relays: %q must include /p2p/<peer-id>: %w", addr, err)
	}
	if info == "" {
		return fmt.Errorf("relay.known_relays: %q is empty", addr)
	}
	for _, p := range m.Protocols() {
		if p.Name == "p2p-circuit" {
			return fmt.Errorf("relay.known_relays: %q must be a direct relay address, not a circuit address", addr)
		}
	}
	return nil
}

func validateBootstrapAddr(addr string) error {
	if strings.TrimSpace(addr) != addr || addr == "" {
		return fmt.Errorf("dht.bootstrap_peers contains an empty or padded address")
	}
	if isPublicBootstrap(addr) {
		return fmt.Errorf("dht.bootstrap_peers: %q is a public IPFS/libp2p bootstrap peer; use Raminga nodes only", addr)
	}
	m, err := ma.NewMultiaddr(addr)
	if err != nil {
		return fmt.Errorf("dht.bootstrap_peers: invalid multiaddr %q: %w", addr, err)
	}
	if _, err := peerAddrInfo(m); err != nil {
		return fmt.Errorf("dht.bootstrap_peers: %q must include /p2p/<peer-id>: %w", addr, err)
	}
	return nil
}

func isPublicBootstrap(addr string) bool {
	lower := strings.ToLower(addr)
	for _, marker := range []string{"bootstrap.libp2p.io", "ipfs.io", "dweb.link", "/ipfs/", "protocol.ai"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func peerAddrInfo(m ma.Multiaddr) (string, error) {
	for _, p := range m.Protocols() {
		if p.Name == "p2p" {
			value, err := m.ValueForProtocol(p.Code)
			if err != nil {
				return "", err
			}
			return value, nil
		}
	}
	return "", errors.New("missing /p2p")
}

func rejectDangerousKeys(raw []byte) error {
	var tree map[string]any
	if err := toml.Unmarshal(raw, &tree); err != nil {
		return fmt.Errorf("invalid TOML: %w", err)
	}
	return walkKeys("", tree)
}

func walkKeys(prefix string, m map[string]any) error {
	for k, v := range m {
		path := k
		if prefix != "" {
			path = prefix + "." + k
		}
		key := strings.ToLower(k)
		switch key {
		case "upnp", "nat_pmp", "nat", "stun", "relay_provider", "api", "identity":
			return fmt.Errorf("config key %q is not supported; UPnP/NAT-PMP/STUN are never enabled", path)
		}

		allowed := false
		var section bool
		switch prefix {
		case "":
			switch key {
			case "network", "relay", "dht", "autonat", "peerstore", "limits", "chat", "storage", "outbox", "content", "log":
				allowed, section = true, true
			}
		case "network":
			switch key {
			case "listen_addrs", "announce_addrs", "prefer_ipv6", "enable_dcutr", "dcutr_timeout",
				"enable_relay_client", "enable_auto_relay":
				allowed = true
			}
		case "relay":
			switch key {
			case "provider", "known_relays", "max_reservations", "reservation_ttl",
				"max_reservations_per_ip", "max_reservations_per_peer", "max_circuits",
				"reservation_data_limit_bytes", "reservation_duration_limit":
				allowed = true
			}
		case "dht":
			switch key {
			case "enabled", "mode", "protocol_prefix", "bootstrap_peers", "refresh_interval", "query_timeout":
				allowed = true
			}
		case "autonat":
			allowed = key == "enabled"
		case "peerstore":
			switch key {
			case "cache_enabled", "cache_max_entries", "cache_ttl":
				allowed = true
			}
		case "limits":
			switch key {
			case "max_message_bytes", "max_chat_text_bytes", "max_connections", "max_streams",
				"max_memory_bytes", "max_fds", "app_messages_per_second", "app_burst":
				allowed = true
			}
		case "content":
			switch key {
			case "max_file_bytes", "max_posts_bytes", "max_profile_bytes":
				allowed = true
			}
		case "chat":
			switch key {
			case "allow_unknown_peers", "allowed_peer_ids", "denied_peer_ids":
				allowed = true
			}
		case "storage":
			allowed = key == "max_stored_messages"
		case "outbox":
			switch key {
			case "max_entries", "max_bytes", "ttl", "retry_initial", "retry_max", "sweep_interval":
				allowed = true
			}
		case "log":
			allowed = key == "level"
		}
		if !allowed {
			return fmt.Errorf("unknown config key %q", path)
		}
		if section {
			child, ok := v.(map[string]any)
			if !ok {
				return fmt.Errorf("config section %q must be a table", path)
			}
			if err := walkKeys(path, child); err != nil {
				return err
			}
		}
	}
	return nil
}

// DefaultTOML is written on first run.
const DefaultTOML = `# Raminga node configuration (G2).
# Relay provider is OFF by default. There are no public bootstrap peers,
# public relays, STUN servers, UPnP or NAT-PMP. All helpers must be Raminga
# nodes and are opt-in.

[network]
# libp2p listen multiaddrs. TCP and QUIC only. An empty list disables all
# inbound libp2p listeners (useful for a local-only/test daemon).
listen_addrs = ["/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/udp/4001/quic-v1", "/ip6/::/tcp/4001", "/ip6/::/udp/4001/quic-v1"]
# Advertised addresses for a NATed node (e.g. its WAN address). This does not
# create a port mapping.
announce_addrs = []
# Sort IPv6 candidates before IPv4 candidates.
prefer_ipv6 = true
# DCUtR hole punching and Circuit Relay v2 client.
enable_dcutr = true
dcutr_timeout = "10s"
enable_relay_client = true
enable_auto_relay = true

[relay]
# Circuit Relay v2 provider. Keep false unless this node is publicly reachable.
provider = false
# Explicit Raminga relay multiaddrs (direct addresses with /p2p/<peer-id>).
known_relays = []
max_reservations = 128
reservation_ttl = "1h"
max_reservations_per_ip = 8
max_reservations_per_peer = 1
max_circuits = 16
reservation_data_limit_bytes = 131072
reservation_duration_limit = "2m"

[dht]
# Independent Raminga Kademlia DHT. Never joins /ipfs/kad/1.0.0.
enabled = true
mode = "auto"
protocol_prefix = "/raminga"
# Explicit Raminga bootstrap peers only. Empty = no bootstrap.
bootstrap_peers = []
refresh_interval = "30s"
query_timeout = "20s"

[autonat]
# AutoNAT v2. With no probe peer the status is unknown, never unreachable.
enabled = true

[peerstore]
# Bounded SQLite hint cache for the in-memory go-libp2p PeerStore.
cache_enabled = true
cache_max_entries = 512
cache_ttl = "168h"

[limits]
max_message_bytes = 1048576
max_chat_text_bytes = 4096
max_connections = 256
max_streams = 1024
max_memory_bytes = 134217728
max_fds = 256
app_messages_per_second = 5
app_burst = 10

[chat]
# Transport authentication is not authorization. The development default keeps
# "any authenticated peer may send chat" (a documented G4 known gap); set this
# to false to require allowed_peer_ids. denied_peer_ids always wins.
allow_unknown_peers = true
allowed_peer_ids = []
denied_peer_ids = []

[storage]
# Oldest messages are pruned so a remote peer cannot grow the database without
# bound. Development data may be rebuilt; revisit retention before release.
max_stored_messages = 50000

[outbox]
# Durable unacked outbound messages. Bounded by rows, bytes and age; retries use
# exponential backoff until a real matching ACK or expiry.
max_entries = 1000
max_bytes = 8388608
ttl = "24h"
retry_initial = "1s"
retry_max = "1m"
sweep_interval = "2s"

[log]
level = "info"
`

// InitOptions controls the config written by Init. Ports are ignored when
// ListenAddrs is non-empty.
type InitOptions struct {
	ListenAddrs    []string
	TCPPort        int
	QUICPort       int
	Force          bool
	RelayProvider  bool
	AnnounceAddrs  []string
	KnownRelays    []string
	BootstrapPeers []string
}

// Init creates dataDir and writes a validated default config without starting
// a node. Existing configs are preserved unless Force is set.
func Init(dataDir string, opts InitOptions) (Config, error) {
	if opts.ListenAddrs == nil {
		tcpPort, quicPort := opts.TCPPort, opts.QUICPort
		if tcpPort == 0 {
			tcpPort = 4001
		}
		if quicPort == 0 {
			quicPort = 4001
		}
		if err := validatePort("tcp", tcpPort); err != nil {
			return Config{}, err
		}
		if err := validatePort("quic", quicPort); err != nil {
			return Config{}, err
		}
		opts.ListenAddrs = []string{
			fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", tcpPort),
			fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", quicPort),
			fmt.Sprintf("/ip6/::/tcp/%d", tcpPort),
			fmt.Sprintf("/ip6/::/udp/%d/quic-v1", quicPort),
		}
	}

	cfg := Default()
	cfg.Network.ListenAddrs = append([]string(nil), opts.ListenAddrs...)
	cfg.Network.AnnounceAddrs = append([]string(nil), opts.AnnounceAddrs...)
	cfg.Relay.Provider = opts.RelayProvider
	cfg.Relay.KnownRelays = append([]string(nil), opts.KnownRelays...)
	cfg.DHT.BootstrapPeers = append([]string(nil), opts.BootstrapPeers...)
	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("invalid init options: %w", err)
	}
	raw, err := RenderTOML(cfg)
	if err != nil {
		return Config{}, err
	}

	path := Path(dataDir)
	if _, err := os.Stat(path); err == nil && !opts.Force {
		return Config{}, fmt.Errorf("config %q already exists; use --force to replace it", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("inspect config %q: %w", path, err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return Config{}, fmt.Errorf("create data directory %q: %w", dataDir, err)
	}
	for _, sub := range []string{"public", "public/profile", "public/posts"} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0o755); err != nil {
			return Config{}, fmt.Errorf("create public content directory %q: %w", sub, err)
		}
	}
	tmp, err := os.CreateTemp(dataDir, ".config-*.toml")
	if err != nil {
		return Config{}, fmt.Errorf("create temporary config in %q: %w", dataDir, err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return Config{}, fmt.Errorf("set config permissions: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return Config{}, fmt.Errorf("write config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return Config{}, fmt.Errorf("close config: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return Config{}, fmt.Errorf("install config %q: %w", path, err)
	}
	return cfg, nil
}

// RenderTOML serializes a validated config with an explanatory header.
func RenderTOML(cfg Config) ([]byte, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	body, err := toml.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("encode config: %w", err)
	}
	header := []byte("# Raminga node configuration.\n" +
		"# Relay provider is OFF by default. There are no public bootstrap peers,\n" +
		"# public relays, STUN servers, UPnP or NAT-PMP. All helpers must be Raminga\n" +
		"# nodes and are opt-in.\n\n")
	return append(header, body...), nil
}

func validatePort(name string, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("--%s-port must be in 1..65535, got %d", name, port)
	}
	return nil
}
