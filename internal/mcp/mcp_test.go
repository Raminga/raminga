package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/Raminga/raminga/agent"
	"github.com/Raminga/raminga/internal/identity"
)

// writeTestNodeIdentity seeds the minimum identity layout that
// raminga_agent_init requires. The key bytes are never parsed here.
func writeTestNodeIdentity(t *testing.T, dir string) {
	t.Helper()
	identityDir := filepath.Join(dir, identity.IdentityDirName)
	if err := os.MkdirAll(identityDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(identityDir, identity.KeyFileName), []byte("test-key"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// newTestServer builds a server pointed at a fresh, daemon-less data dir so
// the client() handshake fails with a DaemonNotRunningError (no api.token).
func newTestServer(t *testing.T) *sdkmcp.Server {
	t.Helper()
	srv, _ := newTestServerWithDir(t)
	return srv
}

func newTestServerWithDir(t *testing.T) (*sdkmcp.Server, string) {
	t.Helper()
	dir := t.TempDir()
	srv, err := New(dir, "test-version", nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv, dir
}

// drive calls one tool through an in-memory transport and returns its text.
func drive(t *testing.T, srv *sdkmcp.Server, name string, args any) (string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ct, st := sdkmcp.NewInMemoryTransports()
	serverSession, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer func() { _ = serverSession.Close() }()

	c := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := c.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	res, err := cs.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool %q: %v", name, err)
	}
	var sb strings.Builder
	for _, content := range res.Content {
		if tc, ok := content.(*sdkmcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String(), res.IsError
}

func TestToolCatalogRegistered(t *testing.T) {
	srv := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ct, st := sdkmcp.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer func() { _ = ss.Close() }()

	c := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := c.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	listed, err := cs.ListTools(ctx, &sdkmcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(listed.Tools) != 12 {
		t.Fatalf("got %d tools, want 12", len(listed.Tools))
	}
	names := make(map[string]bool)
	for _, tool := range listed.Tools {
		names[tool.Name] = true
	}
	for _, want := range []string{"raminga_status", "raminga_chat_send", "raminga_content_get", "raminga_chat_history", "raminga_agent_init"} {
		if !names[want] {
			t.Errorf("missing tool %q", want)
		}
	}
}

func TestDaemonStarterIsLazyAndRunsOnToolCall(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	srv, err := New(dir, "test-version", nil, WithDaemonStarter(func(context.Context) error {
		calls++
		return nil
	}))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if calls != 0 {
		t.Fatalf("daemon starter ran during New (%d calls)", calls)
	}
	text, isErr := drive(t, srv, "raminga_status", map[string]any{})
	if !isErr {
		t.Fatalf("status without a daemon must be an error result: %q", text)
	}
	if calls != 1 {
		t.Fatalf("daemon starter calls = %d, want 1", calls)
	}
}

func TestDaemonStarterErrorIsReported(t *testing.T) {
	dir := t.TempDir()
	srv, err := New(dir, "test-version", nil, WithDaemonStarter(func(context.Context) error {
		return errors.New("daemon start failed for test")
	}))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	text, isErr := drive(t, srv, "raminga_status", map[string]any{})
	if !isErr || !strings.Contains(text, "daemon start failed for test") {
		t.Fatalf("starter error not reported: isErr=%v text=%q", isErr, text)
	}
}

func TestDaemonNotRunningMapped(t *testing.T) {
	srv := newTestServer(t)
	text, isErr := drive(t, srv, "raminga_status", map[string]any{})
	if !isErr {
		t.Fatalf("expected IsError result, got success: %q", text)
	}
	if !strings.Contains(text, "节点未运行") {
		t.Fatalf("expected daemon-not-running message, got %q", text)
	}
}

func TestMissingRequiredArg(t *testing.T) {
	srv := newTestServer(t)
	// peer_profile requires peer_id; the error is raised before the daemon
	// handshake, so it must not be a "node not running" message.
	text, isErr := drive(t, srv, "raminga_peer_profile", map[string]any{})
	if !isErr {
		t.Fatalf("expected error, got %q", text)
	}
	if !strings.Contains(text, "peer_id") {
		t.Fatalf("expected peer_id validation message, got %q", text)
	}
}

func TestUntrustedFlagInCatalog(t *testing.T) {
	catalog, err := agent.ToolCatalog()
	if err != nil {
		t.Fatalf("ToolCatalog: %v", err)
	}
	untrusted := map[string]bool{}
	for _, tool := range catalog.Tools {
		if tool.ResultUntrusted {
			untrusted[tool.Name] = true
		}
	}
	for _, want := range []string{"raminga_peer_profile", "raminga_peer_manifest", "raminga_peer_friends", "raminga_content_get"} {
		if !untrusted[want] {
			t.Errorf("%s must be marked result_untrusted", want)
		}
	}
	if untrusted["raminga_status"] {
		t.Error("raminga_status must not be result_untrusted")
	}
}

func TestVersionMismatchErrorFormat(t *testing.T) {
	msg := mapError(&versionMismatchError{got: "2", want: "1"})
	if !strings.Contains(msg, "版本不兼容") {
		t.Fatalf("expected version message, got %q", msg)
	}
}

func TestParseArgs(t *testing.T) {
	m, err := parseArgs(json.RawMessage(`{"peer_id":"12D3","limit":3}`))
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if got := argString(m, "peer_id"); got != "12D3" {
		t.Fatalf("peer_id = %q", got)
	}
	if got := limitInt(m, "limit", 20); got != 3 {
		t.Fatalf("limit = %d, want 3", got)
	}
	if got := limitInt(map[string]any{}, "limit", 20); got != 20 {
		t.Fatalf("default limit = %d, want 20", got)
	}
	if got := limitInt(map[string]any{"limit": float64(999)}, "limit", 20); got != 500 {
		t.Fatalf("clamped limit = %d, want 500", got)
	}
}

func TestInitAgentDataCreatesMissingFiles(t *testing.T) {
	dataDir := t.TempDir()
	writeTestNodeIdentity(t, dataDir)
	result, err := initAgentData(dataDir)
	if err != nil {
		t.Fatalf("initAgentData: %v", err)
	}
	wantCreated := []string{"agent/persona.md", "agent/growth.md", "agent/contact-notes.json"}
	if strings.Join(result.Created, ",") != strings.Join(wantCreated, ",") {
		t.Fatalf("created = %v, want %v", result.Created, wantCreated)
	}
	if len(result.Existing) != 0 {
		t.Fatalf("existing = %v, want none", result.Existing)
	}
	if strings.Join(result.DirectoriesCreated, ",") != "agent/,agent/sessions/" {
		t.Fatalf("directories_created = %v", result.DirectoriesCreated)
	}
	for _, rel := range wantCreated {
		path := filepath.Join(dataDir, rel)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", rel, err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", rel, info.Mode().Perm())
		}
	}
	persona, err := os.ReadFile(filepath.Join(dataDir, "agent", "persona.md"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := agent.FS.ReadFile("templates/private/persona.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(persona) != string(want) {
		t.Fatal("persona.md does not match the embedded template")
	}
	info, err := os.Stat(filepath.Join(dataDir, "agent", "sessions"))
	if err != nil || !info.IsDir() {
		t.Fatalf("agent/sessions is not a directory: %v", err)
	}
}

func TestInitAgentDataIsIdempotentAndNeverOverwrites(t *testing.T) {
	dataDir := t.TempDir()
	writeTestNodeIdentity(t, dataDir)
	if err := os.MkdirAll(filepath.Join(dataDir, "agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	custom := []byte("my existing persona\n")
	if err := os.WriteFile(filepath.Join(dataDir, "agent", "persona.md"), custom, 0o600); err != nil {
		t.Fatal(err)
	}

	first, err := initAgentData(dataDir)
	if err != nil {
		t.Fatalf("first init: %v", err)
	}
	if len(first.Created) != 2 {
		t.Fatalf("first created = %v, want growth+contact-notes", first.Created)
	}
	if strings.Join(first.Existing, ",") != "agent/persona.md" {
		t.Fatalf("first existing = %v", first.Existing)
	}
	content, err := os.ReadFile(filepath.Join(dataDir, "agent", "persona.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(custom) {
		t.Fatalf("existing persona was overwritten: %q", content)
	}

	second, err := initAgentData(dataDir)
	if err != nil {
		t.Fatalf("second init: %v", err)
	}
	if len(second.Created) != 0 {
		t.Fatalf("second created = %v, want none", second.Created)
	}
	if len(second.Existing) != 3 {
		t.Fatalf("second existing = %v, want all three", second.Existing)
	}
	content, err = os.ReadFile(filepath.Join(dataDir, "agent", "persona.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(custom) {
		t.Fatalf("second init overwrote persona: %q", content)
	}
}

func TestInitAgentDataRejectsSymlinkedAgentDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs extra privileges on Windows")
	}
	dataDir := t.TempDir()
	writeTestNodeIdentity(t, dataDir)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dataDir, "agent")); err != nil {
		t.Fatal(err)
	}
	if _, err := initAgentData(dataDir); err == nil {
		t.Fatal("initAgentData must refuse a symlinked agent directory")
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("init wrote outside the data directory: %v", entries)
	}
}

func TestSafeAgentPathRejectsEscapes(t *testing.T) {
	dataDir := t.TempDir()
	for _, rel := range []string{"../escape", "agent/../../escape", "/absolute", ""} {
		if _, err := safeAgentPath(dataDir, rel); err == nil {
			t.Errorf("safeAgentPath(%q) unexpectedly succeeded", rel)
		}
	}
	if _, err := safeAgentPath(dataDir, "agent/persona.md"); err != nil {
		t.Fatalf("safeAgentPath(valid): %v", err)
	}
}

func TestInitAgentDataRequiresNodeIdentity(t *testing.T) {
	t.Run("missing data directory is not created", func(t *testing.T) {
		dataDir := filepath.Join(t.TempDir(), "not-initialized")
		if _, err := initAgentData(dataDir); err == nil {
			t.Fatal("initAgentData must refuse a data directory without identity/key")
		} else if !strings.Contains(err.Error(), "identity/key") || !strings.Contains(err.Error(), "raminga_status") {
			t.Fatalf("error is not actionable: %v", err)
		}
		if _, err := os.Stat(dataDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("data directory was created: %v", err)
		}
	})

	t.Run("existing empty directory is left untouched", func(t *testing.T) {
		dataDir := t.TempDir()
		if _, err := initAgentData(dataDir); err == nil {
			t.Fatal("initAgentData must refuse a data directory without identity/key")
		}
		entries, err := os.ReadDir(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("init created entries in a node-less data directory: %v", entries)
		}
	})

	t.Run("existing agent directory is not populated", func(t *testing.T) {
		dataDir := t.TempDir()
		agentDir := filepath.Join(dataDir, "agent")
		if err := os.Mkdir(agentDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := initAgentData(dataDir); err == nil {
			t.Fatal("initAgentData must refuse a data directory without identity/key")
		}
		entries, err := os.ReadDir(agentDir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("init wrote into agent/ without a node identity: %v", entries)
		}
		if _, err := os.Stat(filepath.Join(dataDir, "identity")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("init created an identity directory: %v", err)
		}
	})
}

func TestAgentInitToolThroughMCP(t *testing.T) {
	srv, dataDir := newTestServerWithDir(t)
	writeTestNodeIdentity(t, dataDir)
	text, isErr := drive(t, srv, "raminga_agent_init", map[string]any{})
	if isErr {
		t.Fatalf("raminga_agent_init returned an error: %s", text)
	}
	var result agentInitResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatalf("decode result: %v\n%s", err, text)
	}
	if len(result.Created) != 3 {
		t.Fatalf("created = %v, want three files", result.Created)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent", "persona.md")); err != nil {
		t.Fatalf("persona.md not created: %v", err)
	}
	if runtime.GOOS != "windows" {
		for _, rel := range []string{"agent", filepath.Join("agent", "sessions")} {
			info, err := os.Stat(filepath.Join(dataDir, rel))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o700 {
				t.Errorf("%s mode = %o, want 700", rel, info.Mode().Perm())
			}
		}
		for _, rel := range []string{"agent/persona.md", "agent/growth.md", "agent/contact-notes.json"} {
			info, err := os.Stat(filepath.Join(dataDir, filepath.FromSlash(rel)))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Errorf("%s mode = %o, want 600", rel, info.Mode().Perm())
			}
		}
	}

	// A second call must report existing files and leave contents untouched.
	if err := os.WriteFile(filepath.Join(dataDir, "agent", "persona.md"), []byte("kept\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	text, isErr = drive(t, srv, "raminga_agent_init", map[string]any{})
	if isErr {
		t.Fatalf("second raminga_agent_init returned an error: %s", text)
	}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Created) != 0 || len(result.Existing) != 3 {
		t.Fatalf("second result = created %v existing %v", result.Created, result.Existing)
	}
	content, err := os.ReadFile(filepath.Join(dataDir, "agent", "persona.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "kept\n" {
		t.Fatalf("second call overwrote persona: %q", content)
	}
}

func TestAgentInitToolRequiresNodeIdentity(t *testing.T) {
	srv, dataDir := newTestServerWithDir(t)
	text, isErr := drive(t, srv, "raminga_agent_init", map[string]any{})
	if !isErr {
		t.Fatalf("raminga_agent_init must fail without identity/key, got %q", text)
	}
	if !strings.Contains(text, "identity/key") || !strings.Contains(text, "raminga_status") {
		t.Fatalf("tool error is not actionable: %q", text)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tool created agent/ without a node identity: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "identity")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tool created identity/ without a node identity: %v", err)
	}
}

func TestCatalogToolsAreAutoPermitted(t *testing.T) {
	catalog, err := agent.ToolCatalog()
	if err != nil {
		t.Fatalf("ToolCatalog: %v", err)
	}
	for _, tool := range catalog.Tools {
		if tool.Permission != agent.PermissionAuto {
			t.Errorf("%s permission = %q, want auto", tool.Name, tool.Permission)
		}
	}
}

func TestMCPAnnotations(t *testing.T) {
	srv := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ct, st := sdkmcp.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer func() { _ = ss.Close() }()
	c := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := c.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	listed, err := cs.ListTools(ctx, &sdkmcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	type want struct{ readOnly, openWorld bool }
	wants := map[string]want{
		"raminga_status":         {true, false},
		"raminga_friends":        {true, false},
		"raminga_published":      {true, false},
		"raminga_peer_profile":   {true, true},
		"raminga_peer_manifest":  {true, true},
		"raminga_peer_friends":   {true, true},
		"raminga_content_get":    {false, true},
		"raminga_connect":        {false, true},
		"raminga_connect_listed": {false, true},
		"raminga_chat_send":      {false, true},
		"raminga_chat_history":   {true, false},
		"raminga_agent_init":     {false, false},
	}
	if len(listed.Tools) != len(wants) {
		t.Fatalf("got %d tools, want %d", len(listed.Tools), len(wants))
	}
	for _, tool := range listed.Tools {
		w, ok := wants[tool.Name]
		if !ok {
			t.Fatalf("unexpected tool %q", tool.Name)
		}
		if tool.Annotations == nil {
			t.Fatalf("%s has no annotations", tool.Name)
		}
		if tool.Annotations.ReadOnlyHint != w.readOnly {
			t.Errorf("%s readOnlyHint = %v, want %v", tool.Name, tool.Annotations.ReadOnlyHint, w.readOnly)
		}
		if tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint != w.openWorld {
			t.Errorf("%s openWorldHint = %v, want %v", tool.Name, tool.Annotations.OpenWorldHint, w.openWorld)
		}
		if !w.readOnly && (tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint) {
			t.Errorf("%s destructiveHint must be explicitly false", tool.Name)
		}
	}
}
