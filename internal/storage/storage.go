// Package storage owns the SQLite business database.
//
// G1 uses modernc.org/sqlite (pure Go, CGO_ENABLED=0) and a single writer
// connection with WAL enabled. It stores chat message/ACK state and a small
// optional known-peer cache; the go-libp2p PeerStore remains the runtime
// address source of truth and is not duplicated here.
package storage

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go database/sql driver
)

const (
	// FileName is the SQLite database inside the data directory.
	FileName            = "raminga.db"
	schemaVersion       = 8
	defaultCacheEntries = 512
	defaultMaxFriends   = 10000
)

// Message origin values. Provenance is a local operator model, not a
// cryptographic identity: every holder of the local API token can claim it.
const (
	OriginHuman   = "human"
	OriginAgent   = "agent"
	OriginUnknown = "unknown"
)

// Message delivery states. Acked means the receiving node accepted the
// protocol message; it never means a human read it.
const (
	DeliveryPending   = "pending"
	DeliveryAcked     = "acked"
	DeliveryFailed    = "failed"
	DeliveryCancelled = "cancelled"
	DeliveryUnknown   = "unknown"
	DeliveryReceived  = "received"
)

// ErrInvalidCursor reports a malformed or stale pagination cursor.
var ErrInvalidCursor = errors.New("storage: invalid cursor")

// Message is one persisted chat message.
type Message struct {
	MessageID         string
	PeerID            string
	Direction         string // "in" or "out"
	Text              string
	Acked             bool
	CreatedAtMS       int64
	AckedAtMS         int64
	Origin            string
	DeliveryStatus    string
	DeliveryError     string
	DeliveryUpdatedMS int64
	ClientRequestID   string
}

// ConversationSummary is one Peer's latest retained message.
type ConversationSummary struct {
	PeerID         string
	LastMessageID  string
	Direction      string
	Preview        string
	LastAtMS       int64
	DeliveryStatus string
	Origin         string
	MessageCount   int
}

// HumanOutboundPeer is a stage-6 "has human outbound" relation. It is updated
// when a human send is accepted and persisted, and is not pruned with messages.
type HumanOutboundPeer struct {
	PeerID    string
	FirstAtMS int64
	LastAtMS  int64
	// RowID and SnapshotRowID are opaque paging positions. They are not exposed
	// by the API but keep a snapshot complete while last_at_ms changes.
	RowID         int64
	SnapshotRowID int64
}

// MessageRetention is the currently retained bounded history.
type MessageRetention struct {
	RetainedMessages int
	OldestAtMS       int64
	MaxMessages      int
}

// MessageCursor is the stable keyset position (created_at_ms, message_id) for
// one Peer's message history. message_id breaks ties for equal timestamps.
type MessageCursor struct {
	CreatedAtMS int64
	MessageID   string
}

// ConversationCursor is the stable keyset position (last_at_ms, peer_id) for
// conversation summaries.
type ConversationCursor struct {
	LastAtMS      int64
	PeerID        string
	SnapshotRowID int64
	// RowID is an immutable rowid position for the human-relation snapshot.
	// last_at_ms changes on every new human send, so ordering by it while a
	// client pages would skip rows that moved across the boundary.
	RowID int64
}

type cursorEnvelope struct {
	V    int    `json:"v"`
	At   int64  `json:"at"`
	ID   string `json:"id"`
	Snap int64  `json:"snap,omitempty"`
	// Row is the stable rowid position used by relation snapshots. It is
	// separate from Snap so existing conversation cursors keep their meaning.
	Row int64 `json:"row,omitempty"`
}

// EncodeMessageCursor serializes a position without relying on rowids, which
// are not stable across pruning and vacuum.
func EncodeMessageCursor(c MessageCursor) string {
	raw, _ := json.Marshal(cursorEnvelope{V: 1, At: c.CreatedAtMS, ID: c.MessageID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeMessageCursor validates an opaque cursor from a previous response.
func DecodeMessageCursor(raw string) (MessageCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return MessageCursor{}, nil
	}
	env, err := decodeCursor(raw)
	if err != nil {
		return MessageCursor{}, err
	}
	if env.ID == "" || len(env.ID) > 128 {
		return MessageCursor{}, ErrInvalidCursor
	}
	return MessageCursor{CreatedAtMS: env.At, MessageID: env.ID}, nil
}

func EncodeConversationCursor(c ConversationCursor) string {
	raw, _ := json.Marshal(cursorEnvelope{V: 1, At: c.LastAtMS, ID: c.PeerID, Snap: c.SnapshotRowID, Row: c.RowID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func DecodeConversationCursor(raw string) (ConversationCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return ConversationCursor{}, nil
	}
	env, err := decodeCursor(raw)
	if err != nil {
		return ConversationCursor{}, err
	}
	if env.ID == "" || len(env.ID) > 128 {
		return ConversationCursor{}, ErrInvalidCursor
	}
	if env.Row < 0 || env.Snap < 0 || (env.Row > 0 && env.Snap < env.Row) {
		return ConversationCursor{}, ErrInvalidCursor
	}
	return ConversationCursor{LastAtMS: env.At, PeerID: env.ID, SnapshotRowID: env.Snap, RowID: env.Row}, nil
}

func decodeCursor(raw string) (cursorEnvelope, error) {
	if strings.TrimSpace(raw) == "" {
		return cursorEnvelope{}, nil
	}
	if len(raw) > 512 {
		return cursorEnvelope{}, ErrInvalidCursor
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cursorEnvelope{}, ErrInvalidCursor
	}
	var env cursorEnvelope
	if err := json.Unmarshal(data, &env); err != nil || env.V != 1 || env.At < 0 {
		return cursorEnvelope{}, ErrInvalidCursor
	}
	return env, nil
}

// KnownPeer is one bounded SQLite peer-cache row. It is a restart hint for
// the in-memory go-libp2p PeerStore, never an online-state claim. Sources are
// bootstrap, known, pinned and manual.
type KnownPeer struct {
	PeerID      string
	Addrs       []string
	Source      string
	UpdatedAtMS int64
	ExpiresAtMS int64
}

// ErrOutboxFull reports that the bounded outbox would exceed its entry or byte
// budget. The caller must not claim the message was stored.
var ErrOutboxFull = errors.New("storage: outbox is full")

// ErrOutboxNotFound reports an unknown outbox entry.
var ErrOutboxNotFound = errors.New("storage: outbox entry not found")

// OutboxEntry is one durable outbound message awaiting a real ACK.
type OutboxEntry struct {
	MessageID     string
	PeerID        string
	Text          string
	Multiaddr     string
	Status        string // pending, acked, failed, cancelled
	Attempts      int
	Bytes         int
	LastError     string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	NextAttemptAt time.Time
	UpdatedAt     time.Time
}

// OutboxStats is the bounded outbox accounting view.
type OutboxStats struct {
	Pending      int
	Acked        int
	Failed       int
	Cancelled    int
	PendingBytes int64
}

// Peer cache source values. Higher-priority sources are preserved when a
// lower-priority source refreshes the same peer.
const (
	PeerSourceDHT       = "dht"
	PeerSourceKnown     = "known"
	PeerSourceManual    = "manual"
	PeerSourceBootstrap = "bootstrap"
	PeerSourcePinned    = "pinned"
)

// Store is the SQLite handle.
type Store struct {
	db          *sql.DB
	path        string
	maxMessages int
	maxFriends  int
	now         func() time.Time
}

// SetMaxMessages bounds the messages table. Oldest rows (by created_at_ms, then
// rowid) are pruned in the same transaction as each insert. Zero disables the
// bound and is only for tests/diagnostics, never for a daemon.
func (s *Store) SetMaxMessages(max int) {
	if max < 0 {
		max = 0
	}
	s.maxMessages = max
}

// Open opens <dataDir>/raminga.db, applies pragmas and migrations.
func Open(ctx context.Context, dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	path := filepath.Join(dataDir, FileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	closeOnErr := func(err error) (*Store, error) {
		_ = db.Close()
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		return closeOnErr(fmt.Errorf("ping sqlite %q: %w", path, err))
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
		// Bound the WAL to ~1 MiB (256 pages) so message pruning cannot leave a
		// multi-megabyte WAL on disk between SQLite auto-checkpoints.
		"PRAGMA wal_autocheckpoint=256",
	} {
		if _, err := db.ExecContext(ctx, pragma); err != nil {
			return closeOnErr(fmt.Errorf("apply %s: %w", pragma, err))
		}
	}
	if err := migrate(ctx, db); err != nil {
		return closeOnErr(fmt.Errorf("migrate sqlite: %w", err))
	}
	return &Store{db: db, path: path, maxFriends: defaultMaxFriends, now: time.Now}, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at_ms INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
			message_id TEXT PRIMARY KEY,
			peer_id TEXT NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('in','out')),
			text TEXT NOT NULL,
			acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0,1)),
			created_at_ms INTEGER NOT NULL,
			acked_at_ms INTEGER NOT NULL DEFAULT 0,
			origin TEXT NOT NULL DEFAULT 'unknown',
			delivery_status TEXT NOT NULL DEFAULT 'unknown',
			delivery_error TEXT NOT NULL DEFAULT '',
			delivery_updated_at_ms INTEGER NOT NULL DEFAULT 0,
			client_request_id TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at_ms DESC)`,
		`CREATE INDEX IF NOT EXISTS messages_created_id_idx ON messages (created_at_ms DESC, message_id DESC)`,
		`CREATE INDEX IF NOT EXISTS messages_peer_created_idx ON messages (peer_id, created_at_ms DESC, message_id DESC)`,
		`CREATE TABLE IF NOT EXISTS human_outbound_peers (
			peer_id TEXT PRIMARY KEY,
			first_at_ms INTEGER NOT NULL,
			last_at_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS human_outbound_peers_last_idx ON human_outbound_peers (last_at_ms DESC, peer_id DESC)`,
		`CREATE TABLE IF NOT EXISTS public_discoveries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_id TEXT NOT NULL,
			path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size_bytes INTEGER NOT NULL,
			fetched_at_ms INTEGER NOT NULL,
			source TEXT NOT NULL,
			UNIQUE(peer_id, path, sha256)
		)`,
		`CREATE INDEX IF NOT EXISTS public_discoveries_fetched_idx ON public_discoveries (fetched_at_ms DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS public_discoveries_peer_idx ON public_discoveries (peer_id)`,
		`CREATE TABLE IF NOT EXISTS known_peers (
			peer_id TEXT PRIMARY KEY,
			addrs_json TEXT NOT NULL,
			source TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS outbox (
			message_id TEXT PRIMARY KEY,
			peer_id TEXT NOT NULL,
			text TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			multiaddr TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL CHECK (status IN ('pending','acked','failed','cancelled')),
			attempts INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, next_attempt_at_ms)`,
		`DROP TABLE IF EXISTS peer_names`,
		`CREATE TABLE IF NOT EXISTS friends (
			peer_id TEXT PRIMARY KEY,
			name TEXT NOT NULL DEFAULT '',
			addrs_json TEXT NOT NULL DEFAULT '[]',
			description TEXT NOT NULL DEFAULT '',
			manually_connected INTEGER NOT NULL DEFAULT 0 CHECK (manually_connected IN (0,1)),
			first_seen_ms INTEGER NOT NULL,
			last_interaction_ms INTEGER NOT NULL,
			relay_capable INTEGER NOT NULL DEFAULT 0,
			dht_capable INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS friends_name_unique ON friends(name) WHERE name <> ''`,
		`CREATE TABLE IF NOT EXISTS paused_peers (
			peer_id TEXT PRIMARY KEY,
			paused_at_ms INTEGER NOT NULL
		)`,
	}
	for _, stmt := range stmts {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("exec schema statement: %w", err)
		}
	}
	// Add columns introduced after G1 without rebuilding the database. Older
	// messages intentionally keep origin=unknown and delivery_status=unknown
	// until the versioned backfill below can inspect the old outbox.
	if err := ensureColumn(ctx, tx, "known_peers", "expires_at_ms", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, tx, "friends", "relay_capable", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, tx, "friends", "dht_capable", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	for _, column := range []struct{ name, decl string }{
		{"origin", "TEXT NOT NULL DEFAULT 'unknown'"},
		{"delivery_status", "TEXT NOT NULL DEFAULT 'unknown'"},
		{"delivery_error", "TEXT NOT NULL DEFAULT ''"},
		{"delivery_updated_at_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"client_request_id", "TEXT NOT NULL DEFAULT ''"},
	} {
		if err := ensureColumn(ctx, tx, "messages", column.name, column.decl); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`CREATE UNIQUE INDEX IF NOT EXISTS messages_request_unique ON messages (peer_id, client_request_id) WHERE client_request_id <> ''`); err != nil {
		return fmt.Errorf("create message request index: %w", err)
	}
	var applied int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&applied); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if applied < 7 {
		// v7 provenance/delivery backfill. Old outbound rows are NOT presented
		// as pending merely because acked=0: only a surviving pending outbox
		// row is evidence for that. Everything else is failed/cancelled/acked
		// if the old outbox proves it, and unknown otherwise.
		if _, err := tx.ExecContext(ctx, `
			UPDATE messages SET
				delivery_status = CASE
					WHEN direction = 'in' THEN 'received'
					WHEN acked = 1 THEN 'acked'
					WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = messages.message_id AND o.status = 'pending') THEN 'pending'
					WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = messages.message_id AND o.status = 'acked') THEN 'acked'
					WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = messages.message_id AND o.status = 'failed') THEN 'failed'
					WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = messages.message_id AND o.status = 'cancelled') THEN 'cancelled'
					ELSE 'unknown'
				END,
				delivery_error = COALESCE((
					SELECT o.last_error FROM outbox o
					WHERE o.message_id = messages.message_id AND o.status IN ('pending','failed','cancelled')
					ORDER BY o.updated_at_ms DESC LIMIT 1
				), ''),
				delivery_updated_at_ms = CASE
					WHEN acked = 1 THEN acked_at_ms
					ELSE COALESCE((
						SELECT o.updated_at_ms FROM outbox o
						WHERE o.message_id = messages.message_id
						ORDER BY o.updated_at_ms DESC LIMIT 1
					), 0)
				END,
				origin = 'unknown'
			WHERE origin = 'unknown' AND delivery_status = 'unknown'`); err != nil {
			return fmt.Errorf("backfill message provenance/delivery: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)`,
		schemaVersion, time.Now().UnixMilli(),
	); err != nil {
		return fmt.Errorf("record schema version: %w", err)
	}
	return tx.Commit()
}

func ensureColumn(ctx context.Context, tx *sql.Tx, table, column, decl string) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return fmt.Errorf("inspect table %s: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return fmt.Errorf("scan table %s: %w", table, err)
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate table %s: %w", table, err)
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE `+table+` ADD COLUMN `+column+` `+decl); err != nil {
		return fmt.Errorf("add %s.%s: %w", table, column, err)
	}
	return nil
}

// Path returns the database path.
func (s *Store) Path() string { return s.path }

// DB exposes the underlying handle for tests and diagnostics. Callers must not
// open a second competing address/state source with it.
func (s *Store) DB() *sql.DB { return s.db }

// Close closes the database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// SaveOutbound persists an outbound message before it is sent, with acked=0.
// It is a legacy diagnostic path without a durable outbox entry, so its
// delivery state is unknown rather than an unprovable "pending".
func (s *Store) SaveOutbound(ctx context.Context, messageID, peerID, text string, createdAt time.Time) error {
	return s.SaveOutboundOrigin(ctx, messageID, peerID, text, createdAt, OriginUnknown, "")
}

// SaveOutboundOrigin persists one outbound row without an outbox entry.
func (s *Store) SaveOutboundOrigin(ctx context.Context, messageID, peerID, text string, createdAt time.Time, origin, requestID string) error {
	if messageID == "" || peerID == "" {
		return errors.New("storage: message ID and peer ID are required")
	}
	if err := validateOrigin(origin); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbound message: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO messages
		 (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
		  origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
		 VALUES (?, ?, 'out', ?, 0, ?, 0, ?, 'unknown', '', 0, ?)
		 ON CONFLICT(message_id) DO NOTHING`,
		messageID, peerID, text, createdAt.UnixMilli(), origin, requestID); err != nil {
		return fmt.Errorf("save outbound message: %w", err)
	}
	if err := s.pruneMessagesTx(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbound message: %w", err)
	}
	return nil
}

// MarkAcked records a matching ACK for messageID and its persisted delivery
// state. ACK means protocol acceptance, not that a human read the message.
func (s *Store) MarkAcked(ctx context.Context, messageID string, ackedAt time.Time) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE messages SET acked=1, acked_at_ms=?,
		 delivery_status='acked', delivery_error='', delivery_updated_at_ms=?
		 WHERE message_id=?`,
		ackedAt.UnixMilli(), ackedAt.UnixMilli(), messageID)
	if err != nil {
		return fmt.Errorf("mark message acked: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("mark message acked: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("mark message acked: unknown message %q", messageID)
	}
	return nil
}

// SaveInbound stores an inbound message. It returns false when messageID was
// already stored, which makes duplicate delivery harmless. An inbound row is
// "received"; its remote human/agent provenance is not authenticated and stays
// unknown.
func (s *Store) SaveInbound(ctx context.Context, messageID, peerID, text string, createdAt time.Time) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin inbound message: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
		`INSERT INTO messages
		 (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
		  origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
		 VALUES (?, ?, 'in', ?, 1, ?, 0, 'unknown', 'received', '', 0, '')
		 ON CONFLICT(message_id) DO NOTHING`,
		messageID, peerID, text, createdAt.UnixMilli())
	if err != nil {
		return false, fmt.Errorf("save inbound message: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("save inbound message: %w", err)
	}
	if err := s.pruneMessagesTx(ctx, tx); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit inbound message: %w", err)
	}
	return n == 1, nil
}

// pruneMessagesTx deletes the oldest rows beyond maxMessages. It is a hard
// bound (not a periodic best-effort), so a flood cannot grow the table past the
// configured cap between inserts. The human_outbound_peers relation is
// deliberately not pruned: it records accepted human sends, not message text.
func (s *Store) pruneMessagesTx(ctx context.Context, tx *sql.Tx) error {
	if s.maxMessages <= 0 {
		return nil
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		return fmt.Errorf("count messages: %w", err)
	}
	if count <= s.maxMessages {
		return nil
	}
	over := count - s.maxMessages
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM messages WHERE rowid IN (
		   SELECT rowid FROM messages ORDER BY created_at_ms ASC, rowid ASC LIMIT ?
		 )`, over); err != nil {
		return fmt.Errorf("prune %d old messages: %w", over, err)
	}
	return nil
}

// CountMessages returns the persisted message row count (diagnostics/tests).
func (s *Store) CountMessages(ctx context.Context) (int, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count messages: %w", err)
	}
	return count, nil
}

// MessageRetention returns the currently retained range and hard cap.
func (s *Store) MessageRetention(ctx context.Context) (MessageRetention, error) {
	var (
		count  int
		oldest sql.NullInt64
	)
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), MIN(created_at_ms) FROM messages`).Scan(&count, &oldest); err != nil {
		return MessageRetention{}, fmt.Errorf("measure message retention: %w", err)
	}
	return MessageRetention{RetainedMessages: count, OldestAtMS: oldest.Int64, MaxMessages: s.maxMessages}, nil
}

const messageColumns = `message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
	origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id`

func scanMessage(row interface{ Scan(dest ...any) error }) (Message, error) {
	var m Message
	if err := row.Scan(&m.MessageID, &m.PeerID, &m.Direction, &m.Text, &m.Acked, &m.CreatedAtMS, &m.AckedAtMS,
		&m.Origin, &m.DeliveryStatus, &m.DeliveryError, &m.DeliveryUpdatedMS, &m.ClientRequestID); err != nil {
		return Message{}, err
	}
	return m, nil
}

// GetMessage returns one persisted message, if the row is still retained.
func (s *Store) GetMessage(ctx context.Context, messageID string) (Message, bool, error) {
	if messageID == "" {
		return Message{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE message_id=?`, messageID)
	m, err := scanMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	if err != nil {
		return Message{}, false, fmt.Errorf("get message: %w", err)
	}
	return m, true, nil
}

// GetMessageByRequest returns a message created with one idempotency key for
// peerID. It is used to reconcile a timed-out send without creating another.
func (s *Store) GetMessageByRequest(ctx context.Context, peerID, requestID string) (Message, bool, error) {
	if peerID == "" || requestID == "" {
		return Message{}, false, nil
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT `+messageColumns+` FROM messages
		 WHERE peer_id=? AND client_request_id=?
		 ORDER BY created_at_ms DESC, message_id DESC LIMIT 1`, peerID, requestID)
	m, err := scanMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	if err != nil {
		return Message{}, false, fmt.Errorf("get message by request: %w", err)
	}
	return m, true, nil
}

// RecentMessages returns the newest messages first.
func (s *Store) RecentMessages(ctx context.Context, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+messageColumns+` FROM messages ORDER BY created_at_ms DESC, message_id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("query recent messages: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Message
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages: %w", err)
	}
	return out, nil
}

// ListMessages returns one Peer's retained messages newest first and whether
// more older rows exist. The keyset cursor is stable across inserts, equal
// timestamps and pruning; it never uses rowid.
func (s *Store) ListMessages(ctx context.Context, peerID string, before MessageCursor, limit int) ([]Message, bool, error) {
	if peerID == "" {
		return nil, false, errors.New("storage: peer ID is required")
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := `SELECT ` + messageColumns + ` FROM messages WHERE peer_id=?`
	args := []any{peerID}
	if before.MessageID != "" {
		query += ` AND (created_at_ms < ? OR (created_at_ms = ? AND message_id < ?))`
		args = append(args, before.CreatedAtMS, before.CreatedAtMS, before.MessageID)
	}
	query += ` ORDER BY created_at_ms DESC, message_id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, fmt.Errorf("query messages: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]Message, 0, limit)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, false, fmt.Errorf("scan message: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate messages: %w", err)
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, nil
}

// ListConversations returns one summary per Peer, newest first.
func (s *Store) ListConversations(ctx context.Context, before ConversationCursor, limit int) ([]ConversationSummary, bool, int64, error) {
	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}
	snapshot := before.SnapshotRowID
	if snapshot <= 0 {
		if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(rowid), 0) FROM messages`).Scan(&snapshot); err != nil {
			return nil, false, 0, fmt.Errorf("snapshot conversations: %w", err)
		}
	}
	query := `WITH ranked AS (
		SELECT message_id, peer_id, direction, text, created_at_ms, delivery_status, origin,
		       ROW_NUMBER() OVER (PARTITION BY peer_id ORDER BY created_at_ms DESC, message_id DESC) AS rn,
		       COUNT(*) OVER (PARTITION BY peer_id) AS message_count
		FROM messages WHERE rowid <= ?
	)
	SELECT peer_id, message_id, direction, text, created_at_ms, delivery_status, origin, message_count
	FROM ranked WHERE rn = 1`
	args := []any{snapshot}
	if before.PeerID != "" {
		query += ` AND (created_at_ms < ? OR (created_at_ms = ? AND peer_id < ?))`
		args = append(args, before.LastAtMS, before.LastAtMS, before.PeerID)
	}
	query += ` ORDER BY created_at_ms DESC, peer_id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, 0, fmt.Errorf("query conversations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]ConversationSummary, 0, limit)
	for rows.Next() {
		var c ConversationSummary
		if err := rows.Scan(&c.PeerID, &c.LastMessageID, &c.Direction, &c.Preview, &c.LastAtMS,
			&c.DeliveryStatus, &c.Origin, &c.MessageCount); err != nil {
			return nil, false, 0, fmt.Errorf("scan conversation: %w", err)
		}
		c.Preview = truncatePreview(c.Preview, 240)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, false, 0, fmt.Errorf("iterate conversations: %w", err)
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, snapshot, nil
}

// ListHumanOutboundPeers returns the durable stage-6 relation as a stable
// rowid snapshot. The first page pins MAX(rowid); later pages walk strictly
// older rowids. A human send that updates last_at_ms between pages therefore
// cannot move an unseen row across the cursor and silently omit it.
//
// For compatibility with a cursor minted by the stage-5 last_at ordering, a
// cursor without RowID falls back to that legacy order.
func (s *Store) ListHumanOutboundPeers(ctx context.Context, before ConversationCursor, limit int) ([]HumanOutboundPeer, bool, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var (
		rows     *sql.Rows
		err      error
		snapshot = before.SnapshotRowID
	)
	if before.PeerID != "" && before.RowID == 0 {
		rows, err = s.db.QueryContext(ctx,
			`SELECT peer_id, first_at_ms, last_at_ms, rowid FROM human_outbound_peers
			 WHERE (last_at_ms < ? OR (last_at_ms = ? AND peer_id < ?))
			 ORDER BY last_at_ms DESC, peer_id DESC LIMIT ?`,
			before.LastAtMS, before.LastAtMS, before.PeerID, limit+1)
	} else {
		if snapshot == 0 {
			if err := s.db.QueryRowContext(ctx,
				`SELECT COALESCE(MAX(rowid), 0) FROM human_outbound_peers`).Scan(&snapshot); err != nil {
				return nil, false, fmt.Errorf("snapshot human outbound peers: %w", err)
			}
		}
		if before.RowID > 0 {
			rows, err = s.db.QueryContext(ctx,
				`SELECT peer_id, first_at_ms, last_at_ms, rowid FROM human_outbound_peers
				 WHERE rowid <= ? AND rowid < ?
				 ORDER BY rowid DESC LIMIT ?`,
				snapshot, before.RowID, limit+1)
		} else {
			rows, err = s.db.QueryContext(ctx,
				`SELECT peer_id, first_at_ms, last_at_ms, rowid FROM human_outbound_peers
				 WHERE rowid <= ?
				 ORDER BY rowid DESC LIMIT ?`,
				snapshot, limit+1)
		}
	}
	if err != nil {
		return nil, false, fmt.Errorf("query human outbound peers: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]HumanOutboundPeer, 0, limit)
	for rows.Next() {
		var p HumanOutboundPeer
		if err := rows.Scan(&p.PeerID, &p.FirstAtMS, &p.LastAtMS, &p.RowID); err != nil {
			return nil, false, fmt.Errorf("scan human outbound peer: %w", err)
		}
		p.SnapshotRowID = before.SnapshotRowID
		if p.SnapshotRowID == 0 {
			p.SnapshotRowID = p.RowID
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate human outbound peers: %w", err)
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	if snapshot == 0 && len(out) > 0 {
		snapshot = out[0].RowID
	}
	for i := range out {
		out[i].SnapshotRowID = snapshot
	}
	return out, hasMore, nil
}

func truncatePreview(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max]) + "…"
}

func validateOrigin(origin string) error {
	switch origin {
	case OriginHuman, OriginAgent, OriginUnknown, "":
		return nil
	default:
		return fmt.Errorf("storage: invalid message origin %q", origin)
	}
}

// UpsertKnownPeer writes a bounded peer-cache hint with the default TTL.
func (s *Store) UpsertKnownPeer(ctx context.Context, peerID string, addrs []string, source string) error {
	return s.UpsertPeerCache(ctx, peerID, addrs, source, 30*24*time.Hour, defaultCacheEntries)
}

// UpsertPeerCache merges addrs into the peer's cache entry, preserves valid
// existing addresses instead of truncating them, and prunes expired/over-cap
// rows. It is a hint cache only; callers must not treat it as online state.
func (s *Store) UpsertPeerCache(ctx context.Context, peerID string, addrs []string, source string, ttl time.Duration, maxEntries int) error {
	if peerID == "" {
		return errors.New("storage: peer ID is required")
	}
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	if maxEntries <= 0 {
		maxEntries = defaultCacheEntries
	}
	now := time.Now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin peer cache update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		existingJSON string
		existingExp  int64
		existingSrc  string
	)
	err = tx.QueryRowContext(ctx,
		`SELECT addrs_json, expires_at_ms, source FROM known_peers WHERE peer_id=?`, peerID).
		Scan(&existingJSON, &existingExp, &existingSrc)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read peer cache: %w", err)
	}
	merged := dedupeAddrs(addrs)
	if err == nil && existingExp > now.UnixMilli() {
		var old []string
		if jsonErr := json.Unmarshal([]byte(existingJSON), &old); jsonErr == nil {
			merged = dedupeAddrs(append(merged, old...))
		}
		if sourcePriority(existingSrc) > sourcePriority(source) {
			source = existingSrc
		}
	}
	raw, err := json.Marshal(merged)
	if err != nil {
		return fmt.Errorf("encode peer addrs: %w", err)
	}
	expires := now.Add(ttl).UnixMilli()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO known_peers (peer_id, addrs_json, source, updated_at_ms, expires_at_ms)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(peer_id) DO UPDATE SET
		   addrs_json=excluded.addrs_json,
		   source=excluded.source,
		   updated_at_ms=excluded.updated_at_ms,
		   expires_at_ms=excluded.expires_at_ms`,
		peerID, string(raw), source, now.UnixMilli(), expires); err != nil {
		return fmt.Errorf("upsert peer cache: %w", err)
	}
	if err := prunePeerCacheTx(ctx, tx, now.UnixMilli(), maxEntries); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit peer cache update: %w", err)
	}
	return nil
}

func sourcePriority(source string) int {
	switch source {
	case PeerSourcePinned:
		return 4
	case PeerSourceBootstrap:
		return 3
	case PeerSourceManual:
		return 2
	case PeerSourceKnown:
		return 1
	default:
		return 0
	}
}

func dedupeAddrs(addrs []string) []string {
	seen := make(map[string]struct{}, len(addrs))
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		if addr == "" {
			continue
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr)
	}
	return out
}

func prunePeerCacheTx(ctx context.Context, tx *sql.Tx, nowMS int64, maxEntries int) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM known_peers WHERE expires_at_ms > 0 AND expires_at_ms <= ?`, nowMS); err != nil {
		return fmt.Errorf("prune expired peer cache: %w", err)
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM known_peers`).Scan(&count); err != nil {
		return fmt.Errorf("count peer cache: %w", err)
	}
	if count <= maxEntries {
		return nil
	}
	over := count - maxEntries
	rows, err := tx.QueryContext(ctx,
		`SELECT peer_id FROM known_peers ORDER BY updated_at_ms ASC, peer_id ASC LIMIT ?`, over)
	if err != nil {
		return fmt.Errorf("select over-cap peer cache: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan over-cap peer cache: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close over-cap peer cache rows: %w", err)
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `DELETE FROM known_peers WHERE peer_id=?`, id); err != nil {
			return fmt.Errorf("delete over-cap peer cache row: %w", err)
		}
	}
	return nil
}

// ListKnownPeers returns all cache rows (including expired hints; callers that
// need only valid hints should filter on ExpiresAtMS). The in-memory PeerStore
// remains the runtime source of truth.
func (s *Store) ListKnownPeers(ctx context.Context) ([]KnownPeer, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT peer_id, addrs_json, source, updated_at_ms, expires_at_ms
		 FROM known_peers ORDER BY peer_id`)
	if err != nil {
		return nil, fmt.Errorf("query known peers: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []KnownPeer
	for rows.Next() {
		var (
			p   KnownPeer
			raw string
		)
		if err := rows.Scan(&p.PeerID, &raw, &p.Source, &p.UpdatedAtMS, &p.ExpiresAtMS); err != nil {
			return nil, fmt.Errorf("scan known peer: %w", err)
		}
		if err := json.Unmarshal([]byte(raw), &p.Addrs); err != nil {
			return nil, fmt.Errorf("decode known peer addrs: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate known peers: %w", err)
	}
	return out, nil
}

// CountPeerCache returns the number of cache rows.
func (s *Store) CountPeerCache(ctx context.Context) (int, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM known_peers`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count peer cache: %w", err)
	}
	return count, nil
}

// DeletePeerCache removes one hint (used by tests/diagnostics).
func (s *Store) DeletePeerCache(ctx context.Context, peerID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM known_peers WHERE peer_id=?`, peerID); err != nil {
		return fmt.Errorf("delete peer cache: %w", err)
	}
	return nil
}

// SaveOutboundWithOutbox persists one outbound message and its durable outbox
// entry in a single transaction. Capacity is checked before insert, so a full
// outbox returns ErrOutboxFull without creating a misleading history row.
func (s *Store) SaveOutboundWithOutbox(ctx context.Context, messageID, peerID, text, multiaddr string, createdAt, expiresAt time.Time, maxEntries int, maxBytes int64) error {
	return s.SaveOutboundWithOutboxOrigin(ctx, messageID, peerID, text, multiaddr, createdAt, expiresAt, maxEntries, maxBytes, OriginUnknown, "")
}

// SaveOutboundWithOutboxOrigin is SaveOutboundWithOutbox with explicit local
// provenance and an optional idempotency key. A human send records the durable
// human_outbound_peers relation in the same transaction that persists the
// message, so later pruning of message rows cannot erase the relationship.
func (s *Store) SaveOutboundWithOutboxOrigin(ctx context.Context, messageID, peerID, text, multiaddr string, createdAt, expiresAt time.Time, maxEntries int, maxBytes int64, origin, requestID string) error {
	if messageID == "" || peerID == "" {
		return errors.New("storage: message ID and peer ID are required")
	}
	if err := validateOrigin(origin); err != nil {
		return err
	}
	if origin == "" {
		origin = OriginUnknown
	}
	now := time.Now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbound outbox: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := expireOutboxTx(ctx, tx, now); err != nil {
		return err
	}
	if err := pruneTerminalOutboxTx(ctx, tx, maxEntries); err != nil {
		return err
	}
	var pendingCount int
	var pendingBytes int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM outbox WHERE status='pending'`).
		Scan(&pendingCount, &pendingBytes); err != nil {
		return fmt.Errorf("measure outbox: %w", err)
	}
	if maxEntries > 0 && pendingCount >= maxEntries {
		return fmt.Errorf("%w: %d pending entries >= %d", ErrOutboxFull, pendingCount, maxEntries)
	}
	if maxBytes > 0 && pendingBytes+int64(len(text)) > maxBytes {
		return fmt.Errorf("%w: %d pending bytes + %d > %d", ErrOutboxFull, pendingBytes, len(text), maxBytes)
	}

	res, err := tx.ExecContext(ctx,
		`INSERT INTO messages
		 (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
		  origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
		 VALUES (?, ?, 'out', ?, 0, ?, 0, ?, 'pending', '', ?, ?)
		 ON CONFLICT(message_id) DO NOTHING`,
		messageID, peerID, text, createdAt.UnixMilli(), origin, now.UnixMilli(), requestID)
	if err != nil {
		return fmt.Errorf("save outbound message: %w", err)
	}
	if inserted, _ := res.RowsAffected(); inserted == 0 {
		// The caller normally checks by message ID first. A concurrent retry
		// must not insert a second outbox row with different text.
		return fmt.Errorf("storage: message %q already exists", messageID)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO outbox
		 (message_id, peer_id, text, bytes, multiaddr, status, attempts, created_at_ms, expires_at_ms, next_attempt_at_ms, last_error, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, 0, '', ?)`,
		messageID, peerID, text, len(text), multiaddr, createdAt.UnixMilli(), expiresAt.UnixMilli(), now.UnixMilli()); err != nil {
		return fmt.Errorf("enqueue outbox: %w", err)
	}
	if origin == OriginHuman {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms)
			 VALUES (?, ?, ?)
			 ON CONFLICT(peer_id) DO UPDATE SET
			   first_at_ms=MIN(human_outbound_peers.first_at_ms, excluded.first_at_ms),
			   last_at_ms=MAX(human_outbound_peers.last_at_ms, excluded.last_at_ms)`,
			peerID, createdAt.UnixMilli(), createdAt.UnixMilli()); err != nil {
			return fmt.Errorf("record human outbound relation: %w", err)
		}
	}
	if err := s.pruneMessagesTx(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbound outbox: %w", err)
	}
	return nil
}

// DueOutbox returns pending entries whose retry time and expiry are in range.
func (s *Store) DueOutbox(ctx context.Context, now time.Time, limit int) ([]OutboxEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 64
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT message_id, peer_id, text, multiaddr, status, attempts, bytes, last_error,
		        created_at_ms, expires_at_ms, next_attempt_at_ms, updated_at_ms
		 FROM outbox
		 WHERE status='pending' AND next_attempt_at_ms <= ? AND expires_at_ms > ?
		 ORDER BY created_at_ms ASC, message_id ASC LIMIT ?`,
		now.UnixMilli(), now.UnixMilli(), limit)
	if err != nil {
		return nil, fmt.Errorf("query due outbox: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []OutboxEntry
	for rows.Next() {
		e, err := scanOutbox(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate due outbox: %w", err)
	}
	return out, nil
}

// ListOutbox returns newest-first outbox rows, including terminal states.
func (s *Store) ListOutbox(ctx context.Context, limit int) ([]OutboxEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT message_id, peer_id, text, multiaddr, status, attempts, bytes, last_error,
		        created_at_ms, expires_at_ms, next_attempt_at_ms, updated_at_ms
		 FROM outbox ORDER BY created_at_ms DESC, message_id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("query outbox: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []OutboxEntry
	for rows.Next() {
		e, err := scanOutbox(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate outbox: %w", err)
	}
	return out, nil
}

type outboxScanner interface {
	Scan(dest ...any) error
}

func scanOutbox(row outboxScanner) (OutboxEntry, error) {
	var (
		e                               OutboxEntry
		created, expires, next, updated int64
	)
	if err := row.Scan(&e.MessageID, &e.PeerID, &e.Text, &e.Multiaddr, &e.Status, &e.Attempts, &e.Bytes,
		&e.LastError, &created, &expires, &next, &updated); err != nil {
		return OutboxEntry{}, fmt.Errorf("scan outbox: %w", err)
	}
	e.CreatedAt = time.UnixMilli(created)
	e.ExpiresAt = time.UnixMilli(expires)
	if next > 0 {
		e.NextAttemptAt = time.UnixMilli(next)
	}
	e.UpdatedAt = time.UnixMilli(updated)
	return e, nil
}

// MarkOutboxDelivered records a real matching ACK for an outbox entry and the
// history row. A missing history row (pruned by the message bound) does not
// erase the outbox success.
func (s *Store) MarkOutboxDelivered(ctx context.Context, messageID string, ackedAt time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbox ack: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
		`UPDATE outbox SET status='acked', last_error='', updated_at_ms=? WHERE message_id=? AND status IN ('pending','acked')`,
		ackedAt.UnixMilli(), messageID)
	if err != nil {
		return fmt.Errorf("ack outbox: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrOutboxNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET acked=1, acked_at_ms=?,
		 delivery_status='acked', delivery_error='', delivery_updated_at_ms=?
		 WHERE message_id=?`, ackedAt.UnixMilli(), ackedAt.UnixMilli(), messageID); err != nil {
		return fmt.Errorf("ack outbox history: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbox ack: %w", err)
	}
	return nil
}

// RecordOutboxFailure persists the next exponential-backoff attempt and the
// real error. It never marks the entry acked; the history row stays pending so
// the UI can distinguish "queued/unknown" from protocol acceptance.
func (s *Store) RecordOutboxFailure(ctx context.Context, messageID string, attempts int, nextAttempt time.Time, reason string) error {
	if len(reason) > 512 {
		reason = reason[:512]
	}
	now := time.Now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbox failure: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`UPDATE outbox SET attempts=?, next_attempt_at_ms=?, last_error=?, updated_at_ms=?
		 WHERE message_id=? AND status='pending'`,
		attempts, nextAttempt.UnixMilli(), reason, now, messageID); err != nil {
		return fmt.Errorf("record outbox failure: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET delivery_status='pending', delivery_error=?, delivery_updated_at_ms=?
		 WHERE message_id=? AND delivery_status='pending'`, reason, now, messageID); err != nil {
		return fmt.Errorf("record message delivery error: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbox failure: %w", err)
	}
	return nil
}

// CancelOutbox cancels a pending entry and persists the cancelled delivery
// state on the history row. Terminal entries are not cancellable.
func (s *Store) CancelOutbox(ctx context.Context, messageID string) (bool, error) {
	now := time.Now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin outbox cancel: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
		`UPDATE outbox SET status='cancelled', last_error='cancelled by local user', updated_at_ms=?
		 WHERE message_id=? AND status='pending'`, now, messageID)
	if err != nil {
		return false, fmt.Errorf("cancel outbox: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		var status string
		err := tx.QueryRowContext(ctx, `SELECT status FROM outbox WHERE message_id=?`, messageID).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrOutboxNotFound
		}
		if err != nil {
			return false, fmt.Errorf("inspect outbox: %w", err)
		}
		return false, fmt.Errorf("storage: outbox entry %q is %s, not pending", messageID, status)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET delivery_status='cancelled', delivery_error='cancelled by local user',
		 delivery_updated_at_ms=? WHERE message_id=?`, now, messageID); err != nil {
		return false, fmt.Errorf("cancel message history: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit outbox cancel: %w", err)
	}
	return true, nil
}

// ExpireOutbox marks every overdue pending entry failed and persists that
// failed state on the retained history rows. It returns the count.
func (s *Store) ExpireOutbox(ctx context.Context, now time.Time) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin outbox expiry: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	n, err := expireOutboxTx(ctx, tx, now)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit outbox expiry: %w", err)
	}
	return n, nil
}

// OutboxStats returns bounded-outbox accounting.
func (s *Store) OutboxStats(ctx context.Context) (OutboxStats, error) {
	var st OutboxStats
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*), COALESCE(SUM(bytes),0) FROM outbox GROUP BY status`)
	if err != nil {
		return st, fmt.Errorf("query outbox stats: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var status string
		var count int
		var bytes int64
		if err := rows.Scan(&status, &count, &bytes); err != nil {
			return st, fmt.Errorf("scan outbox stats: %w", err)
		}
		switch status {
		case "pending":
			st.Pending = count
			st.PendingBytes = bytes
		case "acked":
			st.Acked = count
		case "failed":
			st.Failed = count
		case "cancelled":
			st.Cancelled = count
		}
	}
	return st, rows.Err()
}

func expireOutboxTx(ctx context.Context, tx *sql.Tx, now time.Time) (int, error) {
	var count int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM outbox WHERE status='pending' AND expires_at_ms <= ?`,
		now.UnixMilli()).Scan(&count); err != nil {
		return 0, fmt.Errorf("count expired outbox: %w", err)
	}
	if count == 0 {
		return 0, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET delivery_status='failed', delivery_error='expired before delivery', delivery_updated_at_ms=?
		 WHERE delivery_status='pending' AND message_id IN (
		   SELECT message_id FROM outbox WHERE status='pending' AND expires_at_ms <= ?
		 )`, now.UnixMilli(), now.UnixMilli()); err != nil {
		return 0, fmt.Errorf("expire message history: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE outbox SET status='failed', last_error='expired before delivery', updated_at_ms=?
		 WHERE status='pending' AND expires_at_ms <= ?`, now.UnixMilli(), now.UnixMilli()); err != nil {
		return 0, fmt.Errorf("expire outbox: %w", err)
	}
	return count, nil
}

func pruneTerminalOutboxTx(ctx context.Context, tx *sql.Tx, keep int) error {
	if keep <= 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM outbox WHERE status != 'pending' AND message_id NOT IN (
		   SELECT message_id FROM outbox WHERE status != 'pending'
		   ORDER BY updated_at_ms DESC, message_id DESC LIMIT ?
		 )`, keep); err != nil {
		return fmt.Errorf("prune terminal outbox: %w", err)
	}
	return nil
}

// FailOutbox marks a pending entry failed with an honest reason (for example a
// permanent policy rejection) and persists it on the history row. It never
// marks the message ACKed.
func (s *Store) FailOutbox(ctx context.Context, messageID, reason string) error {
	if len(reason) > 512 {
		reason = reason[:512]
	}
	now := time.Now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbox fail: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`UPDATE outbox SET status='failed', last_error=?, updated_at_ms=?
		 WHERE message_id=? AND status='pending'`, reason, now, messageID); err != nil {
		return fmt.Errorf("fail outbox: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET delivery_status='failed', delivery_error=?, delivery_updated_at_ms=?
		 WHERE message_id=? AND delivery_status IN ('pending','unknown')`, reason, now, messageID); err != nil {
		return fmt.Errorf("fail message history: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbox fail: %w", err)
	}
	return nil
}

// ResetOutboxPeer makes pending entries for one peer due immediately, used when
// that peer reconnects (fresh connectivity resets the backoff wait).
func (s *Store) ResetOutboxPeer(ctx context.Context, peerID string) error {
	if _, err := s.db.ExecContext(ctx,
		`UPDATE outbox SET next_attempt_at_ms=0
		 WHERE peer_id=? AND status='pending' AND expires_at_ms > ?`,
		peerID, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("reset outbox peer: %w", err)
	}
	return nil
}
