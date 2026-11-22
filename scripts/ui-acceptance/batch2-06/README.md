# 第二批第 6 项：设置与公开资料编辑（隔离验收）

本目录只验证 [`docs/ui-prototype-remediation-plan.md`](../../../docs/ui-prototype-remediation-plan.md)
第二批「设置与公开资料编辑」。使用独立宿主端口 `4392`、测试控制端口 `4357`、
独立 DSH profile 和独立 A/B 节点数据目录；不读写 `~/.raminga`、用户 DSH 配置、
真实桌面或其他验收端口。旧验收目录和日志均保留，本轮证据在
`.local/prototype-remediation/b2-06-settings/`。

## 最短复跑

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

# UI 是纯前端改动；构建共享 UI 和 DSH 插件，不跑全量 Go。
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build )

export B6_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-06-settings"
export B6_HOST_PORT=4392 B6_CONTROL_PORT=4357
node scripts/ui-acceptance/batch2-06/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-06/acceptance.py
```

中断后清理本次 fixture：

```sh
B6_ACCEPTANCE_DIR="$PWD/.local/prototype-remediation/b2-06-settings" \
  node scripts/ui-acceptance/batch2-06/cleanup.mjs
```

`prepare.mjs` 复用第一批 A 的真实 A/B 节点、DSH seed profile 和公开动态 fixture，
再移除 A 的旧 profile 制造空态，写入私有人设/成长/记忆标记，复制到本目录的
隔离 DSH profile 并链接本次 `plugins/dsh`。它不会复制 Go/npm 缓存，也不会触碰
其他验收目录。`acceptance.py` 自己启动 4392 宿主和 4357 测试控制端点，在
1440×900 / 390×844 操作真实 Chromium；结束时只终止本次 Popen 的宿主进程，
并通过正常 `raminga stop --data-dir` 停止本目录的 fixture 节点。

## fixture

- A 是本机节点（DSH 宿主读取），B 是远端节点；两者均为真实 daemon，A/B 双向连接。
- A 初始无 `profile/profile.json` / 旧 `index.md`，用于空态；保留真实公开动态和
  `hello.md` 普通公开文件。
- 验收中通过真实 `SavePublicDraft` + `PublishPublicDraft` RPC 预置一份旧公开资料，
  并保留其私有草稿；随后在 UI 中编辑、上传真实 PNG 头像、保存草稿、重启宿主、
  取消一次发布并最终确认发布。
- `agent/persona.md`、`agent/growth.md`、`agent/contact-notes.json` 与一条私有草稿
  含唯一标记；验收扫描 A 的 `public/`、已发布清单、B 的公开资料读取与远端清单，
  确认这些标记不出现。
- 公开文件独立入口读取 A 的真实 `hello.md`；联系人/会话来自第一批 C 已有真实 fixture。

## 覆盖

`B6-01`–`B6-08`：设置索引六个任务入口与宽屏截图；空公开资料、无头像默认形象、
主页编辑直达并返回原位置；旧公开值、公开内容预览与恢复、私有草稿状态；真实
头像上传、保存草稿、关闭重开、宿主重启后 SQLite 草稿仍在；文字与头像修改使
发布确认失效、取消不写公开文件；真实确认发布后主页、编辑状态、公开清单与 B
节点 `GetPeerProfile` / `GetPeerManifest` / `DownloadPeerFile` 实际读取一致；私有
人设/成长/记忆/草稿标记不进入 public、manifest 或远端读取；390×844 目录、编辑、
草稿状态、公开文件无横向溢出；聊天齿轮往返保留草稿、焦点与原分区。

## 本轮结果（2026-11-19）

- `packages/ui` 218 项测试 PASS；`plugins/dsh` 193 项测试 PASS。
- `prepare.mjs` PASS；`acceptance.py` B6-01–B6-08 PASS，`pageErrors=[]`。
- 证据：
  - `.local/prototype-remediation/b2-06-settings/evidence/b2-06-settings-results.json`
  - `.local/prototype-remediation/b2-06-settings/evidence/*.png`：宽屏空态/设置目录/
    旧值/草稿头像/确认发布/发布回执/主页、390 目录/编辑/状态/公开文件/聊天返回
  - `.local/prototype-remediation/b2-06-settings/evidence/host-b2-06*.log`
  - `.local/prototype-remediation/b2-06-settings/evidence/acceptance-run-20.log`
- 控制端点 `4357` 返回 health；真实 DSH 宿主端口 `4392`，未使用 4388/4390 或此前端口。

## 边界与已知限制

- 只改第二批第 6 项；未提前实现第 7 项聊天构图、第 8 项全局导航。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/Linux、
  第三方字体差异或真实公网。
- 头像由 daemon 按既有图片校验重新编码；验收比较发布后 A 的公开文件与 B 下载字节，
  不要求与上传源文件逐字节相同。
- 未提交、未推送、未发布。
