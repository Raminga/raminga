package node

import (
	"time"

	"github.com/Raminga/raminga/internal/network"
)

// Status is a point-in-time view of the running node.
type Status struct {
	PeerID          string
	NodeID          string
	ListenAddrs     []string
	AdvertisedAddrs []string
	Version         string
	ProtocolVersion string
	StartedAt       time.Time
	Peers           []PeerStatus
	Connections     []network.ConnInfo
	TestAPI         bool
	Supervised      bool
	DataDir         string
	GoVersion       string
	Network         NetworkStatus
	ContentWarnings []string
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
// matching ACK was received and its ACK state was persisted.
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
	MessageID string
	PeerID    string
	Direction string
	Text      string
	Acked     bool
	CreatedAt time.Time
	AckedAt   time.Time
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
