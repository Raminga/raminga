package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ProfilePublicationRequest records the private intent before any public
// files are written. An empty receipt indicates an interrupted attempt.
type ProfilePublicationRequest struct {
	RequestID        string
	DraftCreatedAtMS int64
	Revision         int64
	BaseSHA256       string
	PublishedAtNS    int64
	TargetSHA256     string
	FilesJSON        []byte
	ReceiptJSON      []byte
}

const selectProfilePublication = `SELECT request_id, draft_created_at_ms,
	revision, base_sha256, published_at_ns, target_sha256, files_json, receipt_json
	FROM profile_publication_requests`

func scanProfilePublication(row *sql.Row) (ProfilePublicationRequest, bool, error) {
	var r ProfilePublicationRequest
	err := row.Scan(&r.RequestID, &r.DraftCreatedAtMS, &r.Revision, &r.BaseSHA256,
		&r.PublishedAtNS, &r.TargetSHA256, &r.FilesJSON, &r.ReceiptJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	return r, err == nil, err
}

func (s *Store) GetProfilePublicationRequest(ctx context.Context, id string) (ProfilePublicationRequest, bool, error) {
	return scanProfilePublication(s.db.QueryRowContext(ctx, selectProfilePublication+` WHERE request_id=?`, id))
}

// PendingProfilePublication matches the public metadata, so a later publish
// can finish recording the previous commit before replacing it.
func (s *Store) PendingProfilePublication(ctx context.Context, sha string) (ProfilePublicationRequest, bool, error) {
	return scanProfilePublication(s.db.QueryRowContext(ctx, selectProfilePublication+
		` WHERE target_sha256=? AND receipt_json=''`, sha))
}

func (s *Store) LatestProfilePublicationTime(ctx context.Context) (sql.NullInt64, error) {
	var latest sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT MAX(published_at_ns) FROM profile_publication_requests`).Scan(&latest)
	return latest, err
}

func (s *Store) BeginProfilePublication(ctx context.Context, r ProfilePublicationRequest) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO profile_publication_requests
		(request_id, draft_created_at_ms, revision, base_sha256, published_at_ns, target_sha256, files_json)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, r.RequestID, r.DraftCreatedAtMS, r.Revision,
		r.BaseSHA256, r.PublishedAtNS, r.TargetSHA256, string(r.FilesJSON))
	return err
}

// FinishProfilePublication remembers the exact receipt and updates the draft
// together. The draft can have a newer private revision, or have been deleted
// entirely, while the public files from this attempt remain committed.
func (s *Store) FinishProfilePublication(ctx context.Context, r ProfilePublicationRequest, profilePath string, receipt []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE public_drafts SET
		published_path=?, published_sha256=?, published_revision=?
		WHERE draft_id='profile' AND created_at_ms=? AND revision>=? AND published_sha256=?`,
		profilePath, r.TargetSHA256, r.Revision, r.DraftCreatedAtMS, r.Revision, r.BaseSHA256); err != nil {
		return fmt.Errorf("record profile draft publication: %w", err)
	}
	res, err := tx.ExecContext(ctx, `UPDATE profile_publication_requests SET receipt_json=?
		WHERE request_id=? AND receipt_json=''`, string(receipt), r.RequestID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("record profile publication receipt: pending request missing")
	}
	return tx.Commit()
}
