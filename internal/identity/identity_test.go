package identity

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCreatesAndLocks(t *testing.T) {
	dir := t.TempDir()
	id1, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if id1.PeerID() == "" || id1.NodeID() == "" {
		t.Fatal("empty identity")
	}
	if got := id1.NodeID(); got[:5] != "node_" || len(got) != 5+24 {
		t.Fatalf("unexpected node ID %q", got)
	}

	keyPath := filepath.Join(dir, IdentityDirName, KeyFileName)
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("key permissions = %o, want 600", perm)
	}

	if _, err := Open(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Open error = %v, want ErrLocked", err)
	}
	firstPeer := id1.PeerID()
	if err := id1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	id2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = id2.Close() }()
	if id2.PeerID() != firstPeer {
		t.Fatalf("peer ID changed: %s -> %s", firstPeer, id2.PeerID())
	}
}

func TestKeyPermissionsAreTightened(t *testing.T) {
	dir := t.TempDir()
	id, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, IdentityDirName, KeyFileName)
	if err := id.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatal(err)
	}
	id2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = id2.Close() }()
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("key permissions = %o, want 600", perm)
	}
}
