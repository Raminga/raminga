# 第二批第 3 项：联系人档案（隔离验收）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 第二批的「联系人档案」。使用
独立端口（宿主 `4376`、控制端点 `4343`）、独立 DSH profile 和独立 Node 数据目录
`.local/prototype-remediation/b3-contact-profile/`，不读写 `~/.raminga`、用户 DSH
配置、真实桌面、`4374`/`4341` 及其数据，也不占用其他验收宿主。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

make build
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build:ui )

node scripts/ui-acceptance/batch2-03/cleanup.mjs
node scripts/ui-acceptance/batch2-03/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-03/acceptance.py
```

`acceptance.py` 自己启动/停止 4376 的隔离 DSH Web，结束后调用 `cleanup.mjs`
停止本次 fixture 的 A/B/C/G/E/D 记录。连续复跑前重新执行 `prepare.mjs`。它不会按
端口或进程名杀未知进程；旧 PID 记录只在对应进程已退出时删除。

## fixture

`prepare.mjs` 创建真实 A/B/C/G/E/D 节点（D 初始化后停止，Peer ID 有效但离线；E
是 B 的另一条真实非 self 声明）和一条仅本机的联系人记录：

- B「潮汐线旁的林岸」在线，公开 v2 资料：验证过的头像、简介、4 个兴趣、公开交流
  风格、人类介绍；真实公开动态 `posts/tide-notes/post.json` 和公开文件
  `docs/tide-notes.md` 由 A 通过真实下载/发现记录取得。B 的 6 条真实消息写入 A；
- C「潮声与旧信记录者…」在线，长名称、长简介、6 个长兴趣、无头像、缺少公开交流
  风格；
- G「kong-bai」在线，但没有公开档案；
- D 是初始化后停止的真实节点，A 只有本机联系人记录，用于离线失败/重试路径；
- B 的 `public/friends.json` 由真实 `friends sync` 生成，包含 A 和 E；A 是 UI 的
  self Peer，因此 E 是用于「他的通讯录」在线与历史读取的非 self 真实声明。

隔离 DSH profile 从已有
`.local/ui-refresh-20261117/p4-acceptance/dsh-home` 轻量复制，再 link 当前
`plugins/dsh` 和本目录 control plugin；不复制 Go/npm 缓存。

## 覆盖

C3-01–C3-10 覆盖：1440×900 公开主卡（头像/名称/简介/兴趣/公开交流风格、主发消息
按钮、三个分区）、来源/完整 Peer ID/读取时间次级入口、390×844 首屏几何、长文本与
无头像/缺字段、在线无公开档案、真实离线失败与重试、公开文件与两个分区的聊天往返、
第 2 项行内聊天与齿轮往返、来源离线后的公开快照、历史动态、下载文件阅读、交互记录
和通讯录失败/重试。C3-11 覆盖 B 在线时 E 的真实公开声明、同会话失联与刷新后来源离线
时按「本机历史」保留同源部分历史及重试、1440×900/390×844 截图，以及真实空名单成功
响应清除历史。结果写入：

- `evidence/b3-contact-profile-results.json`：逐项断言、几何、错误、截图和宿主日志；
- `evidence/*.png`：宽窄首屏、来源详情、长文本、缺失/重试、文件/聊天往返、离线快照、
  在线/历史/空名单通讯录；
- `evidence/host-b3-contact-profile.log`：隔离 DSH Web 启动日志和本地 token URL。

## 边界与已知限制

- 只改第二批第 3 项；未提前做第 4 项时间线/印象及后续项目。
- 通讯录读取失败时复用第 2 项同源目录投影，明确标为「本机历史/上次读取」并说明持久
  投影只保留有界的一部分；成功响应（含真实空名单）会替换历史。没有历史时显示诚实
  空态和重试。本机联系人列表的公开名称/头像/线索仍复用第 2 项投影。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/Linux。
- 未提交、未推送、未发布；fixture 只使用 24 KiB 测试头像，不复制大型缓存。
