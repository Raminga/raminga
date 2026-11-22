# 第二批第 8 项：全局导航与视觉（隔离验收）

本目录只验证 [`docs/ui-prototype-remediation-plan.md`](../../../docs/ui-prototype-remediation-plan.md)
第二批「全局导航与视觉」。使用隔离宿主端口 `4404`、测试控制端口 `4369`、
独立 DSH profile 与 A/B 节点数据目录；不读写 `~/.raminga`、用户 DSH 配置、
真实桌面，也不使用 `4400/4365`、`4402/4367` 或其他既有验收端口。证据在
`.local/prototype-remediation/b2-08-nav/`。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga

export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build )

export B8_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-08-nav"
export B8_HOST_PORT=4404 B8_CONTROL_PORT=4369
node scripts/ui-acceptance/batch2-08/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-08/acceptance.py
```

中断后只清理本次 fixture：

```sh
B8_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-08-nav" \
  node scripts/ui-acceptance/batch2-08/cleanup.mjs
```

`prepare.mjs` 复用已验收的轻量双节点 fixture（26 条真实入站未读、1 条本机
人工发出、6 篇公开动态、Journey 与真实资料），并追加 7 条真实格式的本地
Journey 目录，使「全部记录」列表能实际滚动；不复制用户缓存。

`acceptance.py` 自己启动 `4404` 宿主，操作真实 Chromium Web UI；用真实
SQLite 读取未读游标，用 `raminga stop --data-dir` 停止隔离节点 A 验证节点
异常状态，并读取真实状态详情。结束时只终止本次 Popen 的宿主和 A/B 节点。

## 覆盖

- `N8-01` 1440×900：仅桌面主导航可见；动态｜主页｜联系人三项；主页是真实
  Raminga 品牌中心入口；节点状态在齿轮之前；状态标签「节点在线」不截断；
  未读徽标 26；品牌重复入口不成为第二个 aria-current。
- `N8-02` 状态详情明确显示连接数；键盘 Tab 顺序为 主页→联系人→节点→齿轮，
  焦点环 3px；中心主页按钮 Enter 可返回主页。
- `N8-03` 三种动态筛选只出现帖子（发现 6、有过交流 6、我的动态 0，文件 0）；
  选中筛选是原型实紫渐变；帖子详情可返回；设置里的「我的公开文件」仍是
  独立入口。
- `N8-04` 主页→全部记录→搜索「散步」（7 条）→滚动 260px→漫游详情→返回，
  搜索、滚动和原页面均保留。
- `N8-05` 联系人档案三个分区→聊天；设置齿轮往返保留草稿和档案来源；返回
  联系人列表；真实未读从 26 降到 0，持久读游标推进。
- `N8-06` 390×844：仅底栏主导航可见；主页品牌选中线为 3px 实紫；节点标签
  44px 无截断；安全区规则存在；滚到底部后最后一个近期卡片在底栏之上。
- `N8-07` 390：动态筛选实紫；滚到底部最后一个帖子不被底栏遮挡；横向溢出 0。
- `N8-08` 390：档案/聊天/设置往返；输入区底部 779 与底栏顶部 779 相接，
  聊天列表不被输入区或底栏遮挡；键盘 Tab/Enter 回主页；焦点环可见。
- `N8-09` 390 节点详情、连接数、关闭后焦点回节点按钮。
- `N8-10` 停止隔离节点 A 后真实状态变为「暂不可用」，详情显示最近结果时间。

## 本轮结果（2026-11-19）

- `packages/ui`：225 项测试 PASS；`plugins/dsh`：193 项测试 PASS。
- `prepare.mjs` PASS；`acceptance.py` N8-01–N8-10 全部 PASS；
  `pageErrors=[]`、`consoleErrors=[]`、每个主/子页横向溢出 0。
- 结果：`.local/prototype-remediation/b2-08-nav/evidence/b2-08-nav-results.json`
- 截图目录：`.local/prototype-remediation/b2-08-nav/evidence/`
  - 宽屏：`n8-01-wide-home-1440.png`、`n8-01-wide-status-1440.png`、
    `n8-02-wide-explore-1440.png`、`n8-02-wide-post-detail-1440.png`、
    `n8-03-wide-journeys-1440.png`、`n8-03-wide-journey-detail-1440.png`、
    `n8-04-wide-contacts-1440.png`、`n8-04-wide-profile-1440.png`、
    `n8-04-wide-chat-1440.png`、`n8-04-wide-settings-1440.png`、
    `n8-10-wide-node-offline-1440.png`、`n8-10-wide-node-offline-status-1440.png`
  - 窄屏：`n8-06-narrow-home-390.png`、`n8-07-narrow-explore-390.png`、
    `n8-08-narrow-contacts-390.png`、`n8-08-narrow-profile-390.png`、
    `n8-08-narrow-chat-390.png`、`n8-08-narrow-settings-390.png`、
    `n8-08-narrow-home-focus-390.png`、`n8-09-narrow-status-390.png`
  - 原型基线：`prototype-wide.png`、`prototype-narrow.png`
- 宿主日志：`evidence/host-b2-08.log`；端口 `4404` / 控制 `4369`。

## 边界与已知限制

- 只处理全局导航/视觉：品牌主页入口、节点与齿轮顺序、短状态、实紫筛选、
  窄屏底栏/安全区、焦点与横向溢出。未改真实 `~/.raminga`、用户 DSH 配置、
  日用桌面，也未提交/推送/发布/安装。
- 无头 Chromium 的 390×844 视口 `env(safe-area-inset-bottom)` 为 0；本轮验证
  了样式中的 `env(safe-area-inset-bottom)` 规则存在、底栏在 flex 布局中占位
  且不覆盖聊天输入/列表末尾，未声称覆盖物理刘海设备。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/
  Linux 或公网差异。
