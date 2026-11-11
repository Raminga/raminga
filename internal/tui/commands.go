package tui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/report"
	"github.com/Raminga/raminga/internal/textsafe"
)

type argKind uint8

const (
	argText argKind = iota
	argPeer
	argOutbox
)

type commandDef struct {
	Name  string
	Desc  string
	Group string
	Args  bool
	// ArgKinds declares each positional argument so completion is driven by
	// this table rather than a separate command switch.
	ArgKinds []argKind
}

// helpGroups is the display order of /help sections.
var helpGroups = []string{"连接", "聊天", "内容", "诊断", "其他"}

var commands = []commandDef{
	{"/connect", "连接节点（名字 / Peer ID / multiaddr）", "连接", true, []argKind{argPeer}},
	{"/disconnect", "断开连接（可能自动重连）", "连接", true, []argKind{argPeer}},
	{"/status", "本机与连接概况", "连接", false, nil},
	{"/peers", "已知节点；/peers <节点> 看地址", "连接", false, []argKind{argPeer}},
	{"/chat", "选择聊天对象", "聊天", true, []argKind{argPeer}},
	{"/name", "给节点起名", "聊天", true, []argKind{argPeer, argText}},
	{"/describe", "设置节点描述", "聊天", true, []argKind{argPeer, argText}},
	{"/forget", "从好友表删除", "聊天", true, []argKind{argPeer}},
	{"/view", "查看远端档案", "内容", true, []argKind{argPeer}},
	{"/posts", "列出远端动态", "内容", true, []argKind{argPeer}},
	{"/peerfriends", "查看远端好友列表", "内容", true, []argKind{argPeer}},
	{"/files", "列出远端文件", "内容", true, []argKind{argPeer}},
	{"/get", "下载远端文件", "内容", true, []argKind{argPeer, argText}},
	{"/published", "本机已发布文件", "内容", false, nil},
	{"/diag", "网络诊断", "诊断", false, nil},
	{"/outbox", "待发与失败消息", "诊断", false, nil},
	{"/cancel", "取消一条待发消息", "诊断", true, []argKind{argOutbox}},
	{"/mark", "记录测试节点", "诊断", true, []argKind{argText}},
	{"/report", "导出诊断报告", "诊断", false, nil},
	{"/copy", "复制地址或对方 Peer ID", "其他", false, []argKind{argPeer}},
	{"/clear", "清空当前屏幕", "其他", false, nil},
	{"/help", "显示全部指令", "其他", false, nil},
	{"/quit", "退出 TUI", "其他", false, nil},
}

func resolveCommand(token string) (commandDef, bool, error) {
	token = strings.TrimPrefix(token, "/")
	if token == "" {
		return commandDef{}, false, nil
	}
	var matches []commandDef
	for _, c := range commands {
		name := strings.TrimPrefix(c.Name, "/")
		if name == token {
			return c, true, nil
		}
		if strings.HasPrefix(name, token) {
			matches = append(matches, c)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], true, nil
	case 0:
		return commandDef{}, false, fmt.Errorf("未知指令 /%s；输入 /help 查看", token)
	default:
		names := make([]string, 0, len(matches))
		for _, c := range matches {
			names = append(names, c.Name)
		}
		return commandDef{}, false, fmt.Errorf("指令 /%s 有歧义：%s", token, strings.Join(names, " "))
	}
}

func (m *Model) execCommand(line string) (tea.Cmd, bool) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return nil, false
	}
	cmd, ok, err := resolveCommand(fields[0])
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil, false
	}
	if !ok {
		m.appendLog("! 空指令；输入 /help 查看")
		return nil, false
	}
	args := fields[1:]
	rest := strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
	switch cmd.Name {
	case "/help":
		m.cmdHelp()
		return nil, false
	case "/status":
		return m.cmdStatus(), false
	case "/peers":
		if len(args) > 0 {
			m.cmdPeerDetail(strings.Join(args, " "))
			return nil, false
		}
		m.cmdPeers()
		return nil, false
	case "/diag":
		m.cmdDiag()
		return nil, false
	case "/outbox":
		m.cmdOutbox()
		return nil, false
	case "/view":
		if len(args) == 0 {
			m.appendLog("! 用法：/view <节点>")
			return nil, false
		}
		return m.cmdView(args[0]), false
	case "/posts":
		if len(args) == 0 {
			m.appendLog("! 用法：/posts <节点>")
			return nil, false
		}
		return m.cmdPosts(args[0]), false
	case "/peerfriends":
		if len(args) == 0 {
			m.appendLog("! 用法：/peerfriends <节点>")
			return nil, false
		}
		return m.cmdPeerFriends(args[0]), false
	case "/files":
		if len(args) == 0 {
			m.appendLog("! 用法：/files <节点>")
			return nil, false
		}
		return m.cmdFiles(args[0]), false
	case "/get":
		if len(args) < 2 {
			m.appendLog("! 用法：/get <节点> <清单路径，例如 posts/hello.md>")
			m.appendLog("  第二个参数是对方发布清单里的路径，不是本地保存位置；先 /files <节点> 查看清单。")
			return nil, false
		}
		return m.cmdGet(args[0], strings.Join(args[1:], " ")), false
	case "/published":
		sync := strings.TrimSpace(rest) == "sync"
		if strings.TrimSpace(rest) != "" && !sync {
			m.appendLog("! 用法：/published [sync]")
			return nil, false
		}
		return m.cmdPublished(sync), false
	case "/clear":
		return m.clearScreen(), false
	case "/quit":
		return nil, true
	case "/copy":
		if len(args) > 0 {
			return m.cmdCopyPeer(strings.Join(args, " ")), false
		}
		return m.cmdCopy(), false
	case "/mark":
		m.cmdMark(rest)
		return nil, false
	case "/report":
		include := m.opts.IncludeText
		if strings.Contains(rest, "--include-text") {
			include = true
		}
		if strings.Contains(rest, "--no-include-text") {
			include = false
		}
		return m.exportCmd(include), false
	case "/connect":
		if len(args) == 0 {
			m.appendLog("! 用法：/connect <节点|multiaddr>，或 /connect <列表所有者> <列表中的节点>")
			return nil, false
		}
		// Two fields mean owner + listed peer only if the first really names a
		// node; otherwise they're a wrapped address or Peer ID split by a space.
		if len(args) == 2 && !strings.HasPrefix(args[0], "/") {
			if _, ownerID, _, err := m.resolve(args[0]); err == nil {
				return m.cmdConnectListed(ownerID, args[1]), false
			}
		}
		return m.cmdConnect(strings.Join(args, " ")), false
	case "/disconnect":
		if len(args) == 0 {
			m.appendLog("! 用法：/disconnect <节点>")
			return nil, false
		}
		return m.cmdDisconnect(strings.Join(args, " ")), false
	case "/chat":
		if len(args) == 0 {
			m.appendLog("! 用法：/chat <节点>")
			return nil, false
		}
		m.cmdChat(strings.Join(args, " "))
		return nil, false
	case "/name":
		if len(args) < 2 {
			m.appendLog("! 用法：/name <节点> <名字>")
			return nil, false
		}
		return m.cmdName(args[0], strings.Join(args[1:], " ")), false
	case "/describe":
		if len(args) < 2 {
			m.appendLog("! 用法：/describe <节点> <描述>")
			return nil, false
		}
		return m.cmdDescribe(args[0], strings.Join(args[1:], " ")), false
	case "/forget":
		if len(args) == 0 {
			m.appendLog("! 用法：/forget <节点> [--cancel-pending]")
			return nil, false
		}
		return m.cmdForget(args), false
	case "/cancel":
		if len(args) == 0 {
			m.appendLog("! 用法：/cancel <消息 id>")
			return nil, false
		}
		return m.cmdCancel(args[0]), false
	default:
		m.appendLog("! 未实现指令 %s", cmd.Name)
		return nil, false
	}
}

func (m *Model) cmdStatus() tea.Cmd {
	if m.status == nil {
		m.appendLog("… 正在读取本地节点状态")
		return m.refreshCmd()
	}
	direct, relay := m.connectionCounts()
	own := m.status.GetPeerId()
	for _, n := range m.friends {
		if n.GetPeerId() == own {
			own = n.GetName() + "（" + own + "）"
			break
		}
	}
	m.appendLog("本机：%s", own)
	if m.status.GetNodeId() != "" {
		m.appendLog("Node ID：%s", m.status.GetNodeId())
	}
	m.appendLog("版本：%s · 协议 %s", m.status.GetVersion(), m.status.GetProtocolVersion())
	m.appendLog("连接：直连 %d · 中继 %d · 已知 %d", direct, relay, len(m.peers))
	if m.target != nil {
		m.appendLog("聊天对象：%s（%s）", m.target.Name, shortID(m.target.PeerID))
	} else {
		m.appendLog("聊天对象：未选择（/chat <名字>）")
	}
	chosen, _ := m.pickShareableAddr()
	for _, choice := range m.addressChoices() {
		label := "公告地址：" + choice.label
		if choice.raw == chosen {
			label += "（/copy 默认）"
		}
		m.appendLog("%s", label)
		m.appendLog("%s", choice.value)
	}
	return nil
}

func (m *Model) publicReachability() bool {
	n := m.status.GetNetwork()
	return n != nil && strings.EqualFold(n.GetReachability(), "public")
}

// classifyAddr labels an advertised address and returns its /copy priority.
// Loopback, link-local and unspecified addresses get an unusable priority.
func classifyAddr(raw string, publicReachability bool) (string, int) {
	m, err := ma.NewMultiaddr(raw)
	if err != nil {
		return "其他", 100
	}
	relay := strings.Contains(raw, "/p2p-circuit")
	switch {
	case manet.IsIPLoopback(m), manet.IsIP6LinkLocal(m), manet.IsIPUnspecified(m):
		if manet.IsIPLoopback(m) {
			return "本机回环", 100
		}
		return "链路本地/未指定", 100
	case relay:
		if publicReachability {
			return "中继", 1
		}
		return "中继", 0
	case manet.IsPublicAddr(m):
		if publicReachability {
			return "公网", 0
		}
		return "公网", 1
	case manet.IsPrivateAddr(m):
		return "局域网", 2
	default:
		return "其他", 3
	}
}

type addressChoice struct {
	raw    string
	value  string
	label  string
	rank   int
	usable bool
}

// addressChoices returns the advertised addresses in the same priority order
// used by /copy. Loopback, link-local and unspecified addresses are only
// returned when nothing better exists.
func (m *Model) addressChoices() []addressChoice {
	if m.status == nil {
		return nil
	}
	pid := m.status.GetPeerId()
	var usable, fallback []addressChoice
	for _, raw := range m.status.GetAdvertisedAddrs() {
		label, rank := classifyAddr(raw, m.publicReachability())
		choice := addressChoice{raw: raw, value: shareableAddr(raw, pid), label: label, rank: rank}
		if rank >= 100 {
			fallback = append(fallback, choice)
			continue
		}
		if !strings.Contains(raw, "/ip4/") {
			choice.rank = rank*2 + 1
		} else {
			choice.rank = rank * 2
		}
		choice.usable = true
		usable = append(usable, choice)
	}
	choices := usable
	if len(choices) == 0 {
		choices = fallback
	}
	sort.SliceStable(choices, func(i, j int) bool { return choices[i].rank < choices[j].rank })
	return choices
}

func (m *Model) pickShareableAddr() (raw, value string) {
	for _, choice := range m.addressChoices() {
		if choice.usable {
			return choice.raw, choice.value
		}
	}
	return "", ""
}

func displayMyName(st *apiv1.StatusResponse, names []*apiv1.Friend) string {
	for _, n := range names {
		if n.GetPeerId() == st.GetPeerId() && n.GetName() != "" {
			return n.GetName()
		}
	}
	return shortID(st.GetPeerId())
}

func (m *Model) cmdHelp() {
	m.appendLog("可用指令（支持唯一前缀）：")
	nameWidth := 0
	for _, c := range commands {
		if len(c.Name) > nameWidth {
			nameWidth = len(c.Name)
		}
	}
	for _, group := range helpGroups {
		m.appendLog("%s", group)
		for _, c := range commands {
			if c.Group != group {
				continue
			}
			m.appendLog("  %s  %s", padDisplay(c.Name, nameWidth), c.Desc)
		}
	}
}

// peerRow merges one friend row and/or one live PeerStore entry by Peer ID.
type peerRow struct {
	PeerID string
	Name   string
	Friend *apiv1.Friend
	Peer   *apiv1.PeerEntry
	Online bool
}

func (m *Model) peerRows() []peerRow {
	rows := make(map[string]*peerRow, len(m.friends)+len(m.peers))
	get := func(peerID string) *peerRow {
		row := rows[peerID]
		if row == nil {
			row = &peerRow{PeerID: peerID, Name: "-"}
			rows[peerID] = row
		}
		return row
	}
	for _, f := range m.friends {
		if f.GetPeerId() == "" {
			continue
		}
		row := get(f.GetPeerId())
		if row.Friend == nil {
			row.Friend = f
		}
		if f.GetName() != "" {
			row.Name = f.GetName()
		}
	}
	for _, p := range m.peers {
		if p.GetPeerId() == "" {
			continue
		}
		row := get(p.GetPeerId())
		if p.GetOnline() {
			row.Online = true
			row.Peer = p
		} else if row.Peer == nil {
			row.Peer = p
		}
	}
	out := make([]peerRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, *row)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Friend != nil) != (b.Friend != nil) {
			return a.Friend != nil
		}
		if a.Online != b.Online {
			return a.Online
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an != bn {
			return an < bn
		}
		return a.PeerID < b.PeerID
	})
	return out
}

func routeLabel(route, transport string) string {
	switch route {
	case "direct":
		route = "直连"
	case "relay":
		route = "中继"
	}
	if route == "" {
		return ""
	}
	if transport != "" {
		return route + "/" + strings.ToUpper(transport)
	}
	return route
}

// addrs merges what the friend table saved with what the PeerStore knows.
func (row peerRow) addrs() []string {
	var lists [][]string
	if row.Friend != nil {
		lists = append(lists, row.Friend.GetAddrs())
	}
	if row.Peer != nil {
		lists = append(lists, row.Peer.GetAddrs())
	}
	seen := make(map[string]bool)
	var out []string
	for _, list := range lists {
		for _, addr := range list {
			addr = shareableAddr(addr, row.PeerID)
			if !seen[addr] {
				seen[addr] = true
				out = append(out, addr)
			}
		}
	}
	return out
}

// cmdPeerDetail shows one node. Addresses are complete enough to paste into
// /connect, and the live connections are listed apart from remembered addresses.
func (m *Model) cmdPeerDetail(arg string) {
	_, pid, _, err := m.resolve(arg)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return
	}
	var found *peerRow
	rows := m.peerRows()
	for i := range rows {
		if rows[i].PeerID == pid {
			found = &rows[i]
			break
		}
	}
	if found == nil {
		m.appendLog("! 没有这个节点的记录：%s；用 /peers 查看已知节点", pid)
		return
	}
	status := "离线"
	if found.Online {
		status = "在线"
	}
	line := found.Name + "  " + status
	if details := m.peerDetails(*found); details != "" {
		line += " " + details
	}
	m.appendLog("%s", line)
	m.appendLog("Peer ID：%s", pid)
	if m.status != nil {
		var conns []string
		for _, c := range m.status.GetConnections() {
			if c.GetPeerId() != pid {
				continue
			}
			label := routeLabel(c.GetRoute(), c.GetTransport())
			if label == "" {
				label = "连接"
			}
			conns = append(conns, "  "+label+"  "+c.GetRemoteMultiaddr())
		}
		if len(conns) > 0 {
			m.appendLog("当前连接（%d 条）：", len(conns))
			for _, conn := range conns {
				m.appendLog("%s", conn)
			}
		}
	}
	addrs := found.addrs()
	if len(addrs) == 0 {
		m.appendLog("已知地址：（没有）")
		return
	}
	m.appendLog("已知地址（%d 条，可能已过期）：", len(addrs))
	for _, line := range labelledAddrLines(addrs) {
		m.appendLog("%s", line)
	}
}

func (m *Model) peerDetails(row peerRow) string {
	var parts []string
	if row.Online {
		if p := row.Peer; p != nil {
			if route := routeLabel(p.GetRoute(), p.GetTransport()); route != "" {
				parts = append(parts, route)
			}
		}
	}
	if f := row.Friend; f != nil {
		if f.GetManuallyConnected() {
			parts = append(parts, "手动")
		}
	}
	if n := len(row.addrs()); n > 0 {
		parts = append(parts, fmt.Sprintf("地址=%d", n))
	}
	if p := row.Peer; p != nil {
		if p.GetRelayPeerId() != "" {
			parts = append(parts, "中继 via "+displayName(p.GetRelayPeerId(), m.friends))
		}
		if p.GetLimited() {
			parts = append(parts, "受限")
		}
		if p.GetPaused() {
			parts = append(parts, "暂停")
		}
		switch p.GetDirection() {
		case "":
		case "inbound":
			parts = append(parts, "入站")
		case "outbound":
			parts = append(parts, "出站")
		default:
			parts = append(parts, p.GetDirection())
		}
	}
	if f := row.Friend; f != nil {
		if f.GetPaused() && (row.Peer == nil || !row.Peer.GetPaused()) {
			parts = append(parts, "暂停")
		}
		if f.GetDescription() != "" {
			parts = append(parts, "描述="+f.GetDescription())
		}
	}
	return strings.Join(parts, " ")
}

func (m *Model) cmdPeers() {
	rows := m.peerRows()
	if len(rows) == 0 {
		m.appendLog("（没有已知节点）")
		return
	}
	nameWidth, statusWidth, detailWidth := 0, 0, 0
	names := make([]string, len(rows))
	statuses := make([]string, len(rows))
	details := make([]string, len(rows))
	for i, row := range rows {
		names[i] = row.Name
		if row.Online {
			statuses[i] = "在线"
		} else {
			statuses[i] = "离线"
		}
		details[i] = m.peerDetails(row)
		if w := displayWidth(names[i]); w > nameWidth {
			nameWidth = w
		}
		if w := displayWidth(statuses[i]); w > statusWidth {
			statusWidth = w
		}
		if w := displayWidth(details[i]); w > detailWidth {
			detailWidth = w
		}
	}
	for i := range rows {
		line := padDisplay(names[i], nameWidth) + "  " + padDisplay(statuses[i], statusWidth)
		if detailWidth > 0 {
			line += " " + padDisplay(details[i], detailWidth)
		}
		line += "  " + rows[i].PeerID
		m.appendLog("%s", line)
	}
}

func (m *Model) cmdDiag() {
	if m.status == nil || m.status.GetNetwork() == nil {
		m.appendLog("… 诊断尚未就绪")
		return
	}
	n := m.status.GetNetwork()
	m.appendLog("AutoNAT：enabled=%t state=%s 探测节点=%d", n.GetAutonat().GetEnabled(), n.GetAutonat().GetState(), len(n.GetAutonat().GetProbePeers()))
	m.appendLog("打洞 DCUtR：尝试 %d · 成功 %d · 失败 %d", n.GetDcutr().GetAttempts(), n.GetDcutr().GetSuccesses(), n.GetDcutr().GetFailures())
	m.appendLog("DHT：enabled=%t mode=%s 路由节点=%d 错误=%s", n.GetDht().GetEnabled(), n.GetDht().GetMode(), len(n.GetDht().GetRoutingTablePeers()), textsafe.Sanitize(n.GetDht().GetLastError()))
	for _, warning := range m.status.GetContentWarnings() {
		m.appendLog("内容扫描警告：%s", textsafe.Sanitize(warning))
	}
	if n.GetDht().GetLastPublishUnixMs() > 0 {
		m.appendLog("DHT 地址发布：%s", time.UnixMilli(n.GetDht().GetLastPublishUnixMs()).UTC().Format(time.RFC3339))
	}
	if n.GetDht().GetLastPublishError() != "" {
		m.appendLog("DHT 地址发布错误：%s", textsafe.Sanitize(n.GetDht().GetLastPublishError()))
	}
	m.appendLog("资源：连接 %d/%d · 流 %d/%d · goroutines=%d", n.GetResources().GetOpenConnections(), n.GetResources().GetMaxConnections(), n.GetResources().GetOpenStreams(), n.GetResources().GetMaxStreams(), n.GetResources().GetGoroutines())
	for _, r := range n.GetRelays() {
		m.appendLog("中继 %s：%s / 预约 %s / 错误=%s", displayName(r.GetRelayPeerId(), m.friends), r.GetStatus(), r.GetReservationStatus(), textsafe.Sanitize(r.GetLastError()))
	}
	for _, line := range explainZH(n, m.peers) {
		m.appendLog("  · %s", line)
	}
}

func outboxStatus(status string) string {
	switch status {
	case "pending":
		return "待发"
	case "failed":
		return "失败"
	case "cancelled":
		return "已取消"
	case "acked":
		return "已送达"
	default:
		return status
	}
}

func (m *Model) cmdOutbox() {
	if m.outbox == nil || len(m.outbox.GetEntries()) == 0 {
		m.appendLog("（没有待发或失败消息）")
		return
	}
	s := m.outbox.GetStats()
	m.appendLog("待发 %d · 失败 %d · 已取消 %d · 待发大小 %s",
		s.GetPending(), s.GetFailed(), s.GetCancelled(), humanBytes(s.GetPendingBytes()))
	for _, e := range m.outbox.GetEntries() {
		line := fmt.Sprintf("消息 %s 发给 %s：%s，尝试 %d 次", e.GetMessageId(), displayName(e.GetPeerId(), m.friends), outboxStatus(e.GetStatus()), e.GetAttempts())
		if e.GetLastError() != "" {
			line += "，错误：" + e.GetLastError()
		}
		m.appendLog("%s", line)
	}
}

func (m *Model) cmdMark(note string) {
	note = strings.TrimSpace(note)
	if note == "" {
		m.appendLog("! 用法：/mark <备注>")
		return
	}
	m.timeline = append(m.timeline, report.Event{At: m.now().UTC().Format(time.RFC3339), Kind: "mark", Detail: note})
	m.appendLog("✓ 已记录测试节点：%s", note)
	lower := strings.ToLower(note)
	if strings.Contains(note, "停中继") || strings.Contains(note, "中继已停") || strings.Contains(lower, "relay stop") || strings.Contains(lower, "relay stopped") {
		if m.target == nil {
			m.appendLog("! 还没有聊天对象，无法判断停中继后是否仍直连")
			return
		}
		m.relayStopAt = m.now()
		m.directAtStop = m.targetDirect()
		m.stillDirect = nil
		m.stillSeconds = 0
		m.appendLog("… 开始观察 10 秒：停中继后到 %s 是否仍直连", m.target.Name)
	}
}

func (m *Model) cmdCopy() tea.Cmd {
	if m.status == nil {
		m.appendLog("! 状态尚未就绪")
		return nil
	}
	value := m.status.GetPeerId()
	if _, picked := m.pickShareableAddr(); picked != "" {
		value = picked
	}
	m.appendLog("已发送到剪贴板（终端需支持 OSC52）：%s", value)
	return clipboardCmd(value, m.opts.Clipboard)
}

func (m *Model) cmdCopyPeer(arg string) tea.Cmd {
	_, pid, _, err := m.resolve(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.appendLog("已发送到剪贴板（终端需支持 OSC52）：%s", pid)
	return clipboardCmd(pid, m.opts.Clipboard)
}

// shareableAddr appends the peer ID to a listen/advertised address so it can be
// dialed with /connect. Relay circuit addresses already contain the relay's
// /p2p component, so only an existing trailing /p2p/<peerID> counts as complete.
func shareableAddr(addr, peerID string) string {
	if strings.HasSuffix(addr, "/p2p/"+peerID) {
		return addr
	}
	return strings.TrimRight(addr, "/") + "/p2p/" + peerID
}

func (m *Model) cmdDisconnect(arg string) tea.Cmd {
	name, pid, _, err := m.resolve(arg)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil
	}
	if name == "" {
		name = displayName(pid, m.friends)
	}
	client := m.client
	m.appendLog("… 正在断开 %s（%s）", name, shortID(pid))
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		res, err := client.DisconnectPeer(ctx, pid)
		return disconnectResultMsg{name: name, peerID: pid, res: res, err: err}
	}
}

func (m *Model) disconnectNotices(peerID string) []string {
	var out []string
	if n := m.status.GetNetwork(); n != nil {
		for _, r := range n.GetRelays() {
			if r.GetRelayPeerId() == peerID {
				out = append(out, "该节点是已配置/正在使用的中继，可能会为 Relay/DHT 自动重连。")
				break
			}
		}
		if d := n.GetDht(); d != nil {
			for _, raw := range d.GetBootstrapPeers() {
				if raw == peerID || strings.Contains(raw, "/p2p/"+peerID) {
					out = append(out, "该节点是 Bootstrap 节点，DHT 可能会自动重连。")
					break
				}
			}
		}
	}
	pending := 0
	if m.outbox != nil {
		for _, e := range m.outbox.GetEntries() {
			if e.GetPeerId() == peerID && (e.GetStatus() == "pending" || e.GetStatus() == "failed") {
				pending++
			}
		}
	}
	if pending > 0 {
		out = append(out, fmt.Sprintf("该节点还有 %d 条待发消息；自动重试可能重新拨号。", pending))
	}
	return out
}

func (m *Model) cmdChat(arg string) {
	name, pid, _, err := m.resolve(arg)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return
	}
	if name == "" {
		name = displayName(pid, m.friends)
	}
	m.target = &chatTarget{Name: name, PeerID: pid}
	m.syncPrompt()
	m.appendLog("✓ 当前聊天对象：%s（%s）", name, shortID(pid))
	m.appendLog("… 直接输入文字回车即可发送，空输入时按 Esc 退出聊天")
}

// exitChat clears the chat target. A pending /mark relay-stop observation is
// tied to that target, so it is cancelled rather than reported as lost.
func (m *Model) exitChat() {
	name := m.target.Name
	m.target = nil
	m.syncPrompt()
	m.appendLog("✓ 已退出与 %s 的聊天", name)
	if !m.relayStopAt.IsZero() && m.stillDirect == nil {
		m.relayStopAt = time.Time{}
		m.appendLog("… 已取消停中继观察")
	}
}

func (m *Model) cmdName(target, name string) tea.Cmd {
	_, pid, _, err := m.resolve(target)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil
	}
	client := m.client
	m.appendLog("… 保存名字 %s：%s", shortID(pid), name)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		res, err := client.SetFriendName(ctx, pid, name)
		return friendResultMsg{op: "name", friend: res.GetFriend(), err: err}
	}
}

func (m *Model) cmdDescribe(target, description string) tea.Cmd {
	_, pid, _, err := m.resolve(target)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil
	}
	client := m.client
	m.appendLog("… 保存描述 %s", shortID(pid))
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		res, err := client.SetFriendDescription(ctx, pid, description)
		return friendResultMsg{op: "describe", friend: res.GetFriend(), err: err}
	}
}

func (m *Model) cmdForget(args []string) tea.Cmd {
	cancelPending := false
	if len(args) > 1 && args[len(args)-1] == "--cancel-pending" {
		cancelPending = true
		args = args[:len(args)-1]
	}
	if len(args) != 1 {
		m.appendLog("! 用法：/forget <节点> [--cancel-pending]")
		return nil
	}
	_, pid, _, err := m.resolve(args[0])
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil
	}
	client := m.client
	m.appendLog("… 从好友表删除 %s", shortID(pid))
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		res, err := client.RemoveFriend(ctx, pid, cancelPending)
		return friendResultMsg{op: "forget", removed: res.GetRemoved(), pending: int(res.GetPendingOutbox()), err: err}
	}
}

func (m *Model) cmdConnect(arg string) tea.Cmd {
	if m.busy {
		m.appendLog("… 上一个操作尚未结束，内容已保留")
		return nil
	}
	name, pid, addrs, err := m.resolve(arg)
	if err != nil {
		m.appendLog("! %s", err.Error())
		return nil
	}
	if name == "" {
		name = displayName(pid, m.friends)
	}
	m.busy = true
	client := m.client
	spinCmd := m.startActivity(progressLabel("正在连接 " + name))
	if len(addrs) > 0 {
		m.appendLog("  使用已保存地址 %d 条", len(addrs))
	}
	work := func() tea.Msg {
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
		defer cancel()
		for _, addr := range addrs {
			_, _ = client.DhtAddPeer(ctx, addr)
		}
		var res *apiv1.ConnectResponse
		var err error
		if name == "" && len(addrs) == 1 {
			res, err = client.Connect(ctx, "", addrs[0])
		} else {
			res, err = client.Connect(ctx, pid, "")
		}
		return connectResultMsg{res: res, name: name, peerID: pid, err: err, elapsed: time.Since(start)}
	}
	return tea.Batch(spinCmd, work)
}

func (m *Model) sendPlain(text string) tea.Cmd {
	if m.target == nil {
		m.appendLog("! 还没有聊天对象。先输入 /chat <节点> 选择。")
		return nil
	}
	if m.busy {
		m.appendLog("… 上一个操作尚未结束，内容已保留")
		return nil
	}
	m.busy = true
	target := *m.target
	client := m.client
	spinCmd := m.startActivity("发送中…")
	work := func() tea.Msg {
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		res, err := client.SendChat(ctx, target.PeerID, "", text)
		return sendResultMsg{res: res, text: text, name: target.Name, peerID: target.PeerID, err: err, elapsed: time.Since(start)}
	}
	return tea.Batch(spinCmd, work)
}

func (m *Model) cmdCancel(id string) tea.Cmd {
	if m.outbox == nil {
		m.appendLog("! 待发消息列表尚未就绪")
		return nil
	}
	found := ""
	for _, e := range m.outbox.GetEntries() {
		if e.GetMessageId() == id {
			found = e.GetMessageId()
			break
		}
		if strings.HasPrefix(e.GetMessageId(), id) {
			if found != "" {
				m.appendLog("! 消息 id 前缀不唯一：%s", id)
				return nil
			}
			found = e.GetMessageId()
		}
	}
	if found == "" {
		m.appendLog("! 找不到消息 id：%s", id)
		return nil
	}
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		res, err := client.OutboxCancel(ctx, found)
		return cancelResultMsg{res: res, err: err}
	}
}

func explainZH(n *apiv1.NetworkStatus, peers []*apiv1.PeerEntry) []string {
	out := make([]string, 0, 6)
	an := n.GetAutonat()
	if an.GetEnabled() && (an.GetState() == "unknown" || !an.GetHasProbePeer()) {
		out = append(out, "AutoNAT：没有 Raminga 探测节点，可达性未知（不是“不可达”）。")
	}
	direct, relay := 0, 0
	hasTCPRelay := false
	for _, p := range peers {
		if !p.GetOnline() {
			continue
		}
		if p.GetDirect() && p.GetRoute() == "direct" {
			direct++
		}
		if p.GetRoute() == "relay" {
			relay++
			if p.GetTransport() == "tcp" {
				hasTCPRelay = true
			}
		}
	}
	if direct > 0 {
		out = append(out, fmt.Sprintf("已有 %d 条直连；请用 /mark 记录停中继后的观察结果。", direct))
	}
	if relay > 0 && direct == 0 {
		out = append(out, "仅中继可用：当前没有直连；可能是对称 NAT/CGNAT 或 UDP 被封锁。")
	}
	d := n.GetDcutr()
	if d.GetAttempts() > 0 && d.GetSuccesses() == 0 {
		out = append(out, fmt.Sprintf("打洞：尝试 %d 次、成功 0、失败 %d；attempt 不等于 direct。", d.GetAttempts(), d.GetFailures()))
	}
	if hasTCPRelay && d.GetFailures() > 0 {
		out = append(out, "双 NAT 下 TCP 直连 BLOCKED；当前经中继回退，不能写成 direct。")
	}
	if n.GetDht().GetEnabled() && n.GetDht().GetLastError() != "" {
		out = append(out, "DHT："+textsafe.Sanitize(n.GetDht().GetLastError()))
	}
	if n.GetDht().GetEnabled() && len(n.GetDht().GetRoutingTablePeers()) == 0 {
		out = append(out, "DHT 路由表为空；bootstrap/发现可能尚未完成。")
	}
	if len(out) == 0 {
		out = append(out, "本地 API 未报告明显问题。")
	}
	return out
}
