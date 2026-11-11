# 手动 Docker 实验室（TUI 优先：lan / onesided / symmetric / dualnat / ipv6fw）

Status: **G4.5.1 TUI-first（2026-10-31）**。本文只讲“打开 TUI，输入 `/…` 命令，对照日志”。Docker 是受控模拟，**不是**真实公网/NAT/M6 证据。

`make lab-up` 会：构建/复用镜像、生成配置、启动全部节点、做路由/iptables/ip6tables/conntrack 自检、等待 Relay 预约、给每个节点写入**其他节点服务名的本地别名**（`b-quic`、`r1`…，存在本机 SQLite，不联网、不自动拨号），然后生成 `.local/lab/<lab>.md`（同样 TUI-first，另有 CLI 附录）。daemon 默认不启用 `--enable-test-api`。

## 1. 前提与启动

- macOS arm64、Go 1.27.4、Docker Desktop 28.4；`docker compose` 可用。
- 不要占用宿主机 4001/4002；lab 不发布宿主端口。
- 每一步：

```sh
make lab-up LAB=dualnat
# 按本文（或 .local/lab/dualnat.md）操作
make lab-down LAB=dualnat
```

`make lab-up` 只准备设施，不运行业务场景、不发聊天；`make lab-down` 删除本项目容器/网络/volume 和 `.local/lab/<lab>.md`。

## 2. TUI 通用操作

```sh
docker exec -it raminga-lab-dualnat-a-quic-1 raminga tui
```

容器已设置 `RAMINGA_DATA_DIR=/data`，**不需要** `--data-dir`。lab 已启动容器内 daemon，所以这里用 `raminga tui`；它按设计**不会**自动启动节点。宿主机日常使用直接输入 `raminga` 即可自动启动并打开 TUI。屏幕：

- 输出：直接写入终端正常回滚区（不在备用屏幕），滚动、选择和复制都交给终端；TUI 只管理底部的小块实时区域。
- 实时区域：状态行 + 输入行（未选聊天对象时 `>`，已选时 `<名字>> `），补全弹窗或一行提示；没有空白填充。状态行显示聊天对象、连接数、自己的名字；运行中显示 spinner 进度，窄终端从右往左省略。
- `/copy` 和 `/status` 的公告地址都带完整 `/p2p/<PeerID>`；`/status` 先打印地址标签，再单独打印完整地址。`/status` 的“本机：”显示完整 Peer ID。
- Home/End 在输入行内移动光标；PgUp/PgDn 由终端处理。
- 输入 `/` 打开中文指令补全；↑/↓ 选择，Tab 只补全，Enter 确认当前高亮指令/参数后执行，Esc 关闭。名字/Peer ID 参数也会补全。
- 不带 `/` 的文字 = 发给当前 `/chat` 对象。
- 长行不插入换行，由终端自然折行；远端文本会转义控制字符。
- 输入非空时 Ctrl+C 清空输入并关闭补全；输入为空时 Ctrl+C（或 `/quit`）退出 TUI，**daemon 继续运行**。已选聊天对象时，输入为空按 Esc 退出聊天；输入非空时 Esc 只清空输入。

常用命令（唯一前缀可用）：

```text
/connect <节点|multiaddr>          连接；经中继后自动尝试打洞直连
/connect <所有者> <列表中的节点>   用对方好友列表里的地址连接
/disconnect <节点>                 断开并持久暂停（/connect 解除）
/chat <节点>                       选择聊天对象
/status  /peers  /diag  /outbox    状态/节点/诊断/待发
/peers <节点>                      单个节点的当前连接和已知地址
/name <节点> <名字>               起名；/peers 列出（含完整 Peer ID）
/mark <备注>                        时间线记录；备注含“停中继”会观察 10 秒
/report [--include-text]            导出 JSON+Markdown
/copy  /clear  /help  /quit
```

## 3. lan

在 `a4` 打开 TUI：

```sh
docker exec -it raminga-lab-lan-a4-1 raminga tui
```

```text
> /connect b4
> /chat b4
> hello from a4
> /report
> /quit
```

应看到：`✓ 已连接 b4：直连/TCP /ip4/10.250.1.12/tcp/4001`、`✓ 当前聊天对象：b4`、`→ b4：hello from a4 ✓ 7 ms`、`✓ 报告已保存：/data/reports/test-report.json`。

IPv6 / QUIC / 仅名字选择分别在 `a6→b6`、`q6-a→q6-b`、`a6only→b6only` 上重复 `/connect <名字>` + `/chat <名字>`。UDP 封锁对在 `tcp-a` 手工加 iptables 后 `/connect tcp-b`，预期 TCP 直连、QUIC 失败不写成直连；netem 在 `loss-a` 手工 `tc`。

## 4. onesided

先在公网节点 `pub` 上验证反向主动拨号（预期 BLOCKED）：

```sh
docker exec -it raminga-lab-onesided-pub-1 raminga tui
```

```text
> /connect peer
```

应看到 `✗ 连接失败：所有候选地址都失败（连接超时）`，随后缩进的候选地址 `  · /ip4/...（超时）`（原因可能是超时/握手失败/backoff 等）（预期 BLOCKED，不是 bug）。退出后，在 NAT 后的 `peer`：

```sh
docker exec -it raminga-lab-onesided-peer-1 raminga tui
```

```text
> /connect pub
> /chat pub
> hello from peer
> /report
> /quit
```

应看到 `✓ 已连接 <名字>：直连/TCP /ip4/11.43.0.10/tcp/4001` 和 ACK。随后在 `pub` 上 `/chat peer` 回一条，走已建立连接；这**不**证明反向可达。

## 5. symmetric

在 `a`：

```text
> /connect b
> /chat b
> symmetric relay only
> /diag
> /report
> /quit
```

应看到 `✓ 已连接 <名字>：中继/TCP（经中继 relay，受限）`，`/diag` 里 `  · 仅中继可用：当前没有直连；可能是对称 NAT/CGNAT 或 UDP 被封锁。`；报告 `still_direct_after_relay_stop` 为 `null`。对端 `b` 可 `/chat a` 回一条，仍然 only relay。**不要写成 direct。**

## 6. dualnat（完整流程）

1. `a-quic`：

```sh
docker exec -it raminga-lab-dualnat-a-quic-1 raminga tui
```

```text
> /connect b-quic
> /chat b-quic
> dualnat hello
```

应看到 `✓ 已连接 b-quic：中继/TCP（经中继 r1，受限）`，随后 `✓ 已升级为直连/QUIC /ip4/11.41.0.11/udp/4001/quic-v1`；`→ b-quic：dualnat hello ✓ 7 ms 经中继`。

2. 宿主另一个终端停两个 Relay（保持 TUI）：

```sh
docker stop raminga-lab-dualnat-r1-1 raminga-lab-dualnat-r2-1
```

3. 回到同一个 TUI，继续输入：

```text
> /mark 已停中继
> still direct after relay stop
> /report
> /quit
```

等 10 秒应看到 `✓ 停中继后直连仍然保持（已观察 10 秒）`；仅中继路径关闭时还会看到 `b-quic 的中继线路已关闭（直连仍在）`（不是 `断开 b-quic`）。第二条也 ACK；报告保存到 `/data/reports/test-report.json|md`。

4. 反向聊天：在 `b-quic` 开另一个 TUI，`/chat a-quic`，输入 `direct from b`，应 ACK。

5. **重新启动 Relay**（后续 TCP/relay-only 步骤需要）：

```sh
docker start raminga-lab-dualnat-r1-1 raminga-lab-dualnat-r2-1
```

在 TUI 输入 `/diag`，等待中继预约恢复 `active` 后再继续。

6. TCP 双 NAT：在 `a-tcp` 输入 `/connect b-tcp`、`/diag`、`/chat b-tcp`、`tcp relay fallback`、`/quit`。**通常** TCP 直连 BLOCKED 后回退 Relay，`/diag` 出现 `双 NAT 下 TCP 直连 BLOCKED；当前经中继回退`；Docker 中也**偶尔**观察到 simultaneous-open 成功直连（此时日志是 `✓ 已连接 <名字>：直连/TCP .../tcp/4100`）。两种都如实记录，**不能**把 attempt/relay 写成 direct，也不能保证每次都成功。

7. `a-relay`→`b-relay`（DCUtR 关闭）：`/connect b-relay`、`/chat b-relay`，始终 `route=relay`，等待也不会变 direct。

## 7. ipv6fw（完整流程）

1. `a-quic`：`/connect b-quic`（经 IPv6 Relay → DCUtR QUIC direct），`/chat b-quic`，发 `ipv6fw relay hello`。应看到中继 + `✓ 已升级为直连/QUIC /ip6/...`。
2. 宿主停 Relay：

```sh
docker stop raminga-lab-ipv6fw-relay-1
```

3. 同一 TUI：`/mark 已停中继`、`ipv6fw still direct`、`/report`、`/quit`；10 秒后直连仍在并 ACK；仅 Relay 路径关闭时应看到 `b-quic 的中继线路已关闭（直连仍在）`，不是 `断开 b-quic`。
4. 反向：`b-quic` 的 TUI `/chat a-quic`，发 `ipv6fw still direct from b`。
5. **重新启动 IPv6 Relay**（后续 TCP/单侧步骤需要）：

```sh
docker start raminga-lab-ipv6fw-relay-1
```

TUI `/diag` 确认中继预约恢复 `active`。

6. `a-tcp` `/connect b-tcp`：TCP direct 允许 PASS 或 BLOCKED，两种都如实显示；失败后仍可经 Relay 聊天。
7. 单侧防火墙：宿主 `docker exec ... fw-a sh -c 'ip6tables -w 5 -F FORWARD; ip6tables -w 5 -P FORWARD ACCEPT'`；`one-a`→`one-b` 主动拨号预期 BLOCKED，`one-b`→`one-a` 应 direct + ACK。反向应用消息不证明 open→closed 入站可达。

## 8. 自动验证与 CLI 附录

- `make tui-lab-verify LAB=<lab>`：用真实 pty 驱动真实 TUI，按键执行本文同类 `/…` 命令；`lan/onesided/symmetric/dualnat/ipv6fw` 都可用。dualnat/ipv6fw 覆盖 relay→direct→停 relay→仍 direct→双向 ACK→`/report`→schema 校验。
- `make lab-verify LAB=<lab>`：执行生成文件的 **CLI 附录**（`raminga connect/chat` 等）作为回归；TUI 步骤在 `tui` 代码块中，不会被当作 shell 执行。
- 生成的 `.local/lab/<lab>.md` 同时含完整 TUI 步骤、真实容器名/Peer ID/地址与 CLI 附录；以该文件为准（无 drift）。
- 清理：`make lab-down LAB=<lab>`；确认无 `raminga-lab-<lab>` 容器/网络/volume 残留。

以上为 Docker 受控模拟；真实公网 M6-R/M6-D 仍 **NOT_TESTED**，见 [公网测试指南](public-test-guide.md)。
