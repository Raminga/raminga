# 第二批第 4 项：交互时间线与私有印象（隔离验收）

本目录只验证 [`docs/ui-prototype-remediation-plan.md`](../../../docs/ui-prototype-remediation-plan.md)
第二批的「交互时间线与私有印象」。使用独立端口（宿主 `4382`、控制端点 `4349`）、
独立 DSH profile 和独立 Node 数据目录
`.local/prototype-remediation/b2-04-interactions/`，不读写 `~/.raminga`、用户 DSH
配置、真实桌面、`4378`/`4345`/`4380`/`4347` 及其数据，也不占用其他验收宿主。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

make build
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build:ui )

node scripts/ui-acceptance/batch2-04/cleanup.mjs
node scripts/ui-acceptance/batch2-04/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-04/acceptance.py
```

`acceptance.py` 自己启动 4382 的隔离 DSH Web，在 1440×900 与 390×844 操作真实
Chromium，随后只终止本次 Popen 的宿主进程并重启一次以验证持久性；结束时通过
`cleanup.mjs` 停止本次 fixture 节点，不会按端口或进程名杀未知进程。连续复跑前
重新执行 `prepare.mjs`。

## fixture（真实与固定内容边界）

`prepare.mjs` 创建真实 A/B/C/E 节点，A 是 DSH 宿主读取的本机节点：

- B「潮汐线旁的林岸」在线，公开 v2 资料、头像、动态
  `posts/tide-notes/post.json` 和公开文件 `docs/tide-notes.md`；A 通过真实
  `GetPeerProfile` / `GetPeerManifest` / `DownloadPeerFile`（`recordDiscovery`）
  读取或下载，保存真实消息 ID、内容路径与 SHA-256。
- A/B 通过真实 `SendChat` 互发 20 条消息，含一条 465 字的真实长消息。真实消息的
  文本、方向、ID、ACK 不变；为覆盖多日期，`prepare.mjs` 停止 A 后只把
  `messages.created_at_ms`/`acked_at_ms` 调整到 2026-11-15、11-17、11-18 三天。
  这是本 fixture 唯一的元数据改写，已在证据中明确记录。
- B 连接真实 E 并 `friends sync`，公开 `friends.json` 含一条对 E 的非 self 声明
  `star-collector`。A 通过真实 `GetPeerFriends` 读到该声明；Journey 事件把它记为
  「公开线索」，不访问 E、不建立联系。
- Journey `b2-04-visit` 的 `events.jsonl`/`report.md` 是固定 fixture 文件，不是
  一次自主 Agent 运行；其中 `message_sent`/`message_received` 的真实消息 ID、
  `content_read` 的真实下载路径/哈希以及公开线索来源对应上面的真实 API 操作。
  另建一个没有可用时间的旧报告 `b2-04-no-date`，覆盖「日期未知」。
- `agent/contact-notes.json` 是 v2：B 有私有观察、私有印象、私有好奇及未知字段；
  C 没有任何消息、Journey 或私有记忆，用于空态。A 的 `public/friends.json` 保留
  B 的公开备注 `潮汐线附近的联系人，公开备注保留-B2-04`。
- 隔离 DSH profile 从已有
  `.local/ui-refresh-20261117/p4-acceptance/dsh-home` 轻量复制，再 link 当前
  `plugins/dsh` 和本目录 control plugin；不复制 Go/npm 缓存。

## 覆盖

B4-01–B4-15 覆盖：1440×900 首屏摘要/来源/私有印象与可编辑入口、按日期分组的
折叠历史、三天前与日期未知分组、长消息短预览与原文展开、消息证据精确定位及
分组/滚动/焦点/草稿恢复、同一持久消息 ID 被真实消息行与 Journey e4/e7 多处引用时
仍回到被点击的具体条目、Journey 证据沿用现有回程且草稿不受损、无记录联系人空态、
空印象校验、真实 UI 保存、同一联系人重开、宿主重开、公开文件/公开清单/远端读取
隐私负向、已有公开备注保留、390×844 首屏与底部导航、窄屏长文本/证据往返/焦点环、
第一批 C 聊天与第 3 项档案三个分区往返回归。逐项断言、几何、宿主日志和截图见：

- `evidence/b2-04-interactions-results.json`
- `evidence/*.png`：宽窄首屏、展开原文、证据返回、重复引用条目前后、印象编辑/保存、
  空态、Journey、同联系人重开和宿主重启
- `evidence/host-b2-04-interactions.log`、`host-b2-04-interactions-restart.log`

## 本轮结果（2026-11-18）

`prepare.mjs` PASS；`acceptance.py` B4-01–B4-15 PASS，`pageErrors=[]`。B4-15 在
1440×900 与 390×844 都从 Journey e4 的消息证据进入真实聊天，返回后活动焦点条目为
`journey:b2-04-visit:4`，不是同一消息 ID 的聊天行或 e7；同消息的聊天分组保持原
折叠状态，滚动位置和未发送草稿恢复。最终一次隐私检查 `publicHitCount=0`、
`publicHashUnchanged=true`、
`friendsDescription=潮汐线附近的联系人，公开备注保留-B2-04`、
`clueNotContact=true`；`agent/contact-notes.json` 保留唯一标记且未知字段未丢失。
宿主重开后同一标记仍从本地文件读回，A 的 `public/` 全目录、B 的公开
profile/friends/manifest 读取均不含该标记。

宿主重启时旧页面会记录预期的 WebSocket/连接拒绝 console 错误；`pageErrors` 仍为
空，结果文件会保留这些 console 记录。

## 边界与已知限制

- 只改第二批第 4 项；未提前做第 5 项及以后。未提交、未推送、未发布。
- Journey 会话/报告是固定 fixture，不声称由自主 Agent 现场生成；其证据 ID/路径
  来自真实 daemon 操作。消息多日期通过停止节点后调整时间元数据实现，不伪造正文。
- 私有记忆 v1 只读兼容沿用既有 Go/DSH 单测与集成测试；本 fixture 使用 v2 以覆盖
  编辑与持久性。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/Linux
  或第三方字体差异。
