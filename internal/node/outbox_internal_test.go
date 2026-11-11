package node

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/Raminga/raminga/internal/storage"
	"github.com/libp2p/go-libp2p/core/peer"
)

func TestRetryDelayExponentialAndCapped(t *testing.T) {
	initial := time.Second
	max := time.Minute
	first := retryDelay(1, initial, max)
	if first < initial/2 || first > initial*3/2 {
		t.Fatalf("first retry delay = %s, want within [0.5s,1.5s]", first)
	}
	late := retryDelay(40, initial, max)
	if late <= 0 || late > max*3/2 {
		t.Fatalf("late retry delay = %s, want >0 and <=90s", late)
	}
	if retryDelay(0, initial, max) != first && retryDelay(0, initial, max) < initial/2 {
		t.Fatal("attempt 0 must behave like attempt 1")
	}
}

func TestOutboxSkipsPausedPeerAndKeepsMessage(t *testing.T) {
	ctx := context.Background()
	st, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	pid, err := peer.Decode("QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N")
	if err != nil {
		t.Fatal(err)
	}
	peerID := pid.String()
	if err := st.SaveOutboundWithOutbox(ctx, "m-paused", peerID, "hello", "", time.Now(), time.Now().Add(time.Hour), 10, 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := st.PausePeer(ctx, peerID); err != nil {
		t.Fatal(err)
	}
	n := &Node{store: st, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	entry, err := st.ListOutbox(ctx, 10)
	if err != nil || len(entry) != 1 {
		t.Fatalf("outbox=%v err=%v", entry, err)
	}
	n.deliverOutbox(ctx, entry[0], pid)
	after, err := st.ListOutbox(ctx, 10)
	if err != nil || len(after) != 1 || after[0].Status != "pending" || after[0].Attempts != 0 {
		t.Fatalf("paused outbox was changed/dropped: %+v err=%v", after, err)
	}
}
