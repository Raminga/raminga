# DHT 使用与诊断

Status: Accepted（使用说明） · Date: 2026-11-15

Raminga 只运行自己的 Kademlia DHT，协议为 `/raminga/kad/1.0.0`，不使用公共 IPFS DHT，也没有公共 IPFS bootstrap 默认值。DHT 用于两件事：

1. 按 Peer ID 查找当前地址（`raminga dht find`，以及按 Peer ID 连接时的回退）；
2. 保存本机签名的地址记录（`/raminga-addr/<peer-id>`），供其他节点查询。

DHT 不是在线状态、授权或好友关系。只有 DHT 路由流量的节点不会进入好友表；缓存地址也不代表对方在线。

## 1. 选择模式

`[dht].mode` 和 `raminga init --dht-mode` 接受三个值：

| 配置值 | 实际行为 | 适用节点 |
| --- | --- | --- |
| `client` | 只查询/发布记录，不响应入站 DHT 查询，不进入别人的路由表 | NAT 后、家庭网络中的普通节点 |
| `server` | 响应入站 DHT 查询，参与路由表；必须公网可达 | Relay/Bootstrap 节点、有公网地址的长期在线节点 |
| `auto`（默认） | 启动时按 client 运行；AutoNAT v2 报告公网可达后切换为 server，变为私有/未知时切回 client | 地址可达性会变化、但已启用 AutoNAT 的节点 |

注意：

- `auto` 在可达性未知时保持 client。没有 AutoNAT 探测节点时，不要假定它会自动变成 server；需要服务的公网节点应显式写 `server`。
- `client` 仍然会向 DHT 发布自己的签名地址记录（NAT 后通常只有 relay circuit 地址可发布），只是不承担 server 职责。
- `server` 不检查公网可达性。防火墙/端口没有放行时，配置仍是 server，但外部节点连不上；用 `raminga status` 和外部拨号核实，不要只看配置。
- 老配置无需迁移：缺少 `mode` 时加载默认 `auto`；`raminga init` 不带 `--dht-mode` 也保持 `auto`。

初始化示例：

```sh
# 公网 Relay/Bootstrap 节点：显式承担 DHT server
raminga init --data-dir ~/raminga-relay \
  --dht-mode server \
  --relay-provider \
  --announce /ip4/203.0.113.10/tcp/4001 \
  --announce /ip4/203.0.113.10/udp/4001/quic-v1

# NAT 后普通节点：只做 DHT client
raminga init --data-dir ~/raminga-client \
  --dht-mode client \
  --bootstrap /ip4/203.0.113.10/tcp/4001/p2p/<relay-peer-id>

# 保持默认 auto
raminga init --data-dir ~/raminga-auto
```

`--dht-mode` 只写 `config.toml`，不会启动节点或探测端口。`--force` 会按本次 flags 重写配置，但保留身份、Peer ID 和数据库。

## 2. 配置项

```toml
[dht]
# 独立 Raminga DHT，不会加入 /ipfs/kad/1.0.0。
enabled = true
mode = "auto"                  # client | server | auto
protocol_prefix = "/raminga"   # 固定值
# 只填 Raminga 节点的显式地址；空数组表示没有 bootstrap。
bootstrap_peers = []
# 仅首次初始化时使用发行内置官方列表；不写字段的旧配置不会自动补回。
bootstrap_preset = false
refresh_interval = "30s"
query_timeout = "20s"
```

`bootstrap_peers` 的每一项都必须包含 `/p2p/<peer-id>`，不能是 `/p2p-circuit` 地址，也不能是公共 IPFS/libp2p bootstrap；这些会在配置校验时被拒绝。可以重复写多个 Raminga 节点。

### 2.1 首次初始化的引导节点优先级

- 用户显式 `bootstrap_peers` 优先；一旦有自定义列表，就不会再注入发行预置。
- 没有自定义列表时，全新 `raminga init`（或首次 `Load` 创建配置）会按发行内置官方列表写入；`--no-bootstrap-preset` 明确禁用。
- 发行预置当前保持**空列表**，直到提供真实公开地址；不会填入示例、文档 IP 或测试 Peer ID。
- 已有 `config.toml`、升级后的配置、用户把 `bootstrap_peers` 清空后的配置都不会自动补回。加载旧配置时 `bootstrap_preset` 缺失也不会触发写入，`Load` 不重写已有文件。
- `bootstrap_preset` 是首次初始化/显式 `init` 的记录，不是运行时的第二地址来源；daemon 实际拨号只看 `dht.bootstrap_peers`。

`enabled = false` 会关闭 DHT：不启动路由表、不发布地址记录、`dht find` 明确返回 disabled。已连接的普通 libp2p 连接、Relay 和显式 multiaddr 连接不受影响。

## 3. 查看配置模式与实际模式

```sh
raminga dht status --data-dir "$HOME/.raminga"
raminga network status --data-dir "$HOME/.raminga"
```

`dht status` 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 配置是否启用 DHT |
| `mode` | 兼容字段：`config.toml` 里的配置模式 client/server/auto |
| `configured_mode` | 同 `mode`，也是 `config.toml` 里的值：client/server/auto |
| `active_mode` | 现在实际承担的角色：client/server/unknown/disabled |
| `protocol` | 固定 `/raminga/kad/1.0.0` |
| `bootstrap` | 配置的显式 bootstrap multiaddr |
| `bootstrap_connected` | 其中有活动连接的数量 |
| `connected_peers` | 当前连接的所有 libp2p Peer 数（可能包含 Relay/普通连接） |
| `routing_table` | 真正进入 DHT 路由表的 Peer ID |
| `last_bootstrap` | 最后一次**实际尝试** bootstrap dial 的时间；没有配置或全部暂停时为 `-` |
| `last_refresh` | 最后一次路由表刷新时间 |
| `last_error` | 最近的 DHT 发现/刷新错误 |
| `last_publish` / `last_publish_error` | 本机地址记录的发布结果 |
| `diagnosis` | 对空路由表等状态的归纳说明 |

`dht status` 和 `network status` 的文本输出都保留旧的 `mode:` / `mode=` 字段，值等同 `configured_mode`（配置模式），并同时显示 `active_mode`。`--json` 输出保持 protobuf 字段不变：`mode` 是配置值，`active_mode` 是实际角色。

`active_mode` 不是配置值的复读。libp2p 的 `IpfsDHT.Mode()` 返回的是配置选项，`auto` 永远返回 `auto`，不能说明当前到底在 client 还是 server；Raminga 改为检查 host 是否注册了 `/raminga/kad/1.0.0` 入站 stream handler。注册了是 `server`，没有注册是 `client`；DHT 未启动、无法观察时是 `unknown`；显式配置 server 但 handler 意外缺失时也报 `unknown`，不会猜成 client。`enabled=false` 时是 `disabled`。

### 空路由表怎么读

`diagnosis` 按以下顺序区分“已连接但不入表”和“未连接”：

| 现象 | 含义与下一步 |
| --- | --- |
| 有 `routing_table` Peer | 正常；数字是路由表 Peer 数 |
| `bootstrap_connected > 0`，路由表为空 | 已连上 bootstrap，但对方没有作为 DHT server 进入路由表。检查对方是否 `active_mode=server`、是否刚启动尚未 identify/刷新；client 不会进入路由表 |
| `connected_peers > 0`，路由表为空 | 有 libp2p 连接，但都不是可用的 DHT server（可能是 client、Relay 或普通应用连接）；不是“没有网络” |
| 无连接，`bootstrap` 非空 | 未连接。检查地址、端口、防火墙、对端进程和 `last_error` |
| 无连接，`bootstrap` 为空 | 没有配置引导节点；配置 `dht.bootstrap_peers` 或手工加 PeerStore 提示 |

`last_bootstrap` 只在真正尝试 dial bootstrap 时写入。`bootstrap_peers=[]`（或所有 bootstrap 都被暂停）时保持 `-`，不会把进程启动时间伪装成引导时间。

## 4. `dht add` 只写本地 PeerStore

```sh
raminga dht add /ip4/203.0.113.10/tcp/4001/p2p/<peer-id>
```

这个命令只把地址写进本机 go-libp2p PeerStore（启用 peer cache 时也写入 SQLite 地址提示），**不会**：

- 向 DHT 发布记录；
- 连接对方；
- 验证对方在线或地址可用；
- 把对方加入好友表或路由表。

要真正建立连接，用 `raminga connect`（或 TUI `/connect`）。要用 DHT 查询，用 `raminga dht find <peer-id>`；结果中的 `peerstore-cache` 只是缓存提示，不是在线证明。

## 5. 地址记录发布

节点会在启动后、公告地址变化后以及每小时尝试发布一次本机签名地址记录：

- 记录位于 `/raminga-addr/<peer-id>`，是签名的 libp2p `PeerRecord`；
- 只发布公网地址和 `/p2p-circuit` 地址，最多 16 条；回环/私网地址不会被发布；
- server 和 client 都会发布；client 通过已连接的 server 写入；
- 路由表为空时不会假装发布成功，`last_publish_error` 会明确写 `DHT routing table is empty; address record not published (...)`；
- 首次发布失败后会重试；已有成功记录后按小时刷新。诊断以 `last_publish` / `last_publish_error` 为准，不以“配置了 bootstrap”推断已发布。

DHT 服务端的记录保存在内存中，重启后要等节点再次发布；记录有大小（≤4 KiB）、地址条数（≤16）、保存时间（最长 6 小时）和存储键数量上限，远端写入会经过签名、key/Peer ID、大小和地址数量校验。

## 6. Bootstrap 晚启动与恢复

启动时 Raminga 会直接拨号配置的 bootstrap 节点。若对方尚未启动：

1. 启动阶段记录 `last_bootstrap` 和连接错误；
2. go-libp2p Kademlia 的 `fixLowPeers` 在启动时执行一次，之后每 **2 分钟**执行；低路由表时会通过 PeerStore 里的 bootstrap 地址重新拨号并刷新路由表；
3. 路由表恢复后，地址发布重试会成功，`last_publish` 更新。

这条恢复路径使用上游已有的 2 分钟机制，Raminga 不额外增加一套 bootstrap 重连循环。因此 bootstrap 晚启动的预期恢复时间是“最多约 2 分钟 + 下一次发布重试”，不是立即恢复；如果 2 分钟后仍为空，按上一节的空表诊断继续查。

本机集成测试 `TestDHTLateBootstrapRecovery` 可在显式开启时复现该场景（约 2–3 分钟）：

```sh
RAMINGA_DHT_LATE_BOOTSTRAP=1 go test ./internal/network -run TestDHTLateBootstrapRecovery -count=1 -v -timeout 5m
```

它只证明本机回环上的晚启动恢复；真实公网 NAT/防火墙行为仍需单独验收。

## 7. 常用排查

```sh
raminga dht status --data-dir "$HOME/.raminga"
raminga network status --data-dir "$HOME/.raminga"
raminga dht find <peer-id> --data-dir "$HOME/.raminga"
raminga dht add /ip4/<ip>/tcp/4001/p2p/<peer-id> --data-dir "$HOME/.raminga"
raminga connect <peer-id> --data-dir "$HOME/.raminga"
```

- `active_mode=client` 的公网节点不能作为别人的 bootstrap/server；改成 `server` 并重启。
- `bootstrap_connected=1` 但路由表为空：先确认对方是 `server`，再等一次刷新；不要重复添加 bootstrap。
- `last_publish_error` 提到空路由表：先解决 server/连接问题，发布会在后续重试中恢复。
- `dht find` 返回 `peerstore-cache`：只是本地缓存，不代表 DHT 查到了在线节点。
- 只看到 `last_bootstrap=-`：没有配置 bootstrap，或配置的 bootstrap 全部被暂停；不是“引导成功”。

当前验证范围：本机回环上的真实 libp2p TCP/Noise/Yamux、单 server+client 发布/查询、双 server 发布/查询、bootstrap 晚启动 2 分钟恢复；Docker/公网多 NAT、第三方 DHT 实现互操作仍 **NOT_TESTED**。
