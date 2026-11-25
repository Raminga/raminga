package node

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/internal/contactcard"
)

var ErrContactNotFound = errors.New("contact was not found")
var ErrOwnContactCard = errors.New("this is your own Raminga ID")

// AddBootstrapCard saves the addresses together as a bootstrap setting. It
// does not import the card into the contacts list.
func (n *Node) AddBootstrapCard(ctx context.Context, code string) (BootstrapPeer, bool, error) {
	card, err := contactcard.Parse(code)
	if err != nil {
		return BootstrapPeer{}, false, err
	}
	if len(card.Addrs) == 0 {
		return BootstrapPeer{}, false, errors.New("请使用打开「附带连接地址」后复制的名片短码")
	}
	return n.saveBootstrapPeer(ctx, peer.AddrInfo{ID: card.PeerID, Addrs: card.Addrs})
}

func (n *Node) ContactCard(ctx context.Context, rawPeerID string, includeAddresses bool) (contactcard.Card, bool, error) {
	var scopes contactcard.AddressScopes
	if includeAddresses {
		scopes = contactcard.PublicScopes
	}
	card, available, err := n.ContactCardForScopes(ctx, rawPeerID, scopes)
	return card, available&contactcard.PublicScopes != 0, err
}

func (n *Node) ContactCardForScopes(ctx context.Context, rawPeerID string, scopes contactcard.AddressScopes) (contactcard.Card, contactcard.AddressScopes, error) {
	pid := n.identity.PeerID()
	if rawPeerID != "" {
		var err error
		pid, err = peer.Decode(rawPeerID)
		if err != nil {
			return contactcard.Card{}, 0, contactcard.ErrInvalid
		}
	}
	var candidates []ma.Multiaddr
	if pid == n.identity.PeerID() {
		candidates = n.net.Host().Addrs()
	} else {
		friend, found, err := n.store.GetFriend(ctx, pid.String())
		if err != nil {
			return contactcard.Card{}, 0, err
		}
		savedAddrs := friend.Addrs
		if !found {
			bootstrap, found, err := n.store.GetBootstrapPeer(ctx, pid.String())
			if err != nil {
				return contactcard.Card{}, 0, err
			}
			if !found {
				return contactcard.Card{}, 0, ErrContactNotFound
			}
			savedAddrs = bootstrap.Addrs
		}
		for _, conn := range n.net.Host().Network().ConnsToPeer(pid) {
			if conn.Stat().Direction == network.DirOutbound {
				candidates = append(candidates, conn.RemoteMultiaddr())
			}
		}
		known := n.net.KnownPeerAddrs(pid)
		slices.SortFunc(known, func(a, b ma.Multiaddr) int { return strings.Compare(a.String(), b.String()) })
		candidates = append(candidates, known...)
		for _, raw := range savedAddrs {
			if addr, err := ma.NewMultiaddr(raw); err == nil {
				candidates = append(candidates, addr)
			}
		}
	}
	card := contactcard.WithAddresses(pid, candidates, contactcard.AllScopes)
	available := card.Scopes()
	if available&contactcard.PublicScopes != contactcard.PublicScopes && pid != n.identity.PeerID() {
		saved, err := n.savedContactCard(ctx, pid)
		if err != nil {
			return contactcard.Card{}, 0, err
		}
		if len(saved.Addrs) > 0 {
			card = contactcard.WithAddresses(pid, append(card.Addrs, saved.Addrs...), contactcard.AllScopes)
			available = card.Scopes()
		}
	}
	if scopes == 0 {
		card = contactcard.Card{PeerID: pid}
	} else if available&scopes != available {
		card = contactcard.WithAddresses(pid, card.Addrs, scopes)
	}
	return card, available, nil
}

func (n *Node) savedContactCard(ctx context.Context, pid peer.ID) (contactcard.Card, error) {
	envelope, err := n.store.ContactCard(ctx, pid.String())
	if err != nil || len(envelope) == 0 {
		return contactcard.Card{}, err
	}
	card, err := contactcard.FromEnvelope(pid, envelope)
	if errors.Is(err, contactcard.ErrInvalid) {
		return contactcard.Card{}, nil
	}
	return card, err
}

func (n *Node) parseRemoteCard(code string) (contactcard.Card, error) {
	card, err := contactcard.Parse(code)
	if err == nil && card.PeerID == n.identity.PeerID() {
		return contactcard.Card{}, ErrOwnContactCard
	}
	return card, err
}

func (n *Node) PreviewContactCard(ctx context.Context, code string) (contactcard.Card, string, error) {
	card, err := n.parseRemoteCard(code)
	if err != nil {
		return card, "", err
	}
	friend, _, err := n.store.GetFriend(ctx, card.PeerID.String())
	return card, friend.Name, err
}

func (n *Node) ConnectContactCard(ctx context.Context, code string) (ConnectResult, error) {
	card, err := n.parseRemoteCard(code)
	if err != nil {
		return ConnectResult{}, err
	}
	if len(card.Envelope) > 0 {
		saved, err := n.savedContactCard(ctx, card.PeerID)
		if err != nil {
			return ConnectResult{}, err
		}
		if saved.Seq >= card.Seq {
			card = saved
		}
	}
	return n.connectTarget(ctx, card.PeerID, "", &card)
}
