# Raminga Node（Go 实现）

Status: Current (2026-11-07) · Go 1.27 / go-libp2p v0.51.0

**Node** 是 Raminga 的基本社交实体，拥有持久身份、本地数据、公开内容和好友表。当前实现是一个 Go 二进制：`raminga daemon` 是节点状态的唯一写入方，CLI、TUI、测试和以后的 DSH 插件都是本地 API 的薄客户端。模块边界、依赖方向和目标架构见 [architecture.md](architecture.md)；安装、数据目录、平台和命令细节见 [install.md](install.md)，本文不重复。

## 生命周期

- `raminga daemon` 前台运行节点；裸 `raminga` 在交互终端里会先确保该数据目录的 daemon 已运行，再打开 TUI。
- `raminga init` 写入 `config.toml` 并创建数据目录；`init --force` 只重写配置，保留 `identity/key` 和 `raminga.db`。
- `raminga stop` / `raminga restart` 通过本地 Connect API 的 `Shutdown` RPC 停止旧进程，再按需启动当前二进制；systemd 托管时拒绝直接操作，避免起第二个节点。
- 同一数据目录用 `raminga.lock`（flock）保证单实例；第二个 daemon 在改身份或数据库之前就会失败。
- 自动启动的 daemon 日志追加到 `<data-dir>/daemon.log`（0600，超过 10 MiB 轮转）；前台 `raminga daemon` 仍输出到终端。

代码：`cmd/raminga/main.go`、`cmd/raminga/daemon.go`、`cmd/raminga/stop.go`、`internal/identity/identity.go`。

## 身份

- 身份是 libp2p protobuf Ed25519 私钥，保存在 `identity/key`（0600，目录 0700）；Peer ID 由私钥派生，是网络身份。
- 逻辑 Node ID 由 Peer ID 派生（`node_` 前缀），与 Peer ID 分离；目前没有签名绑定，不能把 Node ID 当作可验证的第二种身份。
- 删除 `identity/` 或换一个数据目录会生成新的 Peer ID。迁移数据目录时先停旧节点、整体移动目录，并核对 `raminga status` 的 Peer ID；Peer ID 变了说明新身份已生成，不是数据被删除。迁移步骤见 [install.md](install.md#从自定义数据目录迁移到默认目录第一次运行前)。

## 数据目录

`config.toml`、`identity/`、`raminga.db`（SQLite，纯 Go 驱动）、`raminga.lock`、`api.sock` / `api.token`（0600，daemon 运行时）、`daemon.log`、`public/profile/`、`public/posts/`、程序生成的 `public/friends.json`、下载目录 `downloads/<Peer ID>/`，以及导出报告时的 `reports/`。逐项说明和限额见 [install.md §4](install.md#4-第一次运行)。

## 网络

- go-libp2p 同时监听 TCP 与 QUIC，默认 IPv4 + IPv6 的 4001；地址公告会追加网卡上的公网地址，并过滤链路本地、未指定、组播和常见虚拟网卡地址。过滤规则和已知限制见 `internal/network/filter.go`。
- Circuit Relay v2 客户端默认开启；Relay provider 默认关闭，必须显式 `--relay-provider`，并带预约/数据/时长/配额。DCUtR 在经中继建立受限连接后尝试打洞；AutoNAT 在无探测节点时报告“未知”，不当成不可达。
- 独立 Raminga Kademlia DHT（`/raminga/kad/1.0.0`）用于按 Peer ID 查地址和地址上报；不使用公共 IPFS DHT、公共 STUN 或默认 UPnP/NAT-PMP。
- `/disconnect` 持久暂停一个节点：连接 gater 阻止所有主动拨号，中继预约、DHT 刷新、AutoRelay 和 outbox 重试都不会把它连回来；再次 `/connect` 或发送聊天会解除暂停。断开不是拉黑，对方仍可主动连入。
- 启动时最多自动连回 3 个主动连接过、未暂停、且支持中继或 DHT 的好友；配置里的预置节点继续生效。

**验证状态：** 网络能力由 G1–G4.5 的本地/Docker 验收和单元/本机集成测试覆盖。真实公网只记录过 IPv6 有状态防火墙场景的 M6-D PASS 一次；IPv4 NAT 打洞、M6-R 计数、可复现性和对称 NAT/CGNAT 仍 **NOT_TESTED**。Docker/本地通过不等于公网或生产可用。

## 好友表

- SQLite 的 `friends` 表是唯一准确来源，`paused_peers` 保存 `/disconnect` 的暂停状态；`known_peers` 只是 PeerStore 地址缓存，不是好友表。
- 表里有 Peer ID、本地名字、地址、描述、手动连接标记、中继/DHT 能力、首次和最近往来时间、暂停状态。名字和描述是本地 UI 数据，只有表里的节点才能设置；显示时注明来源。
- 发生过聊天、查看/下载内容、`/connect` 或中继预约等 Raminga 应用层往来时，双方都会进表；只有 DHT 路由流量的节点不进表。
- 地址来自对方或本机观察，公开前过滤；读取方再次过滤并限制尝试次数，连接时仍以 Peer ID 为准。
- `public/friends.json` 每 10 分钟检查一次，有变化才整份原子重写；启动时也生成一次。只包含名字、Peer ID、可公开/中继地址和描述，不包含时间、暂停或内部标记。读取方把整份文件当作对方的说法，不写入自己的好友表。
- 默认最多 10,000 条，超出时按最近往来清理；当前只保护手动连接过的记录，名字/预置/常连保护未实现。

验证：SQLite/node 单元与本机集成测试覆盖写入规则、名字/描述、暂停和 friends.json 生成；没有单独的真实网络好友表验收。

## 内容

- 公开内容在 `public/profile/` 和 `public/posts/`；放进去就公开，移出来就取消。第一版没有非公开内容，也没有每条内容的可见范围设置。可选公开帖子 schema、作者映射与本地发现索引见 [public-content.md](public-content.md)。
- 扫描只读 `public/`：跳过隐藏/临时文件和符号链接，拒绝超出 `[content]` 限额的文件和目录总量；默认单文件 100 MiB、`posts/` 1 GiB、`profile/` 10 MiB，可配置。
- `/manifest` 返回按大小封顶的分页清单（路径、大小、修改时间、SHA-256、版本、Peer ID）；`/files/<path>` 只提供清单里的文件，支持 `Range`/ETag，带 `nosniff` 和 `application/octet-stream`。
- 下载前先取清单，只下清单里的路径；保存到 `downloads/<Peer ID>/`，先写 `.part`，完成后校验大小和 SHA-256，再原子改名。经中继时只取清单和 ≤64 KiB 的小文件，更大的内容等待直连升级，失败就明确要求直连。
- 第一版清单不签名，只校验文件哈希；发布者离线时内容不可用，已下载的副本无法被发布者强制撤回。

验证：内容扫描、清单、路径安全、下载和断点续传有单元/本机集成测试，G2 有 Docker 内容流程复跑记录；真实网络只有 2026-11-06～07 的手工测试报告称直连服务器验证通过，具体项目未单独记录。

## 本地 API

- Connect-RPC over Unix domain socket，JSON/Protobuf，token 0600；不监听网络端口。daemon 是唯一写入方，CLI/TUI/DSH/测试共用同一套 RPC。
- 覆盖状态、连接、聊天、outbox、事件流、好友表、内容清单/档案/好友列表/下载流、`/disconnect`、`Shutdown`；测试专用 RPC 只在 `--enable-test-api` 下出现。
- token 等于节点全部权限；DSH 插件当前选择在用户主动安装后拥有完整权限，不设插件内能力边界（见 [features.md §10](features.md)）。

## TUI

`raminga tui`（或裸 `raminga`）打开内联聊天式界面（[ADR-0004](adr/0004-inline-tui.md)），不持有第二份节点状态，不新增 listener。当前命令：`/connect`、`/disconnect`、`/status`、`/peers`、`/chat`、`/name`、`/describe`、`/forget`、`/view`、`/posts`、`/peerfriends`、`/files`、`/get`、`/published`、`/diag`、`/outbox`、`/cancel`、`/mark`、`/report`、`/copy`、`/clear`、`/help`、`/quit`。`/connect <所有者> <节点>` 通过对方好友列表连接；`/peerfriends` 显示对方列的 Peer ID 和地址（未验证的说法）；`/peers <节点>` 显示当前连接和已知地址；聊天中输入为空按 `Esc` 退出聊天。用法和示例见 [install.md §4](install.md#4-第一次运行)。

## CLI

除裸 `raminga`、`daemon`、`init`、`stop`、`restart`、`status`、`tui`、`version` 外，CLI 按功能分组：`connect`/`disconnect`、`chat`、`peers`、`friends`、`content`、`relay`、`dht`、`network`、`report`；`test` 只在显式 `--enable-test-api` 下可用。命令和 flag 以 `raminga --help` 与 `raminga <cmd> --help` 为准。

## 状态边界

- 本文描述的是代码和本地/Docker 验收；真实公网有上述 M6-D 一次 PASS 记录，以及 2026-11-06～07 的手工测试报告（具体项目未单独记录）。TUI 的 Mac 真实终端手工验收状态未确认，Windows 实机和真实剪贴板仍 **NOT_TESTED**。
- `--service`/systemd 安装脚本存在，但本次验收没有验证 systemd 托管；不要把示例当成已验证的生产部署。
- 当前阶段不承诺跨版本兼容；升级/迁移前先备份身份和数据库，按 [install.md](install.md) 的顺序执行。
