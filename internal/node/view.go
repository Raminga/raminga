package node

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/p2phttp"
	"github.com/Raminga/raminga/internal/peerarg"
	"github.com/Raminga/raminga/internal/protocol"
)

const (
	limitedContentBytes = 64 << 10
	directUpgradeWait   = 15 * time.Second
	maxManifestBody     = 64 << 10
	maxFriendsBody      = 4 << 20
	maxFriendsClaims    = 10000
	maxDownloadBytes    = 100 << 20
)

type PeerManifest struct {
	Version   int
	PeerID    string
	Generated time.Time
	Entries   []content.Entry
	Total     int
	Limited   bool
}

type PeerProfile struct {
	PeerID string
	Name   string
	Text   string
	Files  []string
	Found  bool
}

type PeerFriend struct {
	Name        string
	PeerID      string
	Addrs       []string
	Description string
}

type PeerFriends struct {
	PeerID  string
	Friends []PeerFriend
	Limited bool
}

type DownloadProgress struct {
	Phase    string
	Path     string
	Received int64
	Total    int64
	Direct   bool
}

type DownloadResult struct {
	PeerID    string
	Path      string
	LocalPath string
	Size      int64
	SHA256    string
	Resumed   bool
	Direct    bool
}

func (n *Node) FetchManifest(ctx context.Context, peerID string, offset, limit int) (PeerManifest, error) {
	pid, err := peer.Decode(peerarg.Normalize(peerID))
	if err != nil {
		return PeerManifest{}, fmt.Errorf("invalid peer ID: %w；%s", err, peerarg.WrappedHint)
	}
	if pid == n.identity.PeerID() {
		return PeerManifest{}, errors.New("refusing to view self")
	}
	if offset < 0 {
		return PeerManifest{}, errors.New("offset must be >= 0")
	}
	if limit <= 0 {
		limit = content.DefaultManifestLimit
	}
	if limit > content.MaxManifestLimit {
		limit = content.MaxManifestLimit
	}
	u := &url.URL{Scheme: "http", Host: pid.String(), Path: "/manifest"}
	q := u.Query()
	q.Set("offset", fmt.Sprint(offset))
	q.Set("limit", fmt.Sprint(limit))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return PeerManifest{}, err
	}
	res, err := n.net.HTTPClient().DoWithDial(ctx, pid, req, maxManifestBody)
	if err != nil {
		return PeerManifest{}, fmt.Errorf("fetch manifest: %w", p2phttp.ProtocolMismatch(err, protocol.HTTPProtocol))
	}
	defer func() { _ = res.Response.Body.Close() }()
	if res.Response.StatusCode != http.StatusOK {
		return PeerManifest{}, fmt.Errorf("manifest status %d", res.Response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Response.Body, maxManifestBody+1))
	if err != nil {
		return PeerManifest{}, err
	}
	if len(data) > maxManifestBody {
		return PeerManifest{}, errors.New("manifest response too large")
	}
	var page content.Manifest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&page); err != nil {
		return PeerManifest{}, fmt.Errorf("invalid manifest: %w", err)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return PeerManifest{}, errors.New("manifest trailing data")
	}
	if page.Version != 1 {
		return PeerManifest{}, fmt.Errorf("unsupported manifest version %d", page.Version)
	}
	if page.PeerID != pid.String() {
		return PeerManifest{}, fmt.Errorf("manifest peer_id %q does not match authenticated peer %s", page.PeerID, pid)
	}
	if len(page.Entries) > content.MaxManifestLimit || page.Total < 0 || page.Total > 100000 {
		return PeerManifest{}, errors.New("manifest exceeds server caps")
	}
	for _, e := range page.Entries {
		if e.Size < 0 || e.SHA256 == "" || !validRemotePath(e.Path) {
			return PeerManifest{}, fmt.Errorf("invalid manifest entry %q", e.Path)
		}
	}
	n.recordFriend(context.Background(), pid, false)
	return PeerManifest{Version: page.Version, PeerID: page.PeerID, Generated: time.UnixMilli(page.GeneratedAtUnixMS), Entries: page.Entries, Total: page.Total, Limited: res.Limited}, nil
}

func (n *Node) findEntry(ctx context.Context, pid peer.ID, remotePath string) (content.Entry, bool, error) {
	offset := 0
	for offset < 100000 {
		page, err := n.FetchManifest(ctx, pid.String(), offset, content.MaxManifestLimit)
		if err != nil {
			return content.Entry{}, false, err
		}
		for _, e := range page.Entries {
			if e.Path == remotePath {
				return e, page.Limited, nil
			}
		}
		if len(page.Entries) == 0 || offset+len(page.Entries) >= page.Total {
			break
		}
		offset += len(page.Entries)
	}
	return content.Entry{}, false, nil
}

func (n *Node) ensureDirect(ctx context.Context, pid peer.ID, size int64, limited bool) error {
	if !limited || size <= limitedContentBytes {
		return nil
	}
	deadline := time.Now().Add(directUpgradeWait)
	for time.Now().Before(deadline) {
		if info, err := n.net.ConnectionInfo(pid); err == nil && info.Direct {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("content: direct connection required for %d-byte file (still relay-limited after %s)", size, directUpgradeWait)
}

func validRemotePath(p string) bool {
	if p == "" || !utf8.ValidString(p) || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." || !validPathSegment(part) {
			return false
		}
	}
	return true
}

func validPathSegment(seg string) bool {
	if seg == "" || seg == "." || seg == ".." || !utf8.ValidString(seg) {
		return false
	}
	if strings.ContainsAny(seg, "\\/:*?\"<>|\x00") {
		return false
	}
	for _, r := range seg {
		if unicode.IsControl(r) {
			return false
		}
	}
	trimmed := strings.TrimRight(seg, " .")
	base := strings.ToUpper(strings.TrimSuffix(trimmed, filepath.Ext(trimmed)))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return false
	}
	return true
}

func (n *Node) Download(ctx context.Context, peerID, remotePath string, progress func(DownloadProgress)) (DownloadResult, error) {
	pid, err := peer.Decode(peerarg.Normalize(peerID))
	if err != nil {
		return DownloadResult{}, fmt.Errorf("invalid peer ID: %w；%s", err, peerarg.WrappedHint)
	}
	if pid == n.identity.PeerID() {
		return DownloadResult{}, errors.New("refusing to download from self")
	}
	entry, limited, err := n.findEntry(ctx, pid, remotePath)
	if err != nil {
		return DownloadResult{}, err
	}
	if entry.Path == "" {
		return DownloadResult{}, fmt.Errorf("对方发布清单里没有文件 %q；<path> 要填对方清单里的路径（如 posts/hello.md），不是本地保存位置。可用 /files <名字|Peer ID> 或 raminga content manifest 查看；下载的文件保存到 <data-dir>/downloads/%s/。", remotePath, pid)
	}
	if entry.Size > maxDownloadBytes {
		return DownloadResult{}, fmt.Errorf("file is %d bytes, local download limit is %d", entry.Size, maxDownloadBytes)
	}
	if err := n.ensureDirect(ctx, pid, entry.Size, limited); err != nil {
		return DownloadResult{}, err
	}
	if progress == nil {
		progress = func(DownloadProgress) {}
	}
	progress(DownloadProgress{Phase: "start", Path: entry.Path, Total: entry.Size, Direct: !limited})

	downloadsDir := filepath.Join(n.dataDir, "downloads")
	if err := os.MkdirAll(filepath.Join(downloadsDir, pid.String()), 0o755); err != nil {
		return DownloadResult{}, err
	}
	root, err := os.OpenRoot(filepath.Join(downloadsDir, pid.String()))
	if err != nil {
		return DownloadResult{}, err
	}
	defer func() { _ = root.Close() }()
	rel := filepath.FromSlash(entry.Path)
	if err := root.MkdirAll(filepath.Dir(rel), 0o755); err != nil {
		return DownloadResult{}, err
	}
	partName := rel + ".part"
	part, err := root.OpenFile(partName, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return DownloadResult{}, err
	}
	partInfo, _ := part.Stat()
	offset := partInfo.Size()
	if offset > entry.Size {
		offset = 0
		_ = part.Truncate(0)
		_, _ = part.Seek(0, 0)
	}
	u := &url.URL{Scheme: "http", Host: pid.String(), Path: "/files/" + entry.Path}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		_ = part.Close()
		return DownloadResult{}, err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		req.Header.Set("If-Range", `"`+entry.SHA256+`"`)
	}
	res, err := n.net.HTTPClient().DoWithDial(ctx, pid, req, maxDownloadBytes)
	if err != nil {
		_ = part.Close()
		return DownloadResult{}, fmt.Errorf("download: %w", p2phttp.ProtocolMismatch(err, protocol.HTTPProtocol))
	}
	defer func() { _ = res.Response.Body.Close() }()
	appendMode := offset > 0 && res.Response.StatusCode == http.StatusPartialContent
	if appendMode {
		_, _ = part.Seek(offset, io.SeekStart)
	} else {
		offset = 0
		_ = part.Truncate(0)
		_, _ = part.Seek(0, 0)
	}
	if res.Response.StatusCode != http.StatusOK && res.Response.StatusCode != http.StatusPartialContent {
		_ = part.Close()
		return DownloadResult{}, fmt.Errorf("download status %d", res.Response.StatusCode)
	}
	written := offset
	buf := make([]byte, 64<<10)
	for {
		nr, rerr := res.Response.Body.Read(buf)
		if nr > 0 {
			written += int64(nr)
			if written > entry.Size {
				_ = part.Close()
				return DownloadResult{}, errors.New("file changed or corrupt: server sent more than manifest size")
			}
			if _, werr := part.Write(buf[:nr]); werr != nil {
				_ = part.Close()
				return DownloadResult{}, werr
			}
			progress(DownloadProgress{Phase: "download", Path: entry.Path, Received: written, Total: entry.Size, Direct: !res.Limited})
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			_ = part.Close()
			return DownloadResult{}, fmt.Errorf("download interrupted: %w", rerr)
		}
	}
	if err := part.Sync(); err != nil {
		_ = part.Close()
		return DownloadResult{}, err
	}
	if err := part.Close(); err != nil {
		return DownloadResult{}, err
	}
	if written != entry.Size {
		_ = root.Remove(partName)
		return DownloadResult{}, fmt.Errorf("file changed or corrupt: size %d, manifest %d; retry", written, entry.Size)
	}
	progress(DownloadProgress{Phase: "verify", Path: entry.Path, Received: written, Total: entry.Size, Direct: !res.Limited})
	hash, err := hashRootFile(root, partName)
	if err != nil {
		return DownloadResult{}, err
	}
	if hash != entry.SHA256 {
		_ = root.Remove(partName)
		return DownloadResult{}, fmt.Errorf("file changed or corrupt: sha256 mismatch (%s != %s); retry", hash, entry.SHA256)
	}
	final := filepath.Join(root.Name(), rel)
	if err := os.Rename(filepath.Join(root.Name(), partName), final); err != nil {
		_ = root.Remove(partName)
		return DownloadResult{}, err
	}
	progress(DownloadProgress{Phase: "complete", Path: entry.Path, Received: written, Total: entry.Size, Direct: !res.Limited})
	n.recordFriend(context.Background(), pid, false)
	return DownloadResult{PeerID: pid.String(), Path: entry.Path, LocalPath: final, Size: written, SHA256: hash, Resumed: appendMode, Direct: !res.Limited}, nil
}

func hashRootFile(root *os.Root, name string) (string, error) {
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (n *Node) ViewProfile(ctx context.Context, peerID string) (PeerProfile, error) {
	pid, err := peer.Decode(peerarg.Normalize(peerID))
	if err != nil {
		return PeerProfile{}, fmt.Errorf("invalid peer ID: %w；%s", err, peerarg.WrappedHint)
	}
	manifest, err := n.FetchManifest(ctx, pid.String(), 0, content.MaxManifestLimit)
	if err != nil {
		return PeerProfile{}, err
	}
	profile := PeerProfile{PeerID: pid.String()}
	for _, e := range manifest.Entries {
		profile.Files = append(profile.Files, e.Path)
	}
	entry, _, err := n.findEntry(ctx, pid, "profile/index.md")
	if err != nil {
		return PeerProfile{}, err
	}
	if entry.Path == "" {
		return profile, nil
	}
	res, err := n.Download(ctx, pid.String(), entry.Path, nil)
	if err != nil {
		return PeerProfile{}, err
	}
	data, err := os.ReadFile(res.LocalPath)
	if err != nil {
		return PeerProfile{}, err
	}
	profile.Found = true
	profile.Text = string(data)
	profile.Name = firstHeading(profile.Text)
	if profile.Name == "" {
		profile.Name = pid.String()
	}
	return profile, nil
}

func firstHeading(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			return strings.TrimSpace(strings.TrimLeft(line, "#"))
		}
	}
	return ""
}

func (n *Node) ViewFriends(ctx context.Context, peerID string) (PeerFriends, error) {
	pid, err := peer.Decode(peerarg.Normalize(peerID))
	if err != nil {
		return PeerFriends{}, fmt.Errorf("invalid peer ID: %w；%s", err, peerarg.WrappedHint)
	}
	entry, limited, err := n.findEntry(ctx, pid, "friends.json")
	if err != nil {
		return PeerFriends{}, err
	}
	if entry.Path == "" {
		return PeerFriends{PeerID: pid.String()}, nil
	}
	if entry.Size > maxFriendsBody {
		return PeerFriends{}, fmt.Errorf("friends.json too large: %d bytes", entry.Size)
	}
	if err := n.ensureDirect(ctx, pid, entry.Size, limited); err != nil {
		return PeerFriends{}, err
	}
	res, err := n.Download(ctx, pid.String(), entry.Path, nil)
	if err != nil {
		return PeerFriends{}, err
	}
	data, err := os.ReadFile(res.LocalPath)
	if err != nil {
		return PeerFriends{}, err
	}
	var file publicFriendsFile
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return PeerFriends{}, fmt.Errorf("invalid friends.json: %w", err)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return PeerFriends{}, errors.New("friends.json trailing data")
	}
	if file.Version != 1 {
		return PeerFriends{}, fmt.Errorf("unsupported friends.json version %d", file.Version)
	}
	if len(file.Friends) > maxFriendsClaims {
		return PeerFriends{}, errors.New("friends.json has too many entries")
	}
	out := PeerFriends{PeerID: pid.String(), Limited: limited}
	for _, f := range file.Friends {
		if !utf8.ValidString(f.Name) || !utf8.ValidString(f.Description) || hasControl(f.Name) || hasControl(f.Description) {
			return PeerFriends{}, errors.New("friends.json contains control characters")
		}
		if _, err := peer.Decode(f.PeerID); err != nil {
			continue
		}
		f.Name = strings.TrimSpace(f.Name)
		f.Description = strings.TrimSpace(f.Description)
		if len(f.Name) > 256 {
			f.Name = f.Name[:256]
		}
		if len(f.Description) > 4096 {
			f.Description = f.Description[:4096]
		}
		addrs := make([]string, 0, 16)
		for _, raw := range f.Addrs {
			if len(addrs) == 16 {
				break
			}
			addr, err := ma.NewMultiaddr(raw)
			if err != nil || !usableHintAddr(addr) {
				continue
			}
			addrs = append(addrs, addr.String())
		}
		out.Friends = append(out.Friends, PeerFriend{Name: f.Name, PeerID: f.PeerID, Addrs: addrs, Description: f.Description})
	}
	return out, nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
func usableHintAddr(addr ma.Multiaddr) bool {
	ip, err := addr.ValueForProtocol(ma.P_IP4)
	if err == nil {
		_ = ip
		return !isLoopbackOrUnspecified(addr)
	}
	ip6, err := addr.ValueForProtocol(ma.P_IP6)
	if err == nil {
		_ = ip6
		return !isLoopbackOrUnspecified(addr)
	}
	return true
}
func isLoopbackOrUnspecified(addr ma.Multiaddr) bool {
	for _, p := range addr.Protocols() {
		if p.Code == ma.P_IP4 || p.Code == ma.P_IP6 {
			value, err := addr.ValueForProtocol(p.Code)
			if err != nil {
				return true
			}
			parsed := net.ParseIP(value)
			if parsed == nil {
				return true
			}
			return parsed.IsLoopback() || parsed.IsUnspecified() || parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() || parsed.IsMulticast()
		}
	}
	return false
}

func (n *Node) ConnectListedPeer(ctx context.Context, peerID string, addrs []string) (ConnectResult, error) {
	pid, err := peer.Decode(peerarg.Normalize(peerID))
	if err != nil {
		return ConnectResult{}, fmt.Errorf("invalid peer ID: %w；%s", err, peerarg.WrappedHint)
	}
	if len(addrs) > 16 {
		addrs = addrs[:16]
	}
	parsed := make([]ma.Multiaddr, 0, len(addrs))
	for _, raw := range addrs {
		if a, err := ma.NewMultiaddr(raw); err == nil && usableHintAddr(a) {
			parsed = append(parsed, a)
		}
	}
	n.net.AddPeerHints(pid, parsed, 10*time.Minute)
	return n.Connect(ctx, pid.String(), "")
}

// API-facing aliases use explicit Get names.
func (n *Node) GetPeerManifest(ctx context.Context, peerID string, offset, limit int) (PeerManifest, error) {
	return n.FetchManifest(ctx, peerID, offset, limit)
}
func (n *Node) GetPeerProfile(ctx context.Context, peerID string) (PeerProfile, error) {
	return n.ViewProfile(ctx, peerID)
}
func (n *Node) GetPeerFriends(ctx context.Context, peerID string) (PeerFriends, error) {
	return n.ViewFriends(ctx, peerID)
}
func (n *Node) DownloadPeerFile(ctx context.Context, peerID, path string, progress func(DownloadProgress)) (DownloadResult, error) {
	return n.Download(ctx, peerID, path, progress)
}
