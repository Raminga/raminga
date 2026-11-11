// Command e2e-plugins is the repeatable MCP smoke test for the plugin shells.
//
// It starts the committed Claude Code launcher through `sh`, with
// RAMINGA_BIN pointing at the locally built binary, and speaks MCP over stdio.
// Every scenario uses a temporary HOME/RAMINGA_DATA_DIR and stops the daemon
// it started before returning. Scenarios 1 and 3 pre-write loopback-only
// configs with system-assigned ports; scenario 2 needs the default config and
// is skipped when TCP/UDP 4001 is already in use, so no smoke daemon shares a
// real node's public port. Run it after `make build`:
//
//	make e2e-plugins
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	ma "github.com/multiformats/go-multiaddr"

	"github.com/Raminga/raminga/agent"
	"github.com/Raminga/raminga/internal/config"
	"github.com/Raminga/raminga/internal/identity"
)

const (
	daemonStopTimeout = 20 * time.Second
	scenarioTimeout   = 2 * time.Minute

	defaultListenPort  = "4001"
	skipDefaultPortMsg = "本机已有进程占用 4001，跳过默认端口场景以免与真实节点共用端口"
	loopbackTCPListen  = "/ip4/127.0.0.1/tcp/0"
	loopbackQUICListen = "/ip4/127.0.0.1/udp/0/quic-v1"
)

type runner struct {
	root     string
	bin      string
	launcher string
}

// lockedBuffer collects child stderr while the MCP client reads it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func main() {
	root := flag.String("root", ".", "repository root")
	flag.Parse()

	abs, err := filepath.Abs(*root)
	if err != nil {
		fatalf(fmt.Errorf("resolve root: %w", err))
	}
	r := runner{
		root:     abs,
		bin:      filepath.Join(abs, "bin", "raminga"),
		launcher: filepath.Join(abs, "plugins", "claude", "bin", "raminga-launcher.sh"),
	}
	if info, err := os.Stat(r.bin); err != nil || info.IsDir() {
		fatalf(fmt.Errorf("missing %s; run `make build` first", r.bin))
	}
	if info, err := os.Stat(r.launcher); err != nil || info.IsDir() {
		fatalf(fmt.Errorf("missing launcher %s", r.launcher))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*scenarioTimeout)
	defer cancel()

	if err := r.scenarioMCP(ctx); err != nil {
		fatalf(fmt.Errorf("scenario 1 (MCP tools/init): %w", err))
	}
	cacheSkipped, err := r.scenarioLauncherCache(ctx)
	if err != nil {
		fatalf(fmt.Errorf("scenario 2 (only ~/.raminga/bin): %w", err))
	}
	if err := r.scenarioNoIdentity(ctx); err != nil {
		fatalf(fmt.Errorf("scenario 3 (agent_init without identity): %w", err))
	}
	if err := r.scenarioAgentSendGuard(ctx); err != nil {
		fatalf(fmt.Errorf("scenario 4 (agent-origin send guard): %w", err))
	}
	if cacheSkipped {
		fmt.Println("e2e-plugins: PASS (scenario 2 SKIPPED: port 4001 in use)")
		return
	}
	fmt.Println("e2e-plugins: PASS")
}

// scenarioMCP walks initialize -> tools/list -> status -> first/second
// agent_init over the committed launcher and an explicit RAMINGA_DATA_DIR.
func (r runner) scenarioMCP(parent context.Context) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, scenarioTimeout)
	defer cancel()

	home, err := os.MkdirTemp("", "raminga-e2e-plugins-mcp-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(home) }()
	dataDir := filepath.Join(home, "data")
	if err := writeLoopbackConfig(dataDir); err != nil {
		return err
	}
	var session *sdkmcp.ClientSession
	defer func() {
		if session != nil {
			_ = session.Close()
		}
		if err := stopDaemon(r.bin, home, dataDir); err != nil {
			retErr = errors.Join(retErr, err)
		}
	}()

	session, stderr, err := r.startMCP(ctx, home, dataDir)
	if err != nil {
		return fmt.Errorf("start MCP: %w (stderr: %s)", err, stderr)
	}

	init := session.InitializeResult()
	if init == nil || init.ServerInfo == nil {
		return errors.New("initialize returned no server info")
	}
	fmt.Printf("initialize: protocol=%s server=%s/%s\n",
		init.ProtocolVersion, init.ServerInfo.Name, init.ServerInfo.Version)

	tools, err := session.ListTools(ctx, &sdkmcp.ListToolsParams{})
	if err != nil {
		return fmt.Errorf("tools/list: %w", err)
	}
	if err := checkToolCatalog(tools.Tools); err != nil {
		return err
	}
	fmt.Printf("tools/list: %d tools, all agent/tools.yaml entries present\n", len(tools.Tools))

	statusText, isErr, err := callTool(ctx, session, "raminga_status", map[string]any{})
	if err != nil {
		return fmt.Errorf("raminga_status: %w", err)
	}
	if isErr {
		return fmt.Errorf("raminga_status returned an error: %s", statusText)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(statusText), &status); err != nil {
		return fmt.Errorf("decode raminga_status: %w\n%s", err, statusText)
	}
	peerID, _ := status["peer_id"].(string)
	if peerID == "" {
		return fmt.Errorf("raminga_status returned no peer_id: %s", statusText)
	}
	if got, _ := status["api_version"].(string); got != "2" {
		return fmt.Errorf("raminga_status api_version = %q, want 2", got)
	}
	if err := checkLoopbackListenAddrs(status["listen_addrs"]); err != nil {
		return err
	}
	if err := requireRegularFile(filepath.Join(dataDir, "identity", "key")); err != nil {
		return fmt.Errorf("node identity was not created: %w", err)
	}
	fmt.Printf("raminga_status: peer_id=%s api_version=2 listen_addrs=%v\n",
		peerID, status["listen_addrs"])

	first, err := callAgentInit(ctx, session)
	if err != nil {
		return err
	}
	if len(first.Created) != 3 || len(first.Existing) != 0 {
		return fmt.Errorf("first agent_init = created %v existing %v, want 3 created / 0 existing", first.Created, first.Existing)
	}
	persona := filepath.Join(dataDir, "agent", "persona.md")
	if err := os.WriteFile(persona, []byte("custom persona\n"), 0o600); err != nil {
		return err
	}
	second, err := callAgentInit(ctx, session)
	if err != nil {
		return err
	}
	if len(second.Created) != 0 || len(second.Existing) != 3 {
		return fmt.Errorf("second agent_init = created %v existing %v, want 0 created / 3 existing", second.Created, second.Existing)
	}
	content, err := os.ReadFile(persona)
	if err != nil {
		return err
	}
	if string(content) != "custom persona\n" {
		return fmt.Errorf("second agent_init overwrote persona: %q", content)
	}
	fmt.Printf("raminga_agent_init: first created=%v, second created=%v existing=%d (persona preserved)\n",
		first.Created, second.Created, len(second.Existing))

	return nil
}

// scenarioLauncherCache reproduces the first-use bug: ~/.raminga contains only
// the launcher's bin/ cache. The default data directory must auto-initialize.
//
// This scenario needs the default config, so it cannot pre-write a loopback
// config. A plain bind (never SO_REUSEPORT) on TCP/UDP 4001 first detects a
// real local node; in that case the scenario is skipped rather than sharing
// the public port.
func (r runner) scenarioLauncherCache(parent context.Context) (bool, error) {
	if busy, detail := port4001InUse(); busy {
		fmt.Printf("scenario 2 (only ~/.raminga/bin): SKIP: %s\n", skipDefaultPortMsg)
		if detail != "" {
			fmt.Printf("  port probe: %s\n", detail)
		}
		return true, nil
	}
	return false, r.runLauncherCache(parent)
}

func (r runner) runLauncherCache(parent context.Context) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, scenarioTimeout)
	defer cancel()

	home, err := os.MkdirTemp("", "raminga-e2e-plugins-cache-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(home) }()
	dataDir := filepath.Join(home, ".raminga")
	if err := os.MkdirAll(filepath.Join(dataDir, "bin", "0.1.0"), 0o700); err != nil {
		return err
	}
	var session *sdkmcp.ClientSession
	defer func() {
		if session != nil {
			_ = session.Close()
		}
		if err := stopDaemon(r.bin, home, dataDir); err != nil {
			retErr = errors.Join(retErr, err)
		}
	}()

	// No RAMINGA_DATA_DIR: the launcher/mcp must use the default ~/.raminga.
	session, stderr, err := r.startMCP(ctx, home, "")
	if err != nil {
		return fmt.Errorf("start MCP: %w (stderr: %s)", err, stderr)
	}

	if strings.Contains(stderr, "疑似旧版或非 Raminga 数据目录") {
		return fmt.Errorf("mcp rejected a directory containing only bin/: %s", stderr)
	}

	statusText, isErr, err := callTool(ctx, session, "raminga_status", map[string]any{})
	if err != nil {
		return fmt.Errorf("raminga_status: %w", err)
	}
	if isErr {
		return fmt.Errorf("raminga_status returned an error: %s", statusText)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(statusText), &status); err != nil {
		return fmt.Errorf("decode raminga_status: %w", err)
	}
	got, _ := status["data_dir"].(string)
	if !samePath(got, dataDir) {
		return fmt.Errorf("status data_dir = %q, want %q", got, dataDir)
	}
	if err := requireRegularFile(filepath.Join(dataDir, "identity", "key")); err != nil {
		return fmt.Errorf("default data directory was not initialized: %w", err)
	}
	fmt.Printf("default data dir: only bin/ present, auto-initialized at %s\n", got)

	init, err := callAgentInit(ctx, session)
	if err != nil {
		return err
	}
	if len(init.Created) != 3 {
		return fmt.Errorf("agent_init after auto-init created %v, want 3 files", init.Created)
	}
	fmt.Printf("default data dir: agent_init created=%v\n", init.Created)

	return nil
}

// scenarioNoIdentity calls raminga_agent_init against a node-less directory
// that already contains agent/. The tool must refuse and create nothing.
//
// The directory gets a loopback-only config too, so any daemon that mcp might
// start would not bind 4001. To keep the target node-less, a real identity is
// seeded in the documented legacy sibling path: mcp's existing
// otherNodeDataDirs guard then refuses to mint a second identity instead of
// starting a daemon.
func (r runner) scenarioNoIdentity(parent context.Context) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, scenarioTimeout)
	defer cancel()

	home, err := os.MkdirTemp("", "raminga-e2e-plugins-noidentity-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(home) }()
	dataDir := filepath.Join(home, ".raminga")
	agentDir := filepath.Join(dataDir, "agent")
	if err := writeLoopbackConfig(dataDir); err != nil {
		return err
	}
	if err := os.MkdirAll(agentDir, 0o700); err != nil {
		return err
	}
	if err := seedOtherNodeIdentity(filepath.Join(dataDir, "raminga-test")); err != nil {
		return fmt.Errorf("seed other node identity: %w", err)
	}
	var session *sdkmcp.ClientSession
	defer func() {
		if session != nil {
			_ = session.Close()
		}
		if err := stopDaemon(r.bin, home, dataDir); err != nil {
			retErr = errors.Join(retErr, err)
		}
	}()

	session, stderr, err := r.startMCP(ctx, home, "")
	if err != nil {
		return fmt.Errorf("start MCP: %w (stderr: %s)", err, stderr)
	}

	if !strings.Contains(stderr, "检测到其他位置已有 Raminga 节点") {
		return fmt.Errorf("mcp did not report the existing other node: %s", stderr)
	}

	text, isErr, err := callTool(ctx, session, "raminga_agent_init", map[string]any{})
	if err != nil {
		return fmt.Errorf("raminga_agent_init: %w", err)
	}
	if !isErr {
		return fmt.Errorf("raminga_agent_init unexpectedly succeeded: %s", text)
	}
	if !strings.Contains(text, "identity/key") || !strings.Contains(text, "raminga_status") {
		return fmt.Errorf("agent_init error is not actionable: %s", text)
	}
	entries, err := os.ReadDir(agentDir)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("agent_init created files without identity: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "identity")); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("agent_init created identity/: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "config.toml")); err != nil {
		return fmt.Errorf("agent_init removed config.toml: %v", err)
	}
	fmt.Printf("no identity: raminga_agent_init rejected with %q; no files created\n", firstLine(text))

	return nil
}

// scenarioAgentSendGuard proves the MCP shell sets agent_origin and that the
// daemon rejects private-data leaks before delivery while normal short chat is
// still delivered. Two temporary loopback nodes are connected inside this
// scenario; no real node or default port is touched.
func (r runner) scenarioAgentSendGuard(parent context.Context) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, scenarioTimeout)
	defer cancel()

	home, err := os.MkdirTemp("", "raminga-e2e-plugins-guard-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(home) }()
	dirA := filepath.Join(home, "node-a")
	dirB := filepath.Join(home, "node-b")
	for _, dir := range []string{dirA, dirB} {
		if err := writeLoopbackConfig(dir); err != nil {
			return err
		}
	}

	var sessionA, sessionB *sdkmcp.ClientSession
	defer func() {
		if sessionA != nil {
			_ = sessionA.Close()
		}
		if sessionB != nil {
			_ = sessionB.Close()
		}
		if err := stopDaemon(r.bin, home, dirA); err != nil {
			retErr = errors.Join(retErr, err)
		}
		if err := stopDaemon(r.bin, home, dirB); err != nil {
			retErr = errors.Join(retErr, err)
		}
	}()

	var stderr string
	sessionA, stderr, err = r.startMCP(ctx, home, dirA)
	if err != nil {
		return fmt.Errorf("start MCP A: %w (stderr: %s)", err, stderr)
	}
	sessionB, stderr, err = r.startMCP(ctx, home, dirB)
	if err != nil {
		return fmt.Errorf("start MCP B: %w (stderr: %s)", err, stderr)
	}

	statusB, err := statusOf(ctx, sessionB)
	if err != nil {
		return fmt.Errorf("status B: %w", err)
	}
	peerB, _ := statusB["peer_id"].(string)
	if peerB == "" {
		return fmt.Errorf("status B has no peer_id: %v", statusB)
	}
	listenAddr, err := firstTCPListenAddr(statusB["listen_addrs"])
	if err != nil {
		return fmt.Errorf("status B: %w", err)
	}
	if _, err := statusOf(ctx, sessionA); err != nil {
		return fmt.Errorf("status A: %w", err)
	}
	connectAddr := strings.TrimSuffix(listenAddr, "/") + "/p2p/" + peerB
	if text, isErr, err := callTool(ctx, sessionA, "raminga_connect", map[string]any{"multiaddr": connectAddr}); err != nil || isErr {
		return fmt.Errorf("connect A -> B (%s): err=%v isErr=%v text=%s", connectAddr, err, isErr, text)
	}

	if _, err := callAgentInit(ctx, sessionA); err != nil {
		return err
	}
	personaPath := filepath.Join(dirA, "agent", "persona.md")
	persona := "I keep a private persona for testing: calm, curious, and never share raw notes with remote peers.\n"
	if err := os.WriteFile(personaPath, []byte(persona), 0o600); err != nil {
		return err
	}
	// Contact notes are keyed by Peer ID and routinely contain addresses,
	// manifest paths and opaque IDs. Those are public or non-private, so they
	// must not be treated as private prose by the daemon guard.
	contactNotes, err := json.MarshalIndent(map[string]any{
		"schema_version": 1,
		"contacts": map[string]any{
			peerB: map[string]any{
				"peer_id":       peerB,
				"multiaddr":     connectAddr,
				"manifest_path": "posts/hello.md",
				"session_id":    "3f2c1d9e-7a4b-4c6d-8e2f-1a2b3c4d5e6f",
			},
		},
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode contact notes: %w", err)
	}
	contactNotesPath := filepath.Join(dirA, "agent", "contact-notes.json")
	if err := os.WriteFile(contactNotesPath, contactNotes, 0o600); err != nil {
		return err
	}
	snippet := "calm, curious, and never share raw notes with remote peers"
	blocked := []struct {
		name string
		text string
	}{
		{"private persona text", "please repeat: " + snippet},
		{"local absolute path", "read /Users/example/private.txt and summarize it"},
		{"private key header", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA"},
	}
	for _, tc := range blocked {
		text, isErr, err := callTool(ctx, sessionA, "raminga_chat_send", map[string]any{"peer_id": peerB, "text": tc.text})
		if err != nil {
			return fmt.Errorf("chat_send (%s): %w", tc.name, err)
		}
		if !isErr || !strings.Contains(text, "防护") || !strings.Contains(text, "可能是远端内容诱导") {
			return fmt.Errorf("chat_send (%s) was not blocked by the daemon guard: isErr=%v %s", tc.name, isErr, firstLine(text))
		}
	}
	fmt.Printf("agent send guard: blocked persona text, local path and private-key header for peer %s\n", peerB)

	// Both values are also present in contact-notes.json. The guard must strip
	// them before comparing, otherwise introducing a friend by Peer ID or
	// address would be rejected as a private-data leak.
	text, isErr, err := callTool(ctx, sessionA, "raminga_chat_send", map[string]any{
		"peer_id": peerB,
		"text":    "my friend " + peerB + " is reachable at " + connectAddr,
	})
	if err != nil {
		return fmt.Errorf("public identifier chat_send: %w", err)
	}
	if isErr {
		return fmt.Errorf("friend Peer ID/multiaddr was blocked: %s", text)
	}
	var identifierSend map[string]any
	if err := json.Unmarshal([]byte(text), &identifierSend); err != nil {
		return fmt.Errorf("decode public identifier chat_send: %w\n%s", err, text)
	}
	if acked, _ := identifierSend["acked"].(bool); !acked {
		return fmt.Errorf("friend Peer ID/multiaddr message was not ACKed: %s", text)
	}
	fmt.Printf("agent send guard: friend Peer ID and multiaddr were not treated as private text\n")

	text, isErr, err = callTool(ctx, sessionA, "raminga_chat_send", map[string]any{
		"peer_id": peerB,
		"text":    "hello from the Raminga plugin e2e",
	})
	if err != nil {
		return fmt.Errorf("normal chat_send: %w", err)
	}
	if isErr {
		return fmt.Errorf("normal short message was blocked: %s", text)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(text), &sent); err != nil {
		return fmt.Errorf("decode normal chat_send: %w\n%s", err, text)
	}
	if acked, _ := sent["acked"].(bool); !acked {
		return fmt.Errorf("normal short message was not ACKed: %s", text)
	}
	fmt.Printf("agent send guard: normal short message delivered and ACKed\n")
	return nil
}

func statusOf(ctx context.Context, session *sdkmcp.ClientSession) (map[string]any, error) {
	text, isErr, err := callTool(ctx, session, "raminga_status", map[string]any{})
	if err != nil {
		return nil, err
	}
	if isErr {
		return nil, fmt.Errorf("raminga_status error: %s", text)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(text), &status); err != nil {
		return nil, fmt.Errorf("decode raminga_status: %w\n%s", err, text)
	}
	return status, nil
}

func firstTCPListenAddr(value any) (string, error) {
	addrs, ok := value.([]any)
	if !ok || len(addrs) == 0 {
		return "", fmt.Errorf("no listen_addrs: %v", value)
	}
	for _, item := range addrs {
		raw, ok := item.(string)
		if !ok {
			continue
		}
		addr, err := ma.NewMultiaddr(raw)
		if err != nil {
			continue
		}
		if _, err := addr.ValueForProtocol(ma.P_TCP); err == nil {
			return raw, nil
		}
	}
	return "", fmt.Errorf("no TCP listen address in %v", value)
}

func seedOtherNodeIdentity(dir string) error {
	id, err := identity.Open(dir)
	if err != nil {
		return err
	}
	return id.Close()
}

type agentInitResult struct {
	Created            []string `json:"created"`
	Existing           []string `json:"existing"`
	DirectoriesCreated []string `json:"directories_created"`
}

func callAgentInit(ctx context.Context, session *sdkmcp.ClientSession) (agentInitResult, error) {
	text, isErr, err := callTool(ctx, session, "raminga_agent_init", map[string]any{})
	if err != nil {
		return agentInitResult{}, fmt.Errorf("raminga_agent_init: %w", err)
	}
	if isErr {
		return agentInitResult{}, fmt.Errorf("raminga_agent_init returned an error: %s", text)
	}
	var result agentInitResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return agentInitResult{}, fmt.Errorf("decode raminga_agent_init: %w\n%s", err, text)
	}
	return result, nil
}

func callTool(ctx context.Context, session *sdkmcp.ClientSession, name string, args any) (string, bool, error) {
	res, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return "", false, err
	}
	var b strings.Builder
	for _, content := range res.Content {
		if text, ok := content.(*sdkmcp.TextContent); ok {
			b.WriteString(text.Text)
		}
	}
	return b.String(), res.IsError, nil
}

func checkToolCatalog(got []*sdkmcp.Tool) error {
	catalog, err := agent.ToolCatalog()
	if err != nil {
		return err
	}
	want := make(map[string]bool, len(catalog.Tools))
	for _, tool := range catalog.Tools {
		want[tool.Name] = true
	}
	seen := make(map[string]bool, len(got))
	for _, tool := range got {
		seen[tool.Name] = true
	}
	for name := range want {
		if !seen[name] {
			return fmt.Errorf("tools/list is missing %q", name)
		}
	}
	if len(got) != len(want) {
		return fmt.Errorf("tools/list returned %d tools, agent/tools.yaml has %d", len(got), len(want))
	}
	return nil
}

// startMCP launches the committed launcher with RAMINGA_BIN and connects an
// MCP client. dataDir may be empty to exercise the default ~/.raminga path.
func (r runner) startMCP(ctx context.Context, home, dataDir string) (*sdkmcp.ClientSession, string, error) {
	cmd := exec.Command("sh", r.launcher, "mcp")
	cmd.Dir = r.root
	cmd.Env = cleanEnv(home, dataDir, r.bin)
	stderr := &lockedBuffer{}
	cmd.Stderr = stderr

	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "raminga-e2e-plugins", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdkmcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		return nil, stderr.String(), err
	}
	return session, stderr.String(), nil
}

// cleanEnv removes every ambient HOME/data-dir override and adds the scenario
// values. No real ~/.raminga or ~/.dsh is ever used.
func cleanEnv(home, dataDir, bin string) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		switch key {
		case "HOME", "RAMINGA_DATA_DIR", "RAMINGA_BIN", "DSH_HOME":
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "HOME="+home)
	if dataDir != "" {
		env = append(env, "RAMINGA_DATA_DIR="+dataDir)
	}
	if bin != "" {
		env = append(env, "RAMINGA_BIN="+bin)
	}
	return env
}

// stopDaemon stops the daemon for this data directory. A daemon that was never
// started is not an error (`raminga stop` prints 节点未运行 and exits 0).
func stopDaemon(bin, home, dataDir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), daemonStopTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "stop", "--data-dir", dataDir)
	cmd.Env = cleanEnv(home, dataDir, "")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("stop daemon for %s: %w (%s)", dataDir, err, strings.TrimSpace(string(out)))
	}
	fmt.Printf("stop: %s\n", strings.TrimSpace(string(out)))
	return nil
}

// writeLoopbackConfig writes a validated config.toml that listens only on
// loopback addresses with system-assigned ports. It uses internal/config's
// real structs and RenderTOML so field names and validation cannot drift.
// Bootstrap, relay, DHT, AutoNAT and hole punching are all left unconfigured
// or disabled: these smoke nodes must not make outbound peer connections.
func writeLoopbackConfig(dataDir string) error {
	cfg := config.Default()
	cfg.Network.ListenAddrs = []string{loopbackTCPListen, loopbackQUICListen}
	cfg.Network.AnnounceAddrs = nil
	cfg.Network.EnableDCUtR = false
	cfg.Network.EnableRelayClient = false
	cfg.Network.EnableAutoRelay = false
	cfg.Relay.Provider = false
	cfg.Relay.KnownRelays = nil
	cfg.DHT.Enabled = false
	cfg.DHT.BootstrapPeers = nil
	cfg.AutoNAT.Enabled = false

	raw, err := config.RenderTOML(cfg)
	if err != nil {
		return fmt.Errorf("render loopback config: %w", err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}
	if err := os.WriteFile(config.Path(dataDir), raw, 0o600); err != nil {
		return fmt.Errorf("write loopback config: %w", err)
	}
	return nil
}

// port4001InUse probes TCP and UDP 4001 with ordinary listeners. It never
// sets SO_REUSEPORT, unlike go-libp2p, so an existing real node makes the bind
// fail even though the test daemon could otherwise share the port.
func port4001InUse() (bool, string) {
	probes := []struct {
		network string
		address string
	}{
		{"tcp4", "0.0.0.0:" + defaultListenPort},
		{"tcp6", "[::]:" + defaultListenPort},
		{"udp4", "0.0.0.0:" + defaultListenPort},
		{"udp6", "[::]:" + defaultListenPort},
	}
	var busy []string
	for _, probe := range probes {
		var err error
		if strings.HasPrefix(probe.network, "tcp") {
			var ln net.Listener
			ln, err = net.Listen(probe.network, probe.address)
			if err == nil {
				_ = ln.Close()
			}
		} else {
			var pc net.PacketConn
			pc, err = net.ListenPacket(probe.network, probe.address)
			if err == nil {
				_ = pc.Close()
			}
		}
		if errors.Is(err, syscall.EADDRINUSE) {
			busy = append(busy, fmt.Sprintf("%s %s: %v", probe.network, probe.address, err))
		}
		// Other errors (for example an unavailable IPv6 stack) do not prove
		// that the port is occupied, so keep probing.
	}
	if len(busy) > 0 {
		return true, strings.Join(busy, "; ")
	}
	return false, ""
}

// checkLoopbackListenAddrs asserts the daemon reports only loopback listeners
// on system-assigned ports. Port 4001 is explicitly rejected.
func checkLoopbackListenAddrs(value any) error {
	addrs, ok := value.([]any)
	if !ok || len(addrs) == 0 {
		return fmt.Errorf("raminga_status returned no listen_addrs: %v", value)
	}
	for _, item := range addrs {
		raw, ok := item.(string)
		if !ok {
			return fmt.Errorf("listen_addrs contains %T, want string", item)
		}
		addr, err := ma.NewMultiaddr(raw)
		if err != nil {
			return fmt.Errorf("invalid listen address %q: %w", raw, err)
		}
		ip4, err4 := addr.ValueForProtocol(ma.P_IP4)
		ip6, err6 := addr.ValueForProtocol(ma.P_IP6)
		if (err4 != nil || ip4 != "127.0.0.1") && (err6 != nil || ip6 != "::1") {
			return fmt.Errorf("listen address %q is not loopback", raw)
		}
		port, err := addr.ValueForProtocol(ma.P_TCP)
		if err != nil {
			port, err = addr.ValueForProtocol(ma.P_UDP)
		}
		if err != nil {
			return fmt.Errorf("listen address %q has no TCP or UDP port", raw)
		}
		if port == defaultListenPort || port == "0" {
			return fmt.Errorf("listen address %q uses port %s", raw, port)
		}
	}
	return nil
}

func requireRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	return nil
}

func samePath(a, b string) bool {
	if a == "" {
		return false
	}
	ra, err := filepath.EvalSymlinks(a)
	if err != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	rb, err := filepath.EvalSymlinks(b)
	if err != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

func firstLine(s string) string {
	if line, _, ok := strings.Cut(strings.TrimSpace(s), "\n"); ok {
		return line
	}
	return strings.TrimSpace(s)
}

func fatalf(err error) {
	fmt.Fprintf(os.Stderr, "e2e-plugins: FAIL: %v\n", err)
	os.Exit(1)
}
