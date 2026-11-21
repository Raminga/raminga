# 第三批：DSH Web 引导节点管理（隔离验收）

本目录验证 `[dht].bootstrap_peers` 首次预置、SQLite 引导角色、本机认证
API 和真实 DHT 拨号，以及 DSH Web「节点状态 → 引导节点」的查看/添加/
移除/刷新。使用隔离 A/B/C 三个本机 daemon、固定回环端口
`44741`/`44742`/`44743`、DSH Web `44744`、独立 `HOME`/`DSH_HOME`；不读写
`~/.raminga`、用户 DSH 配置、真实桌面或其他验收端口。

## 从干净克隆准备

在较短的路径克隆包含本验收脚本的分支，然后在仓库根目录完成[构建与浏览器依赖](../batch2-09/README.md#构建与浏览器依赖)。两套验收共享同一个空白 Web profile。

### 生成隔离 DSH Web profile

两套验收共用 `.local/ui-refresh-20261117/p4-acceptance/dsh-home`。在仓库根目录生成一次空白 Web profile。

```sh
seed_root="$PWD/.local/ui-refresh-20261117/p4-acceptance"
mkdir -p "$seed_root/home" "$seed_root/dsh-home"
env -u DSH_PROFILE HOME="$seed_root/home" DSH_HOME="$seed_root/dsh-home" \
  dsh --profile web --dump-config >/dev/null
```

验收准备脚本会复制 Web profile 到各自的 `dsh-home`，并链接本仓库构建的 `@raminga/dsh`。共用 profile 保持空白，真实 profile、登录态、凭据和验收产物留在本地。

## 最短复跑

首次完成上一节后，复跑只需：

```sh
B3_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b3-01-bootstrap" \
  node scripts/ui-acceptance/batch3-01/prepare.mjs
B3_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b3-01-bootstrap" \
  .local/ui-acceptance-python/bin/python -B scripts/ui-acceptance/batch3-01/acceptance.py
```

中断后只清理本次 fixture：

```sh
B3_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b3-01-bootstrap" \
  node scripts/ui-acceptance/batch3-01/cleanup.mjs
```

`prepare.mjs` 会创建 A（client + DSH 宿主）、B（DHT server）、C（普通
联系人）三个真实节点，复制隔离 DSH seed profile 并把 `@raminga/dsh`
链接到本仓库；A 的 `refresh_interval` 固定为 2s，便于观察显式断开后的
DHT 定时刷新。它只启动节点读取身份/地址，随后停止，全部节点由
`acceptance.py` 重新启动。

`acceptance.py` 自己启动真实 Chromium 和 DSH Web 宿主，操作 1440×900 与
390×844；通过页面添加/移除引导节点，通过 `raminga disconnect` 做真实
显式断开，通过 `raminga status/dht status --json` 和只读 SQLite 核对
持久化、运行候选、暂停记录与 TOML 字节。结束时只终止本次 Popen 的宿主
和本次三个节点。

## 覆盖

- `B3-01` 测试节点显式关闭预置，初始引导列表为空；非法地址明确报错；TOML/SQLite 未变。
- `B3-02` 通过 UI 添加 B；重复提交幂等；真实 DHT 引导连接；TOML 不变。
- `B3-03` 真正重启 A 后列表和 DHT 候选仍在。
- `B3-04` 显式断开后刷新/定时不偷偷回拨；Peer 暂停与地址保留。
- `B3-05` 移除只删引导标记，保留地址、联系人、其他角色和暂停记录。
- `B3-06` 移除后重启仍为空。
- `B3-07` 普通添加联系人不会写 TOML 或引导标记。
- `B3-08` 390×844 下可添加/移除；暂停状态不显示为在线；无横向溢出。

## 边界

只验证同机回环网络、隔离 DSH Web 和源码构建二进制；不覆盖公网、发行
预置、NAT/跨机器、桌面壳或 Windows/Linux 差异。B 是测试 DHT server，
不是项目方确认的公开引导节点（NET-01 仍未关闭）。证据在
`.local/prototype-remediation/b3-01-bootstrap/evidence/`。
