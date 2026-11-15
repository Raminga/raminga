package tui

import (
	"context"
	"fmt"

	_ "github.com/Raminga/raminga/internal/tuiinit"

	"connectrpc.com/connect"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api/client"
)

// EventStream is the subset of the Connect server stream the TUI needs.
type EventStream interface {
	Recv() (*apiv1.EventsResponse, error)
	Close() error
}

// Client is the local API surface used by the TUI. It is deliberately the same
// Connect client as the CLI and DSH plugin; the TUI never owns node state.
type Client interface {
	Status(ctx context.Context) (*apiv1.StatusResponse, error)
	Peers(ctx context.Context, includeCached bool) (*apiv1.PeersResponse, error)
	Connect(ctx context.Context, peerID, multiaddr string) (*apiv1.ConnectResponse, error)
	DisconnectPeer(ctx context.Context, peerID string) (*apiv1.DisconnectPeerResponse, error)
	SendChat(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error)
	RecentMessages(ctx context.Context, limit uint32) (*apiv1.RecentMessagesResponse, error)
	OutboxList(ctx context.Context, limit uint32) (*apiv1.OutboxListResponse, error)
	OutboxCancel(ctx context.Context, messageID string) (*apiv1.OutboxCancelResponse, error)
	RelayStatus(ctx context.Context) (*apiv1.RelayStatusResponse, error)
	DhtAddPeer(ctx context.Context, multiaddr string) (*apiv1.DhtAddPeerResponse, error)
	ListFriends(ctx context.Context) (*apiv1.ListFriendsResponse, error)
	SetFriendName(ctx context.Context, peerID, name string) (*apiv1.SetFriendNameResponse, error)
	SetFriendDescription(ctx context.Context, peerID, description string) (*apiv1.SetFriendDescriptionResponse, error)
	RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (*apiv1.RemoveFriendResponse, error)
	SyncFriends(ctx context.Context) (*apiv1.SyncFriendsResponse, error)
	Published(ctx context.Context) (*apiv1.PublishedResponse, error)
	GetPeerManifest(ctx context.Context, peerID string, offset, limit int32) (*apiv1.GetPeerManifestResponse, error)
	GetPeerProfile(ctx context.Context, peerID string) (*apiv1.GetPeerProfileResponse, error)
	GetPeerFriends(ctx context.Context, peerID string) (*apiv1.GetPeerFriendsResponse, error)
	DownloadPeerFile(ctx context.Context, peerID, path string, progress func(*apiv1.DownloadPeerFileResponse)) (*apiv1.DownloadPeerFileResponse, error)
	ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (*apiv1.ConnectListedPeerResponse, error)
	Events(ctx context.Context) (EventStream, error)
	Close()
}

// APIClient adapts the shared local API Connect client to Client.
type APIClient struct {
	c *client.Client
}

// NewAPIClient opens the local API for dataDir.
func NewAPIClient(dataDir string) (*APIClient, error) {
	c, err := client.New(dataDir)
	if err != nil {
		return nil, err
	}
	return &APIClient{c: c}, nil
}

// NewAPIClientFromClient adapts an already-open shared client. The caller
// keeps ownership and must Close it.
func NewAPIClientFromClient(c *client.Client) *APIClient {
	return &APIClient{c: c}
}

func (a *APIClient) Status(ctx context.Context) (*apiv1.StatusResponse, error) {
	return a.c.Status(ctx)
}

func (a *APIClient) Peers(ctx context.Context, includeCached bool) (*apiv1.PeersResponse, error) {
	return a.c.Peers(ctx, includeCached)
}

func (a *APIClient) Connect(ctx context.Context, peerID, multiaddr string) (*apiv1.ConnectResponse, error) {
	return a.c.Connect(ctx, peerID, multiaddr)
}

func (a *APIClient) DisconnectPeer(ctx context.Context, peerID string) (*apiv1.DisconnectPeerResponse, error) {
	return a.c.DisconnectPeer(ctx, peerID)
}

func (a *APIClient) SendChat(ctx context.Context, peerID, multiaddr, text string) (*apiv1.SendChatResponse, error) {
	return a.c.SendChat(ctx, peerID, multiaddr, text)
}

func (a *APIClient) RecentMessages(ctx context.Context, limit uint32) (*apiv1.RecentMessagesResponse, error) {
	return a.c.RecentMessages(ctx, limit)
}

func (a *APIClient) OutboxList(ctx context.Context, limit uint32) (*apiv1.OutboxListResponse, error) {
	return a.c.OutboxList(ctx, limit)
}

func (a *APIClient) OutboxCancel(ctx context.Context, messageID string) (*apiv1.OutboxCancelResponse, error) {
	return a.c.OutboxCancel(ctx, messageID)
}

func (a *APIClient) RelayStatus(ctx context.Context) (*apiv1.RelayStatusResponse, error) {
	return a.c.RelayStatus(ctx)
}

func (a *APIClient) DhtAddPeer(ctx context.Context, addr string) (*apiv1.DhtAddPeerResponse, error) {
	return a.c.DhtAddPeer(ctx, addr)
}

func (a *APIClient) ListFriends(ctx context.Context) (*apiv1.ListFriendsResponse, error) {
	return a.c.ListFriends(ctx)
}

func (a *APIClient) SetFriendName(ctx context.Context, peerID, name string) (*apiv1.SetFriendNameResponse, error) {
	return a.c.SetFriendName(ctx, peerID, name)
}

func (a *APIClient) SetFriendDescription(ctx context.Context, peerID, description string) (*apiv1.SetFriendDescriptionResponse, error) {
	return a.c.SetFriendDescription(ctx, peerID, description)
}

func (a *APIClient) RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (*apiv1.RemoveFriendResponse, error) {
	return a.c.RemoveFriend(ctx, peerID, cancelPending)
}

func (a *APIClient) SyncFriends(ctx context.Context) (*apiv1.SyncFriendsResponse, error) {
	return a.c.SyncFriends(ctx)
}

func (a *APIClient) Published(ctx context.Context) (*apiv1.PublishedResponse, error) {
	return a.c.Published(ctx)
}

func (a *APIClient) GetPeerManifest(ctx context.Context, peerID string, offset, limit int32) (*apiv1.GetPeerManifestResponse, error) {
	return a.c.GetPeerManifest(ctx, peerID, offset, limit)
}
func (a *APIClient) GetPeerProfile(ctx context.Context, peerID string) (*apiv1.GetPeerProfileResponse, error) {
	return a.c.GetPeerProfile(ctx, peerID)
}
func (a *APIClient) GetPeerFriends(ctx context.Context, peerID string) (*apiv1.GetPeerFriendsResponse, error) {
	return a.c.GetPeerFriends(ctx, peerID)
}
func (a *APIClient) DownloadPeerFile(ctx context.Context, peerID, path string, progress func(*apiv1.DownloadPeerFileResponse)) (*apiv1.DownloadPeerFileResponse, error) {
	stream, err := a.c.DownloadPeerFile(ctx, peerID, path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.Close() }()
	var final *apiv1.DownloadPeerFileResponse
	for stream.Receive() {
		msg := stream.Msg()
		if msg.GetLocalPath() != "" || msg.GetPhase() == "complete" {
			final = msg
			continue
		}
		if progress != nil {
			progress(msg)
		}
	}
	if err := stream.Err(); err != nil {
		return nil, err
	}
	if final == nil {
		return nil, fmt.Errorf("download ended without completion")
	}
	return final, nil
}
func (a *APIClient) ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (*apiv1.ConnectListedPeerResponse, error) {
	return a.c.ConnectListedPeer(ctx, peerID, addrs)
}

func (a *APIClient) Events(ctx context.Context) (EventStream, error) {
	s, err := a.c.Events(ctx)
	if err != nil {
		return nil, err
	}
	return &apiStream{s: s}, nil
}

func (a *APIClient) Close() { a.c.Close() }

type apiStream struct {
	s *connect.ServerStreamForClient[apiv1.EventsResponse]
}

func (a *apiStream) Recv() (*apiv1.EventsResponse, error) {
	if !a.s.Receive() {
		return nil, a.s.Err()
	}
	return a.s.Msg(), nil
}

func (a *apiStream) Close() error { return a.s.Close() }
