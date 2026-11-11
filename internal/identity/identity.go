// Package identity owns the new libp2p Ed25519 identity, the logical Raminga
// node ID and the per-data-directory single-instance lock.
//
// G1 generates a fresh identity; it deliberately does not read or validate the
// frozen TypeScript key format and does not promise TS Peer ID continuity.
package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

const (
	// IdentityDirName is the identity directory inside the data directory.
	IdentityDirName = "identity"
	// KeyFileName is the marshalled libp2p protobuf private key file.
	KeyFileName = "key"
	// LockFileName is the advisory single-instance lock file.
	LockFileName = "raminga.lock"

	nodeIDDomain = "raminga-node-id-v1\x00"
)

// ErrLocked is returned when another daemon already owns the data directory.
var ErrLocked = errors.New("data directory is locked by another raminga daemon")

// Identity is a loaded node identity. Close releases the data-dir lock.
type Identity struct {
	dataDir  string
	peerID   peer.ID
	nodeID   string
	privKey  crypto.PrivKey
	lock     *flock.Flock
	lockPath string
}

// Open loads or creates the node identity in dataDir and takes the exclusive
// single-instance lock. The lock is taken before any identity or database file
// is touched, so a second daemon fails without mutating the first daemon's
// state.
func Open(dataDir string) (*Identity, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if err := os.Chmod(abs, 0o700); err != nil {
		return nil, fmt.Errorf("restrict data directory permissions: %w", err)
	}

	lockPath := filepath.Join(abs, LockFileName)
	lock := flock.New(lockPath)
	locked, err := lock.TryLock()
	if err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("acquire data directory lock %q: %w", lockPath, err)
	}
	if !locked {
		_ = lock.Close()
		return nil, fmt.Errorf("%w: %s", ErrLocked, lockPath)
	}

	id, err := loadOrCreate(abs, lock, lockPath)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	return id, nil
}

func loadOrCreate(dataDir string, lock *flock.Flock, lockPath string) (*Identity, error) {
	idDir := filepath.Join(dataDir, IdentityDirName)
	if err := os.MkdirAll(idDir, 0o700); err != nil {
		return nil, fmt.Errorf("create identity directory: %w", err)
	}
	if err := os.Chmod(idDir, 0o700); err != nil {
		return nil, fmt.Errorf("restrict identity directory permissions: %w", err)
	}

	keyPath := filepath.Join(idDir, KeyFileName)
	priv, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	pid, err := peer.IDFromPrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("derive peer ID: %w", err)
	}
	return &Identity{
		dataDir:  dataDir,
		peerID:   pid,
		nodeID:   deriveNodeID(pid),
		privKey:  priv,
		lock:     lock,
		lockPath: lockPath,
	}, nil
}

func loadOrCreateKey(path string) (crypto.PrivKey, error) {
	info, err := os.Lstat(path)
	switch {
	case err == nil:
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("identity key %q is not a regular file", path)
		}
		if info.Mode().Perm()&0o077 != 0 {
			if err := os.Chmod(path, 0o600); err != nil {
				return nil, fmt.Errorf("restrict identity key permissions: %w", err)
			}
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read identity key: %w", err)
		}
		priv, err := crypto.UnmarshalPrivateKey(raw)
		if err != nil {
			return nil, fmt.Errorf("parse identity key %q: %w", path, err)
		}
		return priv, nil
	case errors.Is(err, os.ErrNotExist):
		priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("generate Ed25519 identity: %w", err)
		}
		raw, err := crypto.MarshalPrivateKey(priv)
		if err != nil {
			return nil, fmt.Errorf("marshal identity key: %w", err)
		}
		if err := writeFileAtomic(path, raw, 0o600); err != nil {
			return nil, fmt.Errorf("write identity key: %w", err)
		}
		return priv, nil
	default:
		return nil, fmt.Errorf("inspect identity key: %w", err)
	}
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".key-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// deriveNodeID derives a stable logical node ID from the Peer ID. It is a
// namespace/display identifier, not a second secret and not an independent
// cryptographic proof of identity.
func deriveNodeID(pid peer.ID) string {
	h := sha256.New()
	_, _ = h.Write([]byte(nodeIDDomain))
	_, _ = h.Write([]byte(pid))
	sum := h.Sum(nil)
	return "node_" + hex.EncodeToString(sum[:12])
}

// DataDir returns the absolute data directory.
func (i *Identity) DataDir() string { return i.dataDir }

// PeerID returns the libp2p Peer ID.
func (i *Identity) PeerID() peer.ID { return i.peerID }

// NodeID returns the logical Raminga node identifier.
func (i *Identity) NodeID() string { return i.nodeID }

// PrivateKey returns the libp2p private key for host construction. Callers must
// never log or serialize it.
func (i *Identity) PrivateKey() crypto.PrivKey { return i.privKey }

// Close releases the data directory lock. The lock file is intentionally kept.
func (i *Identity) Close() error {
	if i == nil || i.lock == nil {
		return nil
	}
	err := i.lock.Close()
	i.lock = nil
	if err != nil {
		return fmt.Errorf("release data directory lock %q: %w", i.lockPath, err)
	}
	return nil
}
