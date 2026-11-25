package contactcard

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/record"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/pkg/publicpeeraddr"
)

func cardIdentity(t *testing.T) (peer.ID, crypto.PrivKey) {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := peer.IDFromPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pid, key
}

func signedCard(t *testing.T, pid peer.ID, key crypto.PrivKey, seq uint64, addrs []ma.Multiaddr) Card {
	t.Helper()
	env, err := record.Seal(&addressRecord{peer.PeerRecord{PeerID: pid, Seq: seq, Addrs: addrs}}, key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return Card{PeerID: pid, Envelope: raw}
}

func TestCardFormatsAndAuthenticity(t *testing.T) {
	pid, key := cardIdentity(t)
	other, _ := cardIdentity(t)
	identity := Card{PeerID: pid}
	parsed, err := Parse(identity.Code())
	if err != nil || parsed.PeerID != pid || len(parsed.Envelope) != 0 || identity.Code() != pid.String() || len(identity.Code()) != 52 {
		t.Fatalf("identity-only card: %+v, %v", parsed, err)
	}
	addr := ma.StringCast("/ip4/11.66.77.10/tcp/4001")
	signed := signedCard(t, pid, key, 7, []ma.Multiaddr{addr})
	parsed, err = Parse(signed.Code())
	if err != nil || parsed.PeerID != pid || len(parsed.Addrs) != 1 || parsed.Seq != 7 ||
		!bytes.Equal(signed.Envelope, parsed.Envelope) || signed.Code() != parsed.Code() {
		t.Fatalf("signed card not preserved: %+v, %v", parsed, err)
	}
	if _, err := FromEnvelope(other, signed.Envelope); err == nil {
		t.Fatal("accepted a saved record under a different contact")
	}
	mismatch := signedCard(t, other, key, 8, []ma.Multiaddr{addr})
	if _, err := Parse(mismatch.Code()); err == nil {
		t.Fatal("accepted a Peer ID that differs from the signer")
	}
	signed.Envelope[len(signed.Envelope)-1] ^= 1
	if _, err := Parse(signed.Code()); err == nil {
		t.Fatal("accepted tampered signature")
	}
	if _, err := Parse(signedPrefix + strings.Repeat("A", MaxCodeLength)); err == nil {
		t.Fatal("accepted oversized input")
	}
	for _, old := range []string{"raminga:v1:" + pid.String() + ":" + strings.Repeat("A", 600), "raminga://contact/raminga%3Av1%3A" + pid.String()} {
		if _, err := Parse(old); !errors.Is(err, ErrOldFormat) {
			t.Fatalf("old input should ask for a new card: %v", err)
		}
	}
}

func TestCompactCardEndpointLengths(t *testing.T) {
	pid, _ := cardIdentity(t)
	relay, _ := cardIdentity(t)
	v4 := ma.StringCast("/ip4/11.66.77.10/tcp/4001")
	quic := ma.StringCast("/ip4/11.66.77.10/udp/4001/quic-v1")
	v6 := ma.StringCast("/ip6/2400::1/tcp/4001")
	v6OtherPort := ma.StringCast("/ip6/2400::1/tcp/4002")
	v6QUIC := ma.StringCast("/ip6/2400::1/udp/4001/quic-v1")
	circuit := ma.StringCast("/ip6/2400::2/udp/4001/quic-v1/p2p/" + relay.String() + "/p2p-circuit")
	for _, tc := range []struct {
		name string
		in   []ma.Multiaddr
		want []ma.Multiaddr
		size int
	}{
		{"IPv4", []ma.Multiaddr{v4}, []ma.Multiaddr{v4}, 52},
		{"IPv6", []ma.Multiaddr{v6}, []ma.Multiaddr{v6}, 68},
		{"QUIC only", []ma.Multiaddr{quic}, []ma.Multiaddr{quic}, 52},
		{"dual stack and shared port", []ma.Multiaddr{quic, v6, v4, quic}, []ma.Multiaddr{v4, quic, v6}, 74},
		{"dual stack and separate ports", []ma.Multiaddr{v4, v6OtherPort}, []ma.Multiaddr{v4, v6OtherPort}, 76},
		{"with relay", []ma.Multiaddr{circuit, v4, v6, quic}, []ma.Multiaddr{v4, quic, v6, circuit}, 140},
		{"relay only", []ma.Multiaddr{circuit}, []ma.Multiaddr{circuit}, 111},
		{"escape a leading CLI flag", []ma.Multiaddr{circuit, v6QUIC}, []ma.Multiaddr{v6QUIC, circuit}, 136},
		{"private only", []ma.Multiaddr{ma.StringCast("/ip4/10.0.0.1/tcp/4001")}, nil, 52},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code := WithPublicAddresses(pid, tc.in).Code()
			parsed, err := Parse(code)
			if err != nil || parsed.PeerID != pid || parsed.Code() != code || len(code) != tc.size || len(parsed.Envelope) != 0 {
				t.Fatalf("decoded %d-character card: %+v, %v", len(code), parsed, err)
			}
			if !slices.EqualFunc(parsed.Addrs, tc.want, func(a, b ma.Multiaddr) bool { return a.Equal(b) }) {
				t.Fatalf("got %v, want %v", parsed.Addrs, tc.want)
			}
			if IsInput(code) != (len(tc.want) > 0) || strings.Contains(code, ":") || strings.HasPrefix(code, "-") {
				t.Fatalf("unexpected code classification: %s", code)
			}
		})
	}
}

func TestCompactCardSelectsAddressScopes(t *testing.T) {
	pid, _ := cardIdentity(t)
	relay, _ := cardIdentity(t)
	addresses := []ma.Multiaddr{
		ma.StringCast("/ip4/11.66.77.10/tcp/4001"),
		ma.StringCast("/ip6/2400::1/tcp/4001"),
		ma.StringCast("/ip4/11.66.77.11/tcp/4001/p2p/" + relay.String() + "/p2p-circuit"),
		ma.StringCast("/ip4/192.168.13.7/tcp/4001"),
		ma.StringCast("/ip4/192.168.13.7/udp/4001/quic-v1"),
		ma.StringCast("/ip6/fd12::7/tcp/4001"),
		ma.StringCast("/ip4/127.0.0.1/tcp/4001"),
		ma.StringCast("/ip6/fe80::1/tcp/4001"),
	}
	for scopes := AddressScopes(0); scopes <= AllScopes; scopes++ {
		card := WithAddresses(pid, addresses, scopes)
		decoded, err := Parse(card.Code())
		if err != nil || decoded.PeerID != pid || decoded.Scopes() != scopes || decoded.Code() != card.Code() {
			t.Fatalf("scope %d did not round trip: %v (%v)", scopes, decoded.Addrs, err)
		}
		var expected []ma.Multiaddr
		if scopes&PublicDirect != 0 {
			expected = append(expected, addresses[:2]...)
		}
		if scopes&PublicRelay != 0 {
			expected = append(expected, addresses[2])
		}
		if scopes&LANDirect != 0 {
			expected = append(expected, addresses[3:6]...)
		}
		if !slices.EqualFunc(decoded.Addrs, expected, ma.Multiaddr.Equal) {
			t.Fatalf("scope %d decoded %v, want %v", scopes, decoded.Addrs, expected)
		}
	}
	if code := WithAddresses(pid, addresses, PublicDirect).Code(); len(code) != 74 {
		t.Fatalf("dual-stack public card changed length: %d", len(code))
	}
	onlyLAN := WithAddresses(pid, addresses[3:4], LANDirect)
	raw := slices.Clone(onlyLAN.compact)
	copy(raw[2+compactHeader:], []byte{127, 0, 0, 1})
	if _, err := Parse(encodeCompact(raw)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("loopback shifted into LAN payload: %v", err)
	}
}

func TestCompactCardRejectsInvalidAddressesAndShape(t *testing.T) {
	pid, _ := cardIdentity(t)
	addr := ma.StringCast("/ip4/11.66.77.10/tcp/4001")
	card := WithPublicAddresses(pid, []ma.Multiaddr{addr})
	for _, edit := range []func([]byte) []byte{
		func(raw []byte) []byte { raw[0] &^= compactVersion; return raw },
		func(raw []byte) []byte { raw[0] |= relayIPv6; return raw },
		func(raw []byte) []byte { copy(raw[33:], []byte{10, 0, 0, 1}); return raw },
		func(raw []byte) []byte { clear(raw[len(raw)-2:]); return raw },
		func(raw []byte) []byte { return raw[:len(raw)-1] },
		func(raw []byte) []byte { return append(raw, 0) },
		func(raw []byte) []byte { return append([]byte{compactEscape}, raw...) },
	} {
		bad := base64.RawURLEncoding.EncodeToString(edit(bytes.Clone(card.compact)))
		if _, err := Parse(bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid compact record accepted: %v", err)
		}
	}
}

func TestPrefixedV3AndCurrentCardDecodeTheSame(t *testing.T) {
	const old = "raminga:v3:DwECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gC0JNCg-hJAAAAAAAAAAAAAAAAAAAAQ-h"
	const current = "jwECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gC0JNCg-hJAAAAAAAAAAAAAAAAAAAAQ"
	const id = "12D3KooW9tJMax94Lrqw7Y5Qw36viGQAS2gTEPQ5Wg1vTk7xPfQs"
	legacy, err := Parse(old)
	if err != nil || legacy.PeerID.String() != id || len(legacy.Addrs) != 4 || legacy.Code() != old {
		t.Fatalf("legacy v3 import: %+v, %v", legacy, err)
	}
	if out := WithPublicAddresses(legacy.PeerID, legacy.Addrs).Code(); out != current {
		t.Fatalf("generated %s, want %s", out, current)
	}
	parsed, err := Parse(current)
	if err != nil || parsed.PeerID != legacy.PeerID || !slices.EqualFunc(parsed.Addrs, legacy.Addrs, func(a, b ma.Multiaddr) bool { return a.Equal(b) }) {
		t.Fatalf("current import: %+v, %v", parsed, err)
	}
	cid := peer.ToCid(legacy.PeerID).String()
	if parsed, err := Parse(cid); err != nil || parsed.PeerID != legacy.PeerID || IsInput(cid) || len(parsed.Addrs) != 0 {
		t.Fatalf("CID identity import: %+v, %v", parsed, err)
	}
}

func TestCompactCodeDoesNotShadowAValidPeerCID(t *testing.T) {
	// The first few key bytes make the standard Base64URL output also a
	// valid base64url multibase CID with the libp2p-key codec.
	key := append([]byte{0x05, 0xc8, 0x01, 0x80}, bytes.Repeat([]byte{0x11}, 28)...)
	pid, err := idFromCompactKey(key)
	if err != nil {
		t.Fatal(err)
	}
	relay, err := idFromCompactKey(bytes.Repeat([]byte{0x10}, 32))
	if err != nil {
		t.Fatal(err)
	}
	card := WithPublicAddresses(pid, []ma.Multiaddr{
		ma.StringCast("/ip6/2400::1/udp/4001/quic-v1"),
		ma.StringCast("/ip6/2400::2/tcp/4001/p2p/" + relay.String() + "/p2p-circuit"),
	})
	overlap := base64.RawURLEncoding.EncodeToString(card.compact)
	cid, err := peer.Decode(overlap)
	if err != nil || cid == pid {
		t.Fatalf("fixture should collide with a distinct valid Peer ID: %s, %v", cid, err)
	}
	if parsed, err := Parse(overlap); err != nil || parsed.PeerID != cid || IsInput(overlap) || len(parsed.Addrs) != 0 {
		t.Fatalf("valid bare CID was classified as a short code: %+v, %v", parsed, err)
	}
	code := card.Code()
	if parsed, err := Parse(code); err != nil || parsed.PeerID != pid || !IsInput(code) || !strings.HasPrefix(code, "_") || len(parsed.Addrs) != 2 {
		t.Fatalf("escaped card did not round trip: %+v, %v", parsed, err)
	}
}

func TestSignedV2AddressLimits(t *testing.T) {
	pid, key := cardIdentity(t)
	relay, _ := cardIdentity(t)
	v4 := "/ip4/11.66.77.10/tcp/4001"
	v6 := "/ip6/2400::1/tcp/4001"
	circuit := "/ip6/2400::2/tcp/4001/p2p/" + relay.String() + "/p2p-circuit"
	candidates := []ma.Multiaddr{
		ma.StringCast("/ip4/11.66.77.10/udp/4001/quic-v1"),
		ma.StringCast("/ip6/2400::3/udp/4001/quic-v1"),
		ma.StringCast(circuit), ma.StringCast(v4), ma.StringCast(v6),
		ma.StringCast("/ip6/2400::4/tcp/4001"),
	}
	card := signedCard(t, pid, key, 1_800_000_000_000_000_000, []ma.Multiaddr{ma.StringCast(v4), ma.StringCast(circuit), ma.StringCast(v6)})
	parsed, err := Parse(card.Code())
	if err != nil || len(parsed.Addrs) != 3 || len(card.Code()) != 390 {
		t.Fatalf("expected to retain support for 390-character v2 cards, got %+v: %v", parsed, err)
	}
	legacy := &addressRecord{peer.PeerRecord{PeerID: pid, Seq: 1, Addrs: candidates}}
	envelope, err := record.Seal(legacy, key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := envelope.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := FromEnvelope(pid, raw)
	if err != nil || saved.validSignedCode() || !bytes.Equal(saved.Envelope, raw) {
		t.Fatalf("oversized saved envelope should stay intact and fall back to identity-only sharing: %v", err)
	}
	if _, err := Parse(saved.Code()); err == nil {
		t.Fatal("accepted an oversized version 2 card")
	}
}

func TestCardRequiresPublicTransferConsent(t *testing.T) {
	pid, key := cardIdentity(t)
	relay, _ := cardIdentity(t)
	routingRecord := &peer.PeerRecord{PeerID: pid, Seq: 1, Addrs: []ma.Multiaddr{ma.StringCast("/ip4/11.66.77.10/tcp/4001")}}
	ordinary, err := record.Seal(routingRecord, key)
	if err != nil {
		t.Fatal(err)
	}
	body, err := ordinary.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := FromEnvelope(pid, body); err == nil {
		t.Fatal("accepted a routing record as a contact card")
	}

	mixed := &addressRecord{*routingRecord}
	mixed.Addrs = append(mixed.Addrs, ma.StringCast("/ip4/10.0.0.1/tcp/4001/p2p/"+relay.String()+"/p2p-circuit"))
	env, err := record.Seal(mixed, key)
	if err != nil {
		t.Fatal(err)
	}
	body, err = env.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	card, err := FromEnvelope(pid, body)
	if err != nil || card.PeerID != pid || len(card.Addrs) > 0 || len(card.Envelope) > 0 {
		t.Fatalf("private relay must downgrade the entire card: %+v, %v", card, err)
	}
	for _, raw := range []string{
		"/ip4/203.0.113.9/tcp/4001",
		"/ip4/127.0.0.1/tcp/4001",
		"/ip6/fd01::4/udp/4001/quic-v1",
		"/dns4/example.invalid/tcp/4001",
		"/ip4/11.66.77.11/tcp/4001/p2p/" + relay.String(),
	} {
		if addr := publicpeeraddr.Normalize(ma.StringCast(raw), pid); len(addr) != 0 {
			t.Errorf("accepted unsupported address %s", raw)
		}
	}
	publicRelay := "/ip4/11.66.77.11/tcp/4001/p2p/" + relay.String() + "/p2p-circuit"
	if addr := publicpeeraddr.Normalize(ma.StringCast(publicRelay+"/p2p/"+pid.String()), pid); addr.String() != publicRelay {
		t.Errorf("public relay normalization: %s", addr)
	}
}
