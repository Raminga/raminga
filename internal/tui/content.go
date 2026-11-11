package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/content"
	"github.com/Raminga/raminga/internal/peerarg"
	"github.com/Raminga/raminga/internal/textsafe"
)

func (m *Model) contentPeer(arg string) (string, error) {
	_, pid, _, err := m.resolve(arg)
	return pid, err
}

func (m *Model) viewPrivacyNote() {
	if m.viewNotice {
		return
	}
	m.viewNotice = true
	m.appendLog("提示：查看内容会向对方暴露你的 Peer ID 和 IP，并可能把对方记入本地好友表。")
}

func (m *Model) cmdView(arg string) tea.Cmd {
	pid, err := m.contentPeer(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.viewPrivacyNote()
	client := m.client
	owner := textsafe.Sanitize(displayName(pid, m.friends))
	m.appendLog("… 正在读取 %s 的档案", shortID(pid))
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res, err := client.GetPeerProfile(ctx, pid)
		if err != nil {
			return contentResultMsg{kind: "view", err: err}
		}
		lines := []string{fmt.Sprintf("档案：%s，共 %d 个文件", owner, len(res.GetFiles()))}
		if !res.GetFound() {
			lines = append(lines, "（没有 profile/index.md）")
			for _, f := range res.GetFiles() {
				lines = append(lines, "  "+textsafe.Sanitize(f))
			}
			return contentResultMsg{kind: "view", lines: lines}
		}
		for _, line := range strings.Split(res.GetText(), "\n") {
			lines = append(lines, textsafe.Sanitize(line))
		}
		return contentResultMsg{kind: "view", lines: lines}
	}
}

func (m *Model) cmdPosts(arg string) tea.Cmd {
	pid, err := m.contentPeer(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.viewPrivacyNote()
	client := m.client
	owner := textsafe.Sanitize(displayName(pid, m.friends))
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		res, err := client.GetPeerManifest(ctx, pid, 0, 200)
		if err != nil {
			return contentResultMsg{kind: "posts", err: err}
		}
		var posts []string
		for _, e := range res.GetEntries() {
			if strings.HasPrefix(e.GetPath(), "posts/") {
				posts = append(posts, textsafe.Sanitize(e.GetPath()))
			}
		}
		lines := []string{fmt.Sprintf("动态：%s，共 %d 个", owner, len(posts))}
		if len(posts) == 0 {
			lines = append(lines, "（没有动态文件）")
		} else {
			lines = append(lines, posts...)
		}
		return contentResultMsg{kind: "posts", lines: lines}
	}
}

func (m *Model) cmdPeerFriends(arg string) tea.Cmd {
	pid, err := m.contentPeer(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.viewPrivacyNote()
	client := m.client
	owner := displayName(pid, m.friends)
	// A short ID can't be typed back, so the hint falls back to the full one.
	ownerArg := owner
	if strings.HasSuffix(ownerArg, "…") {
		ownerArg = pid
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res, err := client.GetPeerFriends(ctx, pid)
		if err != nil {
			return contentResultMsg{kind: "peerfriends", err: err}
		}
		return contentResultMsg{kind: "peerfriends", lines: peerFriendLines(owner, ownerArg, res.GetFriends())}
	}
}

// peerFriendLines renders a remote friend list. Everything in it is the
// owner's claim, so the header says so and the text is sanitized.
func peerFriendLines(owner, ownerArg string, friends []*apiv1.PeerFriendClaim) []string {
	lines := []string{fmt.Sprintf("%s 的好友列表（对方的说法，未验证），共 %d 条", textsafe.Sanitize(owner), len(friends))}
	names := make([]string, len(friends))
	width := 0
	for i, f := range friends {
		names[i] = textsafe.Sanitize(f.GetName())
		if names[i] == "" {
			names[i] = "-"
		}
		if w := displayWidth(names[i]); w > width {
			width = w
		}
	}
	for i, f := range friends {
		line := padDisplay(names[i], width) + "  " + textsafe.Sanitize(f.GetPeerId())
		if desc := textsafe.Sanitize(f.GetDescription()); desc != "" {
			line += "  描述=" + desc
		}
		lines = append(lines, line)
		if len(f.GetAddrs()) == 0 {
			lines = append(lines, "  （没有可用地址）")
		}
		lines = append(lines, labelledAddrLines(f.GetAddrs())...)
	}
	if len(friends) > 0 {
		lines = append(lines, fmt.Sprintf("连接：/connect %s <名字|Peer ID>", textsafe.Sanitize(ownerArg)))
	}
	return lines
}

// cmdConnectListed connects to a peer found in another node's friend list.
// Reading a list never dials: this runs only when the user asks for it.
func (m *Model) cmdConnectListed(ownerID, listed string) tea.Cmd {
	if m.busy {
		m.appendLog("… 上一个操作尚未结束，内容已保留")
		return nil
	}
	m.viewPrivacyNote()
	m.busy = true
	client := m.client
	spinCmd := m.startActivity(progressLabel("正在连接 " + textsafe.Sanitize(listed)))
	work := func() tea.Msg { return connectListed(client, ownerID, listed) }
	return tea.Batch(spinCmd, work)
}

func connectListed(client Client, ownerID, listed string) tea.Msg {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	list, err := client.GetPeerFriends(ctx, ownerID)
	if err != nil {
		// Only a dial failure reads as one; a bad list must not look like a
		// network problem.
		if text := errText(err); !strings.Contains(text, "dial") {
			return connectResultMsg{name: listed, peerID: ownerID, notice: "读取对方好友列表失败：" + text}
		}
		return connectResultMsg{name: listed, peerID: ownerID, err: err, elapsed: time.Since(start)}
	}
	want := peerarg.Normalize(listed)
	var target *apiv1.PeerFriendClaim
	for _, f := range list.GetFriends() {
		if f.GetPeerId() == want || f.GetName() == listed {
			target = f
			break
		}
	}
	if target == nil {
		return connectResultMsg{name: listed, peerID: ownerID, notice: fmt.Sprintf("对方的好友列表里没有 %s；用 /peerfriends 查看", listed)}
	}
	name := target.GetName()
	if name == "" {
		name = shortID(target.GetPeerId())
	}
	res, err := client.ConnectListedPeer(ctx, target.GetPeerId(), target.GetAddrs())
	if err != nil {
		return connectResultMsg{name: name, peerID: target.GetPeerId(), err: err, elapsed: time.Since(start)}
	}
	return connectResultMsg{
		res: &apiv1.ConnectResponse{
			PeerId: res.GetPeerId(), Transport: res.GetTransport(), Direct: res.GetDirect(), Limited: res.GetLimited(),
			RemoteMultiaddr: res.GetRemoteMultiaddr(), Route: res.GetRoute(), RelayPeerId: res.GetRelayPeerId(),
			Reused: res.GetReused(), RequestedTransport: res.GetRequestedTransport(), TransportChanged: res.GetTransportChanged(),
			Source: res.GetSource(), Attempts: res.GetAttempts(), Note: res.GetNote(),
		},
		name: name, peerID: target.GetPeerId(), elapsed: time.Since(start),
	}
}

func waitDownloadProgress(token int, ch <-chan *apiv1.DownloadPeerFileResponse) tea.Cmd {
	return func() tea.Msg {
		res, ok := <-ch
		if !ok {
			return downloadDoneMsg{token: token}
		}
		return downloadProgressMsg{token: token, ch: ch, res: res}
	}
}

func (m *Model) setDownloadProgress(res *apiv1.DownloadPeerFileResponse) {
	path := textsafe.Sanitize(res.GetPath())
	if path == "" {
		path = m.dlPath
	}
	received, total := res.GetReceivedBytes(), res.GetTotalBytes()
	if received < 0 {
		received = 0
	}
	if total < 0 {
		total = 0
	}
	if path != m.dlPath || total != m.dlTotal {
		m.dlReceived = 0
		m.dlHaveProgress = false
	}
	if m.dlHaveProgress && received < m.dlReceived {
		return
	}
	if total > 0 && received > total {
		received = total
	}
	m.dlPath, m.dlReceived, m.dlTotal = path, received, total
	m.dlHaveProgress = true
	m.activity = downloadActivity(path, received, total)
}

func downloadActivity(path string, received, total int64) string {
	if total > 0 {
		percent := received * 100 / total
		if percent < 0 {
			percent = 0
		}
		if percent > 100 {
			percent = 100
		}
		return fmt.Sprintf("下载 %s %d%%", path, percent)
	}
	return fmt.Sprintf("下载 %s %d B", path, received)
}

func (m *Model) cmdGet(arg, path string) tea.Cmd {
	pid, err := m.contentPeer(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.viewPrivacyNote()
	client := m.client
	m.busy = true
	m.downloadSeq++
	token := m.downloadSeq
	ch := make(chan *apiv1.DownloadPeerFileResponse, 32)
	spinCmd := m.startActivity(progressLabel("下载 " + textsafe.Sanitize(path)))
	return tea.Batch(spinCmd, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res, err := client.DownloadPeerFile(ctx, pid, path, func(p *apiv1.DownloadPeerFileResponse) {
			select {
			case ch <- p:
			default:
			}
		})
		close(ch)
		if err != nil {
			return contentResultMsg{kind: "get", err: err}
		}
		return contentResultMsg{kind: "get", lines: []string{"已保存：" + textsafe.Sanitize(res.GetLocalPath()), "大小：" + humanBytes(res.GetTotalBytes()), "sha256：" + textsafe.Sanitize(res.GetSha256())}}
	}, waitDownloadProgress(token, ch))
}

func (m *Model) cmdFiles(arg string) tea.Cmd {
	pid, err := m.contentPeer(arg)
	if err != nil {
		m.appendLog("! %s", textsafe.Sanitize(err.Error()))
		return nil
	}
	m.viewPrivacyNote()
	client := m.client
	owner := textsafe.Sanitize(displayName(pid, m.friends))
	m.appendLog("… 正在读取 %s 的完整清单", owner)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		var rows []sizedRow
		offset := 0
		total := -1
		for pages := 0; pages < 1000; pages++ {
			res, err := client.GetPeerManifest(ctx, pid, int32(offset), content.MaxManifestLimit)
			if err != nil {
				return contentResultMsg{kind: "files", err: err}
			}
			if total < 0 {
				total = int(res.GetTotal())
			}
			entries := res.GetEntries()
			for _, e := range entries {
				rows = append(rows, sizedRow{Path: textsafe.Sanitize(e.GetPath()), Size: e.GetSize()})
			}
			if len(entries) == 0 || offset+len(entries) >= total {
				break
			}
			offset += len(entries)
		}
		lines := []string{fmt.Sprintf("清单：%s，共 %d 个文件", owner, total)}
		if len(rows) == 0 {
			lines = append(lines, "（对方没有可列出的文件）")
		} else {
			lines = append(lines, sizedLines(rows, "")...)
		}
		lines = append(lines, "下载：/get <节点> <上面的清单路径>")
		return contentResultMsg{kind: "files", lines: lines}
	}
}

func (m *Model) cmdPublished(sync bool) tea.Cmd {
	client := m.client
	if sync {
		m.appendLog("… 正在重写 friends.json 并重新扫描本机公开目录")
	} else {
		m.appendLog("… 正在重新扫描本机公开目录")
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		lines := []string{}
		if sync {
			res, err := client.SyncFriends(ctx)
			switch {
			case err != nil:
				lines = append(lines, "✗ friends.json 重写失败："+errText(err))
			case res.GetWritten():
				lines = append(lines, "✓ friends.json 已重写")
			default:
				lines = append(lines, "✓ friends.json 无变化")
			}
		}
		res, err := client.Published(ctx)
		if err != nil {
			return contentResultMsg{kind: "published", lines: lines, err: err}
		}
		if res.GetGeneratedAtUnixMs() > 0 {
			lines = append(lines, "扫描时间："+time.UnixMilli(res.GetGeneratedAtUnixMs()).UTC().Format(time.RFC3339))
		}
		if res.GetFriendsSyncedAtUnixMs() > 0 {
			lines = append(lines, "friends.json 最后变更时间："+time.UnixMilli(res.GetFriendsSyncedAtUnixMs()).UTC().Format(time.RFC3339))
		} else {
			lines = append(lines, "friends.json 最后变更时间：尚未生成")
		}
		lines = append(lines, fmt.Sprintf("已发布：%d 个文件", len(res.GetFiles())))
		rows := make([]sizedRow, 0, len(res.GetFiles()))
		for _, f := range res.GetFiles() {
			rows = append(rows, sizedRow{Path: textsafe.Sanitize(f.GetPath()), Size: f.GetSize()})
		}
		lines = append(lines, sizedLines(rows, "  ")...)
		lines = append(lines, fmt.Sprintf("已跳过：%d 个路径", len(res.GetSkipped())))
		for _, skipped := range res.GetSkipped() {
			lines = append(lines, "  "+textsafe.Sanitize(skipped.GetPath())+"（"+textsafe.Sanitize(skipped.GetReason())+"）")
		}
		return contentResultMsg{kind: "published", lines: lines}
	}
}
