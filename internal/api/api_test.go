package api_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/gen/raminga/api/v1/apiv1connect"
	"github.com/Raminga/raminga/internal/api"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/api/endpoint"
	"github.com/Raminga/raminga/internal/node"
)

type fakeBackend struct {
	chatCh         chan node.Event
	lastOrigin     string
	lastRequestID  string
	disconnected   []string
	paused         []string
	friends        []node.Friend
	removePending  int
	sendCalls      int
	discoveryPage  node.PublicDiscoveryPage
	downloadOption node.DownloadOptions
}

func (f *fakeBackend) Status(context.Context) (node.Status, error) {
	return node.Status{
		PeerID:            "12D3KooWFake",
		NodeID:            "node_fake",
		ListenAddrs:       []string{"/ip4/127.0.0.1/tcp/1"},
		Version:           "test",
		ProtocolVersion:   "/raminga/http/1.0.0",
		StartedAt:         time.UnixMilli(1000),
		DataDir:           "/tmp/fake",
		GoVersion:         "go-test",
		MaxChatTextBytes:  4096,
		MaxStoredMessages: 50000,
	}, nil
}

func (f *fakeBackend) Connect(context.Context, string, string) (node.ConnectResult, error) {
	return node.ConnectResult{PeerID: "peer-b", Transport: "tcp", Direct: true}, nil
}

func (f *fakeBackend) SendChatOrigin(_ context.Context, _, _, _, origin, requestID string) (node.SendResult, error) {
	f.sendCalls++
	f.lastOrigin = origin
	f.lastRequestID = requestID
	return node.SendResult{
		MessageID: "m1", Acked: true, AckMessageID: "m1", ACKID: "a1", Error: "",
		DeliveryStatus: node.DeliveryAcked, OutboxStatus: node.DeliveryAcked, RequestID: requestID,
	}, nil
}

func (f *fakeBackend) RecentMessages(context.Context, int) ([]node.StoredMessage, error) {
	return []node.StoredMessage{{MessageID: "m1", PeerID: "peer-b", Direction: "out", Text: "hi", Acked: true, DeliveryStatus: node.DeliveryAcked}}, nil
}

func (f *fakeBackend) ListMessages(_ context.Context, peerID, _ string, _ int) (node.MessagePage, error) {
	return node.MessagePage{
		Messages:  []node.StoredMessage{{MessageID: "m1", PeerID: peerID, Direction: "out", Text: "hi", Acked: true, DeliveryStatus: node.DeliveryAcked}},
		Retention: node.MessageRetention{RetainedMessages: 1, MaxMessages: 10},
		HasMore:   true, NextBefore: "cursor-next",
	}, nil
}

func (f *fakeBackend) ListConversations(context.Context, string, int) (node.ConversationPage, error) {
	return node.ConversationPage{
		Conversations: []node.Conversation{{PeerID: "peer-b", LastMessageID: "m1", Direction: "out", Preview: "hi", DeliveryStatus: node.DeliveryAcked, MessageCount: 1}},
		Retention:     node.MessageRetention{RetainedMessages: 1, MaxMessages: 10},
	}, nil
}

func (f *fakeBackend) ListHumanOutboundPeers(context.Context, string, int) (node.HumanOutboundPage, error) {
	return node.HumanOutboundPage{Peers: []node.HumanOutboundPeer{{PeerID: "peer-b"}}}, nil
}

func (f *fakeBackend) Outbox(context.Context, int) ([]node.OutboxEntry, node.OutboxStats, error) {
	return []node.OutboxEntry{{MessageID: "m1", PeerID: "p1", Text: "queued", Status: "pending", Attempts: 1, Bytes: 6}}, node.OutboxStats{Pending: 1, PendingBytes: 6}, nil
}

func (f *fakeBackend) CancelOutbox(context.Context, string) error { return nil }

func (f *fakeBackend) Subscribe(context.Context) (<-chan node.Event, func(), error) {
	return f.chatCh, func() {}, nil
}

type testServer struct {
	dir     string
	srv     *api.Server
	backend *fakeBackend
}

func startServer(t *testing.T, testAPI bool) *testServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "rgapi-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	backend := &fakeBackend{chatCh: make(chan node.Event, 8)}
	srv, err := api.NewServer(backend, dir, testAPI, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
	})
	return &testServer{dir: dir, srv: srv, backend: backend}
}

func TestPermissionsAndStatus(t *testing.T) {
	ts := startServer(t, false)
	for _, path := range []string{api.SocketPath(ts.dir), api.TokenPath(ts.dir)} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s permissions = %o, want 600", path, perm)
		}
	}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	st, err := c.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.GetPeerId() != "12D3KooWFake" || st.GetNodeId() != "node_fake" || st.GetTestApiEnabled() {
		t.Fatalf("status = %+v", st)
	}
	current, err := time.Parse(time.RFC3339, st.GetCurrentTime())
	if err != nil {
		t.Fatalf("current_time %q is not RFC3339: %v", st.GetCurrentTime(), err)
	}
	if current.Location() != time.UTC {
		t.Fatalf("current_time %q is not UTC", st.GetCurrentTime())
	}
	if delta := time.Since(current); delta < -5*time.Second || delta > 5*time.Minute {
		t.Fatalf("current_time %q is not near now (delta %v)", st.GetCurrentTime(), delta)
	}
	if st.GetApiVersion() != api.APIVersion {
		t.Fatalf("api_version = %q, want %q", st.GetApiVersion(), api.APIVersion)
	}
}

func TestWrongAndMissingTokenRejected(t *testing.T) {
	ts := startServer(t, false)
	for name, token := range map[string]string{"missing": "", "wrong": "not-the-token"} {
		t.Run(name, func(t *testing.T) {
			code := rawStatus(t, ts.dir, token)
			if code != http.StatusUnauthorized {
				t.Fatalf("HTTP status = %d, want 401", code)
			}
		})
	}
	// Correct token is accepted.
	token, err := os.ReadFile(api.TokenPath(ts.dir))
	if err != nil {
		t.Fatal(err)
	}
	if code := rawStatus(t, ts.dir, strings.TrimSpace(string(token))); code != http.StatusOK {
		t.Fatalf("correct-token HTTP status = %d, want 200", code)
	}
}

func rawStatus(t *testing.T, dir, token string) int {
	t.Helper()
	return rawCall(t, dir, token, apiv1connect.RamingaServiceStatusProcedure)
}

func rawCall(t *testing.T, dir, token, procedure string) int {
	t.Helper()
	sock := api.SocketPath(dir)
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	req, err := http.NewRequest(http.MethodPost, "http://unix"+procedure, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatalf("raw Status: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func TestShutdownRequiresToken(t *testing.T) {
	ts := startServer(t, false)
	if code := rawCall(t, ts.dir, "", apiv1connect.RamingaServiceShutdownProcedure); code != http.StatusUnauthorized {
		t.Fatalf("Shutdown without token HTTP status = %d, want 401", code)
	}
	token, err := os.ReadFile(api.TokenPath(ts.dir))
	if err != nil {
		t.Fatal(err)
	}
	if code := rawCall(t, ts.dir, strings.TrimSpace(string(token)), apiv1connect.RamingaServiceShutdownProcedure); code != http.StatusOK {
		t.Fatalf("Shutdown with token HTTP status = %d, want 200", code)
	}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.Shutdown(context.Background())
	if err != nil || !res.GetAccepted() {
		t.Fatalf("Shutdown RPC = %+v, %v", res, err)
	}
	select {
	case <-ts.srv.ShutdownRequests():
	default:
		t.Fatal("Shutdown RPC did not reach the daemon shutdown channel")
	}
}

func TestFriendsAPI(t *testing.T) {
	ts := startServer(t, false)
	ts.backend.friends = []node.Friend{{PeerID: "peer-b", Name: "b", Description: "old"}}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	list, err := c.ListFriends(ctx)
	if err != nil || len(list.GetFriends()) != 1 || list.GetFriends()[0].GetName() != "b" {
		t.Fatalf("list=%v err=%v", list, err)
	}
	if _, err := c.SetFriendName(ctx, "peer-b", "new"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetFriendDescription(ctx, "peer-b", "desc"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetFriendName(ctx, "missing", "x"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown name code=%v", connect.CodeOf(err))
	}
	rem, err := c.RemoveFriend(ctx, "peer-b", false)
	if err != nil || !rem.GetRemoved() {
		t.Fatalf("remove=%v err=%v", rem, err)
	}
}

func friendWireBody(peerID string, field protowire.Number, value string, present bool) []byte {
	var body []byte
	body = protowire.AppendTag(body, 1, protowire.BytesType)
	body = protowire.AppendString(body, peerID)
	if present {
		body = protowire.AppendTag(body, field, protowire.BytesType)
		body = protowire.AppendString(body, value)
	}
	return body
}

// TestFriendEditPresenceSemantics pins the release-blocker contract: a missing
// optional field is InvalidArgument and never mutates, while a present empty
// field clears and old non-empty wire clients keep their field numbers.
func TestFriendEditPresenceSemantics(t *testing.T) {
	ts := startTCPTestServer(t)
	doc, found, err := endpoint.ReadIfPresent(ts.dir)
	if err != nil || !found {
		t.Fatalf("read endpoint found=%v err=%v", found, err)
	}
	ts.backend.friends = []node.Friend{{PeerID: "peer-b", Name: "alice", Description: "note"}}
	post := func(procedure string, body []byte) (int, string) {
		t.Helper()
		return rawTCPPost(t, doc, procedure, "application/proto", string(body))
	}
	unchanged := func(label, wantName, wantDescription string) {
		t.Helper()
		if len(ts.backend.friends) != 1 || ts.backend.friends[0].Name != wantName || ts.backend.friends[0].Description != wantDescription {
			t.Fatalf("%s mutated friend: %+v", label, ts.backend.friends)
		}
	}

	// Omitted name (only field 1 on the wire) is not a deletion request.
	if code, body := post(apiv1connect.RamingaServiceSetFriendNameProcedure, friendWireBody("peer-b", 2, "", false)); code != http.StatusBadRequest {
		t.Fatalf("omitted name status=%d body=%s, want 400", code, body)
	}
	unchanged("omitted name", "alice", "note")
	if code, body := post(apiv1connect.RamingaServiceSetFriendDescriptionProcedure, friendWireBody("peer-b", 2, "", false)); code != http.StatusBadRequest {
		t.Fatalf("omitted description status=%d body=%s, want 400", code, body)
	}
	unchanged("omitted description", "alice", "note")

	// Explicit empty names clear only the named field.
	if code, body := post(apiv1connect.RamingaServiceSetFriendNameProcedure, friendWireBody("peer-b", 2, "", true)); code != http.StatusOK {
		t.Fatalf("explicit empty name status=%d body=%s, want 200", code, body)
	}
	unchanged("explicit empty name", "", "note")
	if code, body := post(apiv1connect.RamingaServiceSetFriendDescriptionProcedure, friendWireBody("peer-b", 2, "", true)); code != http.StatusOK {
		t.Fatalf("explicit empty description status=%d body=%s, want 200", code, body)
	}
	unchanged("explicit empty description", "", "")

	// An old non-empty wire client uses exactly field 2 as a length-delimited
	// string; that shape must remain valid and must not clear the other field.
	if code, body := post(apiv1connect.RamingaServiceSetFriendNameProcedure, friendWireBody("peer-b", 2, "legacy", true)); code != http.StatusOK {
		t.Fatalf("old nonempty name status=%d body=%s, want 200", code, body)
	}
	unchanged("old nonempty name", "legacy", "")
	if code, body := post(apiv1connect.RamingaServiceSetFriendDescriptionProcedure, friendWireBody("peer-b", 2, "old note", true)); code != http.StatusOK {
		t.Fatalf("old nonempty description status=%d body=%s, want 200", code, body)
	}
	unchanged("old nonempty description", "legacy", "old note")

	// JSON clients use the proto3 optional JSON name without presence; omission
	// must fail the same way as binary omission.
	if code, body := rawTCPPost(t, doc, apiv1connect.RamingaServiceSetFriendNameProcedure, "application/json", `{"peerId":"peer-b"}`); code != http.StatusBadRequest {
		t.Fatalf("JSON omitted name status=%d body=%s, want 400", code, body)
	}
	unchanged("JSON omitted name", "legacy", "old note")
	if code, body := rawTCPPost(t, doc, apiv1connect.RamingaServiceSetFriendNameProcedure, "application/json", `{"peerId":"peer-b","name":""}`); code != http.StatusOK {
		t.Fatalf("JSON explicit empty name status=%d body=%s, want 200", code, body)
	}
	unchanged("JSON explicit empty name", "", "old note")
}

func TestRemoveFriendPendingOutboxAPI(t *testing.T) {
	ts := startServer(t, false)
	ts.backend.friends = []node.Friend{{PeerID: "peer-b"}}
	ts.backend.removePending = 2
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	if _, err := c.RemoveFriend(ctx, "peer-b", false); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("no cancel code=%v", connect.CodeOf(err))
	}
	res, err := c.RemoveFriend(ctx, "peer-b", true)
	if err != nil || !res.GetRemoved() {
		t.Fatalf("cancel remove=%v err=%v", res, err)
	}
}

func TestDisconnectPeerIsNormalAPI(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.DisconnectPeer(context.Background(), "peer-b")
	if err != nil {
		t.Fatalf("DisconnectPeer without test API: %v", err)
	}
	if !res.GetDisconnected() || len(ts.backend.paused) != 1 || ts.backend.paused[0] != "peer-b" {
		t.Fatalf("result=%v paused=%v", res, ts.backend.paused)
	}
}

func TestTestPingFlag(t *testing.T) {
	off := startServer(t, false)
	cOff, err := client.New(off.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer cOff.Close()
	if _, err := cOff.TestPing(context.Background(), "x"); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("TestPing without flag error = %v, want CodeUnimplemented", err)
	}

	on := startServer(t, true)
	cOn, err := client.New(on.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer cOn.Close()
	res, err := cOn.TestPing(context.Background(), "hello")
	if err != nil {
		t.Fatalf("TestPing with flag: %v", err)
	}
	if res.GetEcho() != "hello" {
		t.Fatalf("echo = %q", res.GetEcho())
	}
}

func TestEventsStreamSendsImmediateHeartbeat(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// No chat/ACK exists yet. The server must flush response headers with an
	// immediate heartbeat, so this call and the first Receive both return.
	stream, err := c.Events(ctx)
	if err != nil {
		t.Fatalf("Events without a prior event: %v", err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() {
		t.Fatalf("heartbeat Receive failed: %v", stream.Err())
	}
	if hb := stream.Msg(); !hb.GetHeartbeat() {
		t.Fatalf("first event = %+v, want heartbeat", hb)
	}

	ts.backend.chatCh <- node.Event{
		At: time.Now(),
		Chat: &node.ChatEvent{
			MessageID:  "m1",
			FromPeerID: "peer-b",
			Text:       "streamed",
			Accepted:   true,
		},
	}
	if !stream.Receive() {
		t.Fatalf("chat Receive failed: %v", stream.Err())
	}
	ev := stream.Msg()
	if ev.GetChatReceived().GetText() != "streamed" || ev.GetChatReceived().GetMessageId() != "m1" {
		t.Fatalf("event = %+v", ev)
	}
}

func TestNewServerRejectsLongSocketPath(t *testing.T) {
	longDir := filepath.Join(t.TempDir(), strings.Repeat("x", 120))
	_, err := api.NewServer(&fakeBackend{chatCh: make(chan node.Event, 1)}, longDir, false, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("long socket path unexpectedly accepted")
	}
	for _, want := range []string{"unix socket path is too long", "shorter --data-dir"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
}

func TestClientRejectsLongSocketPathBeforeToken(t *testing.T) {
	longDir := filepath.Join(t.TempDir(), strings.Repeat("y", 120))
	_, err := client.New(longDir)
	if err == nil {
		t.Fatal("long client socket path unexpectedly accepted")
	}
	if !strings.Contains(err.Error(), "unix socket path is too long") {
		t.Fatalf("error = %v, want socket-path validation", err)
	}
}

func TestEnsureTokenStable(t *testing.T) {
	dir := t.TempDir()
	tok1, err := api.EnsureToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(tok1) != 64 {
		t.Fatalf("token length = %d", len(tok1))
	}
	tok2, err := api.EnsureToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	if tok1 != tok2 {
		t.Fatal("token changed on reload")
	}
	info, err := os.Stat(filepath.Join(dir, api.TokenFileName))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token permissions = %o", perm)
	}
}

func TestClientMissingToken(t *testing.T) {
	_, err := client.New(t.TempDir())
	if err == nil {
		t.Fatal("client without token unexpectedly succeeded")
	}
	if !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "no such file") {
		t.Logf("missing-token error (acceptable): %v", err)
	}
}

func (f *fakeBackend) Peers(context.Context) ([]node.PeerStatus, error) {
	return []node.PeerStatus{{PeerID: "peer-b", Online: true, Route: "direct", Transport: "tcp", Direct: true}}, nil
}

func (f *fakeBackend) RelayReservations() []node.RelayReservation { return nil }

func (f *fakeBackend) RelayProvider() node.RelayProviderStatus {
	return node.RelayProviderStatus{Enabled: false}
}

func (f *fakeBackend) AddPeer(_ context.Context, multiaddr string) (node.PeerEntry, error) {
	return node.PeerEntry{PeerID: "peer-b", Addrs: []string{multiaddr}, Sources: []string{"manual"}}, nil
}

func (f *fakeBackend) DHTStatus() node.DHTStatus {
	return node.DHTStatus{Enabled: true, Mode: "client", Protocol: "/raminga/kad/1.0.0"}
}

func (f *fakeBackend) DHTFindPeer(context.Context, string) (node.DHTPeer, error) {
	return node.DHTPeer{PeerID: "peer-b", Found: true, Source: "dht"}, nil
}

func (f *fakeBackend) PausePeer(_ context.Context, peerID string) error {
	f.paused = append(f.paused, peerID)
	return nil
}

func (f *fakeBackend) Disconnect(_ context.Context, peerID string) error {
	f.disconnected = append(f.disconnected, peerID)
	return nil
}

func FuzzAPIRequestDecoding(f *testing.F) {
	// Real Connect-RPC clients send protobuf; these seeds cover valid and
	// hostile wire bytes for the request messages exposed on the UDS API.
	f.Add([]byte{})
	f.Add([]byte{0x0a, 0x03, 'a', 'b', 'c'})
	f.Add([]byte{0x08, 0x01})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff, 0x07})
	f.Fuzz(func(t *testing.T, data []byte) {
		var status apiv1.StatusRequest
		_ = proto.Unmarshal(data, &status)
		var connectReq apiv1.ConnectRequest
		if err := proto.Unmarshal(data, &connectReq); err == nil {
			_ = connectReq.GetPeerId()
			_ = connectReq.GetMultiaddr()
		}
		var send apiv1.SendChatRequest
		if err := proto.Unmarshal(data, &send); err == nil {
			_ = send.GetPeerId()
			_ = send.GetMultiaddr()
			_ = send.GetText()
		}
		var recent apiv1.RecentMessagesRequest
		if err := proto.Unmarshal(data, &recent); err == nil {
			_ = recent.GetLimit()
		}
		var jsonReq apiv1.SendChatRequest
		_ = protojson.Unmarshal(data, &jsonReq)
	})
}

func TestOutboxListAndCancel(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	list, err := c.OutboxList(context.Background(), 10)
	if err != nil {
		t.Fatalf("OutboxList: %v", err)
	}
	if len(list.GetEntries()) != 1 || list.GetEntries()[0].GetStatus() != "pending" ||
		list.GetStats().GetPending() != 1 {
		t.Fatalf("outbox = %+v", list)
	}
	cancel, err := c.OutboxCancel(context.Background(), "m1")
	if err != nil || !cancel.GetCancelled() {
		t.Fatalf("OutboxCancel = %+v, %v", cancel, err)
	}
}

func (f *fakeBackend) ListFriends(context.Context) ([]node.Friend, error) { return f.friends, nil }
func (f *fakeBackend) SetFriendName(_ context.Context, peerID, name string) (node.Friend, error) {
	for i := range f.friends {
		if f.friends[i].PeerID == peerID {
			f.friends[i].Name = name
			return f.friends[i], nil
		}
	}
	return node.Friend{}, node.ErrFriendNotFound
}
func (f *fakeBackend) SetFriendDescription(_ context.Context, peerID, description string) (node.Friend, error) {
	for i := range f.friends {
		if f.friends[i].PeerID == peerID {
			f.friends[i].Description = description
			return f.friends[i], nil
		}
	}
	return node.Friend{}, node.ErrFriendNotFound
}
func (f *fakeBackend) SyncFriends(context.Context) (bool, error) { return true, nil }

func (f *fakeBackend) RemoveFriend(_ context.Context, peerID string, cancelPending bool) (bool, int, error) {
	if f.removePending > 0 && !cancelPending {
		return false, f.removePending, node.ErrFriendPendingOutbox
	}
	for i := range f.friends {
		if f.friends[i].PeerID == peerID {
			f.friends = append(f.friends[:i], f.friends[i+1:]...)
			return true, 0, nil
		}
	}
	return false, 0, node.ErrFriendNotFound
}

func TestSyncFriendsAPI(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.SyncFriends(context.Background())
	if err != nil || !res.GetWritten() {
		t.Fatalf("sync=%v err=%v", res, err)
	}
}

func (f *fakeBackend) Published(context.Context) (node.Published, error) {
	return node.Published{
		Files:       []node.PublishedFile{{Path: "posts/a.txt", Size: 3}},
		Skipped:     []node.PublishedSkip{{Path: "posts/.hidden", Reason: "hidden name"}},
		GeneratedAt: time.UnixMilli(2000), FriendsSyncedAt: time.UnixMilli(3000),
	}, nil
}

func (f *fakeBackend) GetPeerManifest(context.Context, string, int, int) (node.PeerManifest, error) {
	return node.PeerManifest{PeerID: "peer-b", Version: 1, Total: 0, Entries: nil}, nil
}
func (f *fakeBackend) GetPeerProfile(context.Context, string) (node.PeerProfile, error) {
	return node.PeerProfile{PeerID: "peer-b", Name: "B"}, nil
}
func (f *fakeBackend) GetPeerFriends(context.Context, string) (node.PeerFriends, error) {
	return node.PeerFriends{PeerID: "peer-b"}, nil
}
func (f *fakeBackend) ListDiscoveries(context.Context, string, int, bool) (node.PublicDiscoveryPage, error) {
	return f.discoveryPage, nil
}

func (f *fakeBackend) DownloadPeerFile(_ context.Context, _ string, _ string, progress func(node.DownloadProgress), options node.DownloadOptions) (node.DownloadResult, error) {
	f.downloadOption = options
	if progress != nil {
		progress(node.DownloadProgress{Phase: "download", Received: 1, Total: 1})
	}
	return node.DownloadResult{
		PeerID: "peer-b", Path: "a", LocalPath: "/tmp/a", Size: 1, SHA256: "aa",
		DiscoveryID: 7, DiscoveryRecorded: options.RecordDiscovery,
	}, nil
}
func (f *fakeBackend) ConnectListedPeer(context.Context, string, []string) (node.ConnectResult, error) {
	return node.ConnectResult{PeerID: "peer-b"}, nil
}

func TestClientDaemonNotRunningHintAndCause(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "rgapi-down-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if _, err := api.EnsureToken(dir); err != nil {
		t.Fatal(err)
	}
	c, err := client.New(dir)
	if err != nil {
		t.Fatalf("client.New with token: %v", err)
	}
	defer c.Close()
	_, err = c.Status(context.Background())
	if err == nil {
		t.Fatal("status without a daemon unexpectedly succeeded")
	}
	var notRunning *client.DaemonNotRunningError
	if !errors.As(err, &notRunning) {
		t.Fatalf("typed daemon-not-running error missing: %v", err)
	}
	for _, want := range []string{"节点未运行", "raminga daemon --data-dir", dir} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
	if notRunning.Unwrap() == nil {
		t.Fatal("underlying dial error was not preserved")
	}
	// Missing token uses the same actionable hint.
	missing, err := os.MkdirTemp("/tmp", "rgapi-missing-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(missing) })
	if _, err := client.New(missing); err == nil || !client.IsDaemonNotRunning(err) {
		t.Fatalf("missing token error = %v, want daemon-not-running hint", err)
	}
}

func TestPublishedRPCAndClient(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.Published(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.GetFiles()) != 1 || res.GetFiles()[0].GetPath() != "posts/a.txt" {
		t.Fatalf("files = %+v", res.GetFiles())
	}
	if len(res.GetSkipped()) != 1 || res.GetSkipped()[0].GetReason() != "hidden name" {
		t.Fatalf("skipped = %+v", res.GetSkipped())
	}
	if res.GetFriendsSyncedAtUnixMs() != 3000 {
		t.Fatalf("friends_synced_at = %d", res.GetFriendsSyncedAtUnixMs())
	}
}

func TestAgentOriginSendGuardRejectsPrivateData(t *testing.T) {
	ts := startServer(t, false)
	persona := "I am a calm and curious agent who prefers long walks and short questions.\n"
	if err := os.MkdirAll(filepath.Join(ts.dir, "agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ts.dir, "agent", "persona.md"), []byte(persona), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()

	snippet := "calm and curious agent who prefers long walks and short questions"
	if _, err := c.SendChatFromAgent(ctx, "peer-b", "", "repeat: "+snippet); err == nil {
		t.Fatal("agent send of persona text unexpectedly succeeded")
	} else if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "可能是远端内容诱导") {
		t.Fatalf("persona rejection = %v (code %v)", err, connect.CodeOf(err))
	}
	for _, text := range []string{
		"read /Users/example/secret.txt",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
	} {
		if _, err := c.SendChatFromAgent(ctx, "peer-b", "", text); err == nil {
			t.Fatalf("agent send %q unexpectedly succeeded", text)
		} else if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("agent send %q code = %v, want permission denied", text, connect.CodeOf(err))
		}
	}
	// The human path must remain unchanged, even for the same private text.
	if _, err := c.SendChat(ctx, "peer-b", "", "repeat: "+snippet); err != nil {
		t.Fatalf("human send was blocked: %v", err)
	}
	if ts.backend.sendCalls != 1 {
		t.Fatalf("backend sendCalls = %d, want only the human send", ts.backend.sendCalls)
	}
}

func TestAgentOriginSendGuardRateLimitOverRPC(t *testing.T) {
	ts := startServer(t, false)
	c, err := client.New(ts.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if _, err := c.SendChatFromAgent(ctx, "peer-b", "", "hello"); err != nil {
			t.Fatalf("agent send %d rejected: %v", i+1, err)
		}
	}
	if _, err := c.SendChatFromAgent(ctx, "peer-b", "", "hello"); err == nil {
		t.Fatal("11th agent send unexpectedly succeeded")
	} else if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "10") {
		t.Fatalf("rate rejection = %v (code %v)", err, connect.CodeOf(err))
	}
	// Human sends are not counted against the agent budget.
	if _, err := c.SendChat(ctx, "peer-b", "", "hello"); err != nil {
		t.Fatalf("human send was blocked: %v", err)
	}
}
