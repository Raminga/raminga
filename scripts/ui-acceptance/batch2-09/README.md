# 第二批补项：关联人类公开头像（隔离验收）

本目录验证关联人类独立公开头像、首屏/对端展示、聊天气泡身份，以及首批
验收补项中的双头像草稿/恢复路径。使用隔离宿主端口 `4406`、测试控制端口
`4371`、独立 `HOME`/`DSH_HOME` profile 与 A/B 节点数据目录；不读写 `~/.raminga`、用户
DSH 配置、真实桌面，也不使用其他既有验收端口。证据在
`.local/prototype-remediation/b2-09-human-avatar/`。

## 从干净克隆准备

把包含本验收脚本的分支克隆到较短的路径，例如 `/tmp/raminga`，然后在仓库根目录执行下列命令。路径过长会超过 macOS 的 Unix socket 地址长度限制。

### 构建与浏览器依赖

准备 `make`、Go 1.27.4、Node.js 24 或更新版本、Python 3，以及 `PATH` 中可用的 `dsh` 命令。

```sh
make build
(cd packages/ui && npm ci && npm run build)
(cd plugins/dsh && npm install --no-save --no-package-lock --omit=optional \
  --ignore-scripts && npm run build)

python3 -m venv .local/ui-acceptance-python
.local/ui-acceptance-python/bin/python -m pip install playwright
.local/ui-acceptance-python/bin/python -m playwright install chromium
```

### 生成隔离 DSH Web profile

两套验收共用 `.local/ui-refresh-20261117/p4-acceptance/dsh-home`。在仓库根目录生成一次空白 Web profile。

```sh
seed_root="$PWD/.local/ui-refresh-20261117/p4-acceptance"
mkdir -p "$seed_root/home" "$seed_root/dsh-home"
env -u DSH_PROFILE HOME="$seed_root/home" DSH_HOME="$seed_root/dsh-home" \
  dsh --profile web --dump-config >/dev/null
```

验收准备脚本会复制 Web profile 到各自的 `dsh-home`，并链接本仓库构建的 `@raminga/dsh`。共用 profile 保持空白，真实 profile、登录态、凭据和验收产物留在本地。

`batch2-09/prepare.mjs` 通过 `c1/prepare.mjs` 使用这个共用 profile。

## 最短复跑

首次完成上一节后，复跑只需：

```sh
B9_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-09-human-avatar" \
  node scripts/ui-acceptance/batch2-09/prepare.mjs
B9_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-09-human-avatar" \
  .local/ui-acceptance-python/bin/python -B scripts/ui-acceptance/batch2-09/acceptance.py
```

中断后只清理本次 fixture：

```sh
B9_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-09-human-avatar" \
  node scripts/ui-acceptance/batch2-09/cleanup.mjs
```

`prepare.mjs` 经 `c1/prepare.mjs` 复用第一批 C 的真实双节点、真实消息与 DSH
seed profile，再：
- 给 B 的 `profile.json` v2 写入独立的 Agent 头像和关联人类头像；
- 让 A 只保留真实旧 `profile/index.md`，从旧档案回退进入设置；
- 生成与 A 的 Agent 图不同的测试 PNG，供真实文件输入使用；
- 保留未受头像功能管理的 `profile/avatar-deadbeef.png` /
  `profile/human-avatar-deadbeef.png`，用于验证清理边界。

`acceptance.py` 自己启动 `4406` 宿主，操作真实 Chromium Web UI；通过
`4371` 控制端点调用真实的 `raminga_chat_send`，并用 B 的 daemon 真实读取
A 的 `GetPeerProfile`。结束时只终止本次 Popen 的宿主，并通过
`raminga stop --data-dir` 停止本次 A/B 节点。

## 覆盖

- `B9-01` 1440×900：双头像独立草稿预览；保存草稿只写 SQLite；检查后取消
  发布不写入 `public/`。
- `B9-02` 确认发布：公开 `profile.json` 同时含 `agent.avatar` 与
  `human.avatar`，字节/SHA 与清单一致；首页同时显示两张公开头像。
- `B9-03` B 的 daemon 真实读取 A 的人类头像路径/哈希；A 的对端档案页显示
  B 的独立人类头像，不与 Agent 头像混用。
- `B9-04` 出站 `human` / `agent` 气泡分别使用本地人类/Agent 公开头像；
  入站气泡保持中性、不借对端档案冒充作者；来源文案不变。
- `B9-05` 390×844：首页与聊天气泡无横向溢出，头像不挤压文本。
- `B9-06` 只替换人类头像：Agent 头像字节不变，旧人类文件清理，未受管文件保留。
- `B9-07` 只移除 Agent 头像：关联人类头像不变。
- `B9-08` 只移除人类头像：Agent 默认形象、未受管文件保留。

## 本轮结果（2026-11-21）

- `packages/ui`：254 tests PASS；`plugins/dsh`：204 tests PASS。
- 定向 Go：storage/publication/node/api PASS（含旧库迁移、双头像独立
  保存/清除、原子发布、远端读取与清理边界）。
- `prepare.mjs` PASS；`acceptance.py` B9-01–B9-08 PASS，`pageErrors=[]`、
  `consoleErrors=[]`。
- 结果：`.local/prototype-remediation/b2-09-human-avatar/evidence/b2-09-human-avatar-results.json`
- 截图：`b9-01-wide-dual-draft-preview-1440.png`、
  `b9-01b-wide-human-avatar-draft-1440.png`、
  `b9-02-wide-home-both-avatars-1440.png`、
  `b9-03-wide-peer-human-avatar-1440.png`、
  `b9-04-wide-chat-identities-1440.png`、
  `b9-05-narrow-home-both-avatars-390.png`、
  `b9-06-narrow-chat-identities-390.png`、
  `b9-08-wide-home-defaults-1440.png`
- 宿主日志：`evidence/host-b2-09.log`；端口 `4406` / 控制 `4371`。

## 边界与已知限制

- 只验证同机受控网络和隔离 DSH Web；不覆盖公网、NAT、跨机器或桌面壳。
- 聊天入站头像保持中性是刻意的：当前协议只认证 Peer，不能可靠区分该
  Peer 下具体作者。
- 未运行全量 e2e；未改真实用户配置、权限、凭据或依赖。
