# P5 隔离双节点验收与 Codex 手工复验

本目录在独立端口/数据目录上复现 P5：真实 DSH Web、真实 A/B 双节点、真实
`raminga_*` 工具活动、宽屏 1440×900、窄屏 390×844、真实插件禁用/卸载/重装，
以及 schema 9→11 升级。它不会修改用户 DSH 配置、`~/.raminga`、4321 宿主、
`.local/ui-implementation` 或 4332/4333 P4 宿主。

## 目录

- `prepare.mjs`：重建 `node-a`、`node-b`、`upgrade-v9` 和隔离 `dsh-home`；
  同时写入固定 fixture、120 条历史消息/已读基线、旧格式公开资料、私有
  contact-notes、Journey、schema 9 数据库与旧 viewState。
- `start-host.sh`：前台启动隔离 DSH Web（默认 4344，控制插件 4346）。
- `acceptance.py`：T1–T13 真实 UI/API/daemon 验收。
- `t14.py`：真实 DSH Plugins 开关、`dsh plugin remove/add`、实例变化。
- `upgrade-check.mjs` / `t15_ui.py`：schema 9→11 前后比对与升级后真实 UI。
- `narrow_extra.py`：390×844 的真实发布/未读/分页/草稿/收藏/印象/Journey。
- `focus_audit.py`：焦点环、联系人不裁切、底部安全区、500px 高视口输入框。
- `run-tool.mjs`：通过仅测试用控制插件调用真实 `raminga_*` 工具。
- `control-plugin/`：仅测试用 DSH 插件，不发布、不装入任何用户 profile。

## 启动

```sh
# 仓库根；不要复用 4321/4332
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod make build
(cd packages/ui && npm test && npm run build)
(cd plugins/dsh && npm test && npm run test:integration && npm run build)
node scripts/ui-acceptance/p5/prepare.mjs
sh scripts/ui-acceptance/p5/start-host.sh
```

日志会打印 `http://127.0.0.1:4344/?token=...`，用浏览器打开，必要时先关闭
DSH 欢迎/Get started，再点侧栏 **Raminga**。`fixture.json` 记录当前 A/B
Peer ID、B 地址、B 的 profile/post/image 路径与 SHA-256。

## Codex 手工复验步骤（无后台调度器）

1. **未读注入与 Agent 读取不清**
   ```sh
   A=$(node -e 'console.log(require("./.local/ui-refresh-20261117/p5/fixture.json").nodeA)')
   # 如果 B 的地址缓存过期，用 A 当前监听地址重连一次：
   ADDR=$(bin/raminga status --data-dir .local/ui-refresh-20261117/p5/node-a --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).listenAddrs.find(a=>a.includes("/tcp/"))))')
   bin/raminga connect "$ADDR/p2p/$A" --data-dir .local/ui-refresh-20261117/p5/node-b
   bin/raminga chat send --to "$A" --text 'P5 手工未读一' --data-dir .local/ui-refresh-20261117/p5/node-b
   bin/raminga chat send --to "$A" --text 'P5 手工未读二' --data-dir .local/ui-refresh-20261117/p5/node-b
   bin/raminga friends list --data-dir .local/ui-refresh-20261117/p5/node-a --json
   node scripts/ui-acceptance/p5/run-tool.mjs raminga_chat_history '{"limit":10}'
   # 再查 friends list：unreadCount 必须不变；人才打开会话后才归零。
   ```
   `run-tool.mjs` 走与 Agent 相同的注册工具 execute 包装，会写
   `node-a/agent/activity.jsonl`；它不是生产入口。

2. **重挂/焦点**
   - 宽屏：DSH 侧栏 `New Session` → 再点 `Raminga`；会话/滚动/草稿/设置页
     应恢复。
   - 窄屏 390×844：打开侧栏 → `Raminga`；底部三项导航、键盘 Tab 焦点环、
     输入框、底部安全区。`#desktopNav`/`#mobileNav` 只应有一个可见。
   - 可用 `python3 scripts/ui-acceptance/p5/focus_audit.py` 自动采集。

3. **插件真实卸载/重装**
   ```sh
   # 停宿主后
   DSH_HOME=$PWD/.local/ui-refresh-20261117/p5/dsh-home \
     dsh plugin --profile web remove @raminga/dsh
   # 重装
   DSH_HOME=$PWD/.local/ui-refresh-20261117/p5/dsh-home \
     dsh plugin --profile web add link:$PWD/plugins/dsh
   ```
   重启宿主后侧栏入口消失/恢复；`activity.jsonl` 中旧实例不得显示为当前
   “运行中”。注意 DSH 0.2.2-rc.3 在开关/SIGTERM 时不保证调用 Cordis
   disposer，真实日志可能是 `unknown/host_restart` 或晚到 `ok`，不是
   `interrupted`；`interrupted` 由插件单元测试覆盖，不冒充真实宿主证据。

4. **升级**
   ```sh
   node scripts/ui-acceptance/p5/upgrade-check.mjs
   python3 scripts/ui-acceptance/p5/t15_ui.py
   ```
   不要删除 `upgrade-v9`；`upgrade-live` 由 `upgrade-check.mjs` 从
   `upgrade-v9` 重建，交接时可能不存在。

## 清理

```sh
bin/raminga stop --data-dir .local/ui-refresh-20261117/p5/node-a
bin/raminga stop --data-dir .local/ui-refresh-20261117/p5/node-b
bin/raminga stop --data-dir .local/ui-refresh-20261117/p5/upgrade-live 2>/dev/null || true
```

证据写入 `evidence/`，不提交。完整结果见
`reports/p5-acceptance-2026-11-18.md`。
