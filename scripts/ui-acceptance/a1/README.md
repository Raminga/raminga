# 第一批 A 隔离验收（动态 / 帖子详情 / 公开文件）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 的第一批 A。它使用独立端口
（默认 4354；定向复验使用 4360）与独立数据目录
`.local/ui-refresh-20261117/a1` 或 `A1_ACCEPTANCE_DIR`，不读写 `~/.raminga`、
用户 DSH 配置、真实桌面、4321/4332、4354 Codex 实例或 p5 的 4344 目录。

## 启动（Codex 可直接运行）

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod
export A1_ACCEPTANCE_DIR=$PWD/.local/prototype-remediation/a-fix-run
export A1_HOST_PORT=4360
export A1_DSH_HOME=$A1_ACCEPTANCE_DIR/dsh-home
export A1_DATA_DIR=$A1_ACCEPTANCE_DIR/node-a
make build
(cd packages/ui && npm test && npm run build)
(cd plugins/dsh && npm test && npm run test:integration && npm run build)
node scripts/ui-acceptance/a1/prepare.mjs
sh scripts/ui-acceptance/a1/start-host.sh > "$A1_ACCEPTANCE_DIR/dsh-$A1_HOST_PORT.log" 2>&1 &
# 打开日志中的 http://127.0.0.1:4360/?token=... ，点侧栏 Raminga
python3 scripts/ui-acceptance/a1/acceptance.py
# PASS/FAIL 写入 evidence/a1-results.json；宽窄屏截图也在 evidence/。
# 按用户 review-a.py 的步骤重跑并等待宿主侧栏收起/图片解码后截图：
python3 scripts/ui-acceptance/a1/review-a-targeted.py
# T9 会另起 4361 的新宿主验证离线历史，结束后自动停止该 4361 进程。
```

定向复验的三个问题可单独核对：

1. `.local/prototype-remediation/a-fix-run/node-a/raminga.db` 有 600 条
   `notes/bulk/*` 普通文件（fetched_at 更新）在前，3 条更早的帖子在后；
   `A1-T1` 的 `scope` 必须显示“本次读取了 3 条帖子候选”，而不是 500/600 条
   混合记录。存储层另有 `internal/storage/discoveries_test.go` 用 620 条普通
   文件验证候选游标，并验证不传新字段的旧调用仍能翻出全部文件。
2. `A1-T1` 断言 `#discoveryMeta` 隐藏、`#discoveryScope` 默认收起且在列表之后；
   106/600 条非帖子说明只在该次级说明里。
3. 帖子卡片主区只剩收藏（我的动态另有编辑）；`阅读内容` 和
   `在文件夹中显示` 不再出现在卡片底部，`在文件夹中显示` 移到展开的
   `来源详情`。`A1-T10` 在 390×844 下等待宿主侧栏收起且图片
   `naturalWidth > 0` 后才截图。独立详情页同样把定位收进来源。

结束后只关闭本 fixture：

```sh
bin/raminga stop --data-dir "${A1_ACCEPTANCE_DIR:-.local/ui-refresh-20261117/a1}/node-a"
bin/raminga stop --data-dir "${A1_ACCEPTANCE_DIR:-.local/ui-refresh-20261117/a1}/node-b"
# start-host.sh 的 PID 文件固定在 a1 目录，文件名带实际端口。
kill "$(cat .local/ui-refresh-20261117/a1/dsh-${A1_HOST_PORT:-4354}.pid 2>/dev/null)" 2>/dev/null || true
```

`prepare.mjs` 写入 `fixture.json`：A/B Peer ID、公开帖子/文件路径、图片 SHA-256、
600 条批量非帖子；B 还保留一个未预下载的普通附件，用于验证受控下载。批量行直接
写入隔离 fixture 的 SQLite，避免发起数百次真实下载；Feed 只请求帖子候选页，因此
这些普通文件既不进入动态也不消耗帖子预算。证据写入 `evidence/`，结果文件
`a1-results.json`。
