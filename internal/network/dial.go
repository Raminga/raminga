package network

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	ma "github.com/multiformats/go-multiaddr"
)

// DialAttempt is one candidate address dialed for a peer. It is exposed through
// the local API so callers can see which family/address worked or failed.
type DialAttempt struct {
	Multiaddr string
	Source    string
	Family    string
	OK        bool
	Error     string
	Backoff   bool
	Note      string
}

// DialOutcome is the result of dialing one peer. Reused is true when an
// already-open connection was returned without a new dial.
type DialOutcome struct {
	ConnInfo
	Reused             bool
	RequestedTransport string
	TransportChanged   bool
	Source             string
	Attempts           []DialAttempt
	Note               string
}

type dialCandidate struct {
	addr   ma.Multiaddr
	source string
}

const (
	candidateDialTimeout = 5 * time.Second
	dhtRecordTimeout     = 8 * time.Second
	dhtFindTimeout       = 10 * time.Second
	sourceExplicit       = "explicit"
	sourcePeerStore      = "peerstore"
	sourceCache          = "cache"
	sourceDHT            = "dht"
)

// DialPeerByID dials a peer using addresses from the in-memory PeerStore, the
// SQLite hint cache and, when no address is known, the Raminga DHT. Candidates
// are ordered IPv6-first and each one is dialed separately so failures are
// reported with the address family that failed.
func (n *Network) DialPeerByID(ctx context.Context, pid peer.ID) (DialOutcome, error) {
	return n.dialPeer(ctx, pid, nil)
}

// DialMultiaddr dials one explicit multiaddr. It does not append PeerStore or
// DHT candidates: an explicit target is expected to fail honestly if that path
// is blocked.
func (n *Network) DialMultiaddr(ctx context.Context, raw string) (DialOutcome, error) {
	m, err := ma.NewMultiaddr(raw)
	if err != nil {
		return DialOutcome{}, fmt.Errorf("invalid peer multiaddr %q: %w", raw, err)
	}
	ai, err := peer.AddrInfoFromP2pAddr(m)
	if err != nil {
		return DialOutcome{}, fmt.Errorf("peer multiaddr %q must include /p2p/<peer-id>: %w", raw, err)
	}
	return n.dialPeer(ctx, ai.ID, ai.Addrs)
}

func (n *Network) dialPeer(ctx context.Context, pid peer.ID, explicit []ma.Multiaddr) (DialOutcome, error) {
	if pid == "" {
		return DialOutcome{}, errors.New("peer ID is required")
	}
	if pid == n.host.ID() {
		return DialOutcome{}, errors.New("refusing to dial self")
	}

	requested := ""
	if len(explicit) > 0 {
		requested = transportOf(explicit[0])
	}

	if info, err := n.connectionInfo(pid); err == nil {
		out := DialOutcome{
			ConnInfo:           info,
			Reused:             true,
			RequestedTransport: requested,
			Source:             "existing",
		}
		if requested != "" && info.Transport != requested {
			out.TransportChanged = true
			out.Note = fmt.Sprintf("reused an existing %s connection instead of dialing the requested %s path", info.Transport, requested)
		}
		return out, nil
	}

	candidates, err := n.resolveCandidates(ctx, pid, explicit)
	if err != nil {
		return DialOutcome{}, err
	}

	totalTimeout := n.totalDialTimeout
	if totalTimeout <= 0 {
		totalTimeout = 30 * time.Second
	}
	totalCtx, totalCancel := withDefaultTimeout(ctx, totalTimeout)
	defer totalCancel()
	knownBudget := totalTimeout
	if n.cfg.DHT.Enabled && n.dht != nil && !n.IsPaused(pid) && n.knownDialBudget > 0 {
		knownBudget = n.knownDialBudget
	}
	if knownBudget > totalTimeout {
		knownBudget = totalTimeout
	}
	knownCtx, knownCancel := context.WithTimeout(totalCtx, knownBudget)
	defer knownCancel()

	// host.Connect absorbs AddrInfo into the shared PeerStore and then dials
	// every PeerStore address, so a single-address AddrInfo does not restrict
	// the attempt. Serialize explicit candidate dials and temporarily set only
	// the candidate address, restoring the real PeerStore entries afterwards.
	// This keeps the in-memory PeerStore as the single address source while
	// still reporting each candidate's real outcome.
	n.dialMu.Lock()
	defer n.dialMu.Unlock()

	out := DialOutcome{RequestedTransport: requested}
	var notes []string
	dhtTried := false
	attempted := make(map[string]struct{}, len(candidates))
	for {
		for _, candidate := range candidates {
			attempted[candidate.addr.String()] = struct{}{}
			attempt := DialAttempt{
				Multiaddr: candidate.addr.String(),
				Source:    candidate.source,
				Family:    candidateFamily(candidate.addr),
			}
			remaining := time.Until(deadlineOf(knownCtx))
			if remaining <= 0 {
				attempt.Error = "overall dial deadline exceeded before this candidate"
				out.Attempts = append(out.Attempts, attempt)
				break
			}
			perCandidate := n.candidateTimeout
			if perCandidate <= 0 {
				perCandidate = candidateDialTimeout
			}
			if len(explicit) > 0 {
				perCandidate = DefaultDialTimeout
			}
			if perCandidate > remaining {
				perCandidate = remaining
			}
			original := n.host.Peerstore().Addrs(pid)
			// SetAddrs does not remove addresses that are absent from the slice;
			// clear first so host.Connect only sees this candidate.
			n.host.Peerstore().ClearAddrs(pid)
			n.host.Peerstore().SetAddrs(pid, []ma.Multiaddr{candidate.addr}, peerstore.TempAddrTTL)
			attemptCtx, attemptCancel := context.WithTimeout(knownCtx, perCandidate)
			var err error
			if n.testDial != nil {
				err = n.testDial(attemptCtx, pid, candidate.addr)
			} else {
				err = n.host.Connect(attemptCtx, peer.AddrInfo{ID: pid})
			}
			attemptCancel()
			restore := append([]ma.Multiaddr(nil), original...)
			if err == nil {
				restore = append(restore, candidate.addr)
			}
			n.host.Peerstore().SetAddrs(pid, dedupeMultiaddrs(restore), peerstore.PermanentAddrTTL)
			if err != nil {
				attempt.Error = err.Error()
				if isDialBackoff(err) {
					attempt.Backoff = true
					attempt.Note = dialBackoffNote()
					notes = append(notes, attempt.Note)
				}
				out.Attempts = append(out.Attempts, attempt)
				continue
			}
			info, infoErr := n.connectionInfo(pid)
			if infoErr != nil {
				return out, infoErr
			}
			if actual := candidateFamilyOfString(info.RemoteAddr); actual != attempt.Family && attempt.Family != "relay" {
				attempt.Error = fmt.Sprintf("swarm reused an existing %s connection at %s instead of dialing this candidate", actual, info.RemoteAddr)
				out.Attempts = append(out.Attempts, attempt)
				out.ConnInfo = info
				out.Reused = true
				out.Source = "existing"
				out.Note = attempt.Error
				return out, nil
			}
			attempt.OK = true
			out.Attempts = append(out.Attempts, attempt)
			out.ConnInfo = info
			out.Source = candidate.source
			if requested != "" && info.Transport != requested {
				out.TransportChanged = true
				out.Note = fmt.Sprintf("requested %s but the established connection uses %s", requested, info.Transport)
			}
			return out, nil
		}
		if dhtTried {
			break
		}
		dhtTried = true
		fallback := n.resolveDHTCandidates(totalCtx, pid, attempted)
		if len(fallback) == 0 {
			break
		}
		candidates = fallback
	}

	out.Note = strings.Join(dedupeStrings(notes), " ")
	return out, fmt.Errorf("dial peer %s failed after %d candidate(s): %s; peer may be offline or its address is stale", pid, len(out.Attempts), formatAttempts(out.Attempts))
}

func (n *Network) resolveCandidates(ctx context.Context, pid peer.ID, explicit []ma.Multiaddr) ([]dialCandidate, error) {
	if len(explicit) > 0 {
		out := make([]dialCandidate, 0, len(explicit))
		for _, addr := range explicit {
			out = append(out, dialCandidate{addr: addr, source: sourceExplicit})
		}
		sortCandidates(out)
		return out, nil
	}

	out := make([]dialCandidate, 0, 8)
	seen := make(map[string]struct{})

	cacheAddrs := make(map[string]struct{})
	if n.cfg.PeerCache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		entries, err := n.cfg.PeerCache.LoadPeerCache(cacheCtx)
		cancel()
		if err == nil {
			for _, entry := range entries {
				if entry.PeerID != pid.String() {
					continue
				}
				if !entry.ExpiresAt.IsZero() && entry.ExpiresAt.Before(time.Now()) {
					continue
				}
				for _, raw := range entry.Addrs {
					addr, parseErr := ma.NewMultiaddr(raw)
					if parseErr != nil {
						continue
					}
					cacheAddrs[addr.String()] = struct{}{}
					if _, ok := seen[addr.String()]; ok {
						continue
					}
					seen[addr.String()] = struct{}{}
					out = append(out, dialCandidate{addr: addr, source: sourceCache})
				}
			}
		}
	}

	for _, addr := range n.host.Peerstore().Addrs(pid) {
		key := addr.String()
		if _, ok := seen[key]; ok {
			continue
		}
		source := sourcePeerStore
		if _, cached := cacheAddrs[key]; cached {
			source = sourceCache
		}
		seen[key] = struct{}{}
		out = append(out, dialCandidate{addr: addr, source: source})
	}

	sortCandidates(out)
	return out, nil
}

// resolveDHTCandidates is the fallback after every known candidate failed.
// It reads the signed record first, then uses the existing FindPeer path.
func (n *Network) resolveDHTCandidates(ctx context.Context, pid peer.ID, seen map[string]struct{}) []dialCandidate {
	if !n.cfg.DHT.Enabled || n.dht == nil || n.IsPaused(pid) {
		return nil
	}
	out := make([]dialCandidate, 0, 16)
	appendRaw := func(raw string) {
		addr, err := ma.NewMultiaddr(raw)
		if err != nil || addr == nil || !usableDialAddr(addr) {
			return
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, dialCandidate{addr: addr, source: sourceDHT})
	}
	lookupCtx, lookupCancel := context.WithTimeout(ctx, dhtRecordTimeout)
	addrs, lookupErr := n.dht.AddressesFromDHT(lookupCtx, pid)
	lookupCancel()
	if lookupErr == nil {
		for _, raw := range addrs {
			appendRaw(raw)
			if len(out) == 16 {
				break
			}
		}
	}
	if len(out) == 0 {
		if found := n.dht.FindPeer(ctx, pid); found.Found {
			for _, raw := range found.Addrs {
				appendRaw(raw)
				if len(out) == 16 {
					break
				}
			}
		}
	}
	sortCandidates(out)
	return out
}

// sortCandidates orders direct IPv6 first, then direct IPv4/DNS, then relay
// addresses. Within a family the PeerStore is preferred over cache then DHT.
func sortCandidates(candidates []dialCandidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		fi, fj := familyRank(candidateFamily(candidates[i].addr)), familyRank(candidateFamily(candidates[j].addr))
		if fi != fj {
			return fi < fj
		}
		si, sj := sourceRank(candidates[i].source), sourceRank(candidates[j].source)
		if si != sj {
			return si < sj
		}
		return candidates[i].addr.String() < candidates[j].addr.String()
	})
}

func familyRank(family string) int {
	switch family {
	case "ipv6":
		return 0
	case "ipv4":
		return 1
	case "dns":
		return 2
	case "relay":
		return 3
	default:
		return 4
	}
}

func sourceRank(source string) int {
	switch source {
	case sourceExplicit, sourcePeerStore:
		return 0
	case sourceCache:
		return 1
	case sourceDHT:
		return 2
	default:
		return 3
	}
}

func candidateFamily(addr ma.Multiaddr) string {
	if strings.Contains(addr.String(), "p2p-circuit") {
		return "relay"
	}
	for _, protocol := range addr.Protocols() {
		switch protocol.Name {
		case "ip6":
			return "ipv6"
		case "ip4":
			return "ipv4"
		case "dns", "dns4", "dns6":
			return "dns"
		}
	}
	return "unknown"
}

func isDialBackoff(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "backoff") || strings.Contains(text, "backing off")
}

func dialBackoffNote() string {
	return "go-libp2p dial backoff: this peer/address recently failed, so the dial was refused. The public API does not expose the remaining duration; wait a few seconds and retry."
}

func dedupeMultiaddrs(addrs []ma.Multiaddr) []ma.Multiaddr {
	seen := make(map[string]struct{}, len(addrs))
	out := make([]ma.Multiaddr, 0, len(addrs))
	for _, addr := range addrs {
		if addr == nil {
			continue
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, addr)
	}
	return out
}

func candidateFamilyOfString(raw string) string {
	addr, err := ma.NewMultiaddr(raw)
	if err != nil {
		return "unknown"
	}
	return candidateFamily(addr)
}

func formatAttempts(attempts []DialAttempt) string {
	parts := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		reason := attempt.Error
		if reason == "" {
			reason = "ok"
		}
		parts = append(parts, fmt.Sprintf("%s source=%s family=%s: %s", attempt.Multiaddr, attempt.Source, attempt.Family, reason))
	}
	return strings.Join(parts, "; ")
}

func deadlineOf(ctx context.Context) time.Time {
	deadline, ok := ctx.Deadline()
	if !ok {
		return time.Now().Add(DefaultDialTimeout)
	}
	return deadline
}
