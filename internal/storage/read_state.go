package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrMessageNotFound reports that a requested message ID does not belong to
// the stated Peer in the currently retained history.
var ErrMessageNotFound = errors.New("storage: message not found for peer")

// ReadState is the human read cursor for one Peer. The timestamp is the
// authoritative boundary; last_read_message_id is the public, human-readable
// position at that same millisecond. Same-millisecond messages are treated as
// one read batch.
type ReadState struct {
	PeerID            string
	LastReadAtMS      int64
	LastReadMessageID string
	UpdatedAtMS       int64
}

// MarkReadResult is one monotonic cursor update and the remaining unread count.
type MarkReadResult struct {
	State       ReadState
	UnreadCount int
}

// unreadCountsCTE is the single unread definition shared by conversation and
// friend queries. Only retained inbound rows newer than the human cursor count;
// outbound, failed outbound and unknown-origin rows never add unread.
const unreadCountsCTE = `unread_counts AS (
	SELECT m.peer_id AS peer_id, COUNT(*) AS unread_count
	FROM messages m
	LEFT JOIN conversation_read_state r ON r.peer_id = m.peer_id
	WHERE m.direction = 'in' AND m.created_at_ms > COALESCE(r.last_read_at_ms, 0)
	GROUP BY m.peer_id
)`

// GetPeerMessage returns one retained message scoped to a Peer.
func (s *Store) GetPeerMessage(ctx context.Context, peerID, messageID string) (Message, bool, error) {
	if peerID == "" || messageID == "" {
		return Message{}, false, nil
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT `+messageColumns+` FROM messages WHERE peer_id=? AND message_id=?`,
		peerID, messageID)
	m, err := scanMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	if err != nil {
		return Message{}, false, fmt.Errorf("get peer message: %w", err)
	}
	return m, true, nil
}

// GetReadState returns the current human cursor, or a zero cursor when the
// Peer has never been marked read.
func (s *Store) GetReadState(ctx context.Context, peerID string) (ReadState, error) {
	state := ReadState{PeerID: peerID}
	err := s.db.QueryRowContext(ctx,
		`SELECT peer_id, last_read_at_ms, last_read_message_id, updated_at_ms
		 FROM conversation_read_state WHERE peer_id=?`, peerID).Scan(
		&state.PeerID, &state.LastReadAtMS, &state.LastReadMessageID, &state.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return ReadState{PeerID: peerID}, nil
	}
	if err != nil {
		return ReadState{}, fmt.Errorf("get conversation read state: %w", err)
	}
	return state, nil
}

// CountUnread returns the number of retained inbound messages newer than the
// shared human cursor.
func (s *Store) CountUnread(ctx context.Context, peerID string) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `WITH `+unreadCountsCTE+`
		SELECT COALESCE((SELECT unread_count FROM unread_counts WHERE peer_id=?), 0)`, peerID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count unread messages: %w", err)
	}
	return count, nil
}

// MarkConversationRead advances the human cursor monotonically through one
// retained message. A message belongs to the stated Peer and may be inbound or
// outbound (the newest message the human actually saw). A lower timestamp never
// moves the cursor backwards; an equal timestamp only records the message ID
// without widening the read boundary.
func (s *Store) MarkConversationRead(ctx context.Context, peerID, messageID string, nowMS int64) (MarkReadResult, error) {
	if strings.TrimSpace(peerID) == "" {
		return MarkReadResult{}, errors.New("storage: peer ID is required")
	}
	if strings.TrimSpace(messageID) == "" {
		return MarkReadResult{}, errors.New("storage: message ID is required")
	}
	if nowMS <= 0 {
		nowMS = s.now().UnixMilli()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MarkReadResult{}, fmt.Errorf("mark conversation read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var targetAt int64
	if err := tx.QueryRowContext(ctx,
		`SELECT created_at_ms FROM messages WHERE peer_id=? AND message_id=?`,
		peerID, messageID).Scan(&targetAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MarkReadResult{}, ErrMessageNotFound
		}
		return MarkReadResult{}, fmt.Errorf("read target message: %w", err)
	}
	// The upsert is atomic at the SQL level. Concurrent marks may read the same
	// starting cursor, but a later transaction cannot move the boundary
	// backwards: an older target keeps the existing timestamp/ID, while the
	// newest target wins. Re-read the row inside the transaction so the
	// response reflects the actual committed value rather than a stale read.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO conversation_read_state
			(peer_id, last_read_at_ms, last_read_message_id, updated_at_ms)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(peer_id) DO UPDATE SET
			last_read_message_id = CASE
				WHEN excluded.last_read_at_ms > conversation_read_state.last_read_at_ms THEN excluded.last_read_message_id
				WHEN excluded.last_read_at_ms = conversation_read_state.last_read_at_ms THEN excluded.last_read_message_id
				ELSE conversation_read_state.last_read_message_id END,
			last_read_at_ms = MAX(conversation_read_state.last_read_at_ms, excluded.last_read_at_ms),
			updated_at_ms = CASE
				WHEN excluded.last_read_at_ms >= conversation_read_state.last_read_at_ms THEN excluded.updated_at_ms
				ELSE conversation_read_state.updated_at_ms END`,
		peerID, targetAt, messageID, nowMS); err != nil {
		return MarkReadResult{}, fmt.Errorf("write conversation read state: %w", err)
	}
	var final ReadState
	if err := tx.QueryRowContext(ctx,
		`SELECT peer_id, last_read_at_ms, last_read_message_id, updated_at_ms
		 FROM conversation_read_state WHERE peer_id=?`, peerID).Scan(
		&final.PeerID, &final.LastReadAtMS, &final.LastReadMessageID, &final.UpdatedAtMS); err != nil {
		return MarkReadResult{}, fmt.Errorf("read committed conversation cursor: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return MarkReadResult{}, fmt.Errorf("commit conversation read state: %w", err)
	}
	unread, err := s.CountUnread(ctx, peerID)
	if err != nil {
		return MarkReadResult{}, err
	}
	return MarkReadResult{State: final, UnreadCount: unread}, nil
}

// Favorite is one privately retained public-post bookmark. The unique key is
// only (peer_id, path, sha256): messages, contacts and private notes cannot be
// represented here.
type Favorite struct {
	ID          string
	PeerID      string
	Path        string
	SHA256      string
	Title       string
	CreatedAtMS int64
}

// FavoritePage is one keyset page of favorites, newest first.
type FavoritePage struct {
	Items      []Favorite
	NextBefore string
	HasMore    bool
}

type favoriteCursorEnvelope struct {
	V  int    `json:"v"`
	At int64  `json:"at"`
	ID string `json:"id"`
}

// EncodeFavoriteCursor serializes the (created_at_ms, id) position.
func EncodeFavoriteCursor(at int64, id string) string {
	raw, _ := json.Marshal(favoriteCursorEnvelope{V: 1, At: at, ID: id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeFavoriteCursor validates an opaque favorites cursor.
func DecodeFavoriteCursor(raw string) (at int64, id string, err error) {
	if strings.TrimSpace(raw) == "" {
		return 0, "", nil
	}
	if len(raw) > 512 {
		return 0, "", ErrInvalidCursor
	}
	data, decodeErr := base64.RawURLEncoding.DecodeString(raw)
	if decodeErr != nil {
		return 0, "", ErrInvalidCursor
	}
	var env favoriteCursorEnvelope
	if json.Unmarshal(data, &env) != nil || env.V != 1 || env.At < 0 || len(env.ID) > 128 {
		return 0, "", ErrInvalidCursor
	}
	return env.At, env.ID, nil
}

func favoriteID(peerID, path, digest string) string {
	sum := sha256.Sum256([]byte(peerID + "\x00" + path + "\x00" + digest))
	return "fav_" + hex.EncodeToString(sum[:16])
}

// SetFavorite is idempotent for one (peer, path, sha256) key. Clearing an
// absent key succeeds with an empty item and favorite=false; it never errors.
func (s *Store) SetFavorite(ctx context.Context, peerID, publicPath, sha256, title string, nowMS int64, favorite bool) (Favorite, bool, error) {
	if peerID == "" {
		return Favorite{}, false, errors.New("storage: peer ID is required")
	}
	if publicPath == "" || sha256 == "" {
		return Favorite{}, false, errors.New("storage: favorite path and sha256 are required")
	}
	if nowMS <= 0 {
		nowMS = s.now().UnixMilli()
	}
	title = strings.TrimSpace(title)
	if len([]rune(title)) > 200 {
		title = string([]rune(title)[:200])
	}
	if !favorite {
		if _, err := s.db.ExecContext(ctx,
			`DELETE FROM favorites WHERE peer_id=? AND path=? AND sha256=?`,
			peerID, publicPath, sha256); err != nil {
			return Favorite{}, false, fmt.Errorf("remove favorite: %w", err)
		}
		return Favorite{}, false, nil
	}
	id := favoriteID(peerID, publicPath, sha256)
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO favorites (id, peer_id, path, sha256, title, created_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(peer_id, path, sha256) DO UPDATE SET title = excluded.title`,
		id, peerID, publicPath, sha256, title, nowMS); err != nil {
		return Favorite{}, false, fmt.Errorf("save favorite: %w", err)
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT id, peer_id, path, sha256, title, created_at_ms
		 FROM favorites WHERE peer_id=? AND path=? AND sha256=?`,
		peerID, publicPath, sha256)
	var item Favorite
	if err := row.Scan(&item.ID, &item.PeerID, &item.Path, &item.SHA256, &item.Title, &item.CreatedAtMS); err != nil {
		return Favorite{}, false, fmt.Errorf("read saved favorite: %w", err)
	}
	return item, true, nil
}

// ListFavorites returns favorites newest first with a stable keyset cursor.
func (s *Store) ListFavorites(ctx context.Context, before string, limit int) (FavoritePage, error) {
	at, id, err := DecodeFavoriteCursor(before)
	if err != nil {
		return FavoritePage{}, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	query := `SELECT id, peer_id, path, sha256, title, created_at_ms FROM favorites`
	args := []any{}
	if before != "" {
		query += ` WHERE (created_at_ms < ? OR (created_at_ms = ? AND id < ?))`
		args = append(args, at, at, id)
	}
	query += ` ORDER BY created_at_ms DESC, id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return FavoritePage{}, fmt.Errorf("query favorites: %w", err)
	}
	defer func() { _ = rows.Close() }()
	page := FavoritePage{Items: make([]Favorite, 0, limit)}
	for rows.Next() {
		var item Favorite
		if err := rows.Scan(&item.ID, &item.PeerID, &item.Path, &item.SHA256, &item.Title, &item.CreatedAtMS); err != nil {
			return FavoritePage{}, fmt.Errorf("scan favorite: %w", err)
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return FavoritePage{}, fmt.Errorf("iterate favorites: %w", err)
	}
	page.HasMore = len(page.Items) > limit
	if page.HasMore {
		page.Items = page.Items[:limit]
	}
	if page.HasMore && len(page.Items) > 0 {
		last := page.Items[len(page.Items)-1]
		page.NextBefore = EncodeFavoriteCursor(last.CreatedAtMS, last.ID)
	}
	return page, nil
}

// PublicDiscoveryExists reports whether one exact remote post version is
// recorded as verified local acquisition evidence.
func (s *Store) PublicDiscoveryExists(ctx context.Context, peerID, publicPath, sha256 string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM public_discoveries
		WHERE peer_id=? AND path=? AND sha256=? LIMIT 1`,
		peerID, publicPath, sha256).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check public discovery: %w", err)
	}
	return true, nil
}
