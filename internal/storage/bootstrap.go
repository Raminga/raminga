package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/pkg/bootstrapaddr"
)

// BootstrapPeer is one ordinary peer record carrying the bootstrap role.
// Addrs are the stored peer-cache addresses, Paused is the existing explicit
// disconnect state, and SavedAtMS is when the role first appeared. Online is
// deliberately not part of this record: it is a live network fact, not a
// stored setting.
type BootstrapPeer struct {
	PeerID    string
	Addrs     []string
	SavedAtMS int64
	Paused    bool
}

// BootstrapImported reports whether the one-time legacy/preset import has
// already committed. It is read before config recovery so a missing config
// cannot resolve a new official preset over an existing database marker.
func (s *Store) BootstrapImported(ctx context.Context) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM bootstrap_import_state WHERE singleton=1`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read bootstrap import state: %w", err)
	}
	return true, nil
}

// ImportBootstrapPeersOnce consumes the legacy TOML bootstrap list (including
// the first-run release preset) exactly once. It returns the number of roles
// seeded and whether this call performed the one-time import. A marker is
// written even for an empty list, so an explicit clear or opt-out can never be
// undone by a later restart or config edit.
func (s *Store) ImportBootstrapPeersOnce(ctx context.Context, seed []string) (int, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("begin bootstrap import: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// The singleton marker is the authority, not the current TOML text. Check
	// it inside the transaction before looking at the seed: once the first
	// import (including an empty list) is committed, a later invalid legacy
	// address is dormant and must not stop the daemon.
	var importedAt int64
	err = tx.QueryRowContext(ctx, `SELECT imported_at_ms FROM bootstrap_import_state WHERE singleton=1`).Scan(&importedAt)
	if err == nil {
		return 0, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, fmt.Errorf("read bootstrap import state: %w", err)
	}
	// Validate the complete first seed before writing any role. A failed first
	// import rolls back without a marker, so a corrected config can retry.
	canonical, err := canonicalBootstrapSeed(seed)
	if err != nil {
		return 0, false, err
	}
	added := 0
	for _, addresses := range canonical {
		for _, address := range addresses {
			changed, err := s.upsertBootstrapPeerTx(ctx, tx, address)
			if err != nil {
				return 0, false, err
			}
			if changed {
				added++
			}
		}
	}
	if err := prunePeerCacheTx(ctx, tx, s.now().UnixMilli(), defaultCacheEntries); err != nil {
		return 0, false, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO bootstrap_import_state (singleton, imported_at_ms, imported_count) VALUES (1, ?, ?)`,
		s.now().UnixMilli(), added); err != nil {
		return 0, false, fmt.Errorf("record bootstrap import: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("commit bootstrap import: %w", err)
	}
	return added, true, nil
}

// AddBootstrapPeer validates one address, merges it into the ordinary peer
// cache and adds the bootstrap role. Re-adding the same peer/address is
// idempotent; the bool reports whether the persisted list changed. It never
// dials, publishes, or changes contact/pause records.
func (s *Store) AddBootstrapPeer(ctx context.Context, raw string) (BootstrapPeer, bool, error) {
	address, err := bootstrapaddr.Parse(raw)
	if err != nil {
		return BootstrapPeer{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BootstrapPeer{}, false, fmt.Errorf("begin bootstrap add: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	added, err := s.upsertBootstrapPeerTx(ctx, tx, address)
	if err != nil {
		return BootstrapPeer{}, false, err
	}
	if err := prunePeerCacheTx(ctx, tx, s.now().UnixMilli(), defaultCacheEntries); err != nil {
		return BootstrapPeer{}, false, err
	}
	// Build the save receipt from the same transaction. Once Commit succeeds
	// the caller applies the role to the live map without another
	// request-context storage read that could fail and leave the two views
	// disagreeing.
	value, err := readBootstrapPeer(ctx, tx, address.PeerID)
	if err != nil {
		return BootstrapPeer{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return BootstrapPeer{}, false, fmt.Errorf("commit bootstrap add: %w", err)
	}
	return value, added, nil
}

// RemoveBootstrapPeer removes only the bootstrap role. Peer addresses, friend
// history/contact semantics, other roles and the explicit-disconnect record
// are preserved. A non-member is an idempotent no-op (removed=false).
func (s *Store) RemoveBootstrapPeer(ctx context.Context, peerID string) (bool, error) {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return false, fmt.Errorf("invalid peer ID %q: %w", peerID, err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin bootstrap remove: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `DELETE FROM bootstrap_peers WHERE peer_id=?`, pid.String())
	if err != nil {
		return false, fmt.Errorf("remove bootstrap role: %w", err)
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read bootstrap remove result: %w", err)
	}
	// The cache row is history/address state, not the role. Demote only the
	// source label so the ordinary peer is no longer described as bootstrap.
	if _, err := tx.ExecContext(ctx,
		`UPDATE known_peers SET source=? WHERE peer_id=? AND source=?`,
		PeerSourceKnown, pid.String(), PeerSourceBootstrap); err != nil {
		return false, fmt.Errorf("demote bootstrap peer cache source: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit bootstrap remove: %w", err)
	}
	return removed > 0, nil
}

// ListBootstrapPeers returns saved bootstrap roles with ordinary peer-cache
// addresses and the existing persistent pause flag. The order is stable:
// role creation time, then Peer ID; addresses are sorted.
func (s *Store) ListBootstrapPeers(ctx context.Context) ([]BootstrapPeer, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT b.peer_id, COALESCE(k.addrs_json, '[]'), b.created_at_ms,
		       CASE WHEN p.peer_id IS NULL THEN 0 ELSE 1 END
		FROM bootstrap_peers b
		LEFT JOIN known_peers k ON k.peer_id=b.peer_id
		LEFT JOIN paused_peers p ON p.peer_id=b.peer_id
		ORDER BY b.created_at_ms ASC, b.peer_id ASC`)
	if err != nil {
		return nil, fmt.Errorf("query bootstrap peers: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]BootstrapPeer, 0)
	for rows.Next() {
		var (
			value  BootstrapPeer
			raw    string
			paused int
		)
		if err := rows.Scan(&value.PeerID, &raw, &value.SavedAtMS, &paused); err != nil {
			return nil, fmt.Errorf("scan bootstrap peer: %w", err)
		}
		if err := json.Unmarshal([]byte(raw), &value.Addrs); err != nil {
			return nil, fmt.Errorf("decode bootstrap peer addrs: %w", err)
		}
		value.Addrs = bootstrapFullAddrs(value.PeerID, value.Addrs)
		value.Paused = paused != 0
		out = append(out, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bootstrap peers: %w", err)
	}
	return out, nil
}

type bootstrapPeerQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func readBootstrapPeer(ctx context.Context, queryer bootstrapPeerQuerier, peerID string) (BootstrapPeer, error) {
	var (
		value  BootstrapPeer
		raw    string
		paused int
	)
	err := queryer.QueryRowContext(ctx, `
		SELECT b.peer_id, COALESCE(k.addrs_json, '[]'), b.created_at_ms,
		       CASE WHEN p.peer_id IS NULL THEN 0 ELSE 1 END
		FROM bootstrap_peers b
		LEFT JOIN known_peers k ON k.peer_id=b.peer_id
		LEFT JOIN paused_peers p ON p.peer_id=b.peer_id
		WHERE b.peer_id=?`, peerID).
		Scan(&value.PeerID, &raw, &value.SavedAtMS, &paused)
	if err != nil {
		return BootstrapPeer{}, fmt.Errorf("read bootstrap peer: %w", err)
	}
	if err := json.Unmarshal([]byte(raw), &value.Addrs); err != nil {
		return BootstrapPeer{}, fmt.Errorf("decode bootstrap peer addrs: %w", err)
	}
	value.Addrs = bootstrapFullAddrs(value.PeerID, value.Addrs)
	value.Paused = paused != 0
	return value, nil
}

func canonicalBootstrapSeed(seed []string) (map[string][]bootstrapaddr.Address, error) {
	out := make(map[string][]bootstrapaddr.Address)
	for index, raw := range seed {
		address, err := bootstrapaddr.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("第 %d 个引导节点地址无效：%w", index+1, err)
		}
		out[address.PeerID] = append(out[address.PeerID], address)
	}
	for id, addrs := range out {
		sort.Slice(addrs, func(i, j int) bool { return addrs[i].Multiaddr < addrs[j].Multiaddr })
		unique := addrs[:0]
		for _, address := range addrs {
			if len(unique) > 0 && unique[len(unique)-1].Multiaddr == address.Multiaddr {
				continue
			}
			unique = append(unique, address)
		}
		out[id] = unique
	}
	return out, nil
}

func (s *Store) upsertBootstrapPeerTx(ctx context.Context, tx *sql.Tx, address bootstrapaddr.Address) (bool, error) {
	now := s.now().UnixMilli()
	var (
		existingJSON string
		existingSrc  string
	)
	err := tx.QueryRowContext(ctx,
		`SELECT addrs_json, source FROM known_peers WHERE peer_id=?`, address.PeerID).
		Scan(&existingJSON, &existingSrc)
	existed := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("read bootstrap peer cache: %w", err)
	}
	var old []string
	if existed {
		if jsonErr := json.Unmarshal([]byte(existingJSON), &old); jsonErr != nil {
			return false, fmt.Errorf("decode bootstrap peer cache: %w", jsonErr)
		}
	}
	merged := sortedUniqueStrings(append(old, address.Multiaddr))
	source := PeerSourceBootstrap
	if existed && sourcePriority(existingSrc) > sourcePriority(source) {
		source = existingSrc
	}
	raw, err := json.Marshal(merged)
	if err != nil {
		return false, fmt.Errorf("encode bootstrap peer addrs: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO known_peers (peer_id, addrs_json, source, updated_at_ms, expires_at_ms)
		 VALUES (?, ?, ?, ?, 0)
		 ON CONFLICT(peer_id) DO UPDATE SET
		   addrs_json=excluded.addrs_json,
		   source=excluded.source,
		   updated_at_ms=excluded.updated_at_ms,
		   expires_at_ms=0`,
		address.PeerID, string(raw), source, now); err != nil {
		return false, fmt.Errorf("upsert bootstrap peer cache: %w", err)
	}
	roleResult, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO bootstrap_peers (peer_id, created_at_ms) VALUES (?, ?)`,
		address.PeerID, now)
	if err != nil {
		return false, fmt.Errorf("add bootstrap role: %w", err)
	}
	roleAdded, err := roleResult.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read bootstrap role result: %w", err)
	}
	addressAdded := !existed
	if existed {
		found := false
		for _, value := range old {
			if value == address.Multiaddr {
				found = true
				break
			}
		}
		addressAdded = !found
	}
	return roleAdded > 0 || addressAdded, nil
}

// bootstrapFullAddrs keeps ordinary cache addresses usable as bootstrap
// candidates. libp2p's PeerStore/cache may store a transport address without
// /p2p/<id>; the role listing appends the known target Peer ID to a direct
// transport or a relay transport ending in /p2p/<relay>/p2p-circuit. A full
// address is preserved only when its final /p2p component matches the target;
// malformed addresses, mismatched final Peer IDs and a bare /p2p/<target> with
// no transport are skipped. The function is pure: it never rewrites
// known_peers or another peer's cache row.
func bootstrapFullAddrs(peerID string, values []string) []string {
	if _, err := peer.Decode(peerID); err != nil {
		return []string{}
	}
	suffix := ma.StringCast("/p2p/" + peerID)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		m, err := ma.NewMultiaddr(value)
		if err != nil {
			continue
		}
		head, last := ma.SplitLast(m)
		if last == nil {
			continue
		}
		switch last.Protocol().Name {
		case "p2p":
			// A complete address is usable only when its final Peer ID is the
			// known target. This structurally rejects a mismatched final ID.
			if last.Value() != peerID {
				continue
			}
			// A bare /p2p/<target> is syntactically valid but has no transport
			// and cannot be a dial candidate.
			if head == nil {
				continue
			}
			out = append(out, m.String())
		case "p2p-circuit":
			// Relay transport: .../p2p/<relay>/p2p-circuit. The only /p2p
			// here is the relay, so append the known target at the end.
			out = append(out, m.Encapsulate(suffix).String())
		default:
			// Direct transport with no /p2p suffix. If a /p2p exists earlier
			// but is not final, the address is not a complete bootstrap target
			// (for example .../p2p/<id>/http); skip it rather than appending a
			// second identity after an unrelated protocol.
			hasP2P := false
			for _, protocol := range m.Protocols() {
				if protocol.Name == "p2p" {
					hasP2P = true
					break
				}
			}
			if hasP2P {
				continue
			}
			out = append(out, m.Encapsulate(suffix).String())
		}
	}
	out = sortedUniqueStrings(out)
	if out == nil {
		return []string{}
	}
	return out
}

func sortedUniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
