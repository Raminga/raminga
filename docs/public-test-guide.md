# Raminga 公网连接测试指南（中文）

Status: **G4.5.1 交付文档** · 适用版本：`0.1.0-g451-snapshot` 及同源构建 · 更新：2026-10-31

本指南面向真实公网测试：由**你自己控制的一台可被外部连接的 Raminga 节点**充当 Relay/Bootstrap，其他测试机从不同网络连接它，用 `raminga tui` 完成 Relay → 直连（DCUtR）→ 停 Relay 仍直连 → 双向聊天 → 导出报告。它包含真实公网 M6-R/M6-D 的 Go/TUI 验收步骤，但不替代测试人员对 M6 的最终判定。

> **诚实边界：** Docker lab 的 PASS **不是**公网结果；只看到 DCUtR attempt **不是** direct；relay 上的 ACK **不是**打洞成功；本指南不会自动把任何结果写成 M6 PASS。没有可被外部连接的 Raminga 节点时，双 NAT 场景只能记 **BLOCKED**。测试结束必须停止节点/Relay 并撤销临时端口开放。

## 1. 角色与拓扑

至少两台机器、两种角色：

| 角色 | 数量 | 要求 | 作用 |
| --- | --- | --- | --- |
| Relay/Bootstrap 节点 | 1（建议 2 台） | 可被公网 TCP+UDP 直连；稳定 IP | Circuit Relay v2 provider；DHT bootstrap；让受限节点先建立 limited relay 连接 |
| 测试机 A / B | 各 1（建议不同网络） | 能出站访问公网；可安装 Raminga | 运行 `raminga`（自动启动 daemon + TUI），做 Relay→direct→chat |
| 测试机 C（可选） | 1 | 只做对照 | 例如只开 IPv4、只开 IPv6、对称 NAT/CGNAT、手机热点 |

**只能使用 Raminga 节点做 Relay/Bootstrap/AutoNAT 探测。** 不添加公共 IPFS bootstrap、公共 STUN、厂商 Relay 或 UPnP/NAT-PMP。Raminga 默认不启用这些路径，配置中也没有它们的代码路径。

## 2. 前提：一台可被外部连接的 Raminga 节点

满足以下**任意一种**：

1. 云主机/独立服务器有**公网 IPv4**，安全组/防火墙放行 TCP 4001 与 UDP 4001；
2. 有**公网 IPv6**，云防火墙与主机防火墙放行 TCP/UDP 4001；
3. 家宽有公网 IPv4 且做了 **端口转发**（TCP+UDP 4001 → 内网机器）；
4. 自有云 VM（最省事，推荐）。

不满足时：宽带处于 **CGNAT**（WAN 地址不是公网地址）时端口转发无效；只有内网 IP、没有公网 IPv6 的机器不能充当公网 Relay。此时双 NAT 直连测试记 **BLOCKED**，不要伪造。

Relay/Bootstrap 节点要求：

- **不需要域名或 CA 证书。** libp2p 用 Peer ID + multiaddr 寻址；Noise / QUIC-TLS 自带身份认证。
- 开放 **TCP + UDP 4001**（默认；可用 `--listen` 改端口，但两边要一致）。QUIC 走 UDP，TCP 走 TCP；只开一个会限制可用传输。
- **建议双栈**：同时有公网 IPv4 和 IPv6。只有 IPv6 时，IPv6-only 测试机能连，IPv4-only 测试机不能。
- IP 尽量稳定；IP 变化后所有测试机要更新 `--bootstrap` 和 relay 地址。
- 硬件要求低：Relay 是 limited 的 Circuit Relay v2，只做协调/转发；1 vCPU / 512 MB 起即可，真实带宽取决于测试消息量。
- 不启用 UPnP/NAT-PMP，不做静默端口映射。
- provider 配额始终生效（默认 `max_reservations=128`、per-IP 8、per-peer 1、data 128 KiB/direction、duration 2m）；不要为了测试关闭配额。

### 2.1 Relay/Bootstrap 节点自查

在 Relay 主机上：

```sh
# 1) 确认全局地址（不要拿 192.168/10./172.16-31 或 fe80:: 当公网地址）
ip -6 addr show scope global
ip -4 addr show scope global

# 2) 确认默认出口 IP 与 WAN/弹性 IP 一致（CGNAT 时通常不一致）
curl -4 -s https://ifconfig.me; echo
curl -6 -s https://ifconfig.me; echo

# 3) 确认端口真的在监听（Raminga 启动后）
ss -lntup | grep 4001

# 4) 从另一台外部机器测试 TCP 可达（示例，替换 IP）
nc -vz 203.0.113.10 4001

# 5) UDP 没有 TCP 那样的 connect 成功语义；以测试机实际 connect/relay 成功为准
```

云安全组、系统防火墙（ufw/firewalld/nftables/Windows Firewall）都要放行；只改其中一层不够。

### 2.2 启动 Relay/Bootstrap

```sh
# 在公网节点上；把 announce 换成真实公网地址
raminga init --data-dir ~/raminga-relay \
  --relay-provider \
  --announce /ip4/203.0.113.10/tcp/4001 \
  --announce /ip4/203.0.113.10/udp/4001/quic-v1

raminga daemon --data-dir ~/raminga-relay
```

不必写 `--listen`：默认同时监听 IPv4/IPv6。`--announce` 只在云 1:1 NAT 隐藏公网 IPv4 时需要；网卡上的公网 IPv6 会自动公告。家庭路由器常阻断入站 IPv6；云服务器需分配 IPv6 并在安全组/主机防火墙放行。启动后：

```sh
raminga status --data-dir ~/raminga-relay          # peer_id / listen / announce
raminga relay status --data-dir ~/raminga-relay    # provider.enabled=true 及配额
raminga network status --data-dir ~/raminga-relay  # DHT / resources / AutoNAT
```

把 `peer_id` 和实际 multiaddr（必须含 `/p2p/<relay-peer-id>`）发给测试机，例如：

```text
/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
/ip4/203.0.113.10/udp/4001/quic-v1/p2p/12D3KooW...
```

## 3. 获取二进制或从源码构建

安装、PATH、SHA256 校验、macOS quarantine、Windows SmartScreen、从源码/交叉编译与首次运行的完整说明见 [安装与构建指南](install.md)。本指南后续假设 `raminga` 已在 PATH 或使用 `./bin/raminga`。

## 4. 准备测试机 A / B

每台测试机：

```sh
raminga init --data-dir ~/raminga-test \
  --bootstrap /ip4/203.0.113.10/tcp/4001/p2p/<relay-peer-id>

raminga --data-dir ~/raminga-test   # 自动启动 daemon 并打开 TUI
```

需要看前台日志时，改用 `raminga daemon --data-dir ~/raminga-test`，另开终端 `raminga tui --data-dir ~/raminga-test`。

- `--bootstrap` 可重复；必须含 `/p2p/<peer-id>`；不能填 `/p2p-circuit` 地址，也不能填公共 IPFS/libp2p bootstrap（会被严格拒绝）。
- 客户端不需要预先配置 `--known-relay`：在 TUI 执行 `/connect <relay 地址>` 后，该 Relay 会成为候选并自动获得 circuit 地址；`/copy` 可复制。
- `--announce` 只用于你有固定公网地址/NAT 映射的节点；它**不会**创建端口映射。
- 不要在测试机启用 `--relay-provider`，除非它也有公网可达地址。
- daemon 只监听 libp2p TCP/UDP；本地 API 仍然只在 `<data-dir>/api.sock`，token 0600，没有 TCP API listener。TUI 不需要 `--enable-test-api`。

查看并复制本机信息：

```sh
raminga status --data-dir ~/raminga-test
```

启动 TUI 后先 `/connect /ip4/203.0.113.10/tcp/4001/p2p/<relay-peer-id>`，等日志出现 relay reservation，再 `/copy` 取得本机 circuit 地址。把每台测试机的 **Peer ID** 和 relay circuit 地址互换。circuit 地址格式：

```text
<relay 的 /p2p/<peer-id> 地址>/p2p-circuit/p2p/<目标 peer-id>
```

例如：

```text
/ip4/203.0.113.10/tcp/4001/p2p/<relay-peer-id>/p2p-circuit/p2p/<B-peer-id>
```

## 5. 用 TUI 完成测试（推荐）

A 机：

```sh
raminga --data-dir ~/raminga-test
```

内联界面：输出直接进入终端正常回滚区，滚动/选择/复制交给终端；程序只维护底部实时区域（状态行、输入行、补全弹窗或一行提示）。状态行显示聊天对象、连接数、自己的名字；连接/发送/下载时显示 spinner 进度，窄终端从右往左省略。Home/End 在输入行内移动光标。输入 `/` 打开中文指令补全；↑/↓ 选择，Tab 只补全，Enter 确认当前高亮指令/参数后执行，Esc 关闭。名字/Peer ID 参数也会补全。输入非空时 Ctrl+C 清空输入，输入为空时退出。长行不插入换行，由终端自然折行；远端文本会转义控制字符，不会被当作命令。`/copy` 和 `/status` 的地址带完整 `/p2p/<PeerID>`；`/status` 先打印地址标签，再单独打印完整地址，“本机：”显示完整 Peer ID。

逐步操作：

1. **先建立名字（可选）**：
   ```text
   /name <B-Peer-ID> b
   /peers
   ```
   名字只保存在本机 SQLite，不会发到网络，也不会自动拨号。
2. **连接并观察 relay → direct**：
   ```text
   /connect b
   ```
   预期日志：
   ```text
   ✓ 已连接 b：中继/TCP（经中继 <relay>，受限）
   … 等待打洞（DCUtR）升级为直连
   ✓ 已升级为直连/QUIC /ip4/.../udp/4001/quic-v1
   ```
   只有 `中继/...（经中继 ...，受限）` 是 limited relay；只有 `✓ 已升级为直连/...` 才是 direct。没有这行就记 **relay-only**，不要写 direct。对称 NAT/CGNAT、UDP 被封锁时很常见。
3. **选择聊天对象并发送**：
   ```text
   /chat b
   hello from A
   ```
   预期 `→ b：hello from A ✓ 7 ms`（经中继时行尾还有 `经中继`）。在 B 的 TUI 里 `/chat a` 后回一条，B 也看到 ACK。
4. **看诊断**：
   ```text
   /diag
   /peers
   ```
   日志会给出“仅中继可用”“双 NAT 下 TCP 直连 BLOCKED”“UDP 被封 → 中继”等中文解释；不会把 attempt 写成 direct。
5. **停 Relay 后验证仍直连**：在 Relay 节点停止 daemon/实例或封端口；回到 A 的 TUI：
   ```text
   /mark 已停中继
   ```
   等至少 10 秒；若日志出现 `✓ 停中继后直连仍然保持（已观察 10 秒）`，报告才写 `still_direct_after_relay_stop=true`。否则为 `false`/`null`，不会猜。
6. **导出报告**：
   ```text
   /report
   ```
   默认脱敏；所有参与者明确同意时才 `/report --include-text`。报告写到 `<data-dir>/reports/test-report.json|md`。
7. **退出**：输入为空时 `/quit` 或 `Ctrl+C`（输入非空时 Ctrl+C 先清空）；daemon 继续运行。需要停止时回到 shell `Ctrl+C` 或 `kill` daemon。

更多命令：`/status`（本机概况）、`/disconnect <名字|Peer ID>`（断开并持久暂停自动重连；再次 `/connect` 解除）、`/outbox`（待发/失败）、`/cancel <id>`、`/copy`（OSC52 + 文本回显）、`/clear`、`/help`。

## 6. CLI 等价操作

不使用 TUI 时，逐条对应：

```sh
# 本机信息 / 本地名字（只在本机，不上网络）
raminga status --data-dir ~/raminga-test
raminga friends name b 12D3KooW... --data-dir ~/raminga-test
raminga friends list --data-dir ~/raminga-test
raminga friends remove b --data-dir ~/raminga-test
raminga peers --data-dir ~/raminga-test
raminga network status --data-dir ~/raminga-test

# 经 relay 连接 B（circuit 地址）
raminga connect '/ip4/203.0.113.10/tcp/4001/p2p/<relay-peer-id>/p2p-circuit/p2p/<B-peer-id>' --data-dir ~/raminga-test

# 断开当前连接（对方可能因 Relay/DHT/outbox 重试重连）
raminga disconnect <B-peer-id> --data-dir ~/raminga-test

# 等待后看是否 direct
raminga peers --data-dir ~/raminga-test
raminga network status --data-dir ~/raminga-test

# 双向聊天
raminga chat send --to <B-peer-id> --text 'hello from A' --data-dir ~/raminga-test
raminga chat send --to <A-peer-id> --text 'hello from B' --data-dir ~/raminga-test

# 查看事件（另一个终端；Ctrl+C 退出）
raminga chat events --data-dir ~/raminga-test

# outbox
raminga chat outbox --data-dir ~/raminga-test
raminga chat cancel <message-id> --data-dir ~/raminga-test

# 导出报告（默认脱敏；显式包含正文才加 --include-text）
raminga report export --data-dir ~/raminga-test
raminga report export --json --data-dir ~/raminga-test
raminga report export --md --data-dir ~/raminga-test
```

停 Relay 后，`raminga peers` 仍应显示目标 peer `route=direct direct=true limited=false`；随后再发消息并确认 `acked: true`。

## 7. 预期结果与判定

| 检查 | PASS | 不算 PASS |
| --- | --- | --- |
| 初始连接 | `route=relay limited=true direct=false` | 把 relay 写成 direct |
| 打洞 | 真实 `route=direct direct=true limited=false`，地址不含 `/p2p-circuit` | 只有 DCUtR attempt/success 计数，但连接仍 relay |
| 停 Relay 后 | 同一 peer 的 direct 连接仍存在 ≥10 秒，报告 `still_direct_after_relay_stop=true` | 停 Relay 后连接断开/回退，或没有观察就写 true |
| 双向聊天 | A→B 与 B→A 都有真实匹配 ACK，接收端看到文本 | 只有单向，或把 outbox pending 当 ACK |
| 报告 | JSON 通过 `docs/schemas/test-report.schema.json`；无密钥/token；正文默认不含 | 报告包含私钥/token/未脱敏正文 |
| 网络条件 | 记录真实公网 IPv4/IPv6、NAT 类型、是否 CGNAT | 用 Docker 结果冒充公网 M6 |

`AutoNAT: unknown` 只表示**没有 Raminga 探测节点**，不等于 unreachable。`TCP direct` 通常 BLOCKED（Docker 偶见 simultaneous-open，非确定性）是已知限制，不阻塞 QUIC direct/停 Relay 的验收，但必须如实写。

## 8. 报告提交

把以下文件一起提交（不要提交密钥、token、`identity/` 或完整 `config.toml` 中的敏感路径）：

```text
test-report.json
test-report.md
（可选）TUI/CLI 的关键终端输出，去掉 Peer 之外的隐私
```

报告包含：Raminga 版本/commit、OS/arch、时间、NAT 诊断、连接时间线、route/transport 变化、ACK 结果、outbox、停 Relay 后是否仍 direct。默认**不含**聊天正文；只有在所有参与者同意并且你显式加 `--include-text`（TUI 同理）时才包含正文。

提交前可用仓库里的 schema 校验：

```sh
go run ./tests/e2e/g45 -report test-report.json \
  -schema docs/schemas/test-report.schema.json \
  -forbid 'your secret marker'
```

把报告交给维护者（提交方式由维护者指定）；说明：日期/时间（UTC）、两台测试机的网络类型（家宽/云/手机热点/VPN）、是否有公网 IPv4/IPv6、是否 CGNAT、Relay 位置、结果 PASS/BLOCKED/FAIL。**不要**把 Docker 结果写成公网 M6。

## 9. 测试结束清理

1. A/B：退出 TUI，然后 `raminga stop --data-dir ~/raminga-test`；前台 daemon 用 `Ctrl+C`（不要用 `kill -9`，除非专门测崩溃恢复）。
2. Relay：`raminga stop --data-dir ~/raminga-relay`；前台 daemon 用 `Ctrl+C`。
3. 云安全组/系统防火墙：撤销临时开放的 TCP/UDP 4001。
4. 家宽端口转发：删除临时规则。
5. 删除测试 `--data-dir`（含身份/密钥）或妥善保管；不要把 `identity/` 发给任何人。
6. 如使用云 VM，确认实例已停止/释放，避免继续计费。

## 10. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| Relay 连不上 | 端口未放行、CGNAT、announce 地址错、Peer ID 不匹配 | 从外部 `nc -vz` 测 TCP；核对 `/p2p/<id>`；云安全组 + 主机防火墙都放行 |
| 只有 relay，无 direct | 对称 NAT/CGNAT、UDP 被封锁、双方都不可入站 | 看 Diagnostics 的 `DCUtR failures` / `UDP blocked`；换网络（手机热点/云）复测；不要写 direct |
| TCP direct BLOCKED | 真实 NAT 不支持可预测端口/TCP 同时打开 | 保持 QUIC direct 或 relay fallback；记录真实 BLOCKED 或偶见 direct，不保证 |
| IPv6 连不上 | 只有链路本地/ULA、防火墙 DROP、没有全局地址 | `ip -6 addr show scope global`；放行 IPv6 TCP/UDP 4001；用外部 IPv6 测试 |
| AutoNAT unknown | 没有 Raminga 探测节点 | 这是 unknown，不是 unreachable；不是失败原因 |
| 报告没有正文 | 默认脱敏 | 只有明确同意才加 `--include-text` |
| `still_direct_after_relay_stop` 为 null | 没有按 `m` 标记，或观察不足 10 秒 | 按流程重做；不要手工改 JSON |

## 11. 真实公网 M6-R / M6-D（真实设备手工验收）

Docker/lab 不是公网证据。需要两台**独立异地设备**（不同网络/运营商）和一个双方可达的真实公网 Relay；A/B/R 使用同一 Go commit，记录 `git rev-parse HEAD`、`git status --porcelain`、Go 版本、时间、网络类型、Peer ID/Node ID 与脱敏证据。Relay provider 默认 off，M6 用 `raminga init --relay-provider` 显式开启并在 `config.toml` 调整配额；A/B 只出站，不做静态 DNAT/端口转发/UPnP。A/B 身份必须来自各自 dataDir，不复制。

**M6-R（仅真实公网 Relay）**
1. Relay R 启动：`raminga init --data-dir ... --relay-provider --announce /dns4/<relay>/tcp/4001` 后启动 `raminga daemon --data-dir ...`（或 systemd）；记录 R 的 Peer ID/公告地址/配额。
2. A/B 配置已知 Relay、允许对方 Peer ID，启动 daemon/TUI；在 A `/connect <R multiaddr>`，在 B 同样与 R 建立 reservation；等待双方 `/diag` 显示 R reservation active。
3. A `/connect <B relayed addr>`（或 `/connect <B peer id>`），`/chat B`；A→B ≥3 条、B→A ≥2 条。每条日志/事件必须显示 `route=relay`、`relayPeerId=R`、匹配的 messageId ACK；记录消息哈希/长度，不存正文。
4. 记录 R 的转发/预约观测、错误码、时间线。**M6-R 只证明 Relay 路径，不证明 direct。**

**M6-D（真实 direct + 停 Relay）**
1. 先建立 M6-R 的 relayed 会话；确认 A/B 均启用 DCUtR（known relay）。观察真实 `dcutr` attempt/success/failure；不得把 attempt 写成 success。
2. 若建立 direct：双方 `/peers`/`/diag` 显示 `route=direct`、`direct=true`、无 `/p2p-circuit`；A↔B 双向各至少 1 条，ACK `route=direct` 且无 relayPeerId。
3. **停掉 Relay R（不是断开 A/B）**，确认 R 不可达；保持 A/B 进程/PID/Peer ID 不变，再双向发送，ACK 仍 `route=direct`。只有这一步成功，M6-D 才能 PASS。
4. 未建立 direct：记录 attempts/candidates/error/超时与 Relay fallback（仍可聊天），M6-D 记 FAIL/BLOCKED；不能拿 Docker 或 A↔Relay direct 冒充 A↔B direct。
5. 记录 NAT/运营商/防火墙、路由、ACK、PID/Peer ID、消息哈希、报告路径（`/report` 的 JSON+Markdown；默认脱敏）。

**独立记录模板（最小字段）：** `testId` (M6-R/M6-D)、start/end、commit、device labels/network、relay Peer ID/multiaddr、A/B Peer ID、route/relayPeerId/directAddress、messages counts/hashes、ACK match count、DCUtR attempts/successes/failures、`result` PASS|FAIL|BLOCKED|NOT_TESTED、脱敏说明。M6-R 与 M6-D 分开填写；M6-R PASS 不推出 M6-D PASS。当前状态：M6-D 在 IPv6 有状态防火墙场景 **PASS** 一次，IPv4 NAT 打洞与 M6-R 计数 **NOT_TESTED**。
