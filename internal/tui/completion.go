package tui

import (
	"fmt"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
)

type completion struct {
	Insert string
	Label  string
	Desc   string
}

type popup struct {
	active bool
	items  []completion
	sel    int
	offset int
	// moved records an explicit arrow/shift+tab selection. It is cleared
	// whenever the candidate list changes so Enter only accepts a value the
	// user deliberately highlighted.
	moved bool
	// argStart/argEnd are rune offsets of the argument being completed in the
	// whole input value; only that range is replaced.
	argStart int
	argEnd   int
}

const popupMaxVisible = 8

func (m *Model) updatePopup() {
	oldItems := append([]completion(nil), m.popup.items...)
	defer func() {
		if !sameCompletions(oldItems, m.popup.items) {
			m.popup.moved = false
		}
	}()
	value := m.input.Value()
	m.popup.items = nil
	m.popup.active = false
	m.popup.argStart, m.popup.argEnd = 0, 0
	if !strings.HasPrefix(value, "/") {
		return
	}
	body := strings.TrimPrefix(value, "/")
	if !strings.Contains(body, " ") {
		for _, c := range commands {
			name := strings.TrimPrefix(c.Name, "/")
			if strings.HasPrefix(name, body) {
				insert := c.Name
				if c.Args {
					insert += " "
				}
				m.popup.items = append(m.popup.items, completion{Insert: insert, Label: c.Name, Desc: c.Desc})
			}
		}
		m.finishPopup()
		return
	}

	cmdToken, argPart, _ := strings.Cut(body, " ")
	cmd, ok, _ := resolveCommand("/" + cmdToken)
	if !ok || len(cmd.ArgKinds) == 0 {
		m.finishPopup()
		return
	}
	argRunes := []rune(argPart)
	prefixRunes := len([]rune("/" + cmdToken + " "))
	cursor := m.input.Position() - prefixRunes
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(argRunes) {
		cursor = len(argRunes)
	}
	idx, start, end := currentField(argRunes, cursor)
	if idx >= len(cmd.ArgKinds) {
		m.finishPopup()
		return
	}
	arg := string(argRunes[start:end])
	switch cmd.ArgKinds[idx] {
	case argPeer:
		m.popup.items = m.peerCompletions(arg)
	case argOutbox:
		if m.outbox != nil {
			for _, e := range m.outbox.GetEntries() {
				if strings.HasPrefix(e.GetMessageId(), arg) {
					m.popup.items = append(m.popup.items, completion{Insert: e.GetMessageId(), Label: e.GetMessageId(), Desc: fmt.Sprintf("%s · %s", displayName(e.GetPeerId(), m.friends), outboxStatus(e.GetStatus()))})
				}
			}
		}
	case argText:
		m.finishPopup()
		return
	}
	m.popup.argStart = prefixRunes + start
	m.popup.argEnd = prefixRunes + end
	m.finishPopup()
}

func (m *Model) finishPopup() {
	if len(m.popup.items) > 0 {
		m.popup.active = true
		if m.popup.sel >= len(m.popup.items) {
			m.popup.sel = len(m.popup.items) - 1
		}
		if m.popup.sel < 0 {
			m.popup.sel = 0
		}
		m.clampPopupOffset()
	} else {
		m.popup.sel = 0
		m.popup.offset = 0
	}
}

func (m *Model) clampPopupOffset() {
	maxOffset := len(m.popup.items) - popupMaxVisible
	if maxOffset < 0 {
		maxOffset = 0
	}
	if m.popup.offset > maxOffset {
		m.popup.offset = maxOffset
	}
	if m.popup.offset < 0 {
		m.popup.offset = 0
	}
	if m.popup.sel < m.popup.offset {
		m.popup.offset = m.popup.sel
	}
	if m.popup.sel >= m.popup.offset+popupMaxVisible {
		m.popup.offset = m.popup.sel - popupMaxVisible + 1
	}
	if m.popup.offset > maxOffset {
		m.popup.offset = maxOffset
	}
}

func sameCompletions(a, b []completion) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (m *Model) popupMove(delta int) {
	if !m.popup.active || len(m.popup.items) == 0 {
		return
	}
	before := m.popup.sel
	m.popup.sel += delta
	if m.popup.sel < 0 {
		m.popup.sel = 0
	}
	if m.popup.sel >= len(m.popup.items) {
		m.popup.sel = len(m.popup.items) - 1
	}
	if m.popup.sel != before {
		m.popup.moved = true
	}
	m.clampPopupOffset()
}

func (m *Model) popupWindow() (start, end int) {
	start = m.popup.offset
	end = start + popupMaxVisible
	if end > len(m.popup.items) {
		end = len(m.popup.items)
	}
	if start > end {
		start = end
	}
	return start, end
}

func (m *Model) peerCompletions(prefix string) []completion {
	var out []completion
	seen := map[string]bool{}
	for _, n := range m.friends {
		// An unnamed friend is offered by Peer ID, never as a blank row.
		label := n.GetName()
		if label == "" {
			label = n.GetPeerId()
		}
		if strings.HasPrefix(label, prefix) {
			out = append(out, completion{Insert: label, Label: label, Desc: "好友"})
			seen[n.GetPeerId()] = true
		}
	}
	for _, p := range m.peers {
		if seen[p.GetPeerId()] {
			continue
		}
		id := p.GetPeerId()
		if strings.HasPrefix(id, prefix) || strings.HasPrefix(shortID(id), prefix) {
			status := "离线"
			if p.GetOnline() {
				status = "在线"
			}
			out = append(out, completion{Insert: id, Label: id, Desc: status})
		}
	}
	return out
}

func (m *Model) completeSelected() (tea.Cmd, bool) {
	if !m.popup.active || len(m.popup.items) == 0 {
		return nil, false
	}
	item := m.popup.items[m.popup.sel]
	value := m.input.Value()
	if strings.HasPrefix(item.Insert, "/") {
		m.input.SetValue(item.Insert)
		m.input.CursorEnd()
		m.updatePopup()
		return nil, false
	}
	runes := []rune(value)
	start, end := m.popup.argStart, m.popup.argEnd
	if start < 0 || start > len(runes) || end < start || end > len(runes) {
		return nil, false
	}
	insert := []rune(item.Insert)
	if end == len(runes) {
		insert = append(insert, ' ')
	}
	next := make([]rune, 0, len(runes)+len(insert))
	next = append(next, runes[:start]...)
	next = append(next, insert...)
	next = append(next, runes[end:]...)
	m.input.SetValue(string(next))
	m.input.SetCursor(start + len(insert))
	m.updatePopup()
	return nil, false
}

// currentField returns the argument index and rune range under the cursor.
// A cursor after trailing whitespace selects the next (empty) argument.
func currentField(runes []rune, pos int) (index, start, end int) {
	if pos < 0 {
		pos = 0
	}
	if pos > len(runes) {
		pos = len(runes)
	}
	index = 0
	for i := 0; i < len(runes); {
		for i < len(runes) && unicode.IsSpace(runes[i]) {
			i++
		}
		if i >= len(runes) {
			return index, len(runes), len(runes)
		}
		start = i
		for i < len(runes) && !unicode.IsSpace(runes[i]) {
			i++
		}
		end = i
		if pos <= end {
			return index, start, end
		}
		index++
	}
	return index, len(runes), len(runes)
}
