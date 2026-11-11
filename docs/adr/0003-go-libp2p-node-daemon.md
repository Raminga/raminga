# ADR-0003: 采用 go-libp2p，节点收敛为 Go 单二进制 daemon

Status: Accepted（2026-10-30；同日按已确定的 wire/API/存储/分发选型修订）

> **修订（2026-11-05，聊天和内容已于 2026-11-06 实现（真实网络未测））：** 下面第 3 条的跨节点 wire 已改为 HTTP over libp2p 流（`net/http` + `gostream`）加 JSON 请求体，聊天和内容统一使用。理由：项目早期统一成本最低，并优先使用成熟的标准库能力。旧的 `/raminga/chat/1.0.0` 已删除。方案与本机小测试见[功能与设计清单](../features.md#第一版技术方案2026-11-05)。其余决定不变。
Date: 2026-10-30

## Context

项目从 TypeScript 迁移到 Go 的直接原因是 **js-libp2p 发布版在双 NAT/DCUtR 上无法满足发布门槛**：NAT05 TCP direct 与 NAT07 QUIC direct 均 BLOCKED，缺少受支持的固定源端口/QUIC listener 复用接口，同时又不能用未合并补丁/私有 fork。原 M1–M5/Phase 文档已随 G6 删除，结论摘要见本节。原 TS 实现是 Node.js 24 + TypeScript ESM + js-libp2p 3.5.1 的模块化单体；M1–M5 与 Phase 1–5 的本地/Docker 验收覆盖 TCP/Noise/Yamux、持久 Ed25519 Peer ID、实验聊天及 ACK、Circuit Relay v2、Relay 恢复、PeerStore 持久化、可选 QUIC 与 DCUtR 协商。但在**发布版依赖**下，严格 Docker 双 NAT 拓扑中 **NAT05 TCP direct BLOCKED、NAT07 QUIC direct BLOCKED、NAT08 NOT_APPLICABLE**；js-libp2p 的 QUIC listener 端口复用依赖上游尚未合并的 QUIC listener 端口复用补丁方向，TCP 也缺少公开的固定源端口/`initiator` 接口。项目规则禁止把未合并补丁、私有 fork、deep import 或内部字段当作正式能力。

2026-10-29 在**同一严格双 NAT 拓扑**（沿用当时的 NAT router 规则，无静态 DNAT、无端口转发、无共享管理网、无宿主发布端口）完成的 go-libp2p PoC 给出了不同结果：

| 传输 | 隔离 | Relay 聊天 | direct | 停全部 Relay 后仍 direct | Relay 回退 |
| --- | --- | --- | --- | --- | --- |
| TCP | PASS | PASS | **BLOCKED**（SYN_SENT/SYN_SENT2） | NOT_APPLICABLE | PASS |
| QUIC | PASS | PASS | **PASS** | **PASS** | NOT_APPLICABLE |

QUIC 路径由 DCUtR 建立真实、`limited=false`、不含 `/p2p-circuit` 的连接，双向应用消息与 ACK 均为 `route=direct`；停止 R1/R2 后同一连接、同一进程与 Peer ID 仍可通信。TCP 的失败有 DCUtR 错误与两侧 conntrack 状态证据，不能记作 direct。上述结果只证明该受控 Docker 拓扑，**不是真实公网 M6**，也没有做长稳或重启后直连存活测试。PoC 证据已随 G6 删除，结论以本 ADR 记录为准。PoC 镜像实际使用 go1.26.10；目标工具链为 Go 1.27，G1 统一后需重跑基础测试并记录兼容性。

现有 TypeScript 实现没有已部署的节点，仅是开发原型。2026-10-30 进一步确定：当前处于**开发/验证阶段，不要求任何本地兼容**——不保留 TS 生成的 Peer ID、不要求校验 TS 密钥格式、G1–G6 不做 TS→Go 数据/配置迁移或回滚，wire 协议可自由变更；**真实发布前需复审兼容与迁移需求**。因此本 ADR 不再把“沿用旧密钥/保留 Peer ID”作为设计目标。

## Decision

以下 1–13 为本次迁移决策，其中 12–13 为继续有效的网络与验收约束，均不得在实施中自行重开。

1. **采用 go-libp2p。** Go 节点以 go-libp2p v0.51.0 为基线网络栈，使用其公开 API；版本升级须按依赖审查与回归重新确认，不把 v0.51.0 当作永久锁定。PoC 的 QUIC direct + relay-independence PASS 是选择依据，TCP direct 仍为 BLOCKED，不以 Relay 回退冒充直连。
2. **进程模型：一个 Go 二进制 `raminga`。** `raminga daemon` 运行节点，是节点状态的唯一来源；`raminga chat`、`raminga status` 等 CLI 子命令是客户端。TypeScript 只用于 DSH（DeepSeek Harness）插件，且是薄客户端。没有已部署的 TS 节点，因此不要求 TS↔Go 互通。
3. **跨节点 wire：protobuf + uvarint 长度前缀。** 使用 libp2p 惯例的 delimited framing（uvarint 长度前缀，采用 go-libp2p 内置的 delimited reader/writer，例如 go-msgio/pbio），取代旧的 4 字节大端 + JSON。新聊天协议版本为 `/raminga/chat/1.0.0`；`.proto` 定义放在 `spec/`，语言无关测试向量由 `.proto` 重新生成并放在 `spec/` 下。旧的 TypeScript wire 已不在本仓库中。该条已被上方 2026-11-05 修订取代：当前树使用 `/raminga/http/1.0.0` + JSON（`spec/chat-http-v1.*`）。
4. **本地 API：Connect-RPC（connect-go），替代 OpenAPI。** 仍是 HTTP over **Unix domain socket**，支持 JSON（可用 curl 调试），认证 = socket/文件权限（0600）+ token；**不监听任何网络端口**。契约在 `.proto` 中定义，由 `buf` 统一管理/生成；入站消息、连接变化等事件改用 **server-streaming RPC**，不再使用 SSE。CLI、DSH 插件和 Docker 测试设施共用**同一个 API**；仅测试使用的操作放在显式 flag 之后，默认关闭。DSH 插件使用官方 Connect TS 客户端（connect-es），从同一 `.proto` 生成。`api/` 的含义改为“本地 API 的 `.proto`（语言中立）”，跨节点 wire 的 `.proto` 在 `spec/`；两种契约共用一种 schema 语言。
5. **无本地兼容要求（开发/验证阶段）。** 不要求读取/校验现有 TS 密钥格式，不保留 TS Peer ID；不要求 TS 数据目录、配置或业务数据的迁移/回滚；wire 可自由变更。Go 侧使用新生成的 libp2p protobuf Ed25519 身份即可。**真实发布前必须复审**是否需要兼容、迁移或回滚；在此之前不得把“已兼容旧数据”写成事实。
6. **业务存储：SQLite + 纯 Go 驱动。** 使用 `modernc.org/sqlite` 或 `ncruces/go-sqlite3`，G1 做短测后最终选定；构建保持 `CGO_ENABLED=0`，以支持单静态二进制和跨平台分发。取代“bbolt 或 SQLite”的待定项。单实例锁用 SQLite exclusive mode 或 `gofrs/flock`，G1 选定并验证。数据目录收敛为 `identity/`、`raminga.db`（SQLite）、`config.toml`、本地 API socket + token（0600）；不再有独立 `peerstore/` 或 `storage/` 目录。
7. **PeerStore：go-libp2p 内存 peerstore + 少量 SQLite 持久化。** 网络地址/协议仍以 go-libp2p PeerStore 为运行时主数据源；只把真正需要跨重启保留的内容（bootstrap cache、已知 peers、pinned relays）写入 SQLite，重启后通过 DHT 重新发现。不引入独立 datastore 引擎，不与业务存储形成第二套地址主数据源。
8. **仓库与模块边界不变。** 留在本仓库；`go.mod` 放在仓库根，module 为 `github.com/Raminga/raminga`。目标布局：

   ```text
   cmd/raminga/            daemon + CLI entry
   internal/{identity,storage,network,protocol,node,profile,social,api,config}/
   api/                    local API .proto (language neutral, buf-managed)
   spec/                   cross-node wire .proto + regenerated test vectors
   plugins/dsh/            TS DSH plugin (G5, own package.json)
   npm/                    per-platform binary npm packages (G5)
   tests/e2e/              Go Docker runners, manual labs, evidence
   docs/ Makefile          docs and make check/test/e2e
   ```

   模块职责与依赖方向沿用现有架构：`protocol`/`network`/`identity`/`storage`/`config` 不依赖其他 `internal/` 包；`node` 负责编排；`profile`/`social` 只使用 `identity` 公共类型，且两者不互相依赖。用 Go `internal/` 加 depguard/golangci-lint 做边界检查。旧 TS boundary 脚本已在 G6 删除。
9. **TS runtime 已于 G6 退役。** 随后删除 TS 节点、Node workspace、旧脚本/测试与历史文档。Node.js 24 现在只用于 G5 的 DSH 插件（`plugins/dsh/`，own package.json）。
10. **默认库选择（版本在 G1 锁定并复核）：**

    | 领域 | 选择 | 一句话理由 |
    | --- | --- | --- |
    | CLI | `spf13/cobra` | 子命令/flag/帮助成熟，Go CLI 事实标准。 |
    | 配置 | `pelletier/go-toml/v2` | 维护中、TOML v2、结构体映射稳定。 |
    | 日志 | 标准库 `log/slog` | 结构化日志进标准库，减少依赖。 |
    | 去重 | `hashicorp/golang-lru/v2`（expirable） | 有界 TTL/LRU，替换自研窗口并限制内存。 |
    | 限流 | go-libp2p resource manager + `golang.org/x/time/rate` | 网络层配额与应用层令牌桶分工，不重造限流器。 |
    | 重试/退避 | `cenkalti/backoff` | 成熟指数退避，替换手写重试循环。 |
    | Lint/边界 | `golangci-lint` + `depguard` | 静态检查与依赖边界。 |
    | 供应链 | `govulncheck` + `go-licenses` | 漏洞与许可证清单使用成熟工具，不自写扫描器。 |
    | 模糊测试 | Go native fuzzing | 标准库能力，覆盖 frame/protobuf 解析边界。 |
    | 发布 | GoReleaser | 跨平台构建/归档/包管理；G5 验证逐平台 npm 发布能力。 |

11. **分发与安装（主要 G5）。** 目标交付单平台单静态二进制（`CGO_ENABLED=0`）：darwin arm64/amd64、linux arm64/amd64、windows amd64/arm64；最终用户不需要安装 Go/Node，也不要求设置环境变量。首次运行在 OS 标准位置创建默认配置与数据目录。渠道：DSH 插件经 npm 分发，用 `optionalDependencies` 携带各平台二进制（esbuild 模式）；同时用 GoReleaser 生成 standalone archives、Homebrew tap，以及 Windows 包（scoop 或 winget）。已知摩擦需在 G5 作为待决事项处理：macOS 代码签名 + notarization（Developer ID）、Windows 代码签名（SmartScreen）、首次监听时的系统防火墙提示、可选自启动（launchd/systemd/Windows 服务）；签名证书有成本，不得默认承诺已签名。
12. **网络与辅助节点约束（继续有效）。**
    - NAT05 TCP 双 NAT direct **不阻塞发布**，状态保持 BLOCKED 并持续跟踪；双 NAT 直连发布门槛 = **QUIC direct + relay-independence**（NAT07 + NAT08 等价）。
    - Relay、协调、地址观察、AutoNAT、bootstrap 等辅助节点**只能由 Raminga 节点提供**，不得默认使用第三方/境外公共服务（公共 STUN、IPFS bootstrap/DHT、厂商 Relay）。
    - 使用独立 Raminga Kademlia DHT，自有协议前缀（如 `/raminga/kad/1.0.0`）；配置多个 bootstrap 条目 + 持久 peer cache + 手工添加；DHT 发现的 Relay 供 AutoRelay 使用。
    - **IPv6-first**（对中国大陆网络尤其重要）。
    - Relay provider 默认关闭并设配额；**绝不静默启用 UPnP/NAT-PMP**。
    - Coordinator v1 = 受限 Circuit Relay v2 + DCUtR；纯信令打洞 PoC 仅为可选项。
    - 对称 NAT/CGNAT 可能只能走 Relay，必须如实诊断，不得伪造直连。
13. **验收范围。** 开发验收只做 Docker；真实公网 M6-R/M6-D 由测试人员在真实设备上手工完成，未执行前保持 NOT_TESTED，不得用 Docker 结果代替。

## Alternatives considered

- **js-libp2p + 未合并补丁**：可保留现有 TS 代码，但依赖未合并的 QUIC listener 端口复用，TCP 也缺公开接口；在项目规则下不能把补丁/fork 作为生产能力。
- **js-libp2p + WebRTC**：引入浏览器导向的传输与额外信令，未证明能解决本机 dual-NAT 的 TCP/QUIC direct，组件与失败面更多。
- **rust-libp2p**：技术能力足够，但等于完整 Rust 重写并更换工具链，本项目没有该拓扑的 PoC 证据，交付路径更长且不解决当前已验证的 QUIC 问题。
- **Hyperswarm**：打洞与 DHT 成熟，但身份、寻址、Relay 与 libp2p 生态不同，等于放弃 libp2p 兼容并重建发现/中继层。
- **iroh**：QUIC-first 且有 Relay，但寻址、身份和 Relay 模型独立于 libp2p，无法复用 go-libp2p 的 Relay/DCUtR/AutoNAT/DHT 能力。
- **本地 API 继续用 OpenAPI/REST + SSE**：契约与 wire 分成两套 schema，事件还要额外流式封装；Connect-RPC 让本地 API 与 wire 共用 protobuf，并直接支持 server-streaming 与官方 TS 客户端。
- **bbolt/独立 PeerStore datastore**：无法同时承担业务关系型查询与“少量缓存持久化”；SQLite 单库 + 内存 PeerStore 更少引擎、更少状态源。

## Consequences

- **正面**：QUIC dual-NAT direct 在受控拓扑中得到真实证据；go-libp2p 的 Circuit Relay v2、DCUtR、AutoNAT v2、Kademlia DHT、AutoRelay、PeerStore、resource manager 等成熟组件替代原 Phase A 的大量通用自研需求。节点与 CLI 收敛到一个 Go 二进制；protobuf 统一 wire 与本地 API 的 schema；SQLite 单库减少数据引擎数量；纯 Go + `CGO_ENABLED=0` 为单静态二进制和 npm 分发铺路。
- **代价**：需要完成 Go 重写；Go 1.27 用于节点/CLI/测试，Node.js 24 仅用于 G5 DSH 插件；引入 `buf`/connect-go/connect-es、SQLite 驱动、GoReleaser 与签名/公证流程。旧 TS 代码已随 G6 删除。
- **未解决风险**：TCP direct 仍 BLOCKED，UDP 被封或对称 NAT/CGNAT 环境可能只能 Relay；Connect-RPC 的 auth/流式错误模型、纯 Go SQLite 驱动的并发/恢复表现、DSH 插件能否管理子进程与分发二进制、macOS/Windows 签名成本都要在后续阶段验证。PoC 未覆盖真实公网、长稳或重启后直连；新 wire/API 已实现，但仍没有第三方互操作证据。
- **身份与数据**：开发阶段接受新的 Go Peer ID，不要求旧 TS 身份/数据可延续；G1–G6 不安排迁移或回滚。**真实发布前**必须重新评估是否需要兼容、迁移、备份与回滚；在此之前不得对外承诺平滑升级。
- **文档与执行**：功能范围与状态见 [features.md](../features.md)，测试方法与阈值见 [testing.md](../testing.md)。架构见 [architecture.md](../architecture.md)，发布门槛与 2026-10-29 NAT05 决策继续有效。真实 M6-D 已在 IPv6 有状态防火墙场景 PASS 一次，IPv4 NAT M6-D 与 M6-R 仍为 NOT_TESTED；Docker 成功不等于公网 PASS。
