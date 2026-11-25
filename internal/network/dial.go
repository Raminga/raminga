package network

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/p2p/net/swarm"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/pkg/publicpeeraddr"
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
	dhtRecordTimeout = 8 * time.Second
	dhtFindTimeout   = 10 * time.Second
	lanDialTimeout   = 2 * time.Second
	sourceExplicit   = "explicit"
	sourcePeerStore  = "peerstore"
	sourceCache      = "cache"
	sourceCard       = "share_code"
	sourceDHT        = "dht"
)

// DialPeerByID dials a peer using addresses from the in-memory PeerStore, the
// SQLite hint cache and the Raminga DHT. The swarm staggers direct and relay
// dials and returns the first connection that succeeds.
func (n *Network) DialPeerByID(ctx context.Context, pid peer.ID) (DialOutcome, error) {
	return n.dialPeer(ctx, pid, nil, nil)
}

type dialHints struct {
	addrs     []ma.Multiaddr
	temporary bool
}

func (n *Network) DialContactCard(ctx context.Context, pid peer.ID, addrs []ma.Multiaddr, temporary bool) (DialOutcome, error) {
	return n.dialPeer(ctx, pid, nil, &dialHints{addrs: addrs, temporary: temporary})
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
	return n.dialPeer(ctx, ai.ID, ai.Addrs, nil)
}

func (n *Network) dialPeer(ctx context.Context, pid peer.ID, explicit []ma.Multiaddr, card *dialHints) (DialOutcome, error) {
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

	// An explicit dial temporarily isolates one address in the shared peerstore.
	// Keep user dials serialized around that operation.
	n.dialMu.Lock()
	defer n.dialMu.Unlock()

	if info, err := n.connectionInfo(pid); err == nil {
		out := DialOutcome{ConnInfo: info, Reused: true, RequestedTransport: requested, Source: "existing"}
		if requested != "" && info.Transport != requested {
			out.TransportChanged = true
			out.Note = fmt.Sprintf("reused an existing %s connection instead of dialing the requested %s path", info.Transport, requested)
		}
		return out, nil
	}

	totalTimeout := n.totalDialTimeout
	if totalTimeout <= 0 {
		totalTimeout = DefaultDialTimeout
	}
	dialCtx, cancel := withDefaultTimeout(ctx, totalTimeout)
	defer cancel()
	if len(explicit) > 0 {
		return n.dialExplicit(dialCtx, pid, explicit[0])
	}
	known := n.resolveCandidates(dialCtx, pid)
	var lan []dialCandidate
	if card != nil {
		seen := make(map[string]bool, len(known)+len(card.addrs))
		for _, candidate := range known {
			seen[candidate.addr.String()] = true
		}
		var newHints []ma.Multiaddr
		for _, addr := range card.addrs {
			if local := publicpeeraddr.NormalizeLAN(addr, pid); len(local) > 0 {
				if !onLocalSubnet(local) {
					continue
				}
				lan = append(lan, dialCandidate{addr: addr, source: sourceCard})
			}
			if key := addr.String(); !seen[key] {
				known = append(known, dialCandidate{addr: addr, source: sourceCard})
				newHints = append(newHints, addr)
				seen[key] = true
			}
		}
		if card.temporary && len(newHints) > 0 {
			n.mu.Lock()
			n.cardDialHints = peer.AddrInfo{ID: pid, Addrs: newHints}
			n.mu.Unlock()
			defer n.clearCardDialHints()
		}
		sortCandidates(known)
	}
	var lanAttempts []DialAttempt
	if len(lan) > 0 {
		lanCtx, stop := context.WithTimeout(dialCtx, lanDialTimeout)
		out, err := n.dialBatch(lanCtx, pid, lan)
		stop()
		if err == nil {
			return out, nil
		}
		lanAttempts = out.Attempts
	}
	out, err := n.dialPeerID(dialCtx, pid, known, card != nil)
	out.Attempts = append(lanAttempts, out.Attempts...)
	return out, err
}

func onLocalSubnet(addr ma.Multiaddr) bool {
	ip := net.IP(addr[0].RawValue())
	addresses, _ := net.InterfaceAddrs()
	for _, address := range addresses {
		if subnet, ok := address.(*net.IPNet); ok && subnet.Contains(ip) {
			return true
		}
	}
	return false
}

// Clear only the addresses introduced by this dial. An address used by an
// authenticated connection or learned from its signed Identify record is kept.
func (n *Network) clearCardDialHints() {
	n.mu.Lock()
	defer n.mu.Unlock()
	pid := n.cardDialHints.ID
	ps := n.host.Peerstore()
	var authenticated []ma.Multiaddr
	for _, conn := range n.host.Network().ConnsToPeer(pid) {
		authenticated = append(authenticated, conn.RemoteMultiaddr())
	}
	if cab, ok := peerstore.GetCertifiedAddrBook(ps); ok {
		if env := cab.GetPeerRecord(pid); env != nil {
			if rec, err := env.Record(); err == nil {
				if info, ok := rec.(*peer.PeerRecord); ok {
					authenticated = append(authenticated, info.Addrs...)
				}
			}
		}
	}
	for _, addr := range n.cardDialHints.Addrs {
		if !hasMultiaddr(authenticated, addr) {
			ps.SetAddr(pid, addr, 0)
		}
	}
	n.cardDialHints = peer.AddrInfo{}
}

func hasMultiaddr(addrs []ma.Multiaddr, addr ma.Multiaddr) bool {
	return slices.ContainsFunc(addrs, addr.Equal)
}

func (n *Network) dialExplicit(ctx context.Context, pid peer.ID, addr ma.Multiaddr) (DialOutcome, error) {
	out := DialOutcome{RequestedTransport: transportOf(addr)}
	candidate := dialCandidate{addr: addr, source: sourceExplicit}
	original := n.host.Peerstore().Addrs(pid)
	n.host.Peerstore().ClearAddrs(pid)
	n.host.Peerstore().AddAddr(pid, addr, peerstore.TempAddrTTL)
	err := n.host.Connect(ctx, peer.AddrInfo{ID: pid})
	if err == nil {
		original = append(original, addr)
	}
	n.host.Peerstore().AddAddrs(pid, original, peerstore.PermanentAddrTTL)
	if err != nil {
		out.Attempts = []DialAttempt{failedDialAttempt(candidate, err)}
		out.Note = out.Attempts[0].Note
		return out, fmt.Errorf("dial peer %s failed: %s", pid, formatAttempts(out.Attempts))
	}
	info, err := n.connectionInfo(pid)
	if err != nil {
		return out, err
	}
	out.ConnInfo = info
	out.Source = sourceExplicit
	family := candidateFamily(addr)
	if family != "relay" && family != candidateFamilyOfString(info.RemoteAddr) {
		out.Reused = true
		out.Source = "existing"
		out.Note = fmt.Sprintf("swarm used an existing %s connection at %s", candidateFamilyOfString(info.RemoteAddr), info.RemoteAddr)
	} else {
		out.Attempts = []DialAttempt{{Multiaddr: addr.String(), Source: sourceExplicit, Family: family, OK: true}}
	}
	out.TransportChanged = out.RequestedTransport != "" && info.Transport != out.RequestedTransport
	if out.TransportChanged && out.Note == "" {
		out.Note = fmt.Sprintf("requested %s but the established connection uses %s", out.RequestedTransport, info.Transport)
	}
	return out, nil
}

type dialBatchResult struct {
	out DialOutcome
	err error
}

func (n *Network) dialPeerID(ctx context.Context, pid peer.ID, known []dialCandidate, fromCard bool) (DialOutcome, error) {
	canLookup := n.cfg.DHT.Enabled && n.dht != nil && !n.IsPaused(pid)
	if !canLookup {
		return n.dialBatch(ctx, pid, known)
	}
	seen := make(map[string]struct{}, len(known))
	for _, candidate := range known {
		seen[candidate.addr.String()] = struct{}{}
	}
	if len(known) == 0 {
		return n.dialDiscovered(ctx, pid, nil, seen, fromCard)
	}

	// Known addresses get a head start. DHT lookup can then add candidates to
	// the same swarm dial without interrupting pending known-address attempts.
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer func() {
		cancel()
		workers.Wait()
	}()
	results := make(chan dialBatchResult, 2)
	workers.Go(func() {
		knownCtx := ctx
		if n.knownDialBudget > 0 {
			var stop context.CancelFunc
			knownCtx, stop = context.WithTimeout(ctx, n.knownDialBudget)
			defer stop()
		}
		out, err := n.dialBatch(knownCtx, pid, known)
		results <- dialBatchResult{out, err}
	})

	timer := time.NewTimer(swarm.RelayDelay)
	defer timer.Stop()
	lookup := timer.C
	startLookup := func() {
		lookup = nil
		workers.Go(func() {
			out, err := n.dialDiscovered(ctx, pid, known, seen, fromCard)
			results <- dialBatchResult{out, err}
		})
	}

	var out DialOutcome
	var failures error
	for received := 0; received < 2; {
		select {
		case <-lookup:
			startLookup()
		case result := <-results:
			received++
			if result.err == nil {
				result.out.Attempts = append(out.Attempts, result.out.Attempts...)
				return result.out, nil
			}
			out.Attempts = append(out.Attempts, result.out.Attempts...)
			failures = errors.Join(failures, result.err)
			if lookup != nil {
				startLookup()
			}
		case <-ctx.Done():
			return out, errors.Join(failures, ctx.Err())
		}
	}
	return out, failures
}

// dialDiscovered prefers the signed DHT record. A card can outlive both its
// own record and a cached DHT record, so try peer routing after either fails.
func (n *Network) dialDiscovered(ctx context.Context, pid peer.ID, known []dialCandidate, seen map[string]struct{}, fromCard bool) (DialOutcome, error) {
	signed := n.resolveDHTCandidates(ctx, pid, seen, fromCard, true)
	out := DialOutcome{}
	err := errors.New("DHT returned no new dial addresses")
	if len(signed) > 0 {
		out, err = n.dialBatch(ctx, pid, append(append([]dialCandidate(nil), known...), signed...))
		if err == nil || !fromCard {
			return out, err
		}
	}
	if ctx.Err() != nil {
		return out, errors.Join(err, ctx.Err())
	}
	discovered := n.resolveDHTCandidates(ctx, pid, seen, fromCard, false)
	if len(discovered) == 0 {
		return out, err
	}
	result, findErr := n.dialBatch(ctx, pid, append(append([]dialCandidate(nil), known...), discovered...))
	result.Attempts = append(out.Attempts, result.Attempts...)
	if findErr == nil {
		return result, nil
	}
	return result, errors.Join(err, findErr)
}

func (n *Network) dialBatch(ctx context.Context, pid peer.ID, candidates []dialCandidate) (DialOutcome, error) {
	if len(candidates) == 0 {
		return DialOutcome{}, fmt.Errorf("no dial addresses for peer %s", pid)
	}
	byAddr := make(map[string]dialCandidate, len(candidates))
	addrs := make([]ma.Multiaddr, 0, len(candidates))
	for _, candidate := range candidates {
		addrs = append(addrs, candidate.addr)
		byAddr[candidate.addr.String()] = candidate
	}
	// Let the swarm schedule candidates together. Short-lived hints leave
	// existing peerstore addresses alone, including those learned by Identify.
	n.host.Peerstore().AddAddrs(pid, addrs, peerstore.TempAddrTTL)
	conn, err := n.host.Network().DialPeer(network.WithAllowLimitedConn(ctx, "Raminga peer dial"), pid)
	if err != nil {
		var out DialOutcome
		var dialErr *swarm.DialError
		if errors.As(err, &dialErr) {
			for _, failure := range dialErr.DialErrors {
				candidate := byAddr[failure.Address.String()]
				if candidate.addr == nil {
					candidate = dialCandidate{addr: failure.Address, source: sourcePeerStore}
				}
				attempt := failedDialAttempt(candidate, failure.Cause)
				out.Attempts = append(out.Attempts, attempt)
				if attempt.Backoff {
					out.Note = attempt.Note
				}
			}
		}
		return out, fmt.Errorf("dial peer %s: %w", pid, err)
	}

	info := connInfo(conn)
	candidate, found := byAddr[info.RemoteAddr]
	if !found && info.Route == "relay" {
		// The swarm may reuse an existing connection to the relay itself.
		// Its remote address can then differ from the published circuit address.
		for _, entry := range candidates {
			if route, relayID := routeOfConn(entry.addr); route == "relay" && relayID != "" && relayID == info.RelayPeerID {
				candidate, found = entry, true
				break
			}
		}
	}
	if !found {
		candidate.source = sourcePeerStore
	}
	attempt := DialAttempt{
		Multiaddr: info.RemoteAddr, Source: candidate.source,
		Family: candidateFamilyOfString(info.RemoteAddr), OK: true,
	}
	return DialOutcome{ConnInfo: info, Source: candidate.source, Attempts: []DialAttempt{attempt}}, nil
}

func failedDialAttempt(candidate dialCandidate, err error) DialAttempt {
	attempt := DialAttempt{
		Multiaddr: candidate.addr.String(), Source: candidate.source,
		Family: candidateFamily(candidate.addr), Error: err.Error(), Backoff: isDialBackoff(err),
	}
	if attempt.Backoff {
		attempt.Note = dialBackoffNote()
	}
	return attempt
}

// Keep libp2p's address ordering and Happy Eyeballs timings. Apply its relay
// delay to mixed private/direct batches too, which the default ranker exempts.
func rankDialAddresses(addrs []ma.Multiaddr) []network.AddrDelay {
	ranked := swarm.DefaultDialRanker(addrs)
	firstDirect := time.Duration(-1)
	for _, addr := range ranked {
		if candidateFamily(addr.Addr) != "relay" && (firstDirect < 0 || addr.Delay < firstDirect) {
			firstDirect = addr.Delay
		}
	}
	if firstDirect >= 0 {
		for i := range ranked {
			if candidateFamily(ranked[i].Addr) == "relay" {
				ranked[i].Delay = max(ranked[i].Delay, firstDirect+swarm.RelayDelay)
			}
		}
	}
	return ranked
}

func (n *Network) resolveCandidates(ctx context.Context, pid peer.ID) []dialCandidate {
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
	return out
}

func (n *Network) resolveDHTCandidates(ctx context.Context, pid peer.ID, seen map[string]struct{}, publicOnly, signed bool) []dialCandidate {
	if !n.cfg.DHT.Enabled || n.dht == nil || n.IsPaused(pid) {
		return nil
	}
	out := make([]dialCandidate, 0, 16)
	appendRaw := func(raw string) {
		addr, err := ma.NewMultiaddr(raw)
		if err != nil || addr == nil || !usableDialAddr(addr) {
			return
		}
		if publicOnly {
			addr = publicpeeraddr.Normalize(addr, pid)
			if len(addr) == 0 {
				return
			}
		}
		key := addr.String()
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, dialCandidate{addr: addr, source: sourceDHT})
	}
	var addrs []string
	if signed {
		lookupCtx, cancel := context.WithTimeout(ctx, dhtRecordTimeout)
		addrs, _ = n.dht.AddressesFromDHT(lookupCtx, pid)
		cancel()
	} else {
		findCtx, cancel := context.WithTimeout(ctx, dhtFindTimeout)
		defer cancel()
		if found := n.dht.FindPeer(findCtx, pid); found.Found && (!publicOnly || found.Source == sourceDHT) {
			addrs = found.Addrs
		}
	}
	for _, raw := range addrs {
		appendRaw(raw)
		if len(out) == 16 {
			break
		}
	}
	sortCandidates(out)
	return out
}

// sortCandidates orders direct IPv6 first, then direct IPv4/DNS, then relay
// addresses. Within a family prefer PeerStore, share code, cache, then DHT.
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
	case sourceCard:
		return 1
	case sourceCache:
		return 2
	case sourceDHT:
		return 3
	default:
		return 4
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
