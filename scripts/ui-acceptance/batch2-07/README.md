# 第二批第 7 项：聊天构图（隔离验收）

本目录只验证 [`docs/ui-prototype-remediation-plan.md`](../../../docs/ui-prototype-remediation-plan.md)
第二批「聊天构图」。使用隔离宿主端口 `4398`、测试控制端口 `4363`、独立
DSH profile 与 A/B 节点数据目录；不读写 `~/.raminga`、用户 DSH 配置、真实
桌面，也不使用 `4394/4359`、`4396/4361`、`4366/4337`、`4392/4357` 或其他
既有验收端口。证据在 `.local/prototype-remediation/b2-07-chat/`。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

# 纯前端改动；构建共享 UI 与 DSH 插件，不跑全量 Go。
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build )

export B7_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-07-chat"
export B7_HOST_PORT=4398 B7_CONTROL_PORT=4363
node scripts/ui-acceptance/batch2-07/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-07/acceptance.py
```

中断后只清理本次 fixture：

```sh
B7_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-07-chat" \
  node scripts/ui-acceptance/batch2-07/cleanup.mjs
```

`prepare.mjs` 复用第一批 C 的真实双节点、24 条入站消息、1 条本机人工发出
消息、Journey 证据和 DSH seed profile；随后：

- 为 B 发布带真实 PNG 头像的 `profile/profile.json` v2，使聊天顶栏可以优先
  显示对方公开名称与头像；
- 在 A 的隔离 SQLite 中保留一条旧格式、`origin=unknown` 的本机发出记录，
  验证「来源未知」；
- 由 B 通过真实 `SendChat` 追加长中文与长无空格消息，验证换行和窄屏。

`acceptance.py` 自己启动 `4398` 宿主，操作真实 Chromium Web UI；通过
`4363` 测试控制端点调用真实的 `raminga_chat_send` / `raminga_chat_history`
工具，并读取隔离 SQLite 的持久来源与 `conversation_read_state`。结束时只
终止本次 Popen 的宿主，并通过 `raminga stop --data-dir` 停止本次 A/B 节点。

## 覆盖

- `B7-01` 1440×900：顶栏真实名称/头像、独立「查看档案」、ID 次级折叠；
  对方/本人/Agent/来源未知四类来源；长中文与长无空格文本无横向溢出。
- `B7-02` 真实人工输入并发送长消息；空输入不显示容量、输入时显示、发送后
  收起；真实来源 `origin=human` 与协议接收反馈；底部反馈位于输入上方，不覆盖
  最后一条消息。
- `B7-03` 向上读历史时真实新事件到达、1440↔390 宽度变化均不拉回底部；
  「回到最新」明确可用；390 窄屏单底栏不遮输入、最后消息与焦点。
- `B7-04` 聊天 ↔ 档案 / 设置往返保留草稿、历史位置、来源焦点和联系人分区。
- `B7-05` 会话列表、档案「他的动态」「他的通讯录」、Journey 消息证据进入
  聊天后返回实际来源；保持来源焦点。
- `B7-06` `raminga_chat_history` 只读不推进人类未读；设置/档案隐藏面板、翻
  历史、窗口失焦时未读与持久游标保持；回到可见、聚焦、实际底部后按既有语义
  标读。`visibilityState=visible`、`hasFocus=true` 和游标前后值写入结果 JSON。
- `B7-07` 390×844 首屏、顶栏高度、历史高度、单底栏、无横向溢出；聊天齿轮
  往返保留草稿、历史位置与输入焦点。

## 本轮结果（2026-11-19）

- `packages/ui`：225 项测试 PASS；`plugins/dsh`：193 项测试 PASS。
- `prepare.mjs` PASS；`acceptance.py` B7-01–B7-07 PASS，`pageErrors=[]`、
  `consoleErrors=[]`。
- 结果：`.local/prototype-remediation/b2-07-chat/evidence/b2-07-chat-results.json`
- 截图：`b7-01-wide-chat-sources-1440.png`、`b7-02-wide-manual-send-1440.png`、
  `b7-03-wide-history-1440.png`、`b7-03-wide-latest-1440.png`、
  `b7-03-narrow-history-390.png`、`b7-03-narrow-latest-390.png`、
  `b7-04-wide-settings-return-1440.png`、`b7-05-wide-journey-return-1440.png`、
  `b7-06-wide-read-state-1440.png`、`b7-07-narrow-chat-390.png`、
  `b7-07-narrow-settings-return-390.png`
- 宿主日志：`evidence/host-b2-07.log`；端口 `4398` / 控制 `4363`。

## 边界与已知限制

- 只改第二批第 7 项聊天构图与必要状态逻辑；未改第 8 项全局导航、日用桌面、
  真实 `~/.raminga`、用户 DSH 配置，也未提交/推送/发布。
- 未添加聊天图片、附件、身份切换、轮询或新的自动发送。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/
  Linux 或公网差异。窗口可见性以真实 `document.visibilityState` 记录；文档隐藏
  态由单元测试覆盖，面板隐藏/窗口失焦使用真实页面事件。
