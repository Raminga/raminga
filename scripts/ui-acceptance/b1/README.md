# 第一批 B 隔离验收（主页活动 / 近期记录 / 全部记录 / 漫游详情）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 的第一批 B。它使用独立
端口（默认 4362，控制端点 4336）和独立数据目录
`.local/prototype-remediation/b1`，不读写 `~/.raminga`、用户 DSH 配置、真实桌面、
`4354` 的 Codex 实例、4321/4332 或 p5/a1 的目录。

## 启动

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod
export B1_ACCEPTANCE_DIR=$PWD/.local/prototype-remediation/b1
export B1_HOST_PORT=4362
export B1_CONTROL_PORT=4336
make build
(cd packages/ui && npm test && npm run build)
(cd plugins/dsh && npm test && npm run build)
node scripts/ui-acceptance/b1/prepare.mjs
sh scripts/ui-acceptance/b1/start-host.sh > "$B1_ACCEPTANCE_DIR/dsh-$B1_HOST_PORT.log" 2>&1 &
# 打开日志里的 http://127.0.0.1:4362/?token=... ，点侧栏 Raminga
python3 scripts/ui-acceptance/b1/acceptance.py
```

`prepare.mjs` 会建 A/B 两个真实节点：

- A 打开隔离 DSH；B 提供一个真实公开笔记和一个 40 MiB 公开文件；
- B 暂停时用测试专用的 `.local` control plugin 调真实 `raminga_content_get`，
  观察主页活动卡“进行中 → 最近活动”；
- A 的 `agent/sessions/` 里固定准备 9 条记录：短标题、长旧任务指令、无标题旧格式、
  仅有当前候选但未访问、有/无消息证据、以及多条较早记录。`acceptance.py` 运行时才创建 `b1-active`
  并让真实工具关联它，最后删除它验证“关联 Journey 已清理”的缺失状态。

证据写到 `.local/prototype-remediation/b1/evidence/`：`b1-results.json` 和
`b1-wide-*.png`、`b1-narrow-*.png`。control plugin 只存在于
`scripts/ui-acceptance/b1/control-plugin`，不会进入发布 profile。

## 覆盖的 B 验收点

1. 1440×900 首屏：Agent 主视觉、人类条、单张活动卡、近期记录起始位置；
   成功读取的读取时间/来源/诊断默认折叠。
2. 390×844：活动卡后紧接单列近期记录，单一底栏，无横向溢出。
3. “全部记录”独立列表：按旅程和访问对象检索、清除筛选、打开更早记录，
   返回后保留查询、滚动和焦点。
4. 独立漫游详情：摘要（Agent 报告标注）、实际路线、关键事件、来源、消息证据；
   长旧任务指令使用中性标题，原文与会话 ID 在次级详情；仅有当前对象时路线为空，
   当前对象独立标注且不计入访问；无图不伪造。
5. 消息证据可定位真实保留消息，聊天返回对应旅程/证据；消息被清理时明确提示。
6. 活动点击优先进入关联旅程并高亮对应事件；Journey 已删除时说明原因并保留
   Peer/会话回退。

## 已知限制

- 当前 Journey 数据契约没有配图字段。B 的卡片只使用真实存在的封面（宿主未来
  提供的安全内联图），验收固定记录覆盖“无图”；没有用示例图冒充真实配图。
- 活动卡与详情只读取本机 `agent/activity.jsonl`、`agent/sessions/`。不证明远端
  已读、已回复或在线。

## 结束

```sh
bin/raminga stop --data-dir "${B1_ACCEPTANCE_DIR:-.local/prototype-remediation/b1}/node-a"
bin/raminga stop --data-dir "${B1_ACCEPTANCE_DIR:-.local/prototype-remediation/b1}/node-b"
kill "$(cat .local/prototype-remediation/b1/dsh-${B1_HOST_PORT:-4362}.pid 2>/dev/null)" 2>/dev/null || true
```
