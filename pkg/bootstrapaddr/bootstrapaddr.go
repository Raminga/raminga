// Package bootstrapaddr validates and normalizes operator-supplied Raminga
// DHT bootstrap multiaddrs.
//
// Bootstrap peers are ordinary Raminga Peer records with a bootstrap role. The
// address syntax is intentionally strict: exactly one non-empty multiaddr that
// already contains its /p2p/<peer-id>, with no surrounding whitespace. Public
// IPFS/libp2p helpers are rejected so a historical address can never become a
// release preset by accident.
package bootstrapaddr

import (
	"errors"
	"strings"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

// Address is one canonical bootstrap address and its Peer ID.
type Address struct {
	// Multiaddr is the canonical multiaddr string, including /p2p/<peer-id>.
	Multiaddr string
	// PeerID is the canonical Peer ID string.
	PeerID string
}

// Parse validates raw and returns its canonical form. It rejects empty or
// whitespace-padded values, public IPFS/libp2p bootstrap services, invalid
// multiaddrs, and addresses without a final /p2p/<peer-id>.
func Parse(raw string) (Address, error) {
	if raw == "" {
		return Address{}, errors.New("地址不能为空")
	}
	if strings.TrimSpace(raw) != raw {
		return Address{}, errors.New("地址首尾不能包含空白")
	}
	if strings.ContainsAny(raw, "\r\n\t") {
		return Address{}, errors.New("地址不能包含换行或制表符")
	}
	if IsPublicBootstrap(raw) {
		return Address{}, errors.New("不能使用公用 IPFS/libp2p 引导地址；请填写 Raminga 节点")
	}
	m, err := ma.NewMultiaddr(raw)
	if err != nil {
		return Address{}, errors.New("地址格式不正确，请检查完整 multiaddr")
	}
	info, err := peer.AddrInfoFromP2pAddr(m)
	if err != nil {
		return Address{}, errors.New("地址必须包含有效的节点地址和完整的 /p2p/<peer-id>")
	}
	if info.ID == "" || len(info.Addrs) == 0 {
		return Address{}, errors.New("地址必须包含节点地址和 /p2p/<peer-id>")
	}
	return Address{Multiaddr: m.String(), PeerID: info.ID.String()}, nil
}

// IsPublicBootstrap reports whether raw names a public IPFS/libp2p helper.
// It is shared with config validation so the accepted set never drifts.
func IsPublicBootstrap(raw string) bool {
	lower := strings.ToLower(raw)
	for _, marker := range []string{"bootstrap.libp2p.io", "ipfs.io", "dweb.link", "/ipfs/", "protocol.ai"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
