package network

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/record"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

const (
	addrNamespace  = "raminga-addr"
	addrRecordMax  = 4 << 10
	addrRecordKeys = "/" + addrNamespace + "/"
)

type addrRecordValidator struct{}

func (addrRecordValidator) Validate(key string, value []byte) error {
	_, err := parseAddrRecord(key, value)
	return err
}

func (addrRecordValidator) Select(key string, values [][]byte) (int, error) {
	if len(values) == 0 {
		return -1, errors.New("raminga-addr: no values")
	}
	best := -1
	var bestSeq uint64
	for i, value := range values {
		rec, err := parseAddrRecord(key, value)
		if err != nil {
			return -1, err
		}
		if best < 0 || rec.Seq > bestSeq {
			best = i
			bestSeq = rec.Seq
		}
	}
	if best < 0 {
		return -1, errors.New("raminga-addr: no valid value")
	}
	return best, nil
}

func parseAddrRecord(key string, value []byte) (*peer.PeerRecord, error) {
	if len(value) > addrRecordMax {
		return nil, fmt.Errorf("raminga-addr: value is %d bytes, max %d", len(value), addrRecordMax)
	}
	if !strings.HasPrefix(key, addrRecordKeys) {
		return nil, fmt.Errorf("raminga-addr: invalid key %q", key)
	}
	keyPeer, err := peer.Decode(strings.TrimPrefix(key, addrRecordKeys))
	if err != nil {
		return nil, fmt.Errorf("raminga-addr: invalid key peer ID: %w", err)
	}
	rec := &peer.PeerRecord{}
	env, err := record.ConsumeTypedEnvelope(value, rec)
	if err != nil {
		return nil, fmt.Errorf("raminga-addr: invalid envelope: %w", err)
	}
	if env == nil || env.PublicKey == nil {
		return nil, errors.New("raminga-addr: missing signer")
	}
	signer, err := peer.IDFromPublicKey(env.PublicKey)
	if err != nil || signer != keyPeer || rec.PeerID != keyPeer {
		return nil, errors.New("raminga-addr: signer/key/record peer mismatch")
	}
	if len(rec.Addrs) > 16 {
		return nil, fmt.Errorf("raminga-addr: %d addresses, max 16", len(rec.Addrs))
	}
	return rec, nil
}

func addrRecordKey(pid peer.ID) string { return addrRecordKeys + pid.String() }

func publishableAddrs(addrs []ma.Multiaddr) []ma.Multiaddr {
	out := make([]ma.Multiaddr, 0, 16)
	seen := make(map[string]struct{})
	for _, addr := range addrs {
		if addr == nil {
			continue
		}
		if !strings.Contains(addr.String(), "/p2p-circuit") && !manet.IsPublicAddr(addr) {
			continue
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, addr)
		if len(out) == 16 {
			break
		}
	}
	return out
}

// PublishableAddrs returns the addresses Raminga publishes: public addresses
// plus circuit addresses (including circuits through private relay IPs).
// Content's friends.json uses this same predicate.
func PublishableAddrs(addrs []ma.Multiaddr) []ma.Multiaddr { return publishableAddrs(addrs) }

func (d *DHT) publishAddresses() []ma.Multiaddr {
	if d == nil || d.h == nil {
		return nil
	}
	return publishableAddrs(d.h.Addrs())
}

func (d *DHT) publishOnce(ctx context.Context) error {
	if d.d == nil || !d.cfg.Enabled {
		return errors.New("DHT is disabled")
	}
	addrs := d.publishAddresses()
	if len(addrs) == 0 {
		return errors.New("no public or circuit addresses to publish")
	}
	rec := &peer.PeerRecord{PeerID: d.h.ID(), Addrs: addrs, Seq: peer.TimestampSeq()}
	priv := d.h.Peerstore().PrivKey(d.h.ID())
	if priv == nil {
		return errors.New("missing identity key")
	}
	env, err := record.Seal(rec, priv)
	if err != nil {
		return err
	}
	value, err := env.Marshal()
	if err != nil {
		return err
	}
	putCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return d.d.PutValue(putCtx, addrRecordKey(d.h.ID()), value)
}

// AddressesFromDHT reads and validates one signed address record, filters
// unusable addresses and caps the result at 16.
func (d *DHT) AddressesFromDHT(ctx context.Context, pid peer.ID) ([]string, error) {
	if d == nil || d.d == nil || !d.cfg.Enabled {
		return nil, errors.New("DHT is disabled")
	}
	value, err := d.d.GetValue(ctx, addrRecordKey(pid))
	if err != nil {
		return nil, err
	}
	rec, err := parseAddrRecord(addrRecordKey(pid), value)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rec.Addrs))
	for _, addr := range rec.Addrs {
		if !usableDialAddr(addr) {
			continue
		}
		out = append(out, addr.String())
		if len(out) == 16 {
			break
		}
	}
	return out, nil
}
