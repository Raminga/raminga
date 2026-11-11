package node

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/storage"
)

// Friend sentinel errors are stable API-facing aliases for the storage errors.
var (
	ErrFriendNotFound      = storage.ErrFriendNotFound
	ErrFriendNameTaken     = storage.ErrFriendNameTaken
	ErrFriendPendingOutbox = storage.ErrFriendPendingOutbox
)

// Friend is the node-facing friend view. Names/descriptions are local only.
type Friend struct {
	PeerID            string
	Name              string
	Addrs             []string
	Description       string
	ManuallyConnected bool
	RelayCapable      bool
	DHTCapable        bool
	Paused            bool
	FirstSeen         time.Time
	LastInteraction   time.Time
}

func friendFromStorage(f storage.Friend) Friend {
	out := Friend{
		PeerID: f.PeerID, Name: f.Name, Addrs: f.Addrs, Description: f.Description,
		ManuallyConnected: f.ManuallyConnected, RelayCapable: f.RelayCapable,
		DHTCapable: f.DHTCapable, Paused: f.Paused,
	}
	if f.FirstSeenMS > 0 {
		out.FirstSeen = time.UnixMilli(f.FirstSeenMS)
	}
	if f.LastInteractionMS > 0 {
		out.LastInteraction = time.UnixMilli(f.LastInteractionMS)
	}
	return out
}

// ListFriends is the API-facing alias for Friends.
func (n *Node) ListFriends(ctx context.Context) ([]Friend, error) { return n.Friends(ctx) }

// Friends lists local friend rows.
func (n *Node) Friends(ctx context.Context) ([]Friend, error) {
	rows, err := n.store.ListFriends(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Friend, 0, len(rows))
	for _, row := range rows {
		out = append(out, friendFromStorage(row))
	}
	return out, nil
}

// SetFriendName replaces a name for an existing friend.
func (n *Node) SetFriendName(ctx context.Context, peerID, name string) (Friend, error) {
	if err := storage.ValidateFriendName(name); err != nil {
		return Friend{}, err
	}
	pid, err := peer.Decode(peerID)
	if err != nil {
		return Friend{}, fmt.Errorf("无效 Peer ID %q: %w", peerID, err)
	}
	row, err := n.store.SetFriendName(ctx, pid.String(), name)
	if err != nil {
		return Friend{}, friendError(err)
	}
	n.syncFriendsAfterChange(ctx)
	return friendFromStorage(row), nil
}

// SetFriendDescription replaces a description for an existing friend.
func (n *Node) SetFriendDescription(ctx context.Context, peerID, description string) (Friend, error) {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return Friend{}, fmt.Errorf("无效 Peer ID %q: %w", peerID, err)
	}
	row, err := n.store.SetFriendDescription(ctx, pid.String(), description)
	if err != nil {
		return Friend{}, friendError(err)
	}
	n.syncFriendsAfterChange(ctx)
	return friendFromStorage(row), nil
}

// syncFriendsAfterChange is best effort: a failed public/friends.json rewrite
// never turns a successful name/description/forget operation into an error.
func (n *Node) syncFriendsAfterChange(ctx context.Context) {
	if n == nil {
		return
	}
	syncCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storeTimeout)
	defer cancel()
	if _, err := n.syncFriends(syncCtx); err != nil && n.logger != nil {
		n.logger.Warn("friends.json sync after friend change failed", "error", err)
	}
}

// RemoveFriend deletes a friend row; pending outbox requires explicit cancel.
func (n *Node) RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (bool, int, error) {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return false, 0, fmt.Errorf("无效 Peer ID %q: %w", peerID, err)
	}
	removed, pending, err := n.store.RemoveFriend(ctx, pid.String(), cancelPending)
	if err != nil {
		return false, pending, friendError(err)
	}
	if removed {
		n.syncFriendsAfterChange(ctx)
	}
	return removed, pending, nil
}

func friendError(err error) error {
	if errors.Is(err, storage.ErrFriendNotFound) {
		return fmt.Errorf("节点不在好友表中：%w", err)
	}
	if errors.Is(err, storage.ErrFriendNameTaken) {
		return fmt.Errorf("名称已被其他节点使用：%w", err)
	}
	if errors.Is(err, storage.ErrFriendPendingOutbox) {
		return err
	}
	return err
}

func (n *Node) restoreFriendAddrs(ctx context.Context, pid peer.ID) {
	f, found, err := n.store.GetFriend(ctx, pid.String())
	if err == nil && found {
		n.net.RestorePeer(pid, f.Addrs)
	}
}

// recordInteraction records one successful Raminga HTTP interaction after the
// response has been written. It is opt-in per route; health checks and raw
// libp2p connections are intentionally not wrapped. Recording is asynchronous
// and bounded by recordFriend's store timeout, so a slow database cannot delay
// the response or turn success into failure. Later routes opt in by wrapping
// their handler: n.recordInteraction("manifest", handler).
func (n *Node) recordInteraction(kind string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status < 200 || sw.status >= 300 {
			return
		}
		pid, ok := p2phttp.PeerID(r.Context())
		if !ok || pid == "" {
			return
		}
		n.logger.Debug("recording Raminga interaction", "kind", kind, "peer_id", pid.String())
		go n.recordFriend(context.Background(), pid, false)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

// Unwrap lets http.ResponseController reach the p2phttp writer for long
// download routes that opt into per-response deadlines.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// recordFriend upserts from the live PeerStore. It is called only on
// application interactions, never for DHT-only or idle inbound connections.
func (n *Node) recordFriend(ctx context.Context, pid peer.ID, manual bool, extra ...string) {
	if n == nil || n.store == nil || pid == "" {
		return
	}
	addrs := n.net.Host().Peerstore().Addrs(pid)
	stringsAddrs := make([]string, 0, len(addrs)+len(extra))
	for _, addr := range addrs {
		stringsAddrs = append(stringsAddrs, addr.String())
	}
	stringsAddrs = append(stringsAddrs, extra...)
	storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	if _, _, err := n.store.UpsertFriend(storeCtx, pid.String(), stringsAddrs, manual, true); err != nil {
		n.logger.Warn("record friend failed", "peer_id", pid.String(), "error", err)
	}
}

// PausePeer persists a pause, stops local relay/auto-relay work and closes the
// current connection. It intentionally does not create a friend row.
func (n *Node) PausePeer(ctx context.Context, peerID string) error {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return fmt.Errorf("无效 Peer ID %q: %w", peerID, err)
	}
	if err := n.store.PausePeer(ctx, pid.String()); err != nil {
		return err
	}
	return n.net.PausePeer(pid)
}

// ResumePeer clears a pause (explicit connect/chat).
func (n *Node) ResumePeer(ctx context.Context, pid peer.ID) error {
	if err := n.store.ResumePeer(ctx, pid.String()); err != nil {
		return err
	}
	n.net.ResumePeer(pid)
	return nil
}

func (n *Node) recordFriendCapabilities(ctx context.Context, pid peer.ID) {
	relay, dht := n.net.PeerCapabilities(ctx, pid)
	if err := n.store.SetFriendCapabilities(ctx, pid.String(), relay, dht); err != nil {
		n.logger.Warn("record friend capabilities failed", "peer_id", pid.String(), "error", err)
	}
}

func (n *Node) recoverFriends(ctx context.Context) {
	rows, err := n.store.FriendsForRestart(ctx, 3)
	if err != nil {
		n.logger.Warn("load restart friends failed", "error", err)
		return
	}
	for _, f := range rows {
		pid, err := peer.Decode(f.PeerID)
		if err != nil || n.net.IsPaused(pid) {
			continue
		}
		n.net.RestorePeer(pid, f.Addrs)
		connCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		_, dialErr := n.net.DialPeerByID(connCtx, pid)
		cancel()
		if dialErr != nil {
			n.logger.Warn("restart friend connect failed", "peer_id", f.PeerID, "error", dialErr)
			continue
		}
		n.recordFriendCapabilities(ctx, pid)
		n.net.MaybeAddConnectRelay(ctx, pid)
	}
}
