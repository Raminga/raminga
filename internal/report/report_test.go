package report_test

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
	"time"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/report"
)

const (
	testToken     = "0123456789abcdef0123456789abcdef"
	testText      = "G45-SECRET-TEXT-\x1b[31mred"
	testPrivKey   = "-----BEGIN PRIVATE KEY-----"
	testPeer      = "12D3KooWTestPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	testRelayPeer = "12D3KooWTestRelayBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)

func sampleStatus(relayOnly bool) *apiv1.StatusResponse {
	route := "direct"
	direct, limited := true, false
	transport := "quic"
	if relayOnly {
		route, direct, limited, transport = "relay", false, true, "tcp"
	}
	return &apiv1.StatusResponse{
		PeerId:          testPeer,
		NodeId:          "node-1",
		Version:         "test-version",
		ProtocolVersion: "/raminga/http/1.0.0",
		ListenAddrs:     []string{"/ip4/0.0.0.0/tcp/4001"},
		AdvertisedAddrs: []string{"/ip4/203.0.113.1/tcp/4001"},
		Network: &apiv1.NetworkStatus{
			Reachability: "unknown",
			Autonat:      &apiv1.AutoNATStatus{Enabled: true, State: "unknown"},
			Dcutr:        &apiv1.DCUtRStatus{Enabled: true, Attempts: 2, Successes: 0, Failures: 2},
			Relays: []*apiv1.RelayReservation{{
				RelayPeerId:       testRelayPeer,
				RelayAddr:         "/ip4/203.0.113.2/tcp/4001/p2p/" + testRelayPeer,
				Status:            "active",
				ReservationStatus: "active",
				RelayedAddr:       "/ip4/203.0.113.2/tcp/4001/p2p/" + testRelayPeer + "/p2p-circuit/p2p/" + testPeer,
			}},
			Dht:       &apiv1.DHTStatus{Enabled: true, Mode: "client", Protocol: "/raminga/kad/1.0.0", LastError: "bootstrap failed: \x1b[2J"},
			Resources: &apiv1.ResourceStatus{MaxConnections: 256, MaxStreams: 1024, MaxFds: 256, Goroutines: 12},
			PeerCache: []*apiv1.CachedPeer{{PeerId: testRelayPeer, Source: "known"}},
		},
		Peers: []*apiv1.PeerStatus{{
			PeerId: testPeer, Route: route, Transport: transport, Direct: direct, Limited: limited, Online: true, Direction: "outbound",
		}},
	}
}

func samplePeers(relayOnly bool) *apiv1.PeersResponse {
	route := "direct"
	direct, limited := true, false
	transport := "quic"
	if relayOnly {
		route, direct, limited, transport = "relay", false, true, "tcp"
	}
	return &apiv1.PeersResponse{Peers: []*apiv1.PeerEntry{{
		PeerId:      testPeer,
		Addrs:       []string{"/ip4/198.51.100.2/udp/4001/quic-v1"},
		Online:      true,
		Route:       route,
		Transport:   transport,
		Direct:      direct,
		Limited:     limited,
		Direction:   "outbound",
		RelayPeerId: testRelayPeer,
	}}}
}

func sampleMessages(includeText bool) *apiv1.RecentMessagesResponse {
	m := &apiv1.StoredMessage{
		MessageId:       "m-1",
		PeerId:          testPeer,
		Direction:       "out",
		Text:            testText,
		Acked:           true,
		CreatedAtUnixMs: 1000,
		AckedAtUnixMs:   1100,
	}
	return &apiv1.RecentMessagesResponse{Messages: []*apiv1.StoredMessage{m}}
}

func sampleOutbox() *apiv1.OutboxListResponse {
	return &apiv1.OutboxListResponse{
		Entries: []*apiv1.OutboxEntry{{
			MessageId: "m-2", PeerId: testPeer, Text: testText, Status: "pending",
			LastError: "deadline exceeded: \x1b]52;c;SGVsbG8=\x07", Bytes: 12,
		}},
		Stats: &apiv1.OutboxStats{Pending: 1, PendingBytes: 12},
	}
}

func opts(includeText bool) report.Options {
	return report.Options{
		Version:     "test-version",
		IncludeText: includeText,
		Timeline: []report.Event{{
			At: "2026-10-30T00:00:00Z", Kind: "connection", PeerID: testPeer,
			Route: "relay", Transport: "tcp", Limited: true, Detail: "relay \x1b[31mconnected",
		}},
		RouteChanges: []report.Change{{At: "2026-10-30T00:00:01Z", PeerID: testPeer, From: "relay", To: "direct", Transport: "quic"}},
		ACKs: []report.ACK{{
			At: "2026-10-30T00:00:02Z", MessageID: "m-1", PeerID: testPeer,
			Acked: true, Route: "direct", Transport: "quic", Text: testText,
		}},
		Now: time.Date(2026, 10, 30, 0, 0, 3, 0, time.UTC),
	}
}

func TestReportOmitsTextAndSecretsAndMatchesSchema(t *testing.T) {
	r := report.Build(sampleStatus(false), samplePeers(false), sampleMessages(false), sampleOutbox(), opts(false))
	data, err := report.JSON(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{testText, testToken, testPrivKey, "\x1b"} {
		if bytes.Contains(data, []byte(marker)) {
			t.Fatalf("redacted report contains forbidden marker %q:\n%s", marker, data)
		}
	}
	if r.MessageTextIncluded {
		t.Fatal("message_text_included should be false")
	}
	if r.StillDirectAfterRelayStop != nil {
		t.Fatal("still_direct_after_relay_stop must be nil when not observed")
	}
	schema, err := filepath.Abs(filepath.Join("..", "..", "docs", "schemas", "test-report.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := report.ValidateFile(data, schema); err != nil {
		t.Fatalf("schema validation: %v\n%s", err, data)
	}
}

func TestReportIncludeTextAndStillDirectMatchesSchema(t *testing.T) {
	yes := true
	o := opts(true)
	o.StillDirectAfterRelayStop = &yes
	o.StillDirectObservationSeconds = 12
	r := report.Build(sampleStatus(false), samplePeers(false), sampleMessages(true), sampleOutbox(), o)
	data, err := report.JSON(r)
	if err != nil {
		t.Fatal(err)
	}
	if !r.MessageTextIncluded {
		t.Fatal("message_text_included should be true")
	}
	if !bytes.Contains(data, []byte("G45-SECRET-TEXT")) {
		t.Fatal("opted-in text missing from report")
	}
	// Even opted-in text must be JSON-encoded without a raw ESC byte.
	if bytes.Contains(data, []byte{0x1b}) {
		t.Fatal("report JSON contains a raw ESC byte")
	}
	schema, err := filepath.Abs(filepath.Join("..", "..", "docs", "schemas", "test-report.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := report.ValidateFile(data, schema); err != nil {
		t.Fatalf("schema validation: %v\n%s", err, data)
	}
}

func TestMarkdownEscapesControlCharsAndText(t *testing.T) {
	r := report.Build(sampleStatus(true), samplePeers(true), sampleMessages(false), sampleOutbox(), opts(false))
	md := report.Markdown(r)
	if bytes.Contains(md, []byte{0x1b}) || bytes.Contains(md, []byte{0x07}) {
		t.Fatalf("markdown contains a raw control byte:\n%s", md)
	}
	if bytes.Contains(md, []byte("G45-SECRET-TEXT")) {
		t.Fatalf("markdown leaked message text:\n%s", md)
	}
	if !bytes.Contains(md, []byte("Only a relay path")) {
		t.Fatalf("markdown lacks relay explanation:\n%s", md)
	}
	if !bytes.Contains(md, []byte("TCP direct BLOCKED")) {
		t.Fatalf("markdown lacks TCP BLOCKED explanation:\n%s", md)
	}
}

func TestMarkdownWithTextStaysTerminalSafe(t *testing.T) {
	yes := true
	o := opts(true)
	o.StillDirectAfterRelayStop = &yes
	r := report.Build(sampleStatus(false), samplePeers(false), sampleMessages(true), sampleOutbox(), o)
	md := report.Markdown(r)
	if bytes.Contains(md, []byte{0x1b}) || bytes.Contains(md, []byte{0x07}) {
		t.Fatalf("markdown contains a raw control byte:\n%s", md)
	}
	if !strings.Contains(string(md), "G45-SECRET-TEXT-red") {
		t.Fatalf("opted-in text should be present with ANSI stripped:\n%s", md)
	}
}

func TestValidateRejectsBrokenReport(t *testing.T) {
	schema, err := filepath.Abs(filepath.Join("..", "..", "docs", "schemas", "test-report.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	err = report.ValidateFile([]byte(`{"schema_version":"wrong"}`), schema)
	if err == nil {
		t.Fatal("invalid report unexpectedly validated")
	}
}

func TestEmptyReportArraysMatchSchema(t *testing.T) {
	r := report.Build(sampleStatus(false), &apiv1.PeersResponse{}, &apiv1.RecentMessagesResponse{}, &apiv1.OutboxListResponse{}, report.Options{Version: "test"})
	data, err := report.JSON(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"peers": null`, `"connection_timeline": null`, `"route_changes": null`, `"acks": null`, `"messages": null`, `"entries": null`} {
		if bytes.Contains(data, []byte(field)) {
			t.Fatalf("empty report contains %s:\n%s", field, data)
		}
	}
	schema, err := filepath.Abs(filepath.Join("..", "..", "docs", "schemas", "test-report.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := report.ValidateFile(data, schema); err != nil {
		t.Fatalf("empty report schema: %v\n%s", err, data)
	}
}
