package contactcard

const (
	// Relay modifier bits without hasRelay are invalid in the public format.
	lanExtension    = compactVersion | relayIPv6 | relayQUIC
	maxLANExtension = 2 + ipv4Bytes + ipv6Bytes + 2*portBytes
)

// The LAN header precedes the existing compact payload. The LAN endpoints
// follow that payload, without changing the existing public-only format.
func appendLAN(public []byte, lan [2]compactEndpoint) []byte {
	raw := append([]byte{lanExtension, 0}, public...)
	for slot, endpoint := range lan {
		var flags byte
		raw, flags = appendDirectEndpoint(raw, endpoint, slot, true)
		raw[1] |= flags
	}
	return raw
}

func decodeLAN(raw []byte) (Card, error) {
	if len(raw) < 2+compactHeader+ipv4Bytes+portBytes {
		return Card{}, ErrInvalid
	}
	flags := raw[1]
	if flags == 0 || flags&^(ipv4TCP|ipv4QUIC|ipv6TCP|ipv6QUIC) != 0 {
		return Card{}, ErrInvalid
	}
	publicEnd := len(raw)
	ipLengths := [2]int{ipv4Bytes, ipv6Bytes}
	for slot, transports := range directTransportFlags {
		if flags&(transports[0]|transports[1]) != 0 {
			publicEnd -= ipLengths[slot] + portBytes
		}
	}
	if publicEnd < 2+compactHeader {
		return Card{}, ErrInvalid
	}
	public := raw[2:publicEnd]
	var card Card
	var err error
	if len(public) == compactHeader && public[0] == compactVersion {
		card.PeerID, err = idFromCompactKey(public[1:])
	} else {
		card, err = decodePublicCompact(public, false)
	}
	if err != nil {
		return Card{}, ErrInvalid
	}
	data := raw[publicEnd:]
	for slot, transports := range directTransportFlags {
		tcp, quic := flags&transports[0] != 0, flags&transports[1] != 0
		if tcp || quic {
			data, err = card.readEndpoint(data, ipLengths[slot], tcp, quic, LANDirect, 0)
			if err != nil {
				return Card{}, err
			}
		}
	}
	card.compact = raw
	return card, nil
}
