package tui

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	osc52 "github.com/aymanbagabas/go-osc52/v2"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/teatest"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
)

const (
	fakePeer  = "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"
	fakePeer2 = "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"
	fakeRelay = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN"
)

type fakeStream struct {
	ch   chan *apiv1.EventsResponse
	done chan struct{}
	once sync.Once
}

func newFakeStream() *fakeStream {
	return &fakeStream{ch: make(chan *apiv1.EventsResponse, 8), done: make(chan struct{})}
}
func (f *fakeStream) Recv() (*apiv1.EventsResponse, error) {
	select {
	case ev := <-f.ch:
		return ev, nil
	case <-f.done:
		return nil, fmt.Errorf("closed")
	}
}
func (f *fakeStream) Close() error { f.once.Do(func() { close(f.done) }); return nil }

type fakeClient struct {
	mu               sync.Mutex
	peers            []*apiv1.PeerEntry
	messages         []*apiv1.StoredMessage
	outbox           *apiv1.OutboxListResponse
	friends          []*apiv1.Friend
	downloadProgress []*apiv1.DownloadPeerFileResponse
	stream           *fakeStream
	sent             []string
	disconnected     []string
	connectPeer      string
	connectAddr      string
	dhtAddrs         []string
}

func newFake() *fakeClient {
	return &fakeClient{
		stream: newFakeStream(),
		peers: []*apiv1.PeerEntry{{
			PeerId: fakePeer, Online: true, Route: "direct", Transport: "quic",
			Direct: true, Limited: false, Direction: "outbound",
			Addrs: []string{"/ip4/198.51.100.2/udp/4001/quic-v1"},
		}},
		friends: []*apiv1.Friend{{Name: "b-quic", PeerId: fakePeer, Addrs: []string{"/ip4/198.51.100.2/udp/4001/quic-v1"}}},
		outbox:  &apiv1.OutboxListResponse{Stats: &apiv1.OutboxStats{}},
	}
}

func (f *fakeClient) Status(context.Context) (*apiv1.StatusResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &apiv1.StatusResponse{
		PeerId: fakePeer2, NodeId: "node-1", Version: "test", ProtocolVersion: "/raminga/http/1.0.0",
		DataDir: "/tmp/fake", ListenAddrs: []string{"/ip4/127.0.0.1/tcp/4001"},
		AdvertisedAddrs: []string{"/ip4/1.1.1.1/tcp/4001"},
		Network: &apiv1.NetworkStatus{
			Reachability: "unknown",
			Autonat:      &apiv1.AutoNATStatus{Enabled: true, State: "unknown"},
			Dcutr:        &apiv1.DCUtRStatus{Enabled: true, Attempts: 2, Successes: 0, Failures: 2},
			Dht:          &apiv1.DHTStatus{Enabled: true, Mode: "client", Protocol: "/raminga/kad/1.0.0"},
			Resources:    &apiv1.ResourceStatus{MaxConnections: 256, MaxStreams: 1024, MaxFds: 256, Goroutines: 12},
		},
	}, nil
}
func (f *fakeClient) Peers(context.Context, bool) (*apiv1.PeersResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &apiv1.PeersResponse{Peers: append([]*apiv1.PeerEntry(nil), f.peers...)}, nil
}
func (f *fakeClient) Connect(_ context.Context, peerID, multiaddr string) (*apiv1.ConnectResponse, error) {
	f.mu.Lock()
	f.connectPeer, f.connectAddr = peerID, multiaddr
	f.mu.Unlock()
	return &apiv1.ConnectResponse{PeerId: fakePeer, Route: "direct", Transport: "quic", Direct: true, RemoteMultiaddr: "/ip4/198.51.100.2/udp/4001/quic-v1"}, nil
}
func (f *fakeClient) DisconnectPeer(_ context.Context, peerID string) (*apiv1.DisconnectPeerResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disconnected = append(f.disconnected, peerID)
	return &apiv1.DisconnectPeerResponse{Disconnected: true}, nil
}

func (f *fakeClient) SendChat(_ context.Context, _, _, text string) (*apiv1.SendChatResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, text)
	return &apiv1.SendChatResponse{MessageId: "m-1", Acked: true, Route: "direct", Transport: "quic", OutboxStatus: "acked"}, nil
}
func (f *fakeClient) RecentMessages(context.Context, uint32) (*apiv1.RecentMessagesResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &apiv1.RecentMessagesResponse{Messages: append([]*apiv1.StoredMessage(nil), f.messages...)}, nil
}
func (f *fakeClient) OutboxList(context.Context, uint32) (*apiv1.OutboxListResponse, error) {
	return f.outbox, nil
}
func (f *fakeClient) OutboxCancel(context.Context, string) (*apiv1.OutboxCancelResponse, error) {
	return &apiv1.OutboxCancelResponse{Cancelled: true, Status: "cancelled"}, nil
}
func (f *fakeClient) RelayStatus(context.Context) (*apiv1.RelayStatusResponse, error) {
	return &apiv1.RelayStatusResponse{}, nil
}
func (f *fakeClient) DhtAddPeer(_ context.Context, addr string) (*apiv1.DhtAddPeerResponse, error) {
	f.mu.Lock()
	f.dhtAddrs = append(f.dhtAddrs, addr)
	f.mu.Unlock()
	return &apiv1.DhtAddPeerResponse{}, nil
}
func (f *fakeClient) ListFriends(context.Context) (*apiv1.ListFriendsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &apiv1.ListFriendsResponse{Friends: append([]*apiv1.Friend(nil), f.friends...)}, nil
}
func (f *fakeClient) SetFriendName(_ context.Context, peerID, name string) (*apiv1.SetFriendNameResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, friend := range f.friends {
		if friend.GetPeerId() == peerID {
			friend.Name = name
			return &apiv1.SetFriendNameResponse{Friend: friend}, nil
		}
	}
	return nil, fmt.Errorf("friend not found")
}
func (f *fakeClient) SetFriendDescription(_ context.Context, peerID, description string) (*apiv1.SetFriendDescriptionResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, friend := range f.friends {
		if friend.GetPeerId() == peerID {
			friend.Description = description
			return &apiv1.SetFriendDescriptionResponse{Friend: friend}, nil
		}
	}
	return nil, fmt.Errorf("friend not found")
}
func (f *fakeClient) RemoveFriend(_ context.Context, peerID string, _ bool) (*apiv1.RemoveFriendResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, friend := range f.friends {
		if friend.GetPeerId() == peerID {
			f.friends = append(f.friends[:i], f.friends[i+1:]...)
			return &apiv1.RemoveFriendResponse{Removed: true}, nil
		}
	}
	return nil, fmt.Errorf("friend not found")
}
func (f *fakeClient) SyncFriends(context.Context) (*apiv1.SyncFriendsResponse, error) {
	return &apiv1.SyncFriendsResponse{Written: true}, nil
}
func (f *fakeClient) Events(context.Context) (EventStream, error) { return f.stream, nil }
func (f *fakeClient) Close()                                      {}

func testModel(t *testing.T) *Model {
	t.Helper()
	f := newFake()
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	m := NewModel(f, Options{Version: "test", Plain: true, Tick: time.Hour, Now: func() time.Time { return now }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st, _ := f.Status(context.Background())
	peers, _ := f.Peers(context.Background(), true)
	friends, _ := f.ListFriends(context.Background())
	m.applyRefresh(refreshMsg{status: st, peers: peers, friends: friends, at: now})
	return m
}

func TestPopupFiltersCommandsAndCompletes(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/con")
	m.updatePopup()
	if !m.popup.active || len(m.popup.items) == 0 || m.popup.items[0].Insert != "/connect " {
		t.Fatalf("popup = %+v", m.popup)
	}
	if cmd, quit := m.completeSelected(); cmd != nil || quit {
		t.Fatal("completion returned command/quit")
	}
	if got := m.input.Value(); got != "/connect " {
		t.Fatalf("input = %q", got)
	}
	m.updatePopup()
	if !m.popup.active {
		t.Fatal("peer popup should open")
	}
	for _, it := range m.popup.items {
		if it.Insert == "b-quic" {
			return
		}
	}
	t.Fatalf("name b-quic not in popup: %+v", m.popup.items)
}

// Regression (manual dualnat walk): Enter on a fully typed "/connect b-quic"
// accepts the single matching argument and submits. The command stage instead
// takes the highlighted command without running it when it needs arguments.
func TestEnterWithArgumentPopupSubmits(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/connect b-quic")
	m.updatePopup()
	if !m.popup.active {
		t.Fatal("name popup should be open")
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.input.Value(); got != "" {
		t.Fatalf("input not submitted: %q", got)
	}
	if len(m.history) != 1 || strings.TrimSpace(m.history[0]) != "/connect b-quic" {
		t.Fatalf("history = %q", m.history)
	}
	m.input.SetValue("/con")
	m.updatePopup()
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.input.Value(); got != "/connect " {
		t.Fatalf("command-stage Enter = %q, want /connect ", got)
	}
	if !m.popup.active {
		t.Fatal("argument completion should be shown after taking /connect")
	}
	if cmd, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyTab}); cmd != nil || quit {
		t.Fatal("Tab should only complete")
	}
	if got := m.input.Value(); got != "/connect b-quic " {
		t.Fatalf("Tab completion = %q", got)
	}
}

func TestEnterCommandStageNeverNoOp(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/")
	m.updatePopup()
	if !m.popup.active || m.popup.items[0].Insert != "/connect " {
		t.Fatalf("startup popup = %+v", m.popup)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.input.Value(); got != "/connect " {
		t.Fatalf("/ + Enter = %q, want /connect ", got)
	}
	if !m.popup.active {
		t.Fatal("/connect should show argument completion")
	}

	m.input.SetValue("/")
	m.updatePopup()
	m.handleKey(tea.KeyMsg{Type: tea.KeyDown}) // highlight /disconnect
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.input.Value(); got != "/disconnect " {
		t.Fatalf("highlighted command = %q, want /disconnect ", got)
	}

	m.input.SetValue("/")
	m.updatePopup()
	for m.popup.items[m.popup.sel].Insert != "/status" && m.popup.sel < len(m.popup.items)-1 {
		m.popupMove(1)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if m.input.Value() != "" {
		t.Fatalf("argless highlighted command was not run: %q", m.input.Value())
	}
	if !logContains(m, "本机：") {
		t.Fatalf("argless highlighted command did not execute: %v", m.log)
	}
}

func TestMissingRequiredArgWithoutPopupPrintsUsage(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/connect")
	m.updatePopup()
	if !m.popup.active {
		t.Fatal("command popup should be open")
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if m.popup.active {
		t.Fatal("Esc did not close the popup")
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if !logContains(m, "用法：/connect") {
		t.Fatalf("missing required argument was a silent no-op: %v", m.log)
	}
	if m.input.Value() != "" {
		t.Fatalf("usage command was not submitted: %q", m.input.Value())
	}
}

func TestEnterArgumentStageUsesSelectionOrTypedLine(t *testing.T) {
	m := testModel(t)
	m.friends = append(m.friends,
		&apiv1.Friend{Name: "b-two", PeerId: fakePeer2},
	)
	m.input.SetValue("/chat b-")
	m.updatePopup()
	if !m.popup.active || len(m.popup.items) < 2 {
		t.Fatalf("expected multiple peer candidates: %+v", m.popup)
	}
	m.handleKey(tea.KeyMsg{Type: tea.KeyDown})
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if m.target == nil || m.target.Name != "b-two" {
		t.Fatalf("highlighted argument was not accepted/run: target=%+v log=%v", m.target, m.log)
	}

	m2 := testModel(t)
	m2.friends = append(m2.friends,
		&apiv1.Friend{Name: "b-two", PeerId: fakePeer2},
	)
	m2.input.SetValue("/chat b")
	m2.updatePopup()
	m2.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if m2.target != nil {
		t.Fatalf("unmoved multi-candidate Enter must run the typed line, not select: %+v", m2.target)
	}
	if len(m2.history) != 1 || m2.history[0] != "/chat b" {
		t.Fatalf("typed line was not submitted as typed: %q", m2.history)
	}

	m3 := testModel(t)
	m3.input.SetValue("/chat b-")
	m3.updatePopup()
	m3.popupMove(1) // single candidate: popupMove cannot change it
	m3.popup.moved = true
	m3.input.SetValue("/chat no-such-candidate")
	m3.updatePopup()
	if m3.popup.moved {
		t.Fatal("selection movement was not reset when candidates changed")
	}
}

func TestAddrCommandRemoved(t *testing.T) {
	for _, c := range commands {
		if c.Name == "/addr" {
			t.Fatal("/addr is still registered")
		}
	}
	if _, ok, _ := resolveCommand("/addr"); ok {
		t.Fatal("/addr still resolves")
	}
}

func TestPrefixCommandsAndAmbiguity(t *testing.T) {
	m := testModel(t)
	if _, _ = m.execCommand("/st"); !logContains(m, "本机：") {
		t.Fatalf("prefix /st did not run status: %v", m.log)
	}
	if _, _ = m.execCommand("/c"); !logContains(m, "歧义") {
		t.Fatalf("ambiguous /c not rejected: %v", m.log)
	}
}

func TestHistoryNavigation(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/status")
	if _, quit := m.submit(); quit || len(m.history) != 1 {
		t.Fatal("history not recorded")
	}
	m.input.SetValue("/help")
	_, _ = m.submit()
	m.historyPrev()
	if m.input.Value() != "/help" {
		t.Fatalf("history prev = %q", m.input.Value())
	}
	m.historyPrev()
	if m.input.Value() != "/status" {
		t.Fatalf("history prev2 = %q", m.input.Value())
	}
}

func TestPlainTextNeedsTargetAndSends(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("hello")
	if _, quit := m.submit(); quit || !logContains(m, "还没有聊天对象") {
		t.Fatalf("missing target hint: %v", m.log)
	}
	m.cmdChat("b-quic")
	m.input.SetValue("hello")
	cmd, _ := m.submit()
	if cmd == nil {
		t.Fatal("send produced no command")
	}
	m.Update(cmd())
	if !logContains(m, "→ b-quic：hello ✓") {
		t.Fatalf("ACK log missing: %v", m.log)
	}
}

func TestLongLinesAreNotWrappedAndStaySanitized(t *testing.T) {
	m := testModel(t)
	m.log = nil
	m.pending = nil
	long := "测试中文长行：" + strings.Repeat("这是很长的中文消息，用于检查换行。", 8)
	m.appendLog("%s", long)
	m.appendLog("远端：hello\x1b[31mred\x07\u202eoverride")
	if len(m.pending) != 2 {
		t.Fatalf("pending lines = %d, want 2", len(m.pending))
	}
	if !strings.Contains(m.log[0].Text, strings.TrimPrefix(long, "测试中文长行：")) {
		t.Fatalf("long line was split or truncated: %q", m.log[0].Text)
	}
	for _, line := range m.pending {
		rendered := m.renderLogLine(line)
		if strings.Contains(rendered, "\n") {
			t.Fatalf("program inserted a line break: %q", rendered)
		}
		if strings.Contains(rendered, "\x1b") || strings.Contains(rendered, "\x07") {
			t.Fatalf("raw control survived: %q", rendered)
		}
	}
	if ansi.StringWidth(m.renderLogLine(m.pending[0])) <= 80 {
		t.Fatal("test line should be wider than 80 columns")
	}
}

func TestKeysAfterConnectStillWork(t *testing.T) {
	m := testModel(t)
	m.busy = true
	m.Update(connectResultMsg{res: &apiv1.ConnectResponse{PeerId: fakePeer, Route: "direct", Transport: "quic", Direct: true}})
	if m.busy {
		t.Fatal("connect result left busy")
	}
	m.input.SetValue("/status")
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !logContains(m, "本机：") {
		t.Fatalf("keys after connect were not processed: %v", m.log)
	}
}

func TestHintAndStatusFit80(t *testing.T) {
	m := testModel(t)
	if w := ansi.StringWidth(m.hintLine()); w > 80 {
		t.Fatalf("hint width %d: %q", w, m.hintLine())
	}
	if w := ansi.StringWidth(m.statusLine()); w > 80 {
		t.Fatalf("status width %d: %q", w, m.statusLine())
	}
}

func TestGoldenMainScreen(t *testing.T) {
	m := testModel(t)
	m.appendLog("✓ 已经中继 r1 连接（受限）")
	m.appendLog("✓ 已升级为 QUIC 直连 /ip4/198.51.100.2/udp/4001/quic-v1")
	m.appendLog("← b-quic：你好，测试消息")
	m.input.SetValue("/")
	m.updatePopup()
	teatest.RequireEqualOutput(t, []byte(m.View()))
}

func TestTeatestSlashFlow(t *testing.T) {
	m := testModel(t)
	m.opts.Tick = 50 * time.Millisecond
	tm := teatest.NewTestModel(t, m, teatest.WithInitialTermSize(80, 24))
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool { return bytes.Contains(b, []byte("Raminga")) }, teatest.WithDuration(3*time.Second))
	tm.Type("/status")
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool { return bytes.Contains(b, []byte("本机：")) }, teatest.WithDuration(3*time.Second))
	tm.Type("/chat b-quic")
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	tm.Type("hello teatest")
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool { return bytes.Contains(b, []byte("→ b-quic：hello teatest")) }, teatest.WithDuration(3*time.Second))
	tm.Type("/quit")
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))
}

func logContains(m *Model, sub string) bool {
	for _, l := range m.log {
		if strings.Contains(l.Text, sub) {
			return true
		}
	}
	return false
}

func logIndex(m *Model, sub string) int {
	for i, l := range m.log {
		if strings.Contains(l.Text, sub) {
			return i
		}
	}
	return -1
}

func TestStartupSummaryAndRecentMessagesOldestFirst(t *testing.T) {
	f := newFake()
	at := time.Date(2026, 10, 31, 1, 2, 3, 0, time.UTC)
	f.messages = []*apiv1.StoredMessage{
		{MessageId: "m2", PeerId: fakePeer, Direction: "in", Text: "second\x1b[31m", CreatedAtUnixMs: at.Add(2 * time.Second).UnixMilli()},
		{MessageId: "m1", PeerId: fakePeer, Direction: "out", Text: "first", CreatedAtUnixMs: at.UnixMilli()},
	}
	m := NewModel(f, Options{Version: "v9", Plain: true, Tick: time.Hour, Now: func() time.Time { return at.Add(time.Hour) }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(m.refreshCmd()())
	if !logContains(m, "Raminga v9 · 我 ") || !logContains(m, "连接 1") {
		t.Fatalf("startup summary missing: %v", m.log)
	}
	if !logContains(m, "最近消息：") {
		t.Fatalf("recent-messages header missing: %v", m.log)
	}
	first, second := logIndex(m, "→ b-quic：first"), logIndex(m, "← b-quic：second")
	if first < 0 || second < 0 {
		t.Fatalf("recent messages missing: %v", m.log)
	}
	if first > second {
		t.Fatalf("recent messages are not oldest first: %v", m.log)
	}
	if got := m.log[second].Text; strings.Contains(got, "\x1b") {
		t.Fatalf("stored message was not sanitized: %q", got)
	}
	if !m.log[second].Event || !m.log[second].At.Equal(at.Add(2*time.Second)) {
		t.Fatalf("history timestamp = %v event=%t, want real stored time", m.log[second].At, m.log[second].Event)
	}
	before := 0
	for _, line := range m.log {
		if strings.Contains(line.Text, "← b-quic：second") {
			before++
		}
	}
	m.handleEvent(&apiv1.EventsResponse{AtUnixMs: at.Add(3 * time.Second).UnixMilli(), Body: &apiv1.EventsResponse_ChatReceived{
		ChatReceived: &apiv1.ChatEvent{MessageId: "m2", FromPeerId: fakePeer, Text: "second", Accepted: true},
	}})
	after := 0
	for _, line := range m.log {
		if strings.Contains(line.Text, "← b-quic：second") {
			after++
		}
	}
	if after != before {
		t.Fatalf("history/event duplicate printed twice: before=%d after=%d", before, after)
	}
}

func TestStartupWithoutMessagesPrintsNoRecentSection(t *testing.T) {
	f := newFake()
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	m := NewModel(f, Options{Version: "test", Plain: true, Tick: time.Hour, Now: func() time.Time { return now }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(m.refreshCmd()())
	if !logContains(m, "Raminga test · 我 ") {
		t.Fatalf("startup summary missing: %v", m.log)
	}
	if logContains(m, "最近消息：") {
		t.Fatalf("empty history printed a recent-messages section: %v", m.log)
	}
}

func TestStartupVersionMismatchWarnsOnce(t *testing.T) {
	f := newFake()
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	m := NewModel(f, Options{Version: "v-program", Plain: true, Tick: time.Hour, Now: func() time.Time { return now }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(m.refreshCmd()())
	want := "! 节点版本 test 与当前程序 v-program 不同；运行 raminga restart 切换到新版本"
	count := func() int {
		n := 0
		for _, line := range m.log {
			if line.Text == want {
				n++
			}
		}
		return n
	}
	if got := count(); got != 1 {
		t.Fatalf("version mismatch warning count = %d, want 1: %v", got, m.log)
	}
	m.Update(m.refreshCmd()())
	if got := count(); got != 1 {
		t.Fatalf("version mismatch warning repeated: count = %d", got)
	}
}

func TestStartupVersionMatchDoesNotWarn(t *testing.T) {
	f := newFake()
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	m := NewModel(f, Options{Version: "test", Plain: true, Tick: time.Hour, Now: func() time.Time { return now }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(m.refreshCmd()())
	if logContains(m, "节点版本") {
		t.Fatalf("matching versions printed a mismatch warning: %v", m.log)
	}
}

type failingStatusClient struct {
	*fakeClient
	err error
}

func (f *failingStatusClient) Status(ctx context.Context) (*apiv1.StatusResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.fakeClient.Status(ctx)
}

func TestLocalAPIFailurePrintsOnlyOnTransition(t *testing.T) {
	f := newFake()
	client := &failingStatusClient{fakeClient: f, err: errors.New("dial unix: connection refused")}
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	m := NewModel(client, Options{Version: "test", Plain: true, Tick: time.Hour, Now: func() time.Time { return now }})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	refresh := func() { m.Update(m.refreshCmd()()) }
	countFailures := func() int {
		n := 0
		for _, line := range m.log {
			if strings.HasPrefix(line.Text, "! dial unix") {
				n++
			}
		}
		return n
	}
	refresh()
	if countFailures() != 1 {
		t.Fatalf("first failure not printed once: %v", m.log)
	}
	if !strings.Contains(m.View(), "节点未运行") {
		t.Fatalf("failing status line missing 节点未运行: %q", m.View())
	}
	refresh()
	if countFailures() != 1 {
		t.Fatalf("repeated failure was printed again: %v", m.log)
	}
	client.err = nil
	refresh()
	if !logContains(m, "✓ 本地节点已恢复") {
		t.Fatalf("recovery line missing: %v", m.log)
	}
	if strings.Contains(m.View(), "节点未运行") {
		t.Fatalf("status line still failing after recovery: %q", m.View())
	}
}

func TestOnlyEventLinesGetTimestamps(t *testing.T) {
	m := testModel(t)
	m.log = nil
	m.pending = nil
	m.appendLog("命令输出")
	m.appendEvent("异步事件")
	if m.log[0].Event {
		t.Fatal("command output was marked as an event")
	}
	if !m.log[1].Event {
		t.Fatal("asynchronous line was not marked as an event")
	}
	if got := m.renderLogLine(m.log[0]); strings.Contains(got, "00:00:00") {
		t.Fatalf("command output has a timestamp: %q", got)
	}
	if got := m.renderLogLine(m.log[1]); !strings.HasPrefix(got, "00:00:00 ") {
		t.Fatalf("event timestamp missing: %q", got)
	}
}

func TestViewIsOnlyTheInlineLiveRegion(t *testing.T) {
	m := testModel(t)
	m.appendLog("this-output-belongs-in-scrollback")
	view := m.View()
	if strings.Contains(view, "scrollback") {
		t.Fatalf("View rendered the log: %q", view)
	}
	lines := strings.Split(view, "\n")
	if len(lines) != 3 {
		t.Fatalf("View lines = %d, want status+input+hint: %q", len(lines), view)
	}
	if !strings.Contains(lines[0], "连接 1") || strings.Contains(lines[0], "Raminga ") || !strings.HasPrefix(lines[1], "> ") || !strings.Contains(lines[2], "Ctrl+C") {
		t.Fatalf("unexpected live region order: %q", view)
	}
	m.input.SetValue(strings.Repeat("x", 200))
	for _, line := range strings.Split(m.View(), "\n") {
		if w := ansi.StringWidth(line); w > 80 {
			t.Fatalf("live line width %d > 80: %q", w, line)
		}
	}
	m.input.SetValue("/")
	m.updatePopup()
	view = m.View()
	lines = strings.Split(view, "\n")
	if len(lines) < 4 || !strings.HasPrefix(lines[1], "> /") {
		t.Fatalf("popup is not below the input line: %q", view)
	}
	if strings.Contains(view, "Ctrl+C") {
		t.Fatalf("hint rendered together with popup: %q", view)
	}
	for _, line := range lines {
		if w := ansi.StringWidth(line); w > 80 {
			t.Fatalf("popup line width %d > 80: %q", w, line)
		}
	}
}

func TestViewFollowsResizeWithoutBlankLines(t *testing.T) {
	m := headlessModel(t)
	m.input.SetValue(strings.Repeat("resize-", 30))
	for _, width := range []int{40, 50, 120} {
		m.Update(tea.WindowSizeMsg{Width: width, Height: 40})
		lines := strings.Split(m.View(), "\n")
		if len(lines) != 3 {
			t.Fatalf("width %d produced %d lines, want 3", width, len(lines))
		}
		for _, line := range lines {
			if w := ansi.StringWidth(line); w > width {
				t.Fatalf("width %d: line width %d: %q", width, w, line)
			}
		}
	}
}

func TestCommandEchoHasBlankSeparatorAndNoChatEcho(t *testing.T) {
	m := headlessModel(t)
	m.log = nil
	m.pending = nil
	m.hasOutput = false
	m.input.SetValue("/status")
	m.submit()
	if len(m.log) == 0 || m.log[0].Text != "> /status" {
		t.Fatalf("first command echo = %v", m.log)
	}
	if m.log[0].Text == "" {
		t.Fatal("first command must not be preceded by a blank line")
	}
	m.input.SetValue("/help")
	m.submit()
	echo := logIndex(m, "> /help")
	if echo <= 0 || m.log[echo-1].Text != "" {
		t.Fatalf("command echo is not separated by one blank line: %v", m.log)
	}
	m.cmdChat("b-quic")
	m.input.SetValue("plain chat text")
	m.submit()
	if logContains(m, "> plain chat text") {
		t.Fatalf("plain chat was echoed: %v", m.log)
	}
}

func TestTabOnlyCompletesArglessCommand(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/qu")
	m.updatePopup()
	if !m.popup.active {
		t.Fatal("popup should be open")
	}
	cmd, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyTab})
	if cmd != nil || quit {
		t.Fatal("Tab executed a command instead of only completing")
	}
	if got := m.input.Value(); got != "/quit" {
		t.Fatalf("Tab completion = %q, want /quit", got)
	}
	// Enter now executes the completed argless command.
	_, quit = m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if !quit {
		t.Fatal("Enter did not execute /quit after Tab completion")
	}
}

func TestAutoResendLogOnlyForRetriedOutboxMessage(t *testing.T) {
	m := testModel(t)
	m.outbox = &apiv1.OutboxListResponse{Entries: []*apiv1.OutboxEntry{{MessageId: "m-1", PeerId: fakePeer, Status: "pending", Attempts: 1}}}
	m.handleEvent(&apiv1.EventsResponse{AtUnixMs: 1000, Body: &apiv1.EventsResponse_Ack{Ack: &apiv1.AckEvent{MessageId: "m-1", PeerId: fakePeer, Accepted: true}}})
	if logContains(m, "自动补发") {
		t.Fatalf("first-attempt ACK must not be logged as an outbox resend: %v", m.log)
	}
	m.outbox = &apiv1.OutboxListResponse{Entries: []*apiv1.OutboxEntry{{MessageId: "m-2", PeerId: fakePeer, Status: "pending", Attempts: 3}}}
	m.handleEvent(&apiv1.EventsResponse{AtUnixMs: 2000, Body: &apiv1.EventsResponse_Ack{Ack: &apiv1.AckEvent{MessageId: "m-2", PeerId: fakePeer, Accepted: true}}})
	if !logContains(m, "自动补发") {
		t.Fatalf("retried outbox ACK should be logged: %v", m.log)
	}
}

func TestRelayDisconnectKeepsDirectLog(t *testing.T) {
	m := testModel(t)
	ev := func(kind, route string) *apiv1.EventsResponse {
		return &apiv1.EventsResponse{AtUnixMs: 1000, Body: &apiv1.EventsResponse_Connection{Connection: &apiv1.ConnectionEvent{PeerId: fakePeer, Kind: kind, Route: route, Transport: "quic"}}}
	}
	m.handleEvent(ev("connected", "relay"))
	m.handleEvent(ev("connected", "direct"))
	m.handleEvent(ev("disconnected", "relay"))
	if !logContains(m, "中继线路已关闭（直连仍在）") {
		t.Fatalf("relay-only close not distinguished: %v", m.log)
	}
	m.handleEvent(ev("disconnected", "direct"))
	if !logContains(m, "断开 b-quic") {
		t.Fatalf("final disconnect missing: %v", m.log)
	}
}

func TestUpgradeLogPrintsOnlyDirectAddr(t *testing.T) {
	m := testModel(t)
	m.log = nil
	m.peers = []*apiv1.PeerEntry{{
		PeerId: fakePeer, Online: true, Route: "direct", Transport: "quic", Direct: true,
		Addrs: []string{"/ip4/11.41.0.2/tcp/4001/p2p/" + fakeRelay + "/p2p-circuit/p2p/" + fakePeer, "/ip4/11.41.0.11/udp/4001/quic-v1"},
	}}
	m.lastRoutes[fakePeer] = "relay"
	m.detectRouteChanges(time.Now())
	if !logContains(m, "已升级为 QUIC 直连 /ip4/11.41.0.11/udp/4001/quic-v1") {
		t.Fatalf("upgrade log missing direct addr: %v", m.log)
	}
	if logContains(m, "/p2p-circuit") {
		t.Fatalf("upgrade log leaked circuit addr: %v", m.log)
	}
}

func TestStatusShowsFullPeerIDAndShareableAddrs(t *testing.T) {
	m := testModel(t)
	m.cmdStatus()
	id := m.status.GetPeerId()
	if !logContains(m, "本机："+id) {
		t.Fatalf("status missing full Peer ID %q: %v", id, m.log)
	}
	if !logContains(m, "公告地址：公网（/copy 默认）") {
		t.Fatalf("address label/default marker missing: %v", m.log)
	}
	if !logContains(m, "/ip4/1.1.1.1/tcp/4001/p2p/"+id) {
		t.Fatalf("advertised address missing /p2p/: %v", m.log)
	}
	if !logContains(m, "Node ID：") {
		t.Fatalf("Node ID line missing: %v", m.log)
	}
}

func TestStatusUsesNameWithFullPeerID(t *testing.T) {
	m := testModel(t)
	id := m.status.GetPeerId()
	m.friends = append(m.friends, &apiv1.Friend{Name: "me", PeerId: id})
	m.cmdStatus()
	if !logContains(m, "本机：me（"+id+"）") {
		t.Fatalf("status name form wrong: %v", m.log)
	}
}

func TestShareableAddrIdempotent(t *testing.T) {
	id := fakePeer
	base := "/ip4/198.51.100.2/udp/4001/quic-v1"
	got := shareableAddr(base, id)
	if got != base+"/p2p/"+id {
		t.Fatalf("shareableAddr = %q", got)
	}
	if again := shareableAddr(got, id); again != got {
		t.Fatalf("not idempotent: %q -> %q", got, again)
	}
	circuit := "/ip4/198.51.100.3/tcp/4001/p2p/12D3KooWRelay/p2p-circuit"
	if got := shareableAddr(circuit, id); got != circuit+"/p2p/"+id {
		t.Fatalf("circuit address = %q", got)
	}
}

func TestCopyUsesShareableAddrAndBareFallback(t *testing.T) {
	m := testModel(t)
	id := m.status.GetPeerId()
	m.cmdCopy()
	if !logContains(m, "/ip4/1.1.1.1/tcp/4001/p2p/"+id) {
		t.Fatalf("/copy missing shareable address: %v", m.log)
	}
	m.status.AdvertisedAddrs = nil
	m.log = nil
	m.cmdCopy()
	if !logContains(m, id) || logContains(m, "/p2p/") {
		t.Fatalf("/copy fallback should be bare Peer ID: %v", m.log)
	}
}

func TestConnectFailureSummaryAndCandidateDedup(t *testing.T) {
	m := testModel(t)
	raw := `raminga: unavailable: dial peer failed after 2 candidate(s): /ip4/11.41.0.2/tcp/4001/p2p/relay/p2p-circuit/p2p/b: i/o timeout * [/ip4/11.41.0.2/tcp/4001/p2p/relay/p2p-circuit] timeout * [/ip4/11.41.0.2/tcp/4001/p2p/relay/p2p-circuit] timeout\nsecond line`
	m.Update(connectResultMsg{err: fmt.Errorf("%s", raw), peerID: fakePeer})
	main := ""
	for _, l := range m.log {
		if strings.HasPrefix(l.Text, "✗ 连接失败") {
			main = l.Text
		}
	}
	if main == "" || strings.Contains(main, `\n`) || strings.Contains(main, "second line") {
		t.Fatalf("main failure line is not short: %q", main)
	}
	if !strings.Contains(main, "所有候选地址都失败") {
		t.Fatalf("missing Chinese summary: %q", main)
	}
	n := 0
	for _, l := range m.log {
		if strings.HasPrefix(l.Text, "  · ") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("candidate lines = %d, want deduplicated 1: %v", n, m.log)
	}
	if !logContains(m, "（超时）") {
		t.Fatalf("candidate reason missing: %v", m.log)
	}
	for _, l := range m.log {
		if strings.Contains(l.Text, "（失败）") || strings.Contains(l.Text, `\n`) {
			t.Fatalf("generic/literal reason leaked: %q", l.Text)
		}
	}
}

func TestConnectFailureCandidateReasons(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"* [/ip4/1.1.1.1/tcp/1] dial backoff", "暂停重拨（dial backoff）"},
		{"* [/ip4/1.1.1.1/tcp/1] i/o timeout", "超时"},
		{"* [/ip4/1.1.1.1/tcp/1] connection refused", "连接被拒绝"},
		{"* [/ip4/1.1.1.1/tcp/1] failed to negotiate security protocol: noise", "加密握手失败"},
		{"* [/ip4/1.1.1.1/tcp/1] no route to host", "无可用线路"},
		{"* [/ip4/1.1.1.1/tcp/1] weird", "原因未知"},
	}
	for _, tc := range cases {
		if _, details := formatConnectFailure(tc.raw); len(details) != 1 || !strings.Contains(details[0], tc.want) {
			t.Fatalf("%q -> %v, want %s", tc.raw, details, tc.want)
		}
	}
}

func TestPeersOmitsEmptyConnectionFields(t *testing.T) {
	m := testModel(t)
	m.peers = []*apiv1.PeerEntry{{PeerId: fakePeer, Online: false, Route: "", Transport: ""}, {PeerId: fakePeer2, Online: true, Route: "relay", Transport: "tcp", Direct: false, Limited: true}}
	m.cmdPeers()
	for _, l := range m.log {
		if strings.Contains(l.Text, "方向= 中继=") || strings.Contains(l.Text, "方向= ") || strings.Contains(l.Text, "中继= ") {
			t.Fatalf("empty field printed: %q", l.Text)
		}
	}
	if !logContains(m, "离线") {
		t.Fatalf("offline peer not marked: %v", m.log)
	}
}

func TestPickShareableAddrOrder(t *testing.T) {
	id := fakePeer2
	relay := "/ip4/1.1.1.1/tcp/4001/p2p/" + fakePeer + "/p2p-circuit"
	cases := []struct {
		name         string
		reachability string
		addrs        []string
		want         string
	}{
		{
			"loopback skipped and circuit preferred",
			"unknown",
			[]string{"/ip4/127.0.0.1/tcp/4001", "/ip4/192.168.1.5/tcp/4001", relay},
			relay,
		},
		{
			"public before circuit when reachable",
			"public",
			[]string{relay, "/ip4/1.1.1.1/tcp/4001"},
			"/ip4/1.1.1.1/tcp/4001",
		},
		{
			"IPv4 before IPv6 in same class",
			"public",
			[]string{"/ip6/2606:4700:4700::1111/tcp/4001", "/ip4/1.1.1.1/tcp/4001"},
			"/ip4/1.1.1.1/tcp/4001",
		},
		{
			"public before LAN",
			"unknown",
			[]string{"/ip4/10.0.0.2/tcp/4001", "/ip4/1.1.1.1/tcp/4001"},
			"/ip4/1.1.1.1/tcp/4001",
		},
		{
			"loopback only falls through",
			"unknown",
			[]string{"/ip4/127.0.0.1/tcp/4001", "/ip6/::1/tcp/4001"},
			"",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := testModel(t)
			m.status.PeerId = id
			m.status.AdvertisedAddrs = tc.addrs
			m.status.Network.Reachability = tc.reachability
			raw, got := m.pickShareableAddr()
			if raw != tc.want {
				t.Fatalf("pick raw = %q, want %q", raw, tc.want)
			}
			if tc.want != "" && got != tc.want+"/p2p/"+id {
				t.Fatalf("shareable = %q", got)
			}
			if tc.want == "" && got != "" {
				t.Fatalf("fallback should be empty, got %q", got)
			}
		})
	}
}

func TestStatusPrintsLabelThenBareAddress(t *testing.T) {
	m := testModel(t)
	id := m.status.GetPeerId()
	relay := "/ip4/1.1.1.1/tcp/4001/p2p/" + fakePeer + "/p2p-circuit"
	public := "/ip4/1.1.1.1/tcp/4001"
	lan := "/ip4/192.168.1.5/tcp/4001"
	m.status.AdvertisedAddrs = []string{
		"/ip4/127.0.0.1/tcp/4001",
		relay,
		lan,
		public,
	}
	m.cmdStatus()
	index := func(text string) int {
		for i, line := range m.log {
			if line.Text == text {
				return i
			}
		}
		return -1
	}
	pairs := []struct{ label, addr string }{
		{"公告地址：中继（/copy 默认）", shareableAddr(relay, id)},
		{"公告地址：公网", shareableAddr(public, id)},
		{"公告地址：局域网", shareableAddr(lan, id)},
	}
	last := -1
	for _, pair := range pairs {
		i := index(pair.label)
		if i < 0 {
			t.Fatalf("status label missing %q: %v", pair.label, m.log)
		}
		if i+1 >= len(m.log) || m.log[i+1].Text != pair.addr {
			t.Fatalf("address after %q = %v, want bare %q", pair.label, m.log[i+1:], pair.addr)
		}
		if i <= last {
			t.Fatalf("address order wrong at %q", pair.label)
		}
		last = i
	}
	if logContains(m, "本机回环") {
		t.Fatalf("loopback shown despite usable addresses: %v", m.log)
	}
}

func TestStatusShowsLabelledLoopbackOnlyWhenNothingElse(t *testing.T) {
	m := testModel(t)
	id := m.status.GetPeerId()
	loopback := "/ip4/127.0.0.1/tcp/4001"
	m.status.AdvertisedAddrs = []string{loopback}
	m.cmdStatus()
	if !logContains(m, "公告地址：本机回环") {
		t.Fatalf("loopback label missing: %v", m.log)
	}
	if !logContains(m, shareableAddr(loopback, id)) {
		t.Fatalf("bare loopback address missing: %v", m.log)
	}
	if logContains(m, "（/copy 默认）") {
		t.Fatalf("loopback must not be marked as the /copy default: %v", m.log)
	}
}

func TestDisconnectCommandResolvesNameAndWarns(t *testing.T) {
	m := testModel(t)
	m.status.Network.Relays = []*apiv1.RelayReservation{{RelayPeerId: fakePeer}}
	m.status.Network.Dht.BootstrapPeers = []string{"/ip4/1.1.1.1/tcp/4001/p2p/" + fakePeer}
	m.outbox = &apiv1.OutboxListResponse{Entries: []*apiv1.OutboxEntry{{PeerId: fakePeer, Status: "pending"}}}
	cmd, _ := m.execCommand("/disconnect b-quic")
	if cmd == nil {
		t.Fatal("disconnect command missing")
	}
	m.Update(cmd())
	if len(m.client.(*fakeClient).disconnected) != 1 || m.client.(*fakeClient).disconnected[0] != fakePeer {
		t.Fatalf("disconnect calls = %v", m.client.(*fakeClient).disconnected)
	}
	for _, want := range []string{"已断开 b-quic", "中继", "Bootstrap", "待发"} {
		if !logContains(m, want) {
			t.Fatalf("disconnect log missing %q: %v", want, m.log)
		}
	}
}

func TestFriendCommands(t *testing.T) {
	m := testModel(t)
	m.cmdPeers()
	if !logContains(m, "b-quic") {
		t.Fatalf("/peers missing seeded friend: %v", m.log)
	}
	cmd, _ := m.execCommand("/name b-quic b-new")
	if cmd == nil {
		t.Fatal("/name returned no command")
	}
	m.Update(cmd())
	if !logContains(m, "已保存名字：b-new") {
		t.Fatalf("/name result missing: %v", m.log)
	}
	cmd, _ = m.execCommand("/describe b-new hello world")
	if cmd == nil {
		t.Fatal("/describe returned no command")
	}
	m.Update(cmd())
	if !logContains(m, "已保存描述：hello world") {
		t.Fatalf("/describe result missing: %v", m.log)
	}
	cmd, _ = m.execCommand("/forget b-new")
	if cmd == nil {
		t.Fatal("/forget returned no command")
	}
	m.Update(cmd())
	if !logContains(m, "已从好友表删除") {
		t.Fatalf("/forget result missing: %v", m.log)
	}
	if logContains(m, "/friends sync") {
		t.Fatalf("/forget still asks for manual sync: %v", m.log)
	}
}

func TestPeersShowPausedMarkerForFriendOnlyAndLivePeer(t *testing.T) {
	m := testModel(t)
	m.peers = nil
	m.friends[0].Paused = true
	m.cmdPeers()
	if !logContains(m, "暂停") {
		t.Fatalf("/peers missing friend pause marker: %v", m.log)
	}
	m.log = nil
	m.peers = []*apiv1.PeerEntry{{PeerId: fakePeer, Online: true, Route: "direct", Transport: "quic", Direct: true, Paused: true}}
	m.cmdPeers()
	if !logContains(m, "暂停") {
		t.Fatalf("/peers missing live pause marker: %v", m.log)
	}
}

func (f *fakeClient) Published(context.Context) (*apiv1.PublishedResponse, error) {
	return &apiv1.PublishedResponse{
		Files:                 []*apiv1.PublishedFile{{Path: "posts/a.txt", Size: 3}},
		Skipped:               []*apiv1.PublishedSkip{{Path: "posts/.hidden", Reason: "hidden name"}},
		GeneratedAtUnixMs:     2000,
		FriendsSyncedAtUnixMs: 3000,
	}, nil
}
func (f *fakeClient) GetPeerManifest(_ context.Context, _ string, offset, limit int32) (*apiv1.GetPeerManifestResponse, error) {
	all := []*apiv1.ManifestEntry{
		{Path: "posts/a.txt", Size: 1, Sha256: "aa"},
		{Path: "posts/b.txt", Size: 2, Sha256: "bb"},
		{Path: "profile/index.md", Size: 3, Sha256: "cc"},
	}
	if limit <= 0 || limit > 2 {
		limit = 2
	}
	start := int(offset)
	if start > len(all) {
		start = len(all)
	}
	end := start + int(limit)
	if end > len(all) {
		end = len(all)
	}
	return &apiv1.GetPeerManifestResponse{PeerId: fakePeer, Version: 1, Total: int32(len(all)), Entries: all[start:end]}, nil
}
func (f *fakeClient) GetPeerProfile(context.Context, string) (*apiv1.GetPeerProfileResponse, error) {
	return &apiv1.GetPeerProfileResponse{PeerId: fakePeer, Name: "B", Text: "# B\nhello", Found: true}, nil
}
func (f *fakeClient) GetPeerFriends(context.Context, string) (*apiv1.GetPeerFriendsResponse, error) {
	return &apiv1.GetPeerFriendsResponse{PeerId: fakePeer, Friends: []*apiv1.PeerFriendClaim{{Name: "C", PeerId: fakePeer2, Description: "friend"}}}, nil
}
func (f *fakeClient) DownloadPeerFile(_ context.Context, _, _ string, progress func(*apiv1.DownloadPeerFileResponse)) (*apiv1.DownloadPeerFileResponse, error) {
	if progress != nil {
		for _, p := range f.downloadProgress {
			progress(p)
		}
	}
	return &apiv1.DownloadPeerFileResponse{Phase: "complete", LocalPath: "/tmp/download", TotalBytes: 1, Sha256: "aa"}, nil
}
func (f *fakeClient) ConnectListedPeer(_ context.Context, peerID string, _ []string) (*apiv1.ConnectListedPeerResponse, error) {
	return &apiv1.ConnectListedPeerResponse{PeerId: peerID, Route: "direct", Direct: true}, nil
}

func TestResolveStripsWrappedWhitespace(t *testing.T) {
	m := testModel(t)
	addr := "/ip4/198.51.100.2/tcp/4001/p2p/" + fakePeer
	wrapped := "  /ip4/198.51.100.2/tcp/\r\n4001/p2p/\n\t" + fakePeer + "  "
	_, pid, addrs, err := m.resolve(wrapped)
	if err != nil {
		t.Fatalf("resolve wrapped address: %v", err)
	}
	if pid != fakePeer || len(addrs) != 1 || addrs[0] != addr {
		t.Fatalf("resolved pid=%q addrs=%v", pid, addrs)
	}
	if _, _, _, err := m.resolve("/ip4/not-an-ip/tcp/x/p2p/" + fakePeer); err == nil || !strings.Contains(err.Error(), "完整") {
		t.Fatalf("parse error missing completeness hint: %v", err)
	}
}

func TestResolveMatchesFriendNameBeforeNormalize(t *testing.T) {
	m := testModel(t)
	m.friends = append(m.friends, &apiv1.Friend{
		Name:   "a b",
		PeerId: fakePeer2,
		Addrs:  []string{"/ip4/198.51.100.3/tcp/4001"},
	})
	name, pid, addrs, err := m.resolve("  a b  ")
	if err != nil {
		t.Fatalf("resolve friend name with space: %v", err)
	}
	if name != "a b" || pid != fakePeer2 || len(addrs) != 1 {
		t.Fatalf("resolved name=%q pid=%q addrs=%v", name, pid, addrs)
	}
}

func TestBracketedPasteMultiLineConnect(t *testing.T) {
	m := testModel(t)
	addr := "/ip4/198.51.100.2/tcp/4001/p2p/" + fakePeer
	pasted := "/connect /ip4/198.51.100.2/tcp/4001/p2p/\n" + fakePeer
	m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(pasted), Paste: true})
	if strings.ContainsAny(m.input.Value(), "\r\n\t") {
		t.Fatalf("textinput did not sanitize the paste: %q", m.input.Value())
	}
	cmd, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if quit {
		t.Fatal("connect paste quit the TUI")
	}
	if cmd == nil {
		t.Fatal("connect paste produced no command")
	}
	_ = cmd()
	fc := m.client.(*fakeClient)
	if fc.connectPeer != fakePeer {
		t.Fatalf("connect peer = %q, want %q", fc.connectPeer, fakePeer)
	}
	if len(fc.dhtAddrs) != 1 || fc.dhtAddrs[0] != addr {
		t.Fatalf("pasted multiaddr = %v, want %q", fc.dhtAddrs, addr)
	}
}

type countingWriter struct {
	bytes.Buffer
	writes int
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.writes++
	return w.Buffer.Write(p)
}

func TestCopyCmdEmitsExactOSC52BytesInOneWrite(t *testing.T) {
	m := testModel(t)
	var buf countingWriter
	m.opts.Clipboard = &buf
	cmd := m.cmdCopy()
	if cmd == nil {
		t.Fatal("/copy produced no command")
	}
	_, value := m.pickShareableAddr()
	if value == "" {
		t.Fatal("test status has no shareable address")
	}
	if !logContains(m, "已发送到剪贴板（终端需支持 OSC52）："+value) {
		t.Fatalf("/copy message missing value: %v", m.log)
	}
	if buf.Len() != 0 {
		t.Fatal("copy bytes were written before the Cmd ran")
	}
	expected := "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(value)) + "\a"
	if got := osc52.New(value).String(); got != expected {
		t.Fatalf("osc52 format = %q, want %q", got, expected)
	}
	cmd()
	if buf.writes != 1 {
		t.Fatalf("clipboard used %d Write calls, want 1", buf.writes)
	}
	if got := buf.String(); got != expected {
		t.Fatalf("clipboard bytes = %q, want %q", got, expected)
	}
}

func TestCopyPeerArgumentSendsFullPeerID(t *testing.T) {
	m := testModel(t)
	var buf countingWriter
	m.opts.Clipboard = &buf
	cmd := m.cmdCopyPeer("b-quic")
	if cmd == nil {
		t.Fatal("/copy <name> produced no command")
	}
	if !logContains(m, "已发送到剪贴板（终端需支持 OSC52）："+fakePeer) {
		t.Fatalf("/copy <name> log missing full Peer ID: %v", m.log)
	}
	cmd()
	if buf.writes != 1 {
		t.Fatalf("clipboard used %d Write calls, want 1", buf.writes)
	}
	if !strings.Contains(buf.String(), base64.StdEncoding.EncodeToString([]byte(fakePeer))) {
		t.Fatalf("clipboard bytes missing Peer ID: %q", buf.String())
	}
}

func TestCompletionReplacesOnlyCurrentArgument(t *testing.T) {
	cases := []struct {
		name  string
		value string
		cmd   string
		want  string
	}{
		{"name", "/name b- my-name", "/name", "/name b-quic my-name"},
		{"describe", "/describe b- keep this", "/describe", "/describe b-quic keep this"},
		{"forget", "/forget b- --cancel-pending", "/forget", "/forget b-quic --cancel-pending"},
		{"connect", "/connect b-", "/connect", "/connect b-quic "},
		{"chat", "/chat b-", "/chat", "/chat b-quic "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := testModel(t)
			m.input.SetValue(tc.value)
			cursor := strings.Index(tc.value, "b-") + len("b-")
			m.input.SetCursor(len([]rune(tc.value[:cursor])))
			m.updatePopup()
			if !m.popup.active {
				t.Fatalf("popup not active for %q: %+v", tc.value, m.popup)
			}
			m.completeSelected()
			if got := m.input.Value(); got != tc.want {
				t.Fatalf("completed = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPeerCompletionCoversContentCommands(t *testing.T) {
	for _, command := range []string{"/view", "/posts", "/peerfriends", "/get", "/copy"} {
		t.Run(command, func(t *testing.T) {
			m := testModel(t)
			m.input.SetValue(command + " b-")
			m.input.CursorEnd()
			m.updatePopup()
			if !m.popup.active {
				t.Fatalf("%s did not open peer completion: %+v", command, m.popup)
			}
			found := false
			for _, item := range m.popup.items {
				if item.Insert == fakePeer || item.Insert == "b-quic" {
					found = true
				}
				if item.Desc == "" || len([]rune(item.Desc)) > 8 {
					t.Fatalf("%s completion description is not short: %+v", command, item)
				}
			}
			if !found {
				t.Fatalf("%s peer completion = %+v", command, m.popup.items)
			}
		})
	}
}

func TestPopupScrollsToAllItems(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("/")
	m.updatePopup()
	if len(m.popup.items) != len(commands) {
		t.Fatalf("popup items = %d, want %d", len(m.popup.items), len(commands))
	}
	for i := 0; i < len(commands)-1; i++ {
		m.handleKey(tea.KeyMsg{Type: tea.KeyDown})
	}
	start, end := m.popupWindow()
	if m.popup.sel != len(commands)-1 || end != len(commands) || end-start > 8 {
		t.Fatalf("window sel=%d start=%d end=%d", m.popup.sel, start, end)
	}
	view := strings.Join(m.popupLines(), "\n")
	if !strings.Contains(view, commands[len(commands)-1].Name) || !strings.Contains(view, fmt.Sprintf("%d-%d/%d", start+1, end, len(commands))) || strings.Contains(view, "补全") {
		t.Fatalf("last completion/indicator not visible:\n%s", view)
	}
	if m.popup.offset == 0 {
		t.Fatal("popup did not scroll")
	}
}

func TestHomeEndMoveInputCursor(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("hello world")
	m.input.SetCursor(5)
	if _, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyHome}); quit {
		t.Fatal("Home quit the TUI")
	}
	if got := m.input.Position(); got != 0 {
		t.Fatalf("Home cursor = %d, want 0", got)
	}
	if view := m.View(); !strings.Contains(view, "> ▌hello world") {
		t.Fatalf("Home cursor not rendered at the start: %q", view)
	}
	if _, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyEnd}); quit {
		t.Fatal("End quit the TUI")
	}
	if got := m.input.Position(); got != len("hello world") {
		t.Fatalf("End cursor = %d, want %d", got, len("hello world"))
	}
	if view := m.View(); !strings.Contains(view, "> hello world▌") {
		t.Fatalf("End cursor not rendered at the end: %q", view)
	}
}

func TestInputWidthKeepsTailAndCursorVisible(t *testing.T) {
	for _, plain := range []bool{true, false} {
		t.Run(fmt.Sprintf("plain=%t", plain), func(t *testing.T) {
			m := testModel(t)
			m.opts.Plain = plain
			m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
			if want := 80 - ansi.StringWidth("> ") - 1; m.input.Width != want {
				t.Fatalf("input width = %d, want %d", m.input.Width, want)
			}
			value := "start-" + strings.Repeat("x", 140) + "-END"
			m.input.SetValue(value)
			m.input.CursorEnd()
			view := m.View()
			if !strings.Contains(view, "-END") {
				t.Fatalf("input tail is not visible:\n%s", view)
			}
			for _, line := range strings.Split(view, "\n") {
				if w := ansi.StringWidth(line); w > 80 {
					t.Fatalf("line width %d > 80: %q", w, line)
				}
			}

			cjk := strings.Repeat("中", 70) + "结束"
			m.input.SetValue(cjk)
			m.input.CursorEnd()
			view = m.View()
			if !strings.Contains(view, "结束") {
				t.Fatalf("CJK tail is not visible:\n%s", view)
			}
			if plain && !strings.Contains(view, "结束▌") {
				t.Fatalf("plain CJK cursor is not after the tail:\n%s", view)
			}
			for _, line := range strings.Split(view, "\n") {
				if w := ansi.StringWidth(line); w > 80 {
					t.Fatalf("CJK line width %d > 80: %q", w, line)
				}
			}
		})
	}
}

func TestPromptAndPlaceholderFollowTarget(t *testing.T) {
	m := testModel(t)
	if got := m.prompt(); got != "> " {
		t.Fatalf("prompt without target = %q", got)
	}
	if got := m.placeholder(); got != "输入 / 查看指令" {
		t.Fatalf("placeholder without target = %q", got)
	}
	if !strings.Contains(m.View(), "输入 / 查看指令") {
		t.Fatalf("placeholder missing from view: %q", m.View())
	}
	m.cmdChat("b-quic")
	if got := m.prompt(); got != "b-quic> " {
		t.Fatalf("prompt with target = %q", got)
	}
	if got := m.placeholder(); got != "发送给 b-quic" {
		t.Fatalf("placeholder with target = %q", got)
	}
	if !strings.Contains(m.View(), "b-quic> 发送给 b-quic") {
		t.Fatalf("target prompt/placeholder missing from view: %q", m.View())
	}

	m.target = &chatTarget{Name: "小明", PeerID: fakePeer}
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	if want := 80 - ansi.StringWidth("小明> ") - 1; m.input.Width != want {
		t.Fatalf("CJK prompt width calculation = %d, want %d", m.input.Width, want)
	}
}

func TestCtrlCClearsInputThenQuits(t *testing.T) {
	m := testModel(t)
	m.input.SetValue("draft text")
	m.updatePopup()
	cmd, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd != nil || quit {
		t.Fatal("Ctrl+C with input should not quit")
	}
	if m.input.Value() != "" || m.popup.active {
		t.Fatalf("Ctrl+C did not clear input/popup: value=%q popup=%+v", m.input.Value(), m.popup)
	}
	if _, quit := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC}); !quit {
		t.Fatal("Ctrl+C on empty input should quit")
	}
	if !strings.Contains(m.hintLine(), "清空输入") {
		t.Fatalf("hint does not describe Ctrl+C clearing: %q", m.hintLine())
	}
}

func TestStatusLineOrderDropsFromRight(t *testing.T) {
	m := testModel(t)
	m.cmdChat("b-quic")
	line := m.statusLine()
	if strings.Contains(line, "Raminga") || strings.Contains(line, " test") {
		t.Fatalf("status line still contains version: %q", line)
	}
	chat, conn, me := strings.Index(line, "聊天 b-quic"), strings.Index(line, "连接 1"), strings.Index(line, "我 ")
	if chat < 0 || conn < 0 || me < 0 || chat >= conn || conn >= me {
		t.Fatalf("status order = %q (chat=%d conn=%d me=%d)", line, chat, conn, me)
	}
	if w := ansi.StringWidth(line); w > 80 {
		t.Fatalf("80-column status width = %d: %q", w, line)
	}

	m.apiFailing = true
	m.streamErr = "closed"
	line = m.statusLine()
	if !strings.HasPrefix(line, "节点未运行 · 事件重连中 · 聊天 b-quic") {
		t.Fatalf("status flags are not first: %q", line)
	}
	m.apiFailing = false
	m.streamErr = ""

	m.Update(tea.WindowSizeMsg{Width: 40, Height: 24})
	line = m.statusLine()
	if !strings.Contains(line, "聊天 b-quic") {
		t.Fatalf("chat target was dropped/truncated on a narrow line: %q", line)
	}
	if strings.Contains(line, "我 ") {
		t.Fatalf("right-most name segment was not dropped first: %q", line)
	}
}

func TestSpinnerOnlyWhileBusy(t *testing.T) {
	m := testModel(t)
	m.opts.Plain = false
	m.cmdChat("b-quic")
	m.cmdConnect("b-quic")
	if !m.busy || !strings.Contains(m.statusLine(), "⠋ 正在连接 b-quic…") {
		t.Fatalf("connect spinner missing: busy=%t status=%q", m.busy, m.statusLine())
	}
	if logContains(m, "正在连接") {
		t.Fatalf("connect progress leaked into scrollback: %v", m.log)
	}
	m.finishActivity()
	m.busy = false
	m.pending = nil
	if _, cmd := m.Update(spinner.TickMsg{}); cmd != nil {
		t.Fatal("idle spinner scheduled another tick")
	}

	plain := testModel(t)
	plain.cmdChat("b-quic")
	plain.cmdConnect("b-quic")
	line := plain.statusLine()
	if !strings.Contains(line, "… 正在连接 b-quic…") || strings.Contains(line, "⠋") {
		t.Fatalf("plain progress should be static text: %q", line)
	}
	plain.pending = nil
	if _, cmd := plain.Update(spinner.TickMsg{}); cmd != nil {
		t.Fatal("plain spinner scheduled a tick")
	}
}

func TestDownloadProgressIsSafeAndPlainStatic(t *testing.T) {
	m := testModel(t)
	m.opts.Plain = false
	m.setDownloadProgress(&apiv1.DownloadPeerFileResponse{Path: "posts/a.jpg", ReceivedBytes: 37, TotalBytes: 100})
	if !strings.Contains(m.activity, "下载 posts/a.jpg 37%") {
		t.Fatalf("download activity = %q", m.activity)
	}
	if !strings.Contains(m.statusLine(), "⠋ 下载 posts/a.jpg 37%") {
		t.Fatalf("download spinner missing from status: %q", m.statusLine())
	}
	m.setDownloadProgress(&apiv1.DownloadPeerFileResponse{Path: "posts/a.jpg", ReceivedBytes: 20, TotalBytes: 100})
	if !strings.Contains(m.activity, "37%") {
		t.Fatalf("non-monotonic progress regressed: %q", m.activity)
	}
	m.setDownloadProgress(&apiv1.DownloadPeerFileResponse{Path: "posts/a.jpg", ReceivedBytes: 512, TotalBytes: 0})
	if strings.Contains(m.activity, "%") || !strings.Contains(m.activity, "512 B") {
		t.Fatalf("unknown total should show bytes only: %q", m.activity)
	}
	m.setDownloadProgress(&apiv1.DownloadPeerFileResponse{Path: "posts/a.jpg", ReceivedBytes: 999, TotalBytes: 100})
	if !strings.Contains(m.activity, "100%") {
		t.Fatalf("over-total progress was not clamped: %q", m.activity)
	}

	plain := testModel(t) // plain model
	plain.setDownloadProgress(&apiv1.DownloadPeerFileResponse{Path: "posts/a.jpg", ReceivedBytes: 37, TotalBytes: 100})
	if line := plain.statusLine(); !strings.Contains(line, "… 下载 posts/a.jpg 37%") || strings.Contains(line, "⠋") {
		t.Fatalf("plain download progress = %q", line)
	}
}

func TestBusyRefusalRestoresInputAndSkipsHistory(t *testing.T) {
	m := testModel(t)
	m.cmdChat("b-quic")
	m.busy = true
	m.input.SetValue("keep this message")
	cmd, quit := m.submit()
	if cmd != nil || quit {
		t.Fatal("busy send should be refused")
	}
	if m.input.Value() != "keep this message" {
		t.Fatalf("busy send lost the input: %q", m.input.Value())
	}
	if !logContains(m, "上一个操作尚未结束，内容已保留") {
		t.Fatalf("busy refusal notice missing: %v", m.log)
	}
	if len(m.history) != 0 {
		t.Fatalf("busy refusal added history: %q", m.history)
	}

	m.input.SetValue("/connect b-quic")
	if _, _ = m.submit(); m.input.Value() != "/connect b-quic" {
		t.Fatalf("busy connect lost the input: %q", m.input.Value())
	}
	if len(m.history) != 0 {
		t.Fatalf("busy connect added history: %q", m.history)
	}

	m.busy = false
	m.input.SetValue("keep this message")
	if cmd, _ := m.submit(); cmd == nil {
		t.Fatal("retry after busy produced no command")
	}
	if len(m.history) != 1 || m.history[0] != "keep this message" {
		t.Fatalf("retry history = %q", m.history)
	}
}

func TestGetUsesProgressCallbackAndClearsBusy(t *testing.T) {
	m := testModel(t)
	f := m.client.(*fakeClient)
	f.downloadProgress = []*apiv1.DownloadPeerFileResponse{
		{Path: "posts/a.jpg", ReceivedBytes: 37, TotalBytes: 100},
		{Path: "posts/a.jpg", ReceivedBytes: 100, TotalBytes: 100},
	}
	m.cmdChat("b-quic")
	cmd := m.cmdGet("b-quic", "posts/a.jpg")
	if cmd == nil || !m.busy {
		t.Fatalf("get did not start busy: cmd=%v busy=%t", cmd != nil, m.busy)
	}
	for _, msg := range runCommandMessages(cmd) {
		m.Update(msg)
	}
	if m.busy || m.activity != "" {
		t.Fatalf("get left busy/activity behind: busy=%t activity=%q", m.busy, m.activity)
	}
	if !logContains(m, "已保存：/tmp/download") {
		t.Fatalf("get result line missing: %v", m.log)
	}
	if logContains(m, "正在下载") {
		t.Fatalf("download progress leaked into scrollback: %v", m.log)
	}
}

func runCommandMessages(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		var out []tea.Msg
		for _, sub := range msg {
			out = append(out, runCommandMessages(sub)...)
		}
		return out
	default:
		return []tea.Msg{msg}
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func headlessModel(t *testing.T) *Model {
	t.Helper()
	m := NewModel(newFake(), Options{
		Version: "test",
		Plain:   true,
		Tick:    time.Hour,
		Now:     func() time.Time { return time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC) },
	})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	return m
}

// runScriptedHeadless drives the model through a real Bubble Tea program and
// returns the stripped terminal stream. The final line should be /quit so the
// model's own flush-before-quit path runs (a raw tea.Quit message would bypass
// Update and could drop queued lines).
func runScriptedHeadless(t *testing.T, m *Model, lines []string) string {
	t.Helper()
	var out lockedBuffer
	p := tea.NewProgram(m, tea.WithInput(nil), tea.WithOutput(&out), tea.WithoutSignals())
	done := make(chan struct{})
	go func() {
		_, _ = p.Run()
		close(done)
	}()
	for i, line := range lines {
		p.Send(scriptLineMsg{line: line, next: i + 1})
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("TUI did not finish")
	}
	return ansi.Strip(out.String())
}

func TestOrderedOutputOver200Lines(t *testing.T) {
	m := headlessModel(t)
	lines := make([]string, 0, 221)
	for i := 0; i < 220; i++ {
		lines = append(lines, fmt.Sprintf("/mark line-%03d", i))
	}
	lines = append(lines, "/quit")
	out := runScriptedHeadless(t, m, lines)
	prev := -1
	for i := 0; i < 220; i++ {
		needle := fmt.Sprintf("line-%03d", i)
		idx := strings.Index(out, needle)
		if idx < 0 {
			t.Fatalf("line %s missing from output", needle)
		}
		if idx <= prev {
			t.Fatalf("line %s appeared out of order", needle)
		}
		prev = idx
	}
	if len(m.log) < 200 {
		t.Fatalf("in-memory log kept %d lines, want at least 200", len(m.log))
	}
}

func TestOutputNotLostOnQuit(t *testing.T) {
	m := headlessModel(t)
	out := runScriptedHeadless(t, m, []string{"/mark keep-1", "/mark keep-2", "/mark keep-3", "/quit"})
	for i := 1; i <= 3; i++ {
		if !strings.Contains(out, fmt.Sprintf("keep-%d", i)) {
			t.Fatalf("pending output keep-%d was lost on quit:\n%s", i, out)
		}
	}
}

func TestListsShowFullPeerIDs(t *testing.T) {
	m := testModel(t)
	m.cmdPeers()
	if !logContains(m, fakePeer) {
		t.Fatalf("list output missing full Peer ID: %v", m.log)
	}
	if logContains(m, "Peer ID：") {
		t.Fatalf("list output still uses the old multi-line Peer ID label: %v", m.log)
	}
	count := 0
	for _, line := range m.log {
		if strings.Contains(line.Text, fakePeer) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("node appeared %d times, want once: %v", count, m.log)
	}
}

func TestFilesAndPublishedCommands(t *testing.T) {
	m := testModel(t)
	cmd := m.cmdFiles("b-quic")
	if cmd == nil {
		t.Fatal("/files produced no command")
	}
	m.Update(cmd())
	for _, want := range []string{"posts/a.txt", "posts/b.txt", "profile/index.md", "共 3 个文件"} {
		if !logContains(m, want) {
			t.Fatalf("/files output missing %q: %v", want, m.log)
		}
	}
	m.log = nil
	cmd = m.cmdPublished(false)
	if cmd == nil {
		t.Fatal("/published produced no command")
	}
	m.Update(cmd())
	for _, want := range []string{"friends.json 最后变更时间", "posts/a.txt", "3 B", "posts/.hidden", "hidden name", "已跳过：1"} {
		if !logContains(m, want) {
			t.Fatalf("/published output missing %q: %v", want, m.log)
		}
	}
	m.log = nil
	cmd = m.cmdPublished(true)
	if cmd == nil {
		t.Fatal("/published sync produced no command")
	}
	m.Update(cmd())
	for _, want := range []string{"✓ friends.json 已重写", "已发布：1 个文件"} {
		if !logContains(m, want) {
			t.Fatalf("/published sync output missing %q: %v", want, m.log)
		}
	}
}

func TestGetUsageExplainsRemoteManifestPath(t *testing.T) {
	m := testModel(t)
	m.execCommand("/get b-quic")
	if !logContains(m, "清单路径") || !logContains(m, "不是本地保存位置") || !logContains(m, "/files") {
		t.Fatalf("/get usage missing remote manifest explanation: %v", m.log)
	}
}

func TestFriendsAndNamesCommandsAreRemoved(t *testing.T) {
	for _, command := range []string{"/friends", "/names"} {
		m := testModel(t)
		m.execCommand(command)
		if !logContains(m, "未知指令") {
			t.Fatalf("%s should be unknown: %v", command, m.log)
		}
		if logContains(m, fakePeer) {
			t.Fatalf("%s still listed peers: %v", command, m.log)
		}
	}
}

func TestPeersMergesFriendsAndKnownPeersOncePerNode(t *testing.T) {
	m := testModel(t)
	m.friends = []*apiv1.Friend{
		{Name: "小明", PeerId: fakePeer, ManuallyConnected: true, Addrs: []string{"a", "b"}},
		{Name: "server", PeerId: fakePeer2, Description: "测试", Paused: true, Addrs: []string{"a", "b", "c", "d"}},
	}
	m.peers = []*apiv1.PeerEntry{
		{PeerId: fakePeer, Online: true, Route: "direct", Transport: "quic", Direct: true, Direction: "outbound", Addrs: []string{"a"}},
		{PeerId: fakeRelay, Online: true, Route: "relay", Transport: "tcp", Limited: true, RelayPeerId: fakePeer},
		{PeerId: fakePeer2, Online: false},
	}
	m.log = nil
	m.cmdPeers()
	if len(m.log) != 3 {
		t.Fatalf("merged peers lines = %d, want 3: %v", len(m.log), m.log)
	}
	wantOrder := []string{fakePeer, fakePeer2, fakeRelay}
	for i, line := range m.log {
		if !strings.Contains(line.Text, wantOrder[i]) {
			t.Fatalf("line %d = %q, want peer %s", i, line.Text, wantOrder[i])
		}
		if strings.Count(line.Text, wantOrder[i]) != 1 {
			t.Fatalf("peer appeared twice on one line: %q", line.Text)
		}
	}
	friendLine := m.log[0].Text
	for _, want := range []string{"小明", "在线", "直连/QUIC", "手动", "出站"} {
		if !strings.Contains(friendLine, want) {
			t.Fatalf("online friend line missing %q: %q", want, friendLine)
		}
	}
	offline := m.log[1].Text
	for _, want := range []string{"server", "离线", "地址=4", "暂停", "描述=测试"} {
		if !strings.Contains(offline, want) {
			t.Fatalf("offline friend line missing %q: %q", want, offline)
		}
	}
	relay := m.log[2].Text
	for _, want := range []string{"-", "在线", "中继/TCP", "受限", "中继 via 小明"} {
		if !strings.Contains(relay, want) {
			t.Fatalf("relay line missing %q: %q", want, relay)
		}
	}
	// The full ID is last and starts in the same display column on every line.
	width := -1
	for _, line := range m.log {
		idx := strings.LastIndex(line.Text, " ")
		if idx < 0 || !strings.HasSuffix(line.Text, wantOrder[len(m.log)-1]) && false {
			t.Fatalf("Peer ID is not the last column: %q", line.Text)
		}
		w := ansi.StringWidth(line.Text[:idx])
		if width < 0 {
			width = w
		} else if w != width {
			t.Fatalf("Peer ID column misaligned: %q (prefix width %d, want %d)", line.Text, w, width)
		}
	}
	for _, line := range m.log {
		if strings.Contains(line.Text, "direct=") || strings.Contains(line.Text, "limited=") || strings.Contains(line.Text, "未连接") {
			t.Fatalf("old peer fields leaked: %q", line.Text)
		}
	}
}

func TestHelpIsGroupedAndFitsOneLine(t *testing.T) {
	m := testModel(t)
	m.execCommand("/help")
	for _, group := range helpGroups {
		if !logContains(m, group) {
			t.Fatalf("/help missing group %q: %v", group, m.log)
		}
	}
	for _, c := range commands {
		if c.Name == "/friends" || c.Name == "/names" {
			t.Fatalf("/help still contains removed command %s", c.Name)
		}
	}
	for _, line := range m.log {
		if ansi.StringWidth(line.Text) > 80 {
			t.Fatalf("help line wider than 80 columns: %q", line.Text)
		}
	}
	m.input.SetValue("/")
	m.updatePopup()
	for _, line := range m.popupLines() {
		if ansi.StringWidth(line) > 79 {
			t.Fatalf("popup line wider than the render area: %q", line)
		}
	}
}

func TestHumanReadableSizes(t *testing.T) {
	if got := humanBytes(16); got != "16 B" {
		t.Fatalf("humanBytes(16) = %q", got)
	}
	if got := humanBytes(1536); got != "1.5 KiB" {
		t.Fatalf("humanBytes(1536) = %q", got)
	}
	m := testModel(t)
	cmd := m.cmdFiles("b-quic")
	m.Update(cmd())
	for _, want := range []string{"清单：b-quic，共 3 个文件", "posts/a.txt", "1 B", "2 B", "3 B"} {
		if !logContains(m, want) {
			t.Fatalf("/files output missing %q: %v", want, m.log)
		}
	}
	m.log = nil
	cmd = m.cmdGet("b-quic", "posts/a.txt")
	for _, msg := range runCommandMessages(cmd) {
		m.Update(msg)
	}
	if !logContains(m, "大小：1 B") {
		t.Fatalf("/get size is not human-readable: %v", m.log)
	}
}

func TestErrTextStripsConnectCodePrefix(t *testing.T) {
	err := connect.NewError(connect.CodeUnavailable, errors.New("dial failed: timeout"))
	if got := errText(err); got != "dial failed: timeout" {
		t.Fatalf("errText = %q, want server message", got)
	}
	if strings.Contains(errText(err), "unavailable:") {
		t.Fatalf("errText kept code prefix: %q", errText(err))
	}
	if got := errText(errors.New("plain")); got != "plain" {
		t.Fatalf("errText plain = %q", got)
	}
}

func TestSendResultWording(t *testing.T) {
	m := testModel(t)
	m.handleSendResult(sendResultMsg{
		res:  &apiv1.SendChatResponse{Acked: true, Route: "direct", Transport: "quic", OutboxStatus: "acked"},
		text: "hello", name: "bob", peerID: fakePeer, elapsed: 7 * time.Millisecond,
	})
	if !logContains(m, "→ bob：hello ✓ 7 ms") {
		t.Fatalf("direct success line = %v", m.log)
	}
	if logContains(m, "你对") || logContains(m, "发送给") || logContains(m, "ACK") {
		t.Fatalf("old send wording leaked: %v", m.log)
	}
	m.log = nil
	m.handleSendResult(sendResultMsg{
		res:  &apiv1.SendChatResponse{Acked: true, Route: "relay", Transport: "tcp", OutboxStatus: "acked"},
		text: "hello", name: "bob", peerID: fakePeer, elapsed: 7 * time.Millisecond,
	})
	if !logContains(m, "经中继") {
		t.Fatalf("relay send line missing route: %v", m.log)
	}
	m.log = nil
	m.handleSendResult(sendResultMsg{
		res:  &apiv1.SendChatResponse{OutboxStatus: "pending", Error: "queued"},
		text: "hello", name: "bob", peerID: fakePeer,
	})
	if !logContains(m, "→ bob：hello 待发（queued）") {
		t.Fatalf("pending send line = %v", m.log)
	}
	m.log = nil
	m.handleSendResult(sendResultMsg{
		err:  connect.NewError(connect.CodeUnavailable, errors.New("dial failed")),
		text: "hello", name: "bob", peerID: fakePeer,
	})
	if !logContains(m, "→ bob：hello ✗（dial failed）") || logContains(m, "unavailable:") {
		t.Fatalf("failed send line = %v", m.log)
	}
}

func TestConnectionEventWordingDropsBooleanJargon(t *testing.T) {
	m := testModel(t)
	m.handleEvent(&apiv1.EventsResponse{AtUnixMs: 1000, Body: &apiv1.EventsResponse_Connection{Connection: &apiv1.ConnectionEvent{
		PeerId: fakePeer, Kind: "connected", Route: "direct", Transport: "quic", Direct: true,
	}}})
	if !logContains(m, "连接 b-quic：直连/QUIC") {
		t.Fatalf("direct connection line = %v", m.log)
	}
	if logContains(m, "direct=") || logContains(m, "●") || logContains(m, "○") {
		t.Fatalf("old connection fields/symbols leaked: %v", m.log)
	}
	m.log = nil
	m.handleEvent(&apiv1.EventsResponse{AtUnixMs: 1001, Body: &apiv1.EventsResponse_Connection{Connection: &apiv1.ConnectionEvent{
		PeerId: fakePeer, Kind: "connected", Route: "relay", Transport: "tcp", Limited: true,
	}}})
	if !logContains(m, "中继/TCP") || !logContains(m, "受限") {
		t.Fatalf("relay connection line = %v", m.log)
	}
}

func TestConnectAttemptFailuresUseCandidateReason(t *testing.T) {
	m := testModel(t)
	m.Update(connectResultMsg{
		res: &apiv1.ConnectResponse{
			PeerId: fakePeer, Route: "direct", Transport: "quic", Direct: true,
			Attempts: []*apiv1.DialAttempt{{Multiaddr: "/ip4/1.1.1.1/tcp/1", Ok: false, Error: "i/o timeout"}},
		},
		name: "b-quic",
	})
	if !logContains(m, "候选失败 /ip4/1.1.1.1/tcp/1：超时") {
		t.Fatalf("candidate failure was not translated: %v", m.log)
	}
	if logContains(m, "候选失败 /ip4/1.1.1.1/tcp/1：i/o timeout") {
		t.Fatalf("raw candidate error leaked: %v", m.log)
	}
}

func TestShortIDAndProgressLabelsNeverDoubleEllipsis(t *testing.T) {
	id := shortID("12D3KooWKCqnDBabcdefghijklmnop")
	if !strings.HasSuffix(id, "…") {
		t.Fatalf("shortID = %q", id)
	}
	if second := shortID(id); second != id {
		t.Fatalf("shortID not idempotent: %q -> %q", id, second)
	}
	label := progressLabel("正在连接 " + id)
	if strings.Contains(label, "……") {
		t.Fatalf("progress label has a double ellipsis: %q", label)
	}
	if label != "正在连接 "+id {
		t.Fatalf("progress label = %q", label)
	}
	if got := progressLabel("正在连接 b-quic"); got != "正在连接 b-quic…" {
		t.Fatalf("plain progress label = %q", got)
	}
}

// TestQuitIsIssuedOnlyOnce guards the flush on exit: a message arriving after
// the flush sequence started must not emit another tea.Quit, because that quit
// could overtake the final Println and lose output.
func TestQuitIsIssuedOnlyOnce(t *testing.T) {
	m := headlessModel(t)
	m.appendLog("last line")
	m.quitting = true
	_, first := m.Update(tickMsg(time.Now()))
	if first == nil {
		t.Fatal("first update while quitting must flush and quit")
	}
	if !m.quitIssued {
		t.Fatal("quit must be recorded as issued")
	}
	if _, second := m.Update(refreshMsg{}); second != nil {
		t.Fatal("a later message must not issue another quit")
	}
}

// TestColoursNeverQueryTerminal guards against lipgloss.AdaptiveColor, which
// queries the terminal background on first use. In a PTY that stalled the TUI
// for about six seconds and lost the keys typed meanwhile.
func TestColoursNeverQueryTerminal(t *testing.T) {
	for _, c := range []lipgloss.TerminalColor{colorSuccess, colorError, colorWarning, colorIncoming} {
		if _, ok := c.(lipgloss.Color); !ok {
			t.Fatalf("colour %T may query the terminal; use a standard ANSI lipgloss.Color", c)
		}
	}
}

// TestPrintedOutputErasesOldFrame guards against popup text staying glued to a
// long address: the row a wrapped line lands on isn't erased by the renderer.
func TestPrintedOutputErasesOldFrame(t *testing.T) {
	m := headlessModel(t)
	m.appendLog("line")
	if got := m.pendingText(); !strings.HasPrefix(got, ansi.EraseScreenBelow) {
		t.Fatalf("printed output must start by erasing the old frame: %q", got)
	}
}

func TestUnnamedFriendIsNeverBlankCompletion(t *testing.T) {
	m := headlessModel(t)
	const id = "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"
	m.friends = []*apiv1.Friend{{PeerId: id}}
	items := m.peerCompletions("")
	if len(items) != 1 || items[0].Label != id || items[0].Insert != id {
		t.Fatalf("unnamed friend must be offered by Peer ID: %+v", items)
	}
}

func TestEnterWithEmptyArgumentDoesNotPickSoleCandidate(t *testing.T) {
	m := headlessModel(t)
	const id = "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"
	m.friends = []*apiv1.Friend{{PeerId: id}}
	m.input.SetValue("/chat ")
	m.input.CursorEnd()
	m.updatePopup()
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if m.target != nil {
		t.Fatalf("Enter on an empty argument must not choose %q", m.target.PeerID)
	}
}

func TestContentDialErrorIsSummarised(t *testing.T) {
	m := headlessModel(t)
	m.appendContentError(errors.New(`fetch manifest: dial peer X failed: all dials failed\n  * [/ip4/127.0.0.1/tcp/1] dial tcp4 127.0.0.1:1: connect: connection refused`))
	if len(m.log) != 2 || !strings.Contains(m.log[0].Text, "无法连接对方") || !strings.Contains(m.log[1].Text, "连接被拒绝") {
		t.Fatalf("dial failure must be summarised: %+v", m.log)
	}
}

func TestEscExitsChatOnlyWhenInputIsEmpty(t *testing.T) {
	m := headlessModel(t)
	m.target = &chatTarget{Name: "bob", PeerID: "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"}
	m.syncPrompt()
	m.input.SetValue("draft")

	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if m.target == nil || m.input.Value() != "" {
		t.Fatalf("first Esc must only clear the input: target=%v value=%q", m.target, m.input.Value())
	}

	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if m.target != nil {
		t.Fatal("Esc on empty input must exit chat")
	}
	if got := m.prompt(); got != "> " {
		t.Fatalf("prompt after exit = %q", got)
	}
	if last := m.log[len(m.log)-1].Text; !strings.Contains(last, "已退出与 bob 的聊天") {
		t.Fatalf("missing exit notice: %q", last)
	}

	before := len(m.log)
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if len(m.log) != before {
		t.Fatal("Esc with no chat target must not print anything")
	}
}

func TestEscClosesPopupBeforeExitingChat(t *testing.T) {
	m := headlessModel(t)
	m.target = &chatTarget{Name: "bob", PeerID: "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"}
	m.input.SetValue("/")
	m.updatePopup()
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
	if m.target == nil || m.popup.active {
		t.Fatalf("Esc must close the popup and keep the chat: target=%v popup=%v", m.target, m.popup.active)
	}
}

func TestExitChatCancelsRelayStopObservation(t *testing.T) {
	m := headlessModel(t)
	m.target = &chatTarget{Name: "bob", PeerID: "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"}
	m.relayStopAt = time.Now()
	m.exitChat()
	if !m.relayStopAt.IsZero() {
		t.Fatal("a pending relay-stop observation must be cancelled with the chat")
	}
}

func TestPeerFriendLinesShowFullIDAndAddrs(t *testing.T) {
	const addr = "/ip4/203.0.113.7/tcp/4001/p2p/" + fakePeer2
	lines := peerFriendLines("owner", "owner", []*apiv1.PeerFriendClaim{
		{Name: "c", PeerId: fakePeer2, Addrs: []string{addr}, Description: "desc"},
		{PeerId: fakePeer},
	})
	text := strings.Join(lines, "\n")
	for _, want := range []string{"未验证", fakePeer2, fakePeer, addr, "描述=desc", "（没有可用地址）", "/connect owner"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
}

func TestPeerFriendLinesSanitizeRemoteText(t *testing.T) {
	lines := peerFriendLines("owner", "owner", []*apiv1.PeerFriendClaim{{Name: "evil\x1b[31m", PeerId: fakePeer2, Description: "x\x1b]52;c;AAAA\x07"}})
	if text := strings.Join(lines, "\n"); strings.ContainsRune(text, 0x1b) || strings.ContainsRune(text, 0x07) {
		t.Fatalf("remote control characters reached the terminal: %q", text)
	}
}

func TestConnectListedUsesTheListAndReportsMissing(t *testing.T) {
	m := headlessModel(t)
	got, ok := connectListed(m.client, fakePeer, "C").(connectResultMsg)
	if !ok || got.err != nil || got.res.GetPeerId() != fakePeer2 {
		t.Fatalf("listed peer must be connected: %+v", got)
	}
	missing := connectListed(m.client, fakePeer, "nobody").(connectResultMsg)
	if missing.res != nil || !strings.Contains(missing.notice, "nobody") {
		t.Fatalf("a missing peer must be reported, not dialled: %+v", missing)
	}
	m.handleConnectResult(missing)
	if last := m.log[len(m.log)-1].Text; strings.Contains(last, "候选地址") {
		t.Fatalf("not-found must not read as a dial failure: %q", last)
	}
}

func TestConnectTwoFieldsDispatch(t *testing.T) {
	m := headlessModel(t)
	m.execCommand("/connect " + fakePeer + " C")
	if !m.busy {
		t.Fatal("owner + listed peer must start a listed connect")
	}

	m = headlessModel(t)
	// A Peer ID split by a space isn't an owner: it must not be read as one.
	half := len(fakePeer2) / 2
	m.execCommand("/connect " + fakePeer2[:half] + " " + fakePeer2[half:])
	if !m.busy {
		t.Fatalf("a split Peer ID must be rejoined and connected: %+v", m.log)
	}

	m = headlessModel(t)
	m.execCommand("/connect /ip4/203.0.113.7/tcp/4001/p2p/ " + fakePeer2)
	if !m.busy {
		t.Fatalf("a wrapped address must be rejoined and connected: %+v", m.log)
	}
}

func TestConnectSecondArgumentHasNoPopup(t *testing.T) {
	m := headlessModel(t)
	m.friends = []*apiv1.Friend{{PeerId: fakePeer, Name: "owner"}}
	m.input.SetValue("/connect owner c")
	m.input.CursorEnd()
	m.updatePopup()
	if m.popup.active {
		t.Fatalf("the listed peer isn't a local node, so no local candidates apply: %+v", m.popup.items)
	}
}

type badListClient struct {
	*fakeClient
	err error
}

func (c badListClient) GetPeerFriends(context.Context, string) (*apiv1.GetPeerFriendsResponse, error) {
	return nil, c.err
}

func TestConnectListedSeparatesListErrorsFromDialErrors(t *testing.T) {
	bad := connectListed(badListClient{&fakeClient{}, errors.New("friends.json contains control characters")}, fakePeer, "c").(connectResultMsg)
	if bad.err != nil || !strings.Contains(bad.notice, "读取对方好友列表失败") {
		t.Fatalf("a bad list must not be reported as a dial failure: %+v", bad)
	}
	dial := connectListed(badListClient{&fakeClient{}, errors.New("fetch manifest: dial peer failed")}, fakePeer, "c").(connectResultMsg)
	if dial.err == nil || dial.notice != "" {
		t.Fatalf("a dial failure must stay a dial failure: %+v", dial)
	}
}

func TestAddrTypeLabel(t *testing.T) {
	const relay = "12D3KooWFds5JhUsCDJZYxddHyUTU2KsfFZGTRqoLcK5MFZEdtBr"
	for raw, want := range map[string]string{
		"/ip4/142.250.72.14/tcp/4001":                                       "公网 IPv4/TCP",
		"/ip4/142.250.72.14/udp/4001/quic-v1":                               "公网 IPv4/QUIC",
		"/ip6/2001:4860:4860:0000:0000:0:0:8888/udp/4001/quic-v1":           "公网 IPv6/QUIC",
		"/ip4/93.184.216.34/tcp/4001/p2p/" + relay + "/p2p-circuit":         "中继 IPv4/TCP",
		"/ip6/2606:4700:4700:0::111/tcp/4001/p2p/" + relay + "/p2p-circuit": "中继 IPv6/TCP",
		"/ip4/192.168.1.5/tcp/4001":                                         "局域网 IPv4/TCP",
		"not-an-address":                                                    "其他",
	} {
		if got := addrTypeLabel(raw); got != want {
			t.Errorf("addrTypeLabel(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestPeerFriendAddressStaysSelectableAfterLabel(t *testing.T) {
	const addr = "/ip6/2001:4860:4860:0000:0000:0:0:8888/tcp/4001"
	lines := peerFriendLines("o", "o", []*apiv1.PeerFriendClaim{{PeerId: fakePeer2, Addrs: []string{addr, "/ip4/142.250.72.14/udp/4001/quic-v1"}}})
	var found string
	for _, l := range lines {
		if strings.Contains(l, addr) {
			found = l
		}
	}
	if !strings.HasSuffix(found, "  "+addr) || !strings.Contains(found, "公网 IPv6/TCP") {
		t.Fatalf("label must precede an unbroken address: %q", found)
	}
}

func TestPeerDetailShowsConnectionsAndPasteableAddrs(t *testing.T) {
	m := headlessModel(t)
	const live = "/ip4/93.184.216.34/tcp/4001"
	m.friends = []*apiv1.Friend{{PeerId: fakePeer, Name: "server", Addrs: []string{live}}}
	m.peers = []*apiv1.PeerEntry{{PeerId: fakePeer, Online: true, Route: "direct", Transport: "tcp", Addrs: []string{live, "/ip4/93.184.216.34/udp/4001/quic-v1"}}}
	m.status = &apiv1.StatusResponse{Connections: []*apiv1.ConnectionDetail{
		{PeerId: fakePeer, RemoteMultiaddr: live, Route: "direct", Transport: "tcp"},
		{PeerId: fakePeer2, RemoteMultiaddr: "/ip4/198.51.100.1/tcp/1", Route: "direct", Transport: "tcp"},
	}}
	m.cmdPeerDetail("server")
	var b strings.Builder
	for _, l := range m.log {
		b.WriteString(l.Text + "\n")
	}
	text := b.String()
	for _, want := range []string{"server", "在线", "Peer ID：" + fakePeer, "当前连接（1 条）", "直连/TCP  " + live, "已知地址（2 条", "公网 IPv4/TCP", live + "/p2p/" + fakePeer, "公网 IPv4/QUIC"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "198.51.100.1") {
		t.Fatalf("another peer's connection leaked in:\n%s", text)
	}
}

func TestPeerDetailUnknownAndEmpty(t *testing.T) {
	m := headlessModel(t)
	m.friends = nil
	m.peers = nil
	m.cmdPeerDetail(fakePeer)
	if last := m.log[len(m.log)-1].Text; !strings.Contains(last, "没有这个节点的记录") {
		t.Fatalf("unknown peer: %q", last)
	}
	m.friends = []*apiv1.Friend{{PeerId: fakePeer, Name: "x"}}
	m.cmdPeerDetail("x")
	if last := m.log[len(m.log)-1].Text; !strings.Contains(last, "（没有）") {
		t.Fatalf("no addresses: %q", last)
	}
}

func TestPeersRowCountsAddrsWhenOnlineAndCompletesNames(t *testing.T) {
	m := headlessModel(t)
	m.friends = []*apiv1.Friend{{PeerId: fakePeer, Name: "server", Addrs: []string{"/ip4/93.184.216.34/tcp/4001"}}}
	m.peers = []*apiv1.PeerEntry{{PeerId: fakePeer, Online: true, Route: "direct", Transport: "tcp"}}
	m.log = nil
	m.cmdPeers()
	if len(m.log) != 1 || !strings.Contains(m.log[0].Text, "地址=1") {
		t.Fatalf("an online row must count addresses: %+v", m.log)
	}
	m.input.SetValue("/peers se")
	m.input.CursorEnd()
	m.updatePopup()
	if !m.popup.active || m.popup.items[0].Insert != "server" {
		t.Fatalf("/peers must complete node names: %+v", m.popup.items)
	}
}
