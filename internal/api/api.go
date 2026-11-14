// Package api implements the local Connect-RPC API.
//
// The default transport is a 0600 Unix domain socket with a 0600 token file.
// An explicit opt-in mode serves the same authenticated Connect-RPC API only
// on a per-run ephemeral TCP listener bound to literal 127.0.0.1, protected by
// a per-run bearer token and a pinned per-run TLS certificate. There is no
// automatic fallback between the two modes. Test-only RPCs are unavailable
// unless the daemon was started with --enable-test-api.
package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/gen/raminga/api/v1/apiv1connect"
	"github.com/Raminga/raminga/internal/api/endpoint"
	"github.com/Raminga/raminga/internal/api/paths"
	"github.com/Raminga/raminga/internal/node"
)

const (
	// SocketFileName is the UDS path inside the data directory.
	SocketFileName = paths.SocketFileName
	// TokenFileName is the bearer token path inside the data directory.
	TokenFileName = paths.TokenFileName
	// APIVersion is the local API contract version reported by Status. Plugin
	// shells compare it against their expected version and ask for a restart
	// or upgrade on mismatch instead of failing individual RPCs.
	APIVersion = "4"
	// tokenBytes is the entropy of the bearer token.
	tokenBytes = 32
)

// Backend is the node surface used by the local API.
type Backend interface {
	Status(ctx context.Context) (node.Status, error)
	Connect(ctx context.Context, peerID, multiaddr string) (node.ConnectResult, error)
	SendChatOrigin(ctx context.Context, peerID, multiaddr, text, origin, requestID string) (node.SendResult, error)
	RecentMessages(ctx context.Context, limit int) ([]node.StoredMessage, error)
	ListMessages(ctx context.Context, peerID, before string, limit int) (node.MessagePage, error)
	ListConversations(ctx context.Context, before string, limit int) (node.ConversationPage, error)
	ListHumanOutboundPeers(ctx context.Context, before string, limit int) (node.HumanOutboundPage, error)
	Outbox(ctx context.Context, limit int) ([]node.OutboxEntry, node.OutboxStats, error)
	CancelOutbox(ctx context.Context, messageID string) error
	Subscribe(ctx context.Context) (<-chan node.Event, func(), error)

	Peers(ctx context.Context) ([]node.PeerStatus, error)
	RelayReservations() []node.RelayReservation
	RelayProvider() node.RelayProviderStatus
	AddPeer(ctx context.Context, multiaddr string) (node.PeerEntry, error)
	DHTStatus() node.DHTStatus
	DHTFindPeer(ctx context.Context, peerID string) (node.DHTPeer, error)
	ListFriends(ctx context.Context) ([]node.Friend, error)
	SetFriendName(ctx context.Context, peerID, name string) (node.Friend, error)
	SetFriendDescription(ctx context.Context, peerID, description string) (node.Friend, error)
	RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (bool, int, error)
	SyncFriends(ctx context.Context) (bool, error)
	Published(ctx context.Context) (node.Published, error)
	ListDiscoveries(ctx context.Context, before string, limit int, familiarOnly bool) (node.PublicDiscoveryPage, error)
	GetPeerManifest(ctx context.Context, peerID string, offset, limit int) (node.PeerManifest, error)
	GetPeerProfile(ctx context.Context, peerID string) (node.PeerProfile, error)
	GetPeerFriends(ctx context.Context, peerID string) (node.PeerFriends, error)
	DownloadPeerFile(ctx context.Context, peerID, path string, progress func(node.DownloadProgress), options node.DownloadOptions) (node.DownloadResult, error)
	ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (node.ConnectResult, error)
	Disconnect(ctx context.Context, peerID string) error
	PausePeer(ctx context.Context, peerID string) error
}

// Options selects the local API transport. The zero value preserves the Unix
// domain socket default.
type Options struct {
	// EnableTCP serves only the opt-in loopback TCP transport. It never starts
	// the Unix socket, and a caller cannot silently fall back to either mode.
	EnableTCP bool
}

// Server serves the Connect-RPC API over the selected local transport.
type Server struct {
	backend    Backend
	logger     *slog.Logger
	testAPI    bool
	agentGuard *agentSendGuard
	dataDir    string
	token      string
	sockPath   string
	srv        *http.Server
	ln         net.Listener
	tcpEnabled bool
	tcpAddr    string
	tcpSrv     *http.Server
	tcpLn      net.Listener
	errCh      chan error
	shutdownCh chan struct{}
}

// SocketPath returns <dataDir>/api.sock.
func SocketPath(dataDir string) string { return paths.SocketPath(dataDir) }

// TokenPath returns <dataDir>/api.token.
func TokenPath(dataDir string) string { return paths.TokenPath(dataDir) }

// NewServer prepares the default Unix-socket API server.
func NewServer(backend Backend, dataDir string, testAPI bool, logger *slog.Logger) (*Server, error) {
	return NewServerWithOptions(backend, dataDir, testAPI, logger, Options{})
}

// NewServerWithOptions prepares the API server for the explicitly selected
// transport. Unix mode ensures the 0600 UDS token file exists; TCP mode does
// not read or create that token, because its bearer token is per-run and lives
// only in the protected discovery document.
func NewServerWithOptions(backend Backend, dataDir string, testAPI bool, logger *slog.Logger, options Options) (*Server, error) {
	if backend == nil {
		return nil, errors.New("api: backend is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if options.EnableTCP {
		return &Server{
			backend:    backend,
			logger:     logger,
			testAPI:    testAPI,
			agentGuard: newAgentSendGuard(dataDir),
			dataDir:    dataDir,
			tcpEnabled: true,
			errCh:      make(chan error, 2),
			shutdownCh: make(chan struct{}, 1),
		}, nil
	}
	token, err := EnsureToken(dataDir)
	if err != nil {
		return nil, err
	}
	sockPath := SocketPath(dataDir)
	if err := paths.ValidateSocketPath(sockPath); err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	return &Server{
		backend:    backend,
		logger:     logger,
		testAPI:    testAPI,
		agentGuard: newAgentSendGuard(dataDir),
		dataDir:    dataDir,
		token:      token,
		sockPath:   sockPath,
		errCh:      make(chan error, 2),
		shutdownCh: make(chan struct{}, 1),
	}, nil
}

// Start serves the explicitly selected transport. TCP mode is mutually
// exclusive with the Unix socket; a stale discovery document is removed before
// the new per-run document is published.
func (s *Server) Start(_ context.Context) error {
	if s.ln != nil || s.tcpLn != nil {
		return errors.New("api: server already started")
	}
	// The daemon holds the data-directory lock before this call. Removing any
	// previous run's discovery file here prevents a stale token/port/cert from
	// being used after a crash.
	if err := endpoint.Remove(s.dataDir); err != nil {
		return fmt.Errorf("api: %w", err)
	}
	if s.tcpEnabled {
		if err := endpoint.Supported(); err != nil {
			return fmt.Errorf("api: %w", err)
		}
		return s.startTCP()
	}
	return s.startUnix()
}

// startUnix listens on the Unix socket, applies 0600 and serves the API.
func (s *Server) startUnix() error {
	if info, err := os.Lstat(s.sockPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("api: refusing to remove non-socket path %q", s.sockPath)
		}
		if err := os.Remove(s.sockPath); err != nil {
			return fmt.Errorf("api: remove stale socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("api: inspect socket path: %w", err)
	}

	ln, err := net.Listen("unix", s.sockPath)
	if err != nil {
		return fmt.Errorf("api: listen on unix socket %q: %w", s.sockPath, err)
	}
	if err := os.Chmod(s.sockPath, 0o600); err != nil {
		_ = ln.Close()
		return fmt.Errorf("api: set socket permissions: %w", err)
	}

	s.srv = &http.Server{
		Handler:           s.withAuth(s.newMux(), s.token),
		ReadHeaderTimeout: 5 * time.Second,
	}
	s.ln = ln
	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.errCh <- fmt.Errorf("api: serve unix socket: %w", err)
		}
	}()
	s.logger.Info("local API listening", "socket", s.sockPath, "test_api", s.testAPI)
	return nil
}

func (s *Server) newMux() *http.ServeMux {
	mux := http.NewServeMux()
	path, handler := apiv1connect.NewRamingaServiceHandler(s)
	mux.Handle(path, handler)
	return mux
}

// Errors reports an unexpected serve failure.
func (s *Server) Errors() <-chan error { return s.errCh }

// ShutdownRequests reports token-authenticated Shutdown RPCs. The daemon owns
// the actual stop sequence so the API can finish writing the response first.
func (s *Server) ShutdownRequests() <-chan struct{} { return s.shutdownCh }

func (s *Server) withAuth(next http.Handler, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		header := r.Header.Get("Authorization")
		got := ""
		if strings.HasPrefix(header, prefix) {
			got = strings.TrimPrefix(header, prefix)
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Close shuts the selected listener down and removes its discovery artifact.
func (s *Server) Close(ctx context.Context) error {
	var errs []error
	if s.srv != nil {
		errs = append(errs, s.srv.Shutdown(ctx))
	}
	if s.tcpSrv != nil {
		errs = append(errs, s.tcpSrv.Shutdown(ctx))
	}
	if s.tcpLn != nil {
		_ = s.tcpLn.Close()
	}
	if s.sockPath != "" {
		_ = os.Remove(s.sockPath)
	}
	// Always remove the discovery artifact: a UDS-mode server also removed a
	// previous run's stale file at Start, and a TCP-mode server must not leave
	// a token/port behind after shutdown.
	if err := endpoint.Remove(s.dataDir); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// EnsureToken loads or creates the 0600 bearer token.
func EnsureToken(dataDir string) (string, error) {
	path := TokenPath(dataDir)
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		token := strings.TrimSpace(string(raw))
		if len(token) < 32 {
			return "", fmt.Errorf("api: token file %q is too short", path)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", fmt.Errorf("api: restrict token permissions: %w", err)
		}
		return token, nil
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return "", fmt.Errorf("api: create data directory: %w", err)
		}
		var b [tokenBytes]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", fmt.Errorf("api: generate token: %w", err)
		}
		token := hex.EncodeToString(b[:])
		if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
			return "", fmt.Errorf("api: write token: %w", err)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", fmt.Errorf("api: set token permissions: %w", err)
		}
		return token, nil
	default:
		return "", fmt.Errorf("api: read token: %w", err)
	}
}

// Status implements the Status RPC.
func (s *Server) Status(ctx context.Context, _ *connect.Request[apiv1.StatusRequest]) (*connect.Response[apiv1.StatusResponse], error) {
	st, err := s.backend.Status(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := &apiv1.StatusResponse{
		PeerId:            st.PeerID,
		NodeId:            st.NodeID,
		ListenAddrs:       st.ListenAddrs,
		Version:           st.Version,
		ProtocolVersion:   st.ProtocolVersion,
		StartedAtUnixMs:   st.StartedAt.UnixMilli(),
		TestApiEnabled:    st.TestAPI,
		Supervised:        st.Supervised,
		DataDir:           st.DataDir,
		GoVersion:         st.GoVersion,
		AdvertisedAddrs:   st.AdvertisedAddrs,
		Network:           networkStatusToProto(st.Network),
		ApiVersion:        APIVersion,
		CurrentTime:       time.Now().UTC().Format(time.RFC3339),
		MaxChatTextBytes:  uint32(st.MaxChatTextBytes),
		MaxStoredMessages: uint32(st.MaxStoredMessages),
	}
	for _, p := range st.Peers {
		resp.Peers = append(resp.Peers, &apiv1.PeerStatus{
			PeerId:         p.PeerID,
			Addrs:          p.Addrs,
			Direction:      p.Direction,
			Transport:      p.Transport,
			Direct:         p.Direct,
			Limited:        p.Limited,
			OpenedAtUnixMs: p.OpenedAt.UnixMilli(),
			Route:          p.Route,
			RelayPeerId:    p.RelayPeerID,
			Online:         p.Online,
			Sources:        p.Sources,
		})
	}
	for _, c := range st.Connections {
		resp.Connections = append(resp.Connections, &apiv1.ConnectionDetail{
			PeerId:          c.PeerID,
			RemoteMultiaddr: c.RemoteAddr,
			LocalMultiaddr:  c.LocalAddr,
			Direction:       c.Direction,
			Transport:       c.Transport,
			Route:           c.Route,
			RelayPeerId:     c.RelayPeerID,
			Direct:          c.Direct,
			Limited:         c.Limited,
			OpenedAtUnixMs:  c.OpenedAt.UnixMilli(),
		})
	}
	return connect.NewResponse(resp), nil
}

// Connect implements the Connect RPC.
func (s *Server) Connect(ctx context.Context, req *connect.Request[apiv1.ConnectRequest]) (*connect.Response[apiv1.ConnectResponse], error) {
	if strings.TrimSpace(req.Msg.GetMultiaddr()) == "" && strings.TrimSpace(req.Msg.GetPeerId()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("multiaddr or peer_id is required"))
	}
	res, err := s.backend.Connect(ctx, req.Msg.GetPeerId(), req.Msg.GetMultiaddr())
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	resp := &apiv1.ConnectResponse{
		PeerId:             res.PeerID,
		Transport:          res.Transport,
		Direct:             res.Direct,
		Limited:            res.Limited,
		RemoteMultiaddr:    res.RemoteMultiaddr,
		Route:              res.Route,
		RelayPeerId:        res.RelayPeerID,
		Reused:             res.Reused,
		RequestedTransport: res.RequestedTransport,
		TransportChanged:   res.TransportChanged,
		Source:             res.Source,
		Note:               res.Note,
		Attempts:           dialAttemptsToProto(res.Attempts),
	}
	return connect.NewResponse(resp), nil
}

func dialAttemptsToProto(attempts []node.DialAttempt) []*apiv1.DialAttempt {
	out := make([]*apiv1.DialAttempt, 0, len(attempts))
	for _, attempt := range attempts {
		out = append(out, &apiv1.DialAttempt{
			Multiaddr: attempt.Multiaddr,
			Source:    attempt.Source,
			Family:    attempt.Family,
			Ok:        attempt.OK,
			Error:     attempt.Error,
			Backoff:   attempt.Backoff,
			Note:      attempt.Note,
		})
	}
	return out
}

// SendChat implements the SendChat RPC.
func (s *Server) SendChat(ctx context.Context, req *connect.Request[apiv1.SendChatRequest]) (*connect.Response[apiv1.SendChatResponse], error) {
	if strings.TrimSpace(req.Msg.GetText()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("text is required"))
	}
	if req.Msg.GetPeerId() == "" && req.Msg.GetMultiaddr() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("peer_id or multiaddr is required"))
	}
	origin, err := sendOrigin(req.Msg.GetOrigin(), req.Msg.GetAgentOrigin())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	// An agent-marked send can never downgrade itself to human to skip the
	// guard. agent_origin remains the compatibility security switch.
	if origin == node.OriginAgent {
		if err := s.agentGuard.check(req.Msg.GetPeerId(), req.Msg.GetMultiaddr(), req.Msg.GetText()); err != nil {
			s.logger.Warn("agent-origin send blocked",
				"peer_id", req.Msg.GetPeerId(),
				"error", err)
			return nil, connect.NewError(connect.CodePermissionDenied, err)
		}
	}
	res, err := s.backend.SendChatOrigin(ctx, req.Msg.GetPeerId(), req.Msg.GetMultiaddr(), req.Msg.GetText(), origin, req.Msg.GetRequestId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&apiv1.SendChatResponse{
		MessageId:       res.MessageID,
		Acked:           res.Acked,
		AckMessageId:    res.AckMessageID,
		AckId:           res.ACKID,
		Error:           res.Error,
		Route:           res.Route,
		Transport:       res.Transport,
		RelayPeerId:     res.RelayPeerID,
		RemoteMultiaddr: res.RemoteMultiaddr,
		Reused:          res.Reused,
		Source:          res.Source,
		Attempts:        dialAttemptsToProto(res.Attempts),
		Note:            res.Note,
		OutboxStatus:    res.OutboxStatus,
		DeliveryStatus:  res.DeliveryStatus,
		Replayed:        res.Replayed,
		RequestId:       res.RequestID,
	}), nil
}

func sendOrigin(value string, agentOrigin bool) (string, error) {
	if agentOrigin {
		return node.OriginAgent, nil
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return node.OriginUnknown, nil
	case node.OriginHuman:
		return node.OriginHuman, nil
	case node.OriginAgent:
		return node.OriginAgent, nil
	case node.OriginUnknown:
		return node.OriginUnknown, nil
	default:
		return "", fmt.Errorf("origin must be human, agent or unknown")
	}
}

// OutboxList implements the durable outbox listing RPC.
func zeroMS(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func (s *Server) OutboxList(ctx context.Context, req *connect.Request[apiv1.OutboxListRequest]) (*connect.Response[apiv1.OutboxListResponse], error) {
	entries, stats, err := s.backend.Outbox(ctx, int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := &apiv1.OutboxListResponse{
		Entries: make([]*apiv1.OutboxEntry, 0, len(entries)),
		Stats: &apiv1.OutboxStats{
			Pending: int32(stats.Pending), Acked: int32(stats.Acked),
			Failed: int32(stats.Failed), Cancelled: int32(stats.Cancelled),
			PendingBytes: stats.PendingBytes,
		},
	}
	for _, e := range entries {
		resp.Entries = append(resp.Entries, &apiv1.OutboxEntry{
			MessageId: e.MessageID, PeerId: e.PeerID, Text: e.Text, Multiaddr: e.Multiaddr, Status: e.Status,
			Attempts: int32(e.Attempts), Bytes: int32(e.Bytes), LastError: e.LastError,
			CreatedAtUnixMs: e.CreatedAt.UnixMilli(), ExpiresAtUnixMs: e.ExpiresAt.UnixMilli(),
			NextAttemptAtUnixMs: zeroMS(e.NextAttemptAt), UpdatedAtUnixMs: e.UpdatedAt.UnixMilli(),
		})
	}
	return connect.NewResponse(resp), nil
}

// OutboxCancel implements the durable outbox cancellation RPC.
func (s *Server) OutboxCancel(ctx context.Context, req *connect.Request[apiv1.OutboxCancelRequest]) (*connect.Response[apiv1.OutboxCancelResponse], error) {
	if strings.TrimSpace(req.Msg.GetMessageId()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("message_id is required"))
	}
	if err := s.backend.CancelOutbox(ctx, req.Msg.GetMessageId()); err != nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return connect.NewResponse(&apiv1.OutboxCancelResponse{Cancelled: true, Status: "cancelled"}), nil
}

// RecentMessages implements the RecentMessages RPC.
func (s *Server) RecentMessages(ctx context.Context, req *connect.Request[apiv1.RecentMessagesRequest]) (*connect.Response[apiv1.RecentMessagesResponse], error) {
	limit := int(req.Msg.GetLimit())
	msgs, err := s.backend.RecentMessages(ctx, limit)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := &apiv1.RecentMessagesResponse{Messages: make([]*apiv1.StoredMessage, 0, len(msgs))}
	for _, m := range msgs {
		resp.Messages = append(resp.Messages, storedMessageToProto(m))
	}
	return connect.NewResponse(resp), nil
}

// ListMessages implements the stable per-Peer keyset query.
func (s *Server) ListMessages(ctx context.Context, req *connect.Request[apiv1.ListMessagesRequest]) (*connect.Response[apiv1.ListMessagesResponse], error) {
	peerID := strings.TrimSpace(req.Msg.GetPeerId())
	if peerID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("peer_id is required"))
	}
	page, err := s.backend.ListMessages(ctx, peerID, req.Msg.GetBefore(), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(pageErrorCode(err), err)
	}
	resp := &apiv1.ListMessagesResponse{
		Messages:   make([]*apiv1.StoredMessage, 0, len(page.Messages)),
		NextBefore: page.NextBefore,
		HasMore:    page.HasMore,
		Retention:  retentionToProto(page.Retention),
	}
	for _, m := range page.Messages {
		resp.Messages = append(resp.Messages, storedMessageToProto(m))
	}
	return connect.NewResponse(resp), nil
}

// ListConversations implements the per-Peer conversation summary query.
func (s *Server) ListConversations(ctx context.Context, req *connect.Request[apiv1.ListConversationsRequest]) (*connect.Response[apiv1.ListConversationsResponse], error) {
	page, err := s.backend.ListConversations(ctx, req.Msg.GetBefore(), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(pageErrorCode(err), err)
	}
	resp := &apiv1.ListConversationsResponse{
		Conversations: make([]*apiv1.ConversationSummary, 0, len(page.Conversations)),
		NextBefore:    page.NextBefore,
		HasMore:       page.HasMore,
		Retention:     retentionToProto(page.Retention),
	}
	for _, c := range page.Conversations {
		resp.Conversations = append(resp.Conversations, &apiv1.ConversationSummary{
			PeerId:         c.PeerID,
			LastMessageId:  c.LastMessageID,
			Direction:      c.Direction,
			Preview:        c.Preview,
			LastAtUnixMs:   c.LastAt.UnixMilli(),
			DeliveryStatus: c.DeliveryStatus,
			Origin:         c.Origin,
			MessageCount:   uint32(c.MessageCount),
		})
	}
	return connect.NewResponse(resp), nil
}

// ListHumanOutboundPeers exposes the durable stage-6 relation.
func (s *Server) ListHumanOutboundPeers(ctx context.Context, req *connect.Request[apiv1.ListHumanOutboundPeersRequest]) (*connect.Response[apiv1.ListHumanOutboundPeersResponse], error) {
	page, err := s.backend.ListHumanOutboundPeers(ctx, req.Msg.GetBefore(), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(pageErrorCode(err), err)
	}
	resp := &apiv1.ListHumanOutboundPeersResponse{
		Peers:      make([]*apiv1.HumanOutboundPeer, 0, len(page.Peers)),
		NextBefore: page.NextBefore,
		HasMore:    page.HasMore,
	}
	for _, p := range page.Peers {
		resp.Peers = append(resp.Peers, &apiv1.HumanOutboundPeer{
			PeerId:        p.PeerID,
			FirstAtUnixMs: p.FirstAt.UnixMilli(),
			LastAtUnixMs:  p.LastAt.UnixMilli(),
		})
	}
	return connect.NewResponse(resp), nil
}

func pageErrorCode(err error) connect.Code {
	if errors.Is(err, node.ErrInvalidCursor) {
		return connect.CodeInvalidArgument
	}
	return connect.CodeInternal
}

func retentionToProto(r node.MessageRetention) *apiv1.MessageRetention {
	var oldest int64
	if !r.OldestAt.IsZero() {
		oldest = r.OldestAt.UnixMilli()
	}
	return &apiv1.MessageRetention{
		RetainedMessages:       uint32(r.RetainedMessages),
		OldestRetainedAtUnixMs: oldest,
		MaxStoredMessages:      uint32(r.MaxMessages),
	}
}

func storedMessageToProto(m node.StoredMessage) *apiv1.StoredMessage {
	var ackedAt, deliveryUpdated int64
	if !m.AckedAt.IsZero() {
		ackedAt = m.AckedAt.UnixMilli()
	}
	if !m.DeliveryUpdatedAt.IsZero() {
		deliveryUpdated = m.DeliveryUpdatedAt.UnixMilli()
	}
	return &apiv1.StoredMessage{
		MessageId:               m.MessageID,
		PeerId:                  m.PeerID,
		Direction:               m.Direction,
		Text:                    m.Text,
		Acked:                   m.Acked,
		CreatedAtUnixMs:         m.CreatedAt.UnixMilli(),
		AckedAtUnixMs:           ackedAt,
		DeliveryStatus:          m.DeliveryStatus,
		DeliveryError:           m.DeliveryError,
		Origin:                  m.Origin,
		DeliveryUpdatedAtUnixMs: deliveryUpdated,
		ClientRequestId:         m.ClientRequestID,
	}
}

// eventHeartbeatInterval is short enough to keep a quiet stream healthy and
// long enough not to pollute the wire.
const eventHeartbeatInterval = 10 * time.Second

// Events implements the server-streaming Events RPC.
func (s *Server) Events(ctx context.Context, _ *connect.Request[apiv1.EventsRequest], stream *connect.ServerStream[apiv1.EventsResponse]) error {
	ch, cancel, err := s.backend.Subscribe(ctx)
	if err != nil {
		return connect.NewError(connect.CodeFailedPrecondition, err)
	}
	defer cancel()

	// Connect-RPC flushes response headers with the first Send. An immediate
	// heartbeat makes the client call return before any chat/ACK arrives, so a
	// quiet stream can no longer look like a dead connection.
	if err := sendHeartbeat(stream); err != nil {
		return err
	}
	ticker := time.NewTicker(eventHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(toProtoEvent(ev)); err != nil {
				return err
			}
		case <-ticker.C:
			if err := sendHeartbeat(stream); err != nil {
				return err
			}
		}
	}
}

func sendHeartbeat(stream *connect.ServerStream[apiv1.EventsResponse]) error {
	return stream.Send(&apiv1.EventsResponse{AtUnixMs: time.Now().UnixMilli(), Heartbeat: true})
}

// TestPing implements the test-only TestPing RPC.
func (s *Server) TestPing(_ context.Context, req *connect.Request[apiv1.TestPingRequest]) (*connect.Response[apiv1.TestPingResponse], error) {
	if !s.testAPI {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("test API is disabled; start the daemon with --enable-test-api"))
	}
	return connect.NewResponse(&apiv1.TestPingResponse{Echo: req.Msg.GetEcho()}), nil
}

func toProtoEvent(ev node.Event) *apiv1.EventsResponse {
	out := &apiv1.EventsResponse{AtUnixMs: ev.At.UnixMilli()}
	switch {
	case ev.Chat != nil:
		out.Body = &apiv1.EventsResponse_ChatReceived{ChatReceived: &apiv1.ChatEvent{
			MessageId:  ev.Chat.MessageID,
			FromPeerId: ev.Chat.FromPeerID,
			FromNodeId: ev.Chat.FromNodeID,
			Text:       ev.Chat.Text,
			Duplicate:  ev.Chat.Duplicate,
			Accepted:   ev.Chat.Accepted,
		}}
	case ev.Ack != nil:
		out.Body = &apiv1.EventsResponse_Ack{Ack: &apiv1.AckEvent{
			MessageId: ev.Ack.MessageID,
			PeerId:    ev.Ack.PeerID,
			Accepted:  ev.Ack.Accepted,
			Error:     ev.Ack.Error,
		}}
	case ev.Connection != nil:
		out.Body = &apiv1.EventsResponse_Connection{Connection: &apiv1.ConnectionEvent{
			PeerId:          ev.Connection.PeerID,
			Direction:       ev.Connection.Direction,
			Transport:       ev.Connection.Transport,
			Direct:          ev.Connection.Direct,
			Limited:         ev.Connection.Limited,
			RemoteMultiaddr: ev.Connection.RemoteMultiaddr,
			Kind:            ev.Connection.Kind,
			Route:           ev.Connection.Route,
			RelayPeerId:     ev.Connection.RelayPeerID,
		}}
	}
	return out
}

// ListFriends implements the ListFriends RPC.
func (s *Server) ListFriends(ctx context.Context, _ *connect.Request[apiv1.ListFriendsRequest]) (*connect.Response[apiv1.ListFriendsResponse], error) {
	rows, err := s.backend.ListFriends(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*apiv1.Friend, 0, len(rows))
	for _, row := range rows {
		out = append(out, friendToProto(row))
	}
	return connect.NewResponse(&apiv1.ListFriendsResponse{Friends: out}), nil
}

// SetFriendName implements the SetFriendName RPC.
func (s *Server) SetFriendName(ctx context.Context, req *connect.Request[apiv1.SetFriendNameRequest]) (*connect.Response[apiv1.SetFriendNameResponse], error) {
	if req.Msg.Name == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required; omit the field only when no edit is intended, or send an explicit empty string to clear it"))
	}
	f, err := s.backend.SetFriendName(ctx, req.Msg.GetPeerId(), *req.Msg.Name)
	if err != nil {
		return nil, friendConnectError(err)
	}
	return connect.NewResponse(&apiv1.SetFriendNameResponse{Friend: friendToProto(f)}), nil
}

// SetFriendDescription implements the SetFriendDescription RPC.
func (s *Server) SetFriendDescription(ctx context.Context, req *connect.Request[apiv1.SetFriendDescriptionRequest]) (*connect.Response[apiv1.SetFriendDescriptionResponse], error) {
	if req.Msg.Description == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("description is required; omit the field only when no edit is intended, or send an explicit empty string to clear it"))
	}
	f, err := s.backend.SetFriendDescription(ctx, req.Msg.GetPeerId(), *req.Msg.Description)
	if err != nil {
		return nil, friendConnectError(err)
	}
	return connect.NewResponse(&apiv1.SetFriendDescriptionResponse{Friend: friendToProto(f)}), nil
}

// RemoveFriend implements the RemoveFriend RPC.
func (s *Server) RemoveFriend(ctx context.Context, req *connect.Request[apiv1.RemoveFriendRequest]) (*connect.Response[apiv1.RemoveFriendResponse], error) {
	removed, pending, err := s.backend.RemoveFriend(ctx, req.Msg.GetPeerId(), req.Msg.GetCancelPending())
	if err != nil {
		if errors.Is(err, node.ErrFriendPendingOutbox) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("有 %d 条待发消息；先确认取消再删除", pending))
		}
		return nil, friendConnectError(err)
	}
	return connect.NewResponse(&apiv1.RemoveFriendResponse{Removed: removed, PendingOutbox: int32(pending)}), nil
}

// SyncFriends implements the SyncFriends RPC.
func (s *Server) SyncFriends(ctx context.Context, _ *connect.Request[apiv1.SyncFriendsRequest]) (*connect.Response[apiv1.SyncFriendsResponse], error) {
	written, err := s.backend.SyncFriends(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&apiv1.SyncFriendsResponse{Written: written}), nil
}

// GetPeerManifest implements the GetPeerManifest RPC.
// Published lists the local public manifest after a forced scan.
func (s *Server) Published(ctx context.Context, _ *connect.Request[apiv1.PublishedRequest]) (*connect.Response[apiv1.PublishedResponse], error) {
	published, err := s.backend.Published(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := &apiv1.PublishedResponse{
		GeneratedAtUnixMs:     zeroMS(published.GeneratedAt),
		FriendsSyncedAtUnixMs: zeroMS(published.FriendsSyncedAt),
	}
	for _, f := range published.Files {
		resp.Files = append(resp.Files, &apiv1.PublishedFile{Path: f.Path, Size: f.Size})
	}
	for _, skipped := range published.Skipped {
		resp.Skipped = append(resp.Skipped, &apiv1.PublishedSkip{Path: skipped.Path, Reason: skipped.Reason})
	}
	return connect.NewResponse(resp), nil
}

// ListDiscoveries returns the local, private acquisition index. Rows exist
// only after an Agent tool successfully fetched a manifest file with evidence
// recording requested.
func (s *Server) ListDiscoveries(ctx context.Context, req *connect.Request[apiv1.ListDiscoveriesRequest]) (*connect.Response[apiv1.ListDiscoveriesResponse], error) {
	page, err := s.backend.ListDiscoveries(ctx, req.Msg.GetBefore(), int(req.Msg.GetLimit()), req.Msg.GetFamiliarOnly())
	if err != nil {
		return nil, connect.NewError(pageErrorCode(err), err)
	}
	resp := &apiv1.ListDiscoveriesResponse{
		Discoveries: make([]*apiv1.Discovery, 0, len(page.Discoveries)),
		NextBefore:  page.NextBefore,
		HasMore:     page.HasMore,
	}
	for _, d := range page.Discoveries {
		resp.Discoveries = append(resp.Discoveries, &apiv1.Discovery{
			Id:              strconv.FormatInt(d.ID, 10),
			PeerId:          d.PeerID,
			Path:            d.Path,
			Sha256:          d.SHA256,
			SizeBytes:       d.SizeBytes,
			FetchedAtUnixMs: d.FetchedAt.UnixMilli(),
			Source:          d.Source,
		})
	}
	return connect.NewResponse(resp), nil
}

func (s *Server) GetPeerManifest(ctx context.Context, req *connect.Request[apiv1.GetPeerManifestRequest]) (*connect.Response[apiv1.GetPeerManifestResponse], error) {
	page, err := s.backend.GetPeerManifest(ctx, req.Msg.GetPeerId(), int(req.Msg.GetOffset()), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	out := &apiv1.GetPeerManifestResponse{Version: int32(page.Version), PeerId: page.PeerID, GeneratedAtUnixMs: page.Generated.UnixMilli(), Total: int32(page.Total), Limited: page.Limited}
	for _, e := range page.Entries {
		out.Entries = append(out.Entries, &apiv1.ManifestEntry{Path: e.Path, Size: e.Size, ModifiedUnixMs: e.ModifiedUnixMS, Sha256: e.SHA256})
	}
	return connect.NewResponse(out), nil
}

// GetPeerProfile implements the GetPeerProfile RPC.
func (s *Server) GetPeerProfile(ctx context.Context, req *connect.Request[apiv1.GetPeerProfileRequest]) (*connect.Response[apiv1.GetPeerProfileResponse], error) {
	p, err := s.backend.GetPeerProfile(ctx, req.Msg.GetPeerId())
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	return connect.NewResponse(&apiv1.GetPeerProfileResponse{PeerId: p.PeerID, Name: p.Name, Text: p.Text, Files: p.Files, Found: p.Found}), nil
}

// GetPeerFriends implements the GetPeerFriends RPC.
func (s *Server) GetPeerFriends(ctx context.Context, req *connect.Request[apiv1.GetPeerFriendsRequest]) (*connect.Response[apiv1.GetPeerFriendsResponse], error) {
	f, err := s.backend.GetPeerFriends(ctx, req.Msg.GetPeerId())
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	out := &apiv1.GetPeerFriendsResponse{PeerId: f.PeerID, Limited: f.Limited}
	for _, c := range f.Friends {
		out.Friends = append(out.Friends, &apiv1.PeerFriendClaim{Name: c.Name, PeerId: c.PeerID, Addrs: c.Addrs, Description: c.Description})
	}
	return connect.NewResponse(out), nil
}

// DownloadPeerFile implements the server-streaming DownloadPeerFile RPC.
func (s *Server) DownloadPeerFile(ctx context.Context, req *connect.Request[apiv1.DownloadPeerFileRequest], stream *connect.ServerStream[apiv1.DownloadPeerFileResponse]) error {
	var result node.DownloadResult
	var downloadErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		result, downloadErr = s.backend.DownloadPeerFile(ctx, req.Msg.GetPeerId(), req.Msg.GetPath(), func(p node.DownloadProgress) {
			_ = stream.Send(&apiv1.DownloadPeerFileResponse{Phase: p.Phase, Path: p.Path, ReceivedBytes: p.Received, TotalBytes: p.Total, Direct: p.Direct})
		}, node.DownloadOptions{
			RecordDiscovery: req.Msg.GetRecordDiscovery(),
			DiscoverySource: req.Msg.GetDiscoverySource(),
		})
	}()
	<-done
	if downloadErr != nil {
		return connect.NewError(connect.CodeUnavailable, downloadErr)
	}
	return stream.Send(&apiv1.DownloadPeerFileResponse{
		Phase: "complete", Path: result.Path, ReceivedBytes: result.Size, TotalBytes: result.Size,
		LocalPath: result.LocalPath, Sha256: result.SHA256, Direct: result.Direct,
		DiscoveryId: result.DiscoveryID, DiscoveryRecorded: result.DiscoveryRecorded,
		DiscoveryError: result.DiscoveryError,
	})
}

// ConnectListedPeer implements the ConnectListedPeer RPC.
func (s *Server) ConnectListedPeer(ctx context.Context, req *connect.Request[apiv1.ConnectListedPeerRequest]) (*connect.Response[apiv1.ConnectListedPeerResponse], error) {
	res, err := s.backend.ConnectListedPeer(ctx, req.Msg.GetPeerId(), req.Msg.GetAddrs())
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	resp := &apiv1.ConnectListedPeerResponse{PeerId: res.PeerID, Transport: res.Transport, Direct: res.Direct, Limited: res.Limited, RemoteMultiaddr: res.RemoteMultiaddr, Route: res.Route, RelayPeerId: res.RelayPeerID, Reused: res.Reused, RequestedTransport: res.RequestedTransport, TransportChanged: res.TransportChanged, Source: res.Source, Note: res.Note, Attempts: dialAttemptsToProto(res.Attempts)}
	return connect.NewResponse(resp), nil
}

func friendConnectError(err error) error {
	switch {
	case errors.Is(err, node.ErrFriendNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, node.ErrFriendNameTaken):
		return connect.NewError(connect.CodeAlreadyExists, err)
	default:
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
}

func friendToProto(f node.Friend) *apiv1.Friend {
	out := &apiv1.Friend{PeerId: f.PeerID, Name: f.Name, Addrs: f.Addrs, Description: f.Description, ManuallyConnected: f.ManuallyConnected, Paused: f.Paused, RelayCapable: f.RelayCapable, DhtCapable: f.DHTCapable}
	if !f.FirstSeen.IsZero() {
		out.FirstSeenUnixMs = f.FirstSeen.UnixMilli()
	}
	if !f.LastInteraction.IsZero() {
		out.LastInteractionUnixMs = f.LastInteraction.UnixMilli()
	}
	return out
}

// Shutdown implements the normal, token-authenticated graceful-stop RPC.
func (s *Server) Shutdown(_ context.Context, _ *connect.Request[apiv1.ShutdownRequest]) (*connect.Response[apiv1.ShutdownResponse], error) {
	select {
	case s.shutdownCh <- struct{}{}:
	default:
		// A shutdown is already queued; accept the request idempotently.
	}
	return connect.NewResponse(&apiv1.ShutdownResponse{Accepted: true}), nil
}

// DisconnectPeer implements the normal, token-authenticated DisconnectPeer RPC.
func (s *Server) DisconnectPeer(ctx context.Context, req *connect.Request[apiv1.DisconnectPeerRequest]) (*connect.Response[apiv1.DisconnectPeerResponse], error) {
	if strings.TrimSpace(req.Msg.GetPeerId()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("peer_id is required"))
	}
	if err := s.backend.PausePeer(ctx, req.Msg.GetPeerId()); err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	return connect.NewResponse(&apiv1.DisconnectPeerResponse{Disconnected: true}), nil
}
