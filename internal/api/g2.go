package api

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/node"
)

// Peers implements the Peers RPC.
func (s *Server) Peers(ctx context.Context, req *connect.Request[apiv1.PeersRequest]) (*connect.Response[apiv1.PeersResponse], error) {
	peers, err := s.backend.Peers(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := &apiv1.PeersResponse{Peers: make([]*apiv1.PeerEntry, 0, len(peers))}
	for _, p := range peers {
		if !req.Msg.GetIncludeCached() && !p.Online {
			continue
		}
		resp.Peers = append(resp.Peers, &apiv1.PeerEntry{
			PeerId:         p.PeerID,
			Addrs:          p.Addrs,
			Sources:        p.Sources,
			Online:         p.Online,
			Connectedness:  connectedness(p),
			Route:          p.Route,
			Transport:      p.Transport,
			Direct:         p.Direct,
			Limited:        p.Limited,
			RelayPeerId:    p.RelayPeerID,
			LastSeenUnixMs: p.OpenedAt.UnixMilli(),
			Direction:      p.Direction,
			Paused:         p.Paused,
		})
	}
	return connect.NewResponse(resp), nil
}

func connectedness(p node.PeerStatus) string {
	if p.Online {
		return "connected"
	}
	if len(p.Sources) > 0 {
		return "cached"
	}
	return "known"
}

// RelayStatus implements the RelayStatus RPC.
func (s *Server) RelayStatus(_ context.Context, _ *connect.Request[apiv1.RelayStatusRequest]) (*connect.Response[apiv1.RelayStatusResponse], error) {
	resp := &apiv1.RelayStatusResponse{
		Provider: relayProviderToProto(s.backend.RelayProvider()),
		Relays:   relayReservationsToProto(s.backend.RelayReservations()),
	}
	return connect.NewResponse(resp), nil
}

// DhtStatus implements the DhtStatus RPC.
func (s *Server) DhtStatus(_ context.Context, _ *connect.Request[apiv1.DhtStatusRequest]) (*connect.Response[apiv1.DhtStatusResponse], error) {
	return connect.NewResponse(&apiv1.DhtStatusResponse{Dht: dhtStatusToProto(s.backend.DHTStatus())}), nil
}

// DhtAddPeer implements the DhtAddPeer RPC.
func (s *Server) DhtAddPeer(ctx context.Context, req *connect.Request[apiv1.DhtAddPeerRequest]) (*connect.Response[apiv1.DhtAddPeerResponse], error) {
	if strings.TrimSpace(req.Msg.GetMultiaddr()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("multiaddr is required"))
	}
	entry, err := s.backend.AddPeer(ctx, req.Msg.GetMultiaddr())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&apiv1.DhtAddPeerResponse{Peer: &apiv1.DhtPeer{
		PeerId: entry.PeerID,
		Addrs:  entry.Addrs,
		Found:  true,
		Source: "manual",
	}}), nil
}

// DhtFindPeer implements the DhtFindPeer RPC.
func (s *Server) DhtFindPeer(ctx context.Context, req *connect.Request[apiv1.DhtFindPeerRequest]) (*connect.Response[apiv1.DhtFindPeerResponse], error) {
	if strings.TrimSpace(req.Msg.GetPeerId()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("peer_id is required"))
	}
	found, err := s.backend.DHTFindPeer(ctx, req.Msg.GetPeerId())
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	return connect.NewResponse(&apiv1.DhtFindPeerResponse{Peer: dhtPeerToProto(found)}), nil
}

// TestDisconnectPeer implements the test-only disconnect RPC.
func (s *Server) TestDisconnectPeer(ctx context.Context, req *connect.Request[apiv1.TestDisconnectPeerRequest]) (*connect.Response[apiv1.TestDisconnectPeerResponse], error) {
	if !s.testAPI {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("test API is disabled; start the daemon with --enable-test-api"))
	}
	if strings.TrimSpace(req.Msg.GetPeerId()) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("peer_id is required"))
	}
	if err := s.backend.Disconnect(ctx, req.Msg.GetPeerId()); err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	return connect.NewResponse(&apiv1.TestDisconnectPeerResponse{Disconnected: true}), nil
}

func networkStatusToProto(st node.NetworkStatus) *apiv1.NetworkStatus {
	out := &apiv1.NetworkStatus{
		Reachability:  st.Reachability,
		Autonat:       autoNATToProto(st.AutoNAT),
		Dcutr:         dcutrToProto(st.DCUtR),
		Relays:        relayReservationsToProto(st.Relays),
		RelayProvider: relayProviderToProto(st.RelayProvider),
		Dht:           dhtStatusToProto(st.DHT),
		Resources:     resourceToProto(st.Resources),
		Upnp:          st.UPNP,
		NatPmp:        st.NATPMP,
		Stun:          st.STUN,
	}
	for _, cached := range st.PeerCache {
		out.PeerCache = append(out.PeerCache, &apiv1.CachedPeer{
			PeerId:          cached.PeerID,
			Addrs:           cached.Addrs,
			Source:          cached.Source,
			UpdatedAtUnixMs: cached.UpdatedAt.UnixMilli(),
			ExpiresAtUnixMs: cached.ExpiresAt.UnixMilli(),
		})
	}
	return out
}

func autoNATToProto(st node.AutoNATStatus) *apiv1.AutoNATStatus {
	out := &apiv1.AutoNATStatus{
		Enabled:      st.Enabled,
		State:        st.State,
		ProbePeers:   st.ProbePeers,
		HasProbePeer: st.HasProbePeer,
		Upnp:         st.UPNP,
		NatPmp:       st.NATPMP,
		Stun:         st.STUN,
	}
	if !st.LastChanged.IsZero() {
		out.LastChangedUnixMs = st.LastChanged.UnixMilli()
	}
	return out
}

func dcutrToProto(st node.DCUtRStatus) *apiv1.DCUtRStatus {
	out := &apiv1.DCUtRStatus{
		Enabled:   st.Enabled,
		Attempts:  int32(st.Attempts),
		Successes: int32(st.Successes),
		Failures:  int32(st.Failures),
	}
	for _, peer := range st.Peers {
		out.Peers = append(out.Peers, &apiv1.DCUtRPeer{
			PeerId:             peer.PeerID,
			Status:             peer.Status,
			Attempts:           int32(peer.Attempts),
			Successes:          int32(peer.Successes),
			Failures:           int32(peer.Failures),
			CandidateAddresses: peer.CandidateAddresses,
			DirectAddress:      peer.DirectAddress,
			DirectTransport:    peer.DirectTransport,
			RelayAddress:       peer.RelayAddress,
			Error:              peer.Error,
			UpdatedAtUnixMs:    peer.UpdatedAt.UnixMilli(),
		})
	}
	for _, evt := range st.Events {
		protoEvt := &apiv1.HolePunchEvent{
			Timestamp:   evt.Timestamp,
			Type:        evt.Type,
			PeerId:      evt.PeerID,
			Error:       evt.Error,
			RemoteAddrs: evt.RemoteAddrs,
			Attempt:     int32(evt.Attempt),
			RttMs:       evt.RTTMs,
			ElapsedMs:   evt.ElapsedMs,
		}
		if evt.Success != nil {
			success := *evt.Success
			protoEvt.Success = &success
		}
		out.Events = append(out.Events, protoEvt)
	}
	return out
}

func relayReservationsToProto(relays []node.RelayReservation) []*apiv1.RelayReservation {
	out := make([]*apiv1.RelayReservation, 0, len(relays))
	for _, relay := range relays {
		item := &apiv1.RelayReservation{
			RelayPeerId:       relay.RelayPeerID,
			RelayAddr:         relay.RelayAddr,
			Status:            relay.Status,
			ReservationStatus: relay.ReservationStatus,
			Attempts:          int32(relay.Attempts),
			Successes:         int32(relay.Successes),
			Failures:          int32(relay.Failures),
			RelayedAddr:       relay.RelayedAddr,
			AdvertisedAddr:    relay.AdvertisedAddr,
			LimitDurationMs:   relay.LimitDuration.Milliseconds(),
			LimitDataBytes:    relay.LimitData,
			LastError:         relay.LastError,
			UpdatedAtUnixMs:   relay.UpdatedAt.UnixMilli(),
		}
		if !relay.ExpiresAt.IsZero() {
			item.ExpiresAtUnixMs = relay.ExpiresAt.UnixMilli()
		}
		out = append(out, item)
	}
	return out
}

func relayProviderToProto(st node.RelayProviderStatus) *apiv1.RelayProviderStatus {
	return &apiv1.RelayProviderStatus{
		Enabled:                    st.Enabled,
		MaxReservations:            int32(st.MaxReservations),
		ReservationTtlMs:           st.ReservationTTL.Milliseconds(),
		MaxReservationsPerIp:       int32(st.MaxReservationsPerIP),
		MaxReservationsPerPeer:     int32(st.MaxReservationsPerPeer),
		MaxCircuits:                int32(st.MaxCircuits),
		ReservationDataLimitBytes:  st.ReservationDataLimit,
		ReservationDurationLimitMs: st.ReservationDurationLimit.Milliseconds(),
		Error:                      st.Error,
	}
}

func dhtStatusToProto(st node.DHTStatus) *apiv1.DHTStatus {
	out := &apiv1.DHTStatus{
		Enabled:                   st.Enabled,
		Mode:                      st.Mode,
		Protocol:                  st.Protocol,
		BootstrapPeers:            st.BootstrapPeers,
		PublicBootstrapConfigured: st.PublicBootstrapConfigured,
		RoutingTablePeers:         st.RoutingTablePeers,
		RelayCandidates:           int32(st.RelayCandidates),
		LastError:                 st.LastError,
		LastLookup:                dhtPeerToProto(st.LastLookup),
		LastPublishError:          st.LastPublishError,
	}
	if !st.LastBootstrapAt.IsZero() {
		out.LastBootstrapUnixMs = st.LastBootstrapAt.UnixMilli()
	}
	if !st.LastRefreshAt.IsZero() {
		out.LastRefreshUnixMs = st.LastRefreshAt.UnixMilli()
	}
	if !st.LastPublishAt.IsZero() {
		out.LastPublishUnixMs = st.LastPublishAt.UnixMilli()
	}
	return out
}

func dhtPeerToProto(peer node.DHTPeer) *apiv1.DhtPeer {
	return &apiv1.DhtPeer{
		PeerId:    peer.PeerID,
		Addrs:     peer.Addrs,
		Found:     peer.Found,
		Source:    peer.Source,
		Error:     peer.Error,
		ElapsedMs: peer.Elapsed.Milliseconds(),
	}
}

func resourceToProto(st node.ResourceStatus) *apiv1.ResourceStatus {
	return &apiv1.ResourceStatus{
		MaxConnections:  int32(st.Limits.MaxConnections),
		MaxStreams:      int32(st.Limits.MaxStreams),
		MaxMemoryBytes:  st.Limits.MaxMemoryBytes,
		MaxFds:          int32(st.Limits.MaxFDs),
		OpenConnections: int32(st.OpenConnections),
		OpenStreams:     int32(st.OpenStreams),
		PeerstorePeers:  int32(st.PeerstorePeers),
		CacheEntries:    int32(st.CacheEntries),
		Goroutines:      int32(st.Goroutines),
		HeapAllocBytes:  st.HeapAllocBytes,
	}
}
