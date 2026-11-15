package storage

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// PublicDiscovery is one successful Agent content acquisition from a remote
// peer's public manifest. It is a private local index: the source path, SHA-256
// and fetch context are evidence, never a recommendation by themselves.
type PublicDiscovery struct {
	ID          int64
	PeerID      string
	Path        string
	SHA256      string
	SizeBytes   int64
	FetchedAtMS int64
	Source      string
}

// PublicDiscoveryPage is one keyset page of discovery evidence.
type PublicDiscoveryPage struct {
	Items      []PublicDiscovery
	NextBefore string
	HasMore    bool
}

type discoveryCursorEnvelope struct {
	V  int   `json:"v"`
	At int64 `json:"at"`
	ID int64 `json:"id"`
}

// EncodeDiscoveryCursor serializes the (fetched_at_ms, id) position.
func EncodeDiscoveryCursor(at, id int64) string {
	raw, _ := json.Marshal(discoveryCursorEnvelope{V: 1, At: at, ID: id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeDiscoveryCursor validates an opaque cursor produced by this package.
func DecodeDiscoveryCursor(raw string) (at, id int64, err error) {
	if strings.TrimSpace(raw) == "" {
		return 0, 0, nil
	}
	if len(raw) > 256 {
		return 0, 0, ErrInvalidCursor
	}
	data, decodeErr := base64.RawURLEncoding.DecodeString(raw)
	if decodeErr != nil {
		return 0, 0, ErrInvalidCursor
	}
	var env discoveryCursorEnvelope
	if json.Unmarshal(data, &env) != nil || env.V != 1 || env.At < 0 || env.ID < 0 {
		return 0, 0, ErrInvalidCursor
	}
	return env.At, env.ID, nil
}

// RecordPublicDiscovery stores one successful fetch. A re-download of the same
// version updates the observed time/source but does not create a duplicate;
// a changed SHA-256 is a new version and stays as a separate row.
func (s *Store) RecordPublicDiscovery(ctx context.Context, peerID, path, sha256 string, sizeBytes, fetchedAtMS int64, source string) (PublicDiscovery, error) {
	if fetchedAtMS <= 0 {
		return PublicDiscovery{}, errors.New("storage: discovery fetched_at must be positive")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO public_discoveries (peer_id, path, sha256, size_bytes, fetched_at_ms, source)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(peer_id, path, sha256) DO UPDATE SET
			fetched_at_ms = excluded.fetched_at_ms,
			source = excluded.source,
			size_bytes = excluded.size_bytes`,
		peerID, path, sha256, sizeBytes, fetchedAtMS, source)
	if err != nil {
		return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", err)
	}
	var row PublicDiscovery
	err = s.db.QueryRowContext(ctx, `
		SELECT id, peer_id, path, sha256, size_bytes, fetched_at_ms, source
		FROM public_discoveries WHERE peer_id = ? AND path = ? AND sha256 = ?`,
		peerID, path, sha256).Scan(&row.ID, &row.PeerID, &row.Path, &row.SHA256, &row.SizeBytes, &row.FetchedAtMS, &row.Source)
	if err != nil {
		return PublicDiscovery{}, fmt.Errorf("read recorded discovery: %w", err)
	}
	return row, nil
}

// ListPublicDiscoveries returns discovery evidence newest first. familiarOnly
// joins the durable human outbound relation, so the filter is applied to the
// whole content set rather than only the rows visible on one UI page.
func (s *Store) ListPublicDiscoveries(ctx context.Context, before string, limit int, familiarOnly bool) (PublicDiscoveryPage, error) {
	at, id, err := DecodeDiscoveryCursor(before)
	if err != nil {
		return PublicDiscoveryPage{}, err
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	query := `SELECT d.id, d.peer_id, d.path, d.sha256, d.size_bytes, d.fetched_at_ms, d.source
		FROM public_discoveries d`
	args := []any{}
	if familiarOnly {
		query += ` WHERE EXISTS (SELECT 1 FROM human_outbound_peers h WHERE h.peer_id = d.peer_id)`
		if before != "" {
			query += ` AND (d.fetched_at_ms < ? OR (d.fetched_at_ms = ? AND d.id < ?))`
			args = append(args, at, at, id)
		}
	} else if before != "" {
		query += ` WHERE (d.fetched_at_ms < ? OR (d.fetched_at_ms = ? AND d.id < ?))`
		args = append(args, at, at, id)
	}
	query += ` ORDER BY d.fetched_at_ms DESC, d.id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return PublicDiscoveryPage{}, fmt.Errorf("query public discoveries: %w", err)
	}
	defer func() { _ = rows.Close() }()
	page := PublicDiscoveryPage{Items: make([]PublicDiscovery, 0, limit)}
	for rows.Next() {
		var row PublicDiscovery
		if err := rows.Scan(&row.ID, &row.PeerID, &row.Path, &row.SHA256, &row.SizeBytes, &row.FetchedAtMS, &row.Source); err != nil {
			return PublicDiscoveryPage{}, fmt.Errorf("scan public discovery: %w", err)
		}
		page.Items = append(page.Items, row)
	}
	if err := rows.Err(); err != nil {
		return PublicDiscoveryPage{}, fmt.Errorf("iterate public discoveries: %w", err)
	}
	page.HasMore = len(page.Items) > limit
	if page.HasMore {
		page.Items = page.Items[:limit]
	}
	if page.HasMore && len(page.Items) > 0 {
		last := page.Items[len(page.Items)-1]
		page.NextBefore = EncodeDiscoveryCursor(last.FetchedAtMS, last.ID)
	}
	return page, nil
}

// CountPublicDiscoveries returns the total and familiar-only counts so a
// bounded UI scan can say whether it saw every traceable entry.
func (s *Store) CountPublicDiscoveries(ctx context.Context, familiarOnly bool) (int, error) {
	query := `SELECT COUNT(*) FROM public_discoveries d`
	if familiarOnly {
		query += ` WHERE EXISTS (SELECT 1 FROM human_outbound_peers h WHERE h.peer_id = d.peer_id)`
	}
	var count int
	if err := s.db.QueryRowContext(ctx, query).Scan(&count); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("count public discoveries: %w", err)
	}
	return count, nil
}
