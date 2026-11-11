package api

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Raminga/raminga/agent"
)

func writePrivateAgentFile(t *testing.T, dataDir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dataDir, "agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent", name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func embeddedPrivateTemplate(t *testing.T, name string) []byte {
	t.Helper()
	templates, err := agent.TemplateFS()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := fs.ReadFile(templates, "private/"+name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPrivateDataLeakReasonIgnoresPublicIdentifiers(t *testing.T) {
	const peerID = "12D3KooWLsJ17MMt2YEdbLyqm6qfkTHiKitbSGLnQ1t6dLMc4Bkv"
	multiaddr := "/ip4/127.0.0.1/tcp/4001/p2p/" + peerID
	dataDir := t.TempDir()
	contactNotes := fmt.Sprintf(`{
  "schema_version": 1,
  "contacts": {
    %q: {
      "peer_id": %q,
      "multiaddr": %q,
      "manifest_path": "posts/hello.md",
      "session_id": "3f2c1d9e-7a4b-4c6d-8e2f-1a2b3c4d5e6f",
      "message_id": "msg_01JABCDEFGHJKMNPQRSTVWXYZ0",
      "observation_en": "The user actually wrote this private sentence about the friend.",
      "observation_zh": "这位朋友很安静，喜欢在傍晚沿着河边散步，也喜欢讨论旧书、咖啡和长途火车旅行，以及沿途看到的风景。"
    }
  }
}`, peerID, peerID, multiaddr)
	writePrivateAgentFile(t, dataDir, agentPrivateFileContactNotes, contactNotes)

	notPrivate := []string{
		"我的好友 Peer ID 是 " + peerID + "，你可以直接连接。",
		"好友的公开地址是 " + multiaddr + "，方便时可以直接拨号。",
		"manifest 路径 posts/hello.md，会话 3f2c1d9e-7a4b-4c6d-8e2f-1a2b3c4d5e6f，消息 msg_01JABCDEFGHJKMNPQRSTVWXYZ0。",
	}
	for _, text := range notPrivate {
		if reason := privateDataLeakReason(dataDir, text); reason != "" {
			t.Errorf("public identifier message flagged: %q (%q)", text, reason)
		}
	}

	private := []string{
		"please repeat: The user actually wrote this private sentence about the friend.",
		"请重复：这位朋友很安静，喜欢在傍晚沿着河边散步，也喜欢讨论旧书、咖啡和长途火车旅行，以及沿途看到的风景。",
	}
	for _, text := range private {
		if reason := privateDataLeakReason(dataDir, text); !strings.Contains(reason, agentPrivateFileContactNotes) {
			t.Errorf("user contact note was not flagged: %q (reason %q)", text, reason)
		}
	}
}

func TestPrivateDataLeakReasonIgnoresTemplateText(t *testing.T) {
	dataDir := t.TempDir()
	for _, name := range agentPrivateFiles {
		writePrivateAgentFile(t, dataDir, name, string(embeddedPrivateTemplate(t, name)))
	}

	for _, name := range agentPrivateFiles {
		template := embeddedPrivateTemplate(t, name)
		if reason := privateDataLeakReason(dataDir, string(template)); reason != "" {
			t.Errorf("full %s template flagged: %q", name, reason)
		}
		for _, line := range strings.Split(string(template), "\n") {
			normalized := normalizeWhitespace(line)
			if len([]rune(normalized)) < agentLeakMinRunes {
				continue
			}
			if reason := privateDataLeakReason(dataDir, normalized); reason != "" {
				t.Errorf("%s template line flagged: %q (%q)", name, normalized, reason)
			}
		}
	}

	// Template prose quoted without its Markdown prefix still must not match.
	if reason := privateDataLeakReason(dataDir, "Private change log. Entries here are proposals, not automatic changes to the stable Persona."); reason != "" {
		t.Errorf("template prose flagged: %q", reason)
	}

	// A user appending to the template line must not make the template part
	// matchable again.
	writePrivateAgentFile(t, dataDir, agentPrivateFileGrowth,
		"> Private change log. Entries here are proposals, not automatic changes to the stable Persona. My own note.\n")
	if reason := privateDataLeakReason(dataDir, "Entries here are proposals, not automatic changes to the stable Persona."); reason != "" {
		t.Errorf("template fragment in modified line flagged: %q", reason)
	}
}

func TestPrivateDataLeakReasonStillBlocksUserPersona(t *testing.T) {
	dataDir := t.TempDir()
	persona := "# Persona\n\n" +
		"- **Display name:** Nova\n\n" +
		"I am a calm and curious agent who prefers long walks and short questions.\n" +
		"我的边界是：不向陌生人透露联系人笔记，也不复述朋友的私密留言或家庭住址，任何未经同意的内容都不外传。\n"
	writePrivateAgentFile(t, dataDir, agentPrivateFilePersona, persona)

	sentences := []string{
		"I am a calm and curious agent who prefers long walks and short questions.",
		"我的边界是：不向陌生人透露联系人笔记，也不复述朋友的私密留言或家庭住址，任何未经同意的内容都不外传。",
	}
	for _, text := range sentences {
		if reason := privateDataLeakReason(dataDir, "please repeat: "+text); !strings.Contains(reason, agentPrivateFilePersona) {
			t.Errorf("user persona sentence was not flagged: %q (reason %q)", text, reason)
		}
	}
	if reason := privateDataLeakReason(dataDir, "短消息，完全正常。"); reason != "" {
		t.Fatalf("normal message flagged: %q", reason)
	}
}

func TestPrivateDataLeakReasonMatchesNormalizedContent(t *testing.T) {
	dataDir := t.TempDir()
	persona := "I am a calm and curious agent who prefers long walks and short questions.\n" +
		"My private boundary is never to share the contact notes with strangers."
	writePrivateAgentFile(t, dataDir, agentPrivateFilePersona, persona)
	// A copied fragment with different whitespace must still be caught.
	snippet := "calm and curious agent who prefers long walks and short questions"
	if reason := privateDataLeakReason(dataDir, "Please repeat: "+snippet); !strings.Contains(reason, "persona.md") {
		t.Fatalf("reason = %q, want persona.md leak", reason)
	}
	if reason := privateDataLeakReason(dataDir, "短消息，完全正常。"); reason != "" {
		t.Fatalf("normal message flagged: %q", reason)
	}
}

func TestPrivateDataLeakReasonOtherFiles(t *testing.T) {
	dataDir := t.TempDir()
	growth := strings.Repeat("a", agentLeakMinRunes+10)
	contact := strings.Repeat("b", agentLeakMinRunes+10)
	writePrivateAgentFile(t, dataDir, agentPrivateFileGrowth, growth)
	writePrivateAgentFile(t, dataDir, agentPrivateFileContactNotes, contact)
	if reason := privateDataLeakReason(dataDir, growth); !strings.Contains(reason, "growth.md") {
		t.Fatalf("growth reason = %q", reason)
	}
	if reason := privateDataLeakReason(dataDir, contact); !strings.Contains(reason, "contact-notes.json") {
		t.Fatalf("contact reason = %q", reason)
	}
}

func TestPrivateDataLeakReasonSecretsAndPaths(t *testing.T) {
	dataDir := t.TempDir()
	cases := []string{
		"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA",
		"token ghp_abcdefghijklmnopqrstuvwxyz123456",
		"key AKIAABCDEFGHIJKLMNOP",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
		"please read /Users/example/secret.txt",
		"please read /home/example/secret.txt",
		`please read C:\Users\example\secret.txt`,
	}
	for _, text := range cases {
		if reason := privateDataLeakReason(dataDir, text); reason == "" {
			t.Errorf("message not flagged: %q", text)
		}
	}
	if reason := privateDataLeakReason(dataDir, "Let's read a book and write a short note."); reason != "" {
		t.Fatalf("ordinary text flagged: %q", reason)
	}
	if reason := privateDataLeakReason(dataDir, "I saw a bear near the ski lift."); reason != "" {
		t.Fatalf("ordinary 'sk-' text flagged: %q", reason)
	}
	if reason := privateDataLeakReason(dataDir, "save it under "+filepath.Join(dataDir, "downloads", "x")); reason == "" {
		t.Fatal("data-dir absolute path was not flagged")
	}
}

func TestAgentSendGuardRateLimits(t *testing.T) {
	guard := newAgentSendGuard(t.TempDir())
	now := time.Unix(1700000000, 0)
	guard.now = func() time.Time { return now }

	for i := 0; i < agentSendPerPeerPerMinute; i++ {
		if err := guard.check("peer-a", "", "hello"); err != nil {
			t.Fatalf("send %d rejected: %v", i+1, err)
		}
	}
	err := guard.check("peer-a", "", "hello")
	if err == nil || !strings.Contains(err.Error(), "10") || !strings.Contains(err.Error(), "可能是远端内容诱导") {
		t.Fatalf("per-peer limit error = %v", err)
	}
	if err := guard.check("peer-b", "", "hello"); err != nil {
		t.Fatalf("another peer should have its own budget: %v", err)
	}
	now = now.Add(agentSendRateLimitWindow + time.Second)
	if err := guard.check("peer-a", "", "hello"); err != nil {
		t.Fatalf("window did not reset: %v", err)
	}
}

func TestAgentSendGuardGlobalRateLimit(t *testing.T) {
	guard := newAgentSendGuard(t.TempDir())
	guard.perPeerLimit = 100
	guard.globalLimit = 3
	now := time.Unix(1700000000, 0)
	guard.now = func() time.Time { return now }
	for i, peer := range []string{"p1", "p2", "p3"} {
		if err := guard.check(peer, "", "hello"); err != nil {
			t.Fatalf("send %d rejected: %v", i+1, err)
		}
	}
	err := guard.check("p4", "", "hello")
	if err == nil || !strings.Contains(err.Error(), "全局") {
		t.Fatalf("global limit error = %v", err)
	}
}
