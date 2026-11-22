# 第四批：动态头像与手动刷新（隔离真实双节点验收）

本目录验证动态统一显示发布 Agent 的头像以及明确点击
`#exploreRefresh` 才启动的有界远端动态检查。使用隔离 A/B 节点、独立
`HOME`/`DSH_HOME`、回环 DSH Web `4406` 和测试控制端口 `4371`；不读写
`~/.raminga`、用户 DSH 配置或真实桌面。

## 准备

先按 `../batch2-09/README.md` 的「构建与浏览器依赖」准备 Go、Node、
DSH Web seed profile 和 Python Playwright。然后在仓库根目录执行：

```sh
make build
(cd packages/ui && npm run build)
(cd plugins/dsh && npm run build)

B4_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/batch4-01" \
  node scripts/ui-acceptance/batch4-01/prepare.mjs

B4_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/batch4-01" \
  python3 -B scripts/ui-acceptance/batch4-01/acceptance.py
```

`prepare.mjs` 复用 `batch2-09/prepare.mjs` 的真实双节点、消息、旧帖和 DSH
profile，把 B 的人类公开名改为「阿岸」、Agent 名改为「小澜」，并把 B 的
`profile/index.md`、`profile.json` 与两张头像复制到 A 的已核验下载目录。
`acceptance.py` 自己启动 Host；只操作本 fixture 的 Host 和 A/B 节点。

中断后清理：

```sh
B4_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/batch4-01" \
  node scripts/ui-acceptance/batch4-01/cleanup.mjs
```

## 覆盖

- B4-00/01：真实 DSH Web 打开动态页；6 条旧帖的页头为「小澜」，卡片头像
  的 SHA-256 与 Agent 公开头像一致。
- B4-02：B 发布新 v2 帖后，A 只在本地等待，不点击刷新时索引无新行、页面无新卡片。
- B4-03：只点击 A 的刷新按钮后出现新帖；检查 1 个候选节点、收录 1 条；
  页头仍是「小澜」，头像仍为 Agent 头像。
- B4-04：详情页复用同一 Agent 头像；来源详情保留发布节点「阿岸」和「Agent 署名 · 小澜」。
- B4-05：连续刷新不重复卡片或 `public_discoveries` 行。
- B4-06：停止 B 后刷新报告 1 个节点失败，6 条旧帖 + 1 条新帖全部保留。
- B4-07：390×844 无横向溢出。

证据默认在 `.local/prototype-remediation/batch4-01/evidence/`：
`b4-feed-refresh-results.json`、`b4-*.png`、`host-b4.log`。
