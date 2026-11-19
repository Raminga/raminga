# 第二批第 2 项：联系人列表（隔离验收）

本目录只验证 `docs/ui-prototype-remediation-plan.md` 第二批的「联系人列表」。使用
独立端口（宿主 `4372`、控制端点 `4339`）、独立 DSH profile 和独立 Node 数据目录
`.local/prototype-remediation/b2-contacts/`，不读写 `~/.raminga`、用户 DSH 配置、
真实桌面、`4354`/`4362`/`4366`/`4370` 及其数据，也不占用复验曾用的 `4374`/`4341`。

## 直接复验

```sh
cd /Users/fanyuhang/Documents/raminga
export GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod

make build
( cd packages/ui && npm test && npm run build )
( cd plugins/dsh && npm test && npm run build:ui )

node scripts/ui-acceptance/batch2-02/cleanup.mjs
node scripts/ui-acceptance/batch2-02/prepare.mjs
python3 -B scripts/ui-acceptance/batch2-02/acceptance.py
python3 -B scripts/ui-acceptance/batch2-02/persistence_review.py
```

`cleanup.mjs` 停止 `node-a/b/c/e`，只删除已退出进程留下的 PID 记录；对仍存活的旧
PID 只报告并拒绝猜测（PID 可能已被无关进程复用），不按端口或进程名杀未知进程。本次
验收启动的 DSH Web 由 `acceptance.py` 的实际 Popen 对象停止；若端口仍被占用则拒绝启动。
`prepare.mjs` 在重建节点前同样只清理已退出的旧记录，并用 `DisconnectPeer` + 重新连接
修复上一个 A 进程留下的死连接。

`acceptance.py` 自己启动/停止端口 4372 的隔离 DSH Web，执行 B2C-01–08，写入
`evidence/b2-contact-list-results.json`、宿主日志和截图。每次先发 3 条真实未读，
再清点未读徽标，不依赖上次是否已读；开头只删除本 fixture 的
`agent/host/dsh/contact-list.json`，让连续复跑从无缓存的初始态开始，再由 B2C-02/05
重新读取并写入、B2C-08 验证重载复用。因此不执行 `prepare.mjs` 也可以连续复跑。

`persistence_review.py` 复用同一 fixture，专门复验本次退回的问题：已验证公开名称/
头像/通讯录线索在完整 reload、新 Chromium 进程、宿主重启、来源节点离线、头像损坏、
投影损坏/缺失/错版本后仍然正确复用或安全回退。结果写入
`evidence/b2-contact-persistence-results.json`。

## fixture

`prepare.mjs` 创建 A/B/C/E 四个真实节点和一条仅本机的离线联系人 D：

- B「林岸」在线，拥有公开 Agent 头像/名称和 7 条真实未读消息；接受脚本每次再发送
  3 条真实未读，使重复运行不依赖上次的已读状态；
- C 在线、公开长名称、无头像、无消息；
- D 只在本机 SQLite 中，未运行节点，缺失公开资料，长本地名称；
- E「星云收集者」曾真实连接 B 并进入 B 的 `public/friends.json`，随后停止；A 没有
  连接 E，也不在 A 的联系人中；
- B 的公开通讯录还列出 A 和 C，但 A 会过滤掉自己与已有联系人，只留下 E 作为线索。

## 本次修复的持久化

真实读取 B 的档案和「他的通讯录」后，DSH 宿主把已核对的公开事实写入
`<node-a>/agent/host/dsh/contact-list.json`（目录 `0700`、文件 `0600`、原子替换）：

- 公开 Agent 名称、简介、兴趣、交流风格和读取时间；
- 头像的公开路径、SHA-256、MIME、大小；不写头像字节、不写 data/blob URL；
- 通讯录线索的目标 Peer ID/名称/简介、来源 Peer/名称和读取时间。

联系人列表只通过新的本机只读 `contactProjection` 读取这份投影，再从已有的
`downloads/<peer>/` 读取头像字节并逐次核对大小、SHA-256 和 PNG/JPEG 签名；
不调用 `GetPeerProfile`、`GetPeerFriends`、`DownloadPeerFile` 或 `Connect`。
损坏、缺失、schema 不符或头像哈希不符时回退本地名称/首字头像/隐藏线索，且不会
把损坏值写回或删除真实联系人。投影只存在 `agent/`，不会进入 `public/`。

## 证据

`.local/prototype-remediation/b2-contacts/evidence/`：

- `b2-contact-list-results.json`：B2C-01–08 的断言结果、行/聊天气泡尺寸、剪贴板、
  线索无副作用检查、窄屏溢出和截图清单；
- `b2-contact-persistence-results.json`：PERSIST-01–08 的 reload/新浏览器/宿主重开/
  来源离线/损坏/缺失/恢复/无副作用结果；
- `host-b2-contact-list.log`：隔离 DSH Web 启动日志与本地 token URL；
- `wide-contact-list-initial-1440.png`：未读取任何档案时的本地名称、头像首字、离线、
  长名称、未读/时间/最近消息/聊天入口；
- `wide-contact-list-verified-b-1440.png`：打开 B 档案后列表复用同一公开名称/头像，
  同时保留「本机备注」；
- `wide-contact-list-long-no-avatar-1440.png`、`wide-c-profile-long-no-avatar-1440.png`：
  长公开名称和缺头像回退；
- `wide-contact-full-peer-id-1440.png`：展开完整 Peer ID 后仍在正文下方，不挤占名称/消息；
- `wide-contact-clue-section-1440.png`、`wide-contact-clue-view-1440.png`：真实线索独立一节、
  「未访问」、查看说明；
- `wide-contact-list-after-reload-1440.png`：完整 reload 后公开名称/头像/线索仍在；
- `review-persisted-new-browser-1440.png`、`review-persisted-host-restart-390.png`：
  新浏览器进程和宿主重开（390×844）复用；
- `review-persisted-source-offline-list-1440.png`、
  `review-persisted-source-offline-1440.png`：来源 B 停止后列表仍显示名称/头像/线索，
  查看线索不连接、不添加；
- `review-persisted-damaged-avatar-1440.png`：本地头像字节损坏时不展示旧图；
- `review-persisted-invalid-projection-1440.png`、
  `review-persisted-missing-projection-1440.png`：投影损坏/缺失时回退本地联系人；
- `review-persisted-restored-projection-1440.png`：恢复后重新显示，证明回退不是破坏性状态；
- `narrow-*-390.png`：390×844 的单底栏、时间/聊天/头像、长名称换行、线索与无横向溢出。

## 结束

```sh
node scripts/ui-acceptance/batch2-02/cleanup.mjs
```

## 边界与已知限制

- 只改第二批第 2 项；未提前做联系人档案、时间线、聊天视觉、发布/设置、导航窄屏等后续项。
- 投影只保存最近一次**成功**读取的公开事实，不保证是对方当前资料；界面以读取时间
  和「最近读取/本机已核对副本」区分，打开档案会重新读取并替换成功结果。失败读取
  不会删除最后一次成功快照。
- 投影不保存聊天、私有备注、印象或任何本机私有文本；本地名称/备注仍由
  `ListFriends` 提供，不写入投影。
- 验收使用隔离 Chromium Web 宿主，不声称覆盖 Electron 桌面壳、IME、Windows/Linux。
- 未提交、未推送、未发布；fixture 不复制 Go/npm 缓存，只使用 24 KiB 测试头像。
