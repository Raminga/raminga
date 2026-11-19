# 第一批 C 隔离验收（联系人 / 会话 / 设置往返）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 的第一批 C。使用独立端口
（宿主 4366、控制端点 4337）、独立数据目录 `.local/prototype-remediation/c1`
和独立 DSH_HOME；不读写 `~/.raminga`、用户 DSH 配置、真实桌面、4354/4362 及其数据。

## 启动

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod
export C1_ACCEPTANCE_DIR=$PWD/.local/prototype-remediation/c1
export C1_HOST_PORT=4366
export C1_CONTROL_PORT=4337
make build
(cd packages/ui && npm test && npm run build)
(cd plugins/dsh && npm test && npm run build)
node scripts/ui-acceptance/c1/prepare.mjs
sh scripts/ui-acceptance/c1/start-host.sh > "$C1_ACCEPTANCE_DIR/dsh-$C1_HOST_PORT.log" 2>&1 &
# 打开日志里的 http://127.0.0.1:4366/?token=...，点侧栏 Raminga
python3 scripts/ui-acceptance/c1/acceptance.py
```

`prepare.mjs` 创建两个真实节点：A 是隔离 DSH 打开的本地节点，B 提供公开
档案、6 条公开动态和公开通讯录（friends.json 中列出 A）。B 向 A 发出 24 条
真实入站消息，A 向 B 发 1 条并持久化；A 还有一段引用该出站消息的 Journey。
为保证联系人页可滚动，fixture 还向 A 的隔离 SQLite 插入 10 个仅用于列表滚动
的本地联系人行；B 仍是唯一有消息/未读的联系人。

证据写入 `.local/prototype-remediation/c1/evidence/`：`c1-results.json`、宽屏和
390×844 截图。C1-01 会调用真实 `raminga_chat_history`，确认只读 Agent 历史不会
推进人类未读。

## 重复运行

`prepare.mjs` 会把未读重建为 24；若只重跑 acceptance，可补发真实未读再运行：

```sh
C1_UNREAD_COUNT=10 C1_UNREAD_TAG=rerun node scripts/ui-acceptance/c1/send-from-b.mjs
python3 scripts/ui-acceptance/c1/acceptance.py
```

acceptance 从页面实际未读徽标读取基线，不依赖固定条数。

## 覆盖的 C 验收点

1. 联系人列表行主体进档案；右侧独立 38px（窄屏 42px）聊天入口，未读徽标在聊天入口上；
   从搜索/筛选/滚动位置进入聊天，返回原行聊天入口焦点。
2. 档案「他的动态」「他的通讯录」分别发消息，返回原分区、原滚动、原发消息按钮焦点；
   聊天打开时只有「联系人」主导航选中。
3. 联系人交互时间线的消息证据打开指定聊天；返回原证据行、原焦点和原分区。
4. 会话列表进入聊天，返回保留搜索、滚动、原行焦点。
5. 会话列表和聊天中的齿轮都能开设置目录并返回；聊天返回保留草稿、历史滚动和输入焦点。
6. 漫游消息证据进入聊天再返回原 Journey 证据（B 消息往返回归）。
7. 动态筛选/搜索进入帖子详情再返回筛选、搜索和卡片焦点（A 详情回归）。
8. 未读归零后联系人离开未读筛选，焦点回到未读筛选按钮。
9. 390×844：单一底栏、无横向溢出、输入区不被底栏遮挡、行级聊天点击区可达。
10. `raminga_chat_history` 只读历史不清人类未读。

## 结束

```sh
bin/raminga stop --data-dir "${C1_ACCEPTANCE_DIR:-.local/prototype-remediation/c1}/node-a"
bin/raminga stop --data-dir "${C1_ACCEPTANCE_DIR:-.local/prototype-remediation/c1}/node-b"
kill "$(cat .local/prototype-remediation/c1/dsh-${C1_HOST_PORT:-4366}.pid 2>/dev/null)" 2>/dev/null || true
```
