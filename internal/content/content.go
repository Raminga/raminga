// Package content owns the public directory scanner, manifest and safe file
// access. Public content is untrusted input and is read through os.Root.
package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/sync/singleflight"
)

const (
	CacheTTL             = 30 * time.Second
	FirstScanWait        = 3 * time.Second
	MaxManifestPage      = 64 << 10
	MaxManifestLimit     = 200
	DefaultManifestLimit = 100
)

var ErrScanInProgress = errors.New("content: initial scan in progress")

type Limits struct {
	MaxFileBytes    int64
	MaxPostsBytes   int64
	MaxProfileBytes int64
}

type Entry struct {
	Path           string `json:"path"`
	Size           int64  `json:"size"`
	ModifiedUnixMS int64  `json:"modified_unix_ms"`
	SHA256         string `json:"sha256"`
}

type Skip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type Snapshot struct {
	PeerID      string
	GeneratedAt time.Time
	Entries     []Entry
	Total       int
	Warnings    []string
	Skipped     []Skip
	// FriendsSyncedAt is the mtime of friends.json, i.e. when its contents last
	// changed. WriteFriends skips unchanged writes, so this is not the last time
	// friends were synced.
	FriendsSyncedAt time.Time
}

type Manifest struct {
	Version           int     `json:"version"`
	PeerID            string  `json:"peer_id"`
	GeneratedAtUnixMS int64   `json:"generated_at_unix_ms"`
	Entries           []Entry `json:"entries"`
	Total             int     `json:"total"`
}

type hashKey struct {
	path  string
	size  int64
	mtime int64
}

type Store struct {
	publicDir string
	root      *os.Root
	peerID    string
	limits    Limits

	// publishMu serializes manifest scans and public-file writes with the
	// publication coordinator. Locked methods assume the caller holds it.
	publishMu sync.Mutex

	mu        sync.Mutex
	cache     *Snapshot
	cacheAt   time.Time
	gen       uint64
	sf        singleflight.Group
	lastErr   error
	hashes    map[hashKey]string
	lastWarn  []string
	scanDelay time.Duration // test hook; zero in production
}

func EnsureLayout(dataDir string) error {
	for _, dir := range []string{filepath.Join(dataDir, "public"), filepath.Join(dataDir, "public", "profile"), filepath.Join(dataDir, "public", "posts")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("content: create %s: %w", dir, err)
		}
	}
	return nil
}

func New(dataDir, peerID string, limits Limits) (*Store, error) {
	publicDir := filepath.Join(dataDir, "public")
	if err := EnsureLayout(dataDir); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(publicDir)
	if err != nil {
		return nil, fmt.Errorf("content: open public root: %w", err)
	}
	return &Store{publicDir: publicDir, root: root, peerID: peerID, limits: limits, hashes: make(map[hashKey]string)}, nil
}

func (s *Store) Close() error {
	if s == nil || s.root == nil {
		return nil
	}
	return s.root.Close()
}

func (s *Store) Invalidate() {
	s.mu.Lock()
	s.invalidateLocked()
	s.mu.Unlock()
}

func (s *Store) invalidateLocked() {
	s.gen++
	s.cache = nil
	s.cacheAt = time.Time{}
}

// LockPublish acquires the single public-write/scan lock. The publication
// coordinator holds it for the entire version-check/write/scan/record
// critical section. Callers must use the *Locked methods while holding it.
func (s *Store) LockPublish() { s.publishMu.Lock() }

// UnlockPublish releases the public-write/scan lock.
func (s *Store) UnlockPublish() { s.publishMu.Unlock() }

// InvalidateLocked is Invalidate for a caller already holding LockPublish.
func (s *Store) InvalidateLocked() { s.Invalidate() }

// Snapshot returns the cached manifest inside the TTL. After the TTL it waits
// for one singleflight scan, bounded by FirstScanWait and ctx. If the bound is
// reached it serves the previous snapshot rather than an arbitrarily old one.
func (s *Store) Snapshot(ctx context.Context) (*Snapshot, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	return s.SnapshotLocked(ctx)
}

// SnapshotLocked is Snapshot for a caller already holding LockPublish.
func (s *Store) SnapshotLocked(ctx context.Context) (*Snapshot, error) {
	s.mu.Lock()
	if s.cache != nil && time.Since(s.cacheAt) < CacheTTL {
		snap := s.cache
		s.mu.Unlock()
		return snap, nil
	}
	prev := s.cache
	gen := s.gen
	s.mu.Unlock()

	ch := s.sf.DoChan(s.scanKey(gen), func() (any, error) { return s.runScan(gen) })
	timer := time.NewTimer(FirstScanWait)
	defer timer.Stop()
	select {
	case res := <-ch:
		if res.Err != nil {
			if prev != nil {
				return prev, nil
			}
			return nil, res.Err
		}
		snap, _ := res.Val.(*Snapshot)
		if snap == nil {
			if prev != nil {
				return prev, nil
			}
			return nil, ErrScanInProgress
		}
		return snap, nil
	case <-timer.C:
		if prev != nil {
			return prev, nil
		}
		return nil, ErrScanInProgress
	case <-ctx.Done():
		if prev != nil {
			return prev, nil
		}
		return nil, ctx.Err()
	}
}

// Refresh forces a new scan and waits for it. /published uses this so a user
// never sees a cached list after adding a file.
func (s *Store) Refresh(ctx context.Context) (*Snapshot, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	return s.RefreshLocked(ctx)
}

// RefreshLocked is Refresh for a caller already holding LockPublish.
func (s *Store) RefreshLocked(ctx context.Context) (*Snapshot, error) {
	s.mu.Lock()
	s.gen++
	gen := s.gen
	s.mu.Unlock()
	resCh := s.sf.DoChan(s.scanKey(gen), func() (any, error) { return s.runScan(gen) })
	select {
	case res := <-resCh:
		if res.Err != nil {
			return nil, res.Err
		}
		snap, _ := res.Val.(*Snapshot)
		if snap == nil {
			return nil, ErrScanInProgress
		}
		return snap, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Store) scanKey(gen uint64) string {
	return fmt.Sprintf("scan-%d", gen)
}

func (s *Store) runScan(gen uint64) (*Snapshot, error) {
	snap, err := s.scanAll()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen != gen {
		// Invalidate/Refresh happened while this scan was running. Its result
		// may be stale, so never publish it as the fresh cache.
		return snap, err
	}
	s.lastErr = err
	if err == nil {
		s.cache = snap
		s.cacheAt = time.Now()
		s.lastWarn = append([]string(nil), snap.Warnings...)
	}
	return snap, err
}

func (s *Store) Warnings() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lastWarn...)
}

// scanAll walks the whole public directory. Files placed directly in public/
// are published without a metadata file or a user-maintained index; the
// existing per-file and per-area byte limits still bound what a scan exposes.
func (s *Store) scanAll() (*Snapshot, error) {
	if s.scanDelay > 0 {
		time.Sleep(s.scanDelay)
	}
	snap := &Snapshot{PeerID: s.peerID, GeneratedAt: time.Now().UTC()}
	var profileTotal, publicTotal int64
	if err := s.walk("", "", ".", &profileTotal, &publicTotal, &snap.Entries, &snap.Warnings, &snap.Skipped); err != nil {
		return nil, err
	}
	if fi, err := s.root.Lstat("friends.json"); err == nil && fi.Mode().IsRegular() {
		snap.FriendsSyncedAt = fi.ModTime().UTC()
	}
	sort.Slice(snap.Entries, func(i, j int) bool { return snap.Entries[i].Path < snap.Entries[j].Path })
	sort.Slice(snap.Skipped, func(i, j int) bool { return snap.Skipped[i].Path < snap.Skipped[j].Path })
	snap.Total = len(snap.Entries)
	return snap, nil
}

// walk recursively enumerates one public-directory level. profile/ keeps its
// own total so a large public file cannot evict the user's profile; every
// other public path shares MaxPostsBytes as the aggregate public-content cap.
func (s *Store) walk(rel, top, dir string, profileTotal, publicTotal *int64, entries *[]Entry, warnings *[]string, skipped *[]Skip) error {
	f, err := s.root.Open(dir)
	if err != nil {
		return nil
	}
	items, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		return err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name() < items[j].Name() })
	for _, item := range items {
		name := item.Name()
		child := name
		if rel != "" {
			child = path.Join(rel, name)
		}
		childTop := top
		if childTop == "" {
			childTop = name
		}
		if reason, skip := skipReason(name); skip {
			*skipped = append(*skipped, Skip{Path: child, Reason: reason})
			continue
		}
		if !utf8.ValidString(child) {
			*skipped = append(*skipped, Skip{Path: child, Reason: "invalid UTF-8 path"})
			*warnings = append(*warnings, "skip invalid UTF-8 path")
			continue
		}
		info, err := s.root.Lstat(child)
		if err != nil {
			*skipped = append(*skipped, Skip{Path: child, Reason: err.Error()})
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			*skipped = append(*skipped, Skip{Path: child, Reason: "symbolic link"})
			continue
		}
		if info.IsDir() {
			if err := s.walk(child, childTop, child, profileTotal, publicTotal, entries, warnings, skipped); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			*skipped = append(*skipped, Skip{Path: child, Reason: "not a regular file"})
			continue
		}
		if info.Size() > s.limits.MaxFileBytes {
			reason := fmt.Sprintf("file exceeds %d-byte limit", s.limits.MaxFileBytes)
			*skipped = append(*skipped, Skip{Path: child, Reason: reason})
			*warnings = append(*warnings, "skip "+child+": "+reason)
			continue
		}
		total, limit, label := publicTotal, s.limits.MaxPostsBytes, "public"
		if childTop == "profile" {
			total, limit, label = profileTotal, s.limits.MaxProfileBytes, "profile"
		}
		if limit > 0 && *total+info.Size() > limit {
			reason := fmt.Sprintf("%s total exceeds %d-byte limit", label, limit)
			*skipped = append(*skipped, Skip{Path: child, Reason: reason})
			*warnings = append(*warnings, "stop "+label+": "+reason)
			continue
		}
		entry, err := s.entry(child, info)
		if err != nil {
			*skipped = append(*skipped, Skip{Path: child, Reason: err.Error()})
			*warnings = append(*warnings, fmt.Sprintf("skip %s: %v", child, err))
			continue
		}
		*total += info.Size()
		*entries = append(*entries, entry)
	}
	return nil
}

func skipReason(name string) (string, bool) {
	if name == "" {
		return "empty name", true
	}
	if strings.HasPrefix(name, ".") {
		return "hidden name", true
	}
	if !utf8.ValidString(name) {
		return "invalid UTF-8 name", true
	}
	lower := strings.ToLower(name)
	if lower == "thumbs.db" || lower == "desktop.ini" {
		return "system metadata file", true
	}
	if strings.HasSuffix(lower, ".tmp") || strings.HasSuffix(lower, ".swp") || strings.HasPrefix(name, "~$") {
		return "temporary file", true
	}
	return "", false
}

func (s *Store) entry(rel string, info fs.FileInfo) (Entry, error) {
	key := hashKey{path: rel, size: info.Size(), mtime: info.ModTime().UnixNano()}
	s.mu.Lock()
	cached, ok := s.hashes[key]
	s.mu.Unlock()
	if !ok {
		f, err := s.root.Open(rel)
		if err != nil {
			return Entry{}, err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		_ = f.Close()
		if err != nil {
			return Entry{}, err
		}
		cached = hex.EncodeToString(h.Sum(nil))
		s.mu.Lock()
		s.hashes[key] = cached
		s.mu.Unlock()
	}
	return Entry{Path: rel, Size: info.Size(), ModifiedUnixMS: info.ModTime().UnixMilli(), SHA256: cached}, nil
}

// Page returns a deterministic, size-bounded manifest page. The total is the
// full manifest count, not the page count.
func (snap *Snapshot) Page(offset, limit int) Manifest {
	if limit <= 0 {
		limit = DefaultManifestLimit
	}
	if limit > MaxManifestLimit {
		limit = MaxManifestLimit
	}
	if offset < 0 {
		offset = 0
	}
	if offset > len(snap.Entries) {
		offset = len(snap.Entries)
	}
	end := offset + limit
	if end > len(snap.Entries) {
		end = len(snap.Entries)
	}
	page := Manifest{Version: 1, PeerID: snap.PeerID, GeneratedAtUnixMS: snap.GeneratedAt.UnixMilli(), Entries: append([]Entry{}, snap.Entries[offset:end]...), Total: snap.Total}
	for len(page.Entries) > 0 {
		raw, _ := json.Marshal(page)
		if len(raw) <= MaxManifestPage {
			break
		}
		page.Entries = page.Entries[:len(page.Entries)-1]
	}
	return page
}

func (s *Store) File(rel string) (*os.File, fs.FileInfo, error) {
	f, err := s.root.Open(rel)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, info, nil
}

// WriteFriends atomically replaces friends.json only when bytes differ. It is
// the only writer for the generated file.
func (s *Store) WriteFriends(data []byte) (bool, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	current, err := os.ReadFile(filepath.Join(s.publicDir, "friends.json"))
	if err == nil && bytes.Equal(current, data) {
		return false, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	tmp, err := os.CreateTemp(s.publicDir, ".friends-*.tmp")
	if err != nil {
		return false, err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmpName, filepath.Join(s.publicDir, "friends.json")); err != nil {
		return false, err
	}
	s.mu.Lock()
	s.invalidateLocked()
	s.mu.Unlock()
	return true, nil
}
