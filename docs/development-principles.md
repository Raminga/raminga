# Raminga 开发原则（Engineering Principles）

Status: **Accepted（工程约束）** · Date: 2026-10-29（2026-11-01 按 G6 删除 TS 实现；2026-10-30 按 ADR-0003 修订技术栈）

> 本文回答“如何选型与开发”，不记录阶段进度。架构事实与目标见 [architecture.md](architecture.md)；功能范围与状态见 [features.md](features.md)；迁移决策见 [ADR-0003](adr/0003-go-libp2p-node-daemon.md)；历史决策使用 [ADR](adr/0001-node-first.md)。具体库版本以 `go.mod` 和 ADR 为准。

## 1. 不可变产品与网络边界

1. **Node-first**：每个用户独立运行、控制和存储自己的 Raminga Node。AI Pet、DSH、官方客户端、云服务均为可选接入。
2. **去中心化、无需许可的开放网络**：不得强制依赖指定官方账户、唯一 Bootstrap/Coordinator/Relay、中心目录或指定运营商；第三方可基于公开、语言无关的 wire 协议自行实现节点。
3. **直连优先**：支持实际可达的 IPv4/IPv6 TCP/QUIC；发现、协调和可选数据 Relay 职责分离；默认不向陌生人提供公共数据 Relay 服务。
4. **安全优先与用户自主**：陌生节点不天然获得社交内容、DSH 工具或本地文件权限；可替换的协调服务不能成为强制可信根；不未经同意启用 UPnP/自动端口映射。
5. **最小产品范围**：优先文本/图文社交与可靠网络基础，不提前绑定宠物人格、微服务或商业运营平台。

## 2. 成熟开源优先（默认选型规则）

> **能够使用成熟、持续维护、许可证兼容且满足安全及实际功能需求的开源技术时，原则上直接采用，不新增自研的同类基础设施。已存在的自研实现不是保留理由。**

推荐调查顺序（按需求匹配，而非机械按包数量选）：

1. 目标 Go 节点的 **go-libp2p 公开、稳定 API** 和 Go 1.27 标准库；
2. **Node.js 24 标准库**及成熟开源库（仅 G5 DSH 插件 `plugins/dsh/`）；
3. 与现有架构兼容的其他开源组件，允许轻量适配；
4. 实际没有成熟方案，或现成方案有不可接受的安全/兼容性/复杂度问题时，才保留或新增**最小自研领域逻辑**。

**不自行重造**：TCP/QUIC、安全握手、密码算法、消息帧/字节流工具、限流/缓存、通用重试/队列、嵌入式数据库、跨进程锁、通用监控、测试编排等已有成熟实现的能力。

**可自研但要最小化**：Raminga wire 语义和版本、ACK 的应用含义、内容可见性、授权策略、节点连接优先级、Coordinator 服务策略、上游没有覆盖的安全配额。业务规则应调用成熟实现，不把业务层变成第二套基础框架。

对于没有等价开源替代品的代码，记录“为什么不能替换、现有保护措施、验证范围、复审触发条件”；避免模糊地写“当前实现可用所以保留”。

## 3. 依赖引入前的审查清单

每个拟引入的依赖至少核对：

| 检查 | 最低要求 |
| --- | --- |
| 功能及公开 API | 版本锁定的真实 PoC；不得依赖未公开字段、内部优先级、私有补丁或未合并 PR 作为正式能力 |
| 维护与安全 | 发布记录、活跃维护者、安全公告、已知漏洞、供应链/传递依赖风险 |
| 许可证 | 与 Apache-2.0 项目及预期发行形态兼容；记录必要的许可证告知 |
| 平台 | Go 1.27（节点/CLI/TUI/测试）、Node.js 24（仅 G5 DSH 插件）、macOS/Linux 与目标部署环境；可选 native 模块需可关闭、可明确失败 |
| 协议兼容 | 开发/验证阶段可显式升级 wire 或重建本地数据；不得在同一协议 ID 下暗改语义；真实发布前复审旧数据/配置兼容、迁移与回滚 |
| 成本与复杂度 | 是否引入额外的守护进程、中心服务、凭据、网络权限或无必要的大型框架 |
| 可观测与验证 | 可复现测试、失败行为和合理的卸载/回退路径 |

评估两个等价方案时，优先选择与现有依赖生态一致、维护简单、安全边界清楚的实现。GitHub Stars 或下载量不能单独证明安全。

当前**候选/已选方向**（均非本日已实现承诺）：Go 节点使用 go-libp2p 的公开 transport、Relay v2、DCUtR、AutoNAT v2、Kademlia DHT、AutoRelay、内存 PeerStore、resource manager；跨节点 wire 用 HTTP over libp2p + JSON（`/raminga/http/1.0.0`，`spec/chat-http-v1.*`）；本地 API 用 Connect-RPC over UDS（`api/*.proto`，`buf` 管理）；业务存储用 SQLite + 纯 Go 驱动（`CGO_ENABLED=0`，G1 在 modernc/ncruces 间短测选定）；PeerStore 只把 bootstrap cache/known peers/pinned relays 持久化进 SQLite。默认库：cobra、pelletier/go-toml/v2、log/slog、hashicorp/golang-lru/v2、cenkalti/backoff、golangci-lint+depguard、govulncheck+go-licenses、Go native fuzzing、GoReleaser；版本在 G1 锁定并复核。安全配额与 wire 语义保留最小 Raminga 自研。旧 TS 实现已在 G6 删除，不再扩展。选定之前必须做版本兼容及语义对照。

## 4. 已实现自研通用组件的迁移规则

- **目标是收敛**：遇到可用成熟替代，应主动提出移除自研实现，而非因原代码有测试就无限维护。
- **先证明再切换**：记录当前行为与测试向量 → 独立验证候选 → 小范围迁移 → 全量回归 → 删除旧实现；不保留长期双写/双限流器/双 PeerStore。
- **安全保护不可先删后补**：长度限制应在分配内存之前执行；网络并发、请求频率、授权及存储完整性不能因换库而被弱化。
- **兼容性可明确升级**：当前 Go wire 为 `/raminga/http/1.0.0` + `/chat` JSON，契约与向量在 `spec/`。不得在同一协议 ID 下暗改 wire；开发/验证阶段不保留旧 wire。
- **开发阶段不要求旧数据兼容**：使用 Go 生成的身份/数据；可重建本地数据目录。**真实发布前**必须重新评估兼容、迁移、备份与回滚，并形成发布清单。
- **PeerStore/锁按新架构收敛**：go-libp2p 内存 PeerStore 是运行时地址主数据源，SQLite 只存少量缓存；单实例锁用 SQLite exclusive mode 或 `gofrs/flock`（G1 选定），验证竞争、异常退出和跨平台边界。
- **无成熟等价方案时**：保留有界最小实现，附 ADR 或文档说明缺口和后续上游复审条件，禁止退回不可维护的内部 API hack。

## 5. 模块、状态与接口

- Go 节点由 `node` 组合；`network` 负责 go-libp2p、地址和传输，`protocol` 负责开放 wire 定义，`identity` 负责身份，`storage` 负责 SQLite 持久化，`social/profile` 负责领域规则，`api` 负责 UDS/Connect-RPC，`config` 负责配置。`protocol/network/identity/storage/config` 不依赖其他 `internal/` 包。
- 所有模块只通过公开 API/窄接口交互，不跨 `internal/` 深度导入，不创建相互竞争的状态源；Relay 预约/连接状态必须基于真实 go-libp2p 事件与地址，不按配置推断。
- 本地 API 与跨节点 wire 协议是**不同的契约**。本地 API 是 UDS + Connect-RPC（`api/*.proto`）的本机操作契约；跨节点 wire 是 HTTP `/chat` JSON（`spec/chat-http-v1.*`）。加入网络不依赖官方 Go 二进制或任何私有 SDK；公开协议应有跨语言测试向量和独立实现的互操作验收。
- 无明确需要，不新增额外 workspace、中心服务、数据库或守护进程。目标单二进制 daemon + 本地存储是明确需要；普通节点仍不强制运行 Redis、Prometheus 或中心云平台。

## 6. 安全及隐私默认值

- 传输身份认证（Noise / QUIC TLS）不等于业务授权；Node ID、Peer ID 和 Operator 身份分离。
- 输入不可信：帧长度/严格编码/Schema、配额和超时分层执行；未授权默认拒绝；错误处理不泄露密钥、私人内容和敏感地址信息。
- DSH/Agent 工具访问采用最小权限，远端文字不得作为可信工具指令。执行权限与网络服务隔离。
- 公共 Coordinator/Relay 的提供方默认关闭，Relay client 使用要遵循用户配置；公网发现/探测必须有可关闭与限流机制。
- 对公网端口、UPnP/NAT-PMP、自动转发或外部数据上报，必须有清楚的用户控制。

## 7. 验收、证据和发布门槛

- 每项改动记录：版本/commit、库版本、删除/保留的自研代码、真实运行命令、测试结果、未覆盖情形；开发阶段说明是否只需重建本地数据，真实发布前补兼容/迁移/回滚方案。
- **仅在真实执行后声明 PASS**。统一使用 `PASS / FAIL / BLOCKED / NOT_TESTED`；本地 Docker 网络只能证明模拟拓扑，不能作为真实公网验证。
- 先运行相关 Go 单测，再运行 `make check` 及可用 Docker E2E。涉及网络/安全的变更必须包含恶意输入、异常退出和连接失败场景。
- 真实公网 M6-R 与 M6-D 是不同验收项；双 NAT 只发生协议 attempt 或经 Relay 回退，不是 direct PASS；保留上游阻塞事实。NAT05 TCP 双 NAT direct 不阻塞发布；通常 BLOCKED，Docker 偶见 simultaneous-open，仍不保证；双 NAT 发布门槛为 QUIC direct + relay-independence。
- Any change to build/dist targets, CLI commands/flags, data-dir layout, supported platforms or distribution channels must update `docs/install.md` in the same change.
- M6-R 等真实网络验收尚未完成，状态见 [features.md](features.md) 与 [testing.md](testing.md)。未执行的项目保持 **NOT_TESTED**，不得用本地/Docker 结果代替。

## 8. 文档职责与变更记录

- 长期事实与目标架构：[`architecture.md`](architecture.md)；开发规则：本文；功能范围与状态：[`features.md`](features.md)。
- 重大设计取舍与替代理由：ADR；测试方法、阈值与证据约定：[`testing.md`](testing.md)。
- 参与开发与提交前检查见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
