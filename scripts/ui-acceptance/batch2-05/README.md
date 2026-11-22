# 第二批第 5 项：动态搜索与编辑（隔离验收）

本目录只验证 [`docs/ui-prototype-remediation-plan.md`](../../../docs/ui-prototype-remediation-plan.md)
第二批「动态搜索与编辑」。使用独立端口（宿主 `4386`）、独立 DSH profile 和独立
Node 数据目录，不读写 `~/.raminga`、用户 DSH 配置、真实桌面，也不占用其他验收
宿主端口。默认旧目录 `.local/prototype-remediation/b2-05-feed-editor/` 保留上一轮
证据；本轮复验用 `B5_ACCEPTANCE_DIR` 指向新的隔离目录，避免覆盖旧证据。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

make build
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build )

export B5_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-05-fix"
export B5_HOST_PORT=4386
node scripts/ui-acceptance/batch2-05/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-05/acceptance.py
```

需要保留上一轮证据时不要省略 `B5_ACCEPTANCE_DIR`；`prepare.mjs` 只清理该变量
指向的目录里的 fixture 节点和宿主记录。

`prepare.mjs` 调用第一批 A 的 `a1/prepare.mjs`，用 `A1_ACCEPTANCE_DIR` 指向本目录
创建全新的 A/B 节点和 600 条普通文件发现记录，再通过真实 `SavePublicDraft` RPC
写入一条私有动态草稿。它不会复制 Go/npm 缓存，也不会触碰 a1 原目录。
`acceptance.py` 自己启动 4386 宿主、在 1440×900 与 390×844 操作真实 Chromium、
重启一次宿主验证草稿持久化，结束时只终止本次 Popen 的宿主进程，并通过正常
`raminga stop --data-dir` 停止本目录的 fixture 节点。`cleanup.mjs` 可在中断后
单独清理同一目录。连续复跑前重新执行 `prepare.mjs`。

## fixture（真实与固定内容边界）

- A 是本机节点（DSH 宿主读取），B 是远端节点。两者均由真实 daemon 启动并连接。
- A 的公开目录来自已验收的第一批 A fixture：4 条本人/Agent/来源未注明帖子（含
  真实 PNG 图文帖、v1 帖）和普通文件 `hello.md`、`friends.json`；B 有 3 条帖子、
  普通附件与 600 条非帖子发现记录。发现与我的动态只显示帖子，普通文件仍从
  「我的公开文件」入口读取。
- `fixture.json` 中的 `draft` 是准备阶段通过真实 RPC 创建的本机私有草稿。
- 验收中的新图、新帖、编辑和冲突写入都走真实 UI → DSH bridge → daemon；
  B 通过真实 `DownloadPeerFile` 读取 A 新发布/编辑后的原帖与图片。
- daemon 在写入 PNG 时会重新编码/校验图片，因此 B 读取的字节与 A 的公开文件
  逐字节一致，而不保证与最初上传的测试源文件一致；验收同时核对 post.json
  中的 SHA-256、PNG 签名和 B 下载副本。

## 覆盖

`B5-01`–`B5-14` 覆盖：1440×900 搜索/刷新/发布同组且搜索默认可见、发现与我的
动态只混合帖子、带查询打开编辑器后 Escape 恢复筛选/查询/滚动/焦点、已有草稿
和新输入的关闭/切页保留、发布前检查/取消/不公开、真实图片草稿保存与发布后 B
读取、发布成功「再写一条」空白、从卡片编辑保留身份/路径/发表时间且更新版本、
真实 revision/SHA 冲突时保留本地内容并可另存恢复、普通文件独立入口、390×844
紧凑换行/清除/窄屏内滚/返回焦点、键盘 Tab/Enter/Escape、宿主重启后真实草稿仍
可读取、宽窄切换无横向溢出。

`B5-15`–`B5-17` 覆盖本轮复验新增的失败路径：只有标题的新动态在打开旧帖后可
找回标题、标签和署名（旧帖仍可编辑，并显示其真实 `posts/old-agent.json`
发布路径）；检查后新增有效图立即撤销旧确认，复查前 API/公开目录没有新增，
复查后发布且远端真实读取 1 张图；切换到另一条真实草稿后旧确认清理，提交并
读取所选草稿对应的公开版本。

## 本轮结果（2026-11-18）

- `prepare.mjs` PASS；`acceptance.py` B5-01–B5-17 PASS，`pageErrors=[]`。
- `packages/ui` 208 项测试 PASS；`plugins/dsh` 193 项测试 PASS。
- Go `internal/publication`、`internal/node`、`internal/storage`、`internal/api`
  `go test -count=1` PASS。
- 宿主重启时旧页面会记录预期的 WebSocket/连接拒绝 console 错误；`pageErrors=[]`，
  结果 JSON 保留这些 console 记录，便于区分预期重连与真实脚本错误。
- 证据（本轮新目录）：
  - `.local/prototype-remediation/b2-05-fix/evidence/b2-05-feed-editor-results.json`
  - `.local/prototype-remediation/b2-05-fix/evidence/*.png`：宽窄工具栏、返回
    焦点、草稿、预览取消、发布成功、原帖编辑、冲突/恢复、公开文件入口、窄屏
    编辑器、只有标题输入恢复、旧帖真实路径确认、加图撤销确认、复查图文发布
  - `.local/prototype-remediation/b2-05-fix/evidence/host-b2-05-feed-editor.log`、
    `...-restart.log`

## 边界与已知限制

- 只改第二批第 5 项；未提前做第 6 项及以后。未提交、未推送、未发布。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/Linux
  或第三方字体差异。
- 图片上传由 daemon 重新编码；这是既有图片校验/发布实现，不是 UI 改写。
- 第一项 A fixture 的 `posts/a-image` 是固定的原始公开副本，不用于编辑导入；
  编辑图片帖改用验收中真实发布的新帖，避免把 fixture 的图片元数据差异误判为
  UI 回归。
