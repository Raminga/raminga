package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

// Friend is one local friend record. It is not the wire identity; names and
// descriptions are local UI data only.
type Friend struct {
	PeerID            string
	Name              string
	Addrs             []string
	Description       string
	ManuallyConnected bool
	RelayCapable      bool
	DHTCapable        bool
	Paused            bool
	FirstSeenMS       int64
	LastInteractionMS int64
}

// FriendNamePattern is the existing local-name rule.
var FriendNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// Friend errors are stable so node/API can map them without parsing SQL text.
var (
	ErrFriendNotFound      = errors.New("storage: friend not found")
	ErrFriendNameTaken     = errors.New("storage: friend name already used")
	ErrFriendPendingOutbox = errors.New("storage: friend has pending outbox messages")
)

// SetMaxFriends bounds the friends table. Values <= 0 restore the default.
func (s *Store) SetMaxFriends(max int) {
	if max <= 0 {
		max = defaultMaxFriends
	}
	s.maxFriends = max
}

// ValidateFriendName applies the pre-existing local name rule.
func ValidateFriendName(name string) error {
	if !FriendNamePattern.MatchString(strings.TrimSpace(name)) {
		return fmt.Errorf("无效名称 %q：只允许小写字母、数字和 -，最多 32 个字符", name)
	}
	return nil
}

func filterFriendAddrs(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, value := range raw {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		addr, err := ma.NewMultiaddr(value)
		if err != nil || manet.IsIPLoopback(addr) || manet.IsIP6LinkLocal(addr) {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
		if len(out) == maxFriendAddrs {
			break
		}
	}
	return out
}

func mergeFriendAddrs(old, next []string) []string {
	out := make([]string, 0, len(old)+len(next))
	seen := make(map[string]struct{}, len(old)+len(next))
	for _, list := range [][]string{next, old} {
		for _, value := range list {
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			out = append(out, value)
			if len(out) == maxFriendAddrs {
				return out
			}
		}
	}
	return out
}

func (s *Store) scanFriend(scanner interface{ Scan(...any) error }) (Friend, error) {
	var (
		f                                Friend
		addrsRaw                         string
		manual, relayCap, dhtCap, paused int
	)
	if err := scanner.Scan(&f.PeerID, &f.Name, &addrsRaw, &f.Description, &manual, &f.FirstSeenMS, &f.LastInteractionMS, &relayCap, &dhtCap, &paused); err != nil {
		return Friend{}, err
	}
	if err := jsonUnmarshal(addrsRaw, &f.Addrs); err != nil {
		return Friend{}, fmt.Errorf("decode friend addrs: %w", err)
	}
	f.ManuallyConnected = manual != 0
	f.RelayCapable = relayCap != 0
	f.DHTCapable = dhtCap != 0
	f.Paused = paused != 0
	return f, nil
}

func jsonUnmarshal(raw string, dst *[]string) error {
	if raw == "" {
		*dst = nil
		return nil
	}
	return json.Unmarshal([]byte(raw), dst)
}

// UpsertFriend records an interaction. New rows and address/manual changes write
// immediately; a plain interaction is throttled to once per 10 minutes.
func (s *Store) UpsertFriend(ctx context.Context, peerID string, addrs []string, manuallyConnected, touch bool) (Friend, bool, error) {
	now := s.now().UnixMilli()
	addrs = filterFriendAddrs(addrs)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Friend{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRowContext(ctx, `SELECT f.peer_id, f.name, f.addrs_json, f.description, f.manually_connected, f.first_seen_ms, f.last_interaction_ms, f.relay_capable, f.dht_capable, (p.peer_id IS NOT NULL) AS paused FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id WHERE f.peer_id=?`, peerID)
	current, err := s.scanFriend(row)
	created := false
	if errors.Is(err, sql.ErrNoRows) {
		created = true
		current = Friend{PeerID: peerID, Addrs: nil, FirstSeenMS: now, LastInteractionMS: now}
	} else if err != nil {
		return Friend{}, false, err
	}
	merged := mergeFriendAddrs(current.Addrs, addrs)
	addrChanged := strings.Join(merged, "\x00") != strings.Join(current.Addrs, "\x00")
	last := current.LastInteractionMS
	writeLast := created || addrChanged || manuallyConnected
	if !writeLast && touch && now-last >= friendTouchInterval.Milliseconds() {
		writeLast = true
	}
	if writeLast {
		last = now
	}
	manual := current.ManuallyConnected || manuallyConnected
	if created {
		addrsJSON, _ := json.Marshal(merged)
		if _, err := tx.ExecContext(ctx, `INSERT INTO friends (peer_id,name,addrs_json,description,manually_connected,first_seen_ms,last_interaction_ms) VALUES (?,?,?,?,?,?,?)`,
			peerID, "", addrsJSON, "", boolInt(manual), current.FirstSeenMS, last); err != nil {
			return Friend{}, false, err
		}
	} else if addrChanged || manual != current.ManuallyConnected || writeLast {
		addrsJSON, _ := json.Marshal(merged)
		if _, err := tx.ExecContext(ctx, `UPDATE friends SET addrs_json=?, manually_connected=?, last_interaction_ms=? WHERE peer_id=?`,
			addrsJSON, boolInt(manual), last, peerID); err != nil {
			return Friend{}, false, err
		}
	}
	if err := s.pruneFriendsTx(ctx, tx); err != nil {
		return Friend{}, false, err
	}
	updated, err := s.scanFriend(tx.QueryRowContext(ctx, `SELECT f.peer_id,f.name,f.addrs_json,f.description,f.manually_connected,f.first_seen_ms,f.last_interaction_ms,f.relay_capable,f.dht_capable,(p.peer_id IS NOT NULL) AS paused FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id WHERE f.peer_id=?`, peerID))
	if err != nil {
		return Friend{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Friend{}, false, err
	}
	return updated, created, nil
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (s *Store) pruneFriendsTx(ctx context.Context, tx *sql.Tx) error {
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM friends`).Scan(&count); err != nil {
		return err
	}
	if count <= s.maxFriends {
		return nil
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM friends WHERE manually_connected=0 AND peer_id IN (
		SELECT peer_id FROM friends WHERE manually_connected=0 ORDER BY last_interaction_ms ASC, peer_id ASC LIMIT ?)`, count-s.maxFriends)
	return err
}

// ListFriends returns all rows, named peers first and then by Peer ID.
func (s *Store) ListFriends(ctx context.Context) ([]Friend, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT f.peer_id,f.name,f.addrs_json,f.description,f.manually_connected,f.first_seen_ms,f.last_interaction_ms,f.relay_capable,f.dht_capable,(p.peer_id IS NOT NULL) AS paused FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id ORDER BY CASE WHEN f.name='' THEN 1 ELSE 0 END, f.name, f.peer_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]Friend, 0)
	for rows.Next() {
		f, err := s.scanFriend(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// GetFriend returns one row by Peer ID.
func (s *Store) GetFriend(ctx context.Context, peerID string) (Friend, bool, error) {
	f, err := s.scanFriend(s.db.QueryRowContext(ctx, `SELECT f.peer_id,f.name,f.addrs_json,f.description,f.manually_connected,f.first_seen_ms,f.last_interaction_ms,f.relay_capable,f.dht_capable,(p.peer_id IS NOT NULL) AS paused FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id WHERE f.peer_id=?`, peerID))
	if errors.Is(err, sql.ErrNoRows) {
		return Friend{}, false, nil
	}
	if err != nil {
		return Friend{}, false, err
	}
	return f, true, nil
}

// GetFriendByName resolves a local name.
func (s *Store) GetFriendByName(ctx context.Context, name string) (Friend, bool, error) {
	f, err := s.scanFriend(s.db.QueryRowContext(ctx, `SELECT f.peer_id,f.name,f.addrs_json,f.description,f.manually_connected,f.first_seen_ms,f.last_interaction_ms,f.relay_capable,f.dht_capable,(p.peer_id IS NOT NULL) AS paused FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id WHERE f.name=?`, strings.TrimSpace(name)))
	if errors.Is(err, sql.ErrNoRows) {
		return Friend{}, false, nil
	}
	if err != nil {
		return Friend{}, false, err
	}
	return f, true, nil
}

// SetFriendName replaces (or clears, when name is empty) a friend's local name.
func (s *Store) SetFriendName(ctx context.Context, peerID, name string) (Friend, error) {
	name = strings.TrimSpace(name)
	if name != "" {
		if err := ValidateFriendName(name); err != nil {
			return Friend{}, err
		}
	}
	var other string
	err := s.db.QueryRowContext(ctx, `SELECT peer_id FROM friends WHERE name=? AND peer_id<>?`, name, peerID).Scan(&other)
	if err == nil && name != "" {
		return Friend{}, ErrFriendNameTaken
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Friend{}, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE friends SET name=? WHERE peer_id=?`, name, peerID)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Friend{}, ErrFriendNameTaken
		}
		return Friend{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Friend{}, ErrFriendNotFound
	}
	f, _, err := s.GetFriend(ctx, peerID)
	return f, err
}

// SetFriendDescription replaces a description. It is at most 280 characters and
// rejects control characters.
func (s *Store) SetFriendDescription(ctx context.Context, peerID, description string) (Friend, error) {
	description = strings.TrimSpace(description)
	if utf8.RuneCountInString(description) > 280 {
		return Friend{}, errors.New("描述最多 280 个字符")
	}
	for _, r := range description {
		if unicode.IsControl(r) {
			return Friend{}, errors.New("描述不能包含控制字符")
		}
	}
	res, err := s.db.ExecContext(ctx, `UPDATE friends SET description=? WHERE peer_id=?`, description, peerID)
	if err != nil {
		return Friend{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Friend{}, ErrFriendNotFound
	}
	f, _, err := s.GetFriend(ctx, peerID)
	return f, err
}

// RemoveFriend deletes the row (chat history is untouched). If pending outbox
// rows exist, they must be explicitly cancelled or the delete is refused.
func (s *Store) RemoveFriend(ctx context.Context, peerID string, cancelPending bool) (bool, int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var pending int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM outbox WHERE peer_id=? AND status='pending'`, peerID).Scan(&pending); err != nil {
		return false, 0, err
	}
	if pending > 0 && !cancelPending {
		return false, pending, ErrFriendPendingOutbox
	}
	if pending > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE outbox SET status='cancelled', updated_at_ms=? WHERE peer_id=? AND status='pending'`, time.Now().UnixMilli(), peerID); err != nil {
			return false, pending, err
		}
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM friends WHERE peer_id=?`, peerID)
	if err != nil {
		return false, pending, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, pending, ErrFriendNotFound
	}
	if err := tx.Commit(); err != nil {
		return false, pending, err
	}
	return true, pending, nil
}

// MaxAddrs is the storage limit for a friend's address list.
const maxFriendAddrs = 16

// friendTouchInterval is the write throttle for plain interactions.
var friendTouchInterval = 10 * time.Minute

// PausePeer persists a pause without creating a friend row.
func (s *Store) PausePeer(ctx context.Context, peerID string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO paused_peers (peer_id,paused_at_ms) VALUES (?,?) ON CONFLICT(peer_id) DO UPDATE SET paused_at_ms=excluded.paused_at_ms`, peerID, s.now().UnixMilli())
	return err
}

// ResumePeer clears a persisted pause.
func (s *Store) ResumePeer(ctx context.Context, peerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM paused_peers WHERE peer_id=?`, peerID)
	return err
}

// IsPaused reports the persistent pause flag.
func (s *Store) IsPaused(ctx context.Context, peerID string) bool {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM paused_peers WHERE peer_id=?`, peerID).Scan(&one)
	return err == nil
}

// ListPausedPeers returns persisted pause Peer IDs.
func (s *Store) ListPausedPeers(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT peer_id FROM paused_peers ORDER BY peer_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// SetFriendCapabilities persists protocol capabilities learned from identify.
func (s *Store) SetFriendCapabilities(ctx context.Context, peerID string, relay, dht bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE friends SET relay_capable=?, dht_capable=? WHERE peer_id=?`, boolInt(relay), boolInt(dht), peerID)
	return err
}

// FriendsForRestart returns manual, unpaused friends with relay/DHT capability.
func (s *Store) FriendsForRestart(ctx context.Context, limit int) ([]Friend, error) {
	if limit <= 0 {
		limit = 3
	}
	rows, err := s.db.QueryContext(ctx, `SELECT f.peer_id,f.name,f.addrs_json,f.description,f.manually_connected,f.first_seen_ms,f.last_interaction_ms,f.relay_capable,f.dht_capable,0 AS paused
		FROM friends f LEFT JOIN paused_peers p ON p.peer_id=f.peer_id
		WHERE f.manually_connected=1 AND p.peer_id IS NULL AND (f.relay_capable=1 OR f.dht_capable=1)
		ORDER BY f.last_interaction_ms DESC, f.peer_id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Friend
	for rows.Next() {
		f, err := s.scanFriend(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
