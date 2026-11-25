package contactcard

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/netip"
	"strings"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/pkg/publicpeeraddr"
)

const legacyCompactPrefix = "raminga:v3:"

const (
	ipv4TCP byte = 1 << iota
	ipv4QUIC
	ipv6TCP
	ipv6QUIC
	hasRelay
	relayIPv6
	relayQUIC
	compactVersion
)

// The version bit distinguishes the unprefixed layout from the prefixed v3
// layout. Endpoints follow the flags and target key in IPv4, IPv6, relay order.
// A shorter dual-stack payload uses the IPv4 port for both direct endpoints.
const (
	ipv4Bytes       = 4
	ipv6Bytes       = 16
	portBytes       = 2
	compactHeader   = 1 + ed25519.PublicKeySize
	maxCompactBytes = compactHeader + ipv4Bytes + 2*ipv6Bytes + 3*portBytes + ed25519.PublicKeySize
	compactEscape   = 0xff
)

var directTransportFlags = [2][2]byte{{ipv4TCP, ipv4QUIC}, {ipv6TCP, ipv6QUIC}}

type compactEndpoint struct {
	addr      ma.Multiaddr
	tcp, quic bool
}

func (endpoint *compactEndpoint) add(addr ma.Multiaddr) {
	if endpoint.addr == nil {
		endpoint.addr = addr
	}
	if bytes.Equal(endpoint.addr[0].RawValue(), addr[0].RawValue()) && bytes.Equal(endpoint.addr[1].RawValue(), addr[1].RawValue()) {
		endpoint.tcp = endpoint.tcp || addr[1].Protocol().Code == ma.P_TCP
		endpoint.quic = endpoint.quic || addr[1].Protocol().Code == ma.P_UDP
	}
}

func appendDirectEndpoint(raw []byte, endpoint compactEndpoint, slot int, includePort bool) ([]byte, byte) {
	if endpoint.addr == nil {
		return raw, 0
	}
	var flags byte
	if endpoint.tcp {
		flags |= directTransportFlags[slot][0]
	}
	if endpoint.quic {
		flags |= directTransportFlags[slot][1]
	}
	raw = append(raw, endpoint.addr[0].RawValue()...)
	if includePort {
		raw = append(raw, endpoint.addr[1].RawValue()...)
	}
	return raw, flags
}

// WithPublicAddresses creates an unsigned dial hint. The recipient authenticates
// the expected Peer ID during the connection handshake.
func WithPublicAddresses(pid peer.ID, candidates []ma.Multiaddr) Card {
	return WithAddresses(pid, candidates, PublicScopes)
}

func WithAddresses(pid peer.ID, candidates []ma.Multiaddr, scopes AddressScopes) Card {
	key := embeddedEd25519Key(pid)
	if key == nil {
		return Card{PeerID: pid}
	}
	var endpoints [slotCount]compactEndpoint
	var lan [2]compactEndpoint
	var relayKey []byte
	for _, candidate := range candidates {
		if scopes&LANDirect != 0 {
			if addr := publicpeeraddr.NormalizeLAN(candidate, pid); len(addr) > 0 {
				lan[addressSlot(addr)].add(addr)
				continue
			}
		}
		addr := publicpeeraddr.Normalize(candidate, pid)
		if len(addr) == 0 {
			continue
		}
		slot := addressSlot(addr)
		endpoint := &endpoints[slot]
		if slot == relaySlot {
			if scopes&PublicRelay == 0 || endpoint.addr != nil {
				continue
			}
			relay, _ := peer.Decode(addr[len(addr)-2].Value())
			relayKey = embeddedEd25519Key(relay)
			if relayKey == nil {
				continue
			}
		} else if scopes&PublicDirect == 0 {
			continue
		}
		endpoint.add(addr)
	}
	// Canonicalize the in-memory addresses as well as the bytes so callers
	// see the same deduplicated hints as a recipient decoding the card.
	var flags byte
	raw := append([]byte{0}, key...)
	sharedPort := endpoints[ipv4Slot].addr != nil && endpoints[ipv6Slot].addr != nil &&
		bytes.Equal(endpoints[ipv4Slot].addr[1].RawValue(), endpoints[ipv6Slot].addr[1].RawValue())
	for i, endpoint := range endpoints[:relaySlot] {
		var endpointFlags byte
		raw, endpointFlags = appendDirectEndpoint(raw, endpoint, i, i != ipv6Slot || !sharedPort)
		flags |= endpointFlags
	}
	if relay := endpoints[relaySlot]; relay.addr != nil {
		flags |= hasRelay
		if relay.addr[0].Protocol().Code == ma.P_IP6 {
			flags |= relayIPv6
		}
		if relay.quic {
			flags |= relayQUIC
		}
		raw = append(raw, relay.addr[0].RawValue()...)
		raw = append(raw, relay.addr[1].RawValue()...)
		raw = append(raw, relayKey...)
	}
	hasLAN := lan[ipv4Slot].addr != nil || lan[ipv6Slot].addr != nil
	if flags == 0 && !hasLAN {
		return Card{PeerID: pid}
	}
	raw[0] = compactVersion | flags
	if hasLAN {
		raw = appendLAN(raw, lan)
	}
	card, err := decodeCompact(raw, false)
	if err != nil {
		return Card{PeerID: pid}
	}
	return card
}

func embeddedEd25519Key(id peer.ID) []byte {
	key, err := id.ExtractPublicKey()
	if err != nil || key.Type() != crypto.Ed25519 {
		return nil
	}
	raw, err := key.Raw()
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil
	}
	return raw
}

func idFromCompactKey(raw []byte) (peer.ID, error) {
	key, err := crypto.UnmarshalEd25519PublicKey(raw)
	if err != nil {
		return "", err
	}
	return peer.IDFromPublicKey(key)
}

func encodeCompact(raw []byte) string {
	body := base64.RawURLEncoding.EncodeToString(raw)
	if raw[0]&compactVersion == 0 {
		return legacyCompactPrefix + body
	}
	if _, err := peer.Decode(body); err == nil || body[0] == '-' {
		// Preserve every valid bare Peer ID, including multibase CIDs. In
		// an overlap or a leading CLI flag, this byte starts the text with
		// '_'. Every unescaped payload has an odd byte count.
		return base64.RawURLEncoding.EncodeToString(append([]byte{compactEscape}, raw...))
	}
	return body
}

func parseCompact(body string, legacy bool) (Card, error) {
	if len(body) > base64.RawURLEncoding.EncodedLen(maxCompactBytes+maxLANExtension+1) || strings.ContainsAny(body, "\r\n") {
		return Card{}, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil {
		return Card{}, ErrInvalid
	}
	if !legacy && len(raw) > 0 && len(raw)%2 == 0 && raw[0] == compactEscape {
		raw = raw[1:]
	}
	card, err := decodeCompact(raw, legacy)
	if err == nil && !legacy && encodeCompact(raw) != body {
		return Card{}, ErrInvalid
	}
	return card, err
}

func decodeCompact(raw []byte, legacy bool) (Card, error) {
	if !legacy && len(raw) > 0 && raw[0] == lanExtension {
		return decodeLAN(raw)
	}
	return decodePublicCompact(raw, legacy)
}

func decodePublicCompact(raw []byte, legacy bool) (Card, error) {
	if len(raw) <= compactHeader || (raw[0]&compactVersion == 0) != legacy {
		return Card{}, ErrInvalid
	}
	flags := raw[0] &^ compactVersion
	if flags == 0 || (flags&hasRelay == 0 && flags&(relayIPv6|relayQUIC) != 0) {
		return Card{}, ErrInvalid
	}
	v4 := flags&(ipv4TCP|ipv4QUIC) != 0
	v6 := flags&(ipv6TCP|ipv6QUIC) != 0
	relayIPBytes := ipv4Bytes
	if flags&relayIPv6 != 0 {
		relayIPBytes = ipv6Bytes
	}
	size := compactHeader
	if v4 {
		size += ipv4Bytes + portBytes
	}
	if v6 {
		size += ipv6Bytes + portBytes
	}
	if flags&hasRelay != 0 {
		size += relayIPBytes + portBytes + ed25519.PublicKeySize
	}
	var sharedPort uint16
	if !legacy && v4 && v6 && len(raw) == size-portBytes {
		sharedPort = binary.BigEndian.Uint16(raw[compactHeader+ipv4Bytes:])
		if sharedPort == 0 {
			return Card{}, ErrInvalid
		}
	} else if len(raw) != size {
		return Card{}, ErrInvalid
	}
	pid, err := idFromCompactKey(raw[1:compactHeader])
	if err != nil {
		return Card{}, ErrInvalid
	}
	card := Card{PeerID: pid, compact: raw}
	data := raw[compactHeader:]
	if v4 {
		data, err = card.readEndpoint(data, ipv4Bytes, flags&ipv4TCP != 0, flags&ipv4QUIC != 0, PublicDirect, 0)
		if err != nil {
			return Card{}, err
		}
	}
	if v6 {
		if !legacy && v4 && sharedPort == 0 && bytes.Equal(raw[compactHeader+ipv4Bytes:compactHeader+ipv4Bytes+portBytes], data[ipv6Bytes:ipv6Bytes+portBytes]) {
			return Card{}, ErrInvalid
		}
		data, err = card.readEndpoint(data, ipv6Bytes, flags&ipv6TCP != 0, flags&ipv6QUIC != 0, PublicDirect, sharedPort)
		if err != nil {
			return Card{}, err
		}
	}
	if flags&hasRelay != 0 {
		data, err = card.readEndpoint(data, relayIPBytes, flags&relayQUIC == 0, flags&relayQUIC != 0, PublicRelay, 0)
		if err != nil {
			return Card{}, err
		}
	}
	if len(data) != 0 {
		return Card{}, ErrInvalid
	}
	return card, nil
}

func (c *Card) readEndpoint(data []byte, ipLength int, tcp, quic bool, scope AddressScopes, port uint16) ([]byte, error) {
	relay := scope == PublicRelay
	size := ipLength
	if port == 0 {
		size += portBytes
	}
	if relay {
		size += ed25519.PublicKeySize
	}
	if len(data) < size {
		return nil, ErrInvalid
	}
	ip, _ := netip.AddrFromSlice(data[:ipLength])
	family := "ip4"
	if ipLength == ipv6Bytes {
		family = "ip6"
	}
	if port == 0 {
		port = binary.BigEndian.Uint16(data[ipLength:])
	}
	suffix := ""
	if relay {
		id, err := idFromCompactKey(data[ipLength+portBytes : size])
		if err != nil {
			return nil, ErrInvalid
		}
		suffix = "/p2p/" + id.String() + "/p2p-circuit"
	}
	base := "/" + family + "/" + ip.String()
	normalize := publicpeeraddr.Normalize
	if scope == LANDirect {
		normalize = publicpeeraddr.NormalizeLAN
	}
	for _, transport := range []struct {
		enabled bool
		format  string
	}{{tcp, "/tcp/%d"}, {quic, "/udp/%d/quic-v1"}} {
		if !transport.enabled {
			continue
		}
		addr, err := ma.NewMultiaddr(base + fmt.Sprintf(transport.format, port) + suffix)
		if err != nil || len(normalize(addr, c.PeerID)) == 0 {
			return nil, ErrInvalid
		}
		c.Addrs = append(c.Addrs, addr)
	}
	return data[size:], nil
}
