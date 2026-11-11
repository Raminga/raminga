package tui

import (
	"errors"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/report"
)

// ExportReport writes the redacted JSON+Markdown report. Message text is only
// included when the caller explicitly asks for it.
func (m *Model) ExportReport(includeText bool) (jsonPath, mdPath string, err error) {
	if m.status == nil {
		return "", "", errors.New("本地 API 状态尚未就绪")
	}
	peers := &apiv1.PeersResponse{Peers: m.peers}
	msgs := &apiv1.RecentMessagesResponse{Messages: m.messages}
	outbox := m.outbox
	if outbox == nil {
		outbox = &apiv1.OutboxListResponse{}
	}
	r := report.Build(m.status, peers, msgs, outbox, report.Options{
		Version:                       m.opts.Version,
		IncludeText:                   includeText,
		Timeline:                      m.timeline,
		RouteChanges:                  m.changes,
		ACKs:                          m.acks,
		StillDirectAfterRelayStop:     m.stillDirect,
		StillDirectObservationSeconds: m.stillSeconds,
		Now:                           time.Now(),
	})
	jsonPath, err = report.WriteJSON(m.opts.ReportDir, r)
	if err != nil {
		return "", "", err
	}
	mdPath, err = report.WriteMarkdown(m.opts.ReportDir, r)
	if err != nil {
		return "", "", err
	}
	return jsonPath, mdPath, nil
}

func (m *Model) exportCmd(includeText bool) tea.Cmd {
	return func() tea.Msg {
		jsonPath, mdPath, err := m.ExportReport(includeText)
		return reportResultMsg{jsonPath: jsonPath, mdPath: mdPath, err: err}
	}
}
