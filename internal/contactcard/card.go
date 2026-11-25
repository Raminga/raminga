// Package contactcard implements transferable Raminga identities and
// dial hints, including the historical signed v2 format.
package contactcard

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/libp2p/go-libp2p/core/peer"
	peerpb "github.com/libp2p/go-libp2p/core/peer/pb"
	"github.com/libp2p/go-libp2p/core/record"
	ma "github.com/multiformats/go-multiaddr"
	"google.golang.org/protobuf/proto"

	"github.com/Raminga/raminga/pkg/publicpeeraddr"
)

const (
	signedPrefix  = "raminga:v2:"
	MaxCodeLength = 400
	maxEnvelope   = 1024
	maxAddrs      = 16
)

var ErrInvalid = errors.New("invalid Raminga contact card")
var ErrOldFormat = errors.New("obsolete Raminga contact card format; copy a new card")

type Card struct {
	PeerID   peer.ID
	Seq      uint64
	Envelope []byte
	Addrs    []ma.Multiaddr
	compact  []byte
}

type AddressScopes uint32

const (
	PublicDirect AddressScopes = 1 << iota
	PublicRelay
	LANDirect
	PublicScopes = PublicDirect | PublicRelay
	AllScopes    = PublicScopes | LANDirect
)

func (c Card) Scopes() AddressScopes {
	var scopes AddressScopes
	for _, addr := range c.Addrs {
		switch {
		case len(publicpeeraddr.NormalizeLAN(addr, c.PeerID)) > 0:
			scopes |= LANDirect
		case addressSlot(addr) == relaySlot:
			scopes |= PublicRelay
		default:
			scopes |= PublicDirect
		}
	}
	return scopes
}

type addressRecord struct{ peer.PeerRecord }

func (*addressRecord) Domain() string { return "raminga-contact-card-v1" }
func (*addressRecord) Codec() []byte  { return []byte("raminga/contact-card/1") }

func (r *addressRecord) UnmarshalRecord(raw []byte) error {
	var payload peerpb.PeerRecord
	if err := proto.Unmarshal(raw, &payload); err != nil || len(payload.Addresses) > maxAddrs {
		return ErrInvalid
	}
	parsed, err := peer.PeerRecordFromProtobuf(&payload)
	if err != nil || len(parsed.Addrs) != len(payload.Addresses) {
		return ErrInvalid
	}
	r.PeerRecord = *parsed
	return nil
}

// IsInput recognizes current codes and routes older prefixed values to card parsing.
func IsInput(raw string) bool {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(value, "raminga:") {
		return true
	}
	card, err := Parse(value)
	return err == nil && len(card.compact) > 0
}

func (c Card) Code() string {
	if len(c.compact) > 0 {
		return encodeCompact(c.compact)
	}
	if len(c.Envelope) == 0 {
		return c.PeerID.String()
	}
	return signedPrefix + base64.RawURLEncoding.EncodeToString(c.Envelope)
}

func (c Card) validSignedCode() bool {
	if len(c.Envelope) == 0 || !fitsCode(len(c.Envelope)) {
		return false
	}
	var seen [slotCount]bool
	for _, addr := range c.Addrs {
		slot := addressSlot(addr)
		if seen[slot] {
			return false
		}
		seen[slot] = true
	}
	return len(c.Addrs) > 0
}

func fitsCode(envelopeBytes int) bool {
	return len(signedPrefix)+base64.RawURLEncoding.EncodedLen(envelopeBytes) <= MaxCodeLength
}

func Parse(raw string) (Card, error) {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(value, "raminga:v1:") || strings.HasPrefix(value, "raminga://contact/") {
		return Card{}, ErrOldFormat
	}
	if len(value) > MaxCodeLength {
		return Card{}, ErrInvalid
	}
	if body, ok := strings.CutPrefix(value, legacyCompactPrefix); ok {
		return parseCompact(body, true)
	}
	body, ok := strings.CutPrefix(value, signedPrefix)
	if !ok {
		pid, err := peer.Decode(value)
		if err == nil {
			return Card{PeerID: pid}, nil
		}
		return parseCompact(value, false)
	}
	envelope, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil {
		return Card{}, ErrInvalid
	}
	card, err := FromEnvelope("", envelope)
	if err == nil && len(card.Envelope) > 0 && !card.validSignedCode() {
		return Card{}, ErrInvalid
	}
	return card, err
}

// FromEnvelope verifies the complete signed record before classifying its
// addresses. A valid record with any non-public hint yields only its identity.
func FromEnvelope(pid peer.ID, envelope []byte) (Card, error) {
	if len(envelope) == 0 || len(envelope) > maxEnvelope {
		return Card{}, ErrInvalid
	}
	rec := new(addressRecord)
	env, err := record.ConsumeTypedEnvelope(envelope, rec)
	if err != nil || env == nil || env.PublicKey == nil || !bytes.Equal(env.PayloadType, rec.Codec()) {
		return Card{}, ErrInvalid
	}
	signer, err := peer.IDFromPublicKey(env.PublicKey)
	if err != nil || rec.PeerID != signer || (pid != "" && pid != signer) || rec.Seq == 0 {
		return Card{}, ErrInvalid
	}
	pid = signer
	if len(rec.Addrs) == 0 {
		return Card{PeerID: pid}, nil
	}
	addrs := make([]ma.Multiaddr, 0, len(rec.Addrs))
	for _, addr := range rec.Addrs {
		public := publicpeeraddr.Normalize(addr, pid)
		if len(public) == 0 {
			return Card{PeerID: pid}, nil
		}
		addrs = append(addrs, public)
	}
	return Card{PeerID: pid, Seq: rec.Seq, Envelope: envelope, Addrs: addrs}, nil
}

const (
	ipv4Slot = iota
	ipv6Slot
	relaySlot
	slotCount
)

func addressSlot(addr ma.Multiaddr) int {
	if addr[len(addr)-1].Protocol().Code == ma.P_CIRCUIT {
		return relaySlot
	}
	if addr[0].Protocol().Code == ma.P_IP4 {
		return ipv4Slot
	}
	return ipv6Slot
}
