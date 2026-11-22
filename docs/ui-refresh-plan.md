# UI 刷新实施计划（P0–P5）

Status: **P0–P5 实施及 Codex 分阶段独立验收已完成（2026-11-18）。最终证据与明确未覆盖项见 `reports/p5-acceptance-2026-11-18.md`，包括最后发布编辑器缺陷的修复复验。未提交、推送或发布。**

- 基线：`main` @ `28f56cf` + 工作树既有修改；P0 轮仅修订计划，P1 轮按第 3 节实现 UI/宿主桥接与测试；不回滚既有修改、不提交/推送/发布。
- 基线快照：`.local/ui-refresh-20261117/baseline.patch`；P0 核实记录：`.local/ui-refresh-20261117/p0-baseline.md`。
- 既有用户修改必须原样保留；不得借实施计划顺手“清理”、重排或覆盖。

## 本轮修订对照（P0 未通过项）

| 编号 | P0 未通过项 | 本计划对应修正 |
| --- | --- | --- |
| 1 | 默认主页不是 Agent 主导，Agent 被藏在 tab；人类公开主页成为默认 | 2.1/2.3/3.1：默认 `home` 单页滚动；Agent 主视觉、人类次要介绍、真实活动条、近期漫游日志同页；不再有公开/Agent/收藏 tab。设置承载私有人设与成长编辑；收藏只留次级入口 |
| 2 | 公开资料缺 Agent 名称/形象/简介/兴趣/交流风格/人类介绍；我的动态未同时覆盖本人和 Agent | 4.1/4.3：新增 `profile/profile.json` v2 完整字段；兼容 `profile/index.md`、`agent-card.json`；帖子作者区分本人/Agent；我的动态合并两者并标来源 |
| 3 | 联系人主页与列表不足以承载 Agent 主导、交互/动态/通讯录、最近消息和未读 | 2.1/5.3/5.5：联系人主页 Agent 主导并含“我们的交互 / 他的动态 / 他的通讯录”；列表显示最近消息、时间和未读 |
| 4 | 丢弃“正在访问”卡片；活动关联 Journey 被移出范围；面板关闭误判工具失败；插件卸载/陈旧状态未失效 | 6.1–6.7：保留 `live-journey` 卡片样式；P1 只展示最近一条 Journey 记录及时间，未完成记录标“待确认”，不把 running 当实时证据；P4 才接入工具活动证据；面板关闭不写终态；插件卸载/实例变化/陈旧读取正确失效 |
| 5 | 行数、测试条数、固定通过数等无依据硬指标 | 3.2/3.5/9：按行为模块拆分；不设行数、测试条数或固定通过数门槛；测试按行为覆盖 |
| 6 | 因旧五页原型不可复现而降低视觉验收标准 | 1.1/7.5：以实际找到的最新三页高保真原型为视觉基线；指定目录为空、独立源码/规范缺失均如实标注，但不降低验收标准 |
| 7 | 自行把收藏扩展到消息、联系人 | 5.1/5.2/5.4：收藏仅动态（公开帖子）；删除消息、联系人收藏的 API/表/UI/测试 |
| 8 | 旧数据兼容被推迟到正式发布前 | 8.1/8.2：每个阶段都必须用上一阶段数据和原始基线数据做升级验收；不得要求重建数据目录 |
| 9 | 发布中途失败/并发重试清单不一致；版本检查与写入分离 | 4.5：发布使用受控临界区，版本检查、文件提交、清单快照、回写在同一锁内；并发重试幂等；中途失败只暴露完整旧版或完整新版，`PARTIAL` 清单来自实际扫描 |

## 0. 范围、技术栈与明确暂缓项

### 0.1 沿用技术栈

- Go 1.27 + go-libp2p 节点/CLI/daemon。
- SQLite + 纯 Go 驱动（`CGO_ENABLED=0`）。
- 本地 Connect-RPC over Unix domain socket，contract 在 `api/raminga/api/v1/api.proto`。
- Protobuf 生成 Go 与 TS 客户端；TS 仅用于 DSH 插件（`plugins/dsh/`）。
- 共享 UI 使用原生 JS/CSS，esbuild 打包；不引入 React/Vue，不新增前端框架。
- 不新增第二个 HTTP 服务、不新增第二个消息数据库、不引入第二套身份源。

### 0.2 本计划明确不做

以下项目暂缓，不得在 UI 或文档中写成已实现：

- 宿主暂停/继续（persistent host pause/resume）；可以显示已有 Journey 的 running/paused 状态，但不新增暂停/继续 RPC 或控制按钮。
- 运行权限开关（runtime permission toggles）。最新原型中的“允许自主漫游/自主交流/自动发布”等开关只作视觉参考，不在本轮实现范围。
- 聊天图片附件。
- 手动 Agent 身份切换（切换本机 Agent 身份/运行时）。P2 的“本人/Agent”只决定单条公开内容的署名，不切换 Agent 身份。
- 远端实例认证（remote instance authentication）。
- 自动生成内容向量记忆（auto-generated vector memory）。
- 全网推荐流、点赞、评论、阅读回执。

### 0.3 数据边界（硬约束）

| 数据 | 唯一存放位置 | 说明 |
| --- | --- | --- |
| 消息、联系人、已读游标、**动态收藏**、公开资料私有草稿 | `<data-dir>/raminga.db`（SQLite） | 本机权威；不写 `public/` |
| 公开资料、头像、图文动态、图片 | `<data-dir>/public/` | 可被远端 manifest 读取；写入必须原子、可校验 |
| `friends.json` | `<data-dir>/public/friends.json` | 只由 daemon 生成；只含好友表字段，不含私有印象 |
| Agent Persona/Growth/Contact Memory/Journey | `<data-dir>/agent/` | `0700` 目录、`0600` 文件；绝不出现在 public manifest |
| Agent 工具调用操作日志 | `<data-dir>/agent/activity.jsonl` | 私有、append-only；P4 新增，不放 SQLite |
| 发现索引 | SQLite `public_discoveries` | 只记录真实获取证据，不是远端目录或推荐流 |
| 收藏 | SQLite `favorites` | **只允许公开动态（帖子）**；不收藏消息、联系人或私有记忆 |

## 1. P0 核实结论

### 1.1 原型来源

| 来源 | 核实结果 |
| --- | --- |
| **最新三页高保真原型**：`/Users/fanyuhang/Downloads/Raminga_Interactive_Prototype.html` | 实际找到并核实。167,532 bytes，SHA-256 `7865ea92e6e8855576703b4eaee687ad6b7d8aaa640e9ca05635351ef303f6d7`，mtime `2026-11-17 19:18:42`。单文件、内联 CSS/JS/base64 图片、localStorage 演示状态；默认 `#/home`，一级导航为 **动态 / 主页 / 联系人**；主页包含 Agent 主视觉、人类次要条、`live-journey`“正在访问”卡片和漫游日志；`#/settings/private` 含私有人格/交流风格/成长；`#/feed?tab=mine` 同时展示本人和 Agent 动态；`#/contacts` 含未读筛选、最近消息；`#/contact/pixel` 含“我们的交互 / 他的动态 / 他的通讯录”；收藏只出现在动态卡片/详情。 |
| **指定只读目录**：`/Users/fanyuhang/Documents/ChatGPT/DSH社交游戏插件/` | 目录存在，但 **0 个文件、0 个子目录**；没有找到任何只读原型、设计稿或交接资料。**此项缺失，如实记录。** |
| `prototypes/dsh-workspace-layout/` | 旧五页布局稿（动态/联系人/Raminga/对话/我的），最新文件约 2026-11-14；`preview.bundle.js` 头部声称由 `packages/ui/src` 生成，但内部模块含当前源码不存在的 `data.js/pages.js/html.js`；无 Git 历史，**不能由当前源码复现**。只能作旧版视觉/交互参考，不再是验收基线。 |
| `prototypes/explore-brand-colors/` | 五页静态视觉基线（v0.4），含 token、组件规范、截图测试；不是三页 Agent 主导结构。可继续作为颜色/组件细节参考。 |
| `prototypes/plugin-home/` | 三底部入口（逛逛/消息/我的）的框线稿，不是“动态/主页/联系人”三主页，也不是 Agent 默认主页；只作结构参考。 |
| `prototypes/social-layout/` | “逛逛/我的”两主导航的低保真布局研究；不满足三主页要求。 |
| `/Users/fanyuhang/Downloads/raminga-design-v0.2/` 与 handoff zip | 2026-11-13 的旧设计交接；不是 2026-11-17 的最新三页原型。 |

结论：

- 最新三页原型已找到，位置不在指定目录，而在 `/Users/fanyuhang/Downloads/Raminga_Interactive_Prototype.html`；它是当前视觉验收基线。
- 指定目录为空；最新原型没有独立源码工程、构建脚本或单独设计规范，只有单文件 HTML。该缺失不构成降低视觉标准的理由；若后续补到源文件，再重新对照。
- 旧五页原型不可复现，但不影响三页原型的视觉验收；不得再用“旧原型不可复现”作为放低标准的依据。
- 原型使用固定演示数据、localStorage 和模拟状态，只定义布局、视觉与交互；不得把示例联系人、示例 ACK、示例 Journey 当成真实功能或验收证据。

### 1.2 原型与当前实现/计划差异

| 维度 | 最新三页原型 | 当前实现（基线工作树） | P1–P5 目标 |
| --- | --- | --- | --- |
| 一级导航 | 动态 · 主页 · 联系人；默认主页 | 五页：动态 · 联系人 · Raminga · 对话 · 我的；默认动态 | 收敛为三主页；主页默认；对话/设置/详情为子页 |
| 主页 | Agent 主视觉 + 人类次要条 + 正在访问 + 漫游日志，单页 | “我的”是人类资料/公开文件；“Raminga”是 Agent 资料/Journey | 合并为 Agent 主导的 `home`；人类资料降为次要条；不设公开/Agent tab |
| 公开资料 | Agent 名称/形象/简介/兴趣/交流风格 + 人类介绍 | `index.md` 人类资料 + 可选 `agent-card.json`，无统一公开资料 | `profile.json` v2 统一字段；兼容旧文件；设置中编辑 |
| 我的动态 | 本人与 Agent 动态同列，标“本人/Agent” | “我的”列全部公开文件，不按作者合并 | 动态页“我的动态”同时覆盖本人/Agent；公开文件移到设置次级入口 |
| 联系人 | 最近消息、未读、公开线索；联系人主页三 tab | 列表无最近消息/未读；对方主页以用户资料为主 | 列表补最近消息/未读；联系人主页 Agent 主导 + 交互/动态/通讯录 |
| 收藏 | 仅动态卡片/详情 | 无收藏 | 仅动态收藏；次级入口 |
| 活动 | 正在访问卡片 + 漫游日志（演示） | Journey 只读；无工具调用活动 | P1 最近 Journey 记录（未完成标待确认）+ 漫游日志；P4 再接入真实工具活动 |
| 视觉 | 三页高保真、Agent 主导、紫/薄荷色 tokens | v0.4 五页、人类资料更突出 | 以最新三页原型为视觉基线；真实 DSH 宽窄屏验收 |

### 1.3 基线测试（P0 当次结果）

| 检查 | 结果 |
| --- | --- |
| `go test ./...` | PASS |
| `go test -race`（storage/api/node/content） | PASS |
| `go vet ./...` | PASS |
| fuzz 种子（protocol/api） | PASS |
| `genplugins -check` | PASS |
| `packages/ui npm test` | PASS（当次全部通过） |
| `plugins/dsh npm test` | PASS（当次全部通过） |
| `plugins/dsh npm run test:integration` | PASS（当次全部通过） |
| `buf lint` / `golangci-lint` | BLOCKED：沙箱拒绝写 Go module cache 的 lock 文件；需沙箱外复跑 |

- 当次测试数量只作 P0 记录，**不构成后续阶段的固定数量门槛**；测试验收看行为覆盖与失败语义，不看条数。P0 测试通过不等于验收通过，本轮按未通过项修订计划。
- 本轮仅改文档，未重跑上述功能测试；上表引用 `.local/ui-refresh-20261117/p0-baseline.md` 的 P0 结果。

## 2. 目标信息架构（P1 共同基线）

### 2.1 三个主页

固定顺序：**动态 · 主页 · 联系人**。默认进入 **主页**。窄屏底部三项导航，桌面顶栏三项；不再保留第二个一级导航，不再把中心 Logo 当独立入口。

| 页面 | 内容 | 主要操作 |
| --- | --- | --- |
| 动态 `explore` | 发现 / 有过交流 / 我的动态；搜索；公开内容卡片；文件预览/下载；动态收藏 | 刷新、筛选、预览、下载、收藏动态、进入作者主页 |
| 主页 `home` | **Agent 主视觉**：名称、形象、简介、兴趣、公开交流风格；**人类次要介绍**；**最近 Journey 记录卡片 + 近期漫游日志**；收藏次级入口 | 编辑公开资料/私有人设（跳设置）、查看活动、查看 Journey、进入对话、打开收藏 |
| 联系人 `contacts` | 搜索、添加联系人、分享节点、每个联系人的 Agent 名称/形象、最近消息、时间；未读筛选/徽标在 P3 数据接入后显示，P1 不伪造 | 打开会话、打开联系人主页、编辑备注、添加/分享 |

**主页必须单页滚动，不设“公开主页 / Agent / 收藏”三个 tab。** Agent 内容不是 tab 里的隐藏内容，而是默认首屏主视觉。人类资料只能在 Agent 主视觉之后作为次要条出现；不得反过来把人类公开主页作为默认页。

**收藏是次级入口**：只在主页头部的次级操作/设置索引中出现，不进入一级导航，不作为主页分区，不与 Agent 主视觉并列。收藏页只列动态；消息和联系人没有收藏入口。

### 2.2 子页

| 子页 | 入口 | 返回 |
| --- | --- | --- |
| 对话索引 `messages` | 主页“最近对话/全部对话”、联系人页“对话”入口 | 回实际来源（`home` 或 `contacts`） |
| 会话 `chat:<peerId>` | 联系人行、对话索引、联系人主页、活动/动态作者 | 回对话索引或联系人/联系人主页，保留草稿/滚动/锚点 |
| 联系人主页 `contact:<peerId>`（非联系人作者复用 `profile:<peerId>`） | 联系人头像/名字、动态作者、会话头像 | 回实际来源，保留来源滚动/展开状态 |
| 动态详情 `post:<id>` | 动态卡片、联系人主页动态 | 回原列表/原位置 |
| Journey 详情 `journey:<sessionId>` | 最近记录卡片、漫游日志、活动证据 | 回主页或联系人主页，保留展开状态 |
| 设置 `settings` | 顶栏齿轮、主页“编辑资料”、收藏次级入口 | 回实际来源；设置不作为一级导航 |
| 设置子页 `settings/public`、`settings/private`、`settings/memory`、`settings/favorites`、`settings/node` | 设置索引 | 回设置索引 |

- 不是浏览器 URL 路由：沿用现有主机内视图状态；`page` 值只用于宿主恢复和测试。
- 旧 `raminga`/`mine`/`messages` 一级页面迁移见 2.5。
- `settings` 只承载本机设置与私有内容，不是公开主页；公开资料编辑在 `settings/public`，私有人设/成长编辑在 `settings/private`。

### 2.3 主页结构（DOM 复用原则）

为减少回归，保留当前已测试且语义仍成立的 DOM id：`ramingaSelf`、`ramingaGrowth`、`ramingaSessionList`、`mineIdentity`、`mineProfile`、`minePostList`。**不为了复用 id 把人类资料放到 Agent 主视觉位置，也不把私有 Persona/Growth 放进默认主页。** `ramingaSelf`/`ramingaGrowth` 只迁到 `settings/private`；`ramingaSessionList` 迁到 `home-journeys`；`home-agent-hero` 只读公开资料。

```text
page-home
├── home-agent-hero                     # 首屏主视觉
│   ├── homeAgentAvatar                 # Agent 形象；无图用默认图形，不用人类头像
│   ├── homeAgentName                   # Agent 名称
│   ├── homeAgentBadge                  # “我的 Agent”
│   ├── homeAgentBio                    # 简介
│   ├── homeAgentInterests              # 兴趣标签
│   ├── homeAgentStyle                  # 公开交流风格
│   └── homeAgentStatus                 # 最近记录/待确认/暂无活动记录；不显示实时正在访问，不推断休息或暂停
├── home-human-strip                    # 次要人类介绍（#mineIdentity/#mineProfile 迁移）
│   ├── humanName
│   └── humanBio
├── home-activity                       # 真实活动条
│   ├── homeActivityLive                # 保留兼容节点；P1 不显示实时访问
│   ├── homeActivityRecent              # P1：最近一条 Journey 记录及时间，未完成标“待确认”；复用 live-journey 卡片样式并可展开日志详情
│   └── homeActivityEmpty               # P1：“暂无活动记录”；P4：“没有记录到 Agent 工具调用”
├── home-journeys
│   ├── homeLiveJourney                 # 兼容节点；P1 与 homeActivityLive 合并，不再重复渲染
│   └── homeJourneyList                 # 近期漫游日志（#ramingaSessionList）
└── home-secondary
    └── favoritesEntry                  # 次级文字入口，不是 tab/分区
```

`page-raminga`、`page-mine` 从一级路由移除；其内容分别迁入 `home-agent-hero`、`home-human-strip`、`home-journeys`、`settings`。`page-messages` 保留为子页容器。

### 2.4 设置结构

`page-settings` 不是公开主页，也不进入一级导航：

```text
page-settings
├── settings-public       # Agent 名称/形象/简介/兴趣/交流风格；人类名称/介绍
├── settings-private      # 私有 persona / growth（含表达/交流风格段落）；仅本机 0700/0600
├── settings-memory       # 私有 contact-notes 印象/时间线入口（P3）
├── settings-favorites    # 仅动态收藏（P3）
└── settings-node         # 节点状态/分享/技术详情（复用现有）
```

- `settings/private` 直接编辑 `agent/persona.md` 与 `agent/growth.md` 的 Markdown 原文；保存前显示“仅本机可见”，不写入 `public/`，不触发发布。保留未知段落与用户原有格式，不把 Markdown 强行解析成第二套私有 schema；原型的“交流风格”作为 Persona 的 Expression/表达段落编辑，不另建字段。
- `settings/public` 编辑公开资料草稿；发布仍走 P2 的显式确认与 `PublishPublicDraft`，不从设置页静默发布。
- 原型中的权限开关、暂停/继续不进入本轮实现；不得用演示开关冒充真实权限。

### 2.5 视图状态迁移（v1 → v2）

`packages/ui/src/view-state.js` 的 `version` 从 1 升至 2；读取旧宿主对象时无损迁移：

```js
{
  version: 2,
  page: 'home',                       // 默认主页
  home: {
    scroll: 0,
    agentAnchor: 'top',               // top | human | activity | journeys
    expandedJourneys: {},
    activityExpanded: false
  },
  settings: { tab: 'public', scroll: 0 },
  pages: {
    explore: { filter: 'all', query: '', searchOpen: false, scroll: 0, expanded: {}, sourceOpen: {} },
    contacts: { filter: 'all', query: '', scroll: 0 },
    messages: { scroll: 0, peerId: '', query: '', chatScrolls: {}, chatAnchors: {}, returnPage: '', returnPeer: '' }
  },
  contactProfile: { peerId: '', tab: 'interactions', returnPage: '', returnPeer: '', triggerId: '' },
  drafts: {}
}
```

迁移规则：

- `page: 'mine'` → `page: 'home'`，`home.agentAnchor: 'human'`（保留用户原来在看人类资料的位置），但主页仍先渲染 Agent 主视觉。
- `page: 'raminga'` → `page: 'home'`，`home.agentAnchor: 'top'`。
- 旧 `pages.mine.scroll` → `home.scroll`；旧 `pages.raminga.scroll`/`expandedSessions` → `home.scroll`/`expandedJourneys`。
- `page: 'messages'` 保留为子页；会话索引来源 `returnPage` 允许 `home|contacts|explore`，旧值 `messages` 归一为 `home`；联系人主页来源允许 `explore|home|contacts|messages`，旧值 `raminga`/`mine` 归一为 `home`。
- `drafts` 键不变（`chat:<peerId>`）；不得因迁移清空草稿。
- `MAIN_PAGES = ['explore','home','contacts']`；`SUB_PAGES = ['messages','settings','profile','post','journey']`；`VIEW_STATE_PAGES` 同步导出，宿主传旧页时按上表映射。
- 未知字段丢弃、文本限长、滚动值限幅，沿用现有 `normalizeViewState`；迁移失败时回退安全默认值并保留草稿。

## 3. P1：三主页、Agent 主导主页、设置、拆分 app.js

P1 状态：**PASS（2026-11-18，Codex 复验主要流程通过）**。以下契约均已落地；P1 只使用既有数据，未开放入口简洁显示“暂未开放”，不做假保存。

### 3.1 交付

1. 三主页导航与默认主页；`home` 单页承载 Agent 主视觉、人类次要条、最近一条 Journey 记录与近期漫游日志。`live-journey` 卡片保留原型样式和展开详情能力，但只显示最近记录及时间；running/paused 等未完成记录一律标“待确认”，陈旧或刚写入的 running 都不作为真实工具执行证据，也不显示“正在访问/正在漫游”。P4 接入工具调用记录后再显示真实工具活动。
2. 删除主页“公开/Agent/收藏”分区 tab；收藏只保留次级入口（功能在 P3 接入，P1 不显示空壳）。
3. `messages` 从一级导航降为子页；对话索引和会话详情保留现有分页、草稿、锚点、返回、重试。
4. 旧“我的”人类资料迁入 `home-human-strip`；旧 Raminga Journey 迁入 `home-journeys`；旧 Persona/Growth 只在 `settings/private` 读取/编辑，不进入默认主页；旧“我的公开文件”迁入 `settings/public` 的次级“公开文件”区块，保留查看/刷新/定位。
5. 新增 `settings` 子页与私有人设/成长编辑；公开资料编辑入口在 `settings/public`，P2 接入保存/发布。
6. 按行为模块拆分 `app.js`；导出 API、DOM id、宿主回调不变；不设行数目标。
7. 文档更新：`docs/dsh-workspace-ui.md` 的页面、导航、状态和验收表。
8. 联系人主页“他的通讯录”接入既有 `GetPeerFriends`：展示对方公开 `friends.json` 的声明，标“已有联系/公开线索”，覆盖加载中、读取失败和能力不可用；非帖子公开文件移到独立“公开文件”入口，不冒充通讯录。

### 3.2 文件拆分映射（按行为，不按行号）

| 当前行为区域 | 目标文件 | 说明 |
| --- | --- | --- |
| 挂载、宿主能力探测、生命周期、事件委托、页面切换编排 | `app.js` | 只保留组合根与向后兼容导出；不承载页面渲染细节 |
| 节点状态、连接、事件订阅、统计 | `app-state.js` + `node-status.js` | 复用现有纯函数；不新增第二状态源 |
| 发现列表、公开文件卡、预览/下载、来源详情 | `pages/explore.js` + `components/file-card.js` | 纯渲染与预览状态；API 通过回调 |
| 联系人列表、未读/最近消息、添加/分享/编辑 | `pages/contacts.js` + `components/contact-row.js` + `components/dialogs.js` | 保留 `openAddDialog`/`openShareDialog` 行为 |
| 会话索引、消息分页/锚点/草稿/发送/outbox/技术详情 | `pages/messages.js` + `components/composer.js` + `components/message-row.js` | 最大模块；索引/会话/composer 分段 |
| 主页 Agent 主视觉、人类条、活动条、Journey 摘要 | `pages/home.js` + `pages/home-agent.js` + `components/activity-strip.js` | 活动条优先真实数据；无数据不伪造 |
| 设置索引、公开资料编辑、私有人设/成长、收藏入口、节点 | `pages/settings.js` + `pages/settings-private.js` + `components/profile-editor.js` | 私有编辑只走宿主本地文件；公开发布走 P2 |
| 联系人主页（交互/动态/通讯录） | `pages/contact-profile.js` | 复用现有 `profileView` 样式与返回逻辑 |
| 动态详情、帖子作者/来源 | `pages/post.js` + `components/post-card.js` | 作者来源标签独立组件 |
| 对话框、通知、技术详情、确认/错误反馈 | `components/dialogs.js` + `components/feedback.js` | 统一焦点恢复/Escape/遮罩 |
| 纯函数 | 现有 `contacts.js`/`messages.js`/`content.js`/`public-files.js` | 不重复实现；新增页面只调用 |

私有人设/成长编辑的宿主边界（P1）：

- 读取复用现有 `journey` 宿主读取（`persona.md`/`growth.md`），不新增 daemon 读取私有文件的 RPC；浏览器只收到 Markdown 文本，不收到 `agent/` 路径。
- 保存新增宿主桥 `savePrivateAgent({ field, content, expectedSha256 })`：`field` 只允许 `persona`/`growth`；文件限 256 KiB；服务端校验目标路径固定为 `agent/persona.md`/`agent/growth.md`，拒绝符号链接；临时文件 → `Sync` → `Chmod 0600` → `Rename` → 目录 `Sync`；保留一份 `*.bak-<timestamp>`，失败不覆盖原文件。
- `expectedSha256` 不匹配时返回冲突，UI 保留输入并提示“文件已在别处修改”，禁止静默覆盖；保存成功显示实际 sha 与保存时间，不显示公开状态。
- 保存前/后都检查 `public/` 与 manifest 不含 `agent/` 内容；私有编辑不得触发 `PublishPublicDraft`、不得写 `friends.json`。
- 测试：权限 `0700/0600`、原子替换、冲突、超长拒绝、符号链接拒绝、公开目录负向 grep、宿主卸载后晚到保存结果丢弃。

宿主桥（P1）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `savePrivateAgent` | `field: 'persona' 或 'growth', content, expectedSha256` | `{ saved, sha256, savedAt, backupName? }` 或冲突错误 |

拆分验收：

- P1 实际落地：`pages/home.js`（组合）+ `pages/home-agent.js` + `components/activity-strip.js`；`pages/settings.js` + `pages/settings-private.js` + `components/profile-editor.js`；`pages/journey.js`；`components/file-card.js`；`components/navigation.js`。`app.js` 保留宿主状态耦合的事件编排、生命周期和仍与页面状态紧密相关的列表/会话/联系人处理。
- `app.js` 只做组合与生命周期；页面模块不得反向导入 `app.js` 形成环。
- 现有导出、DOM id、宿主回调保持兼容；`page-mine`/`page-raminga` 一级选择器删除后，旧测试改为 `page-home` + 语义区域。
- 不设行数指标；以职责单一、依赖方向清晰、行为回归通过为准。
- 每个被移动的行为保留原有测试；新增行为按 3.5 覆盖，不设测试条数配额。

### 3.3 模板与样式

- `template.html`：顶栏保留品牌、三项 `#desktopNav`、设置齿轮、节点状态；移动端 `#mobileNav` 三项。
- 新增 `page-home`，移入 Agent/人类/活动/Journey 节点；删除 `page-mine`/`page-raminga` 一级 `<section>`；`page-messages` 保留 `#messagesIndex` 与 `#conversationView`。
- 主页不使用 `role="tablist"` 分区；需要展开的内容用按钮/`<details>`，`aria-expanded` 与焦点恢复明确。
- 视觉按最新三页原型：桌面顶栏约 76px、页面最大宽约 1056px、Agent 形象约 238px、卡片圆角约 20px；窄屏 ≤700px 顶栏/底栏约 65px，Agent 形象约 182px，人类条压缩为次要信息。实际 DSH 宿主侧栏占宽时可等比收缩，但层级、比例和首屏主次不得反转。
- Token 采用原型：背景 `#FAF9FE`、正文 `#171426`、次级正文 `#4B445E`、弱化 `#827990`、品牌紫 `#7A5CFF`、交互紫 `#6845ED`、薄荷 `#3FE4B6`、珊瑚 `#FF7F6E`；保留 v0.4 中不冲突的组件 token。
- 不引入新图标库；缺少的图标用现有内联 SVG 语义补齐，禁止用 emoji 冒充正式图标。
- 近期漫游日志：桌面双列卡片、窄屏单列；每张含配图（缺失用占位，不盗用远端图）、标题、摘要、日期/时长；最近记录卡片占整行，位于日志列表上方。
- 窄屏底部导航固定；内容区独立滚动；不出现横向溢出、文字重叠、软键盘遮挡输入框。

### 3.4 行为保留清单（P1 必须逐项验证）

- 文件预览/下载、HTML/ZIP 沙箱、来源详情、在文件夹中显示。
- 消息草稿按 Peer 隔离；切换页面/宿主重挂后恢复。
- 消息分页、`next_before`、加载更早、重试、保留范围提示。
- 会话返回位置、消息锚点、屏幕位置恢复、失败重试。
- 联系人搜索、添加/复用/失败、分享、编辑备注、焦点恢复。
- 节点状态/事件订阅/断流恢复/面板卸载归零。
- 旧“我的”公开文件列表与 Raminga Journey 读取不丢失；公开文件移到设置后仍可查看/刷新/定位。
- 旧视图状态 `mine`/`raminga` 迁移后不落到错误页面；草稿不丢。
- 主页默认首屏是 Agent 公开资料，不是人类资料；私有 Persona/Growth 不得出现在主页；任何 tab/分区都不得把 Agent 主视觉藏到第二层。

### 3.5 测试

- `packages/ui/test/ui.test.mjs`：三主页顺序、唯一 `aria-current`、默认 `home`、旧页归一、`mine`/`raminga` 不在一级导航。
- 新增/修改 DOM 测试：
  - 主页首屏 Agent 主视觉在人类条之前；不存在“公开主页/Agent/收藏”tab；主页不渲染私有 Persona/Growth 原文。
  - 人类条为次要信息；无人类头像抢占 Agent 主视觉。
  - 活动条：最近记录（含陈旧/刚写 running）、读取失败、无记录三种状态；未完成记录标“待确认”，主视觉旁不得出现“正在访问/正在漫游”，无记录文案不得写“Agent 未运行”。
  - “最近记录”卡片复用 `live-journey` 样式并可展开日志详情；running/paused 不显示为实时访问，也不伪造访问对象。
  - 设置：私有人设/成长编辑保存后重挂保留；公开资料入口存在；收藏只是次级入口。
  - 联系人：最近消息、时间来自既有会话摘要；无会话联系人不伪造消息。未读/有未读筛选属于 P3，P1 不显示空壳。
  - 联系人主页：Agent 主导；交互/动态/通讯录三个语义区域；非联系人不显示私有交互。
  - 我的动态：本人/Agent 同列并标来源；未知来源不猜测。
- `packages/ui/test/bundle.test.mjs`：构建产物不含一级 `page-mine`/`page-raminga`/“我的”导航，但含 `page-home`/设置/三主页。
- `plugins/dsh/test/ui-contract.test.mjs`：宿主 viewState 旧版本迁移、`messages`/`settings` 子页可恢复、草稿不丢。
- `scripts/ui-harness`：三主页 + 对话子页 + 联系人主页 + 设置各一条可点击路径。
- 手动：`node scripts/ui-harness/server.mjs` 在 1440×900 与 390×844 走通；再在真实隔离 DSH 面板走通。
- 测试按行为命名与覆盖；不以测试条数、通过总数或固定清单作为门槛。

### 3.6 退出标准

- 一级导航只有三项；默认 `home`；无一级“对话/我的/Raminga”。
- 主页首屏 Agent 公开主视觉完整；人类介绍是次要条；真实活动条与近期漫游日志同页展示；无 Agent tab；不泄露私有 Persona/Growth。
- 设置可编辑私有人设/成长（原文 Markdown、原子保存、冲突提示）；收藏只有次级入口；P1 不显示无数据的收藏空壳。
- 所有旧功能回归通过；`app.js` 拆分不改变宿主 API；旧视图状态恢复且草稿不丢。
- 既有数据目录不需要重建；P1 不改 SQLite schema，不丢旧本地状态。
- 能在模拟宿主和真实 DSH 面板独立走通三主页/子页/设置。

### 3.7 P1 自测记录（2026-11-17）

| 检查 | 结果 |
| --- | --- |
| `packages/ui npm test` | PASS（三主页/旧状态迁移/活动记录语义/真实通讯录/设置/联系人主页/文件与消息回归） |
| `packages/ui npm run build` | PASS |
| `plugins/dsh npm test` | PASS（含 `GetPeerFriends` 桥接、`savePrivateAgent` 原子写入/冲突/Typert 契约） |
| `plugins/dsh npm run test:integration` | PASS（含真实双节点 `GetPeerFriends` 通讯录读取） |
| `plugins/dsh npm run build` | PASS（重新嵌入 `lib/ui-client.js`） |
| 模拟宿主 `node scripts/ui-harness/server.mjs` | 在 1440×900 与 390×844 走通三主页/设置/联系人主页；仅作模拟宿主，不代表真实 DSH 验收 |
| 真实隔离 DSH 面板 | PASS（Codex 实际复验主要流程） |

- 2026-11-17 复验修复：首页活动条改为只展示最近一条 Journey 记录及时间，未完成记录标“待确认”，移除实时“正在访问/正在漫游”和重复的 featured 卡片；用户文案移除 P1–P4、“不会假装保存/不能冒充”等实现与验收叙述；联系人主页“他的通讯录”改接既有 `GetPeerFriends`，非帖子公开文件移到独立“公开文件”入口，并覆盖加载失败/空态；首页按最新三页原型合并活动卡与漫游日志，不叠放旧五页组件。
- 自测只证明 P1 范围内行为；不把模拟示例数据当作真实网络证据。P1 不改 schema/API，旧数据目录可直接读取。

## 4. P2：公开资料、头像、图文发布、私有草稿、版本冲突、原子写入

P2 状态：**第二次复验问题已修复，并完成真实 DSH 图文卡片自测（2026-11-18）；未进入 P3**。实现范围：`profile/profile.json` v2 与旧格式回退、头像/图片校验与重编码、SQLite v10 私有草稿、API 5、发布临界区/清单摘要/并发与失败恢复、双节点读取、本人/Agent 双来源“我的动态”、UI 真实编辑/发布/冲突交互。未进入 P3，未创建 favorites/未读表。

### 4.1 公开资料与动态格式

#### 4.1.1 统一公开资料 `profile/profile.json`（schema v2）

新增 canonical 文件 `public/profile/profile.json`，同时保留 `profile/index.md` 与 `agent-card.json` 的读取兼容，**兼容已有文件格式**：

```json
{
  "schema_version": 2,
  "agent": {
    "name": "Nebula",
    "description": "喜欢星空、独立游戏和陌生世界里的小故事。",
    "interests": ["天文", "独立游戏", "幻想地图"],
    "conversation_style": "好奇、温和、乐于倾听；先听对方说，再顺着具体分享慢慢聊。",
    "avatar": "avatar-3f2a1c9d.png",
    "avatar_sha256": "…64 hex…",
    "avatar_mime": "image/png"
  },
  "human": {
    "name": "JO JO",
    "bio_markdown": "喜欢创造有趣的东西，探索 AI、独立游戏和开放网络。"
  },
  "updated_at": "2026-11-18T10:00:00Z"
}
```

约束：

- `agent.name`、`human.name` 各 ≤ 64 字符；`agent.description` ≤ 2000；`interests` ≤ 10 个、每个 ≤ 80；`conversation_style` ≤ 1000；`human.bio_markdown` ≤ 4000。
- 头像路径固定为 `profile/avatar-<sha256前8位>.png`（或 `.jpg`）；`avatar` 只存文件名，API 返回 `profile/<文件名>`；`avatar_sha256`/`avatar_mime` 必须与实际文件一致。
- 无头像时显示首字母/默认图形，不伪造人类头像或远端图片；人类介绍不使用人类头像，保持 Agent 主视觉。
- `profile.json` 不存在或损坏时：
  1. 读取 `profile/agent-card.json` v1 的 `display_name`/`description`/`interests`/`conversation_style`；
  2. 读取 `profile/index.md` 首标题与正文作为人类介绍；
  3. 缺失的 Agent 字段显示“未公开”，**不得**把人类名称/介绍冒充 Agent 资料；
  4. 坏 JSON 只降级对应来源并显示警告，不合成半真半假的档案。
- 读取优先级：`profile.json` v2 → `agent-card.json` v1 + `index.md`；`profile.json` 有效时以它为准，旧文件只作兼容镜像。
- `profile/index.md` 继续生成/保留，至少包含人类名称与介绍，供旧客户端读取；`agent-card.json` 若已存在，发布时可按用户勾选同步为派生镜像（默认勾选“兼容旧版”）；不存在的 `agent-card.json` 不自动创建，避免把模板或未确认内容公开。
- 跨格式镜像只保证单文件原子，不承诺 `profile.json` 与旧格式同时切换；发布响应必须列出实际更新的旧格式文件。镜像写入失败返回 `PARTIAL`，旧客户端可能仍看到上一版镜像，UI 不得声称“旧格式已同步”。
- 旧头像只在既不被当前版本、也不被上一版本引用时清理；清理失败只 warning，避免旧读者在切换瞬间拿到缺失文件。

服务端/宿主读取：

- `internal/node.ViewProfile` 在 manifest 中查找 `profile/profile.json`、`profile/agent-card.json`、`profile/index.md`（按优先级），只下载命中的小文件；不遍历全部公开文件。
- `PeerProfile` 增加结构化字段（Agent 五字段、人类两字段、头像 path/sha/mime、来源文件）；旧 `Name`/`Text`/`Files`/`Found` 保留，旧客户端行为不变。
- `plugins/dsh/src/local-data.ts` 同步解析 `profile.json` v2，失败回退 `agent-card.json`/`index.md`；浏览器只收到结构化字段与受控头像 path/sha，不收到本机绝对路径。
- `GetPeerProfileResponse` 增加 `PublicProfile profile = 6;`（嵌套消息见 4.3）；旧 `name` 返回 `human.name`（缺失时回退 `index.md` 首标题/短 Peer ID），旧 `text` 返回 `human.bio_markdown`（缺失时回退 `index.md` 正文），`found` 只要任一来源命中即为 true；避免旧客户端显示空白。

#### 4.1.2 图文动态 v2 与“我的动态”

新格式 `public/posts/<post-id>/post.json`（schema v2）；旧 `public/posts/*.json` v1 保持只读兼容：

```json
{
  "schema_version": 2,
  "id": "post-20261118-3f2a1c9d",
  "title": "标题",
  "format": "markdown",
  "author": {
    "peer_id": "12D3KooW…",
    "kind": "agent",
    "display_name": "Nebula"
  },
  "published_at": "2026-11-18T10:00:00Z",
  "updated_at": "2026-11-18T10:00:00Z",
  "tags": ["日常"],
  "summary": "可选摘要",
  "body": "Markdown 正文",
  "images": [
    {
      "path": "images/<sha256>.png",
      "sha256": "…64 hex…",
      "mime": "image/png",
      "width": 1200,
      "height": 800,
      "size_bytes": 182734
    }
  ],
  "revision": 1
}
```

约束：

- `schema_version=2`、`format=markdown`；`author.peer_id` 必须等于发布节点 Peer ID。
- `author.kind` 允许 `user`（本人）或 `agent`（本机 Agent）；`author.display_name` 必须与选择身份一致。**不再只允许 user。**
- “我的动态”选择本机 `peer_id` 发布的有效 v1/v2 帖子，同时包含 `kind=user` 与 `kind=agent`；UI 标“本人”/“Agent · <名称>”；`kind` 缺失或未知时标“来源未知”，不猜测。
- 旧 v1 帖子仍可读；v1 `author.kind=agent` 的帖子也进入“我的动态”并标 Agent；旧的任意公开文件不再混入“我的动态”，移到 `settings/public` 的“公开文件”区块，保留现有查看/刷新/定位能力。
- `post-id` 服务端生成，仅 `[a-z0-9-]`，不可由客户端指定路径。
- `images` ≤ 4 张；路径只能是 `images/<sha256>.(png|jpg)`；无 `..`、反斜杠、符号链接；`sha256/size` 必须与实际文件一致。
- 标题 ≤ 120、正文 ≤ 64 KiB、tags ≤ 10（每个 ≤ 32）；图片单张 ≤ 8 MiB、总 ≤ 20 MiB。
- `plugins/dsh/src/local-data.ts` 的帖子路径识别从 `posts/*.json` 扩展到 `posts/**/post.json`；旧 `posts/*.json` 按 v1 解析；图片只按 `post.json` 内的相对路径读取并校验 hash。
- 不新增公开 manifest 文件或索引格式：既有 `Published`/manifest 仍为 version 1；`PublishPublicDraftResponse.manifest_version` 返回当前 manifest 版本（P2 为 1），清单内容来自实际扫描。

### 4.2 SQLite schema v10

新增（只建表，不重建已有表）：

```sql
CREATE TABLE public_drafts (
  draft_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('profile','post')),
  -- 仅 post 使用；user = 本人，agent = 本机 Agent。
  author_kind TEXT NOT NULL DEFAULT 'agent' CHECK (author_kind IN ('user','agent')),
  revision INTEGER NOT NULL DEFAULT 0,
  -- profile 字段
  agent_name TEXT NOT NULL DEFAULT '',
  agent_description TEXT NOT NULL DEFAULT '',
  agent_interests_json TEXT NOT NULL DEFAULT '[]',
  agent_conversation_style TEXT NOT NULL DEFAULT '',
  human_name TEXT NOT NULL DEFAULT '',
  human_bio_markdown TEXT NOT NULL DEFAULT '',
  avatar_asset_id TEXT NOT NULL DEFAULT '',
  -- post 字段
  title TEXT NOT NULL DEFAULT '',
  body_markdown TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  image_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  -- 发布状态
  published_path TEXT NOT NULL DEFAULT '',
  published_sha256 TEXT NOT NULL DEFAULT '',
  published_revision INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE public_draft_assets (
  asset_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('avatar','image')),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX public_drafts_kind_updated_idx ON public_drafts (kind, updated_at_ms DESC, draft_id DESC);
CREATE INDEX public_draft_assets_draft_idx ON public_draft_assets (draft_id);
```

- 边界：每个 kind 最多 100 个草稿；草稿图片总量 ≤ 64 MiB；`tags_json`/`agent_interests_json` 只存字符串数组，读取时重新校验。
- 迁移 9→10 只建表；旧表、旧消息、旧联系人、旧发现记录全部保留。
- `favorites` 不在 v10 创建；P3 只创建动态收藏表，禁止顺手加 message/contact kind。

### 4.3 API（api_version 4 → 5）

服务端 `Status.api_version` 返回 `5`；插件 `EXPECTED_API_VERSION='5'`；`internal/api/stage6_test.go` 的硬编码 `"4"` 同步改为 `"5"`。

```proto
service RamingaService {
  // ...既有 RPC...
  rpc GetPublicDraft(GetPublicDraftRequest) returns (GetPublicDraftResponse);
  rpc ListPublicDrafts(ListPublicDraftsRequest) returns (ListPublicDraftsResponse);
  rpc SavePublicDraft(SavePublicDraftRequest) returns (SavePublicDraftResponse);
  rpc PutPublicDraftImage(PutPublicDraftImageRequest) returns (PutPublicDraftImageResponse);
  rpc DeletePublicDraft(DeletePublicDraftRequest) returns (DeletePublicDraftResponse);
  rpc PublishPublicDraft(PublishPublicDraftRequest) returns (PublishPublicDraftResponse);
}

message PublicProfile {
  string agent_name = 1;
  string agent_description = 2;
  repeated string agent_interests = 3;
  string agent_conversation_style = 4;
  string human_name = 5;
  string human_bio_markdown = 6;
  string avatar_path = 7;
  string avatar_sha256 = 8;
  string avatar_mime = 9;
  // source_path 是实际读取的公开文件，例如 profile/profile.json 或 profile/agent-card.json。
  string source_path = 10;
  bool legacy_fallback = 11;
}

message PublicDraftImage {
  string asset_id = 1;
  string sha256 = 2;
  string mime = 3;
  uint32 width = 4;
  uint32 height = 5;
  int64 size_bytes = 6;
}

message PublicDraft {
  string draft_id = 1;
  string kind = 2;                       // "profile" | "post"
  uint64 revision = 3;
  string agent_name = 4;
  string agent_description = 5;
  repeated string agent_interests = 6;
  string agent_conversation_style = 7;
  string human_name = 8;
  string human_bio_markdown = 9;
  PublicDraftImage avatar = 10;
  string title = 11;
  string body_markdown = 12;
  repeated string tags = 13;
  repeated PublicDraftImage images = 14;
  string published_path = 15;
  string published_sha256 = 16;
  uint64 published_revision = 17;
  int64 created_at_unix_ms = 18;
  int64 updated_at_unix_ms = 19;
  string author_kind = 20;                // "user" | "agent"；profile 忽略
}

message GetPublicDraftRequest { string draft_id = 1; }
message GetPublicDraftResponse { bool found = 1; PublicDraft draft = 2; }

message ListPublicDraftsRequest { string kind = 1; uint32 limit = 2; string before = 3; }
message ListPublicDraftsResponse { repeated PublicDraft drafts = 1; string next_before = 2; bool has_more = 3; }

message SavePublicDraftRequest {
  string draft_id = 1;                    // 空表示创建；profile 固定为 "profile"
  string kind = 2;                        // 创建时必填；已有草稿必须一致
  uint64 expected_revision = 3;           // 创建为 0；更新必须精确匹配
  optional string agent_name = 4;
  optional string agent_description = 5;
  repeated string agent_interests = 6;
  optional string agent_conversation_style = 7;
  optional string human_name = 8;
  optional string human_bio_markdown = 9;
  string avatar_asset_id = 10;            // 空表示保留；配合 clear_avatar
  optional string title = 11;
  optional string body_markdown = 12;
  repeated string tags = 13;
  repeated string image_asset_ids = 14;   // 整体替换；空表示清空
  bool clear_avatar = 15;
  optional string author_kind = 16;       // post 必填；"user" | "agent"；profile 忽略
}
message SavePublicDraftResponse { PublicDraft draft = 1; }

message PutPublicDraftImageRequest {
  string draft_id = 1;
  string role = 2;                        // "avatar" | "image"
  string filename = 3;                    // 仅用于诊断/格式提示，不决定路径
  bytes data = 4;
}
message PutPublicDraftImageResponse { PublicDraftImage image = 1; }

message DeletePublicDraftRequest { string draft_id = 1; uint64 expected_revision = 2; }
message DeletePublicDraftResponse { bool deleted = 1; }

enum PublicPublishStatus {
  PUBLIC_PUBLISH_STATUS_UNSPECIFIED = 0;
  PUBLIC_PUBLISH_STATUS_PUBLISHED = 1;
  PUBLIC_PUBLISH_STATUS_ALREADY_PUBLISHED = 2;
  PUBLIC_PUBLISH_STATUS_CONFLICT = 3;
  PUBLIC_PUBLISH_STATUS_INVALID = 4;
  PUBLIC_PUBLISH_STATUS_PARTIAL = 5;
}

message PublishFile { string path = 1; int64 size_bytes = 2; string sha256 = 3; }

message PublishPublicDraftRequest {
  string draft_id = 1;
  uint64 expected_revision = 2;
  string expected_published_sha256 = 3;   // 空表示首次发布或只校验草稿 revision
}
message PublishPublicDraftResponse {
  PublicPublishStatus status = 1;
  string error = 2;                       // 可读、有界；不泄露本机绝对路径
  uint64 current_revision = 3;
  string current_published_sha256 = 4;
  repeated PublishFile files = 5;         // 本次实际提交/已存在的公开文件
  int32 manifest_version = 6;
  int64 manifest_generated_at_unix_ms = 7;
  string post_path = 8;
  string profile_path = 9;
  repeated string warnings = 10;
  // manifest_sha256 是对本次实际扫描到的完整 manifest 的稳定摘要；
  // 并发重试返回同一摘要才表示清单一致。扫描失败时为空并带 error/warning。
  string manifest_sha256 = 11;
}

// 在既有 GetPeerProfileResponse 中追加；既有 1–5 不变。
// PublicProfile profile = 6;
```

实现要点：

- `PutPublicDraftImage` 是 unary bytes；服务端为本地 UDS 显式设置 `connect.WithReadMaxBytes(12 << 20)`，仍受单图 8 MiB、总 64 MiB 限制。
- `SavePublicDraft` 冲突返回 `connect.CodeFailedPrecondition`，错误文本只含 `revision`/`published_sha256` 语义，不带本机路径；UI 收到后重新 `GetPublicDraft`，不静默覆盖。
- `PublishPublicDraft` 的预期结果用 enum 返回，避免“错误响应丢失已提交文件清单”；只有非预期 I/O/数据库错误才返回 Connect error。
- `GetPeerProfile` 只返回头像 path/sha/mime，不返回 bytes；UI 用既有受控文件预览按 path+sha 获取，避免大响应和 N+1 头像下载。
- `manifest_sha256` 与 `files` 必须来自同一个 `content.Snapshot`；不得先返回文件列表再异步刷新清单。
- `manifest_sha256` 对 `version + peer_id + 按 path 排序的 entries(path,size_bytes,sha256)` 的规范 JSON 计算，**不包含 `generated_at_unix_ms`/mtime**；这样同一内容在并发重试/重新扫描后仍得到同一摘要。`files` 是本次提交/已存在文件，按 path 排序，不是完整清单；完整清单由 `manifest_sha256` 标识，UI 不得把 `files` 当完整 manifest。

### 4.4 图片校验

服务端权威，客户端只做提前提示：

- 只接受 PNG/JPEG；拒绝 SVG/GIF/WebP（P2 不引入 `golang.org/x/image` 新依赖）。
- 嗅探内容类型与扩展名一致；`image.DecodeConfig` 检查尺寸；完整 `image.Decode` 检查截断/损坏。
- 头像 ≤ 4 MiB、单边 ≤ 4096、总像素 ≤ 16M；动态图 ≤ 8 MiB、单边 ≤ 8192、总像素 ≤ 32M。
- 重编码为 PNG/JPEG（头像 PNG；动态按原格式，JPEG quality 88），剥离 EXIF/ICC；以重编码后的字节计算 sha/size。
- 失败返回 `InvalidArgument`，包含机器可读 `code`（`image_type`/`image_size`/`image_decode`/`image_dimensions`）和中文可读原因；UI 显示并保留其他表单字段。
- EXIF 方向不保证旋转，属于 P2 已知限制；若验收要求相册方向，再评估成熟库。

### 4.5 原子写入、发布临界区与并发重试

在 `internal/content` 增加唯一写入口，在 `internal/publication` 增加发布协调器；**同一 data dir 只允许一个 daemon 进程写入**（现有部署已如此，计划需明确写出并在启动时拒绝多写者）。

```go
func (s *Store) WritePublicFile(rel string, data []byte) (Entry, error)
```

- 校验 rel 在 public root 内、无 `..`/反斜杠/绝对路径/符号链接。
- 同目录临时文件 `.<base>.tmp-*` 写入 → `Sync` → `Chmod 0644` → `Rename` → 对父目录 `Sync` → `Invalidate`。
- 失败删除临时文件；不把半成品暴露为公开文件。

发布锁与临界区：

1. `publication.Coordinator` 持有每 data dir 的 `publishMu`；`content.Store` 的 `Snapshot`/`Refresh` 与公开文件写入使用同一把写锁（或同一 `publishMu`）。协调器持锁时只调用**不带锁的内部写入/扫描**，禁止再次获取同一把锁造成自锁。
2. `SavePublicDraft`/`DeletePublicDraft` 对同一 `draft_id` 取 per-draft 锁并完成 DB 事务；`PublishPublicDraft` 取同一 per-draft 锁后再取 `publishMu`。锁顺序固定为 **draft lock → publishMu**，禁止任何路径反向获取；这样草稿不能在发布检查后偷偷改 revision。
3. `PublishPublicDraft` 在临界区内依次完成：
   - 读取草稿 revision、当前 `published_sha256`、实际公开文件哈希；
   - 校验 `expected_revision` 与 `expected_published_sha256`；若该草稿已有 `published_sha256`，`expected_published_sha256` 必须非空且匹配，空值只允许首次发布，否则返回 `CONFLICT`/`InvalidArgument`，禁止绕过版本检查；
   - 计算目标文件与内容寻址文件名；
   - 在 `<data-dir>/publication/staging/<publish-id>/` 写入并 `Sync` 全部新文件；
   - 提交：先写新图片/新头像（内容寻址），再写派生旧格式（可选），最后写 `post.json`/`profile.json`；
   - `Invalidate` 后在同一锁内扫描生成 `content.Snapshot`；
   - 回写 `published_*` 与 `updated_at`；
   - 返回与同一 snapshot 对应的 `files`/`manifest_sha256`。
4. 版本检查与文件写入**不得分离**：禁止先 `GetPublicDraft` 校验、再在锁外写文件；并发重试必须在同一锁内重新读取并比较。

发布顺序（保证任何时刻旧版本仍可用）：

- 头像：新版本文件（版本化文件名）→ `index.md`（人类介绍）→ 可选 `agent-card.json` → `profile.json` 最后切换。
- 动态：新图片（内容寻址文件名）→ 其他派生文件 → 新 `post.json` 最后切换；旧 `post.json` 仍引用旧图片。
- 新图片/新头像使用内容寻址名，避免覆盖旧版本引用的文件；旧文件清理在**同一临界区、最终扫描前**完成，且只清理既不被当前也不被上一版本引用的文件；清理失败保留旧文件并 warning，`manifest_sha256` 仍对应实际清单。旧读者在上一版本保留期内仍可读取其引用的文件。
- `public/friends.json` 继续由现有 `WriteFriends` 原子写，P2 不改变其字段。

失败与一致性：

- 元数据（`post.json`/`profile.json`）切换前失败：旧元数据仍指向旧文件，旧版本完整可读；staging 清理。若本次已把新图片/新头像移入 public，先删除这些未被旧元数据引用的新文件并重新扫描：回滚成功时旧清单摘要必须不变；回滚失败则返回 `PARTIAL`，`manifest_sha256` 取实际扫描结果并带 warning，不得声称旧清单未变。
- 元数据切换后、清单扫描前失败：实际公开文件已是完整新版；返回 `PARTIAL`，`files`/`manifest_sha256` 来自实际扫描；不得返回未提交的 staging 文件。
- 清单扫描失败：返回 `PARTIAL` 或 Connect error，`manifest_sha256` 为空，UI 显示“清单未确认”，不得编造清单。
- 单文件原子；跨文件不承诺 POSIX 事务回滚。`PARTIAL` 必须如实列出已提交文件，旧版本仍可读；不声称“全部发布成功”。
- 进程崩溃恢复：启动时先清理 `publication/staging`，再用实际文件重建清单；若发现不完整 `post.json`/缺失图片，隔离该版本并保留旧版本，不把半成品当作已发布。恢复必须在 API 就绪/首次 manifest 读取前完成。

并发重试与幂等：

- 两个并发请求携带相同 `expected_revision`/`expected_published_sha256`：第一个成功；第二个在同一锁内看到已提交状态，若内容与当前公开文件完全一致，返回 `ALREADY_PUBLISHED` 与**同一** `manifest_sha256`/`files`；若草稿已变，返回 `CONFLICT`。不得重复写文件或生成不同清单。
- 相同内容重复发布：比较规范化正文、tags、图片 hash 与当前公开文件；完全一致返回 `ALREADY_PUBLISHED`，不重复写。
- 发布失败后的重试：从实际公开状态与草稿 revision 重新计算；能安全续做则续做，不能安全续做返回 `CONFLICT`/`PARTIAL` 并给出当前清单摘要；不得把半成品“补写”成成功。
- 文件已提交但 `published_*` 回写失败：重试先以实际公开文件对账并修复草稿的 `published_*`，再返回 `ALREADY_PUBLISHED` 与同一 `manifest_sha256`；不得重复写图片/帖子。
- 测试必须覆盖：多路并发相同请求只产生一组文件/一个清单摘要；中途注入失败回滚后旧清单摘要不变；回滚失败返回 `PARTIAL` 且摘要为实际扫描；提交后数据库失败仍返回与文件一致的 `PARTIAL`；下次重试返回 `ALREADY_PUBLISHED`。

### 4.6 UI 与宿主接口

新增/修改 UI：

- `pages/settings.js` + `pages/settings-private.js`：公开资料（Agent 五字段 + 人类介绍）与私有人设/成长编辑；私有一律标“仅本机可见”。
- `pages/home.js`：Agent 主视觉读取公开资料（P1 用旧格式回退，P2 用 `profile.json`）；编辑入口跳 `settings/public`，不在主页放“人类主页”tab。
- `components/profile-editor.js`：Agent 名称/形象/简介/兴趣/交流风格；人类名称/介绍；保存状态/冲突。
- `components/post-editor.js`：标题、Markdown、tags、最多 4 张图；发布身份选择“本人/Agent”，保存到草稿 `author_kind`；草稿列表。
- `components/image-picker.js`：类型/大小/尺寸预检、缩略图、移除；释放 object URL。
- `components/publish-receipt.js`：发布确认 + 实际公开路径/hash + `manifest_sha256`；`PARTIAL` 逐项显示。
- `pages/explore.js`：“我的动态”tab 同时显示本人/Agent，标来源；公开文件列表移到 `settings/public`，保留旧功能。

宿主桥新增方法（`plugins/dsh/src/ui-bridge.ts` + `plugins/dsh/ui/client.js` descriptors）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `publicProfile` | `peerId` | `{ profile, sourcePath, legacyFallback, error? }` |
| `publicDraft` | `draftId` | `{ found, draft, error? }` |
| `publicDrafts` | `kind` | `{ drafts, hasMore, nextBefore }` |
| `savePublicDraft` | draft 字段 + `expectedRevision` | `{ draft }` 或冲突错误 |
| `putPublicDraftImage` | `draftId, role, filename, bytes` | `{ image }` |
| `publicDraftAsset` | `draftId, assetId` | `{ image, dataBase64 }`（仅所属草稿） |
| `importPublicPost` | `path` | `{ draft }`（绑定原公开路径，发布更新原帖） |
| `deletePublicDraft` | `draftId, expectedRevision` | `{ deleted }` |
| `publishPublicDraft` | `draftId, expectedRevision, expectedPublishedSha256` | `PublishPublicDraftResponse` |

交互约定：

- 首次编辑创建草稿；profile 的 `draft_id` 固定 `profile`。
- 表单 600ms 防抖保存；导航/关闭前 flush；未保存显示“未保存”，不显示“已发布”。
- 冲突：保留本地输入，显示“草稿已在别处更新”，提供“重新载入最新”“复制我的修改”；帖子可“另存为新草稿”；禁止覆盖。
- 发布前二次确认，明确列出将公开的路径与身份（本人/Agent）；发布后显示真实清单路径/hash/摘要，不以 toast 代替。
- 发布身份选择必须可见且明确，写入 `author_kind`；默认 Agent 时也要显示“将以 Agent <名称> 发布”，不得把 Agent 内容误标本人。
- 图片只从本地选择；不上传远端；预览用本地 object URL，卸载释放。
- 头像展示：对方主页用 `PublicProfile.avatar_path/sha256`；列表/动态按需调用受控文件预览，限并发（如 4）、LRU 缓存（32 项/256 KiB/项），失败回退首字母，不阻塞列表；卸载释放 object URL。

### 4.7 测试

Go：

- `internal/storage`：v9→v10 迁移；草稿 CRUD；revision 冲突；资产上限/清理；事务失败不写半行。
- `internal/content`：`WritePublicFile` 原子性（临时文件清理、rename、Invalidate）；`profile.json`/post v2 解析；manifest 包含/跳过；旧 v1 帖子兼容；staging/隐藏目录不进入 manifest。
- `internal/publication`（新）：图片类型/尺寸/截断/伪装扩展名；重编码 hash；发布顺序；冲突（外部改动/删除）；`PARTIAL` 清单；并发重试同一摘要；中途失败旧清单不变；相同内容/版本返回 `ALREADY_PUBLISHED`；版本检查与写入在同一临界区（并发测试）。
- `internal/api`：新 RPC 参数校验、错误码、`PublicProfile` 字段、头像 path/sha 校验；API version 5。
- 集成：临时双节点发布→远端 `GetPeerProfile`/`GetPeerManifest`/`DownloadPeerFile` 校验 sha；旧 v1 帖子仍可读；旧 `index.md`/`agent-card.json` 仍能回退。
- 升级：v9 数据目录直接升级到 v10，不重建；旧公开文件不被删除。

UI/插件：

- DOM：Agent 五项公开资料、人类介绍、编辑/保存/重载/冲突/发布清单/图片拒绝/移除图片/未保存离开提示。
- 我的动态：`author_kind` 为 user/agent 的两类帖子、未知来源、旧 v1 帖子、公开文件搬移后仍可查看/刷新/定位。
- `packages/ui/test/files.dom.test.mjs` 扩展新 post 路径和图片按需预览。
- 插件：`local-data` 读 `profile.json`/旧 `agent-card.json`/`index.md`；`ui-bridge` 草稿/发布/冲突/图片 bytes；无本机绝对路径泄露。
- 回归：现有测试全部通过；不以条数作门槛。

手动验收：

1. 设置中编辑 Agent 名称/形象/简介/兴趣/交流风格 + 人类介绍，保存后重挂面板，草稿与预览保留。
2. 新建图文动态，选 2 张 PNG/JPEG，保存草稿，发布；确认 `author_kind` 与清单路径/hash/`manifest_sha256`。
3. 分别以“本人”和“Agent”发布一条动态；我的动态同时显示并标来源。
4. 修改已发布动态，模拟外部改动 `post.json`，发布返回冲突，UI 不覆盖。
5. 上传 SVG/超限/损坏图片，显示明确错误，其他字段不丢。
6. 对方节点读取新资料/动态/图片并校验 hash；旧客户端仍能读 `index.md` 与 v1 帖子。

### 4.8 P2 自测记录（2026-11-18）

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1`（`GOMODCACHE=$PWD/.local/go-mod`、`GOCACHE=/tmp/raminga-gocache`） | PASS |
| `go test -race ./internal/storage ./internal/content ./internal/publication ./internal/api ./internal/node` | PASS |
| `go vet ./...` | PASS |
| `golangci-lint run ./...`（`go tool`，本地 module cache） | PASS |
| `go tool buf lint` | PASS |
| `go run ./scripts/genplugins -root . -check` | PASS |
| `packages/ui npm test` / `npm run build` | PASS |
| `plugins/dsh npm test` / `npm run test:integration` / `npm run build` | PASS（integration 含真实双节点资料/头像/本人与 Agent 动态发布读取；使用重建后的 `bin/raminga`） |
| v9→v10 迁移 | PASS（自动备份 `raminga.db.bak-9`；旧消息保留；只建草稿表） |
| 发布并发/失败恢复 | PASS（同草稿并发只产生一组文件与同一 `manifest_sha256`；元数据失败回滚摘要不变；提交后 DB 失败返回 `PARTIAL`，重试修复为 `ALREADY_PUBLISHED`） |
| 旧格式 | PASS（`profile/index.md`、`agent-card.json`、v1 帖子只读兼容；缺失 Agent 字段保持空，不冒充人类资料） |
| 模拟宿主真实点击 | PASS（`node scripts/ui-harness/server.mjs`，1440×900 与 390×844：设置公开资料草稿保存/头像本地预览/二次确认发布、动态编辑器默认本人/显式 Agent、草稿发布与回执；无控制台错误。模拟宿主不等于真实 DSH） |
| 真实 DSH 面板 | NOT_TESTED（本轮未启动真实 DSH；模拟宿主与真实双节点 daemon/API 已测，最终 UI 验收步骤见下） |

- 测试验收看行为覆盖与失败语义，不以条数/固定通过数为门槛。
- `bin/raminga` 已用本轮 Go 代码重建；若集成测试使用旧二进制，API 5 断言会失败，不能据此宣称通过。
- 未运行 `make e2e-plugins`（需要 Docker/宿主能力）与真实 DSH 视觉验收，记为 NOT_TESTED。

### 4.9 P2 复验修复记录（2026-11-18）

复验反馈的六项问题已在本轮修复；**未进入 P3**，未创建未读/收藏表，未提交、推送或发布。

| 问题 | 修复 | 回归证据 |
| --- | --- | --- |
| 1. 草稿保存/重挂后只有 metadata，无缩略图；头像同类 | 新增本地 `GetPublicDraftAsset(draft_id, asset_id)`；资源按草稿双键校验，失败返回 NotFound。桥接新增 `publicDraftAsset`，UI 生成短生命周期 object URL，保存/重挂后异步恢复帖子图片与头像缩略图，切换草稿、移除图片、卸载时 revoke | `internal/storage` 双草稿资源隔离测试；`internal/api` NotFound/字节测试；`plugins/dsh/test/ui-publication.test.mjs`；`packages/ui/test/home-settings.dom.test.mjs` 保存/重挂/object URL；真实双节点 `publicDraftAsset` 校验 |
| 2. 标题 input/select 浏览器默认边框，宽窄屏不统一 | `.rm-field` 统一 input/select/textarea/file 的 1px 边框、10px 圆角、13px 字号、focus ring 与宽度；窄屏 100% 不溢出 | 1440×900 与 390×844 harness 实际截图（`reports/p2-reverify-2026-11-18/`），computed border 1px solid、圆角 10px、宽度 930/316px，页面 `scrollWidth` 等于视口 |
| 3. 我的动态无编辑入口；无草稿旧 v1/Agent 帖子不能编辑；不能另发副本 | 卡片新增“编辑”；新增 `ImportPublicPost(path)`，校验路径/作者/图片，复制私有资源并记录原 `published_path`/SHA；发布更新原路径。UI 锁定来源身份，v1 保持 v1；远端内容不显示编辑且 API 拒绝 | `internal/publication` 旧 v2（未知字段/图片/Agent 来源）与 v1 原路径更新、远端拒绝测试；真实双节点删除草稿后导入、编辑并更新原 `post.json`；UI v1/v2 编辑入口测试 |
| 4. 冲突另存新草稿丢图片 | “另存为新草稿”读取原草稿全部图片字节并上传到新草稿，再合并本次待上传图片；不需要重新选择，原草稿不变 | UI 冲突另存测试断言原图复制与新草稿 `imageAssetIds` |
| 5. 手动默认本人但存在开发叙述 | 移除“不会默认标成 Agent”等叙述；统一为“将以本人/Agent…署名发布”，导入编辑显示真实来源且不可切换 | UI 文案测试；完整模板/包负向检查 |
| 6. 写资源期间外部版本变化未在元数据提交前复检 | `Publish` 在写入全部图片/头像后、切换 `post.json`/`profile.json` 前重新读取目标元数据哈希；与临界区开始值不同则回滚本次新增文件并返回 `CONFLICT` | `TestExternalMetadataChangeDuringResourceWriteConflicts`：外部改写保留、新图片回滚、状态 `CONFLICT` |

本轮自测：

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1` | PASS |
| `go test -race ./internal/storage ./internal/api ./internal/node ./internal/content ./internal/publication` | PASS |
| `go vet ./...`、`go tool buf lint`、`go run ./scripts/genplugins -root . -check` | PASS |
| `packages/ui npm test` / `npm run build` | PASS（120 tests） |
| `plugins/dsh npm test` / `npm run build` | PASS（157 tests） |
| `plugins/dsh npm run test:integration` | PASS（真实双节点含草稿资源、导入原帖更新、资料/头像/图文发布；本轮重建 `bin/raminga`） |
| 模拟宿主实际点击与截图 | PASS（仅模拟宿主；1440×900/390×844，截图见 `reports/p2-reverify-2026-11-18/`） |
| 真实 DSH 面板复验 | NOT_TESTED（本轮按要求仅修复自测后退出；Codex 此前已在真实 DSH 走通资料与带图动态发布） |
| `make e2e-plugins` / 真实 DSH 截图 | NOT_TESTED（需要宿主/Docker 能力） |

遗留/已知限制：EXIF 方向不旋转；v1 帖子保持 v1 格式，不能在原帖直接加图片，需另存为新草稿；import 只接受 `author.kind=user|agent`，来源未注明的旧帖会明确拒绝而不是猜测；真实 DSH 视觉复验仍待下一轮。


### 4.10 P2 第二次复验修复记录（2026-11-18）

复验反馈“发布后我的动态卡片只有文字和阅读内容、没有图片”已修复；本轮只补 P2 图片消费与自测，**未进入 P3**，未创建未读/收藏表，未提交、推送或发布。

| 问题 | 修复 | 回归证据 |
| --- | --- | --- |
| 我的动态/远端动态卡片不显示 v2 `images` | 桥接在 Mine/发现解析 v2 帖子时返回 `images`；远端卡片通过新增 `peerPostMeta` 读取已核对 post.json 元数据，图片路径解析为 `posts/<id>/images/<sha256>.png`；卡片和详情都渲染真实图片 | `internal` 无新增公开格式；`ui-files` 真实临时数据、双节点 integration 断言 `images`/`publicPath`；UI DOM 测试 8 张图片卡片 |
| 图片读取缺少 path/MIME/SHA-256/大小校验 | 继续走既有受控 `mineFilePreview`/`peerFilePreview`；post 元数据校验相对路径、哈希、MIME、尺寸/大小/总量；实际字节再校验清单 SHA-256/大小，并嗅探 PNG/JPEG 文件头与扩展名 | `ui-files` 正向、哈希不符、清单状态；`previewBytes` 拒绝字节类型不符 |
| 图片懒加载阻塞列表或无界并发 | 卡片可见时才读取 post 元数据/图片；图片队列全局最多 4 个并发，失败不自动重试；展开/预览不重复下载 | UI DOM 测试 8 张图片最大并发 ≤4；真实 DSH 卡片加载后列表仍可交互 |
| object URL 泄漏 | 图片按引用计数保留，列表替换、收起、卸载时释放；卸载立即 revoke 全部 object URL，短延迟释放避免重渲染抖动 | UI DOM 测试 mock `URL.revokeObjectURL`；真实 Chromium 检查 `blob:` 图片 |
| 离线/缺图无明确状态 | 区分 `not-downloaded`/`copy-missing`/`not-published`/`offline`/`hash-mismatch`/`unsupported`，卡片内显示具体原因和重试入口 | DOM 测试公开清单缺图；`peerPostMeta`/`peerFilePreview` 离线错误映射 |
| 点击预览不能返回原位置 | 新增图片 lightbox dialog；点击缩略图打开，关闭按钮/背景/Escape 关闭；焦点优先回到原缩略图，列表已重渲染时按图片 key 找回，滚动位置恢复 | UI DOM 测试 dialog 开关、焦点与 `scrollTop` 恢复；真实 DSH 宽窄屏点击/关闭 |
| 公开头像没有走同一条真实图片链 | 对方主页从 `profile.json` 的 `avatar_path/sha/mime` 与当前 manifest 取尺寸，经 `peerFilePreview` 校验后显示；失败回退首字母 | DOM 测试 `.rm-profile-avatar-img`；真实 DSH 双节点联系人头像显示 |

本轮真实数据与视觉自测：

| 检查 | 结果 |
| --- | --- |
| `bin/raminga` 用本轮源码重建 | PASS |
| `go test ./...` + `go vet ./...` | PASS |
| `packages/ui npm test` / `npm run build` | PASS（123 tests） |
| `plugins/dsh npm test` / `npm run build` | PASS（160 tests） |
| `plugins/dsh npm run test:integration`（真实双节点） | PASS；实际发布带图 v2 帖子后 `peerPostMeta`/`peerFilePreview`/Mine 均返回同一图片 path/SHA-256/大小，嵌入图片读取 `discoveryRecorded=false` |
| 真实 DSH Web（隔离 profile + 独立 data dir） | PASS；在真实 DSH 中通过动态编辑器上传图片、保存草稿、二次确认发布，我的动态卡片显示真实 `blob:` 图片；1440×900 与 390×844 打开/关闭预览；真实双节点联系人主页显示公开头像与远端带图动态，删除本机图片副本后再次打开会从对方重新下载并渲染 |
| 模拟宿主 | PASS（同一 bundle 的宽窄屏截图与交互） |
| 真实 DSH “离线缺图”截图 | 未单独保留；离线状态由 DOM/桥接测试覆盖，真实 DSH 验证了在线远端下载路径 |

遗留/已知限制：EXIF 方向不旋转；v1 帖子保持 v1 格式，不能在原帖直接加图片，需另存为新草稿；v2 图片卡片依赖当前 manifest 中仍存在的图片条目，远端离线且本机无已核对副本时只显示缺失状态；真实 DSH 联系人页在刚连接/清单超时时可能显示本机历史副本，这是既有降级语义。

## 5. P3：未读游标、动态收藏、联系人主页、私有印象

### 5.1 SQLite schema v11

```sql
CREATE TABLE conversation_read_state (
  peer_id TEXT PRIMARY KEY,
  last_read_at_ms INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL
);

-- 只收藏动态（公开帖子），不收藏消息/联系人。
CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  UNIQUE (peer_id, path, sha256)
);
CREATE INDEX favorites_created_idx ON favorites (created_at_ms DESC, id DESC);
```

- 迁移 v10→v11 时为已有消息回填“已读基线”，避免升级后把全部历史显示成未读：

```sql
INSERT OR IGNORE INTO conversation_read_state
  (peer_id, last_read_at_ms, last_read_message_id, updated_at_ms)
SELECT peer_id, MAX(created_at_ms), '', <now_ms>
FROM messages GROUP BY peer_id;
```

- 这是迁移默认值，不代表用户真的读过；UI 文案必须说明“升级后从当前记录开始计未读”，不得声称历史已读。
- 不创建 message/contact 收藏列、kind 字段或迁移；旧数据中不存在收藏，因此无历史收藏需要迁移。

### 5.2 API（api_version 5 → 6）

```proto
service RamingaService {
  // ...既有 RPC...
  rpc MarkConversationRead(MarkConversationReadRequest) returns (MarkConversationReadResponse);
  rpc ListFavorites(ListFavoritesRequest) returns (ListFavoritesResponse);
  rpc SetFavorite(SetFavoriteRequest) returns (SetFavoriteResponse);
}

message MarkConversationReadRequest {
  string peer_id = 1;
  string through_message_id = 2;   // 人类实际看到的最新消息；服务端取该消息的 created_at_ms
}
message MarkConversationReadResponse {
  string peer_id = 1;
  string last_read_message_id = 2;
  int64 last_read_at_unix_ms = 3;
  uint32 unread_count = 4;
}

// 仅动态收藏；没有 kind/message_id/contact 字段。
message Favorite {
  string id = 1;
  string peer_id = 2;
  string path = 3;
  string sha256 = 4;
  string title = 5;
  int64 created_at_unix_ms = 6;
  bool available = 7;              // 目标仍在本地/保留范围
}
message ListFavoritesRequest { uint32 limit = 1; string before = 2; }
message ListFavoritesResponse { repeated Favorite favorites = 1; string next_before = 2; bool has_more = 3; }
message SetFavoriteRequest {
  string peer_id = 1;
  string path = 2;
  string sha256 = 3;
  string title = 4;
  bool favorite = 5;
}
message SetFavoriteResponse { bool favorite = 1; Favorite item = 2; }

// 在既有 Friend 中追加；既有 1–10 不变。
  uint32 unread_count = 11;        // 只读视图字段；不是好友存储

// 在既有 ConversationSummary 中追加；既有 1–8 不变。
  uint32 unread_count = 9;
  string last_read_message_id = 10;
  int64 last_read_at_unix_ms = 11;

// 在既有 ListConversationsResponse 中追加；既有 1–4 不变。
  uint32 total_unread = 5;

// 在既有 ListDiscoveriesRequest 中追加；既有 1–3 不变。
  string peer_id = 4;              // 可选；只返回该作者的发现，供联系人“他的动态”分页
```

- `ListDiscoveriesRequest.peer_id` 是可选过滤；旧客户端不传时行为不变。
- 不新增 `Favorite.kind`；不提供消息/联系人收藏 RPC，也不在 UI 暴露对应星标。

### 5.3 未读语义

- **人类游标**按 Peer 持久化 `last_read_at_ms` + 对外 `last_read_message_id`；不依赖 SQLite rowid（现有代码已注明 rowid 在 prune/VACUUM 后不稳定）。
- `unread_count` 只统计 `direction='in'` 且 `created_at_ms > last_read_at_ms` 的行；outbound 不计。
- 时间精度为 1ms；同一毫秒内到达的多条消息按同一批处理，不承诺逐条区分。这是有意的稳定化取舍，文档和测试需明确。
- `ListMessages`、`RecentMessages`、`ListConversations`、`ListFriends` 都是只读，**绝不**写游标。
- 只有 `MarkConversationRead` 写游标；只允许向前移动（消息 `created_at_ms` 小于等于当前则不变；同毫秒只更新 message_id，不增加已读范围）。
- Agent 工具 `raminga_chat_history` 只调用只读消息查询（`RecentMessages`/`ListMessages`）；不得调用 `MarkConversationRead`。这是 P3 的硬测试。
- UI 仅在以下条件调用 `MarkConversationRead`：
  1. 会话可见且 `document.visibilityState === 'visible'`；
  2. 焦点在会话/面板内，持续 ≥500ms；
  3. 最新一页已渲染且用户位于底部（或刚发送/收到并滚到底部）。
  用户向上翻历史时不标记新到的更晚消息；新消息保持未读。
- 切换页面/卸载时停掉 debounce timer，不补记未读；重新进入且满足条件才标记。
- 新联系人无游标时 `unread_count` 计所有保留入站消息；迁移已有联系人按 5.1 回填基线。
- “有过交流”筛选以真实持久出站消息为准：本人出站关系（`human_outbound_peers`）或保留的 `origin='agent'` 出站消息都计入；入站消息、仅建立连接、浏览档案和 `last_interaction` 不计入。该筛选不对远端声明作推断。
- `Friend.unread_count` 与 `ConversationSummary.unread_count` 共用同一 SQL 子查询/CTE，禁止两套算法。
- 联系人列表的“最近消息/时间”复用 `ListConversations` 的 `preview`/`last_at_unix_ms`，不新增第二套消息摘要；按 `direction`/`origin` 标“本人/Agent/对方”，来源未知不猜；没有会话时显示“还没有消息”，不用 `last_interaction` 冒充聊天。

### 5.4 收藏（仅动态）

- `SetFavorite` 幂等：同键重复收藏不新增；取消不存在的收藏返回 `favorite=false`，不报错。
- 唯一键 `(peer_id, path, sha256)`；`SetFavorite` 只接受 v1/v2 帖子路径（`posts/*.json` 或 `posts/**/post.json`），其他路径返回 `InvalidArgument`；收藏对象必须是 `public` 动态或已验证的动态发现副本；消息、联系人、私有印象不在收藏范围。
- `available` 由查询时判断：帖子是否在 `public_discoveries`、已校验 `downloads/` 或本机 `public/`；不返回虚假可用。
- 收藏不写 public，不导出，不进入 `friends.json`。
- UI：**仅动态卡片和动态详情**提供星标；消息行、联系人行、联系人主页不提供收藏入口。操作先禁用再等响应，失败恢复并提示；`settings/favorites` 次级页按时间分页，显示“原内容已不在保留范围”。
- 删除/清理目标后 `available=false`；收藏记录保留，不自动删除。
- 测试：消息/联系人 API 不暴露收藏；UI 不渲染星标；DB 唯一键只含动态字段。

### 5.5 联系人主页 Agent 主导 + 交互/动态/通讯录

`pages/contact-profile.js`（联系人）与 `profile:<peerId>`（非联系人作者）共用视觉组件，但数据范围不同：

- **Agent 主视觉**：Agent 头像、名称、简介、兴趣、公开交流风格；人类介绍在下方次要条；不使用人类头像作为主视觉。
- **我们的交互**：只合并真实证据：
  - 持久消息（事实，按 Peer）；
  - Journey `events.jsonl`（Agent 观察/动作；只显示有证据的事件）；
  - contact-notes（私有印象，标“仅本机可见”）；
  - 每项必须有时间、来源、摘要/证据引用；消息按 `origin` 标本人/Agent，来源未知不猜；不把浏览档案、连接、`last_interaction` 推断成聊天。
- **他的动态**：`ListDiscoveries` 按 `peer_id` 过滤 + 已验证本地副本；对方离线时显示“本地历史副本，不是当前完整清单”；无动态显示真实空态。
- **他的通讯录**：`GetPeerFriends` 读取对方公开 `friends.json`，标“公开线索/尚未访问”；不得把这些条目当成自己的联系人，也不得自动建立连接。未实际获取时显示“尚未获取公开通讯录”，不编造。P1 已接入该读取与加载/失败/空态；P3 仍负责私印象与交互时间线。
- 非联系人作者：显示公开 Agent 主页 + “添加联系人”；不显示“我们的交互/他的通讯录”（没有关系或未获取）；动态只显示已获取副本。
- 联系人列表：每行 Agent 名称/形象为主，人类名称/说明为辅，显示最近消息、时间、未读；有未读筛选；无会话不伪造消息。列表同时读取 `ListFriends` 与 `ListConversations`；会话读取失败只影响最近消息/未读，不把联系人清空，也不把 `last_interaction` 当消息时间。
- 返回保留来源滚动/展开；会话返回保留草稿/锚点。

### 5.6 私有印象与交互时间线

`agent/contact-notes.json` schema v2（现有 v1 空文件可读；不自动重写）：

```json
{
  "schema_version": 2,
  "contacts": [
    {
      "peer_id": "12D3KooW…",
      "display_name_snapshot": "Alice",
      "updated_at": "2026-11-18T10:00:00Z",
      "observations": [
        {
          "id": "obs-01",
          "summary": "读过对方公开的散步记录。",
          "observed_at": "2026-11-18T09:50:00Z",
          "evidence_refs": {
            "session_ids": ["session-01"],
            "event_ids": ["evt-03"],
            "message_ids": [],
            "content_paths": ["posts/p1/post.json"],
            "content_sha256": ["…64 hex…"]
          }
        }
      ],
      "impressions": [
        {
          "id": "imp-01",
          "summary": "表达克制，可能偏好慢节奏交流。",
          "uncertainty": "medium",
          "created_at": "2026-11-18T09:55:00Z",
          "updated_at": "2026-11-18T09:55:00Z",
          "evidence_refs": { "session_ids": ["session-01"], "event_ids": ["evt-04"], "message_ids": [], "content_paths": [] }
        }
      ],
      "curiosities": [
        { "id": "cur-01", "question": "下次可以问问城市声音。", "created_at": "2026-11-18T09:56:00Z", "evidence_refs": { "session_ids": ["session-01"], "event_ids": [], "message_ids": [], "content_paths": [] } }
      ]
    }
  ]
}
```

- `readContactNotes(dataDir)` 只读 `agent/contact-notes.json`，限 1 MiB；schema v1 空 contacts 合法，未知版本/坏 JSON 显示错误，不编造。
- 交互时间线在宿主合并：持久消息（事实）、Journey `events.jsonl`（Agent 观察/动作）、contact-notes（长期记忆）。每项必须有 `kind`、时间、摘要/证据引用；不把 profile 浏览、连接、`last_interaction` 推断成聊天。
- UI 在设置“社交记忆”/联系人主页“我们的交互”展示私有内容时标“仅本机可见”；不向远端发送，不写 public。
- `friends.json` 只由好友表字段生成；新增测试：把唯一字符串写进 contact-notes 的 impression，`SyncFriends` 后断言该字符串不在 `friends.json`；`Published`/manifest 不含 `agent/`。
- 同步 `agent/templates/private/contact-notes.json`（v2 空模板）、`agent/guidance/data-contract.md` 与 `docs/agent-skill.md` 的 contact-notes v2 字段、证据要求、禁止把印象写成“已聊天”；既有 v1 文件只读兼容，不自动重写。
- 私有印象只由 Agent 宿主/用户写入 `agent/contact-notes.json`；不新增公开/半公开的私有记忆 daemon RPC。

### 5.7 宿主接口（P3）

`plugins/dsh/src/ui-bridge.ts` + `plugins/dsh/ui/client.js` 新增：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `markRead` | `peerId, throughMessageId` | `MarkConversationReadResponse` |
| `favorites` | `before` | `ListFavoritesResponse` |
| `setFavorite` | `peerId, path, sha256, title, favorite` | `SetFavoriteResponse` |
| `contactMemory` | `peerId` | `{ contact, timeline, state, error }`（仅本机私有文件） |
| `peerFriends` | `peerId, force?` | `{ friends, limited, error }`（公开 `friends.json` 声明） |

`contactMemory` 由 `local-data.ts` 的 `readContactNotes` + `readJourney` 合并，不新增 daemon 读取私有文件的 RPC；绝不把 `agent/` 路径交给浏览器。

### 5.8 测试

- 迁移 v10→v11；回填后旧会话未读为 0；新入站消息计数正确；outbound 不计。
- `MarkConversationRead` 向前/向后/不存在 message；返回 unread；并发标记幂等。
- Agent 读：调用 `ListMessages`/`raminga_chat_history` 后 `ListConversations.unread_count` 不变（daemon + 插件两层测试）。
- 联系人 unread 与会话 unread 同源；`total_unread` 一致；联系人列表最近消息来自会话摘要。
- 收藏幂等/唯一/可用性/分页；删除消息后不影响收藏（收藏范围不含消息）；`ListFavorites` 无 kind 参数。
- 负向：消息行/联系人行无收藏 UI；API 不接受 message/contact 收藏。
- contact-notes v1/v2/坏 JSON/超限；时间线只含真实证据；friends.json 负向测试；public manifest 负向测试。
- UI：徽标、进入会话标记、向上翻不标记、星标失败回滚、收藏重挂、联系人主页三 tab、私有印象标签/证据链接。
- 升级：v10 数据目录直接升级到 v11；旧 contact-notes v1 可读且不被自动重写。

### 5.9 P3 本轮自测记录（2026-11-18，待 Codex 验收）

- 实现：schema v11 迁移/回填、单调人类已读游标、同一未读 CTE、联系人未读/最近消息/未读筛选、仅公开动态收藏与可用性、按 Peer 发现过滤、联系人主页交互/动态/通讯录、私有 contact-notes v2 读取与受控单条印象编辑、UI 未读徽标/收藏/印象证据跳转。
- 本轮修复：中断/在途消息到达时 mark-read `finally` 重调度且失败不形成 500ms 重试循环；`destroy()` 清理 mark-read timer 与 mine-feed 图片观察器；私有印象编辑按钮仅在真实可编辑数据就绪时出现；Journey 证据跳转支持“最近记录”特色卡（此前只查列表导致异步数据到达后不展开）；设置社交记忆在联系人异步到达后刷新；联系人仍在加载时打开主页不再被误判为非联系人（否则会永久落到“他的动态”并跳过私有记忆）；长屏/窄屏导航容器查询此前缺少 `@container` 包裹，导致桌面宽度错误显示移动底栏；远端收藏可用性改为要求保留字节仍存在且哈希匹配；storage/node/API 的 v6 契约与 host 版本同步为 6。
- 测试：`go test ./...`、`go test -race ./internal/storage ./internal/api ./internal/node ./internal/content`、`go vet ./...`、`packages/ui npm test`、`plugins/dsh npm test`、`plugins/dsh npm run test:integration`（含新增真实 daemon P3 用例）、`genplugins -check` 通过；另用隔离端口 4322 与独立 mock 数据在真实 Chromium 1440×1000/390×844 检查联系人、联系人主页、收藏与私有印象编辑，未触碰 4321 宿主或 `.local/ui-implementation`。证据日志：`.local/ui-refresh-20261117/p3-final*.log`；截图与真实交互输出：`.local/ui-refresh-20261117/p3-browser/final-*`。
- `buf lint`：本轮未单独复跑；Codex 已补跑 `GOMODCACHE=$PWD/.local/go-mod GOCACHE=/tmp/raminga-gocache go tool buf lint`，结果 PASS。
- 验收状态：以上为本轮自测证据，不替代 Codex 验收；未提交、未推送、未发布，未修改 DSH 配置。

### 5.10 P3 验收反馈修复与复测（2026-11-18，待 Codex 复核）

- 修复设置来源往返崩溃：`openPeerProfile`/`closePeerProfile` 不再写 `view.pages.settings`（settings 的滚动状态实际在 `view.settings`），统一走 `pageStateFor()`；从收藏行打开作者再返回时保存并恢复收藏列表滚动位置、已加载分页与页码状态，作者焦点回到原收藏行的“查看来源”。
- 收藏可直接阅读具体版本：收藏行新增“阅读这条动态”，按 peer/path/sha256 精确读取。本机帖子走 `mineFilePreview` 的本机公开目录受控读取，不再对自己拨号；远端优先读取已保留的精确哈希副本，因此对方离线也可读；返回的路径/哈希必须与收藏版本一致，不一致时不展示正文。收藏行同时保留“查看来源”和“取消收藏”，`available=false` 的行也可取消。
- 收紧精确副本边界：`peerFilePreview` 仅在调用方给出精确 SHA-256 且大小未知（收藏阅读）时优先读取本地精确副本；普通清单/图片读取仍保持原有来源与下载语义，避免把历史副本冒充当前远端清单。
- 联系人主页离线/读取失败 UI：主文案改为短而可操作的“对方当前不可达/读取超时/没有可用地址”等；完整 RPC/dial/multiaddr/本机路径进入折叠“技术详情”，`pre-wrap` + `anywhere` 换行，390 宽无横向溢出。交互、通讯录、私有记忆的读取失败也分别提供折叠原文。
- 文案与内部值：时间线把 `确定性 medium` 等翻译为“确定性 中/低/高”；收藏与私有记忆主界面移走 SQLite、`agent/contact-notes.json`、`friends.json` 等实现细节，折叠“数据说明”仍可查看。
- 测试：新增 UI DOM 用例覆盖设置来源返回滚动/分页、精确版本阅读（本机不拨号、远端错版本不冒充）、失效收藏取消、离线错误摘要/技术详情/确定性翻译；新增 bridge 与真实 daemon 集成用例覆盖本机公开目录精确读取、离线 `downloads/<peer>` 精确哈希读取与错误哈希拒绝；`go test ./...`、`go vet ./...`、`go tool buf lint`、`go tool golangci-lint run ./...`、fuzz-seed、`genplugins --check`、`packages/ui npm test` 134 项、`plugins/dsh npm test` 167 项、`plugins/dsh npm run test:integration`（12 项，含新增真实双节点用例）通过；相关包 `go test -race -p 1 ./internal/storage ./internal/api ./internal/node ./internal/content ./internal/publication` 通过。`make check` 的 `go test -race ./...` 全量链接阶段因本机磁盘仅余约 751 MiB 报 `no space left on device`，该全量目标记为 **BLOCKED（环境磁盘）**，其余 `make check` 子目标已逐项单独通过。
- 真实 DSH 复测：独立 `DSH_HOME=.local/p3-fix-verify/dsh-home`、`RAMINGA_DATA_DIR=.local/p3-fix-verify/node-a`、端口 4331，未触碰 4321。真实 Chromium 1440×1000/390×844 走通：我的动态收藏本机图文→设置→收藏动态→加载更早收藏（50→56）→滚动 6750→查看来源→返回仍为 6750/56 条；本机收藏正文读取；远端收藏在 B 离线后仍读取精确副本；失效收藏取消；B 离线主页短错误+折叠技术详情；390 横向溢出 0；页面异常 0。证据：`.local/p3-fix-verify/evidence/e2e-results.json`、`wide-local-favorite-read.png`、`wide-remote-offline-read.png`、`narrow-offline-profile.png`、`narrow-favorites.png`。
- 状态：修复与自测完成，仍待 Codex 复核；未进入 P4，未提交、未推送、未发布，未修改 DSH 配置。

### 5.11 P3 本机收藏来源修复（2026-11-18，待 Codex 复核）

- 本机收藏的“查看来源”不再调用 `openPeerProfile(selfPeerId)`。它打开设置 → 公开资料并回填本机 `public/` 的真实公开字段，不会把自己当作远端联系人，因此不拨号、不显示“Agent 档案未公开”，也没有“添加联系人”或“发消息”。
- 设置公开资料页的返回按钮在该路径下变为“← 返回收藏的动态”，恢复收藏列表滚动位置、已加载分页和“查看来源”焦点；切到其他设置页、关闭设置或离开设置会清除这个临时返回态。远端收藏仍打开远端联系人主页并保持原有返回行为。
- 公开资料兜底草稿读取到本机公开文件后刷新一次；已保存草稿或正在输入的草稿不会被覆盖。
- 测试：新增 `packages/ui/test/p3.dom.test.mjs` 本机/远端来源用例和 `packages/ui/test/favorites-source.chromium.test.mjs` 真实 Chromium 用例（56 条分页、滚动、返回焦点、无自身拨号、远端主页保持）。独立 DSH 4331（`DSH_HOME=.local/p3-fix-verify/dsh-home`、`RAMINGA_DATA_DIR=.local/p3-fix-verify/node-a`，未触碰 4321）在 1440×1000 与 390×844 实点：本机来源打开公开资料（人类名“验收本人”），返回收藏滚动 6619/11972 与 55 条分页保持，`#profileView` 保持隐藏；“查看来源”焦点回到原收藏按钮；远端来源仍显示“验收 B”主页；横向溢出 0、页面异常 0。证据：`.local/p3-fix-verify/evidence/local-source-results.json`、`wide-local-source-public.png`、`narrow-local-source-public.png`、`narrow-local-source-back.png`。
- 状态：定向修复与自测完成，仍待 Codex 复核；未进入 P4，未提交、未推送、未发布，未修改 DSH 配置。

## 6. P4：按真实 Agent 工具调用记录 Agent 活动

### 6.1 记录格式

新增 `<data-dir>/agent/activity.jsonl`（`agent/` 0700，文件 0600），append-only，一行一个 JSON。只记录插件的 `raminga_*` 工具调用，不记录 UI 手动操作、轮询或宿主内部事件。该文件由插件管理，Agent 不直接读写或编辑；它不替代 Journey `events.jsonl`。

```json
{"schema_version":1,"event":"started","operation_id":"op-1763450000000-1-a1b2","plugin_instance_id":"inst-…","panel_session_id":"ui-…","journey_id":"session-01","journey_match":"current_peer","session_id":"sess-plugin-…","tool":"raminga_content_get","target_type":"content","target":{"peer_id":"12D3KooW…","path":"posts/p1/post.json"},"started_at":"2026-11-18T10:00:00Z"}
{"schema_version":1,"event":"finished","operation_id":"op-1763450000000-1-a1b2","plugin_instance_id":"inst-…","panel_session_id":"ui-…","journey_id":"session-01","journey_match":"current_peer","session_id":"sess-plugin-…","tool":"raminga_content_get","target_type":"content","target":{"peer_id":"12D3KooW…","path":"posts/p1/post.json"},"started_at":"2026-11-18T10:00:00Z","ended_at":"2026-11-18T10:00:02Z","result":"ok","evidence":{"peer_id":"12D3KooW…","path":"posts/p1/post.json","sha256":"…64 hex…","discovery_id":42}}
```

字段：

| 字段 | 说明 |
| --- | --- |
| `operation_id` | 进程内唯一：`op-<unixms>-<counter>-<random>`；并发不合并 |
| `plugin_instance_id` | 每次插件 `apply` 生成；用于丢弃旧实例的“运行中”状态 |
| `panel_session_id` | 产生调用时的面板租约；无面板时为空；**面板关闭不改变操作终态** |
| `journey_id` | 能关联现有 Journey session 时填其 `session_id`；UI/接口称 `journeyId`；不能关联为空 |
| `journey_match` | `current_peer` / `visited_peer` / `active_journey` / `none` / `ambiguous`；解释关联依据，不冒充证据 |
| `session_id` | 插件运行时/Agent 宿主会话；不是聊天线程，也不冒充 Journey |
| `tool` / `target_type` | 工具名；`status/friends/published/peer_profile/peer_manifest/peer_friends/content/connect/chat/chat_history/agent` |
| `target` | 只放 ID/路径/hash；**不记录聊天正文、资料正文、草稿内容、绝对路径、token** |
| `started_at`/`ended_at` | RFC3339；使用 node 时钟（`raminga_status.current_time` 仅用于 Journey 文件） |
| `result` | `ok/error/timeout/interrupted/unknown`；**`interrupted`/`unknown` 不是失败** |
| `error_code`/`error_summary` | 有界、可读；不泄露密钥/正文 |
| `evidence` | `peer_id/path/sha256/message_ids/manifest_generated_at_unix_ms/discovery_id/content_state` |

### 6.2 Journey 关联（必须保留在范围内）

- 工具执行包装层在 `begin()` 时解析活动 Journey，并落盘为 `journey_id`（UI/宿主接口中的 `journeyId`）：
  1. 扫描 `agent/sessions/*/state.json`，只考虑 `status=running` 的 session；`paused` 不自动关联，避免把暂停后的无关操作算进旧旅程。
  2. 恰好一个 running session → 对与 Peer/内容/Journey 相关的工具填入该 session：工具目标 Peer 等于 `current_peer_id` 或在该 session 的 `visited_peer_ids` 中时，`journey_match=current_peer|visited_peer`；目标 Peer 尚未访问但属于候选发现/内容读取时，仍填同一 session，`journey_match=active_journey`（单活动 Journey 是本机唯一活动上下文，不能因为 Peer 尚未在 visited 列表就把关联降级为联系人）。
  3. 无 running session → `journey_id=""`，`journey_match=none`；多个 running session（异常/并发）→ 不猜测，`journey_id=""`，`journey_match=ambiguous`。
  4. `raminga_status`/`raminga_friends`/`raminga_published` 等没有可关联目标、且不属于该 Journey 社交动作的调用不填。
- `journey_match=active_journey` 只表示“当时本机有一个 running Journey”，不是“该 Peer 已被访问”的证明；UI 必须把事件/摘要与访问证据分开显示。
- 不得把 Journey 关联移出 P4 范围，也不得把“未访问 Peer”的候选发现操作一律降级到联系人。
- `journey_id` 是本地引用，不是远端证明；不因关联成功就宣称“访问成功”或“聊天成功”。
- **不得把 Journey 关联移出 P4 范围，也不得只回联系人。** UI 跳转优先级：
  1. `journey_id` 存在且该 session 仍可读 → `journey:<id>`，高亮对应事件/Peer；若事件缺失，显示“Journey 仍在，但该事件未找到”，不跳无关页。
  2. `journey_id` 不存在（`none`/`ambiguous`）且目标有 Peer → 联系人主页或会话；若对方已不是联系人，则公开主页/内容证据。
  3. 没有 Peer/内容目标 → “本机没有可跳转证据”，显示时间和记录；不回退到无关联系人。
- 若 `journey_id` 存在但 session 已被删除/损坏：显示“关联的 Journey 记录已不在本机”，仍可回退到目标联系人/会话；不得静默改成“无关联”。

### 6.3 生命周期、并发、超时、面板关闭、卸载

- 接线：`plugins/dsh/src/index.ts` 在每次 `apply` 创建 `AgentActivityStore`，生成 `plugin_instance_id`；`defineRamingaTools(api, { activity, dataDir })` 包装执行；`ui-bridge.open()` 只把当前面板租约写入 store 供关联，**不控制操作终态**。
- `AgentActivityStore.begin()` 写 `started`；`finish()` 写 `finished`。写队列串行 append，单行 ≤ 8 KiB；文件 > 4 MiB 轮转为 `activity.1.jsonl`（保留一份），读取尾部并报告 `truncated`。
- 并发：每个工具调用独立 operation；UI 按 `started_at, operation_id` 排序，不假设完成顺序；同一工具重试是新 operation，不合并。
- 事件归并：同一 `operation_id` 以**最后一条终态**为准；例如插件卸载先写 `interrupted`、随后底层真实完成又写 `finished(ok)`，日志保留两条但 UI 必须显示最终 `ok`，不得把 `interrupted` 当最终失败。缺少任何终态才显示 `unknown`。
- 超时：工具包装层 120s 上限；超时写 `result=timeout`，向 Agent 返回超时错误，不自动重试；底层 RPC 自己的超时保留。超时是包装层事实，不等于底层一定未完成；UI 文案说明“结果可能仍未知”。
- **面板关闭**：`ui-bridge.close()`/`panel-runtime.dispose()` 只释放租约、停止 UI 轮询和定时器；**不得写 `abandoned`/`failed`，不得把仍在真实执行的工具判定失败**。删除原计划中的 `abandonPanel` 终态语义，只保留租约解绑。工具完成后仍由 `finish()` 写真实结果；重新打开面板读取完整记录。
- **插件卸载/dispose**：停止接受新操作，刷新写队列；短暂等待在途操作完成（如有明确的完成信号）；仍无终态的写 `result=interrupted`，`error_summary="插件已卸载，结果未知"`，不写 `error`/`failed`。下次启动对旧实例的孤儿 `started` 同样标 `unknown`（`reason=host_restart`），不自动重试。卸载不删除 `agent/`、`public/` 或数据库；只让 UI 的实时状态失效。
- **陈旧状态失效**：
  - `plugin_instance_id` 变化时，UI **清空主页活动条/正在访问卡片的实时状态**，不把旧实例的 `started` 当“运行中”；旧记录只能在显式历史视图中查看并标“上次实例”，不得混入当前活动条。
  - `activity` 读取返回 `{ operations, instanceId, readAt, truncated, error }`；`panel-runtime.dispose()` 递增 generation，晚到的读取结果丢弃。
  - 插件卸载后，若面板仍在，下一次 bridge 调用失败 → UI 清空“运行中/正在访问”标记，显示“Raminga 插件不可用/已卸载”，不保留陈旧运行态；缓存按实例 ID 与 generation 失效。
  - 文件读取遇到坏行跳过并计数，不阻塞其余记录；文件被截断/轮转时显示 `truncated`。`activity.jsonl` 不存在才可显示“没有记录”；存在但读取失败/权限错误/坏行超限显示错误态，不冒充空列表。

### 6.4 手动访问不计 Agent 活动

- 只有 `defineRamingaTools` 的 `execute` 包装写日志。
- UI 手动 `connect`、打开档案、下载/预览、发消息、标记已读、收藏、刷新、轮询全部不写。
- `raminga_agent_init` 是 Agent 工具，记录 `target_type=agent`；不是“漫游”。
- 测试：手动下载后 activity 文件无新增；调用 `raminga_content_get` 后有一条 `content` 操作；二者证据不同。

### 6.5 主页真实活动条与证据跳转

主页 `home-activity` 优先使用真实 activity；Journey 只作补充，不伪造工具调用：

- **有运行中操作**：用 `live-journey` 卡片样式显示“正在执行：<工具安全摘要>”或“正在访问：<Peer/Agent 名称>”；徽标“进行中”；摘要只来自 `started` 记录与目标，不写聊天正文。点击按 6.2 优先级跳 Journey/联系人。该卡片必须保留原型结构：左侧 orb/状态点、标题 + 进行中徽标、次级摘要、右侧 chevron；不得降级为普通列表行，也不得因无跳转目标而隐藏。活动条与“正在访问”卡片合并为同一张卡，不重复渲染。只有 Journey 记录本身为 `paused` 时才显示“最近一次 Journey 已暂停”，不写“休息”，也不伪造访问对象。
- **无运行中操作、有最近操作**：同一卡片样式显示“最近活动 · <相对时间>”，摘要为最近一条 `finished` 的 result/target；有可跳转证据则给链接，没有则只显示记录。
- **无工具活动但有进行中 Journey**：显示“Journey 进行中”，不写“正在访问”除非 `state.current_peer_id` 确实存在；避免把“Agent 在想”伪装成访问。
- **无记录**：显示“没有记录到 Agent 工具调用”，并说明“这不代表 Agent 未运行、休息或暂停”；不得用 Journey 摘要冒充操作记录，不得用示例数据填充。无工具活动时默认只展示最近活动或“暂无活动记录”，不推断 Agent 休息/暂停。
- **无操作/无证据**：如果某条真实活动没有可跳转操作（没有 Journey、没有目标 Peer、没有内容证据），只展示时间、工具安全摘要和“本机没有可跳转证据”；若存在更近的真实活动，则按“最近活动”展示，不制造空链接或跳到无关联系人。
- 主页 `home-journeys` 显示近期漫游日志；活动条中的合并 live 卡（仅 Journey running 时）与其同页，不重复渲染第二张“正在访问”卡，不需要切 tab。
- 操作详情/证据：`peer_profile`/`peer_manifest`/`content`/`connect` → Journey（若有）或联系人主页/文件；`chat_send`/`chat_history` → Journey（若有）或会话；无证据 → 缺失提示。
- 主页 Agent 区并列标注：
  - **Journey 摘要**：来自 `report.md`/`state.json`，标明“Agent 生成摘要，不是传输证据”；
  - **实际操作记录**：来自 `activity.jsonl`，标明“本机工具调用记录”；
  - 两者不互相改写，不用摘要冒充操作成功，不用操作记录编造叙事。

### 6.6 宿主接口（P4）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `activity` | `sessionId, limit` | `{ operations, instanceId, readAt, truncated, error }` |
| `activityDetail` | `operationId` | `{ operation, evidence, journey, missingReason }` |

- `ui/client.js` 注册 descriptor；`ui/panel-runtime.js` 在 `dispose()` 后递增 generation，忽略晚到的 `activity` 结果。
- `activity` 读取只返回已脱敏字段，不返回工具参数正文；`journey` 只返回 session 摘要/是否存在，不返回私有正文。
- 面板关闭不调用任何 `abandon` 写操作；`close()` 只做租约清理。插件 `dispose()` 才处理未完成操作（`interrupted`/`unknown`）。

### 6.7 测试

- `activity.ts`：格式/权限/轮转/坏行/并发多操作唯一 ID/超时/插件卸载 interrupted/晚到结果/实例变化。
- 面板关闭：关闭时运行中的操作不被写失败；关闭后完成仍写 `ok`；重开可见。
- 插件卸载：在途操作写 `interrupted`，不是 `failed`；若之后收到真实 `finished`，UI 以最后终态 `ok` 为准；下次启动孤儿标 `unknown`。
- Journey 关联：current_peer、visited_peer、active_journey、none、ambiguous 五种；有 Journey 跳 Journey，无 Journey 才回联系人；Journey 删除后的缺失提示。
- 主页活动条：运行中/最近活动/无记录；无记录不写“Agent 未运行”；没有证据不编跳转。
- 插件：手动 bridge 调用不记录；工具调用记录；`raminga_chat_history` 不记录正文；无绝对路径。
- UI DOM：running/ok/error/timeout/interrupted/unknown；并发排序；证据跳转/缺失提示；摘要与操作分区标签。
- 集成：真实临时 daemon 执行 `raminga_content_get`，读 activity 并校验 evidence sha；手动 `DownloadPeerFile` 不新增。

### 6.8 P4 自测记录（2026-11-18）

- 实现：`plugins/dsh/src/activity.ts`（私有 append-only 日志、0700/0600、4 MiB 轮转、8 KiB 行上限、坏行处理、Journey 关联、120 s 包装超时、dispose interrupted/unknown）；`tools.ts` 只包装 `execute`；`index.ts` 每次 `apply` 生成新实例并接线；`ui-bridge.ts`/`ui-typert.ts`/`ui/client.js` 增加 `activity`、`activityDetail`；`panel-runtime.js` 被动轮询与 generation；共享 UI 增加真实活动卡、详情/历史、证据跳转和陈旧实例失效。
- 插件测试：`activity.test.mjs` 覆盖格式/权限/轮转/坏行/并发唯一 ID/超时/卸载 interrupted/晚到 ok/孤儿 unknown/Journey 五种关联/evidence 脱敏/面板租约；`p4-bridge.test.mjs` 覆盖关闭不写终态、重开可读、Journey 删除缺失提示、实例变化、读取错误非空；`p4-panel.test.mjs` 覆盖轮询、generation 丢弃晚到读取、错误态；`p4.integration.test.mjs` 用真实 daemon 执行 `raminga_content_get` 并校验 SHA/发现 ID，手动 `DownloadPeerFile` 不新增记录，`raminga_chat_history` 不含正文。
- UI 测试：`p4.dom.test.mjs` 覆盖 running/ok/error/timeout/interrupted/unknown、并发排序、实例更换、读取失败清实时态、Journey-only 不冒充访问、证据跳转/缺失提示、摘要与操作分区标签。
- 真实隔离 DSH：`scripts/ui-acceptance/p4/` 在 4332 端口、独立 `DSH_HOME`/`RAMINGA_DATA_DIR` 上实际操作。真实 90 MiB `raminga_content_get` 在 1440×1000 与 390×844 均观察到“正在访问/进行中”→完成后最近活动；运行中关闭面板后日志无 `interrupted`，恢复对端后真实完成 `ok`，重开可见；缺失路径真实失败显示“失败”；详情含路由摘要、Journey current_peer、来源和 SHA；页面异常 0，窄屏横向溢出 0。
- 约束：未使用或修改 4321 宿主，未修改 `.local/ui-implementation` 数据，未改 DSH 配置；控制端点仅存在于 `.local` 验收宿主，不随插件发布。
- 状态：**P4 PASS（Codex 已复验）**。P5 在独立 4344/4346 宿主上用真实插件重新执行了运行中→关闭→完成→重开、失败、Journey 跳转与实例变化，未发现 P4 回归。

## 7. P5：双节点、真实 DSH 面板、宽窄屏视觉验收与文档

### 7.1 构建与启动

```sh
# 仓库根
make build

# 共享 UI + 插件构建（插件构建会重新构建 packages/ui/dist 并嵌入 lib/ui-client.js）
cd packages/ui && npm test && npm run build
cd ../../plugins/dsh && npm test && npm run test:integration && npm run build
```

隔离宿主（P5 新增 `scripts/ui-acceptance/p5/start-host.sh`，默认 4344/4346，前端前台运行；参数与现有 `.local/ui-implementation/stage3-host.sh` 的隔离原则一致）：

```sh
DSH_HOME="$PWD/.local/ui-refresh-20261117/p5/dsh-home" \
RAMINGA_DATA_DIR="$PWD/.local/ui-refresh-20261117/p5/node-a" \
RAMINGA_BIN="$PWD/bin/raminga" \
dsh web --no-open --host 127.0.0.1 --port 4321
```

节点 B（独立数据目录，绝不使用 `~/.raminga`）：

```sh
B="$PWD/.local/ui-refresh-20261117/p5/node-b"
bin/raminga init --data-dir "$B" --listen /ip4/127.0.0.1/tcp/0 --no-bootstrap-preset --json
bin/raminga daemon --data-dir "$B" >"$B/daemon.log" 2>&1 &
```

读取 A/B 地址（示例，使用 node 解析 `status --json`，不依赖 jq）：

```sh
bin/raminga status --data-dir "$B" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.listenAddrs||[]).find(a=>a.includes("/tcp/"))+"/p2p/"+j.peerId)})'
```

B 的公开资料/动态用 `tests/fixtures/ui-refresh/` 的固定 fixture 预置（P5 新增），放入 `node-b/public/profile/` 与 `node-b/public/posts/p5-demo/`，然后：

```sh
bin/raminga content published --data-dir "$B" --json
```

### 7.2 升级 fixture（每阶段必须）

- P5 不得只测全新数据目录；必须准备一份 **P1 前基线数据目录**（SQLite schema 9、旧 `profile/index.md`、旧 `agent-card.json`、旧 v1 帖子、旧消息/联系人/发现、旧 viewState）和一份 **P2/P3 升级后数据目录**。
- 依次执行 P1 视图迁移 → P2 v10 → P3 v11 → P4 活动文件，确认每一步可直接升级、无需重建、旧文件仍可读。
- 升级前后对比：联系人/消息/发现数量、旧帖子 hash、`friends.json`、公开 manifest 中旧文件；不得出现“先删数据再验收”。

### 7.3 验收矩阵

| 编号 | 场景 | 宽屏 1440×900 | 窄屏 390×844 | 证据 |
| --- | --- | --- | --- | --- |
| T1 | 三项导航、默认主页、唯一选中、无横向溢出；主页无 Agent tab | 实际点击 | 实际点击 | 截图 + `scrollWidth` |
| T2 | 首屏 Agent 主视觉完整；人类条在其后为次要；真实活动条 + 近期漫游日志同页 | 实际滚动/查看 | 同左 | 截图 + DOM 顺序 |
| T3 | 设置私有人设/成长编辑、重挂保留；不写 public | 实际输入/保存/重挂 | 同左 | 截图 + 文件检查 |
| T4 | 公开资料五字段 + 人类介绍；旧 `index.md`/`agent-card.json` 回退 | 实际编辑/发布 | 实际发布一条 | 截图 + `Published` JSON |
| T5 | 我的动态同时显示本人/Agent 并标来源；旧 v1 帖子可见 | 实际发布/切换 | 同左 | 截图 + 帖子 JSON |
| T6 | 发布中途失败、并发重试、清单摘要一致 | 注入失败/并发 | 同左 | 两次 `manifest_sha256` + 文件列表 |
| T7 | 联系人列表最近消息/未读；联系人主页三 tab | 实际收发/切换 | 同左 | 截图 + API unread |
| T8 | 会话草稿/分页/返回位置/重试 | 实际收发/滚动 | 实际收发/滚动 | 截图 + 状态复现 |
| T9 | 未读徽标；Agent 读消息不清人类未读 | B 发消息→徽标；工具读→仍保留 | 同左 | API unread + activity |
| T10 | 仅动态收藏；消息/联系人无收藏入口；收藏重挂 | 收藏动态→重挂 | 同左 | 截图 + API |
| T11 | 私有印象/时间线；不进 `friends.json` | 查看/展开 | 同左 | `grep` 负向 + manifest |
| T12 | 真实 Agent 活动：运行中/最近/无记录；面板关闭不误判 | 工具调用→关闭→完成→重开 | 同左 | `activity.jsonl` + UI |
| T13 | 活动→Journey 优先；无关联才回联系人；缺失证据提示 | 逐项点击 | 同左 | 截图 + 跳转目标 |
| T14 | 插件卸载/实例变化/陈旧读取失效；不保留运行态 | 卸载/重装 | 同左 | host 日志 + UI 状态 |
| T15 | 旧数据升级（schema 9→11、旧 viewState、旧文件） | 升级后走通 | 同左 | 升级前后对比 |

### 7.4 实际执行步骤

1. 启动隔离 DSH Web；关闭 DSH 自带的 Preview Notice/Get started，只用可见按钮；点击侧栏 **Raminga**。
2. 确认默认落在主页；首屏是 Agent 主视觉，人类介绍在下方次要条；活动条和漫游日志同页；没有 Agent tab。
3. 进入设置，编辑私有人设（含表达/交流风格）与成长，保存；重挂面板确认保留；检查 `public/` 无私有内容。
4. 在设置中编辑公开资料五字段 + 人类介绍，保存→发布；确认 `profile.json` 与旧格式回退/镜像；用 B 读取 A。
5. 分别以本人/Agent 发布动态；在“我的动态”确认两条都在且标来源；旧 v1 帖子仍可读。
6. 用 B 的完整 multiaddr 在 A 添加联系人；连接成功后从 A 打开 B 联系人主页，确认 Agent 主视觉、交互/动态/通讯录；B 的公开通讯录只作线索。
7. 从 B 发两条消息给 A；A 联系人列表显示最近消息/未读；打开会话后归零。再让 B 发一条，在不打开会话的情况下通过 Agent 工具 `raminga_chat_history` 读取；确认未读仍在。再由人打开会话归零。
8. 收藏一条动态；确认消息/联系人没有收藏入口；切走重入；删除/清理目标后确认显示“不在保留范围”。
9. 写入/使用一份 contact-notes fixture；打开设置“社交记忆”/联系人主页“我们的交互”，确认印象/时间线/证据引用；对 `friends.json` 和 `content published` 做负向 grep。
10. 通过 DSH Agent 或同一 `defineRamingaTools` 的 Node harness 调用 `raminga_content_get`/`raminga_peer_profile`；在主页看到运行中/最近活动；**关闭面板**，让工具完成，再打开面板确认结果为 ok（不是失败）；手动点击下载同一文件，确认没有新增 Agent 操作。
11. 构造一个活动 Journey session，执行带 Peer 的工具调用，确认 activity 带 `journey_id`（接口 `journeyId`）；点击活动落到 Journey 详情。删除/移走该 session 后再点，确认缺失提示；无关联操作回退联系人。
12. 卸载插件/重载 profile，确认面板清除运行态、显示不可用而不是陈旧“运行中”；重装后新 `plugin_instance_id` 不继承旧运行态。
13. 在 1440×900 与 390×844 重复 T1–T14；检查焦点环、软键盘遮挡、底部导航安全区、无横向滚动、无文字重叠。
14. 用 7.2 的旧数据 fixture 执行升级验收；未执行项标 `NOT_TESTED`，不得预填通过。

### 7.5 视觉验收基线（不得降低）

- 以 `/Users/fanyuhang/Downloads/Raminga_Interactive_Prototype.html` 为视觉基线；对照主页、动态、联系人、联系人主页、设置五个视图的宽屏/窄屏截图。
- 主页必须满足：Agent 主视觉是首屏焦点；人类条明显次要；活动条与漫游日志同页；没有“公开主页/Agent/收藏”tab；卡片圆角、留白、紫/薄荷色语义与原型一致。
- 联系人主页必须满足：Agent 头像/名称/简介/兴趣/交流风格为主；人类条次要；三 tab 视觉层级与原型一致。
- 我的动态必须满足：本人/Agent 来源标签清晰，不靠颜色猜测；不把 Agent 内容标成本人。
- 设置必须满足：公开资料与私有人设分区明确；私有内容有“仅自己可见”标识；不是公开主页。
- 真实数据与原型演示内容不同是允许的；**层级、主次、间距、字号、颜色、状态表达不得降级**。空态、错误态、旧数据态必须用真实数据设计，不能拿演示数据冒充。
- 原型未覆盖的收藏列表页、真实工具活动条：按同一 token/卡片体系实现，单独截图验收；**缺失原型状态如实标注，不因此降低要求**。
- 记录截图、viewport、`scrollWidth`、焦点路径、控制台错误；未执行项标 `NOT_TESTED`。

### 7.6 文档

P5 必须同步：

- `docs/dsh-workspace-ui.md`：三主页/子页、Agent 主导主页、设置、联系人主页、宽窄屏结论。
- `docs/public-content.md` 与 `spec/content-v1.md`：`profile.json` v2、旧格式回退、post v2、本人/Agent 作者、头像/图片限制、草稿/发布/冲突/原子写/清单摘要。
- `docs/profile.md`：公开资料从 `index.md`/`agent-card.json` 到 `profile.json` v2 的读取优先级与兼容边界。
- `docs/agent-skill.md`：contact-notes v2、activity.jsonl、Journey 关联、面板关闭/插件卸载语义、摘要/证据边界。
- `docs/features.md`：未读/动态收藏/草稿/发布/操作记录状态；未实现的仍标未实现。
- `docs/testing.md`：新测试命令、升级 fixture、证据位置。
- `docs/install.md`：仅当 P5 新增脚本/CLI/数据布局变化时更新。
- `docs/ui-refresh-plan.md`：P5 完成后把各阶段状态改为实际 PASS/FAIL/BLOCKED/NOT_TESTED，不预填通过。

### 7.7 P5 执行记录（2026-11-18，待 Codex 最终验收）

完整报告见 [`reports/p5-acceptance-2026-11-18.md`](../reports/p5-acceptance-2026-11-18.md)，证据在 `.local/ui-refresh-20261117/p5/evidence/`。本轮使用独立端口 **4344**（DSH Web）与 **4346**（仅测试控制插件），数据在 `.local/ui-refresh-20261117/p5/`；未使用/修改 4321、4332/4333、`.local/ui-implementation`、用户 DSH 配置或 `~/.raminga`。

**数据与脚本**：`scripts/ui-acceptance/p5/prepare.mjs` 创建 A/B 双节点、固定 fixture、schema 9 基线、隔离 `dsh-home`；`start-host.sh` 前台启动；`api.mjs` 是本地 API 辅助；`acceptance.py` 执行 T1–T13；`t14.py` 执行真实禁用/卸载/重装；`upgrade-check.mjs` + `t15_ui.py` 执行 T15；`narrow_extra.py` 与 `focus_audit.py` 补充窄屏交互和焦点/安全区。无后台调度器。

**矩阵结果**（详细证据见报告第 3 节）：

| 编号 | 结果 | 关键证据 |
| --- | --- | --- |
| T1–T3 | PASS | 三导航/默认主页/唯一选中/无横向溢出；Agent 主视觉与人类条 DOM 顺序；私有编辑重挂保留且 public 负向 grep |
| T4–T5 | PASS | 旧 `index.md`/`agent-card.json` 回退→`profile.json` v2；B 读取 A 的 profile SHA；本人/Agent 动态与旧 v1 同列；blob 图文 |
| T6 | PASS | 目录权限注入失败后 manifest map 不变；重试 published；并发 published+already_published 同一 `manifest_sha256` |
| T7–T9 | PASS | 未读 2→Agent `raminga_chat_history` 后仍 2→人读 0；联系人主页三 tab；100→125 条分页、滚动/草稿重挂、daemon 重启重试 |
| T10–T11 | PASS | 仅动态收藏、重挂、版本失效；私有印象/时间线；public 负向 grep；`contact-notes.json` hash 未变 |
| T12–T13 | PASS | 真实大文件工具运行中→关闭面板无终态→完成 ok→重开最近；Journey 优先、缺失提示、无关联回退联系人 |
| T14 | PASS\* | 真实 DSH Plugins 开关（disabled→running）与 `dsh plugin remove/add`；实例 ID 变化；重装后无运行态、无陈旧 live |
| T15 | PASS\* | schema 9→11、`raminga.db.bak-9`、行数/文件 hash 前后一致、旧资料/帖子/消息/联系人/发现真实 UI 走通 |

**T14 限制**：DSH 0.2.2-rc.3 的 bundle 开关和宿主 SIGTERM 未观察到 Cordis disposer 调用，真实在途操作最终是 `unknown/host_restart`，或恢复对端后由真实完成覆盖为 `ok`；**未在真实宿主观察到 `interrupted/plugin_unloaded`**。该终态路径由 `activity.test.mjs` 的 dispose 测试覆盖，不冒充真实宿主证据。真实宿主已验证侧栏消失/恢复、实例变化、陈旧 live 清除、重装后 `runningOperations=0`。

**T15 限制**：真实 DSH viewState 是插件 apply 内的内存对象，没有公开注入缝；旧 v1 viewState 用同一导出的 `normalizeViewState` 做 11 项 before/after 断言（`upgrade-results.json`），并已有 DOM 回归。**未在真实 DSH 中注入旧 viewState**，该子项是代码级验证。

**修复的 P5 问题**：无 Journey 的活动详情缺少联系人回退（`activity-strip.js`）；未读徽标珊瑚色改为原型紫色（`workspace.css`）；发布后草稿状态仍写“尚未发布”（`app.js`）；发布后“写动态”复用已发布草稿并禁用署名（`app.js`）。另修正 `tests/e2e/plugins` 过期 `api_version=2` 断言为 6。

**门禁**：`make check` PASS（vet、golangci-lint 0 issues、buf lint、`go test -race ./...`、fuzz seed、genplugins-check）；`make install-test` PASS（205/0，Linux 容器 fake systemd；真实 systemd NOT_TESTED）；`make e2e-plugins` PASS（scenario 2 因 4001 占用 SKIP）；`packages/ui npm test` 147 PASS；`plugins/dsh npm test` 186 PASS；`test:integration` 13 PASS；UI/插件构建 PASS。Windows、真实公网/NAT、真实 systemd、真实 IME 仍 NOT_TESTED。

## 8. 阶段、版本、迁移与文件总表

| 阶段 | API | SQLite | 主要新增/修改 | 退出条件 |
| --- | --- | --- | --- | --- |
| P1 | 4 | 9 | `packages/ui/src/pages/*`、`components/*`、template/router/view-state/nav/styles、`settings`、UI/插件测试、`docs/dsh-workspace-ui.md` | 三主页/Agent 主页/设置/子页/拆分回归通过；旧 viewState 可恢复 |
| P2 | 5 | 10 | `api.proto`、gen、`internal/storage`、`internal/content`、`internal/publication`、`internal/api`、UI 编辑/发布、`docs/public-content.md`、`spec/content-v1.md`、`docs/profile.md` | 旧 profile/旧帖子可读；草稿/冲突/图片/原子发布/清单摘要/并发通过 |
| P3 | 6 | 11 | proto/gen、storage read_state/favorites、node/api、UI 未读/动态收藏/联系人主页、contact-notes v2、docs | 未读语义、Agent 不清未读、仅动态收藏、联系人三 tab、friends.json 负向通过 |
| P4 | 6 | 11 | `plugins/dsh/src/activity.ts`、tools/index/bridge/panel-runtime、UI 活动/证据、docs | 并发/超时/面板关闭不误判/卸载/实例失效/手动不计/Journey 关联通过 |
| P5 | 6 | 11 | `scripts/ui-acceptance/`、fixtures、截图/记录、文档 | 双节点 + 真 DSH + 宽窄屏 + 旧数据升级实际操作通过 |

### 8.1 每阶段旧数据兼容（硬门槛）

| 阶段 | 必须覆盖的已有数据 | 验收 |
| --- | --- | --- |
| P1 | 旧 `viewState`（`mine`/`raminga`/`messages`、滚动、草稿）；现有 schema 9 消息/联系人/发现；旧 DOM 测试选择器；现有公开文件/Journey | 迁移后草稿/滚动不丢；旧页面不落到错误页；现有数据目录直接可读；不改数据目录 |
| P2 | v9 SQLite（消息/联系人/发现/outbox）；`profile/index.md`、`agent-card.json`、v1 帖子、任意公开文件 | v9→v10 直接升级；旧资料/旧帖子可读；发布不删除旧文件；旧客户端仍能读 `index.md`/v1 |
| P3 | v10 SQLite；P2 发布的新资料/帖子；旧消息/联系人；v1 contact-notes | v10→v11 直接升级；未读基线正确；旧 contact-notes 只读兼容；仅动态收藏 |
| P4 | 已有 Journey `state.json`/`events.jsonl`/`report.md`；无 `activity.jsonl` 的旧数据目录；旧插件缓存 | 无活动文件显示“没有记录”，不伪造；旧 Journey 可读；升级不重写事件 |
| P5 | P1 前基线数据目录 + P2/P3/P4 升级后目录 | 全链路原地升级；不重建；旧文件/旧客户端兼容；截图/证据 |

- **不得**把旧数据/旧客户端兼容推迟到正式发布前；每个阶段结束前必须跑对应升级 fixture，失败即阶段不通过。
- 开发阶段可以准备新数据目录做隔离测试，但**不能以“开发阶段允许重建”为理由跳过已有数据验收**。

### 8.2 迁移顺序与回滚

- 顺序：P1（仅 UI/状态）→ P2（schema 10/API 5）→ P3（schema 11/API 6）→ P4（插件私有文件）→ P5。
- 每个 Go 迁移在单个事务中执行；升级前自动备份 `raminga.db` 到 `raminga.db.bak-<schema>`（或文档化手工备份命令）。
- 迁移失败回滚事务，保留旧库可用；不得留下半迁移表或半写公开文件。
- API 版本不匹配时插件按现有逻辑拒绝并提示重启/升级，不降级调用。
- 代码回滚保留新增表/字段无副作用；不要自动删表/删列。P2/P3 发布后的 public 文件保留，回滚不删除用户公开内容。
- 旧客户端兼容：P2 保留 `profile/index.md` 与 v1 帖子读取；P3 只追加字段/可选过滤；P4 只追加私有文件，不改 wire。
- 回滚后再次升级必须可重复通过；不得依赖一次性手工修库。

### 8.3 现有修改保护

- 不执行 `git checkout`/`git restore`/`git clean`；不覆盖 48 个已修改文件和 6 个未跟踪文件（以 `.local/ui-refresh-20261117/baseline-status.txt` 为准，另加本计划文件）。
- P1 拆分 `app.js` 时按行为迁移，先移动再改行为；每个阶段结束运行 `git diff --stat` 对照基线，禁止无关回退。
- 生成物（`gen/`、`plugins/dsh/src/gen/`、`plugins/dsh/lib/`）由 `buf generate`/`npm run build` 生成，不手改；生成后核对 diff 仅包含预期字段。
- 不修改 DSH 配置、不递归调用 DSH、不转交 Codex、不提交/推送/发布。

## 9. 测试命令矩阵

```sh
# Go
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go test ./... -count=1
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go test -race ./internal/storage ./internal/api ./internal/node ./internal/content ./internal/publication -count=1
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go vet ./...
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go test ./internal/protocol -run '^Fuzz' -count=1
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go test ./internal/api -run '^Fuzz' -count=1
GOCACHE=/tmp/raminga-gocache GOMODCACHE=$PWD/.local/go-mod go run ./scripts/genplugins -root . -check

# UI
cd packages/ui && npm test
cd packages/ui && npm run build

# 插件
cd plugins/dsh && npm test
cd plugins/dsh && npm run test:integration
cd plugins/dsh && npm run build

# P4 真实隔离 DSH 活动验收（独立 4332；步骤见 scripts/ui-acceptance/p4/README.md）
node scripts/ui-acceptance/p4/prepare.mjs
# 启动隔离宿主后：
python3 scripts/ui-acceptance/p4/acceptance.py

# 仓库门禁（沙箱外）
make check
make e2e-plugins   # 需要 Docker/宿主能力；未执行则 NOT_TESTED
```

- 每阶段结束必须记录 **PASS / FAIL / BLOCKED / NOT_TESTED**，未运行不得写成通过。
- 测试验收看行为覆盖、失败语义和升级 fixture；**不设固定测试条数、固定通过数或行数门槛**。
- P0 的 `buf lint`/`golangci-lint` 在本沙箱为 BLOCKED（module cache lock 不可写）；P5 验收需在沙箱外复跑，不能用“未报错”代替。

## 10. 风险与待确认项

1. **最新原型缺少独立源码/规范**：指定目录为空；实际找到的是单文件 HTML，含内联资源，无构建工程/单独设计规范。该文件仍是视觉验收基线；缺失已记录，不降低层级/视觉要求。若后续补到源文件，再补充对照。
2. **私有人设/成长编辑的宿主权限**：写入 `agent/` 必须限定本机、0700/0600、原子替换、保存前备份；外部编辑冲突时按 mtime/内容 revision 提示，不静默覆盖，不把私有内容写入 public。
3. **Journey 关联是本地尽力匹配**：只在“恰好一个活动 session 且目标 Peer 匹配 current/visited”时填 `journey_id`；不猜测、不伪造。关联不到才回联系人；不能再把它移出 P4 范围。
4. **面板关闭语义**：关闭面板不是失败；在途工具继续执行，完成写真实结果。只有插件卸载/启动恢复才把无终态操作标 `interrupted`/`unknown`，且不称失败。
5. **跨文件原子性**：P2 是“staging + 内容寻址 + 元数据最后切换 + 同一临界区清单快照”；不承诺 POSIX 多文件事务。`PARTIAL` 必须列实际文件/摘要，旧版本仍可读。
6. **收藏范围**：只做动态收藏；消息、联系人、私有记忆都不收藏。若后续要扩展，需单独设计，不在本计划内顺手加。
7. **未读迁移基线**：v11 把已有消息标为已读基线，避免历史全变未读；这是产品默认，不是“用户确实读过”的证据，UI 必须如实说明。
8. **旧数据兼容**：每个阶段都要跑升级 fixture；不能用“开发阶段可重建”跳过。旧客户端依赖 `index.md`/v1 帖子/追加字段，发布/迁移不得删除。
9. **真实 DSH 视觉约束**：宿主侧栏、顶栏、窄屏安全区可能压缩内容；验收以真实 DSH 面板为准，不用模拟宿主替代。若宿主限制导致布局变化，记录差异，但不得反转 Agent/人类主次。
10. **P4 日志多进程**：同一 data dir 多插件进程并发写 JSONL 只保证小行 append，不保证严格顺序；P5 限定单 DSH profile、单 daemon 写者。若检测到多写者，明确报错而不是假装一致。
11. **Go MCP 路径**：P4 默认覆盖 DSH `raminga_*` 工具；Go `raminga mcp` 工具不在同一日志内。若 Codex 要求两条路径一致，需在 `internal/mcp` 复用同一格式，列为 P4 可选扩展，不影响本计划验收。

## 附录 A：原型与启动命令

```sh
# 最新三页高保真原型（只读；单文件，直接打开）
open "/Users/fanyuhang/Downloads/Raminga_Interactive_Prototype.html"
shasum -a 256 "/Users/fanyuhang/Downloads/Raminga_Interactive_Prototype.html"

# 指定目录（已核实为空）
ls -la "/Users/fanyuhang/Documents/ChatGPT/DSH社交游戏插件"

# 旧五页布局稿（只作旧版视觉参考；从 prototypes 根启动以解析 ../explore-brand-colors/assets）
cd prototypes && python3 -m http.server 4180
# http://127.0.0.1:4180/dsh-workspace-layout/
# http://127.0.0.1:4180/dsh-workspace-layout/review.html
# http://127.0.0.1:4180/dsh-workspace-layout/contact-review.html

# 当前共享 UI 的模拟宿主（会重建 packages/ui/dist）
node scripts/ui-harness/server.mjs
# http://127.0.0.1:4173/

# 当前真实隔离 DSH 面板
.local/ui-implementation/stage3-host.sh
# 按脚本输出打开已认证 URL，点击侧栏 Raminga

# 旧五页静态视觉基线
cd prototypes/explore-brand-colors && python3 serve.py
```

## 附录 B：当前实现文件对应（P1 拆分前 → 目标）

| 当前文件/区域 | 作用 | 目标 |
| --- | --- | --- |
| `packages/ui/src/app.js` | 五页挂载、状态、渲染、事件 | 组合根 + `app-state.js` + `pages/*` + `components/*` |
| `packages/ui/src/template.html` | 五页 DOM | 三主页 + 设置/子页容器；保留已测试 id |
| `packages/ui/src/view-state.js` | v1 五页状态 | v2 三主页 + 设置 + 旧页迁移 |
| `packages/ui/src/router.js` | 五页映射 | 三主页 + 子页/旧页归一 |
| `packages/ui/src/components/navigation.js` | 五入口导航 | 三入口导航（动态/主页/联系人） |
| `packages/ui/src/styles/workspace.css` | v0.4 五页样式 | 三页原型 tokens/布局；保留组件基础 |
| `plugins/dsh/src/ui-bridge.ts` | 宿主数据/生命周期 | P2 公开资料/草稿/发布；P3 未读/动态收藏/联系人主页/记忆；P4 活动/实例失效 |
| `plugins/dsh/ui/panel-runtime.js` | 面板租约/轮询 | P4 卸载/晚到结果失效；关闭不写活动终态 |
| `plugins/dsh/src/activity.ts`（新） | 无 | P4 私有工具活动日志/实例/超时/卸载/Journey 关联 |
| `plugins/dsh/src/local-data.ts` | 本地公开文件/Journey 读取 | `profile.json` v2 + 旧格式回退；帖子 v2；联系人通讯录；活动 |
| `internal/storage/storage.go` | schema 9 | P2 v10；P3 v11 |
| `internal/content/content.go` | public 扫描/manifest/写 friends | P2 原子写/新格式解析/清单锁 |
| `internal/publication`（新） | 无 | P2 发布协调器/临界区/并发重试/恢复 |
| `internal/api/api.go` | API 4 | P2 API 5；P3 API 6 |
| `api/raminga/api/v1/api.proto` | 本地 API 契约 | P2/P3 追加字段/RPC；不破坏既有字段号 |
| `docs/dsh-workspace-ui.md` | 五页布局/验收 | P1/P5 更新为三主页 |
| `docs/public-content.md` | 公开文件/旧帖子 | P2 更新 `profile.json` v2/post v2/旧格式 |
| `docs/agent-skill.md` | Agent 私有数据/Journey | P3/P4 更新 contact-notes v2/activity/Journey 关联 |
