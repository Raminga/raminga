package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Standard ANSI colours follow the terminal's own theme. Do not use
// lipgloss.AdaptiveColor here: it queries the terminal background on first use,
// which blocks the event loop for seconds and swallows keyboard input.
// Rendering is the only place colours apply, so the in-memory log stays plain.
var (
	colorSuccess  lipgloss.TerminalColor = lipgloss.Color("2")
	colorError    lipgloss.TerminalColor = lipgloss.Color("1")
	colorWarning  lipgloss.TerminalColor = lipgloss.Color("3")
	colorIncoming lipgloss.TerminalColor = lipgloss.Color("6")
)

// View renders only the live region: status line, input line, then the
// completion popup or the one-line hint. All other output goes through
// tea.Println into the terminal's normal scrollback.
func (m *Model) View() string {
	lines := []string{m.statusLine(), m.inputLine()}
	if m.popup.active {
		lines = append(lines, m.popupLines()...)
	} else {
		lines = append(lines, m.hintLine())
	}
	return strings.Join(lines, "\n")
}

func (m *Model) statusLine() string {
	me := "?"
	if m.status != nil {
		me = displayMyName(m.status, m.friends)
	}
	parts := make([]string, 0, 6)
	if m.apiFailing {
		parts = append(parts, "节点未运行")
	}
	if m.streamErr != "" {
		parts = append(parts, "事件重连中")
	}
	if activity := m.activityLine(); activity != "" {
		parts = append(parts, activity)
	}
	if m.target != nil {
		parts = append(parts, "聊天 "+m.target.Name)
	}
	direct, relay := m.connectionCounts()
	parts = append(parts,
		fmt.Sprintf("连接 %d（直连 %d / 中继 %d）", direct+relay, direct, relay),
		"我 "+me,
	)
	text := strings.Join(parts, " · ")
	// Keep the left-most, most important segments and drop from the right.
	// The chat target therefore survives on an 80-column terminal.
	for len(parts) > 1 && ansi.StringWidth(text) > m.width-1 {
		parts = parts[:len(parts)-1]
		text = strings.Join(parts, " · ")
	}
	return m.style(lipgloss.NewStyle().Bold(true)).Render(m.fit(text))
}

func (m *Model) activityLine() string {
	if m.activity == "" {
		return ""
	}
	if m.opts.Plain {
		return "… " + m.activity
	}
	return m.spin.View() + " " + m.activity
}

func (m *Model) prompt() string {
	if m.target != nil {
		return m.target.Name + "> "
	}
	return "> "
}

func (m *Model) placeholder() string {
	if m.target != nil {
		return "发送给 " + m.target.Name
	}
	return "输入 / 查看指令"
}

func (m *Model) syncPrompt() {
	m.input.Placeholder = m.placeholder()
	m.syncInputWidth()
}

func (m *Model) syncInputWidth() {
	available := m.width - ansi.StringWidth(m.prompt()) - 1
	if available < 1 {
		available = 1
	}
	if m.input.Width == available {
		return
	}
	m.input.Width = available
	m.input.SetCursor(m.input.Position()) // recompute the horizontal scroll window
}

// renderLogLine formats one queued line. Only asynchronous events get a
// timestamp, and it is dimmed unless --plain is active. Status symbols are
// coloured on their own, so addresses and Peer IDs in the rest of the line stay
// uncoloured and unbroken.
func (m *Model) renderLogLine(line logLine) string {
	text := m.styleLogText(line.Text)
	if !line.Event {
		return text
	}
	ts := line.At.Format("15:04:05") + " "
	if m.opts.Plain {
		return ts + text
	}
	return m.style(lipgloss.NewStyle().Faint(true)).Render(ts) + text
}

func (m *Model) styleLogText(text string) string {
	if m.opts.Plain {
		return text
	}
	var (
		style  lipgloss.Style
		prefix string
	)
	switch {
	case strings.HasPrefix(text, "✗"):
		style, prefix = lipgloss.NewStyle().Foreground(colorError), "✗"
	case strings.HasPrefix(text, "!"):
		style, prefix = lipgloss.NewStyle().Foreground(colorWarning), "!"
	case strings.HasPrefix(text, "✓"):
		style, prefix = lipgloss.NewStyle().Foreground(colorSuccess), "✓"
	case strings.HasPrefix(text, "←"):
		style, prefix = lipgloss.NewStyle().Foreground(colorIncoming).Bold(true), "←"
	default:
		return text
	}
	return m.style(style).Render(prefix) + text[len(prefix):]
}

func (m *Model) popupLines() []string {
	start, end := m.popupWindow()
	labelWidth := 0
	for i := start; i < end; i++ {
		if w := displayWidth(m.popup.items[i].Label); w > labelWidth {
			labelWidth = w
		}
	}
	if labelWidth > 12 {
		labelWidth = 12
	}
	out := make([]string, 0, end-start+1)
	for i := start; i < end; i++ {
		item := m.popup.items[i]
		mark := " "
		if i == m.popup.sel {
			mark = ">"
		}
		line := fmt.Sprintf("%s %s  %s", mark, padDisplay(item.Label, labelWidth), item.Desc)
		if i == m.popup.sel {
			line = m.style(lipgloss.NewStyle().Bold(true)).Render(m.fit(line))
		} else {
			line = m.fit(line)
		}
		out = append(out, line)
	}
	if len(m.popup.items) > 0 {
		out = append(out, m.fit(fmt.Sprintf("  %d-%d/%d", start+1, end, len(m.popup.items))))
	}
	return out
}

func (m *Model) inputLine() string {
	m.input.Placeholder = m.placeholder()
	m.syncInputWidth()
	prefix := m.prompt()
	if m.opts.Plain {
		return m.fit(prefix + m.plainInputView())
	}
	// The width calculation already reserves the prompt and one cell. Allow the
	// full computed line so the tail and cursor are both visible; only clamp if
	// a style/terminal width exceeds it.
	return ansi.TruncateWc(prefix+m.input.View(), m.width, "…")
}

// plainInputView renders the same horizontally scrolling window as
// bubbles/textinput, including its cursor cell, using display-cell widths so
// CJK input keeps the tail and cursor visible.
func (m *Model) plainInputView() string {
	raw := m.input.Value()
	if raw == "" {
		return m.input.Placeholder
	}
	value := []rune(raw)
	posRunes := m.input.Position()
	if posRunes < 0 {
		posRunes = 0
	}
	if posRunes > len(value) {
		posRunes = len(value)
	}
	budget := m.input.Width
	if budget < 1 {
		budget = 1
	}
	limit := budget - 1
	if limit < 1 {
		limit = 1
	}
	start := 0
	for start < posRunes && ansi.StringWidth(string(value[start:posRunes])) > limit {
		start++
	}
	end := len(value)
	for end > posRunes && ansi.StringWidth(string(value[start:end])) > limit {
		end--
	}
	return string(value[start:posRunes]) + "▌" + string(value[posRunes:end])
}

func (m *Model) hintLine() string {
	hint := "输入 / 查看指令（/help 查看全部） · Ctrl+C 清空输入（空输入退出）"
	if m.target != nil {
		hint = "输入文字发送 · / 查看指令 · 空输入按 Esc 退出聊天"
	}
	if m.popup.active {
		hint = "↑/↓ 选择 · Tab 补全 · Enter 确认 · Esc 关闭"
	}
	return m.style(lipgloss.NewStyle().Faint(true)).Render(m.fit(hint))
}

func (m *Model) fit(s string) string {
	if m.width <= 1 {
		return s
	}
	return ansi.TruncateWc(s, m.width-1, "…")
}

func (m *Model) style(s lipgloss.Style) lipgloss.Style {
	if m.opts.Plain {
		return lipgloss.NewStyle()
	}
	return s
}
