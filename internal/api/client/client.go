// Package client is a Connect-RPC client for the local Raminga API. It is used
// by the CLI and e2e runner; it never opens go-libp2p directly.
package client

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"connectrpc.com/connect"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/gen/raminga/api/v1/apiv1connect"
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

// New reads the 0600 token in dataDir and builds a UDS-only client.
func New(dataDir string) (*Client, error) {
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

// SendChat calls SendChat for a human-initiated TUI/CLI send. It deliberately
// leaves agent_origin unset, so daemon-side agent safety checks do not apply.
func (c *Client) SendChat(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	return c.sendChat(ctx, peerID, multiaddr, text, false)
}

// SendChatFromAgent calls SendChat with agent_origin set. Every Agent shell
// must use this method (or set the field directly), so the daemon can reject
// private-data leaks and excessive automated sends.
func (c *Client) SendChatFromAgent(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	return c.sendChat(ctx, peerID, multiaddr, text, true)
}

func (c *Client) sendChat(ctx context.Context, peerID, multiaddr, text string, agentOrigin bool) (*apiv1.SendChatResponse, error) {
	peerID, multiaddr = peerarg.Normalize(peerID), peerarg.Normalize(multiaddr)
	resp, err := c.svc.SendChat(ctx, connect.NewRequest(&apiv1.SendChatRequest{
		PeerId:      peerID,
		Multiaddr:   multiaddr,
		Text:        text,
		AgentOrigin: agentOrigin,
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

// SetFriendName replaces one existing friend's local name.
func (c *Client) SetFriendName(ctx context.Context, peerID, name string) (*apiv1.SetFriendNameResponse, error) {
	resp, err := c.svc.SetFriendName(ctx, connect.NewRequest(&apiv1.SetFriendNameRequest{PeerId: peerarg.Normalize(peerID), Name: name}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// SetFriendDescription replaces one existing friend's description.
func (c *Client) SetFriendDescription(ctx context.Context, peerID, description string) (*apiv1.SetFriendDescriptionResponse, error) {
	resp, err := c.svc.SetFriendDescription(ctx, connect.NewRequest(&apiv1.SetFriendDescriptionRequest{PeerId: peerarg.Normalize(peerID), Description: description}))
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
func (c *Client) ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (*apiv1.ConnectListedPeerResponse, error) {
	resp, err := c.svc.ConnectListedPeer(ctx, connect.NewRequest(&apiv1.ConnectListedPeerRequest{PeerId: peerarg.Normalize(peerID), Addrs: addrs}))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}
