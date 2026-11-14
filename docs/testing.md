# 测试与独立验收

Status: Accepted (process); **Go G1–G4.5.1 are implemented and passing local/Docker acceptance** (Docker is a controlled simulation, not production security). The old TypeScript M1–M5/Phase implementation and its tests were retired in G6 and are not part of this repository. Real public M6-D **PASS once in an IPv6 stateful-firewall setup**; IPv4 NAT hole punching, M6-R message counts and third-party wire interop remain **NOT_TESTED**.

## 证据布局

E2E runner 默认把 summary 和工具报告写到 `tests/e2e/evidence/<phase>/`（Git 忽略，目录只保留 `.gitignore`），完整 raw 输出（commands、`test-report.json|md`、TUI 日志/按键、`tuiwalk`、soak）写到 `.local/evidence/<phase>/`（同样忽略）。仓库不提交验收证据，只保留测试结论与复现命令。证据文件不得包含私钥、token 或聊天正文；runner 用 `CheckText` 拒绝 NUL/二进制。

## 四级验证

1. **单模块单元测试**：纯函数/模拟端口，无真实公网依赖。覆盖 protocol 编解码、限额、去重，identity 锁/损坏，storage 校验和/路径遍历。
2. **契约测试**：验证公共接口、错误码与兼容性；TS public exports 通过编译验证。
3. **集成测试**：至少两个真实模块协作；Go 单测/集成测试使用真实 TCP/Noise/Yamux/QUIC、Relay/DCUtR、SQLite 与本地 API。
4. **E2E**：Go runner 在独立 Docker 容器/dataDir/端口运行；G1 LAN 直连，G2 双 NAT/Relay/DHT/PeerStore，G3 IPv6/单侧/协议封锁/netem/对称 NAT/双 NAT/ipv6fw，G4 安全/稳定性，G4.5.1 真实 pty TUI。所有结果只是受控 Docker 模拟，不是公网 M6。

## G3 测试设施（Go e2e，2026-10-30 实际结果）

G3 统一使用 `tests/e2e/` Go runner；旧 TS/Node 测试设施已随 G6 删除。G3 覆盖 IPv6 ULA + ip6tables 状态防火墙、单侧可达、UDP/TCP 单向封锁、`tc netem`、对称 NAT（`MASQUERADE --random-fully`）与双 NAT QUIC 复验；每个设施先自检再跑业务场景，NAT01–NAT13 全部以 Go daemon 重测（不继承任何旧 TS 结论）。G3.1 新增 `ipv6fw` 双侧状态防火墙（无 4001 白名单/DNAT）打洞、仅凭 Peer ID 的 IPv6-first 选址与地址族回退、复用/backoff 提示、对称 NAT DCUtR 终态失败（原因），以及第五个手动 lab。

```sh
make check          # Go vet/lint/buf/test/fuzz seed
make cross          # CGO_ENABLED=0 6 平台
make e2e            # G1 + G2 + G3，打印 per-suite 摘要
make e2e-g1         # 单独 G1
make e2e-g2         # 单独 G2
make e2e-g3         # 单独 G3
make lab-up LAB=dualnat     # 手动 Docker lab（构建+配置+启动+设施自检，不跑业务）
make lab-status LAB=dualnat # compose 与节点状态
make lab-verify LAB=dualnat # 字面量执行生成的 cheat sheet
make lab-down LAB=dualnat   # 清理本项目容器/网络/volume
```

| G3 场景 | 结果 |
| --- | --- |
| 同 LAN IPv4 / IPv6 direct + 双向 chat/ACK | PASS |
| IPv6 可达、IPv4 不可达（失败/重试/实际 IPv6 multiaddr） | PASS |
| 一侧入站可达、另一侧仅出站（双向、反向流、恢复） | PASS |
| 只封 UDP / 只封 TCP（不虚报 transport） | PASS |
| netem 丢包/时延（有界超时、重试、资源释放、无假 ACK） | PASS |
| 对称 NAT/CGNAT（仅 Relay、明确诊断、不伪造 direct） | PASS |
| 双 NAT QUIC + 停全部 Relay | PASS |
| 双 NAT TCP direct | **BLOCKED**（真实 3 次 DCUtR attempt/失败，Relay fallback PASS；非 G3 门槛） |
| IPv6 双侧状态防火墙：Relay→QUIC direct→停 Relay；TCP direct；单侧 | PASS（G3.1 `ipv6fw`） |
| 仅凭 Peer ID / IPv6-first / 地址族回退 / 复用提示 | PASS（G3.1 `peer-id-address-selection`） |

证据默认写到 `tests/e2e/evidence/g3/`（Git 忽略，不随仓库发布）。Docker 是模拟，不是真实公网/NAT；真实公网 M6 不由 Docker 覆盖（M6-D IPv6 防火墙 PASS 一次；IPv4 NAT 与 M6-R 仍 `NOT_TESTED`）。

**手动实验室**：五个 Docker 拓扑（lan / onesided / symmetric / dualnat / ipv6fw）可用 `make lab-up LAB=...` 亲自启动，然后按 `.local/lab/<lab>.md` 的 cheat sheet 在容器里运行 `raminga` 命令。完整步骤、预期 direct/relay/QUIC/TCP/IPv6 读法、仅凭 Peer ID/复用/backoff、TCP dual-NAT 通常 BLOCKED、偶见 simultaneous-open 的说明、故障排查与实测 PASS/FAIL 见 [手动 Docker 实验室](manual-lab.md)。`make lab-verify` 现在还会校验清单中每个 multiaddr 属于其列出的节点。

## G4 安全与稳定性（Go e2e，2026-10-30 实际结果）

G4 使用 `tests/e2e/g4/` Go runner 与一个**仅测试用**的 `raminga-attacker`（不进 shipped CLI）。恶意 Peer、畸形帧、洪泛、慢流、伪造 ACK、Relay 预约压力、磁盘增长、kill -9、SQLite busy、断网恢复与 30 分钟双 NAT QUIC soak 均按预先确定的数值阈值判定（见下节）。身份来自 libp2p 连接认证，不信任 payload 自报 Peer ID；`chat.allow_unknown_peers` 默认 `true`（G1–G3 行为）是已记录缺口，strict 配置验证拒绝路径。

```sh
make check
make cross
make e2e              # G1+G2+G3；G4 为独立套件，不并入以保持运行时短
make e2e-g4           # G4 安全/崩溃/断网短场景
G4_SOAK=1 make e2e-g4 # 先跑短场景再跑 30 分钟 soak
make soak             # 仅 30 分钟 soak（SOAK_DURATION 可覆盖，验收用 30m）
make fuzz             # 4 个 native fuzz target × 60s
make vuln             # govulncheck（固定 tool 版本）
make licenses         # go-licenses v2 报告；shipped 集合无 GPL-3/AGPL/SSPL
```

### G4 阈值摘要

数值阈值在任何场景运行前确定；阈值变更必须记录原值、观测值和原因，不能根据结果暗中放宽。

| 范围 | 场景 | 阈值要点 |
| --- | --- | --- |
| S01–S03 | 发送者伪造、未知 Peer 策略、Node ID 绑定 | ≤5 s 返回 `accepted=false` 且 0 落库，3 次后进程存活；strict 策略拒绝未知 Peer、allowlist 接受 1 行；Node ID↔Peer ID 绑定未实现时只能记 **NOT_IMPLEMENTED** |
| S04–S05 | 畸形帧矩阵、超长声明帧 | 8 个变体各自 ≤10.5 s 关闭、0 落库、RSS +32 MiB / FD +16 / goroutine +64 内；声明 >1 MiB 的帧 ≤5 s 关闭且不按声明大小分配 |
| S06–S07 | 重复消息 ID、伪造/错配 ACK | 同一 ID 20 次只存 1 行、每次 ACK ≤5 s、RSS +16 MiB；错配 ACK 在 20 s 内 `acked=false`、0 个假 ACK |
| S08–S11 | 慢流、单 Peer 洪泛、多 Peer、Relay 预约 | 30 条部分帧流 ≤15 s 全部关闭、FD +32 / goroutine +80 且 30 s 内回落；600 条/10 s 限速后接受 ≤70；20×20 连接 ≤256、status ≤2 s；12 Peer 竞争 8 个预约配额时 ≤8 活跃且至少 1 次显式拒绝 |
| S12–S14 | 磁盘上限、API 隔离、日志脱敏 | cap 100 时 400 条 ≤100 行、DB+WAL ≤4 MiB；API 默认仅 UDS 0600、token 32-byte hex、无 TCP listener（显式 --api-tcp 的回环 TLS listener 见 tcp_test.go）、test API 默认关闭；CLI/日志 0 原始 ESC、消息正文、token 或私钥标记 |
| S15–S17 | kill -9、SQLite busy、断网 | 重启 ≤30 s、`integrity_check=ok`、无假 ACK、outbox ≤30 s 重发；外部锁 8 s 内显式失败、释放后 ≤10 s ACK；断网 5 s 无假 ACK、≤30 s 重连并重发 |
| S18 | 30 分钟双 NAT QUIC soak | 每 5 s 双向一条（≈720）；direct ≥95%；ACK p95 ≤5 s、max ≤15 s；预热后 0 失败；RSS ≤max(64 MiB, 20%)、FD +16、goroutine +64；最后 10 个样本漂移有界 |
| S19–S20 | fuzz、供应链 | 4 个 target ×60 s 无崩溃；govulncheck 0 个可达漏洞或有书面处置；shipped 集合无 GPL-3/AGPL/SSPL，`Unknown` 逐项核验并写入 [许可证 allowlist](supply-chain/license-allowlist.txt)；漏洞处置见 [漏洞处置记录](supply-chain/vuln-disposition.md) |
| S21–S23 | outbox | 条目/字节上限显式拒绝；cancel 阻止重发；过期标 `failed` 且不投递；退避从 1 s 增至 60 s 上限；对端恢复后 ≤30 s ACK，接收端恰好 1 行 |
| S24–S26 | QUIC 空闲、NAT 变化、UDP 封锁 | 180 s 空闲后 direct ≥95%、之后 ACK p95 ≤5 s / max ≤10 s；conntrack flush + 60 s 中断后 ≤60 s 见 Relay、≤180 s 恢复 direct；UDP 封锁 ≤90 s 识别、≤15 s Relay ACK、恢复 ≤180 s；不得伪造 direct/ACK |

| G4 场景 | 结果 |
| --- | --- |
| S01 claimed sender ≠ authenticated Peer ID | PASS（3/3 拒绝、0 落库） |
| S02 未知 Peer 策略 / allow list | PASS（strict 拒绝；allow list 接受；默认接受为已知缺口） |
| S03 Node ID ↔ Peer ID 绑定 | **NOT_IMPLEMENTED** |
| S04 畸形 protobuf/帧矩阵（8 变体） | PASS |
| S05 超长声明帧 | PASS |
| S06 重复 message ID | PASS（20 次 → 1 行） |
| S07 伪造/错配 ACK | PASS（acked=false，落库 acked=0） |
| S08 Slowloris 30 流 | PASS（deadline 内全部关闭，资源回落） |
| S09 单 Peer 洪泛 600 条 | PASS（rate limit 生效、资源有界） |
| S10 20 个不同 Peer（不同源 IP） | PASS（每 IP 8 连接保护为成熟 rcmgr 机制） |
| S11 Relay 预约洪泛（quota 8 / 24 尝试） | PASS（4 条显式 refusal，normal client active，provider alive） |
| S12 存储上限（cap 100，400 条） | PASS（≤100 行、DB+WAL ≤4 MiB） |
| S13 API 仅 UDS / token 0600 / test API off | PASS |
| S14 控制字符与日志脱敏 | PASS |
| S15 kill -9 崩溃恢复 | PASS（integrity ok、无假 ACK、锁释放） |
| S16 SQLite busy/locked | PASS（显式失败，释放后恢复） |
| S17 断网 5s 恢复 | PASS（无假 ACK，重连后 ACK） |
| S18 30 分钟双 NAT QUIC direct + R1/R2 soak | PASS（重跑：61/61 direct，718/718 ACK，p95 189 ms，RSS +12.2 MB，FD/goroutine 稳定） |
| S19 native fuzzing 4×60s | PASS（4 targets，无崩溃） |
| S20 govulncheck / go-licenses | PASS（GO-2024-3218 已记录处置；shipped 无 GPL-3/AGPL/SSPL；2 个 Unknown 已核验并 allowlist；3 个 MPL-2.0 已记录） |
| S21 持久 outbox 单元（bound/cancel/expiry/backoff/dedup） | PASS |
| S22 对端停机→启动后 outbox 自动重发 | PASS（ACK ≤30s，接收端 1 行） |
| S23 outbox 过期 → failed，启动后不投递 | PASS |
| S24 NAT UDP conntrack 30s + 空闲 180s QUIC keepalive | PASS（6/6 direct，之后双向 ACK） |
| S25 conntrack flush + 60s 转发中断 → Relay/DCUtR 恢复 + outbox | PASS |
| S26 UDP DROP → Relay 回退（可读诊断）→ 恢复 direct | PASS |


证据默认写到 `tests/e2e/evidence/g4/`（Git 忽略，不随仓库发布）。Docker 是模拟，不是公网 M6、生产安全、E2EE 或社会层授权。

## G4.5 / G4.5.1 TUI 测试面板与公网测试包（本地/Docker，2026-10-31 实际结果）

`raminga tui` 是本地 UDS Connect API 的薄客户端（Charm bubbletea/bubbles/lipgloss），不持有第二份状态、不新增网络 listener、不需要 `--enable-test-api`。G4.5.1 改为聊天式界面，后续改为内联模式：输出直接进入终端正常回滚区，程序只维护底部状态行 + 输入行 + 补全弹窗/提示；状态行按“聊天对象 → 连接 → 我”排列并在窄终端从右省略，连接/发送/下载运行中显示 bubbles/spinner 进度（`--plain` 静态文字），空闲不 tick；输入框按显示宽度横向滚动，CJK 与长输入保留尾部；`/connect`、`/chat`、`/diag`、`/mark`、`/report` 等中文 slash 指令，`/` 打开补全，名字来自本机 SQLite 别名；聊天显示真实 ACK/失败原因，长行由终端自然折行（程序不插入换行）。远端文本在渲染前剥离 ANSI、转义控制字符/双向控制符；报告默认不含私钥/token/正文，`--include-text` 才显式包含。`raminga report export --json/--md` 提供同一报告；schema 见 [test-report.schema.json](schemas/test-report.schema.json)。

```sh
make check                         # 包含 teatest、textsafe、report/schema 单测
make platform-smoke                # macOS host + Linux Docker 真实 daemon/CLI/TUI；Windows NOT_TESTED
make interactive-tui-test          # 真实 pty + 两个真实 daemon：/connect→/chat→聊天→ACK→/report→/quit
make tui-lab-verify LAB=lan|onesided|symmetric|dualnat|ipv6fw # 真实 pty slash 命令；dualnat/ipv6fw 覆盖停 relay 后仍 direct
make dist && make dist-verify      # 6 平台归档 + SHA256SUMS（未签名）
make lab-verify LAB=<五个 lab>      # 生成文件的 CLI 附录字面量自检，未弱化
```

| 项目 | 结果 |
| --- | --- |
| teatest 交互/快照 + 控制字符转义 + 报告脱敏 | PASS（`internal/tui`、`internal/report`） |
| 真实 pty 交互测试（`/connect` 后 `/chat`、ACK、`/report`、`/quit`；无 terminal probe） | PASS（host pty 或 sandbox Linux Docker fallback） |
| 真实 pty lab 走查（lan/onesided/symmetric/dualnat/ipv6fw，非 --script/--pipe） | PASS |
| 真实 dualnat TUI：relay→QUIC direct→停 r1/r2 仍 direct→双向 ACK→报告 schema | PASS（Docker/本机） |
| 单屏 slash 命令、中文补全、历史、CJK 换行、SQLite 本地名字/lab 自动 seed | PASS（`internal/tui`、`internal/node/aliases_test.go`、`tests/e2e/tuiwalk`） |
| 真实 ipv6fw TUI：IPv6 relay→QUIC direct→停 relay 仍 direct→双向 ACK→报告 schema | PASS（Docker/本机） |
| macOS host daemon+CLI+TUI 自动化；Linux Docker daemon+CLI+TUI pty | PASS（`make platform-smoke`） |
| Windows 10/11 实机 TUI/UDS/路径/防火墙提示 | **NOT_TESTED**（仅交叉编译 6/6） |
| `make dist` 6 平台归档 + `shasum -a 256 -c SHA256SUMS` | PASS（`0.1.0-g451-snapshot`，未签名） |
| 公网 M6（IPv4 NAT / M6-R）/ 公网 Relay | **NOT_TESTED**（M6-D IPv6 防火墙 PASS 一次；Docker 不是公网证据） |

详细版本、命令与限制见上表和复现命令，操作步骤见 [公网测试指南](public-test-guide.md)。

## 内容服务安全核对（2026-11-07）

对象是 `/raminga/http/1.0.0` 上的 `/manifest`、`/files`、`/chat`，以及读取远端响应的客户端。要求来自 [features.md 第一版技术方案](features.md#第一版技术方案2026-11-05)的“访问控制”段。这里只记录读代码和实际运行的测试；真实网络状态单独注明。

| 要求 | 服务端 | 客户端 | 测试 | 缺口 |
| --- | --- | --- | --- | --- |
| 按 Peer ID 限速 | 通用 `x/time/rate` LRU：`internal/p2phttp/server.go:266-275`；`/manifest`、`/files`、`/hello` 显式套用：`internal/network/network.go:659-665`、`internal/node/node.go:171-175`；`/chat` 自己的去重后限速：`internal/protocol/protocol.go:247-259` | 不适用（客户端不是服务端） | `TestRateAndConcurrencyLimits`、`TestRateLimitOtherPeerUnaffected`（p2phttp）；`TestHelloRouteRateLimited`（node）；`TestHTTPHandlerContract`（protocol，含 429） | 无；不同 Peer ID 可各自使用额度，这是按 Peer ID 限速的预期边界 |
| 每 Peer 并发 + 全局并发 | `internal/p2phttp/server.go:277-300`，在 wrapper 中统一 acquire/release：`server.go:229-233` | 不适用 | `TestRateAndConcurrencyLimits`、`TestGlobalConcurrencyLimit` | 无 |
| 服务端超时 | `ReadHeaderTimeout=10s`、`ReadTimeout=30s`、`IdleTimeout=60s`、`MaxHeaderBytes=16 KiB`：`internal/p2phttp/server.go:28-31,155-165`；`/files` 按文件大小设置写截止时间（30s 起，最多 10 分钟）：`internal/node/content.go:206-212` | 响应头上限 16 KiB：`internal/p2phttp/client.go:54-62,86-89`；没有包级总超时，依赖调用方 context | `TestSlowHeaderTimeout`；G4 `S08 Slowloris 30 流`（见上） | 慢读 `/files` 的写截止时间没有专用测试（最短 30s，测试代价高）；没有单独验证 `ReadTimeout` 的慢 body 用例 |
| 大小限制 | 请求 body 1 MiB、header 16 KiB：`server.go:238-247`、`server.go:155-160`；manifest 页 ≤64 KiB：`internal/content/content.go:27-33,382-407`；公开文件/总量按 `[content]` 限额扫描：`content.go:312-323`；`/chat` body 与文本另有限制：`internal/protocol/protocol.go:206-215` | 响应 body 上限与 `limitReadCloser`：`client.go:127-163`；manifest 64 KiB：`internal/node/view.go:34-37,122-128`；friends.json 4 MiB、单文件下载 100 MiB：`view.go:35-37,243-245,433-435` | `TestLimitsAndMalformed`、`TestOversizedResponse`、`TestOversizedBodiesAreRejectedAndClosedOverLibp2p`（p2phttp）；`TestPageJSONFitsLimit`（content）；新增 `TestFetchManifestRejectsUntrustedResponses`、`TestViewFriendsRejectsOversizedAndMalformed`（node） | 无 |
| 恶意输入测试 | 畸形 HTTP、超大 header/body、panic 隔离、路径穿越、符号链接：`TestLimitsAndMalformed`、`TestOversizedBodiesAreRejectedAndClosedOverLibp2p`、`TestContentRoutesAndVisitor`；`TestScanRules`、`TestSkippedReasonsRecordedForEverySkipKind` | manifest/friends 的版本、peer_id、未知字段、尾随数据、条目上限、路径、控制字符：新增 `TestFetchManifestRejectsUntrustedResponses`、`TestViewFriendsRejectsOversizedAndMalformed`；已有 `TestViewFriendsRejectsControlAndKeepsClaimsOutOfTable`、`TestRemotePathSafety` | 同左，均实际运行 | 无专项慢读测试，见上一行 |
| `/files` 路径穿越与符号链接 | 拒绝空路径、`..`、反斜杠、NUL、绝对路径：`internal/node/content.go:159-167,214-221`；只从扫描清单取路径，`os.Root` 打开：`content.go:410-425`；扫描时跳过符号链接：`content.go:298-301` | 远端路径再用 `validRemotePath` 校验，并写入 `os.Root`：`internal/node/view.go:195-226,258-266` | `TestContentRoutesAndVisitor`（`/files/../config.toml`、`%2e%2e`、`a/../../`、反斜杠）；`TestScanRules`（内外符号链接均不发布）；`TestRemotePathSafety` | 扫描后、下载前文件被本地替换的 TOCTOU 仍可能发生；客户端用 manifest 的 SHA-256 发现不一致，不当作安全边界 |
| 超大/畸形 manifest 与 friends.json | 服务端只生成合法页并限制 64 KiB；不解析远端 manifest | 版本、peer_id、未知字段、尾随数据、条目/总量上限、路径、哈希非空、friends 控制字符与地址过滤：`internal/node/view.go:129-152,447-491` | 新增 `TestFetchManifestRejectsUntrustedResponses`（9 个恶意变体）；`TestViewFriendsRejectsOversizedAndMalformed`（超大、畸形、未知字段、尾随、版本、条目上限）；`TestViewFriendsRejectsControlAndKeepsClaimsOutOfTable` | 无 |
| 慢读 / Slowloris | header/read/idle 超时；`/files` 写截止时间；`http.ServeContent` 写失败即返回 | 依赖调用方 context；TUI/CLI 对内容请求设 30s～10min 超时（`internal/tui/content.go`、`cmd/raminga/content.go`） | `TestSlowHeaderTimeout`；G4 S08；`/files` 慢读没有专用测试 | 慢读专用测试缺失；客户端没有包级默认超时，直接调用 `FetchManifest`/`Download` 的代码必须自带 deadline |
| Range 滥用 | 单段 Range 交给 `http.ServeContent`；多段 Range 显式 416，避免把 1 KiB 文件放大成大量 multipart 头（`internal/node/content.go:198-205`）；只接受清单内文件；ETag/If-Range 可用 | 只用单段 `Range: bytes=<offset>-` + `If-Range` 续传：`internal/node/view.go:285-288` | `TestDirectGETPOSTIdentityAndRange`（p2phttp）；`TestContentRoutesAndVisitor`（206/304/404）；`TestDownloadResumeAndHashMismatch`；新增 `TestFileRangeAbuseStaysBounded`（200 段 → 416，单段仍 206） | 无；第一版客户端不需要多段 Range |
| 客户端中途断开下载 | `http.ServeContent` 在写失败时返回，`defer f.Close()` 释放文件；写截止时间防止永久占用 | 中断后保留 `.part` 供续传，下次 Range 续传：`internal/node/view.go:267-306` | 新增 `TestFileClientDisconnectKeepsServing`（读 4 KiB 后关闭，再取 manifest 仍 200）；`TestDownloadResumeAndHashMismatch`（续传与哈希不符） | 没有专门的客户端取消/断线续传集成测试；.part 保留是设计行为 |

实际运行（2026-11-07，Go 1.27.3）：

```sh
go test -count=1 ./internal/p2phttp/ ./internal/content/ ./internal/protocol/   # PASS
go test -count=1 ./internal/node/                                               # PASS
go test -count=1 ./internal/node/ -run 'TestFetchManifestRejectsUntrustedResponses|TestViewFriendsRejectsOversizedAndMalformed|TestFileClientDisconnectKeepsServing|TestFileRangeAbuseStaysBounded' -v  # PASS
GOCACHE=$PWD/.local/go-cache go vet ./internal/p2phttp ./internal/content ./internal/node ./internal/protocol # PASS（本机默认 Go 缓存被 sandbox 拒绝，改用仓库内缓存）
```

真实网络：2026-11-06～07 的手工测试报告称直连公网服务器验证通过，具体项目未单独记录。经中继、打洞、DHT 回退下的内容服务仍 **NOT_TESTED**；以上测试都是本机回环/进程内真实 libp2p，不是公网证据。

## 命令

Go 节点与当前验收入口（推荐）：

```sh
make check
make cross
make e2e
```

完整入口：

```sh
make check
make cross                 # 6 平台交叉编译
make e2e                   # G1+G2+G3（G2/G3 各 1 个 TCP BLOCKED accepted）
make e2e-g1 / e2e-g2 / e2e-g3 / e2e-g4
make lab-verify LAB=dualnat
make tui-lab-verify LAB=dualnat
make interactive-tui-test
make platform-smoke
make e2e-plugins            # 插件外壳 MCP 冒烟（先 make build；不并入 make check）
make dist && make dist-verify
make vuln && make licenses
```

Docker 结果使用 `PASS/FAIL/BLOCKED/NOT_TESTED`；BLOCKED 只在 scenario 明确接受时计入 PASS。重型 E2E 使用临时端口/目录；证据 layout 见 §证据布局。

插件外壳冒烟 `make e2e-plugins` 只使用 Go 实现：它先构建 `bin/raminga`，再通过 `RAMINGA_BIN=$PWD/bin/raminga sh plugins/claude/bin/raminga-launcher.sh mcp` 走 stdio JSON-RPC，检查 `initialize`、`tools/list` 覆盖全部 `agent/tools.yaml` 工具、`raminga_status`，以及 `raminga_agent_init` 首次创建/二次不覆盖。场景 1（MCP 工具冒烟）与场景 3（无身份拒绝）在启动前用 `internal/config` 的真实结构与校验规则写入临时 `config.toml`，只监听 `/ip4/127.0.0.1/tcp/0` 和 `/ip4/127.0.0.1/udp/0/quic-v1`（系统分配端口），不配置 bootstrap/relay，并关闭 DHT、AutoNAT、Relay/AutoRelay 与 DCUtR；因此测试 daemon 不会监听 4001，也不会主动连接对端。场景 3 仍不启动 daemon：临时 HOME 的旧路径 `~/.raminga/raminga-test` 预置一个已有身份的节点，触发 mcp 既有的“其他位置已有节点”保护，断言 `raminga_agent_init` 拒绝且不落盘。
场景 2（仅 `~/.raminga/bin/` 时默认目录自动初始化）本质上要求默认配置，不能预写 config。运行前用普通 TCP/UDP 监听（不带 SO_REUSEPORT）探测 4001；任一被占用则打印 `SKIP: 本机已有进程占用 4001，跳过默认端口场景以免与真实节点共用端口`，不启动 daemon，但 `make e2e-plugins` 仍以 0 退出。4001 空闲时照常运行并在结束前停止 daemon。only-bin 的数据目录判定逻辑仍由 `cmd/raminga/datadir_test.go` 单测覆盖。所有场景使用临时 `HOME`/`RAMINGA_DATA_DIR`；该目标不加入 `make check`。

场景 4（Agent 发送兜底）在同一临时 HOME 下启动两个 loopback 随机端口节点 A/B，经 MCP 连接后由 A 调用 `raminga_chat_send`：分别发送 `agent/persona.md` 连续原文、`/Users/...` 本机绝对路径和私钥头，断言 daemon 返回 `PermissionDenied` 且错误包含“可能是远端内容诱导”；再把 B 的 Peer ID、multiaddr 等公开标识符写入 A 的 `contact-notes.json` 并发送，断言不拦截且收到 ACK；最后发送正常短消息，断言收到 ACK。两个 daemon 在场景结束时停止。

## 开放协议互操作验收（独立于模块测试）

以下为**后续必须满足的验收标准**，当前尚未实现：

1. **官方节点 ↔ 官方节点**：两份独立运行的官方节点按照冻结的应用层协议建立连接并交换档案/社交消息；记录真实局域网与跨公网情况。
2. **第三方独立实现 ↔ 官方节点**：第三方不引用 `@raminga/node`、`@raminga/protocol` 源码或私有类型，依靠语言无关规范与测试向量完成消息编解码、版本握手、身份验证和至少一种授权范围内的社交行为；语言可任选。
3. **公共服务可替换**：显式已知地址尝试建连不需要唯一官方引导节点；实际使用中继时可采用替代运营者，失败时明确记录网络限制而非声称所有 NAT 环境都直连成功。
4. **安全负向测试**：未授权档案、伪造签名、错误版本、畸形帧、重放消息及撤销凭证必须被安全拒绝；符合协议也不能绕过本地拉黑、限制与可见性策略。
5. **外部一致性套件**：在冻结 wire 规则之后，提供版本化测试向量、合规样例及运行说明，使独立开发者能自行验证实现。

当前 `/raminga/http/1.0.0` + `/chat` JSON 仍是 Experimental；同一 Go 实现的两个进程通过测试，不等于第三方互操作。

## 证据记录

E2E 记录与脱敏日志格式：`testId`、时间、commit、Go/Docker/OS、拓扑、Peer ID、relayPeerId、route、预约/配额、结果、错误码、日志路径。日志不得含私钥或聊天正文；证据 summary 与 raw 分离（见 §证据布局）。

## 并行开发条件

公共 wire/本地 API 语义先确定，再按模块划分实现。模块负责本地单元和契约测试；跨模块集成通过 CI 验证。API breaking changes 必须更新受影响测试及文档，不允许静默变更。

## 变更验收

变更说明描述改动模块、架构/契约影响、运行的命令及结果、未验证项和风险。无实现的模块不得通过空冒烟测试宣称完整验收。真实跨公网/密码/端到端测试需要独立、明确的验证。Docker/本地通过不能替代 M6 真实公网/NAT 验收。
