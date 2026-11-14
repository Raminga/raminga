# 系统架构与模块边界

Status: Accepted (module boundaries); **Go 1.27 + go-libp2p implementation updated 2026-11-01 (G6)**. G1–G4.5.1 are implemented and locally/Docker-accepted; G6 retired the old TypeScript node and its old test/docs. Real public M6-D passed once in an IPv6 stateful-firewall setup; IPv4 NAT M6-D and M6-R remain **NOT_TESTED** (Docker is not the public internet).

## 1. 当前与目标


Raminga is a node-first P2P network. The node is a single Go binary; CLI, TUI, tests and the future DSH plugin are local-API clients. It is a modular monolith with Ports & Adapters, not microservices.

```text
  raminga chat/status/...   raminga tui   optional Agent hosts   DSH plugin   Go e2e
          \                     |              |                  |          /
           \____________ Connect-RPC over Unix domain socket ______________/
                                       |
                         api/*.proto (buf) · server-streaming events
                                       |
                               raminga daemon
                      identity · storage · network · protocol
                      node orchestration · profile · social · config
                                       |
                                   go-libp2p
               TCP/QUIC · Relay v2 · DCUtR · AutoNAT v2 · Kademlia DHT
                          AutoRelay · in-memory PeerStore · resource manager
                                       |
                               Raminga network
                    spec/ · HTTP + JSON over libp2p
```

- **Single state source:** CLI/TUI/DSH/tests do not open go-libp2p or copy PeerStore/connection state; all operations go through the daemon's local API.
- **Node-first:** DSH/AI Pet are optional clients, never a node prerequisite.
- **No compatibility requirement during development:** Go data/config may change; old TS data/identity is not migrated. Revisit before a real release.

## 2. 进程模型与本地 API

| 进程/组件 | 职责 | 不拥有 |
| --- | --- | --- |
| `raminga daemon` | node lifecycle, identity/storage/network/protocol, policy, local API | no client-side state copies |
| `raminga <subcommand>` | CLI client over the local API | no direct dialing/PeerStore writes |
| `raminga tui` | inline slash-command test panel over the local API ([ADR-0004](adr/0004-inline-tui.md)) | no second state, no new listener, no `--enable-test-api` requirement |
| `plugins/dsh/` | thin DSH plugin over the local API | no node state, no auth bypass |
| `tests/e2e/` | Go Docker topology/runners; test API only when explicitly enabled | not a normal node dependency |

Agent 的持久运行、会话恢复和宿主审批属于宿主 Agent 的内部设计，不在 Raminga 插件范围。插件只提供本地 API、MCP/DSH 工具、私有数据初始化与行为指引。

**Local API:** Connect-RPC over HTTP; `api/*.proto` is authoritative (buf-managed); server-streaming events. The default transport is a Unix domain socket with token + directory 0600 and **no TCP/UDP listener**. An explicit opt-in (`--api-tcp` / `RAMINGA_API_TCP=1`) instead serves only literal `127.0.0.1` on an ephemeral port with a per-run token and pinned per-run TLS certificate; there is no automatic fallback between transports. JSON works for curl-style debugging. Test-only operations are behind an explicit flag, default off. `raminga tui` reports are redacted by default; schema `docs/schemas/test-report.schema.json`.

## 3. Go 布局与依赖方向

```text
cmd/raminga/            daemon + CLI entry
internal/identity/      libp2p Ed25519 key, Peer ID, Node ID, data-dir lock
internal/storage/       SQLite (pure Go), business persistence, cache, recovery
internal/network/       go-libp2p host, transports, Relay, DCUtR, AutoNAT, DHT, AutoRelay, PeerStore, rcmgr
internal/protocol/      chat JSON contract, ACK, limits
internal/node/          lifecycle, composition, connect strategy, helper policy
internal/profile/       profile views/visibility; identity public types only
internal/social/        publish/relationship/interaction; identity public types only
internal/api/           Connect-RPC handlers, UDS/TCP transport, auth, server streaming
internal/config/        config.toml parsing/validation/defaults
internal/tui/           inline Bubble Tea client
api/                    local API .proto (language neutral)
spec/                   cross-node wire .proto + language-neutral vectors
tests/e2e/              Go Docker runners, manual labs, evidence output
plugins/dsh/            TypeScript DSH plugin (own package.json)
npm/                    planned per-platform binary npm packages
```

| 模块 | 拥有 | 不拥有 |
| --- | --- | --- |
| identity | transport Ed25519/Peer ID, logical Node ID, dir lock | relationships, wire parsing |
| storage | SQLite business persistence, PeerStore cache, recovery | key lifecycle, runtime address authority |
| network | go-libp2p host/transports/Relay/DCUtR/AutoNAT/DHT/AutoRelay/PeerStore/limits | social policy, profiles, independent datastore |
| protocol | cross-node wire semantics, JSON contract, version | connection policy, Relay choice |
| node | lifecycle, wiring, connect policy, helper policy, auth context | duplicate domain implementations, second PeerStore |
| profile | node profile, internal/external views, visibility | second social database |
| social | publish/interaction/relationships/business rules | profile storage, libp2p details |
| api | local Connect-RPC, UDS/token default or opt-in loopback TLS/TCP, streaming, implementation | cross-node wire, business rules |
| config | parse/validate/defaults | runtime state |
| tui | presentation, slash commands, reports | node state, network listeners |

**依赖方向:** `protocol`, `network`, `identity`, `storage`, `config` do not import other `internal/` packages. `node` composes them. `profile -> identity`, `social -> identity` only; no `profile <-> social` dependency. `api -> node`; `cmd/raminga` is the composition root. `network` does not depend on `protocol`/`identity`/`storage`.

**边界执行:** Go `internal/` plus `golangci-lint`/`depguard`; no cross-module internal imports or cycles. The old TS boundary script was removed with the TS node in G6.

## 4. 数据目录

```text
<dataDir>/
  identity/       libp2p protobuf Ed25519 private key
  raminga.db      SQLite business data + bootstrap/known peers/pinned relays/peer names
  config.toml     configuration
  api.sock        local API Unix socket (default)
  api.endpoint.json optional 127.0.0.1 TLS endpoint/token (0600 on Unix; protected current-user DACL on Windows, opt-in)
  api.token       local API token (0600)
```

One daemon per data directory; SQLite locking/flock protects it. PeerStore is in-memory; SQLite only keeps bootstrap/known peers/pinned relays/peer names. No old TS identity/data migration. `.local/` is developer workspace, `.raminga/` is runtime data; neither is committed.

## 5. 技术栈与实现状态

| 能力 | 方案 | 状态 |
| --- | --- | --- |
| node | Go 1.27 single binary (daemon + cobra CLI) | **Implemented / G1 PASS** |
| network | go-libp2p v0.51.0 | **Implemented / G2 PASS**; TCP dual-NAT usually BLOCKED (occasional Docker simultaneous-open) |
| identity | libp2p protobuf Ed25519, Peer ID, logical Node ID | **Implemented / G1 PASS** |
| storage | modernc/ncruces SQLite (pure Go), `CGO_ENABLED=0` | **Implemented / G1 PASS**; bounded PeerStore cache G2 |
| cross-node wire | HTTP + JSON, `/raminga/http/1.0.0`, `spec/` | **Implemented / G1 PASS（Docker）** |
| Relay v2 | go-libp2p Circuit Relay v2, provider off by default + quotas | **Implemented / G2 PASS** |
| DCUtR | go-libp2p DCUtR public API | **Implemented / G2 QUIC PASS** |
| AutoNAT v2 | go-libp2p AutoNAT | **Implemented / G2 PASS**; unknown without probe peers |
| DHT | Kademlia with `/raminga/kad/1.0.0` | **Implemented / G2 PASS**; no public IPFS DHT |
| AutoRelay | go-libp2p AutoRelay + Raminga relay discovery | **Implemented / G2 PASS** |
| resource limits | go-libp2p rcmgr + token bucket + Raminga quotas | **Implemented / G2 PASS** |
| local API | Connect-RPC over UDS (default) or explicit loopback TLS/TCP, streaming, token 0600 | **G1/G2/G4.5 PASS** |
| CLI/TUI | status/chat/peers/relay/dht/network/report/tui | **G1–G4.5.1 PASS** |
| Agent plugin shells | Claude/Codex SKILL + launcher, DSH native tools; single-source `agent/` | **Implemented (code); real-host acceptance partial** |
| distribution | static binary + npm optionalDependencies + GoReleaser | **G4.5 dist PASS; packaging/release pipeline incomplete** |
| real public M6 | manual M6-R/M6-D | M6-D **PASS** once (IPv6 stateful firewall); IPv4 NAT M6-D and M6-R **NOT_TESTED** |

`Planned` is not available. Docker PASS is not public-network/production/security evidence. NAT05/NAT07 in the retired js-libp2p implementation were BLOCKED; the Go release gate is QUIC direct + relay-independence. Never turn an attempt or Relay fallback into direct.

## 6. 网络策略与连接边界

- **Direct-first:** reachable IPv4/IPv6 TCP/QUIC; LAN/public direct first, then coordination, then an explicitly configured Relay.
- **IPv6-first:** important in mainland China; record v4/v6 reachability separately; a global address is not an inbound proof.
- **Own helpers only:** Relay, coordination, address observation, AutoNAT, bootstrap only from Raminga nodes; no public STUN/IPFS bootstrap/DHT/vendor Relay by default.
- **Discovery:** independent Raminga Kademlia DHT with own prefix, bootstrap entries + SQLite cache + manual peers; discovered relays feed AutoRelay.
- **Relay:** provider off by default; reservation/data/duration/IP/peer quotas; never silently enable UPnP/NAT-PMP.
- **AutoNAT:** no Raminga probe peer means `unknown`, not unreachable.
- **One-sided reachability:** restricted side dials; after connection either side can open streams. Do not infer online from a historical address.
- **Symmetric NAT/CGNAT:** may be Relay-only; diagnose with conntrack/logs/errors; never fake direct.
- **Dual-NAT gate:** QUIC direct + relay-independence; NAT05 TCP is not a release gate, but report outcomes honestly. Docker is not public M6.

## 7. 两类独立契约

1. **Local node API (`api/*.proto`, Connect-RPC):** CLI, TUI, DSH, third-party local clients and Go tests. HTTP over UDS (default) or explicit loopback TCP with per-run TLS, JSON, streaming, token/0600. Not a requirement for joining the P2P network.
2. **Cross-node open wire (`spec/`):** HTTP with JSON bodies over libp2p streams, `/raminga/http/1.0.0`. Contract: [`spec/chat-http-v1.md`](../spec/chat-http-v1.md).

The retired TypeScript wire is not part of this repository; this tree contains the Go `/raminga/http/1.0.0` contract.

## 8. 历史与 G6

The TypeScript node, Node workspace, old test tree and historical docs were deleted in G6 (2026-11-01). This tree contains only the Go implementation and current docs.

## 9. 分发、记录与发布

- **Distribution (release pipeline incomplete):** static `CGO_ENABLED=0` binaries for darwin/linux/windows arm64/amd64; DSH plugin via npm optionalDependencies; GoReleaser archives/Homebrew/scoop/winget; signing/notarization/autostart remain open decisions.
- Architecture decisions use ADRs; feature scope and status live in [features.md](features.md); tests and thresholds live in [testing.md](testing.md).
- ADR-0003 and the current feature/status documents win on conflict.
