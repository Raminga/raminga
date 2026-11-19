# 第二批第 1 项：主页公开档案（隔离验收）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 第二批的「主页公开档案」。
它使用默认端口 `4370`、独立 DSH profile 和四个独立 Node 数据目录，只写入
`.local/prototype-remediation/b2-home/`。不读写 `~/.raminga`、用户 DSH 配置、真实桌面、
`4354` 的 Codex 实例、4321/4332，也不修改其他验收 fixture。

## 直接复验

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

# UI 与 DSH 浏览器 bundle（只改 UI 时不必重编 Go）
( cd packages/ui && npm run build )
( cd plugins/dsh && npm run build:ui )

# 建四个小数据目录并启动对应 Node daemon
node scripts/ui-acceptance/batch2-01/prepare.mjs

# 自测：逐个启动隔离 DSH Web（端口 4370），跑 1440×900 / 390×844，
# 点击真实编辑入口，最后停止这些 host
python3 -B scripts/ui-acceptance/batch2-01/acceptance.py
```

如果只想手工打开其中一个状态：

```sh
BATCH2_DATA_DIR=$PWD/.local/prototype-remediation/b2-home/avatar-short \
BATCH2_HOST_PORT=4370 \
sh scripts/ui-acceptance/batch2-01/start-host.sh
# 打开日志中的 http://127.0.0.1:4370/?token=...，点侧栏 Raminga
```

结束后：

```sh
kill "$(cat .local/prototype-remediation/b2-home/dsh-4370.pid 2>/dev/null)" 2>/dev/null || true
for variant in avatar-short avatar-long no-avatar missing; do
  bin/raminga stop --data-dir "$PWD/.local/prototype-remediation/b2-home/$variant"
done
```

## fixtures

`prepare.mjs` 在 `.local/prototype-remediation/b2-home/` 下创建并启动：

- `avatar-short`：真实 PNG 头像（受控文件读取后转 data URL）、短简介、3 个带图标兴趣、公开交流风格；
- `avatar-long`：同一头像，多段长简介，用于宽窄屏换行与完整正文；
- `no-avatar`：无头像字段，同一圆角容器显示姓名首字统一占位；
- `missing`：无 `profile.json`/`agent-card.json`，只保留人类 `index.md`，用于一句缺失提示和编辑入口。

每个 Node 另有 4 条 Journey 记录（1 条 running、3 条 completed），主页仍显示第一张
活动卡和「近期记录」网格；`acceptance.py` 在两个宽度下检查活动卡与记录的往返。

真实 PNG 来自 `tests/fixtures/ui-refresh/avatar.png`。fixture 只复制 24 KiB 图片，
不复制 Go/npm 缓存，也不生成大文件。

## 证据

`acceptance.py` 写入 `.local/prototype-remediation/b2-home/evidence/`：

- `b2-home-results.json`：每条断言的结果、头像/占位尺寸、溢出值、截图和 host 日志清单；
- `host-<variant>.log`：隔离 DSH Web 启动日志（含本地 token URL）；
- `wide-<variant>-1440.png`、`narrow-<variant>-390.png`：四个状态两个宽度的截图；
- `wide-edit-full-1440.png`、`wide-edit-missing-1440.png`：实际点击编辑入口后的设置页。

## 手动覆盖的验收点

1. 有头像：`img` 与 238×238 圆角容器同尺寸，`object-fit: cover`，容器无内边距/边框；
2. 缺头像：不显示破图或品牌占位，显示名称首字，占满同一容器；
3. 短/长简介：1440×900 与 390×844 都不横向溢出，长简介保留完整文本；
4. 兴趣标签每个带 SVG 图标，公开交流风格位于标签之后；
5. 缺失档案只显示一句提示和可达的「编辑公开资料」，首屏无 `profile/`、`agent-card.json` 等原始路径；
6. 点击顶部铅笔和缺失提示内的编辑入口，都实际打开 `设置 → 公开资料与文件`，并能返回主页；
7. 第一批 B 的活动卡、近期记录和进入/返回路径仍可用；两个宽度都只有一套主导航。

## 已知限制

- 本项只调整主页公开档案；设置页的表单文案与视觉属于第二批第 6 项，未在本项中改动。
- fixture 的 Journey/活动数据用于回归主页结构；第一批 B 的真实工具调用证据仍以
  `.local/prototype-remediation/b1/evidence/` 为准。
- 本脚本不发布、不连接远端节点、不写私有记忆；四个 Node 都是 `--no-bootstrap-preset`
  的本地隔离节点。
