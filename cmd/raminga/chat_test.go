package main

import (
	"bytes"
	"strings"
	"testing"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

func TestChatEventsDefaultHasNoTimeout(t *testing.T) {
	cmd := newChatEventsCmd()
	flag := cmd.Flags().Lookup("timeout")
	if flag == nil {
		t.Fatal("--timeout flag missing")
	}
	if flag.DefValue != "0s" {
		t.Fatalf("--timeout default = %s, want 0s (stream until Ctrl+C)", flag.DefValue)
	}
}

func TestPrintEventShowsQuotedChatText(t *testing.T) {
	var out bytes.Buffer
	ev := &apiv1.EventsResponse{
		AtUnixMs: 1,
		Body: &apiv1.EventsResponse_ChatReceived{ChatReceived: &apiv1.ChatEvent{
			MessageId:  "m1",
			FromPeerId: "peer-b",
			Text:       "hello\nworld\t\x00\x1b[31mred",
			Accepted:   true,
		}},
	}
	if err := printEvent(&out, ev, false); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, `text="hello\nworld\t\x00\x1b[31mred"`) {
		t.Fatalf("output does not contain escaped text: %q", got)
	}
	if strings.Count(got, "\n") != 1 {
		t.Fatalf("output spans multiple lines: %q", got)
	}
	if strings.Contains(got, "\x1b") {
		t.Fatalf("output contains a raw escape byte: %q", got)
	}
}

func TestPrintEventReadableAckAndConnection(t *testing.T) {
	var out bytes.Buffer
	if err := printEvent(&out, &apiv1.EventsResponse{
		AtUnixMs: 1,
		Body: &apiv1.EventsResponse_Ack{Ack: &apiv1.AckEvent{
			MessageId: "m1", PeerId: "peer-b", Accepted: true,
		}},
	}, false); err != nil {
		t.Fatal(err)
	}
	if err := printEvent(&out, &apiv1.EventsResponse{
		AtUnixMs: 2,
		Body: &apiv1.EventsResponse_Connection{Connection: &apiv1.ConnectionEvent{
			Kind: "connected", PeerId: "peer-b", Transport: "quic", Route: "direct", Direct: true,
			RemoteMultiaddr: "/ip4/11.41.0.11/udp/4001/quic-v1",
		}},
	}, false); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{"ack message_id=m1 peer=peer-b accepted=true", "connection kind=connected", "transport=quic", "route=direct", "direct=true"} {
		if !strings.Contains(got, want) {
			t.Fatalf("output %q missing %q", got, want)
		}
	}
}

func TestDHTDiagnosisEmptyTable(t *testing.T) {
	d := &apiv1.DHTStatus{Enabled: true}
	if got := dhtDiagnosis(d); !strings.Contains(got, "configure dht.bootstrap_peers or add peers") {
		t.Fatalf("diagnosis = %q", got)
	}
	d.BootstrapPeers = []string{"/ip4/1.2.3.4/tcp/4001/p2p/peer"}
	if got := dhtDiagnosis(d); !strings.Contains(got, "not connected") {
		t.Fatalf("diagnosis with bootstrap = %q", got)
	}
}
