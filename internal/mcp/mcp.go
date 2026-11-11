// Package mcp exposes the local Raminga API as a stdio MCP server
// (the `raminga mcp` subcommand). It is stateless: every tool call goes
// through the existing Connect-RPC client to the daemon, and the tool catalog
// comes from the embedded single source (agent/tools.yaml).
//
// stdout carries the MCP JSON-RPC protocol, so the server never writes
// anything but protocol frames to stdout; all diagnostics go to stderr (or the
// configured *slog.Logger).
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/Raminga/raminga/agent"
	apiv1 "github.com/Raminga/raminga/gen/raminga/api/v1"
	"github.com/Raminga/raminga/internal/api"
	"github.com/Raminga/raminga/internal/api/client"
	"github.com/Raminga/raminga/internal/untrusted"
)

// statusTimeout bounds the api_version handshake on first use.
const statusTimeout = 5 * time.Second

// Server builds tool handlers against one daemon's data directory.
type Server struct {
	dataDir string
	version string
	log     *slog.Logger

	mu      sync.Mutex
	conn    *client.Client
	checked bool
	// ensureDaemon, when set, starts the daemon lazily on the first tool call.
	// It is deliberately not called during MCP initialization: hosts impose a
	// short handshake timeout, while the first daemon start may take longer.
	ensureDaemon func(ctx context.Context) error
}

// Option configures a Server.
type Option func(*Server)

// WithDaemonStarter defers daemon startup until the first tool call. The MCP
// handshake then completes immediately even when the first node start is slow.
func WithDaemonStarter(fn func(ctx context.Context) error) Option {
	return func(s *Server) { s.ensureDaemon = fn }
}

// New registers every tool in the embedded catalog and returns an MCP server.
// The returned server does not start a transport; Run or a caller-provided
// transport does.
func New(dataDir, version string, log *slog.Logger, opts ...Option) (*sdkmcp.Server, error) {
	catalog, err := agent.ToolCatalog()
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	s := &Server{dataDir: dataDir, version: version, log: log}
	for _, opt := range opts {
		opt(s)
	}
	impl := &sdkmcp.Implementation{
		Name:        "raminga",
		Title:       "Raminga",
		Version:     version,
		Description: "Local Raminga node tools (status, contacts, content, chat) over the daemon's Unix-socket API.",
	}
	server := sdkmcp.NewServer(impl, &sdkmcp.ServerOptions{Logger: log})
	for _, t := range catalog.Tools {
		tool := t
		readOnly := tool.IsReadOnly()
		openWorld := tool.IsOpenWorld()
		annotations := &sdkmcp.ToolAnnotations{
			Title:        tool.Summary,
			ReadOnlyHint: readOnly,
			// The MCP Go SDK v1.8.0 models OpenWorldHint as *bool so the server
			// can emit an explicit false instead of relying on the client default.
			OpenWorldHint: &openWorld,
		}
		if readOnly {
			annotations.IdempotentHint = true
		} else {
			// Connect, send and local writes are additive, not destructive.
			destructive := false
			annotations.DestructiveHint = &destructive
		}
		mt := &sdkmcp.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.Parameters,
			Annotations: annotations,
		}
		server.AddTool(mt, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
			return s.handle(ctx, tool, req)
		})
	}
	return server, nil
}

// Run serves over stdio until ctx is cancelled.
func Run(ctx context.Context, dataDir, version string, log *slog.Logger, opts ...Option) error {
	srv, err := New(dataDir, version, log, opts...)
	if err != nil {
		return err
	}
	return srv.Run(ctx, &sdkmcp.StdioTransport{})
}

// handle validates arguments, dispatches, and maps errors to a result the LLM
// can read and self-correct from (IsError=true, not a protocol error).
func (s *Server) handle(ctx context.Context, tool agent.Tool, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
	args, err := parseArgs(req.Params.Arguments)
	if err != nil {
		return errResult(fmt.Sprintf("参数错误：%v", err)), nil
	}
	text, err := s.dispatch(ctx, tool.Name, args)
	if err != nil {
		return errResult(mapError(err)), nil
	}
	if tool.ResultUntrusted {
		text = untrusted.Wrap(text)
	}
	return &sdkmcp.CallToolResult{
		Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: text}},
	}, nil
}

// client lazily starts the daemon (when configured), connects to it, and
// verifies its api_version once.
func (s *Server) client(ctx context.Context) (*client.Client, error) {
	s.mu.Lock()
	if s.conn != nil && s.checked {
		c := s.conn
		s.mu.Unlock()
		return c, nil
	}
	ensure := s.ensureDaemon
	s.mu.Unlock()

	if ensure != nil {
		if err := ensure(ctx); err != nil {
			return nil, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil && s.checked {
		return s.conn, nil
	}
	c, err := client.New(s.dataDir)
	if err != nil {
		return nil, err
	}
	statusCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	st, err := c.Status(statusCtx)
	if err != nil {
		c.Close()
		return nil, err
	}
	if st.ApiVersion != api.APIVersion {
		c.Close()
		return nil, &versionMismatchError{got: st.ApiVersion, want: api.APIVersion}
	}
	s.conn = c
	s.checked = true
	return s.conn, nil
}

type versionMismatchError struct{ got, want string }

func (e *versionMismatchError) Error() string {
	return fmt.Sprintf("api_version mismatch: daemon %q, plugin %q", e.got, e.want)
}

// mapError turns a daemon/version error into a clear, actionable message.
func mapError(err error) string {
	var vm *versionMismatchError
	if errors.As(err, &vm) {
		return fmt.Sprintf("本地 Raminga 节点 API 版本不兼容（节点 %s，插件需要 %s）。请重启或升级 daemon 后重试。", vm.got, vm.want)
	}
	if client.IsDaemonNotRunning(err) {
		return "节点未运行：本地 Raminga API 不可用。请先启动 daemon（raminga daemon）后重试。"
	}
	if connect.CodeOf(err) == connect.CodePermissionDenied {
		return "本次 Agent 发送被本地节点防护拒绝：" + err.Error()
	}
	return "调用失败：" + err.Error()
}

func errResult(msg string) *sdkmcp.CallToolResult {
	return &sdkmcp.CallToolResult{
		IsError: true,
		Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: msg}},
	}
}

// validateArgs checks required arguments before the daemon handshake, so a
// malformed call reports a validation error even when the node is down.
func validateArgs(name string, args map[string]any) error {
	switch name {
	case "raminga_peer_profile", "raminga_peer_friends", "raminga_peer_manifest", "raminga_connect_listed":
		if argString(args, "peer_id") == "" {
			return errors.New("peer_id 必填")
		}
	case "raminga_content_get":
		if argString(args, "peer_id") == "" || argString(args, "path") == "" {
			return errors.New("peer_id 与 path 均为必填")
		}
	case "raminga_connect":
		if argString(args, "peer_id") == "" && argString(args, "multiaddr") == "" {
			return errors.New("peer_id 与 multiaddr 至少填一个")
		}
	case "raminga_chat_send":
		if argString(args, "text") == "" {
			return errors.New("text 必填")
		}
	}
	return nil
}

// dispatch runs one tool against the daemon client.
func (s *Server) dispatch(ctx context.Context, name string, args map[string]any) (string, error) {
	if err := validateArgs(name, args); err != nil {
		return "", err
	}
	// Private Agent initialization is local file I/O and must work even when
	// the daemon is not running (first use happens before any node call).
	if name == "raminga_agent_init" {
		result, err := initAgentData(s.dataDir)
		if err != nil {
			return "", err
		}
		return marshalJSON(result)
	}
	c, err := s.client(ctx)
	if err != nil {
		return "", err
	}
	switch name {
	case "raminga_status":
		resp, err := c.Status(ctx)
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_friends":
		resp, err := c.ListFriends(ctx)
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_published":
		resp, err := c.Published(ctx)
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_peer_profile":
		resp, err := c.GetPeerProfile(ctx, argString(args, "peer_id"))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_peer_manifest":
		resp, err := c.GetPeerManifest(ctx, argString(args, "peer_id"), argInt32(args, "offset", 0), int32(limitInt(args, "limit", 50)))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_peer_friends":
		resp, err := c.GetPeerFriends(ctx, argString(args, "peer_id"))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_content_get":
		return s.download(ctx, c, argString(args, "peer_id"), argString(args, "path"))
	case "raminga_connect":
		resp, err := c.Connect(ctx, argString(args, "peer_id"), argString(args, "multiaddr"))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_connect_listed":
		resp, err := c.ConnectListedPeer(ctx, argString(args, "peer_id"), argStrings(args, "addrs"))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_chat_send":
		resp, err := c.SendChatFromAgent(ctx, argString(args, "peer_id"), argString(args, "multiaddr"), argString(args, "text"))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	case "raminga_chat_history":
		resp, err := c.RecentMessages(ctx, uint32(limitInt(args, "limit", 20)))
		if err != nil {
			return "", err
		}
		return marshalJSON(resp)
	default:
		return "", fmt.Errorf("未知工具 %q", name)
	}
}

// download collects the DownloadPeerFile stream into a final summary. The
// stream emits progress frames; only the last frame carries the evidence
// (local_path + sha256).
func (s *Server) download(ctx context.Context, c *client.Client, peerID, path string) (string, error) {
	stream, err := c.DownloadPeerFile(ctx, peerID, path)
	if err != nil {
		return "", err
	}
	defer func() { _ = stream.Close() }()
	var chunks []*apiv1.DownloadPeerFileResponse
	for stream.Receive() {
		chunks = append(chunks, stream.Msg())
	}
	if err := stream.Err(); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if len(chunks) == 0 {
		return "", errors.New("下载无结果")
	}
	last := chunks[len(chunks)-1]
	return marshalJSON(struct {
		PeerID        string `json:"peer_id"`
		Path          string `json:"path"`
		LocalPath     string `json:"local_path,omitempty"`
		SHA256        string `json:"sha256,omitempty"`
		Direct        bool   `json:"direct"`
		ReceivedBytes int64  `json:"received_bytes"`
		Error         string `json:"error,omitempty"`
	}{
		PeerID:        peerID,
		Path:          path,
		LocalPath:     last.GetLocalPath(),
		SHA256:        last.GetSha256(),
		Direct:        last.GetDirect(),
		ReceivedBytes: last.GetReceivedBytes(),
		Error:         last.GetError(),
	})
}

func marshalJSON(v any) (string, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal result: %w", err)
	}
	return string(b), nil
}

func parseArgs(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("无效参数：%w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func argString(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func argInt(m map[string]any, key string, def int) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	}
	return def
}

func argInt32(m map[string]any, key string, def int32) int32 {
	switch v := m[key].(type) {
	case float64:
		return int32(v)
	case int:
		return int32(v)
	case json.Number:
		n, _ := v.Int64()
		return int32(n)
	}
	return def
}

// limitInt clamps a page/limit argument into [1, 500], falling back to def
// when absent or non-positive.
func limitInt(m map[string]any, key string, def int) int {
	v := argInt(m, key, def)
	if v < 1 {
		return def
	}
	if v > 500 {
		return 500
	}
	return v
}

func argStrings(m map[string]any, key string) []string {
	switch v := m[key].(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
