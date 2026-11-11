package node

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v5"
	"github.com/libp2p/go-libp2p/core/event"
	libp2pnet "github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/host/eventbus"

	"github.com/Raminga/raminga/internal/protocol"
	"github.com/Raminga/raminga/internal/storage"
)

// startOutbox subscribes to real libp2p connectedness events and runs the
// bounded retry sweeper. The event bus is the public API; there is no polling
// of private host internals.
func (n *Node) startOutbox(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	n.outboxCancel = cancel
	n.outboxSem = make(chan struct{}, 8)
	sub, err := n.net.Host().EventBus().Subscribe(new(event.EvtPeerConnectednessChanged), eventbus.BufSize(64))
	if err != nil {
		n.logger.Warn("subscribe outbox reconnect events failed", "error", err)
		sub = nil
	}
	n.outboxSub = sub
	n.outboxWG.Add(1)
	go n.outboxLoop(ctx, sub)
}

func (n *Node) outboxLoop(ctx context.Context, sub event.Subscription) {
	defer n.outboxWG.Done()
	interval := n.cfg.OutboxSweepInterval()
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var events <-chan any
	if sub != nil {
		events = sub.Out()
	}
	n.sweepOutbox(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n.sweepOutbox(ctx)
		case raw, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			evt, ok := raw.(event.EvtPeerConnectednessChanged)
			if !ok || evt.Connectedness != libp2pnet.Connected {
				continue
			}
			if err := n.store.ResetOutboxPeer(ctx, evt.Peer.String()); err != nil {
				n.logger.Debug("reset outbox peer failed", "peer_id", evt.Peer.String(), "error", err)
			}
			n.sweepOutbox(ctx)
		}
	}
}

func (n *Node) sweepOutbox(ctx context.Context) {
	if n.stopped.Load() || ctx.Err() != nil {
		return
	}
	now := time.Now()
	if expired, err := n.store.ExpireOutbox(ctx, now); err != nil {
		n.logger.Warn("expire outbox failed", "error", err)
	} else if expired > 0 {
		n.logger.Warn("outbox entries expired without a real ACK", "count", expired)
	}
	entries, err := n.store.DueOutbox(ctx, now, 64)
	if err != nil {
		n.logger.Warn("query due outbox failed", "error", err)
		return
	}
	for _, entry := range entries {
		pid, err := peer.Decode(entry.PeerID)
		if err != nil {
			_ = n.store.FailOutbox(ctx, entry.MessageID, "invalid peer ID stored in outbox")
			continue
		}
		if !n.markOutboxInflight(entry.MessageID) {
			continue
		}
		select {
		case n.outboxSem <- struct{}{}:
			go func(e storage.OutboxEntry, p peer.ID) {
				defer func() { <-n.outboxSem }()
				defer n.clearOutboxInflight(e.MessageID)
				n.deliverOutbox(ctx, e, p)
			}(entry, pid)
		default:
			n.clearOutboxInflight(entry.MessageID)
			return
		}
	}
}

func (n *Node) deliverOutbox(parent context.Context, entry storage.OutboxEntry, target peer.ID) {
	if parent.Err() != nil || n.stopped.Load() {
		return
	}
	if n.store.IsPaused(parent, target.String()) {
		return
	}
	n.restoreFriendAddrs(parent, target)
	ctx, cancel := context.WithTimeout(parent, protocol.DefaultSendTimeout*2)
	defer cancel()
	if n.net.Host().Network().Connectedness(target) != libp2pnet.Connected {
		var dialErr error
		if entry.Multiaddr != "" {
			_, dialErr = n.net.DialMultiaddr(ctx, entry.Multiaddr)
		} else {
			_, dialErr = n.net.DialPeerByID(ctx, target)
		}
		if dialErr != nil {
			n.recordOutboxFailure(ctx, entry, target, "dial for outbox: "+dialErr.Error())
			return
		}
	}
	ack, err := n.sendChatHTTP(ctx, target, entry.MessageID, entry.Text, entry.CreatedAt)
	if err != nil {
		if parent.Err() != nil {
			return
		}
		if permanentSendError(err) {
			if failErr := n.store.FailOutbox(ctx, entry.MessageID, err.Error()); failErr != nil {
				n.logger.Warn("fail outbox after permanent HTTP rejection failed", "message_id", entry.MessageID, "error", failErr)
			}
			return
		}
		n.recordOutboxFailure(ctx, entry, target, err.Error())
		return
	}
	if ack.Accepted {
		if err := n.store.MarkOutboxDelivered(ctx, entry.MessageID, time.Now()); err != nil {
			n.logger.Error("outbox ACK received but not persisted",
				"peer_id", target.String(), "message_id", entry.MessageID, "error", err)
			return
		}
		n.recordFriend(ctx, target, false)
		n.logger.Info("outbox message delivered after reconnect",
			"peer_id", target.String(), "message_id", entry.MessageID, "attempts", entry.Attempts+1)
		n.publish(Event{
			At: time.Now(),
			Ack: &AckEvent{
				MessageID: entry.MessageID,
				PeerID:    target.String(),
				Accepted:  true,
			},
		})
		return
	}
	reason := ack.Error
	if permanentRejection(reason) {
		if err := n.store.FailOutbox(ctx, entry.MessageID, reason); err != nil {
			n.logger.Warn("fail outbox after permanent rejection failed", "message_id", entry.MessageID, "error", err)
		}
		return
	}
	n.recordOutboxFailure(ctx, entry, target, "rejected: "+reason)
}

func (n *Node) recordOutboxFailure(ctx context.Context, entry storage.OutboxEntry, target peer.ID, reason string) {
	attempts := entry.Attempts + 1
	delay := retryDelay(attempts, n.cfg.OutboxRetryInitial(), n.cfg.OutboxRetryMax())
	next := time.Now().Add(delay)
	if err := n.store.RecordOutboxFailure(ctx, entry.MessageID, attempts, next, reason); err != nil {
		n.logger.Warn("record outbox failure failed", "message_id", entry.MessageID, "error", err)
		return
	}
	n.logger.Warn("outbox resend failed; will retry",
		"peer_id", target.String(), "message_id", entry.MessageID, "attempts", attempts,
		"next_attempt", next, "error", reason)
}

func (n *Node) markOutboxInflight(messageID string) bool {
	n.outboxMu.Lock()
	defer n.outboxMu.Unlock()
	if n.outboxInflight[messageID] {
		return false
	}
	n.outboxInflight[messageID] = true
	return true
}

func (n *Node) clearOutboxInflight(messageID string) {
	n.outboxMu.Lock()
	delete(n.outboxInflight, messageID)
	n.outboxMu.Unlock()
}

// retryDelay returns the exponential backoff delay for the given 1-based
// failure count, using cenkalti/backoff v5 with jitter and a hard cap.
func retryDelay(attempt int, initial, max time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if initial <= 0 {
		initial = time.Second
	}
	if max <= 0 {
		max = time.Minute
	}
	b := backoff.NewExponentialBackOff()
	b.InitialInterval = initial
	b.MaxInterval = max
	b.RandomizationFactor = 0.5
	b.Multiplier = 1.5
	b.Reset()
	d := b.NextBackOff()
	for i := 1; i < attempt; i++ {
		d = b.NextBackOff()
	}
	if d > max*3/2 {
		d = max * 3 / 2
	}
	return d
}

func permanentRejection(reason string) bool {
	lower := strings.ToLower(reason)
	for _, marker := range []string{
		"unknown peer is not in the local contact allow list",
		"peer is denied by local policy",
		"sender_peer_id does not match",
		"missing sender_peer_id",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// ListOutbox returns durable outbox entries newest first.
func (n *Node) ListOutbox(ctx context.Context, limit int) ([]OutboxEntry, error) {
	rows, err := n.store.ListOutbox(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]OutboxEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, OutboxEntry{
			MessageID: row.MessageID, PeerID: row.PeerID, Text: row.Text, Multiaddr: row.Multiaddr,
			Status: row.Status, Attempts: row.Attempts, Bytes: row.Bytes,
			LastError: row.LastError, CreatedAt: row.CreatedAt,
			ExpiresAt: row.ExpiresAt, NextAttemptAt: row.NextAttemptAt, UpdatedAt: row.UpdatedAt,
		})
	}
	return out, nil
}

// OutboxStats returns bounded outbox accounting.
func (n *Node) OutboxStats(ctx context.Context) (OutboxStats, error) {
	st, err := n.store.OutboxStats(ctx)
	if err != nil {
		return OutboxStats{}, err
	}
	return OutboxStats{
		Pending: st.Pending, Acked: st.Acked, Failed: st.Failed,
		Cancelled: st.Cancelled, PendingBytes: st.PendingBytes,
	}, nil
}

// CancelOutbox cancels one pending entry; terminal entries are rejected.
func (n *Node) CancelOutbox(ctx context.Context, messageID string) error {
	if messageID == "" {
		return errors.New("node: message ID is required")
	}
	ok, err := n.store.CancelOutbox(ctx, messageID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("node: outbox entry %q was not cancelled", messageID)
	}
	return nil
}

// Outbox returns the durable outbox page and accounting in one call for the
// local API.
func (n *Node) Outbox(ctx context.Context, limit int) ([]OutboxEntry, OutboxStats, error) {
	entries, err := n.ListOutbox(ctx, limit)
	if err != nil {
		return nil, OutboxStats{}, err
	}
	stats, err := n.OutboxStats(ctx)
	if err != nil {
		return nil, OutboxStats{}, err
	}
	return entries, stats, nil
}
