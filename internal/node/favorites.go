package node

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/Raminga/raminga/internal/publication"
	"github.com/Raminga/raminga/internal/storage"
)

// ErrMessageNotFound reports a missing message inside the stated Peer's
// retained history.
var ErrMessageNotFound = storage.ErrMessageNotFound

// ErrFavoriteTarget reports a favorite target that is not a verified public
// post version or not an accepted post path.
var ErrFavoriteTarget = errors.New("node: favorite target is not an available public post")

const maxFavoriteVerifyBytes = 128 << 20

func (n *Node) decodePeer(peerID string) (string, error) {
	pid, err := peer.Decode(strings.TrimSpace(peerID))
	if err != nil {
		return "", fmt.Errorf("无效 Peer ID %q: %w", peerID, err)
	}
	return pid.String(), nil
}

// MarkConversationRead advances the human cursor through one retained message.
// It is the only node path that writes read state; ListMessages and
// RecentMessages stay read-only.
func (n *Node) MarkConversationRead(ctx context.Context, peerID, throughMessageID string) (MarkReadResult, error) {
	canonical, err := n.decodePeer(peerID)
	if err != nil {
		return MarkReadResult{}, err
	}
	if strings.TrimSpace(throughMessageID) == "" {
		return MarkReadResult{}, errors.New("through_message_id is required")
	}
	result, err := n.store.MarkConversationRead(ctx, canonical, throughMessageID, time.Now().UnixMilli())
	if err != nil {
		return MarkReadResult{}, err
	}
	out := MarkReadResult{
		PeerID:            result.State.PeerID,
		LastReadMessageID: result.State.LastReadMessageID,
		UnreadCount:       result.UnreadCount,
	}
	if result.State.LastReadAtMS > 0 {
		out.LastReadAt = time.UnixMilli(result.State.LastReadAtMS)
	}
	return out, nil
}

// ListFavorites returns private public-post bookmarks and computes availability
// from retained discovery evidence, the local public snapshot or a verified
// downloaded copy. A missing target keeps the row with available=false.
func (n *Node) ListFavorites(ctx context.Context, before string, limit int) (FavoritePage, error) {
	page, err := n.store.ListFavorites(ctx, before, limit)
	if err != nil {
		return FavoritePage{}, err
	}
	out := FavoritePage{NextBefore: page.NextBefore, HasMore: page.HasMore, Favorites: make([]Favorite, 0, len(page.Items))}
	var snapshotEntries map[string]string
	for _, row := range page.Items {
		available, availErr := n.favoriteAvailable(ctx, row.PeerID, row.Path, row.SHA256, &snapshotEntries)
		if availErr != nil {
			return FavoritePage{}, availErr
		}
		out.Favorites = append(out.Favorites, Favorite{
			ID: row.ID, PeerID: row.PeerID, Path: row.Path, SHA256: row.SHA256,
			Title: row.Title, CreatedAt: time.UnixMilli(row.CreatedAtMS), Available: available,
		})
	}
	return out, nil
}

// SetFavorite validates one public-post target and idempotently stores or
// clears its bookmark. It never stores message/contact favorites.
func (n *Node) SetFavorite(ctx context.Context, peerID, publicPath, digest, title string, favorite bool) (Favorite, bool, error) {
	canonical, err := n.decodePeer(peerID)
	if err != nil {
		return Favorite{}, false, err
	}
	digest = strings.ToLower(strings.TrimSpace(digest))
	if _, ok := publication.ValidVersionedPostPath(publicPath); !ok {
		return Favorite{}, false, fmt.Errorf("%w: 只能收藏 posts/*.json 或 posts/*/post.json", ErrFavoriteTarget)
	}
	if len(digest) != 64 || !isHexDigest(digest) {
		return Favorite{}, false, fmt.Errorf("%w: 内容 SHA-256 格式无效", ErrFavoriteTarget)
	}
	if favorite {
		available, err := n.favoriteAvailable(ctx, canonical, publicPath, digest, nil)
		if err != nil {
			return Favorite{}, false, err
		}
		if !available {
			return Favorite{}, false, fmt.Errorf("%w: 目标版本不在本机保留范围，也没有已验证副本", ErrFavoriteTarget)
		}
	}
	row, saved, err := n.store.SetFavorite(ctx, canonical, publicPath, digest, title, time.Now().UnixMilli(), favorite)
	if err != nil {
		return Favorite{}, false, err
	}
	out := Favorite{
		ID: row.ID, PeerID: row.PeerID, Path: row.Path, SHA256: row.SHA256,
		Title: row.Title, Available: saved,
	}
	if row.CreatedAtMS > 0 {
		out.CreatedAt = time.UnixMilli(row.CreatedAtMS)
	}
	return out, saved, nil
}

func isHexDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// favoriteAvailable checks, in increasing cost order: the exact discovery
// evidence row; the current local public manifest for this node; and finally a
// full hash of downloads/<peer>/<path>.
func (n *Node) favoriteAvailable(ctx context.Context, peerID, publicPath, digest string, snapshotEntries *map[string]string) (bool, error) {
	exists, err := n.store.PublicDiscoveryExists(ctx, peerID, publicPath, digest)
	if err != nil {
		return false, err
	}
	if exists {
		// The discovery row proves the version was verified when acquired, but
		// availability is a current property: the retained bytes must still be
		// present and match the exact hash. A deleted/cleaned copy becomes
		// available=false instead of looking readable.
		return n.verifyDownloadedFavorite(peerID, publicPath, digest)
	}
	if peerID == n.identity.PeerID().String() && n.content != nil {
		var entries map[string]string
		if snapshotEntries != nil && *snapshotEntries != nil {
			entries = *snapshotEntries
		} else {
			// Availability is a current property; bypass the content TTL cache so a
			// deleted or replaced local post cannot stay "available" for a page.
			snap, err := n.content.Refresh(ctx)
			if err != nil {
				return false, nil
			}
			entries = make(map[string]string, len(snap.Entries))
			for _, entry := range snap.Entries {
				entries[entry.Path] = strings.ToLower(entry.SHA256)
			}
			if snapshotEntries != nil {
				*snapshotEntries = entries
			}
		}
		if strings.EqualFold(entries[publicPath], digest) {
			return true, nil
		}
	}
	return n.verifyDownloadedFavorite(peerID, publicPath, digest)
}

func (n *Node) verifyDownloadedFavorite(peerID, publicPath, digest string) (bool, error) {
	rootPath := filepath.Join(n.dataDir, "downloads", peerID)
	rootInfo, err := os.Lstat(rootPath)
	if err != nil {
		return false, nil
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return false, nil
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, nil
	}
	defer func() { _ = root.Close() }()
	info, err := root.Lstat(filepath.FromSlash(publicPath))
	if err != nil {
		return false, nil
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > maxFavoriteVerifyBytes {
		return false, nil
	}
	file, err := root.Open(filepath.FromSlash(publicPath))
	if err != nil {
		return false, nil
	}
	defer func() { _ = file.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(file, maxFavoriteVerifyBytes+1)); err != nil {
		return false, nil
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), digest), nil
}
