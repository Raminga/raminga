// Package node orchestrates identity, config, storage, network and protocol.
// It is the only package that composes the base modules; it never reimplements
// their policies.
package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/libp2p/go-libp2p/core/event"
	libp2pnet "github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/identity"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/peerarg"
	"github.com/Raminga/raminga/internal/protocol"
	"github.com/Raminga/raminga/internal/storage"
)

const (
	eventBufferSize = 64
	storeTimeout    = 5 * time.Second
)

// Options constructs a Node. The Node takes ownership of Store and Network and
// closes them on Stop; the caller keeps ownership of Identity and its lock.
type Options struct {
	DataDir    string
	Version    string
	Config     config.Config
	Identity   *identity.Identity
	Store      *storage.Store
	Network    *network.Network
	Logger     *slog.Logger
	TestAPI    bool
	Supervised bool
}

// Node is the running node orchestration.
type Node struct {
	dataDir    string
	version    string
	cfg        config.Config
	identity   *identity.Identity
	store      *storage.Store
	net        *network.Network
	proto      *protocol.Service
	content    *content.Store
	logger     *slog.Logger
	testAPI    bool
	supervised bool

	allowUnknownPeers bool
	allowedPeers      map[string]struct{}
	deniedPeers       map[string]struct{}

	startedAt time.Time
	notify    *libp2pnet.NotifyBundle

	subsMu     sync.Mutex
	subs       map[uint64]chan Event
	nextSub    uint64
	subsClosed bool

	outboxCancel   context.CancelFunc
	outboxWG       sync.WaitGroup
	outboxSub      event.Subscription
	outboxMu       sync.Mutex
	outboxInflight map[string]bool
	outboxSem      chan struct{}

	friendsSyncMu   sync.Mutex
	friendsCancel   context.CancelFunc
	friendsWG       sync.WaitGroup
	friendsSyncedAt atomic.Int64

	stopOnce sync.Once
	stopped  atomic.Bool
}

// New validates dependencies and constructs the node.
func New(opts Options) (*Node, error) {
	if opts.Identity == nil || opts.Store == nil || opts.Network == nil {
		return nil, errors.New("node: identity, storage and network are required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	n := &Node{
		dataDir:           opts.DataDir,
		version:           opts.Version,
		cfg:               opts.Config,
		identity:          opts.Identity,
		store:             opts.Store,
		net:               opts.Network,
		logger:            logger,
		testAPI:           opts.TestAPI,
		supervised:        opts.Supervised,
		allowUnknownPeers: opts.Config.Chat.AllowUnknownPeers,
		allowedPeers:      make(map[string]struct{}, len(opts.Config.Chat.AllowedPeerIDs)),
		deniedPeers:       make(map[string]struct{}, len(opts.Config.Chat.DeniedPeerIDs)),
		subs:              make(map[uint64]chan Event),
		outboxInflight:    make(map[string]bool),
	}
	for _, raw := range opts.Config.Chat.AllowedPeerIDs {
		if pid, err := peer.Decode(raw); err == nil {
			n.allowedPeers[pid.String()] = struct{}{}
		}
	}
	for _, raw := range opts.Config.Chat.DeniedPeerIDs {
		if pid, err := peer.Decode(raw); err == nil {
			n.deniedPeers[pid.String()] = struct{}{}
		}
	}
	opts.Store.SetMaxMessages(opts.Config.Storage.MaxStoredMessages)
	svc, err := protocol.New(protocol.Options{
		MaxBodyBytes:     opts.Config.Limits.MaxMessageBytes,
		MaxChatTextBytes: opts.Config.Limits.MaxChatTextBytes,
		RatePerSecond:    opts.Config.Limits.AppMessagesPerSecond,
		RateBurst:        opts.Config.Limits.AppBurst,
		Handler:          n.handleInbound,
		Logger:           logger,
	})
	if err != nil {
		return nil, fmt.Errorf("node: create protocol service: %w", err)
	}
	n.proto = svc
	contentStore, err := content.New(opts.DataDir, opts.Identity.PeerID().String(), content.Limits{
		MaxFileBytes: opts.Config.Content.MaxFileBytes, MaxPostsBytes: opts.Config.Content.MaxPostsBytes, MaxProfileBytes: opts.Config.Content.MaxProfileBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("node: open content store: %w", err)
	}
	n.content = contentStore
	return n, nil
}

// Start launches the network subsystems, then registers the chat protocol and
// connection notifiee.
func (n *Node) Start(ctx context.Context) error {
	if err := n.net.Start(ctx); err != nil {
		return fmt.Errorf("node: start network: %w", err)
	}
	chat := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remote, ok := p2phttp.PeerID(r.Context())
		if !ok {
			http.Error(w, "unauthenticated peer", http.StatusBadRequest)
			return
		}
		n.proto.HandleHTTP(w, r, remote)
	})
	n.net.HTTPHandler().Handle("POST "+protocol.ChatPath, n.recordInteraction("chat", chat))
	hello := http.HandlerFunc(n.handleHello)
	n.net.HTTPHandler().Handle("POST /hello", n.net.HTTPLimiter(n.recordInteraction("hello", hello)))
	manifest := http.HandlerFunc(n.handleManifest)
	files := http.HandlerFunc(n.handleFile)
	n.net.HTTPHandler().Handle("GET /manifest", n.net.HTTPLimiter(n.recordInteraction("manifest", manifest)))
	n.net.HTTPHandler().Handle("GET /files/{path...}", n.net.HTTPLimiter(n.recordInteraction("files", files)))
	if _, err := n.syncFriends(ctx); err != nil {
		n.logger.Warn("initial friends.json sync failed", "error", err)
	}
	friendsCtx, friendsCancel := context.WithCancel(ctx)
	n.friendsCancel = friendsCancel
	n.startFriendsSync(friendsCtx)
	n.notify = &libp2pnet.NotifyBundle{
		ConnectedF: func(_ libp2pnet.Network, c libp2pnet.Conn) {
			n.publishConnection(c, "connected")
		},
		DisconnectedF: func(_ libp2pnet.Network, c libp2pnet.Conn) {
			n.publishConnection(c, "disconnected")
		},
	}
	n.net.Host().Network().Notify(n.notify)
	n.startOutbox(ctx)
	go n.recoverFriends(ctx)
	n.startedAt = time.Now()
	n.logger.Info("node started",
		"peer_id", n.identity.PeerID().String(),
		"node_id", n.identity.NodeID(),
		"listen_addrs", n.net.ListenAddrs(),
		"data_dir", n.dataDir,
		"protocol", protocol.HTTPProtocol,
		"version", n.version)
	return nil
}

// Stop unregisters notifications and closes the network and storage.
func (n *Node) Stop(context.Context) error {
	var err error
	n.stopOnce.Do(func() {
		n.stopped.Store(true)
		if n.notify != nil {
			n.net.Host().Network().StopNotify(n.notify)
		}
		n.subsMu.Lock()
		n.subsClosed = true
		for id, ch := range n.subs {
			close(ch)
			delete(n.subs, id)
		}
		n.subsMu.Unlock()

		if n.friendsCancel != nil {
			n.friendsCancel()
		}
		friendsDone := make(chan struct{})
		go func() { n.friendsWG.Wait(); close(friendsDone) }()
		select {
		case <-friendsDone:
		case <-time.After(5 * time.Second):
		}
		if n.outboxCancel != nil {
			n.outboxCancel()
		}
		done := make(chan struct{})
		go func() {
			n.outboxWG.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		if n.outboxSub != nil {
			_ = n.outboxSub.Close()
		}
		netErr := n.net.Close()
		contentErr := n.content.Close()
		storeErr := n.store.Close()
		n.logger.Info("node stopped", "peer_id", n.identity.PeerID().String())
		err = errors.Join(netErr, contentErr, storeErr)
	})
	return err
}

// Status returns a point-in-time view. Cached peer hints are listed with
// Online=false; they are never reported as reachable.
func (n *Node) Status(ctx context.Context) (Status, error) {
	if n.stopped.Load() {
		return Status{}, errors.New("node is stopped")
	}
	entries, err := n.net.Peers(ctx)
	if err != nil {
		return Status{}, err
	}
	peers := make([]PeerStatus, 0, len(entries))
	for _, entry := range entries {
		peers = append(peers, PeerStatus{
			PeerID:      entry.PeerID,
			Addrs:       entry.Addrs,
			Sources:     entry.Sources,
			Direction:   entry.Direction,
			Route:       entry.Route,
			Transport:   entry.Transport,
			RelayPeerID: entry.RelayPeerID,
			Direct:      entry.Direct,
			Limited:     entry.Limited,
			Paused:      entry.Paused,
			Online:      entry.Online,
			OpenedAt:    entry.LastSeen,
		})
	}
	cache, _ := n.peerCache(ctx)
	reach := n.net.AutoNAT()
	return Status{
		PeerID:          n.identity.PeerID().String(),
		NodeID:          n.identity.NodeID(),
		ListenAddrs:     n.net.ListenAddrs(),
		AdvertisedAddrs: n.net.AdvertisedAddrs(),
		Version:         n.version,
		ProtocolVersion: protocol.HTTPProtocol,
		StartedAt:       n.startedAt,
		Peers:           peers,
		Connections:     n.net.Connections(),
		TestAPI:         n.testAPI,
		Supervised:      n.supervised,
		DataDir:         n.dataDir,
		GoVersion:       runtime.Version(),
		ContentWarnings: n.contentWarnings(),
		Network: NetworkStatus{
			Reachability:  reach.State,
			AutoNAT:       reach,
			DCUtR:         n.net.DCUtR(),
			Relays:        n.net.RelayReservations(),
			RelayProvider: n.net.RelayProvider(),
			DHT:           n.dhtStatus(),
			Resources:     n.net.ResourceStatus(ctx),
			PeerCache:     cache,
			UPNP:          false,
			NATPMP:        false,
			STUN:          false,
		},
	}, nil
}

func (n *Node) peerCache(ctx context.Context) ([]network.CachedPeer, error) {
	rows, err := n.store.ListKnownPeers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]network.CachedPeer, 0, len(rows))
	for _, row := range rows {
		cached := network.CachedPeer{
			PeerID:    row.PeerID,
			Addrs:     row.Addrs,
			Source:    row.Source,
			UpdatedAt: time.UnixMilli(row.UpdatedAtMS),
		}
		if row.ExpiresAtMS > 0 {
			cached.ExpiresAt = time.UnixMilli(row.ExpiresAtMS)
			if cached.ExpiresAt.Before(time.Now()) {
				continue
			}
		}
		out = append(out, cached)
	}
	return out, nil
}

func (n *Node) dhtStatus() network.DHTStatus {
	if n.net.DHT() == nil {
		return network.DHTStatus{Mode: "disabled"}
	}
	status := n.net.DHT().Status()
	status.RelayCandidates = n.net.RelayCandidates()
	return status
}

// Connect dials a peer by explicit multiaddr or, when only a Peer ID is given,
// through resolved PeerStore/cache/DHT candidates.
func (n *Node) Connect(ctx context.Context, peerID, multiaddr string) (ConnectResult, error) {
	peerID, multiaddr = peerarg.Normalize(peerID), peerarg.Normalize(multiaddr)
	if peerID == "" && multiaddr == "" {
		return ConnectResult{}, errors.New("node: peer_id or multiaddr is required")
	}
	var target peer.ID
	if multiaddr != "" {
		info, err := peer.AddrInfoFromString(multiaddr)
		if err != nil {
			return ConnectResult{}, fmt.Errorf("node: invalid peer multiaddr %q: %w；%s", multiaddr, err, peerarg.WrappedHint)
		}
		target = info.ID
		if peerID != "" && peerID != target.String() {
			return ConnectResult{}, fmt.Errorf("node: peer_id %s does not match dialed peer %s", peerID, target)
		}
	} else {
		var err error
		target, err = peer.Decode(peerID)
		if err != nil {
			return ConnectResult{}, fmt.Errorf("node: invalid peer ID %q: %w；%s", peerID, err, peerarg.WrappedHint)
		}
	}
	n.restoreFriendAddrs(ctx, target)
	// Clear the pause before dialling so the connection gater allows the
	// explicit user action.
	if err := n.ResumePeer(ctx, target); err != nil {
		return ConnectResult{}, err
	}
	var (
		out network.DialOutcome
		err error
	)
	if multiaddr != "" {
		out, err = n.net.DialMultiaddr(ctx, multiaddr)
	} else {
		out, err = n.net.DialPeerByID(ctx, target)
	}
	if err == nil && out.PeerID != "" {
		if pid, decodeErr := peer.Decode(out.PeerID); decodeErr == nil {
			extraAddr := out.RemoteAddr
			if multiaddr != "" {
				extraAddr = multiaddr
			}
			n.recordFriend(ctx, pid, true, extraAddr)
			n.recordFriendCapabilities(ctx, pid)
			n.net.MaybeAddConnectRelay(ctx, pid)
			if helloErr := n.sendHello(ctx, pid); helloErr != nil {
				n.logger.Warn("hello after connect failed", "peer_id", pid.String(), "error", helloErr)
				res := connectResult(out)
				if res.Note == "" {
					res.Note = "hello failed: " + helloErr.Error()
				} else {
					res.Note += "; hello failed: " + helloErr.Error()
				}
				return res, nil
			}
		}
	}
	return connectResult(out), err
}

func (n *Node) sendHello(ctx context.Context, target peer.ID) error {
	helloCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(helloCtx, http.MethodPost, "http://"+target.String()+"/hello", nil)
	if err != nil {
		return err
	}
	res, err := n.net.HTTPClient().Do(helloCtx, target, req, 1024)
	if err != nil {
		return err
	}
	defer func() { _ = res.Response.Body.Close() }()
	if res.Response.StatusCode < 200 || res.Response.StatusCode >= 300 {
		return fmt.Errorf("hello status %d", res.Response.StatusCode)
	}
	return nil
}

func connectResult(out network.DialOutcome) ConnectResult {
	return ConnectResult{
		PeerID:             out.PeerID,
		Transport:          out.Transport,
		Route:              out.Route,
		RelayPeerID:        out.RelayPeerID,
		Direct:             out.Direct,
		Limited:            out.Limited,
		RemoteMultiaddr:    out.RemoteAddr,
		Reused:             out.Reused,
		RequestedTransport: out.RequestedTransport,
		TransportChanged:   out.TransportChanged,
		Source:             out.Source,
		Attempts:           out.Attempts,
		Note:               out.Note,
	}
}

// SendChat persists an outbound message, sends it and records a matching ACK.
// Transport/ACK failures are returned in SendResult with Acked=false, not as a
// local RPC error; only invalid input and local persistence errors are errors.
func (n *Node) SendChat(ctx context.Context, peerIDStr, multiaddrStr, text string) (SendResult, error) {
	peerIDStr, multiaddrStr = peerarg.Normalize(peerIDStr), peerarg.Normalize(multiaddrStr)
	if peerIDStr == "" && multiaddrStr == "" {
		return SendResult{}, errors.New("node: peer_id or multiaddr is required")
	}
	if err := validateText(text, n.cfg.Limits.MaxChatTextBytes); err != nil {
		return SendResult{}, err
	}

	var target peer.ID
	if multiaddrStr != "" {
		info, err := peer.AddrInfoFromString(multiaddrStr)
		if err != nil {
			return SendResult{}, fmt.Errorf("node: invalid peer multiaddr %q: %w；%s", multiaddrStr, err, peerarg.WrappedHint)
		}
		if peerIDStr != "" && peerIDStr != info.ID.String() {
			return SendResult{}, fmt.Errorf("node: peer_id %s does not match dialed peer %s", peerIDStr, info.ID)
		}
		target = info.ID
	} else {
		var err error
		target, err = peer.Decode(peerIDStr)
		if err != nil {
			return SendResult{}, fmt.Errorf("node: invalid peer ID %q: %w；%s", peerIDStr, err, peerarg.WrappedHint)
		}
	}
	if target == n.identity.PeerID() {
		return SendResult{}, errors.New("node: refusing to send chat to self")
	}
	_ = n.ResumePeer(ctx, target)

	messageID := protocol.NewMessageID()
	createdAt := time.Now()
	// Keep the synchronous send and the retry worker from racing on the same ID.
	if !n.markOutboxInflight(messageID) {
		return SendResult{}, fmt.Errorf("node: message %s is already in flight", messageID)
	}
	defer n.clearOutboxInflight(messageID)
	storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
	err := n.store.SaveOutboundWithOutbox(storeCtx, messageID, target.String(), text, multiaddrStr, createdAt,
		createdAt.Add(n.cfg.OutboxTTL()), n.cfg.Outbox.MaxEntries, n.cfg.Outbox.MaxBytes)
	cancel()
	if err != nil {
		return SendResult{}, err
	}
	outboxStatus := "pending"
	n.restoreFriendAddrs(ctx, target)
	out, dialErr := n.dialForChat(ctx, target, multiaddrStr)
	if dialErr != nil {
		n.logger.Warn("chat send aborted before stream open",
			"peer_id", target.String(), "message_id", messageID, "error", dialErr)
		res := SendResult{
			MessageID:       messageID,
			OutboxStatus:    outboxStatus,
			Error:           dialErr.Error(),
			Reused:          out.Reused,
			Source:          out.Source,
			Attempts:        out.Attempts,
			Note:            out.Note,
			RemoteMultiaddr: out.RemoteAddr,
		}
		return res, nil
	}

	ack, sendErr := n.sendChatHTTP(ctx, target, messageID, text, createdAt)
	if sendErr != nil {
		n.logger.Warn("chat send failed without ACK",
			"peer_id", target.String(), "message_id", messageID, "error", sendErr)
		if permanentSendError(sendErr) {
			storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
			_ = n.store.FailOutbox(storeCtx, messageID, sendErr.Error())
			cancel()
			outboxStatus = "failed"
		}
		return SendResult{MessageID: messageID, OutboxStatus: outboxStatus, Error: sendErr.Error()}, nil
	}

	res := SendResult{
		MessageID:       messageID,
		AckMessageID:    ack.MessageID,
		ACKID:           ack.AckID,
		RemoteMultiaddr: out.RemoteAddr,
		Reused:          out.Reused,
		Source:          out.Source,
		Attempts:        out.Attempts,
		Note:            out.Note,
		Error:           ack.Error,
		OutboxStatus:    outboxStatus,
	}
	n.recordFriend(ctx, target, false)
	if conn, connErr := n.net.ConnectionInfo(target); connErr == nil {
		res.Route = conn.Route
		res.Transport = conn.Transport
		res.RelayPeerID = conn.RelayPeerID
		res.RemoteMultiaddr = conn.RemoteAddr
	}
	if ack.Accepted {
		storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
		err := n.store.MarkOutboxDelivered(storeCtx, messageID, time.Now())
		cancel()
		if err != nil {
			n.logger.Error("ACK received but not persisted",
				"peer_id", target.String(), "message_id", messageID, "error", err)
			res.Error = "ACK received but could not be persisted; reporting unacked"
		} else {
			res.Acked = true
			res.OutboxStatus = "acked"
		}
	} else if permanentRejection(ack.Error) {
		storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
		_ = n.store.FailOutbox(storeCtx, messageID, ack.Error)
		cancel()
		res.OutboxStatus = "failed"
	}
	n.publish(Event{
		At: time.Now(),
		Ack: &AckEvent{
			MessageID: messageID,
			PeerID:    target.String(),
			Accepted:  ack.Accepted,
			Error:     ack.Error,
		},
	})
	return res, nil
}

func (n *Node) sendChatHTTP(ctx context.Context, target peer.ID, messageID, text string, sentAt time.Time) (*protocol.Ack, error) {
	body, err := json.Marshal(protocol.Message{MessageID: messageID, Text: text, SentAtUnixMs: sentAt.UnixMilli()})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+target.String()+protocol.ChatPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	sendTimeout := protocol.DefaultSendTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < sendTimeout {
			sendTimeout = remaining
		}
	}
	reqCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	res, err := n.net.HTTPClient().DoWithDial(reqCtx, target, req.WithContext(reqCtx), protocol.MaxResponseBytes)
	if err != nil {
		return nil, p2phttp.ProtocolMismatch(err, protocol.HTTPProtocol)
	}
	defer func() { _ = res.Response.Body.Close() }()
	if res.Response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(res.Response.Body, 512))
		var bodyErr struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &bodyErr)
		return nil, &protocol.StatusError{Status: res.Response.StatusCode, Reason: bodyErr.Error}
	}
	data, err := io.ReadAll(io.LimitReader(res.Response.Body, protocol.MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > protocol.MaxResponseBytes {
		return nil, protocol.ErrTooLarge
	}
	ack, err := protocol.DecodeAck(data, messageID)
	if err != nil {
		return nil, err
	}
	return ack, nil
}

func permanentSendError(err error) bool {
	var se *protocol.StatusError
	return errors.As(err, &se) && se.Permanent()
}

func (n *Node) dialForChat(ctx context.Context, target peer.ID, multiaddr string) (network.DialOutcome, error) {
	if multiaddr != "" {
		return n.net.DialMultiaddr(ctx, multiaddr)
	}
	return n.net.DialPeerByID(ctx, target)
}

// RecentMessages returns persisted messages newest first.
func (n *Node) RecentMessages(ctx context.Context, limit int) ([]StoredMessage, error) {
	msgs, err := n.store.RecentMessages(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]StoredMessage, 0, len(msgs))
	for _, m := range msgs {
		created := time.UnixMilli(m.CreatedAtMS)
		var ackedAt time.Time
		if m.AckedAtMS > 0 {
			ackedAt = time.UnixMilli(m.AckedAtMS)
		}
		out = append(out, StoredMessage{
			MessageID: m.MessageID,
			PeerID:    m.PeerID,
			Direction: m.Direction,
			Text:      m.Text,
			Acked:     m.Acked,
			CreatedAt: created,
			AckedAt:   ackedAt,
		})
	}
	return out, nil
}

// Subscribe returns a buffered event channel and a cancel function.
func (n *Node) Subscribe(ctx context.Context) (<-chan Event, func(), error) {
	n.subsMu.Lock()
	if n.subsClosed {
		n.subsMu.Unlock()
		return nil, func() {}, errors.New("node is stopped")
	}
	n.nextSub++
	id := n.nextSub
	ch := make(chan Event, eventBufferSize)
	n.subs[id] = ch
	n.subsMu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			n.subsMu.Lock()
			if existing, ok := n.subs[id]; ok {
				delete(n.subs, id)
				close(existing)
			}
			n.subsMu.Unlock()
		})
	}
	go func() {
		<-ctx.Done()
		cancel()
	}()
	return ch, cancel, nil
}

func (n *Node) handleInbound(remote peer.ID, msg *protocol.Message) (bool, string, int) {
	if ok, reason := n.authorize(remote); !ok {
		n.logger.Warn("inbound chat rejected by local peer policy",
			"peer_id", remote.String(), "message_id", msg.MessageID, "reason", reason)
		return false, reason, http.StatusForbidden
	}
	// Persist the authenticated connection Peer ID, never a payload field.
	peerID := remote.String()
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	stored, err := n.store.SaveInbound(ctx, msg.MessageID, peerID, msg.Text, time.UnixMilli(msg.SentAtUnixMs))
	if err != nil {
		n.logger.Error("failed to persist inbound chat", "peer_id", peerID, "message_id", msg.MessageID, "error", err)
		return false, "storage unavailable", http.StatusServiceUnavailable
	}
	if !stored {
		n.logger.Debug("inbound chat already stored", "peer_id", peerID, "message_id", msg.MessageID)
		return true, "", http.StatusOK
	}
	n.publish(Event{
		At: time.Now(),
		Chat: &ChatEvent{
			MessageID:  msg.MessageID,
			FromPeerID: peerID,
			FromNodeID: msg.SenderNodeID,
			Text:       msg.Text,
			Accepted:   true,
		},
	})
	return true, "", http.StatusOK
}

// authorize applies the local contact policy. An authenticated transport peer
// is not automatically a contact: deny wins, then the explicit allow list,
// then the documented default (allow unknown unless configured otherwise).
func (n *Node) handleHello(w http.ResponseWriter, r *http.Request) {
	pid, ok := p2phttp.PeerID(r.Context())
	if !ok {
		http.Error(w, "unauthenticated peer", http.StatusBadRequest)
		return
	}
	if r.ContentLength != 0 {
		http.Error(w, "hello body must be empty", http.StatusBadRequest)
		return
	}
	if ok, reason := n.authorize(pid); !ok {
		n.logger.Warn("hello rejected by local peer policy", "peer_id", pid.String(), "reason", reason)
		http.Error(w, reason, http.StatusForbidden)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (n *Node) authorize(remote peer.ID) (bool, string) {
	key := remote.String()
	if _, denied := n.deniedPeers[key]; denied {
		return false, "peer is denied by local policy"
	}
	if _, allowed := n.allowedPeers[key]; allowed {
		return true, ""
	}
	if n.allowUnknownPeers {
		return true, ""
	}
	return false, "unknown peer is not in the local contact allow list"
}

func (n *Node) publishConnection(c libp2pnet.Conn, kind string) {
	info := n.net.ConnInfo(c)
	n.publish(Event{
		At: time.Now(),
		Connection: &ConnectionEvent{
			PeerID:          info.PeerID,
			Direction:       info.Direction,
			Transport:       info.Transport,
			Route:           info.Route,
			RelayPeerID:     info.RelayPeerID,
			RemoteMultiaddr: info.RemoteAddr,
			Kind:            kind,
			Direct:          info.Direct,
			Limited:         info.Limited,
		},
	})
}

func (n *Node) publish(ev Event) {
	n.subsMu.Lock()
	defer n.subsMu.Unlock()
	if n.subsClosed {
		return
	}
	for _, ch := range n.subs {
		select {
		case ch <- ev:
		default:
			// Events are notifications, not durable state; a slow subscriber
			// must not block the node. The client can re-query RecentMessages.
		}
	}
}

// Peers returns live connections plus cached hints (Online=false).
func (n *Node) Peers(ctx context.Context) ([]PeerStatus, error) {
	st, err := n.Status(ctx)
	if err != nil {
		return nil, err
	}
	return st.Peers, nil
}

// RelayReservations returns real Relay v2 client reservation states.
func (n *Node) RelayReservations() []network.RelayReservation { return n.net.RelayReservations() }

// RelayProvider returns the optional relay provider quotas.
func (n *Node) RelayProvider() network.RelayProviderStatus { return n.net.RelayProvider() }

// AddPeer performs a manual peer add via the local API.
func (n *Node) AddPeer(ctx context.Context, multiaddr string) (network.PeerEntry, error) {
	return n.net.AddPeer(ctx, peerarg.Normalize(multiaddr), "manual")
}

// DHTFindPeer performs a real DHT lookup with a cache fallback source label.
func (n *Node) DHTFindPeer(ctx context.Context, peerID string) (network.DHTPeer, error) {
	peerID = peerarg.Normalize(peerID)
	pid, err := peer.Decode(peerID)
	if err != nil {
		return network.DHTPeer{}, fmt.Errorf("invalid peer ID %q: %w；%s", peerID, err, peerarg.WrappedHint)
	}
	if n.net.DHT() == nil || !n.cfg.DHT.Enabled {
		return network.DHTPeer{}, errors.New("DHT is disabled")
	}
	return n.net.DHT().FindPeer(ctx, pid), nil
}

// DHTStatus returns DHT diagnostics.
func (n *Node) DHTStatus() network.DHTStatus { return n.dhtStatus() }

// Disconnect closes all connections to a peer (test-only API).
func (n *Node) Disconnect(ctx context.Context, peerID string) error {
	peerID = peerarg.Normalize(peerID)
	pid, err := peer.Decode(peerID)
	if err != nil {
		return fmt.Errorf("invalid peer ID %q: %w；%s", peerID, err, peerarg.WrappedHint)
	}
	return n.net.Disconnect(pid)
}

func validateText(text string, maxBytes int) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("node: chat text must not be empty")
	}
	if !utf8.ValidString(text) {
		return errors.New("node: chat text must be valid UTF-8")
	}
	if maxBytes > 0 && len(text) > maxBytes {
		return fmt.Errorf("node: chat text is %d bytes, max %d", len(text), maxBytes)
	}
	return nil
}
