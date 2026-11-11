// Package tui implements the Raminga terminal test panel: inline output in the
// terminal's normal scrollback plus a small live region (status, input and
// completion popup). It is a thin client of the local UDS Connect API and owns
// no node state.
package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/peerarg"
	"github.com/Raminga/raminga/internal/report"
	"github.com/Raminga/raminga/internal/textsafe"
	"github.com/Raminga/raminga/internal/tuiinit"
)

// Options configure the TUI. Zero values are safe for tests.
type Options struct {
	Version     string
	DataDir     string
	ReportDir   string
	IncludeText bool
	Tick        time.Duration
	Plain       bool
	// Script is a non-interactive smoke/automation input list. Labs and the
	// interactive tests use real pty keystrokes instead.
	Script []string
	Now    func() time.Time
	// Clipboard receives an OSC52 sequence from /copy. nil means the live
	// terminal output (injected in tests).
	Clipboard io.Writer
}

type logLine struct {
	At    time.Time
	Text  string
	Event bool // asynchronous event: prefix the line with a dim timestamp
}

type chatTarget struct {
	Name   string
	PeerID string
}

type Model struct {
	client Client
	opts   Options

	width int

	status   *apiv1.StatusResponse
	peers    []*apiv1.PeerEntry
	messages []*apiv1.StoredMessage
	outbox   *apiv1.OutboxListResponse
	friends  []*apiv1.Friend

	log     []logLine
	pending []logLine
	input   textinput.Model

	// spin/activity drive the one live status segment. Ticks are only scheduled
	// while activity is non-empty; plain mode renders static text without them.
	spin     spinner.Model
	activity string

	downloadSeq    int
	dlPath         string
	dlReceived     int64
	dlTotal        int64
	dlHaveProgress bool

	// One serial output queue: tea.Println commands must never overlap or the
	// terminal can show later lines before earlier ones.
	inFlight bool
	quitting bool
	// quitIssued is set once the final flush and tea.Quit have been returned.
	quitIssued bool

	popup      popup
	viewNotice bool
	history    []string
	histIdx    int

	target *chatTarget

	busy    bool
	tuiSent map[string]bool

	stream    EventStream
	streamErr string

	apiFailing bool
	started    bool
	hasOutput  bool
	seenMsgs   map[string]bool

	timeline     []report.Event
	changes      []report.Change
	acks         []report.ACK
	lastRoutes   map[string]string
	liveRoutes   map[string]map[string]bool
	relayStopAt  time.Time
	directAtStop bool
	stillDirect  *bool
	stillSeconds int

	script     []string
	scriptAt   int
	autoErr    error
	scriptDone bool
}

// NewModel builds the single-screen model.
func NewModel(client Client, opts Options) *Model {
	tuiinit.Restore()
	if opts.Tick <= 0 {
		opts.Tick = 2 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ReportDir == "" {
		opts.ReportDir = strings.TrimRight(opts.DataDir, "/") + "/reports"
	}
	m := &Model{
		client:     client,
		opts:       opts,
		width:      80,
		lastRoutes: make(map[string]string),
		liveRoutes: make(map[string]map[string]bool),
		tuiSent:    make(map[string]bool),
		seenMsgs:   make(map[string]bool),
		script:     opts.Script,
	}
	m.input = textinput.New()
	m.input.Prompt = ""
	m.input.CharLimit = 4096
	m.input.Focus()
	m.spin = newSpinner()
	m.syncPrompt()
	return m
}

func newSpinner() spinner.Model {
	return spinner.New(spinner.WithSpinner(spinner.MiniDot))
}

func (m *Model) startActivity(label string) tea.Cmd {
	m.activity = label
	m.dlPath = ""
	m.dlReceived = 0
	m.dlTotal = 0
	m.dlHaveProgress = false
	if m.opts.Plain {
		return nil
	}
	m.spin = newSpinner()
	return m.spin.Tick
}

func (m *Model) finishActivity() {
	m.activity = ""
	m.dlPath = ""
	m.dlReceived = 0
	m.dlTotal = 0
	m.dlHaveProgress = false
}

func (m *Model) now() time.Time { return m.opts.Now() }

// Init starts polling, event subscription and optional scripted input.
func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.refreshCmd(), m.tickCmd(), m.subscribeCmd()}
	if len(m.script) > 0 {
		cmds = append(cmds, m.scriptCmd())
	}
	return tea.Batch(cmds...)
}

// AutoErr reports a scripted run failure.
func (m *Model) AutoErr() error { return m.autoErr }

// Close releases the event stream.
func (m *Model) Close() {
	if m.stream != nil {
		_ = m.stream.Close()
		m.stream = nil
	}
}

type tickMsg time.Time
type printedMsg struct{}
type scriptLineMsg struct {
	line string
	next int
}

type downloadProgressMsg struct {
	token int
	ch    <-chan *apiv1.DownloadPeerFileResponse
	res   *apiv1.DownloadPeerFileResponse
}

type downloadDoneMsg struct{ token int }

type refreshMsg struct {
	status   *apiv1.StatusResponse
	peers    *apiv1.PeersResponse
	messages *apiv1.RecentMessagesResponse
	outbox   *apiv1.OutboxListResponse
	friends  *apiv1.ListFriendsResponse
	err      error
	at       time.Time
}

type connectResultMsg struct {
	res     *apiv1.ConnectResponse
	name    string
	peerID  string
	err     error
	elapsed time.Duration
	// notice reports a failure that never reached dialling.
	notice string
}

type disconnectResultMsg struct {
	res    *apiv1.DisconnectPeerResponse
	name   string
	peerID string
	err    error
}

type sendResultMsg struct {
	res     *apiv1.SendChatResponse
	text    string
	name    string
	peerID  string
	err     error
	elapsed time.Duration
}

type cancelResultMsg struct {
	res *apiv1.OutboxCancelResponse
	err error
}

type contentResultMsg struct {
	kind  string
	lines []string
	err   error
}

type friendResultMsg struct {
	op      string
	friend  *apiv1.Friend
	removed bool
	pending int
	err     error
}

type reportResultMsg struct {
	jsonPath, mdPath string
	err              error
}

type streamReadyMsg struct {
	stream EventStream
	err    error
}
type eventMsg struct{ ev *apiv1.EventsResponse }
type streamErrMsg struct{ err error }
type retryStreamMsg struct{}

func (m *Model) tickCmd() tea.Cmd {
	return tea.Tick(m.opts.Tick, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *Model) refreshCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		out := refreshMsg{at: time.Now()}
		st, err := client.Status(ctx)
		if err != nil {
			out.err = err
			return out
		}
		out.status = st
		if peers, err := client.Peers(ctx, true); err != nil {
			out.err = err
		} else {
			out.peers = peers
		}
		if msgs, err := client.RecentMessages(ctx, 200); err != nil {
			out.err = err
		} else {
			out.messages = msgs
		}
		if ob, err := client.OutboxList(ctx, 200); err != nil {
			out.err = err
		} else {
			out.outbox = ob
		}
		if friends, err := client.ListFriends(ctx); err != nil {
			out.err = err
		} else {
			out.friends = friends
		}
		return out
	}
}

func (m *Model) subscribeCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		stream, err := client.Events(ctx)
		if err != nil {
			cancel()
			return streamReadyMsg{err: err}
		}
		return streamReadyMsg{stream: &cancelableStream{EventStream: stream, cancel: cancel}}
	}
}

type cancelableStream struct {
	EventStream
	cancel context.CancelFunc
}

func (c *cancelableStream) Close() error {
	c.cancel()
	return c.EventStream.Close()
}

func waitEventCmd(stream EventStream) tea.Cmd {
	return func() tea.Msg {
		ev, err := stream.Recv()
		if err != nil {
			return streamErrMsg{err: err}
		}
		return eventMsg{ev: ev}
	}
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		if m.width < 40 {
			m.width = 40
		}
		m.syncInputWidth()
	case tea.KeyMsg:
		cmd, quit := m.handleKey(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		if quit {
			m.quitting = true
		}
	case refreshMsg:
		if msg.err != nil {
			if !m.apiFailing {
				m.apiFailing = true
				m.appendEvent("! %s", errText(msg.err))
			}
		} else if m.apiFailing {
			m.apiFailing = false
			m.appendEvent("✓ 本地节点已恢复")
		}
		m.applyRefresh(msg)
	case printedMsg:
		m.inFlight = false
	case tickMsg:
		cmds = append(cmds, m.refreshCmd(), m.tickCmd())
	case spinner.TickMsg:
		if m.activity == "" || m.opts.Plain {
			break
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		cmds = append(cmds, cmd)
	case downloadProgressMsg:
		if msg.token == m.downloadSeq && m.activity != "" {
			m.setDownloadProgress(msg.res)
			cmds = append(cmds, waitDownloadProgress(msg.token, msg.ch))
		}
	case connectResultMsg:
		m.busy = false
		m.finishActivity()
		m.handleConnectResult(msg)
		cmds = append(cmds, m.refreshCmd())
	case disconnectResultMsg:
		if msg.err != nil {
			m.appendEvent("✗ 断开 %s 失败：%s", msg.name, errText(msg.err))
		} else {
			m.appendEvent("✓ 已断开 %s（%s）", msg.name, shortID(msg.peerID))
			for _, note := range m.disconnectNotices(msg.peerID) {
				m.appendEvent("  · %s", note)
			}
		}
		cmds = append(cmds, m.refreshCmd())
	case sendResultMsg:
		m.busy = false
		m.finishActivity()
		if msg.res != nil && msg.res.GetMessageId() != "" {
			m.tuiSent[msg.res.GetMessageId()] = true
			m.seenMsgs[msg.res.GetMessageId()] = true
		}
		m.handleSendResult(msg)
		cmds = append(cmds, m.refreshCmd())
	case cancelResultMsg:
		if msg.err != nil {
			m.appendLog("✗ 取消失败：%s", errText(msg.err))
		} else if msg.res.GetCancelled() {
			m.appendLog("✓ 已取消待发消息（%s）", outboxStatus(msg.res.GetStatus()))
		} else {
			m.appendLog("! 该消息无法取消（%s）", outboxStatus(msg.res.GetStatus()))
		}
		cmds = append(cmds, m.refreshCmd())
	case contentResultMsg:
		if msg.kind == "get" {
			m.busy = false
			m.finishActivity()
		}
		for _, line := range msg.lines {
			m.appendLog("%s", line)
		}
		if msg.err != nil {
			m.appendContentError(msg.err)
		}
		cmds = append(cmds, m.refreshCmd())
	case friendResultMsg:
		if msg.err != nil {
			if msg.op == "forget" && (msg.pending > 0 || strings.Contains(errText(msg.err), "待发")) {
				m.appendLog("! %s；确认取消后重试 /forget --cancel-pending", errText(msg.err))
			} else {
				m.appendLog("✗ 好友操作失败：%s", errText(msg.err))
			}
		} else if msg.op == "forget" {
			m.appendLog("✓ 已从好友表删除")
		} else if msg.friend != nil {
			if msg.op == "describe" {
				m.appendLog("✓ 已保存描述：%s", msg.friend.GetDescription())
			} else {
				m.appendLog("✓ 已保存名字：%s（%s）", msg.friend.GetName(), shortID(msg.friend.GetPeerId()))
			}
		}
		cmds = append(cmds, m.refreshCmd())
	case reportResultMsg:
		if msg.err != nil {
			m.appendLog("✗ 报告导出失败：%s", errText(msg.err))
		} else {
			m.appendLog("✓ 报告已保存：%s", msg.jsonPath)
			m.appendLog("✓ Markdown：%s", msg.mdPath)
		}
	case streamReadyMsg:
		if msg.err != nil {
			m.streamErr = msg.err.Error()
			cmds = append(cmds, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return retryStreamMsg{} }))
		} else {
			m.stream = msg.stream
			m.streamErr = ""
			cmds = append(cmds, waitEventCmd(m.stream))
		}
	case retryStreamMsg:
		if m.stream == nil {
			cmds = append(cmds, m.subscribeCmd())
		}
	case eventMsg:
		m.handleEvent(msg.ev)
		if m.stream != nil {
			cmds = append(cmds, waitEventCmd(m.stream))
		}
	case streamErrMsg:
		m.streamErr = msg.err.Error()
		old := m.stream
		m.stream = nil
		if old != nil {
			cmds = append(cmds, func() tea.Msg {
				_ = old.Close()
				return nil
			})
		}
		cmds = append(cmds, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return retryStreamMsg{} }))
	case scriptLineMsg:
		if msg.next >= len(m.script) {
			m.scriptDone = true
		}
		m.input.SetValue(msg.line)
		cmd, quit := m.submit()
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		if quit {
			m.quitting = true
		} else if !m.scriptDone {
			m.scriptAt = msg.next
			cmds = append(cmds, m.scriptCmd())
		}
	}

	if m.quitting {
		// Wait for the in-flight print first, then flush whatever is queued.
		if m.inFlight {
			return m, tea.Batch(cmds...)
		}
		// Issue the quit only once. A second tea.Quit from a later message
		// (such as a refresh) could overtake the Println in the flush sequence
		// and drop the final lines.
		if m.quitIssued {
			return m, nil
		}
		m.quitIssued = true
		return m, m.quitCmd()
	}
	if cmd := m.printPendingCmd(); cmd != nil {
		cmds = append(cmds, cmd)
	}
	return m, tea.Batch(cmds...)
}

// printPendingCmd drains the serial output queue. There is at most one
// tea.Println in flight so lines can never be reordered by concurrent Cmds.
func (m *Model) printPendingCmd() tea.Cmd {
	if m.inFlight || len(m.pending) == 0 {
		return nil
	}
	joined := m.pendingText()
	m.pending = nil
	m.inFlight = true
	return tea.Sequence(tea.Println(joined), func() tea.Msg { return printedMsg{} })
}

// quitCmd flushes pending output before quitting. The caller guarantees that
// no tea.Println is still in flight.
func (m *Model) quitCmd() tea.Cmd {
	if len(m.pending) == 0 {
		return tea.Quit
	}
	joined := m.pendingText()
	m.pending = nil
	return tea.Sequence(tea.Println(joined), tea.Quit)
}

func (m *Model) pendingText() string {
	lines := make([]string, 0, len(m.pending))
	for _, line := range m.pending {
		lines = append(lines, m.renderLogLine(line))
	}
	// Queued lines are written over the previous live frame, and Bubble Tea
	// doesn't erase the row a wider-than-terminal line wraps onto. Without this,
	// old popup text stays glued to the end of a long address.
	return ansi.EraseScreenBelow + strings.Join(lines, "\n")
}

func (m *Model) scriptCmd() tea.Cmd {
	if m.scriptAt >= len(m.script) {
		return nil
	}
	i := m.scriptAt
	line := m.script[i]
	return tea.Tick(400*time.Millisecond, func(time.Time) tea.Msg {
		return scriptLineMsg{line: line, next: i + 1}
	})
}

func (m *Model) handleKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	if msg.String() == "ctrl+c" {
		if m.input.Value() != "" {
			m.input.SetValue("")
			m.input.CursorEnd()
			m.popup.active = false
			m.popup.moved = false
			return nil, false
		}
		return nil, true
	}
	if m.popup.active {
		switch msg.String() {
		case "up", "shift+tab":
			m.popupMove(-1)
			return nil, false
		case "down":
			m.popupMove(1)
			return nil, false
		case "tab":
			return m.completeSelected()
		case "esc":
			m.popup.active = false
			m.popup.moved = false
			return nil, false
		case "enter":
			return m.enterPopup()
		}
	}
	switch msg.String() {
	case "up":
		m.historyPrev()
		return nil, false
	case "down":
		m.historyNext()
		return nil, false
	case "enter":
		cmd, quit := m.submit()
		return cmd, quit
	case "esc":
		if m.input.Value() == "" && m.target != nil {
			m.exitChat()
			return nil, false
		}
		m.input.SetValue("")
		m.popup.active = false
		m.popup.moved = false
		return nil, false
	case "ctrl+l":
		return m.clearScreen(), false
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	m.updatePopup()
	return cmd, false
}

// commandStage reports whether the popup is completing the command token
// itself, i.e. the input is "/" plus a token with no argument separator yet.
func (m *Model) commandStage() bool {
	value := m.input.Value()
	if !strings.HasPrefix(value, "/") {
		return false
	}
	return !strings.ContainsAny(strings.TrimPrefix(value, "/"), " \t")
}

// enterPopup applies the Claude-Code-style Enter contract:
//   - command stage: take the highlighted command; fill its trailing space and
//     stay for arguments, or run it when it takes none;
//   - argument stage: accept the highlighted value if the user moved the
//     selection or there is exactly one candidate, then run when complete;
//     otherwise run the line exactly as typed.
func (m *Model) enterPopup() (tea.Cmd, bool) {
	if !m.popup.active || len(m.popup.items) == 0 {
		m.popup.active = false
		return m.submit()
	}
	if m.commandStage() {
		item := m.popup.items[m.popup.sel]
		cmd, ok, _ := resolveCommand(strings.TrimSpace(item.Insert))
		if !ok {
			m.input.SetValue(item.Insert)
			m.input.CursorEnd()
			m.popup.moved = false
			m.updatePopup()
			return nil, false
		}
		if cmd.Args {
			m.input.SetValue(cmd.Name + " ")
			m.input.CursorEnd()
			m.popup.moved = false
			m.updatePopup()
			return nil, false
		}
		m.input.SetValue(cmd.Name)
		m.input.CursorEnd()
		m.popup.active = false
		m.popup.moved = false
		return m.submit()
	}
	// A sole candidate is accepted only once something was typed for it, so
	// "/connect " + Enter shows the usage instead of dialling the only peer.
	if m.popup.moved || (len(m.popup.items) == 1 && m.popup.argEnd > m.popup.argStart) {
		if cmd, quit := m.completeSelected(); cmd != nil || quit {
			return cmd, quit
		}
		if m.inputSubmittable() {
			return m.submit()
		}
		return nil, false
	}
	return m.submit()
}

// inputSubmittable reports whether the current command line has every required
// positional argument. It is used only after accepting an argument completion;
// a missing-argument line is still submitted normally and prints its usage.
func (m *Model) inputSubmittable() bool {
	value := strings.TrimSpace(m.input.Value())
	if !strings.HasPrefix(value, "/") {
		return false
	}
	fields := strings.Fields(value)
	cmd, ok, _ := resolveCommand(fields[0])
	if !ok {
		return false
	}
	if !cmd.Args {
		return true
	}
	return len(fields)-1 >= len(cmd.ArgKinds)
}

func (m *Model) submit() (tea.Cmd, bool) {
	raw := m.input.Value()
	line := strings.TrimSpace(raw)
	if line == "" {
		m.input.SetValue("")
		m.popup.active = false
		return nil, false
	}
	if m.busy && m.wouldRefuse(line) {
		m.input.SetValue(raw)
		m.input.CursorEnd()
		m.popup.active = false
		m.popup.moved = false
		m.appendLog("… 上一个操作尚未结束，内容已保留")
		return nil, false
	}
	m.input.SetValue("")
	m.popup.active = false
	m.popup.moved = false
	m.history = append(m.history, line)
	m.histIdx = len(m.history)
	if strings.HasPrefix(line, "/") {
		if m.hasOutput {
			m.appendLog("")
		}
		m.appendLog("> %s", line)
		return m.execCommand(line)
	}
	return m.sendPlain(line), false
}

// wouldRefuse reports whether the line would be rejected by the current busy
// guard. Only connect and chat send have that guard; any other command is
// allowed to run and report its own result.
func (m *Model) wouldRefuse(line string) bool {
	if !strings.HasPrefix(line, "/") {
		return m.target != nil
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return false
	}
	cmd, ok, _ := resolveCommand(fields[0])
	return ok && cmd.Name == "/connect" && len(fields) > 1
}

func (m *Model) historyPrev() {
	if len(m.history) == 0 {
		return
	}
	if m.histIdx > 0 {
		m.histIdx--
	}
	m.input.SetValue(m.history[m.histIdx])
	m.input.CursorEnd()
}

func (m *Model) historyNext() {
	if len(m.history) == 0 {
		return
	}
	if m.histIdx < len(m.history)-1 {
		m.histIdx++
		m.input.SetValue(m.history[m.histIdx])
	} else {
		m.histIdx = len(m.history)
		m.input.SetValue("")
	}
	m.input.CursorEnd()
}

// appendLine enqueues one sanitized line for the serial printer and keeps a
// bounded copy for tests/reports. Remote text is sanitized here, before it can
// reach either the queue or the terminal.
func (m *Model) appendLine(line logLine) {
	line.Text = textsafe.Sanitize(line.Text)
	m.log = append(m.log, line)
	if len(m.log) > 2000 {
		m.log = m.log[len(m.log)-2000:]
	}
	m.pending = append(m.pending, line)
	m.hasOutput = true
}

// appendLog is command output: no timestamp prefix.
func (m *Model) appendLog(format string, args ...any) {
	m.appendLine(logLine{At: m.now(), Text: fmt.Sprintf(format, args...)})
}

// appendEvent is asynchronous output (chat, connections, route changes and
// event-driven errors): keep the wall-clock time visible.
func (m *Model) appendEvent(format string, args ...any) {
	m.appendEventAt(m.now(), format, args...)
}

func (m *Model) appendEventAt(at time.Time, format string, args ...any) {
	m.appendLine(logLine{At: at, Event: true, Text: fmt.Sprintf(format, args...)})
}

// clearScreen discards queued output and clears the terminal view. The
// terminal's scrollback is intentionally not touched.
func (m *Model) clearScreen() tea.Cmd {
	m.pending = nil
	m.log = nil
	return tea.ClearScreen
}

func (m *Model) applyRefresh(msg refreshMsg) {
	if msg.status != nil {
		m.status = msg.status
	}
	if msg.peers != nil {
		m.peers = msg.peers.GetPeers()
	}
	if msg.messages != nil {
		m.messages = msg.messages.GetMessages()
	}
	if msg.outbox != nil {
		m.outbox = msg.outbox
	} else if m.outbox == nil {
		m.outbox = &apiv1.OutboxListResponse{}
	}
	if msg.friends != nil {
		m.friends = msg.friends.GetFriends()
	}
	if !m.started && msg.err == nil && m.status != nil {
		m.started = true
		m.printStartup()
	}
	m.detectRouteChanges(msg.at)
	if !m.relayStopAt.IsZero() && m.stillDirect == nil {
		elapsed := msg.at.Sub(m.relayStopAt)
		if elapsed >= 10*time.Second {
			ok := m.directAtStop && m.targetDirect()
			m.stillDirect = &ok
			m.stillSeconds = int(elapsed.Seconds())
			if ok {
				m.appendEvent("✓ 停中继后直连仍然保持（已观察 %d 秒）", m.stillSeconds)
			} else {
				m.appendEvent("! 停中继后直连未能保持（已观察 %d 秒）", m.stillSeconds)
			}
		}
	}
}

// printStartup runs once on the first successful refresh and writes the
// session summary plus the last ten stored messages, oldest first.
func (m *Model) printStartup() {
	version := m.opts.Version
	if version == "" {
		version = m.status.GetVersion()
	}
	direct, relay := m.connectionCounts()
	m.appendLog("Raminga %s · 我 %s · 连接 %d", version, displayMyName(m.status, m.friends), direct+relay)
	if daemonVersion := m.status.GetVersion(); daemonVersion != "" && m.opts.Version != "" && daemonVersion != m.opts.Version {
		m.appendLog("! 节点版本 %s 与当前程序 %s 不同；运行 raminga restart 切换到新版本", daemonVersion, m.opts.Version)
	}
	if len(m.messages) == 0 {
		return
	}
	m.appendLog("最近消息：")
	msgs := m.messages
	if len(msgs) > 10 {
		msgs = msgs[:10]
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		stored := msgs[i]
		if id := stored.GetMessageId(); id != "" {
			if m.seenMsgs[id] {
				continue
			}
			m.seenMsgs[id] = true
		}
		at := m.now()
		if ts := stored.GetCreatedAtUnixMs(); ts > 0 {
			at = time.UnixMilli(ts)
		}
		peer := displayName(stored.GetPeerId(), m.friends)
		switch stored.GetDirection() {
		case "in":
			m.appendEventAt(at, "← %s：%s", peer, stored.GetText())
		case "out":
			m.appendEventAt(at, "→ %s：%s", peer, stored.GetText())
		default:
			m.appendEventAt(at, "· %s：%s", peer, stored.GetText())
		}
	}
}

func (m *Model) connectionCounts() (direct, relay int) {
	for _, p := range m.peers {
		if !p.GetOnline() {
			continue
		}
		if p.GetDirect() && p.GetRoute() == "direct" {
			direct++
		} else if p.GetRoute() == "relay" {
			relay++
		}
	}
	return direct, relay
}

func (m *Model) detectRouteChanges(at time.Time) {
	if at.IsZero() {
		at = m.now()
	}
	for _, p := range m.peers {
		if !p.GetOnline() {
			continue
		}
		id := p.GetPeerId()
		prev, ok := m.lastRoutes[id]
		if ok && prev != p.GetRoute() {
			m.changes = append(m.changes, report.Change{
				At: at.UTC().Format(time.RFC3339), PeerID: id, From: prev, To: p.GetRoute(), Transport: p.GetTransport(),
			})
			if prev == "relay" && p.GetRoute() == "direct" {
				m.appendEvent("✓ 已升级为 %s 直连 %s", strings.ToUpper(p.GetTransport()), directAddrFor(p))
			} else if prev == "direct" && p.GetRoute() == "relay" {
				m.appendEvent("! 直连丢失，已回退中继（%s）", displayName(id, m.friends))
			}
		}
		m.lastRoutes[id] = p.GetRoute()
	}
}

func directAddrFor(p *apiv1.PeerEntry) string {
	transport := p.GetTransport()
	for _, addr := range p.GetAddrs() {
		if strings.Contains(addr, "/p2p-circuit") {
			continue
		}
		if transport == "quic" && !strings.Contains(addr, "/quic") {
			continue
		}
		if transport == "tcp" && !strings.Contains(addr, "/tcp/") {
			continue
		}
		return addr
	}
	for _, addr := range p.GetAddrs() {
		if !strings.Contains(addr, "/p2p-circuit") {
			return addr
		}
	}
	return "-"
}

func (m *Model) addLiveRoute(peerID, route string) {
	if peerID == "" || route == "" {
		return
	}
	set := m.liveRoutes[peerID]
	if set == nil {
		set = make(map[string]bool)
		m.liveRoutes[peerID] = set
	}
	set[route] = true
}

// removeLiveRoute removes one path and reports whether others remain.
func (m *Model) removeLiveRoute(peerID, route string) bool {
	set := m.liveRoutes[peerID]
	if set == nil {
		return false
	}
	if route == "" {
		delete(m.liveRoutes, peerID)
		return false
	}
	delete(set, route)
	if len(set) == 0 {
		delete(m.liveRoutes, peerID)
		return false
	}
	return true
}

func (m *Model) targetDirect() bool {
	if m.target == nil {
		return false
	}
	for _, p := range m.peers {
		if p.GetOnline() && p.GetPeerId() == m.target.PeerID {
			return p.GetDirect() && p.GetRoute() == "direct"
		}
	}
	return false
}

func (m *Model) handleEvent(ev *apiv1.EventsResponse) {
	if ev == nil || ev.GetHeartbeat() {
		return
	}
	at := m.now()
	if ev.GetAtUnixMs() > 0 {
		at = time.UnixMilli(ev.GetAtUnixMs())
	}
	ts := at.UTC().Format(time.RFC3339)
	switch body := ev.GetBody().(type) {
	case *apiv1.EventsResponse_ChatReceived:
		c := body.ChatReceived
		if c.GetAccepted() && !c.GetDuplicate() {
			show := true
			if id := c.GetMessageId(); id != "" {
				if m.seenMsgs[id] {
					show = false
				}
				m.seenMsgs[id] = true
			}
			if show {
				m.appendEventAt(at, "← %s：%s", displayName(c.GetFromPeerId(), m.friends), c.GetText())
			}
			m.timeline = append(m.timeline, report.Event{At: ts, Kind: "chat_received", PeerID: c.GetFromPeerId(), Detail: fmt.Sprintf("text_len=%d", len(c.GetText()))})
		}
	case *apiv1.EventsResponse_Ack:
		a := body.Ack
		m.recordACK(report.ACK{At: ts, MessageID: a.GetMessageId(), PeerID: a.GetPeerId(), Acked: a.GetAccepted(), Reason: a.GetError()})
		if a.GetAccepted() && m.isOutboxResend(a.GetMessageId()) {
			m.appendEventAt(at, "✓ 待发消息已自动补发并确认（%s）", shortID(a.GetMessageId()))
		}
	case *apiv1.EventsResponse_Connection:
		c := body.Connection
		name := displayName(c.GetPeerId(), m.friends)
		if c.GetKind() == "connected" {
			m.addLiveRoute(c.GetPeerId(), c.GetRoute())
			line := "连接 " + name
			if route := routeLabel(c.GetRoute(), c.GetTransport()); route != "" {
				line += "：" + route
			}
			if c.GetLimited() {
				line += "（受限）"
			}
			m.appendEventAt(at, "%s", line)
		} else {
			if m.removeLiveRoute(c.GetPeerId(), c.GetRoute()) {
				if c.GetRoute() == "relay" {
					m.appendEventAt(at, "%s 的中继线路已关闭（直连仍在）", name)
				} else {
					m.appendEventAt(at, "%s 的%s线路已关闭（仍有其他连接）", name, routeLabel(c.GetRoute(), ""))
				}
			} else {
				m.appendEventAt(at, "断开 %s", name)
			}
		}
		m.timeline = append(m.timeline, report.Event{
			At: ts, Kind: "connection_" + c.GetKind(), PeerID: c.GetPeerId(), Route: c.GetRoute(),
			Transport: c.GetTransport(), Direct: c.GetDirect(), Limited: c.GetLimited(),
			Direction: c.GetDirection(), Relay: c.GetRelayPeerId(), Address: c.GetRemoteMultiaddr(),
		})
	}
}

// isOutboxResend is deliberately conservative: the ACK must belong to a
// message that has already been retried at least once, and it must not be the
// TUI's own current send (that ACK is logged by handleSendResult).
func (m *Model) isOutboxResend(messageID string) bool {
	if messageID == "" || m.tuiSent[messageID] {
		return false
	}
	if m.outbox == nil {
		return false
	}
	for _, e := range m.outbox.GetEntries() {
		if e.GetMessageId() != messageID {
			continue
		}
		return e.GetAttempts() > 1 || e.GetStatus() == "failed"
	}
	return false
}

func (m *Model) recordACK(a report.ACK) {
	for i := len(m.acks) - 1; i >= 0; i-- {
		if m.acks[i].MessageID == a.MessageID && a.MessageID != "" {
			m.acks[i].Acked = a.Acked
			if a.PeerID != "" {
				m.acks[i].PeerID = a.PeerID
			}
			if a.Reason != "" || !a.Acked {
				m.acks[i].Reason = a.Reason
			}
			return
		}
	}
	m.acks = append(m.acks, a)
}

var candidatePattern = regexp.MustCompile(`(?s)\* \[([^\]]+)\](.{0,240})`)

// formatConnectFailure turns a raw libp2p dial dump into one short Chinese
// summary plus de-duplicated candidate lines with a generic reason. It never
// includes lab-specific advice and never emits literal \n sequences.
func formatConnectFailure(raw string) (string, []string) {
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	lower := strings.ToLower(raw)
	summary := "所有候选地址都失败"
	switch {
	case strings.Contains(lower, "timeout"):
		summary = "所有候选地址都失败（连接超时）"
	case strings.Contains(lower, "no route"):
		summary = "所有候选地址都失败（没有可用线路）"
	case strings.Contains(lower, "connection refused"):
		summary = "所有候选地址都失败（连接被拒绝）"
	}
	seen := make(map[string]bool)
	var details []string
	for _, match := range candidatePattern.FindAllStringSubmatch(raw, -1) {
		addr := strings.TrimSpace(match[1])
		if addr == "" {
			continue
		}
		reason := candidateReason(match[2])
		if reason == "原因未知" {
			if raw := textsafe.Sanitize(strings.TrimSpace(match[2])); raw != "" {
				reason += "：" + raw
			}
		}
		key := addr + "\x00" + reason
		if seen[key] {
			continue
		}
		seen[key] = true
		details = append(details, addr+"（"+reason+"）")
		if len(details) >= 4 {
			break
		}
	}
	return summary, details
}

func candidateReason(segment string) string {
	low := strings.ToLower(segment)
	switch {
	case strings.Contains(low, "backoff"):
		return "暂停重拨（dial backoff）"
	case strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded"):
		return "超时"
	case strings.Contains(low, "connection refused"):
		return "连接被拒绝"
	case strings.Contains(low, "noise") || strings.Contains(low, "security protocol") || strings.Contains(low, "handshake"):
		return "加密握手失败"
	case strings.Contains(low, "relay") || strings.Contains(low, "circuit") || strings.Contains(low, "reservation"):
		return "无法连接中继"
	case strings.Contains(low, "no route") || strings.Contains(low, "unreachable"):
		return "无可用线路"
	case strings.Contains(low, "failed to dial") || strings.Contains(low, "all dials failed"):
		return "无法连接"
	default:
		return "原因未知"
	}
}

func (m *Model) handleConnectResult(msg connectResultMsg) {
	if msg.notice != "" {
		m.appendEvent("✗ %s", msg.notice)
		return
	}
	if msg.err != nil {
		summary, details := formatConnectFailure(errText(msg.err))
		m.appendEvent("✗ 连接失败：%s", summary)
		for _, detail := range details {
			m.appendEvent("  · %s", detail)
		}
		m.timeline = append(m.timeline, report.Event{At: m.now().UTC().Format(time.RFC3339), Kind: "connect_failed", PeerID: msg.peerID, Detail: summary})
		return
	}
	res := msg.res
	name := msg.name
	if name == "" {
		name = displayName(msg.peerID, m.friends)
	}
	m.timeline = append(m.timeline, report.Event{
		At: m.now().UTC().Format(time.RFC3339), Kind: "connect", PeerID: res.GetPeerId(),
		Route: res.GetRoute(), Transport: res.GetTransport(), Direct: res.GetDirect(),
		Limited: res.GetLimited(), Relay: res.GetRelayPeerId(), Address: res.GetRemoteMultiaddr(),
		Detail: "source=" + res.GetSource(),
	})
	m.lastRoutes[res.GetPeerId()] = res.GetRoute()
	m.addLiveRoute(res.GetPeerId(), res.GetRoute())
	route := routeLabel(res.GetRoute(), res.GetTransport())
	switch {
	case res.GetRoute() == "relay":
		relay := displayName(res.GetRelayPeerId(), m.friends)
		line := fmt.Sprintf("✓ 已连接 %s：%s（经中继 %s", name, route, relay)
		if res.GetLimited() {
			line += "，受限"
		}
		line += "）"
		m.appendEvent("%s", line)
		m.appendEvent("… 等待打洞（DCUtR）升级为直连")
	case res.GetDirect():
		line := fmt.Sprintf("✓ 已连接 %s：%s", name, route)
		if addr := res.GetRemoteMultiaddr(); addr != "" {
			line += " " + addr
		}
		m.appendEvent("%s", line)
	default:
		m.appendEvent("✓ 已连接 %s：%s", name, route)
	}
	for _, a := range res.GetAttempts() {
		if a.GetOk() {
			continue
		}
		reason := candidateReason(a.GetError())
		if reason == "原因未知" {
			if raw := textsafe.Sanitize(strings.TrimSpace(a.GetError())); raw != "" {
				reason += "（" + raw + "）"
			}
		}
		m.appendEvent("  · 候选失败 %s：%s", a.GetMultiaddr(), reason)
	}
}

func (m *Model) handleSendResult(msg sendResultMsg) {
	if msg.err != nil {
		m.appendEvent("→ %s：%s ✗（%s）", msg.name, msg.text, errText(msg.err))
		m.recordACK(report.ACK{At: m.now().UTC().Format(time.RFC3339), PeerID: msg.peerID, Acked: false, Reason: errText(msg.err), Text: msg.text})
		return
	}
	res := msg.res
	name := msg.name
	if name == "" {
		name = displayName(msg.peerID, m.friends)
	}
	m.recordACK(report.ACK{
		At: m.now().UTC().Format(time.RFC3339), MessageID: res.GetMessageId(), PeerID: msg.peerID,
		Acked: res.GetAcked(), Reason: res.GetError(), Route: res.GetRoute(),
		Transport: res.GetTransport(), OutboxStatus: res.GetOutboxStatus(), Text: msg.text,
	})
	switch {
	case res.GetAcked():
		line := fmt.Sprintf("→ %s：%s ✓ %d ms", name, msg.text, msg.elapsed.Milliseconds())
		if res.GetRoute() == "relay" {
			line += " 经中继"
		}
		m.appendEvent("%s", line)
	case res.GetOutboxStatus() == "pending":
		line := fmt.Sprintf("→ %s：%s 待发", name, msg.text)
		if reason := errText(errors.New(res.GetError())); reason != "" {
			line += "（" + reason + "）"
		}
		m.appendEvent("%s", line)
	default:
		reason := res.GetError()
		if reason == "" {
			reason = "未送达"
		}
		m.appendEvent("→ %s：%s ✗（%s）", name, msg.text, reason)
	}
}

func displayName(peerID string, names []*apiv1.Friend) string {
	for _, n := range names {
		if n.GetPeerId() == peerID && n.GetName() != "" {
			return n.GetName()
		}
	}
	return shortID(peerID)
}

func shortID(id string) string {
	if id == "" || strings.HasSuffix(id, "…") {
		return id
	}
	if len(id) > 14 {
		return id[:14] + "…"
	}
	return id
}

func (m *Model) resolve(arg string) (name, peerID string, addrs []string, err error) {
	raw := strings.TrimSpace(arg)
	if raw == "" {
		return "", "", nil, errors.New("地址为空；" + peerarg.WrappedHint)
	}
	for _, n := range m.friends {
		if n.GetName() == raw {
			return n.GetName(), n.GetPeerId(), n.GetAddrs(), nil
		}
	}
	arg = peerarg.Normalize(raw)
	if strings.Contains(arg, "/") {
		if _, err := ma.NewMultiaddr(arg); err != nil {
			return "", "", nil, fmt.Errorf("无效 multiaddr：%w；%s", err, peerarg.WrappedHint)
		}
		idx := strings.LastIndex(arg, "/p2p/")
		if idx < 0 {
			return "", "", nil, errors.New("multiaddr 缺少 /p2p/<peer-id>；" + peerarg.WrappedHint)
		}
		value := arg[idx+len("/p2p/"):]
		if slash := strings.Index(value, "/"); slash >= 0 {
			value = value[:slash]
		}
		pid, err := peer.Decode(value)
		if err != nil {
			return "", "", nil, fmt.Errorf("multiaddr 里的 Peer ID 无效：%w；%s", err, peerarg.WrappedHint)
		}
		return "", pid.String(), []string{arg}, nil
	}
	pid, err := peer.Decode(arg)
	if err != nil {
		return "", "", nil, fmt.Errorf("未知节点：%s；用 /peers 查看已知节点，或检查 Peer ID 是否完整", arg)
	}
	return "", pid.String(), nil, nil
}

var _ tea.Model = (*Model)(nil)
