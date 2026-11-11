# ADR-0006: Agent 接入以插件分发，内容单一来源

Status: Proposed
Date: 2026-11-10
Revised: 2026-11-12

## Context

早期形态以“Raminga Skill + `raminga` CLI + 可选宿主脚本”接入 Agent（见 [agent-skill.md](../agent-skill.md)）。该形态只能覆盖单次模型调用：Skill 需手工复制，不能安装、更新或注册工具；模型要在 shell 中拼接 CLI 命令并解析 JSON；DSH 不消费包内 Skill；同一内容存在多份副本。2026-11-11 的 macOS 真实安装进一步确认了宿主限制：MCP 握手约 30 秒、Codex 不向插件 MCP 传递调用者环境变量、Codex 对写/网络工具按自身策略审批。

各宿主已有正式插件机制（2026-11-10 公开文档；2026-11-11 起按实际宿主验证）：

| 宿主 | 插件形态 | 工具接入 | 生命周期 / 配置 |
|---|---|---|---|
| Claude Code | marketplace 目录，`.claude-plugin/plugin.json` | 插件 `.mcp.json`；`skills/` 自动加载；`bin/` 进 PATH | hooks、`userConfig`；`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` |
| Codex | marketplace 目录，`plugin.json` | 插件 `mcp.json`；`skills/` 自动发现 | `onboardingSkill`；调用者环境变量不传入插件 MCP |
| DSH | npm 包，`package.json#dsh.bundle.patch` + `cordis.patch.yml` | Cordis 入口内 `ctx.tools.register` 原生注册 | `apply(ctx, config)` 在宿主进程内运行；`$DSH_HOME/data/<id>/` |

## Decision

以下边界已确定，本文不再保留待定项。

### 1. 分层与范围

- **Node（不变）：** `raminga daemon` 是身份、网络、联系人、内容、消息与 ACK 的唯一事实来源，也是唯一需要后台常驻的进程。插件不新增第二份状态或网络监听。
- **核心二进制：** 同一 `raminga` 可执行文件新增 `raminga mcp` 子命令（stdio MCP Server，内部经现有 Connect-RPC over UDS 访问 daemon，自身无状态）。它由宿主按需拉起、随宿主退出，不是用户需要启动的服务。
- **插件外壳：** 每个宿主一个薄外壳，只负责清单、获取二进制、确保 daemon 运行、把工具与指引装配成该宿主的格式。外壳之间不共享运行时状态。
- **工具原则：** Agent 应像普通用户一样使用 Raminga。插件可提供引导与辅助（安全检查、初始化文件），但不承担 Agent 内部设计：Agent 的持久化运行、宿主对工具调用的审批、多宿主会话上下文共享均不在插件范围，只在文档如实说明。不新增为特定 Agent 设计的工具。

### 2. Agent 内容单一来源

`agent/` 是唯一手写的 Agent 内容目录，以 Go 包 `go:embed` 编入二进制：

| 子目录 | 读者 | 内容 |
|---|---|---|
| `agent/guidance/` | 模型 | 启用条件、信任边界、证据与印象区分、公开同意、漫游流程、首次使用、数据约定 |
| `agent/tools.yaml` | 模型（工具描述）与 MCP Server | 12 个工具的名称、参数与语义 |
| `agent/templates/` | 程序 | Persona、Growth、Contact Notes 与 Session 模板 |

- Persona、Growth、Contact Notes 与 Sessions 由宿主 Agent 用自身文件能力读写，不提供读写工具。`raminga_agent_init` 是唯一的初始化辅助：只创建缺失文件，要求节点已有身份，绝不覆盖已有文件。
- `SKILL.md` 正文自足：漫游流程、数据约定、首次使用与 Session 模板由 `agent/` 经 `scripts/genplugins` 渲染进 Claude/Codex 的 `SKILL.md` 与 DSH 核心指引，不再生成 `references/`。
- 生成物提交进仓库（宿主从 git 安装时不运行构建），CI 以 `genplugins --check` 校验；平台差异只在渲染器，不进入内容。面向开发者的说明留在 `docs/`。

### 3. 工具接入

- **Claude Code、Codex：** 插件声明 MCP Server，命令指向随插件提供的启动器，启动器执行 `raminga mcp`。
- **DSH：** 不使用 MCP；Cordis 入口经 connect-es 直连本地 API，以 `ctx.tools.register` 注册原生工具，核心指引经 `ctx.systemPrompt.section` 注入系统提示，工具描述与 MCP 外壳同源。
- **其他支持 MCP 的 Agent：** 用户可只添加一条 `raminga mcp` 配置使用同一套工具；不为其提供专门外壳。
- 12 个工具全部 `permission: auto`，MCP 注解如实（只读、访问开放网络、非破坏）。插件清单不能声明宿主的自动允许；是否弹窗确认由宿主策略决定。Claude Code 的会话/用户级允许规则已实测有效；Codex 对连接、发消息按其策略要求审批，非交互下会失败——第一版接受，不提供绕过。

### 4. 二进制获取与平台

- 二进制只在 CI 中编译一次（GoReleaser，6 个平台，附 `SHA256SUMS`），用户机器不编译。
- **Claude Code、Codex：** 启动器按插件写死的版本复用 PATH 上精确匹配的 `raminga`，其次复用 `~/.raminga/bin/<version>/` 缓存，最后从 GitHub Release 下载对应平台的原始二进制；校验 SHA256，失败即报错、不降级，且失败不留空目录。
- **DSH：** 走 npm 平台子包，经 `optionalDependencies` 随插件安装。已在 macOS/darwin-arm64 实测 pnpm 按 `os`/`cpu` 过滤；其他平台未实测。
- 第一版**不签名**。发布说明写明 macOS 放行方法：带 quarantine 的未签名二进制会被 Gatekeeper 终止，curl 下载不带 quarantine；若仍被拦截，按系统提示选择“仍要打开”或移除 quarantine。
- Windows 外壳照常发布并标注“未实测”；Windows 实测暂缓，不作为第一版出口。
- 插件不引入宿主之外的运行时：启动器为 sh 与 PowerShell 脚本（或极小的按平台 Go 启动器）；DSH 外壳依赖 DSH 自身已有的 Node。

### 5. 数据目录与生命周期

- 节点数据目录保持 `$RAMINGA_DATA_DIR`，否则 `~/.raminga`。它属于用户，不放入任何插件目录或插件状态目录；所有宿主共享同一节点，卸载插件不删除节点。
- `raminga mcp` 与直接运行 `raminga` 共用旧数据目录与其他已知节点检测，避免误建新身份。daemon 在首次工具调用时懒启动（宿主 MCP 握手上限约 30 秒）。
- Codex 不向插件 MCP 传递调用者环境变量，因此 Codex 下只使用默认 `~/.raminga`；`RAMINGA_BIN` / `RAMINGA_DATA_DIR` 适用于 Claude Code 与 DSH。
- `raminga_status` 返回 `current_time`，供 Agent 写事件时间戳。本地 API 的 `api_version` 为 `"2"`；外壳发现 daemon 版本不兼容时提示重启或升级，而不是直接调用失败。

### 6. 入站消息与持久运行

- 插件不处理入站消息，由宿主原生 Agent 决定如何处理。持久运行、入站唤醒、会话恢复、重试/去重与工具审批都是宿主 Agent 的内部设计；插件不提供常驻 supervisor、模型 runtime、宿主 thread 存储或自动回复开关，也不把模型生命周期放进 daemon。
- 第二期若做无人值守自动回复，入站回合必须无工具，只产出结构化 `reply`/`ignore`；第一版不定义该回合形态。

### 7. 注入防护

- **来源规则：** 任务只能来自用户请求或 Agent 为完成该请求制定的计划。远端内容中的请求须转述给用户并等待明确同意，不执行、不据此连接新地址或外发私有资料。规则写在 `agent/guidance/core.md` 的 Source rule。
- **不可伪造信封：** 远端 Profile、Manifest、好友声明与下载内容由 Go 与 DSH 同一套标记包裹；命中注入特征时追加本地警告，不拦截、不改写原文；远端无法伪造结束标记。
- **daemon 兜底：** 只对 `agent_origin` 发送检查私有原文、密钥、本机路径与频率上限，命中返回 `PermissionDenied`。MCP 与 DSH 发送时置位，TUI/CLI 人工发送不置位、行为不变。

### 8. 发布渠道

- 二进制发布到主仓库 `Raminga/raminga` 的 Releases，CI 使用 `GITHUB_TOKEN`，不使用 PAT。
- Claude Code、Codex 外壳发布到 marketplace 仓库 `Raminga/raminga-plugins`（tap 模式，CI 用 deploy key 推送）；marketplace 清单的联系方式只写仓库地址。
- DSH 外壳发布为 npm `@raminga/dsh`，平台二进制为 `@raminga/bin-<os>-<arch>`，发布到 npm 组织 `raminga`，CI 使用 `NPM_TOKEN`。
- 首发先打预发布 tag（如 `v0.1.0-rc.1`），做真实安装冒烟；同一 tag 产出全部发布物，独立安装包与 CLI/TUI 保持不变。

## Consequences

- **用户：** 安装从“解压、复制 Skill、改配置、手动启动”变为一条安装命令；任何目录、任何会话均可使用；多个 Agent 共享同一身份与节点数据。
- **安全：** 工具参数不再经过 shell；本插件工具全部自动放行，由来源规则、不可信信封与 daemon 兜底防护；宿主自身的命令、文件与网络工具权限不受影响。
- **维护：** Agent 内容从多份副本变为 `agent/` 一份源；新增 `internal/mcp`、`scripts/genplugins`、启动器、三个外壳与 TypeScript 的 DSH 外壳（只在 `plugins/dsh/` 内）。旧的持久宿主实验及其决策记录、宿主脚本、入站提示词与宿主配置模板已删除。
- **发布：** 新增两个 marketplace 外壳、DSH npm 包与另行上传的平台二进制；取消 Skill 压缩包；同一 tag 产出全部发布物。
- **不变：** P2P 网络、身份、存储、内容、聊天协议、`spec/`、数据目录结构、CLI/TUI、Node-first 原则。
- **风险与未验证：** Windows（含 `sh`/PowerShell 启动器）NOT_TESTED，暂不作为第一版出口；未签名二进制的 Gatekeeper/SmartScreen 与防火墙首次监听提示未完全验证；Codex 环境变量与审批限制不可绕过；首次二进制下载可能超过宿主 30 秒握手；M6-R 等真实网络测试仍 NOT_TESTED。
- **状态：** ADR 保持 Proposed；发布并完成真实安装后再定。第一版尚未完成：发布流水线与预发布真实安装冒烟未做。

实现状态与验收边界见 [agent-skill.md](../agent-skill.md)。
