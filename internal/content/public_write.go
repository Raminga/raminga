package content

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

// ErrInvalidPublicPath reports a path that is not a safe relative public path.
var ErrInvalidPublicPath = errors.New("content: invalid public path")

func validatePublicRel(rel string) (string, error) {
	if rel == "" || len(rel) > 512 || strings.ContainsRune(rel, 0) || strings.Contains(rel, "\\") || strings.HasPrefix(rel, "/") {
		return "", ErrInvalidPublicPath
	}
	clean := path.Clean(rel)
	if clean == "." || clean != rel {
		return "", ErrInvalidPublicPath
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrInvalidPublicPath
		}
		if strings.HasPrefix(part, ".") {
			return "", ErrInvalidPublicPath
		}
	}
	return clean, nil
}

// ensureParentsLocked creates public subdirectories, rejecting any symlink on
// the path. It is safe to call while holding LockPublish.
func (s *Store) ensureParentsLocked(rel string) error {
	parts := strings.Split(rel, "/")
	current := ""
	for _, part := range parts[:len(parts)-1] {
		if current == "" {
			current = part
		} else {
			current += "/" + part
		}
		info, err := s.root.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			if err := s.root.Mkdir(current, 0o755); err != nil {
				return fmt.Errorf("content: create public directory %s: %w", current, err)
			}
			continue
		}
		if err != nil {
			return fmt.Errorf("content: inspect public directory %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("content: refusing symbolic link in public path %s", current)
		}
		if !info.IsDir() {
			return fmt.Errorf("content: public path component %s is not a directory", current)
		}
	}
	return nil
}

func (s *Store) checkTargetLocked(rel string) error {
	info, err := s.root.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("content: refusing symbolic link target %s", rel)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("content: refusing non-regular target %s", rel)
	}
	return nil
}

// WritePublicFile atomically writes one public file. It is the only public
// writer. A temporary file in the same directory is synced, chmodded 0644 and
// renamed; a failure never exposes a partial file.
func (s *Store) WritePublicFile(rel string, data []byte) (Entry, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	return s.WritePublicFileLocked(rel, data)
}

// WritePublicFileLocked is WritePublicFile for a caller holding LockPublish.
func (s *Store) WritePublicFileLocked(rel string, data []byte) (Entry, error) {
	rel, err := validatePublicRel(rel)
	if err != nil {
		return Entry{}, err
	}
	if err := s.ensureParentsLocked(rel); err != nil {
		return Entry{}, err
	}
	if err := s.checkTargetLocked(rel); err != nil {
		return Entry{}, err
	}
	dir := path.Dir(rel)
	base := path.Base(rel)
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return Entry{}, fmt.Errorf("content: random temp name: %w", err)
	}
	tmp := base + ".tmp-" + hex.EncodeToString(suffix[:])
	if dir != "." {
		tmp = dir + "/" + tmp
	}
	tmp = path.Join(path.Dir(rel), "."+path.Base(tmp))
	f, err := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Entry{}, fmt.Errorf("content: create temp file: %w", err)
	}
	cleanup := true
	defer func() {
		_ = f.Close()
		if cleanup {
			_ = s.root.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return Entry{}, fmt.Errorf("content: write temp file: %w", err)
	}
	if err := f.Sync(); err != nil {
		return Entry{}, fmt.Errorf("content: sync temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		return Entry{}, fmt.Errorf("content: close temp file: %w", err)
	}
	if err := s.root.Chmod(tmp, 0o644); err != nil {
		return Entry{}, fmt.Errorf("content: chmod temp file: %w", err)
	}
	if err := s.root.Rename(tmp, rel); err != nil {
		return Entry{}, fmt.Errorf("content: rename public file: %w", err)
	}
	cleanup = false
	// Best-effort directory fsync: rename is already atomic, and some
	// platforms do not permit syncing a directory handle.
	if parent, err := s.root.Open(path.Dir(rel)); err == nil {
		_ = parent.Sync()
		_ = parent.Close()
	}
	s.mu.Lock()
	s.invalidateLocked()
	s.hashes = make(map[hashKey]string)
	s.mu.Unlock()
	info, err := s.root.Lstat(rel)
	if err != nil {
		return Entry{}, fmt.Errorf("content: stat written file: %w", err)
	}
	sum := sha256.Sum256(data)
	return Entry{Path: rel, Size: int64(len(data)), ModifiedUnixMS: info.ModTime().UnixMilli(), SHA256: hex.EncodeToString(sum[:])}, nil
}

// RemovePublicFile removes one public file. A missing file is a no-op; a
// symlink is refused.
func (s *Store) RemovePublicFile(rel string) error {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	return s.RemovePublicFileLocked(rel)
}

// RemovePublicFileLocked is RemovePublicFile for a caller holding LockPublish.
func (s *Store) RemovePublicFileLocked(rel string) error {
	rel, err := validatePublicRel(rel)
	if err != nil {
		return err
	}
	info, err := s.root.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("content: refusing symbolic link %s", rel)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("content: refusing non-regular file %s", rel)
	}
	if err := s.root.Remove(rel); err != nil {
		return fmt.Errorf("content: remove public file: %w", err)
	}
	// Dropping the hash cache avoids reusing a stale digest after removal.
	s.mu.Lock()
	s.hashes = make(map[hashKey]string)
	s.invalidateLocked()
	s.mu.Unlock()
	return nil
}

// ReadPublicFileLocked reads one regular public file, rejecting symlinks.
func (s *Store) ReadPublicFileLocked(rel string, maxBytes int64) ([]byte, error) {
	rel, err := validatePublicRel(rel)
	if err != nil {
		return nil, err
	}
	info, err := s.root.Lstat(rel)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("content: symbolic link %s", rel)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("content: %s is not a regular file", rel)
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return nil, fmt.Errorf("content: %s exceeds %d bytes", rel, maxBytes)
	}
	return s.root.ReadFile(rel)
}

// PublicFileExistsLocked reports a regular, non-symlink public file.
func (s *Store) PublicFileExistsLocked(rel string) (bool, error) {
	rel, err := validatePublicRel(rel)
	if err != nil {
		return false, err
	}
	info, err := s.root.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0, nil
}

// PublicFileSHA256Locked hashes one public file without exposing its bytes.
func (s *Store) PublicFileSHA256Locked(rel string, maxBytes int64) (string, int64, error) {
	data, err := s.ReadPublicFileLocked(rel, maxBytes)
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), int64(len(data)), nil
}

// ManifestDigest computes the stable publication digest over version, peer_id
// and path-sorted entries. GeneratedAt and mtimes are intentionally excluded.
func ManifestDigest(snap *Snapshot) string {
	if snap == nil {
		return ""
	}
	type digestEntry struct {
		Path      string `json:"path"`
		SizeBytes int64  `json:"size_bytes"`
		SHA256    string `json:"sha256"`
	}
	entries := make([]digestEntry, 0, len(snap.Entries))
	for _, entry := range snap.Entries {
		entries = append(entries, digestEntry{Path: entry.Path, SizeBytes: entry.Size, SHA256: entry.SHA256})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	canonical := struct {
		Version int           `json:"version"`
		PeerID  string        `json:"peer_id"`
		Entries []digestEntry `json:"entries"`
	}{Version: 1, PeerID: snap.PeerID, Entries: entries}
	raw, _ := json.Marshal(canonical)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// NewPublishID returns a safe staging directory name.
func NewPublishID(now time.Time) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("publish-%d-%s", now.UnixNano(), hex.EncodeToString(b[:]))
}
