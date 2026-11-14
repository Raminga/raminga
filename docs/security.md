# 安全与隐私边界

Status: Accepted (principles); Go G1–G4.5.1 controls implemented, with tests and thresholds in [testing.md](testing.md). Production authorization/E2EE/social security remain **Proposed/not implemented**. Docker tests are controlled simulations, not public-network security evidence.

## 1. 身份与本地数据

- **Peer ID / Node ID:** `internal/identity/identity.go` creates a libp2p protobuf Ed25519 key and derives the Peer ID; Node ID is a domain-separated hash (`raminga-node-id-v1`). The key is `identity/key` (0600, directory 0700). There is **no signed Node ID ↔ Peer ID binding** yet; `nodeId` is not proof of identity.
- **Single instance:** `identity.Open` takes an exclusive `raminga.lock` (`gofrs/flock`) before touching identity/DB; a second daemon returns `ErrLocked` ("data directory is locked by another raminga daemon"). The lock file is intentionally kept after close. Tests: `internal/identity/identity_test.go`.
- **Transport authentication:** Noise/TLS authenticates the peer key; it is **not** business authorization. Remote text/IDs are untrusted.
- **Local API (default):** Connect-RPC over a Unix domain socket (`internal/api/api.go`); 32-byte bearer token in `api.token` (0600) plus 0600 socket; wrong/missing token is rejected. No TCP/UDP API listener by default. Test-only RPCs are unavailable unless `--enable-test-api` is explicitly set (`internal/api/g2.go`). `Shutdown` is a normal token-protected local-only RPC: it requests the same graceful stop as SIGTERM, returns before stopping, and is reachable only through the selected local API transport. When the daemon was started by systemd (`INVOCATION_ID` set), `StatusResponse.supervised` is true and the CLI refuses direct stop/restart. Tests: `internal/api/api_test.go`, `cmd/raminga/lifecycle_test.go`.
- **Optional loopback TCP local API (opt-in; DSH default on Windows):** `raminga daemon --api-tcp` (or `RAMINGA_API_TCP=1` before an auto-started daemon/TUI/DSH) serves the same Connect-RPC API **only** on an ephemeral listener bound to literal `127.0.0.1`, with a per-run 32-byte bearer token and a per-run self-signed certificate. The certificate is pinned by SHA-256 in `<data-dir>/api.endpoint.json`, atomically replaced under the existing `raminga.lock`; clients pin the certificate and keep normal hostname/chain verification. On Unix the discovery file is 0600 and owner-checked. On Windows it is created with a protected DACL containing only the current user SID; the Go reader validates the opened handle's type, owner and DACL before reading, and the DSH client obtains the document from the local Go binary over a private stdout pipe instead of reopening the path. Any unverifiable owner/DACL or reparse point is rejected before an HTTPS connection is attempted. There is **no UDS listener in this mode and no automatic fallback** from a stale/unreachable endpoint; a failed tunnel is an explicit error. HTTP(S) proxy environment variables are not used. Restart rotates the port, token and certificate; `stop` removes the endpoint. The token stays host-side, never in renderer state, logs or command lines. Tests: `internal/api/tcp_test.go`, `internal/api/tcp_windows_test.go`, `internal/api/endpoint`, `cmd/raminga/lifecycle_test.go`, `plugins/dsh/test/windows-api.integration.test.mjs`.

来源：`internal/identity/identity.go`、`internal/api/api.go`、`internal/api/api_test.go`、`internal/identity/identity_test.go`。

## 2. 跨节点 wire

- `/raminga/http/1.0.0` carries `POST /chat` with a strict JSON body (`internal/protocol/protocol.go`; `internal/p2phttp`). Not protobuf and not a raw uvarint frame.
- Request bodies are bounded by the p2phttp body limit and `limits.max_message_bytes` (default 1 MiB, allowed 1 KiB–16 MiB); chat text is ≤4096 UTF-8 bytes. Unknown fields, trailing JSON, invalid UTF-8, wrong content type, malformed/truncated bodies and oversized bodies are rejected.
- `sender_peer_id`/`sender_node_id` in the payload are accepted but **ignored**; the authenticated libp2p stream Peer ID is the only sender. A 200 ACK must match `message_id`; ACK `ack_id` is random. Per-peer inbound token bucket default **5/s burst 10** (`config.DefaultAppMessagesPerSecond`/`AppBurst`); dedupe LRU default **4096 entries / 10 min** (`protocol.DefaultDedupeSize/DefaultDedupeTTL`).
- No message signing, application-layer E2EE, replay protection across processes, or formal version negotiation. Relay sees metadata/ciphertext paths; it cannot read Noise-protected application text, but timing/Peer IDs are visible.

来源：`internal/protocol/protocol.go`、`internal/p2phttp`、`internal/config/config.go`、`spec/chat-http-v1.md`；G1/G4 测试见 [testing.md](testing.md)。

## 3. 连接策略、资源限制与 Relay

- **Contact policy:** `internal/node/node.go` `authorize` applies deny list → allow list → default. Default `chat.allow_unknown_peers = true` in `internal/config/config.go` (G1–G3 behavior, documented G4 gap); set false for explicit allow-list deployments. Deny always wins.
- **Resource limits:** `internal/network/network.go` sets go-libp2p rcmgr system/transient limits from `limits.max_connections` (default 256), `max_streams` (1024), `max_memory_bytes` (128 MiB default), `max_fds` (256, must be ≥ connections); additional config validation in `internal/config/config.go`.
- **Relay:** Circuit Relay v2 provider is **off by default**; when enabled, `max_reservations`, per-IP/per-peer quotas, max circuits, TTL, data/duration limits are enforced (`internal/config/config.go`; G2/G3 Docker tests). No public/foreign Relay is auto-enabled; no silent UPnP/NAT-PMP.
- **QUIC/TCP:** Go supports both; default listen addresses are TCP `:4001` and QUIC-v1 UDP `:4001` (`internal/config/config.go`), so TCP is not the only transport. G2/G3 Docker tests cover both; TCP dual-NAT is usually BLOCKED, occasionally simultaneous-open, never guaranteed.
- **Outbox:** durable SQLite outbox with bounded entries/bytes/TTL and exponential backoff (`internal/node/outbox.go`, `internal/config/config.go`); it does not fabricate ACKs. `kill -9`, SQLite busy/lock and network flap recovery are covered by the G4 suite.
- **Logs/reports:** TUI/CLI redact private-key/token-shaped data and report message text only with explicit `--include-text`; see G4 and `internal/tui`.

来源：`internal/node/node.go`、`internal/network/network.go`、`internal/node/outbox.go`、`internal/config/config.go`；G2/G4 测试见 [testing.md](testing.md)。

## 4. Agent 持久运行与宿主边界

- 持久运行、入站唤醒、会话恢复、重试/去重和审批策略属于宿主 Agent 的内部设计，不属于 Raminga 插件范围；插件不提供常驻 supervisor，也不把模型生命周期放进 daemon。
- 插件只通过受保护的本地 CLI/API 操作 Node，不读取 `raminga.db`、`api.token` 或身份私钥。
- 远端正文始终是不可信数据；注入信封与警告由插件提供，但模型是否被唤醒、是否批准工具调用由宿主决定。
- 私有 Agent 文件位于 `agent/`；是否把 Persona 或其他上下文交给某个模型宿主，由操作者在宿主中另行决定。
- Node 消息历史是有界恢复来源；宿主的 checkpoint/thread 保留策略和可能的重复处理不属于本插件保证。

## 5. 已知缺口（不得写成 PASS）

- Node ID ↔ Peer ID signed binding **not implemented** (G4 S03 `NOT_IMPLEMENTED`).
- No application-level message signing, persistent E2EE, replay protection, social/Profile authorization, revocation, or production key rotation.
- Default allows authenticated strangers to send chat (opt-in allow list exists).
- Real public M6-D has one IPv6 stateful-firewall PASS; IPv4 NAT, M6-R, public DHT/Relay/AutoNAT behavior, and third-party wire interop remain **NOT_TESTED**.
- QUIC connection migration, cross-device outbox, and formal third-party wire interop are not tested.

## 6. 测试来源

测试方法、G4 阈值摘要、证据约定和当前结果见 [testing.md](testing.md)。Docker 结果是受控模拟，不是公网或生产安全证据。

Historical TypeScript M1–M5/Phase evidence is not part of this repository and is not current coverage; its values (JSON/4-byte framing, old paths/error names) do not apply to Go.
