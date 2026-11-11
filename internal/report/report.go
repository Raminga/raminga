// Package report builds the redacted Raminga test report used by the TUI and
// by `raminga report export`.
//
// The report deliberately contains no private key, API token or (unless the
// caller explicitly opts in) chat text. It is a snapshot of the public local
// API plus a session timeline recorded by the caller.
package report

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/textsafe"
)

// SchemaVersion identifies the report contract. It is independent from the
// Raminga binary version.
const SchemaVersion = "raminga.test-report/1"

// Report is one test-report export.
type Report struct {
	SchemaVersion string         `json:"schema_version"`
	GeneratedAt   string         `json:"generated_at"`
	Tool          Tool           `json:"tool"`
	Host          Host           `json:"host"`
	Node          Node           `json:"node"`
	NAT           NAT            `json:"nat"`
	Peers         []PeerSnapshot `json:"peers"`
	Timeline      []Event        `json:"connection_timeline"`
	RouteChanges  []Change       `json:"route_changes"`
	ACKs          []ACK          `json:"acks"`
	Outbox        Outbox         `json:"outbox"`
	Messages      []Message      `json:"messages"`

	// StillDirectAfterRelayStop is null until the operator/TUI actually
	// observed a relay stop and a later direct connection. It is never guessed.
	StillDirectAfterRelayStop *bool `json:"still_direct_after_relay_stop"`
	// StillDirectObservationSeconds is how long the direct path was observed
	// after the relay-stop mark; zero when not observed.
	StillDirectObservationSeconds int  `json:"still_direct_observation_seconds"`
	MessageTextIncluded           bool `json:"message_text_included"`

	Explanations []string `json:"explanations"`
}

// Tool describes the binary and protocol that produced the report.
type Tool struct {
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	GoVersion       string `json:"go_version"`
	ProtocolVersion string `json:"protocol_version"`
	SchemaVersion   string `json:"schema_version"`
}

// Host describes the machine running the report, never the network.
type Host struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

// Node is the local node identity and advertised addresses. Peer ID and Node
// ID are public network identifiers; keys and tokens are never included.
type Node struct {
	PeerID        string   `json:"peer_id"`
	NodeID        string   `json:"node_id"`
	ListenAddrs   []string `json:"listen_addrs"`
	AnnounceAddrs []string `json:"announce_addrs"`
}

// NAT is the structured AutoNAT/DCUtR/Relay/DHT/resource snapshot with a
// readable explanation list.
type NAT struct {
	Reachability  string        `json:"reachability"`
	AutoNAT       AutoNAT       `json:"autonat"`
	DCUtR         DCUtR         `json:"dcutr"`
	Relays        []Relay       `json:"relay_reservations"`
	RelayProvider RelayProvider `json:"relay_provider"`
	DHT           DHT           `json:"dht"`
	Resources     Resources     `json:"resources"`
	UPnP          bool          `json:"upnp"`
	NATPMP        bool          `json:"nat_pmp"`
	STUN          bool          `json:"stun"`
	Explanations  []string      `json:"explanations"`
	PeerCache     []CachedPeer  `json:"peer_cache"`
}

// AutoNAT is the AutoNAT v2 view. unknown is not unreachable.
type AutoNAT struct {
	Enabled      bool     `json:"enabled"`
	State        string   `json:"state"`
	ProbePeers   []string `json:"probe_peers"`
	HasProbePeer bool     `json:"has_probe_peer"`
}

// DCUtR is the public hole-punch counter view.
type DCUtR struct {
	Enabled   bool   `json:"enabled"`
	Attempts  int32  `json:"attempts"`
	Successes int32  `json:"successes"`
	Failures  int32  `json:"failures"`
	Peers     []Peer `json:"peers"`
}

type Peer struct {
	PeerID          string   `json:"peer_id"`
	Status          string   `json:"status"`
	Attempts        int32    `json:"attempts"`
	Successes       int32    `json:"successes"`
	Failures        int32    `json:"failures"`
	CandidateAddrs  []string `json:"candidate_addresses"`
	DirectAddress   string   `json:"direct_address"`
	DirectTransport string   `json:"direct_transport"`
	RelayAddress    string   `json:"relay_address"`
	Error           string   `json:"error"`
	UpdatedAtUnixMS int64    `json:"updated_at_unix_ms"`
}

type Relay struct {
	RelayPeerID    string `json:"relay_peer_id"`
	RelayAddr      string `json:"relay_addr"`
	Status         string `json:"status"`
	Reservation    string `json:"reservation_status"`
	Attempts       int32  `json:"attempts"`
	Successes      int32  `json:"successes"`
	Failures       int32  `json:"failures"`
	RelayedAddr    string `json:"relayed_addr"`
	AdvertisedAddr string `json:"advertised_addr"`
	LastError      string `json:"last_error"`
	ExpiresAtMS    int64  `json:"expires_at_unix_ms"`
}

type RelayProvider struct {
	Enabled                bool   `json:"enabled"`
	MaxReservations        int32  `json:"max_reservations"`
	MaxReservationsPerIP   int32  `json:"max_reservations_per_ip"`
	MaxReservationsPerPeer int32  `json:"max_reservations_per_peer"`
	MaxCircuits            int32  `json:"max_circuits"`
	Error                  string `json:"error"`
}

type DHT struct {
	Enabled           bool     `json:"enabled"`
	Mode              string   `json:"mode"`
	Protocol          string   `json:"protocol"`
	BootstrapPeers    []string `json:"bootstrap_peers"`
	RoutingTablePeers []string `json:"routing_table_peers"`
	RelayCandidates   int32    `json:"relay_candidates"`
	LastError         string   `json:"last_error"`
	PublicBootstrap   bool     `json:"public_bootstrap_configured"`
}

type Resources struct {
	MaxConnections  int32 `json:"max_connections"`
	OpenConnections int32 `json:"open_connections"`
	MaxStreams      int32 `json:"max_streams"`
	OpenStreams     int32 `json:"open_streams"`
	MaxMemoryBytes  int64 `json:"max_memory_bytes"`
	MaxFDs          int32 `json:"max_fds"`
	PeerStorePeers  int32 `json:"peerstore_peers"`
	CacheEntries    int32 `json:"cache_entries"`
	Goroutines      int32 `json:"goroutines"`
	HeapAllocBytes  int64 `json:"heap_alloc_bytes"`
}

type CachedPeer struct {
	PeerID          string   `json:"peer_id"`
	Addrs           []string `json:"addrs"`
	Source          string   `json:"source"`
	UpdatedAtUnixMS int64    `json:"updated_at_unix_ms"`
	ExpiresAtUnixMS int64    `json:"expires_at_unix_ms"`
}

// PeerSnapshot is one live/cached peer at export time.
type PeerSnapshot struct {
	PeerID      string   `json:"peer_id"`
	Addrs       []string `json:"addrs"`
	Online      bool     `json:"online"`
	Route       string   `json:"route"`
	Transport   string   `json:"transport"`
	Family      string   `json:"family"`
	Limited     bool     `json:"limited"`
	Direct      bool     `json:"direct"`
	Direction   string   `json:"direction"`
	RelayPeerID string   `json:"relay_peer_id"`
	Sources     []string `json:"sources"`
}

// Event is one connection/route observation in the session timeline.
type Event struct {
	At        string `json:"at"`
	Kind      string `json:"kind"`
	PeerID    string `json:"peer_id"`
	Route     string `json:"route"`
	Transport string `json:"transport"`
	Family    string `json:"family"`
	Direct    bool   `json:"direct"`
	Limited   bool   `json:"limited"`
	Direction string `json:"direction"`
	Relay     string `json:"relay_peer_id"`
	Address   string `json:"address"`
	Detail    string `json:"detail"`
}

// Change is a route transition for one peer.
type Change struct {
	At        string `json:"at"`
	PeerID    string `json:"peer_id"`
	From      string `json:"from"`
	To        string `json:"to"`
	Transport string `json:"transport"`
}

// ACK is one send/ACK result.
type ACK struct {
	At           string `json:"at"`
	MessageID    string `json:"message_id"`
	PeerID       string `json:"peer_id"`
	Acked        bool   `json:"acked"`
	Reason       string `json:"reason"`
	Route        string `json:"route"`
	Transport    string `json:"transport"`
	OutboxStatus string `json:"outbox_status"`
	TextIncluded bool   `json:"text_included"`
	Text         string `json:"text,omitempty"`
}

type Outbox struct {
	Entries []OutboxEntry `json:"entries"`
	Stats   OutboxStats   `json:"stats"`
}

type OutboxEntry struct {
	MessageID     string `json:"message_id"`
	PeerID        string `json:"peer_id"`
	Status        string `json:"status"`
	Attempts      int32  `json:"attempts"`
	Bytes         int32  `json:"bytes"`
	LastError     string `json:"last_error"`
	CreatedAtMS   int64  `json:"created_at_unix_ms"`
	ExpiresAtMS   int64  `json:"expires_at_unix_ms"`
	NextAttemptMS int64  `json:"next_attempt_at_unix_ms"`
	TextIncluded  bool   `json:"text_included"`
	Text          string `json:"text,omitempty"`
}

type OutboxStats struct {
	Pending      int32 `json:"pending"`
	Acked        int32 `json:"acked"`
	Failed       int32 `json:"failed"`
	Cancelled    int32 `json:"cancelled"`
	PendingBytes int64 `json:"pending_bytes"`
}

// Message is one persisted message. Text is omitted unless opted in.
type Message struct {
	MessageID    string `json:"message_id"`
	PeerID       string `json:"peer_id"`
	Direction    string `json:"direction"`
	Acked        bool   `json:"acked"`
	CreatedAtMS  int64  `json:"created_at_unix_ms"`
	AckedAtMS    int64  `json:"acked_at_unix_ms"`
	TextIncluded bool   `json:"text_included"`
	Text         string `json:"text,omitempty"`
}

// Options are the caller-provided session facts.
type Options struct {
	Version                       string
	IncludeText                   bool
	Timeline                      []Event
	RouteChanges                  []Change
	ACKs                          []ACK
	StillDirectAfterRelayStop     *bool
	StillDirectObservationSeconds int
	Now                           time.Time
}

// Build snapshots the local API into a report. It never reads keys/tokens.
func Build(st *apiv1.StatusResponse, peers *apiv1.PeersResponse, msgs *apiv1.RecentMessagesResponse, outbox *apiv1.OutboxListResponse, opts Options) *Report {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	version := opts.Version
	if version == "" {
		version = "unknown"
	}
	commit := Commit()
	r := &Report{
		SchemaVersion: SchemaVersion,
		GeneratedAt:   now.UTC().Format(time.RFC3339),
		Tool: Tool{
			Version:         version,
			Commit:          commit,
			GoVersion:       runtime.Version(),
			ProtocolVersion: st.GetProtocolVersion(),
			SchemaVersion:   SchemaVersion,
		},
		Host: Host{OS: runtime.GOOS, Arch: runtime.GOARCH},
		Node: Node{
			PeerID:        st.GetPeerId(),
			NodeID:        st.GetNodeId(),
			ListenAddrs:   cleanSlice(st.GetListenAddrs()),
			AnnounceAddrs: cleanSlice(st.GetAdvertisedAddrs()),
		},
		Peers:                         peerSnapshots(peers.GetPeers()),
		Timeline:                      append(make([]Event, 0, len(opts.Timeline)), opts.Timeline...),
		RouteChanges:                  append(make([]Change, 0, len(opts.RouteChanges)), opts.RouteChanges...),
		ACKs:                          append(make([]ACK, 0, len(opts.ACKs)), opts.ACKs...),
		StillDirectAfterRelayStop:     opts.StillDirectAfterRelayStop,
		StillDirectObservationSeconds: opts.StillDirectObservationSeconds,
		MessageTextIncluded:           opts.IncludeText,
	}
	// Timelines and ACK text are explicit fields; sanitize every untrusted
	// string except opted-in text.
	sanitizeEvents(r.Timeline)
	sanitizeChanges(r.RouteChanges)
	sanitizeACKs(r.ACKs, opts.IncludeText)
	sanitizeSnapshots(r.Peers)

	n := st.GetNetwork()
	if n != nil {
		r.NAT = NAT{
			Reachability: n.GetReachability(),
			AutoNAT: AutoNAT{
				Enabled:      n.GetAutonat().GetEnabled(),
				State:        n.GetAutonat().GetState(),
				ProbePeers:   cleanSlice(n.GetAutonat().GetProbePeers()),
				HasProbePeer: n.GetAutonat().GetHasProbePeer(),
			},
			DCUtR: DCUtR{
				Enabled:   n.GetDcutr().GetEnabled(),
				Attempts:  n.GetDcutr().GetAttempts(),
				Successes: n.GetDcutr().GetSuccesses(),
				Failures:  n.GetDcutr().GetFailures(),
				Peers:     dcutrPeers(n.GetDcutr().GetPeers()),
			},
			Relays:        relays(n.GetRelays()),
			RelayProvider: relayProvider(n.GetRelayProvider()),
			DHT: DHT{
				Enabled:           n.GetDht().GetEnabled(),
				Mode:              n.GetDht().GetMode(),
				Protocol:          n.GetDht().GetProtocol(),
				BootstrapPeers:    cleanSlice(n.GetDht().GetBootstrapPeers()),
				RoutingTablePeers: cleanSlice(n.GetDht().GetRoutingTablePeers()),
				RelayCandidates:   n.GetDht().GetRelayCandidates(),
				LastError:         textsafe.Sanitize(n.GetDht().GetLastError()),
				PublicBootstrap:   n.GetDht().GetPublicBootstrapConfigured(),
			},
			Resources: Resources{
				MaxConnections:  n.GetResources().GetMaxConnections(),
				OpenConnections: n.GetResources().GetOpenConnections(),
				MaxStreams:      n.GetResources().GetMaxStreams(),
				OpenStreams:     n.GetResources().GetOpenStreams(),
				MaxMemoryBytes:  n.GetResources().GetMaxMemoryBytes(),
				MaxFDs:          n.GetResources().GetMaxFds(),
				PeerStorePeers:  n.GetResources().GetPeerstorePeers(),
				CacheEntries:    n.GetResources().GetCacheEntries(),
				Goroutines:      n.GetResources().GetGoroutines(),
				HeapAllocBytes:  n.GetResources().GetHeapAllocBytes(),
			},
			UPnP:      n.GetUpnp(),
			NATPMP:    n.GetNatPmp(),
			STUN:      n.GetStun(),
			PeerCache: cachedPeers(n.GetPeerCache()),
		}
		if r.NAT.Reachability == "" {
			r.NAT.Reachability = "unknown"
		}
		r.Explanations = Explain(n, peers.GetPeers())
		r.NAT.Explanations = append([]string(nil), r.Explanations...)
	} else {
		r.NAT.Reachability = "unknown"
		r.Explanations = []string{"Network diagnostics unavailable: the daemon returned no network status."}
		r.NAT.Explanations = append([]string(nil), r.Explanations...)
	}

	r.Messages = make([]Message, 0, len(msgs.GetMessages()))
	for _, m := range msgs.GetMessages() {
		out := Message{
			MessageID:    m.GetMessageId(),
			PeerID:       m.GetPeerId(),
			Direction:    m.GetDirection(),
			Acked:        m.GetAcked(),
			CreatedAtMS:  m.GetCreatedAtUnixMs(),
			AckedAtMS:    m.GetAckedAtUnixMs(),
			TextIncluded: opts.IncludeText,
		}
		if opts.IncludeText {
			out.Text = m.GetText()
		}
		r.Messages = append(r.Messages, out)
	}
	o := outbox.GetStats()
	r.Outbox = Outbox{Entries: make([]OutboxEntry, 0, len(outbox.GetEntries())),
		Stats: OutboxStats{
			Pending:      o.GetPending(),
			Acked:        o.GetAcked(),
			Failed:       o.GetFailed(),
			Cancelled:    o.GetCancelled(),
			PendingBytes: o.GetPendingBytes(),
		},
	}
	for _, e := range outbox.GetEntries() {
		entry := OutboxEntry{
			MessageID:     e.GetMessageId(),
			PeerID:        e.GetPeerId(),
			Status:        e.GetStatus(),
			Attempts:      e.GetAttempts(),
			Bytes:         e.GetBytes(),
			LastError:     textsafe.Sanitize(e.GetLastError()),
			CreatedAtMS:   e.GetCreatedAtUnixMs(),
			ExpiresAtMS:   e.GetExpiresAtUnixMs(),
			NextAttemptMS: e.GetNextAttemptAtUnixMs(),
			TextIncluded:  opts.IncludeText,
		}
		if opts.IncludeText {
			entry.Text = e.GetText()
		}
		r.Outbox.Entries = append(r.Outbox.Entries, entry)
	}
	return r
}

// Commit returns the VCS revision embedded by the Go toolchain, or "unknown".
func Commit() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" && s.Value != "" {
			if len(s.Value) > 12 {
				return s.Value[:12]
			}
			return s.Value
		}
	}
	return "unknown"
}

// JSON marshals a report with stable indentation.
func JSON(r *Report) ([]byte, error) {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode report: %w", err)
	}
	return append(b, '\n'), nil
}

// WriteJSON writes test-report.json into dir atomically.
func WriteJSON(dir string, r *Report) (string, error) {
	b, err := JSON(r)
	if err != nil {
		return "", err
	}
	return writeAtomic(dir, "test-report.json", b)
}

// WriteMarkdown writes test-report.md into dir atomically.
func WriteMarkdown(dir string, r *Report) (string, error) {
	return writeAtomic(dir, "test-report.md", Markdown(r))
}

func writeAtomic(dir, name string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create report directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".report-*")
	if err != nil {
		return "", fmt.Errorf("create report file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	path := dir + string(os.PathSeparator) + name
	if err := os.Rename(tmpName, path); err != nil {
		return "", err
	}
	return path, nil
}

// Explain turns the diagnostics into short, honest statements. It never
// upgrades an unknown reachability to unreachable and never calls an attempt a
// success.
func Explain(n *apiv1.NetworkStatus, peers []*apiv1.PeerEntry) []string {
	if n == nil {
		return []string{"Network diagnostics unavailable."}
	}
	out := make([]string, 0, 6)
	an := n.GetAutonat()
	if an.GetEnabled() {
		if an.GetState() == "unknown" || !an.GetHasProbePeer() {
			out = append(out, "AutoNAT: reachability unknown (no Raminga probe peer); this is not \"unreachable\".")
		} else {
			out = append(out, "AutoNAT: reachability "+textsafe.Sanitize(an.GetState())+".")
		}
	}
	d := n.GetDcutr()
	if d.GetAttempts() > 0 && d.GetSuccesses() == 0 {
		msg := fmt.Sprintf("DCUtR: %d attempt(s), 0 success(es), %d failure(s); no direct path has been proven.", d.GetAttempts(), d.GetFailures())
		if hasRelayPeer(peers) {
			msg += " Only a relay path is currently available; this can be symmetric NAT/CGNAT or a blocked transport."
		}
		out = append(out, msg)
	}
	if hasRelayPeer(peers) {
		out = append(out, "At least one peer is reachable only through a limited Circuit Relay path; TCP direct may be BLOCKED behind dual NAT. Relay fallback is not direct.")
	}
	for _, p := range peers {
		if !p.GetOnline() {
			continue
		}
		if p.GetRoute() == "relay" && p.GetTransport() == "tcp" && d.GetFailures() > 0 {
			out = append(out, "TCP direct BLOCKED for "+shortPeer(p.GetPeerId())+" behind dual NAT; relay fallback is in use.")
			break
		}
	}
	for _, relay := range n.GetRelays() {
		if relay.GetReservationStatus() == "failed" || relay.GetLastError() != "" {
			out = append(out, "Relay reservation error for "+shortPeer(relay.GetRelayPeerId())+": "+textsafe.Sanitize(relay.GetLastError())+".")
		}
	}
	if n.GetDht().GetEnabled() && n.GetDht().GetLastError() != "" {
		out = append(out, "DHT: "+textsafe.Sanitize(n.GetDht().GetLastError())+".")
	}
	if n.GetDht().GetEnabled() && len(n.GetDht().GetRoutingTablePeers()) == 0 {
		out = append(out, "DHT routing table is empty; bootstrap/discovery may be incomplete.")
	}
	if n.GetUpnp() || n.GetNatPmp() || n.GetStun() {
		out = append(out, "Unexpected UPnP/NAT-PMP/STUN path reported; inspect the build immediately.")
	}
	if len(out) == 0 {
		out = append(out, "No diagnostic problem reported by the local API.")
	}
	return out
}

func hasRelayPeer(peers []*apiv1.PeerEntry) bool {
	for _, p := range peers {
		if p.GetOnline() && p.GetRoute() == "relay" {
			return true
		}
	}
	return false
}

func shortPeer(id string) string {
	if len(id) > 16 {
		return id[:16] + "…"
	}
	return id
}

func cleanSlice(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		out = append(out, textsafe.Sanitize(s))
	}
	return out
}

func peerSnapshots(in []*apiv1.PeerEntry) []PeerSnapshot {
	out := make([]PeerSnapshot, 0, len(in))
	for _, p := range in {
		family := "unknown"
		for _, a := range p.GetAddrs() {
			switch {
			case strings.Contains(a, "/p2p-circuit"):
				family = "relay"
			case strings.Contains(a, "/ip6/"):
				family = "ipv6"
			case strings.Contains(a, "/ip4/"):
				family = "ipv4"
			}
			if family != "unknown" {
				break
			}
		}
		out = append(out, PeerSnapshot{
			PeerID:      p.GetPeerId(),
			Addrs:       cleanSlice(p.GetAddrs()),
			Online:      p.GetOnline(),
			Route:       p.GetRoute(),
			Transport:   p.GetTransport(),
			Family:      family,
			Limited:     p.GetLimited(),
			Direct:      p.GetDirect(),
			Direction:   p.GetDirection(),
			RelayPeerID: p.GetRelayPeerId(),
			Sources:     cleanSlice(p.GetSources()),
		})
	}
	return out
}

func dcutrPeers(in []*apiv1.DCUtRPeer) []Peer {
	out := make([]Peer, 0, len(in))
	for _, p := range in {
		out = append(out, Peer{
			PeerID:          p.GetPeerId(),
			Status:          p.GetStatus(),
			Attempts:        p.GetAttempts(),
			Successes:       p.GetSuccesses(),
			Failures:        p.GetFailures(),
			CandidateAddrs:  cleanSlice(p.GetCandidateAddresses()),
			DirectAddress:   textsafe.Sanitize(p.GetDirectAddress()),
			DirectTransport: p.GetDirectTransport(),
			RelayAddress:    textsafe.Sanitize(p.GetRelayAddress()),
			Error:           textsafe.Sanitize(p.GetError()),
			UpdatedAtUnixMS: p.GetUpdatedAtUnixMs(),
		})
	}
	return out
}

func relays(in []*apiv1.RelayReservation) []Relay {
	out := make([]Relay, 0, len(in))
	for _, r := range in {
		out = append(out, Relay{
			RelayPeerID:    r.GetRelayPeerId(),
			RelayAddr:      textsafe.Sanitize(r.GetRelayAddr()),
			Status:         r.GetStatus(),
			Reservation:    r.GetReservationStatus(),
			Attempts:       r.GetAttempts(),
			Successes:      r.GetSuccesses(),
			Failures:       r.GetFailures(),
			RelayedAddr:    textsafe.Sanitize(r.GetRelayedAddr()),
			AdvertisedAddr: textsafe.Sanitize(r.GetAdvertisedAddr()),
			LastError:      textsafe.Sanitize(r.GetLastError()),
			ExpiresAtMS:    r.GetExpiresAtUnixMs(),
		})
	}
	return out
}

func relayProvider(p *apiv1.RelayProviderStatus) RelayProvider {
	return RelayProvider{
		Enabled:                p.GetEnabled(),
		MaxReservations:        p.GetMaxReservations(),
		MaxReservationsPerIP:   p.GetMaxReservationsPerIp(),
		MaxReservationsPerPeer: p.GetMaxReservationsPerPeer(),
		MaxCircuits:            p.GetMaxCircuits(),
		Error:                  textsafe.Sanitize(p.GetError()),
	}
}

func cachedPeers(in []*apiv1.CachedPeer) []CachedPeer {
	out := make([]CachedPeer, 0, len(in))
	for _, p := range in {
		out = append(out, CachedPeer{
			PeerID:          p.GetPeerId(),
			Addrs:           cleanSlice(p.GetAddrs()),
			Source:          p.GetSource(),
			UpdatedAtUnixMS: p.GetUpdatedAtUnixMs(),
			ExpiresAtUnixMS: p.GetExpiresAtUnixMs(),
		})
	}
	return out
}

func sanitizeEvents(in []Event) {
	for i := range in {
		in[i].PeerID = textsafe.Sanitize(in[i].PeerID)
		in[i].Route = textsafe.Sanitize(in[i].Route)
		in[i].Transport = textsafe.Sanitize(in[i].Transport)
		in[i].Family = textsafe.Sanitize(in[i].Family)
		in[i].Direction = textsafe.Sanitize(in[i].Direction)
		in[i].Relay = textsafe.Sanitize(in[i].Relay)
		in[i].Address = textsafe.Sanitize(in[i].Address)
		in[i].Detail = textsafe.Sanitize(in[i].Detail)
	}
}

func sanitizeChanges(in []Change) {
	for i := range in {
		in[i].PeerID = textsafe.Sanitize(in[i].PeerID)
		in[i].From = textsafe.Sanitize(in[i].From)
		in[i].To = textsafe.Sanitize(in[i].To)
		in[i].Transport = textsafe.Sanitize(in[i].Transport)
	}
}

func sanitizeACKs(in []ACK, includeText bool) {
	for i := range in {
		in[i].MessageID = textsafe.Sanitize(in[i].MessageID)
		in[i].PeerID = textsafe.Sanitize(in[i].PeerID)
		in[i].Reason = textsafe.Sanitize(in[i].Reason)
		in[i].Route = textsafe.Sanitize(in[i].Route)
		in[i].Transport = textsafe.Sanitize(in[i].Transport)
		in[i].OutboxStatus = textsafe.Sanitize(in[i].OutboxStatus)
		if !includeText {
			in[i].Text = ""
			in[i].TextIncluded = false
		}
	}
}

func sanitizeSnapshots(in []PeerSnapshot) {
	for i := range in {
		in[i].PeerID = textsafe.Sanitize(in[i].PeerID)
		in[i].Route = textsafe.Sanitize(in[i].Route)
		in[i].Transport = textsafe.Sanitize(in[i].Transport)
		in[i].Family = textsafe.Sanitize(in[i].Family)
		in[i].Direction = textsafe.Sanitize(in[i].Direction)
		in[i].RelayPeerID = textsafe.Sanitize(in[i].RelayPeerID)
	}
}
