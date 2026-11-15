// Package client is a Connect-RPC client for the local Raminga API. It is used
// by the CLI and e2e runner; it never opens go-libp2p directly.
package client

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/gen/raminga/api/v1/apiv1connect"
	"github.com/Raminga/raminga/internal/api/endpoint"
	"github.com/Raminga/raminga/internal/api/paths"
	"github.com/Raminga/raminga/internal/peerarg"
)

// Client talks to one local daemon over its UDS.
type Client struct {
	svc  apiv1connect.RamingaServiceClient
	http *http.Client
}

// DaemonNotRunningError adds the actionable "start the daemon" hint while
// preserving the original dial/token error through Unwrap.
type DaemonNotRunningError struct {
	DataDir string
	Err     error
}

func (e *DaemonNotRunningError) Error() string {
	return fmt.Sprintf("节点未运行（本地 API 不可用）；请先启动：raminga daemon --data-dir %s（底层错误：%v）", e.DataDir, e.Err)
}

func (e *DaemonNotRunningError) Unwrap() error { return e.Err }

// IsDaemonNotRunning reports whether err is the actionable local-daemon error.
func IsDaemonNotRunning(err error) bool {
	var target *DaemonNotRunningError
	return errors.As(err, &target)
}

func daemonNotRunning(dataDir string, err error) error {
	if err == nil || IsDaemonNotRunning(err) {
		return err
	}
	return &DaemonNotRunningError{DataDir: dataDir, Err: err}
}

// New opens the explicitly selected local API transport. The protected TCP
// discovery file is authoritative when present; there is no automatic fallback
// to the Unix socket if it is stale or unreachable. When RAMINGA_API_TCP is
// set, a missing TCP endpoint is an error rather than a UDS fallback.
func New(dataDir string) (*Client, error) {
	doc, found, err := endpoint.ReadIfPresent(dataDir)
	if err != nil {
		return nil, fmt.Errorf("local API endpoint is not usable: %w", err)
	}
	if found {
		return newTCPClient(dataDir, doc)
	}
	if tcpRequested() {
		return nil, errors.New("RAMINGA_API_TCP requires the loopback TCP local API, but no protected endpoint exists; not falling back to the Unix socket")
	}
	return newUnixClient(dataDir)
}

func newUnixClient(dataDir string) (*Client, error) {
	sockPath := paths.SocketPath(dataDir)
	if err := paths.ValidateSocketPath(sockPath); err != nil {
		return nil, err
	}
	token, err := readToken(dataDir)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			conn, err := d.DialContext(ctx, "unix", sockPath)
			if err != nil {
				return nil, daemonNotRunning(dataDir, err)
			}
			return conn, nil
		},
		DisableCompression: true,
	}
	hc := &http.Client{Transport: &authTransport{base: transport, token: token}}
	svc := apiv1connect.NewRamingaServiceClient(hc, "http://unix")
	return &Client{svc: svc, http: hc}, nil
}

func newTCPClient(dataDir string, first endpoint.Document) (*Client, error) {
	gen, err := newTCPGeneration(first)
	if err != nil {
		return nil, err
	}
	transport := &tcpGenerationTransport{dataDir: dataDir, current: gen}
	hc := &http.Client{Transport: transport}
	svc := apiv1connect.NewRamingaServiceClient(hc, "https://127.0.0.1")
	return &Client{svc: svc, http: hc}, nil
}

// tcpGeneration is one immutable execution context for the local TCP API:
// bearer token, validated literal loopback address, pinned TLS config and the
// connection pool that may only carry requests from this generation.
type tcpGeneration struct {
	key       string
	address   string
	transport *http.Transport
	auth      http.RoundTripper
}

func newTCPGeneration(doc endpoint.Document) (*tcpGeneration, error) {
	cfg, err := doc.TLSConfig()
	if err != nil {
		return nil, err
	}
	address := doc.Address
	transport := &http.Transport{
		// Never consult HTTP_PROXY/HTTPS_PROXY or any environment proxy for a
		// loopback control connection.
		Proxy:              nil,
		DisableCompression: true,
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			// The request address is fixed to this generation; never dial a
			// host/port read from the request or a newer endpoint document.
			dialCfg := cfg.Clone()
			// Connect-RPC's streaming and unary calls both work over HTTP/1.1
			// here; the server also advertises h2.
			dialCfg.NextProtos = []string{"http/1.1"}
			dialer := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: dialCfg}
			conn, err := dialer.DialContext(ctx, "tcp4", address)
			if err != nil {
				return nil, fmt.Errorf("local API TCP endpoint is unreachable: %w", err)
			}
			return conn, nil
		},
	}
	return &tcpGeneration{
		key:       endpointGenerationKey(doc),
		address:   address,
		transport: transport,
		auth:      &authTransport{base: transport, token: doc.Token},
	}, nil
}

// roundTrip uses only the captured generation for Host/port, token and pin.
func (g *tcpGeneration) roundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "https"
	clone.URL.Host = g.address
	clone.Host = g.address
	if clone.Body != nil {
		// Present an opaque body so net/http cannot silently replay a mutation
		// on a fresh connection after a generation switch.
		clone.Body = replayBlockedBody{ReadCloser: clone.Body}
		clone.GetBody = nil
	}
	return g.auth.RoundTrip(clone)
}

// replayBlockedBody intentionally hides concrete buffer types from net/http's
// retry classification while preserving streaming reads.
type replayBlockedBody struct {
	io.ReadCloser
}

func endpointGenerationKey(doc endpoint.Document) string {
	return fmt.Sprintf("%d|%s|%s|%s|%s|%d|%d",
		doc.Version, doc.Network, doc.Address, doc.Token, doc.CertSHA256, doc.PID, doc.StartedAtUnixMS)
}

// tcpGenerationTransport resolves one immutable generation for each RPC. A
// changed endpoint swaps in a fresh dedicated pool and closes the old idle
// sockets; in-flight requests are never replayed against the new generation.
type tcpGenerationTransport struct {
	dataDir string
	mu      sync.Mutex
	current *tcpGeneration
}

func (t *tcpGenerationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	gen, err := t.generation()
	if err != nil {
		return nil, err
	}
	return gen.roundTrip(req)
}

func (t *tcpGenerationTransport) generation() (*tcpGeneration, error) {
	doc, found, err := endpoint.ReadIfPresent(t.dataDir)
	if err != nil {
		return nil, fmt.Errorf("local API TCP endpoint is stale: %w", err)
	}
	if !found {
		return nil, errors.New("local API TCP endpoint is missing; not falling back to the Unix socket")
	}
	key := endpointGenerationKey(doc)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.current != nil && t.current.key == key {
		return t.current, nil
	}
	gen, err := newTCPGeneration(doc)
	if err != nil {
		return nil, err
	}
	if t.current != nil {
		t.current.transport.CloseIdleConnections()
	}
	t.current = gen
	return gen, nil
}

func (t *tcpGenerationTransport) CloseIdleConnections() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.current != nil {
		t.current.transport.CloseIdleConnections()
	}
}

func tcpRequested() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RAMINGA_API_TCP"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func readToken(dataDir string) (string, error) {
	path := paths.TokenPath(dataDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", daemonNotRunning(dataDir, err)
		}
		return "", fmt.Errorf("read API token %q: %w", path, err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", errors.New("API token file is empty")
	}
	return token, nil
}

// Close closes idle UDS connections.
func (c *Client) Close() {
	if c != nil && c.http != nil {
		c.http.CloseIdleConnections()
	}
}

// Status calls Status.
func (c *Client) Status(ctx context.Context) (*apiv1.StatusResponse, error) {
	resp, err := c.svc.Status(ctx, connect.NewRequest(&apiv1.StatusRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Connect calls Connect. At least one of peerID and multiaddr must be set.
func (c *Client) Connect(ctx context.Context, peerID, multiaddr string) (*apiv1.ConnectResponse, error) {
	peerID, multiaddr = peerarg.Normalize(peerID), peerarg.Normalize(multiaddr)
	resp, err := c.svc.Connect(ctx, connect.NewRequest(&apiv1.ConnectRequest{PeerId: peerID, Multiaddr: multiaddr}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Local send provenance constants. They mirror internal/storage without making
// the CLI depend on daemon storage types.
const (
	originHuman = "human"
	originAgent = "agent"
)

// SendChat calls SendChat for a human-initiated TUI/CLI send. It deliberately
// leaves agent_origin unset, so daemon-side agent safety checks do not apply.
func (c *Client) SendChat(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	return c.sendChat(ctx, peerID, multiaddr, text, false, "")
}

// SendChatFromAgent calls SendChat with agent_origin set. Every Agent shell
// must use this method (or set the field directly), so the daemon can reject
// private-data leaks and excessive automated sends.
func (c *Client) SendChatFromAgent(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	return c.sendChat(ctx, peerID, multiaddr, text, true, "")
}

func (c *Client) sendChat(ctx context.Context, peerID, multiaddr, text string, agentOrigin bool, requestID string) (*apiv1.SendChatResponse, error) {
	peerID, multiaddr = peerarg.Normalize(peerID), peerarg.Normalize(multiaddr)
	origin := originHuman
	if agentOrigin {
		origin = originAgent
	}
	resp, err := c.svc.SendChat(ctx, connect.NewRequest(&apiv1.SendChatRequest{
		PeerId:      peerID,
		Multiaddr:   multiaddr,
		Text:        text,
		AgentOrigin: agentOrigin,
		Origin:      origin,
		RequestId:   requestID,
	}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// RecentMessages calls RecentMessages.
func (c *Client) RecentMessages(ctx context.Context, limit uint32) (*apiv1.RecentMessagesResponse, error) {
	resp, err := c.svc.RecentMessages(ctx, connect.NewRequest(&apiv1.RecentMessagesRequest{Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// ListConversations calls the per-Peer summary query.
func (c *Client) ListConversations(ctx context.Context, before string, limit uint32) (*apiv1.ListConversationsResponse, error) {
	resp, err := c.svc.ListConversations(ctx, connect.NewRequest(&apiv1.ListConversationsRequest{Before: before, Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// ListMessages calls the stable per-Peer message query.
func (c *Client) ListMessages(ctx context.Context, peerID, before string, limit uint32) (*apiv1.ListMessagesResponse, error) {
	resp, err := c.svc.ListMessages(ctx, connect.NewRequest(&apiv1.ListMessagesRequest{PeerId: peerID, Before: before, Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// ListHumanOutboundPeers calls the durable stage-6 relation query.
func (c *Client) ListHumanOutboundPeers(ctx context.Context, before string, limit uint32) (*apiv1.ListHumanOutboundPeersResponse, error) {
	resp, err := c.svc.ListHumanOutboundPeers(ctx, connect.NewRequest(&apiv1.ListHumanOutboundPeersRequest{Before: before, Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// OutboxList lists durable unacknowledged outbound messages.
func (c *Client) OutboxList(ctx context.Context, limit uint32) (*apiv1.OutboxListResponse, error) {
	resp, err := c.svc.OutboxList(ctx, connect.NewRequest(&apiv1.OutboxListRequest{Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// OutboxCancel cancels one pending outbox entry.
func (c *Client) OutboxCancel(ctx context.Context, messageID string) (*apiv1.OutboxCancelResponse, error) {
	resp, err := c.svc.OutboxCancel(ctx, connect.NewRequest(&apiv1.OutboxCancelRequest{MessageId: messageID}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Events opens the server-streaming Events call.
func (c *Client) Events(ctx context.Context) (*connect.ServerStreamForClient[apiv1.EventsResponse], error) {
	return c.svc.Events(ctx, connect.NewRequest(&apiv1.EventsRequest{}))
}

// Shutdown asks the daemon to stop gracefully.
func (c *Client) Shutdown(ctx context.Context) (*apiv1.ShutdownResponse, error) {
	resp, err := c.svc.Shutdown(ctx, connect.NewRequest(&apiv1.ShutdownRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// TestPing calls the test-only TestPing RPC.
func (c *Client) TestPing(ctx context.Context, echo string) (*apiv1.TestPingResponse, error) {
	resp, err := c.svc.TestPing(ctx, connect.NewRequest(&apiv1.TestPingRequest{Echo: echo}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

type authTransport struct {
	base  http.RoundTripper
	token string
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(clone)
}

// Peers calls Peers.
func (c *Client) Peers(ctx context.Context, includeCached bool) (*apiv1.PeersResponse, error) {
	resp, err := c.svc.Peers(ctx, connect.NewRequest(&apiv1.PeersRequest{IncludeCached: includeCached}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// RelayStatus calls RelayStatus.
func (c *Client) RelayStatus(ctx context.Context) (*apiv1.RelayStatusResponse, error) {
	resp, err := c.svc.RelayStatus(ctx, connect.NewRequest(&apiv1.RelayStatusRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// DhtStatus calls DhtStatus.
func (c *Client) DhtStatus(ctx context.Context) (*apiv1.DhtStatusResponse, error) {
	resp, err := c.svc.DhtStatus(ctx, connect.NewRequest(&apiv1.DhtStatusRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// DhtAddPeer calls DhtAddPeer.
func (c *Client) DhtAddPeer(ctx context.Context, multiaddr string) (*apiv1.DhtAddPeerResponse, error) {
	resp, err := c.svc.DhtAddPeer(ctx, connect.NewRequest(&apiv1.DhtAddPeerRequest{Multiaddr: peerarg.Normalize(multiaddr)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// DhtFindPeer calls DhtFindPeer.
func (c *Client) DhtFindPeer(ctx context.Context, peerID string) (*apiv1.DhtFindPeerResponse, error) {
	resp, err := c.svc.DhtFindPeer(ctx, connect.NewRequest(&apiv1.DhtFindPeerRequest{PeerId: peerarg.Normalize(peerID)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// DisconnectPeer closes all connections to a peer through the normal API.
func (c *Client) DisconnectPeer(ctx context.Context, peerID string) (*apiv1.DisconnectPeerResponse, error) {
	resp, err := c.svc.DisconnectPeer(ctx, connect.NewRequest(&apiv1.DisconnectPeerRequest{PeerId: peerarg.Normalize(peerID)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// TestDisconnectPeer calls the test-only disconnect RPC.
func (c *Client) TestDisconnectPeer(ctx context.Context, peerID string) (*apiv1.TestDisconnectPeerResponse, error) {
	resp, err := c.svc.TestDisconnectPeer(ctx, connect.NewRequest(&apiv1.TestDisconnectPeerRequest{PeerId: peerarg.Normalize(peerID)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// ListFriends lists local friend rows.
func (c *Client) ListFriends(ctx context.Context) (*apiv1.ListFriendsResponse, error) {
	resp, err := c.svc.ListFriends(ctx, connect.NewRequest(&apiv1.ListFriendsRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// SetFriendName replaces one existing friend's local name. The value is always
// sent explicitly, so an empty string is distinguishable from an omitted edit.
func (c *Client) SetFriendName(ctx context.Context, peerID, name string) (*apiv1.SetFriendNameResponse, error) {
	value := name
	resp, err := c.svc.SetFriendName(ctx, connect.NewRequest(&apiv1.SetFriendNameRequest{PeerId: peerarg.Normalize(peerID), Name: &value}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// SetFriendDescription replaces one existing friend's description. The value is
// always sent explicitly, so an empty string is distinguishable from omission.
func (c *Client) SetFriendDescription(ctx context.Context, peerID, description string) (*apiv1.SetFriendDescriptionResponse, error) {
	value := description
	resp, err := c.svc.SetFriendDescription(ctx, connect.NewRequest(&apiv1.SetFriendDescriptionRequest{PeerId: peerarg.Normalize(peerID), Description: &value}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// RemoveFriend deletes a friend row; pending outbox requires cancelPending.
func (c *Client) RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (*apiv1.RemoveFriendResponse, error) {
	resp, err := c.svc.RemoveFriend(ctx, connect.NewRequest(&apiv1.RemoveFriendRequest{PeerId: peerarg.Normalize(peerID), CancelPending: cancelPending}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// SyncFriends regenerates public/friends.json immediately.
func (c *Client) SyncFriends(ctx context.Context) (*apiv1.SyncFriendsResponse, error) {
	resp, err := c.svc.SyncFriends(ctx, connect.NewRequest(&apiv1.SyncFriendsRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Published lists the local public manifest after a forced scan.
func (c *Client) Published(ctx context.Context) (*apiv1.PublishedResponse, error) {
	resp, err := c.svc.Published(ctx, connect.NewRequest(&apiv1.PublishedRequest{}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// ListDiscoveries reads the private acquisition index with its opaque cursor.
func (c *Client) ListDiscoveries(ctx context.Context, before string, limit int32, familiarOnly bool) (*apiv1.ListDiscoveriesResponse, error) {
	resp, err := c.svc.ListDiscoveries(ctx, connect.NewRequest(&apiv1.ListDiscoveriesRequest{
		Before: before, Limit: uint32(limit), FamiliarOnly: familiarOnly,
	}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

func (c *Client) GetPeerManifest(ctx context.Context, peerID string, offset, limit int32) (*apiv1.GetPeerManifestResponse, error) {
	resp, err := c.svc.GetPeerManifest(ctx, connect.NewRequest(&apiv1.GetPeerManifestRequest{PeerId: peerarg.Normalize(peerID), Offset: offset, Limit: limit}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}
func (c *Client) GetPeerProfile(ctx context.Context, peerID string) (*apiv1.GetPeerProfileResponse, error) {
	resp, err := c.svc.GetPeerProfile(ctx, connect.NewRequest(&apiv1.GetPeerProfileRequest{PeerId: peerarg.Normalize(peerID)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}
func (c *Client) GetPeerFriends(ctx context.Context, peerID string) (*apiv1.GetPeerFriendsResponse, error) {
	resp, err := c.svc.GetPeerFriends(ctx, connect.NewRequest(&apiv1.GetPeerFriendsRequest{PeerId: peerarg.Normalize(peerID)}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}
func (c *Client) DownloadPeerFile(ctx context.Context, peerID, path string) (*connect.ServerStreamForClient[apiv1.DownloadPeerFileResponse], error) {
	return c.svc.DownloadPeerFile(ctx, connect.NewRequest(&apiv1.DownloadPeerFileRequest{PeerId: peerarg.Normalize(peerID), Path: path}))
}

// DownloadPeerFileWithEvidence is used only by the Agent content tool. It asks
// the daemon to persist the successful acquisition as discovery evidence.
func (c *Client) DownloadPeerFileWithEvidence(ctx context.Context, peerID, path, source string) (*connect.ServerStreamForClient[apiv1.DownloadPeerFileResponse], error) {
	return c.svc.DownloadPeerFile(ctx, connect.NewRequest(&apiv1.DownloadPeerFileRequest{
		PeerId: peerarg.Normalize(peerID), Path: path, RecordDiscovery: true, DiscoverySource: source,
	}))
}
func (c *Client) ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (*apiv1.ConnectListedPeerResponse, error) {
	resp, err := c.svc.ConnectListedPeer(ctx, connect.NewRequest(&apiv1.ConnectListedPeerRequest{PeerId: peerarg.Normalize(peerID), Addrs: addrs}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}
