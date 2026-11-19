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
	// Source is the most recent local acquisition path. Sources keeps every
	// distinct acquisition path for this exact (peer, path, sha256) version.
	Source  string
	Sources []string
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
// version updates the observed time/source and accumulates the acquisition
// path; a changed SHA-256 is a new version and stays as a separate row.
func (s *Store) RecordPublicDiscovery(ctx context.Context, peerID, path, sha256 string, sizeBytes, fetchedAtMS int64, source string) (PublicDiscovery, error) {
	if fetchedAtMS <= 0 {
		return PublicDiscovery{}, errors.New("storage: discovery fetched_at must be positive")
	}
	source = strings.TrimSpace(source)
	if source == "" {
		source = "unknown"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var (
		id      int64
		current string
		sources string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT id, source, sources_json FROM public_discoveries
		WHERE peer_id = ? AND path = ? AND sha256 = ?`,
		peerID, path, sha256).Scan(&id, &current, &sources)
	if errors.Is(err, sql.ErrNoRows) {
		merged := uniqueDiscoverySources(nil, source)
		rawSources, marshalErr := json.Marshal(merged)
		if marshalErr != nil {
			return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", marshalErr)
		}
		res, insertErr := tx.ExecContext(ctx, `
			INSERT INTO public_discoveries (peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			peerID, path, sha256, sizeBytes, fetchedAtMS, source, string(rawSources))
		if insertErr != nil {
			return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", insertErr)
		}
		id, err = res.LastInsertId()
		if err != nil {
			return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", err)
		}
	} else if err != nil {
		return PublicDiscovery{}, fmt.Errorf("read public discovery version: %w", err)
	} else {
		merged := uniqueDiscoverySources(decodeDiscoverySources(sources, current), source)
		rawSources, marshalErr := json.Marshal(merged)
		if marshalErr != nil {
			return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", marshalErr)
		}
		if _, updateErr := tx.ExecContext(ctx, `
			UPDATE public_discoveries SET fetched_at_ms = ?, source = ?, sources_json = ?, size_bytes = ?
			WHERE id = ?`, fetchedAtMS, source, string(rawSources), sizeBytes, id); updateErr != nil {
			return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", updateErr)
		}
	}
	if err := tx.Commit(); err != nil {
		return PublicDiscovery{}, fmt.Errorf("record public discovery: %w", err)
	}
	row, err := s.publicDiscoveryByID(ctx, id)
	if err != nil {
		return PublicDiscovery{}, err
	}
	return row, nil
}

func uniqueDiscoverySources(existing []string, source string) []string {
	out := make([]string, 0, len(existing)+1)
	seen := make(map[string]struct{}, len(existing)+1)
	for _, value := range append(existing, source) {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func decodeDiscoverySources(raw, fallback string) []string {
	var values []string
	if json.Unmarshal([]byte(raw), &values) != nil {
		values = nil
	}
	if len(values) == 0 && strings.TrimSpace(fallback) != "" {
		values = []string{fallback}
	}
	return uniqueDiscoverySources(values, "")
}

func (s *Store) publicDiscoveryByID(ctx context.Context, id int64) (PublicDiscovery, error) {
	var (
		row     PublicDiscovery
		sources string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT id, peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json
		FROM public_discoveries WHERE id = ?`, id).Scan(
		&row.ID, &row.PeerID, &row.Path, &row.SHA256, &row.SizeBytes, &row.FetchedAtMS, &row.Source, &sources)
	if err != nil {
		return PublicDiscovery{}, fmt.Errorf("read recorded discovery: %w", err)
	}
	row.Sources = decodeDiscoverySources(sources, row.Source)
	return row, nil
}

// postCandidateCondition keeps only paths whose shape can hold a versioned
// public post: posts/<name>.json (v1) or posts/<name>/post.json (v2). This is a
// cursor-level prefilter, not post identification: the caller still verifies
// the downloaded bytes and version through its controlled reader. Applying it
// before LIMIT means ordinary files can never consume a post page's budget.
const postCandidateCondition = `(
	(d.path LIKE 'posts/%.json' AND (length(d.path) - length(replace(d.path, '/', ''))) = 1)
	OR (d.path LIKE 'posts/%/post.json' AND (length(d.path) - length(replace(d.path, '/', ''))) = 2)
)`

// familiarPeerCondition defines “有过交流” from persisted outbound messages:
// a durable human relation survives message pruning, while a retained real
// Agent outbound row also proves an actual exchange. The filter never uses
// last_interaction, profile browsing or connection state as a substitute.
const familiarPeerCondition = `(EXISTS (
	SELECT 1 FROM human_outbound_peers h WHERE h.peer_id = d.peer_id
) OR EXISTS (
	SELECT 1 FROM messages m
	WHERE m.peer_id = d.peer_id AND m.direction = 'out' AND m.origin = 'agent'
))`

// ListPublicDiscoveries returns discovery evidence newest first. familiarOnly
// joins the durable human outbound relation, so the filter is applied to the
// whole content set rather than only the rows visible on one UI page.
// postCandidatesOnly restricts the keyset page itself to post-shaped paths;
// callers that omit it (old clients) still receive every file. The default
// false keeps that legacy mixed-page contract.
func (s *Store) ListPublicDiscoveries(ctx context.Context, before string, limit int, familiarOnly bool, peerID string, postCandidatesOnly bool) (PublicDiscoveryPage, error) {
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
	query := `SELECT d.id, d.peer_id, d.path, d.sha256, d.size_bytes, d.fetched_at_ms, d.source, d.sources_json
		FROM public_discoveries d`
	args := []any{}
	conditions := make([]string, 0, 3)
	if familiarOnly {
		conditions = append(conditions, familiarPeerCondition)
	}
	if postCandidatesOnly {
		conditions = append(conditions, postCandidateCondition)
	}
	if strings.TrimSpace(peerID) != "" {
		conditions = append(conditions, `d.peer_id = ?`)
		args = append(args, strings.TrimSpace(peerID))
	}
	if before != "" {
		conditions = append(conditions, `(d.fetched_at_ms < ? OR (d.fetched_at_ms = ? AND d.id < ?))`)
		args = append(args, at, at, id)
	}
	if len(conditions) > 0 {
		query += ` WHERE ` + strings.Join(conditions, ` AND `)
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
		var (
			row     PublicDiscovery
			sources string
		)
		if err := rows.Scan(&row.ID, &row.PeerID, &row.Path, &row.SHA256, &row.SizeBytes, &row.FetchedAtMS, &row.Source, &sources); err != nil {
			return PublicDiscoveryPage{}, fmt.Errorf("scan public discovery: %w", err)
		}
		row.Sources = decodeDiscoverySources(sources, row.Source)
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
		query += ` WHERE ` + familiarPeerCondition
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
