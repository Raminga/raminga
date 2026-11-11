package node

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/network"
	"github.com/Raminga/raminga/internal/p2phttp"
	ma "github.com/multiformats/go-multiaddr"
)

const friendsSyncInterval = 10 * time.Minute

type publicFriend struct {
	Name        string   `json:"name"`
	PeerID      string   `json:"peer_id"`
	Addrs       []string `json:"addrs"`
	Description string   `json:"description"`
}

type publicFriendsFile struct {
	Version int            `json:"version"`
	Friends []publicFriend `json:"friends"`
}

func (n *Node) syncFriends(ctx context.Context) (bool, error) {
	n.friendsSyncMu.Lock()
	defer n.friendsSyncMu.Unlock()
	rows, err := n.store.ListFriends(ctx)
	if err != nil {
		return false, err
	}
	friends := make([]publicFriend, 0, len(rows))
	for _, row := range rows {
		addrs := make([]string, 0, len(row.Addrs))
		parsed := make([]ma.Multiaddr, 0, len(row.Addrs))
		for _, raw := range row.Addrs {
			addr, parseErr := ma.NewMultiaddr(raw)
			if parseErr == nil {
				parsed = append(parsed, addr)
			}
		}
		for _, addr := range network.PublishableAddrs(parsed) {
			addrs = append(addrs, addr.String())
		}
		sort.Strings(addrs)
		friends = append(friends, publicFriend{Name: row.Name, PeerID: row.PeerID, Addrs: addrs, Description: row.Description})
	}
	sort.Slice(friends, func(i, j int) bool { return friends[i].PeerID < friends[j].PeerID })
	raw, err := json.Marshal(publicFriendsFile{Version: 1, Friends: friends})
	if err != nil {
		return false, err
	}
	if n.content == nil {
		return false, errors.New("content store is unavailable")
	}
	written, err := n.content.WriteFriends(append(raw, '\n'))
	if err == nil {
		n.friendsSyncedAt.Store(time.Now().UnixMilli())
	}
	return written, err
}

// SyncFriends regenerates public/friends.json immediately.
func (n *Node) SyncFriends(ctx context.Context) (bool, error) { return n.syncFriends(ctx) }

func (n *Node) startFriendsSync(ctx context.Context) {
	n.friendsWG.Add(1)
	go func() {
		defer n.friendsWG.Done()
		ticker := time.NewTicker(friendsSyncInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := n.syncFriends(ctx); err != nil {
					n.logger.Warn("friends.json sync failed", "error", err)
				}
			}
		}
	}()
}

func (n *Node) contentAuthorized(w http.ResponseWriter, r *http.Request) (peerID string, ok bool) {
	pid, found := p2phttp.PeerID(r.Context())
	if !found {
		http.Error(w, "unauthenticated peer", http.StatusBadRequest)
		return "", false
	}
	if allowed, reason := n.authorize(pid); !allowed {
		n.logger.Warn("content request denied by local policy", "peer_id", pid.String(), "reason", reason)
		http.Error(w, reason, http.StatusForbidden)
		return "", false
	}
	return pid.String(), true
}

func (n *Node) handleManifest(w http.ResponseWriter, r *http.Request) {
	if _, ok := n.contentAuthorized(w, r); !ok {
		return
	}
	snap, err := n.content.Snapshot(r.Context())
	if err != nil {
		if errors.Is(err, content.ErrScanInProgress) {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "content scan in progress", http.StatusServiceUnavailable)
			return
		}
		n.logger.Warn("content scan failed", "error", err)
		http.Error(w, "content scan failed", http.StatusServiceUnavailable)
		return
	}
	for _, warning := range snap.Warnings {
		n.logger.Warn("content scan warning", "warning", warning)
	}
	offset, limit := 0, content.DefaultManifestLimit
	if raw := r.URL.Query().Get("offset"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}
		offset = v
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v <= 0 {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = v
	}
	page := snap.Page(offset, limit)
	w.Header().Set("Content-Type", "application/json")
	raw, err := json.Marshal(page)
	if err != nil {
		n.logger.Debug("manifest marshal failed", "error", err)
		return
	}
	if _, err := w.Write(raw); err != nil {
		n.logger.Debug("manifest write failed", "error", err)
	}
}

func (n *Node) handleFile(w http.ResponseWriter, r *http.Request) {
	if _, ok := n.contentAuthorized(w, r); !ok {
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/files/")
	if rel == "" || strings.Contains(rel, "\\") || strings.ContainsRune(rel, 0) || strings.HasPrefix(rel, "/") || hasDotDot(rel) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	if hasDotDot(rel) || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") || strings.ContainsRune(rel, 0) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	snap, err := n.content.Snapshot(r.Context())
	if err != nil {
		if errors.Is(err, content.ErrScanInProgress) {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "content scan in progress", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "content scan failed", http.StatusServiceUnavailable)
		return
	}
	var entry *content.Entry
	for i := range snap.Entries {
		if snap.Entries[i].Path == rel {
			entry = &snap.Entries[i]
			break
		}
	}
	if entry == nil {
		http.NotFound(w, r)
		return
	}
	f, info, err := n.content.File(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", `"`+entry.SHA256+`"`)
	// The first-version client only resumes with one range. Reject multipart
	// ranges so a peer cannot amplify a small file into hundreds of part
	// headers, and keep serving the common single-range case.
	if strings.Contains(r.Header.Get("Range"), ",") {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(info.Size(), 10))
		http.Error(w, "multiple ranges are not supported", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	timeout := 30*time.Second + time.Duration(info.Size()/(64<<10))*time.Second
	if timeout > 10*time.Minute {
		timeout = 10 * time.Minute
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout))
	http.ServeContent(w, r, rel, info.ModTime(), io.ReadSeeker(f))
}

func hasDotDot(p string) bool {
	for _, part := range strings.Split(strings.ReplaceAll(p, "\\", "/"), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// Published forces a fresh local scan and returns what is published, what was
// skipped and when friends.json was last written. It stays on the local API.
func (n *Node) Published(ctx context.Context) (Published, error) {
	if n == nil || n.content == nil {
		return Published{}, errors.New("content store is unavailable")
	}
	snap, err := n.content.Refresh(ctx)
	if err != nil {
		return Published{}, err
	}
	out := Published{GeneratedAt: snap.GeneratedAt, FriendsSyncedAt: snap.FriendsSyncedAt}
	if ts := n.friendsSyncedAt.Load(); ts > 0 {
		out.FriendsSyncedAt = time.UnixMilli(ts).UTC()
	}
	for _, e := range snap.Entries {
		out.Files = append(out.Files, PublishedFile{Path: e.Path, Size: e.Size})
	}
	for _, skipped := range snap.Skipped {
		out.Skipped = append(out.Skipped, PublishedSkip{Path: skipped.Path, Reason: skipped.Reason})
	}
	return out, nil
}

func (n *Node) contentWarnings() []string {
	if n == nil || n.content == nil {
		return nil
	}
	return n.content.Warnings()
}
