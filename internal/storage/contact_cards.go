package storage

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
)

func (s *Store) ContactCard(ctx context.Context, peerID string) ([]byte, error) {
	var envelope []byte
	err := s.db.QueryRowContext(ctx, "SELECT envelope FROM contact_cards WHERE peer_id = ?", peerID).Scan(&envelope)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return envelope, err
}

func (s *Store) SaveContactCard(ctx context.Context, peerID string, seq uint64, envelope []byte) error {
	// A fixed-width big-endian key preserves unsigned sequence ordering in SQLite.
	order := binary.BigEndian.AppendUint64(nil, seq)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO contact_cards (peer_id, sequence, envelope)
		SELECT peer_id, ?, ? FROM friends WHERE peer_id = ?
		ON CONFLICT(peer_id) DO UPDATE SET sequence = excluded.sequence, envelope = excluded.envelope
		WHERE excluded.sequence > contact_cards.sequence`, order, envelope, peerID)
	return err
}
