package node

import (
	"time"

	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/storage"
)

// ErrInvalidCursor reports a malformed message or conversation cursor.
var ErrInvalidCursor = storage.ErrInvalidCursor

// Local send provenance values. They are an operator model, not strong auth.
const (
	OriginHuman   = storage.OriginHuman
	OriginAgent   = storage.OriginAgent
	OriginUnknown = storage.OriginUnknown
)

// Delivery states exposed by the local API.
const (
	DeliveryPending   = storage.DeliveryPending
	DeliveryAcked     = storage.DeliveryAcked
	DeliveryFailed    = storage.DeliveryFailed
	DeliveryCancelled = storage.DeliveryCancelled
	DeliveryUnknown   = storage.DeliveryUnknown
	DeliveryReceived  = storage.DeliveryReceived
)

// Status is a point-in-time view of the running node.
type Status struct {
	PeerID            string
	NodeID            string
	ListenAddrs       []string
	AdvertisedAddrs   []string
	Version           string
	ProtocolVersion   string
	StartedAt         time.Time
	Peers             []PeerStatus
	Connections       []network.ConnInfo
	TestAPI           bool
	Supervised        bool
	DataDir           string
	GoVersion         string
	Network           NetworkStatus
	ContentWarnings   []string
	MaxChatTextBytes  int
	MaxStoredMessages int
}

// NetworkStatus groups G2 diagnostics. Cached addresses are never online.
type NetworkStatus struct {
	Reachability  string
	AutoNAT       network.AutoNATStatus
	DCUtR         network.DCUtRStatus
	Relays        []network.RelayReservation
	RelayProvider network.RelayProviderStatus
	DHT           network.DHTStatus
	Resources     network.ResourceStatus
	PeerCache     []network.CachedPeer
	UPNP          bool
	NATPMP        bool
	STUN          bool
}

// PeerStatus is one current connection or cached hint.
type PeerStatus struct {
	PeerID      string
	Addrs       []string
	Sources     []string
	Direction   string
	Transport   string
	Route       string
	RelayPeerID string
	Direct      bool
	Limited     bool
	Paused      bool
	Online      bool
	OpenedAt    time.Time
}

// ConnectResult is the outcome of an explicit dial or a peer-ID dial.
type ConnectResult struct {
	PeerID             string
	Transport          string
	Route              string
	RelayPeerID        string
	Direct             bool
	Limited            bool
	RemoteMultiaddr    string
	Reused             bool
	RequestedTransport string
	TransportChanged   bool
	Source             string
	Attempts           []network.DialAttempt
	Note               string
}

// SendResult is the outcome of one SendChat call. Acked is true only when a
// matching ACK was received and its ACK state was persisted. DeliveryStatus is
// the durable history state and outlives the outbox row.
type SendResult struct {
	MessageID       string
	Acked           bool
	AckMessageID    string
	ACKID           string
	Route           string
	Transport       string
	RelayPeerID     string
	RemoteMultiaddr string
	Reused          bool
	Source          string
	Attempts        []network.DialAttempt
	Note            string
	Error           string
	OutboxStatus    string
	DeliveryStatus  string
	Replayed        bool
	RequestID       string
}

// PublishedFile is one file in the local public manifest.
type PublishedFile struct {
	Path string
	Size int64
}

// PublishedSkip is one local path omitted from the public manifest.
type PublishedSkip struct {
	Path   string
	Reason string
}

// Published is the local-only /published view. It is never served over the
// remote content HTTP routes.
type Published struct {
	Files       []PublishedFile
	Skipped     []PublishedSkip
	GeneratedAt time.Time
	// FriendsSyncedAt is the mtime of friends.json, i.e. when its contents last
	// changed, not the last time friends were synced.
	FriendsSyncedAt time.Time
}

// StoredMessage is a persisted message view.
type StoredMessage struct {
	MessageID         string
	PeerID            string
	Direction         string
	Text              string
	Acked             bool
	CreatedAt         time.Time
	AckedAt           time.Time
	Origin            string
	DeliveryStatus    string
	DeliveryError     string
	DeliveryUpdatedAt time.Time
	ClientRequestID   string
}

// MessageRetention describes currently retained rows, not pruned history.
type MessageRetention struct {
	RetainedMessages int
	OldestAt         time.Time
	MaxMessages      int
}

// Conversation is one Peer's latest retained message.
type Conversation struct {
	PeerID         string
	LastMessageID  string
	Direction      string
	Preview        string
	LastAt         time.Time
	DeliveryStatus string
	Origin         string
	MessageCount   int
}

// HumanOutboundPeer is one durable human-outbound relation.
type HumanOutboundPeer struct {
	PeerID  string
	FirstAt time.Time
	LastAt  time.Time
	// PagingRowID and PagingSnapshotID are opaque keyset positions for the
	// stable relation snapshot. They are not serialized as public relation data.
	PagingRowID      int64
	PagingSnapshotID int64
}

// PublicDiscovery is one successful Agent acquisition from a remote public
// manifest, with the exact path, hash, time and local acquisition source.
type PublicDiscovery struct {
	ID        int64
	PeerID    string
	Path      string
	SHA256    string
	SizeBytes int64
	FetchedAt time.Time
	Source    string
}

// PublicDiscoveryPage is one keyset page of discovery evidence.
type PublicDiscoveryPage struct {
	Discoveries []PublicDiscovery
	NextBefore  string
	HasMore     bool
}

// MessagePage is one keyset page of retained messages, newest first.
type MessagePage struct {
	Messages   []StoredMessage
	NextBefore string
	HasMore    bool
	Retention  MessageRetention
}

// ConversationPage is one keyset page of conversation summaries.
type ConversationPage struct {
	Conversations []Conversation
	NextBefore    string
	HasMore       bool
	Retention     MessageRetention
}

// HumanOutboundPage is one keyset page of durable human-outbound relations.
type HumanOutboundPage struct {
	Peers      []HumanOutboundPeer
	NextBefore string
	HasMore    bool
}

// OutboxEntry is one durable unacknowledged outbound message.
type OutboxEntry struct {
	MessageID     string
	PeerID        string
	Text          string
	Multiaddr     string
	Status        string
	Attempts      int
	Bytes         int
	LastError     string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	NextAttemptAt time.Time
	UpdatedAt     time.Time
}

// OutboxStats is the bounded outbox accounting view.
type OutboxStats struct {
	Pending      int
	Acked        int
	Failed       int
	Cancelled    int
	PendingBytes int64
}

// Event is one local-API notification.
type Event struct {
	At         time.Time
	Chat       *ChatEvent
	Ack        *AckEvent
	Connection *ConnectionEvent
}

// ChatEvent reports an inbound chat message.
type ChatEvent struct {
	MessageID  string
	FromPeerID string
	FromNodeID string
	Text       string
	Duplicate  bool
	Accepted   bool
}

// AckEvent reports an ACK observed by this node.
type AckEvent struct {
	MessageID string
	PeerID    string
	Accepted  bool
	Error     string
}

// ConnectionEvent reports a connection change.
type ConnectionEvent struct {
	PeerID          string
	Direction       string
	Transport       string
	Route           string
	RelayPeerID     string
	RemoteMultiaddr string
	Kind            string // "connected" or "disconnected"
	Direct          bool
	Limited         bool
}

// G2 public type aliases keep the local API dependent on node, not on network
// internals directly.
type (
	AutoNATStatus       = network.AutoNATStatus
	DCUtRStatus         = network.DCUtRStatus
	RelayReservation    = network.RelayReservation
	RelayProviderStatus = network.RelayProviderStatus
	DHTStatus           = network.DHTStatus
	DHTPeer             = network.DHTPeer
	CachedPeer          = network.CachedPeer
	ResourceStatus      = network.ResourceStatus
	PeerEntry           = network.PeerEntry
	DialAttempt         = network.DialAttempt
)
