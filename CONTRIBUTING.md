# 贡献指南

Raminga 是一个去中心化、以节点为基础的 P2P 社交网络。每个节点独立运行；
AI 宠物、DSH 和托管服务都是可选项，不是节点的运行前提。本文面向修改代码、
文档或插件的人类贡献者。

## 工程规则

- **成熟开源优先。** 实现基础设施前，先检查 Go 1.27 / go-libp2p 的公开 API
  和维护良好的开源替代方案。Node.js 24 只用于 DSH 插件（`plugins/dsh/`，
  使用自己的 package.json）。已有等价实现时优先替换自研的通用基础设施，
  只保留范围很窄的 Raminga 协议与业务策略。
- **尊重公开导出与所有权。** 不深度导入内部包，不使用不受支持的传输字段，
  不创建相互竞争的 PeerStore 或状态来源。
- **远端数据不可信。** Peer ID 认证不等于授权。Relay provider 默认关闭；
  不静默启用 UPnP，也不静默启用 DSH 工具。
- **如实描述实现状态。** 不把脚手架、计划中的功能、Docker 模拟或一次
  DCUtR attempt 说成真实可用的功能。

## 技术栈与契约

- **节点：** Go 1.27 + go-libp2p，包含节点、CLI、网络与测试 harness。
  旧的 TypeScript 节点和 npm workspace 已退役，不在本仓库中。
- **跨节点 wire：** HTTP over libp2p streams（`net/http` + `gostream`，
  `/raminga/http/1.0.0`），请求体为 JSON；契约与测试向量在 `spec/`。
- **本地 API：** Connect-RPC（connect-go）over Unix domain socket
  （`api/*.proto`，server-streaming 事件，token 0600，不监听网络端口）。
- **业务存储：** SQLite + 纯 Go 驱动（`CGO_ENABLED=0`），另有一个小型
  PeerStore 缓存；go-libp2p PeerStore 运行时只保存在内存中。

## 开发与验证

```sh
make check             # vet/lint/buf lint/单测/fuzz 种子/生成物一致性
make e2e               # G1 + G2 + G3 的 Docker 测试
make e2e-plugins       # 插件外壳 MCP 冒烟
make genplugins-check  # 校验 agent/ 渲染出的插件文件没有漂移
```

其他目标见 `Makefile`。测试结果必须按 **PASS / FAIL / BLOCKED /
NOT_TESTED** 如实记录；未运行的测试不要写成通过。Docker 与本地结果不能
替代真实公网/NAT 验证。改动 `agent/` 后运行 `go run ./scripts/genplugins -root .`；改动 `plugins/dsh/` 后在该目录运行 `npm run build`。

`plugins/dsh` 的 `optionalDependencies` 精确指向同版本的平台子包。本地安装
依赖时使用 `npm install --no-package-lock --omit=optional`（发布脚本也这样
做），不要用 `npm ci`；平台子包在首次发布前不在 registry 上。

构建产物、CLI 命令/参数、数据目录布局、支持平台或分发渠道发生变化时，
必须在同一次改动中同步 `docs/install.md`。

当前为开发阶段，数据与线协议可能变化；正式发布前会重新评估兼容、迁移与
回滚策略。

## 发布

发布以仓库根 `VERSION` 为唯一版本来源；一个 tag 同时产出 GitHub Release、npm 包和 marketplace 仓库。不要在本机直接发布。

1. 修改 `VERSION`（例如 `0.1.0-rc.1`）。预发布使用 `-rc.N` 后缀；正式版不带后缀。
2. 运行 `make genplugins`，它会更新启动器、Claude/Codex 清单、marketplace 清单、`plugins/dsh/package.json` 的版本与平台子包依赖，以及 `cmd/raminga` 的默认版本。提交前运行 `make genplugins-check` 确认没有漂移。
3. 如果 `plugins/dsh/` 的 TypeScript 源码有改动，进入该目录运行 `npm run build` 并提交 `lib/`。
4. 本地验证：`make check`、`cd plugins/dsh && npm test`、`make e2e-plugins`，以及 `make release-dry-run`。dry-run 不发布任何东西。
5. 提交改动后打 tag：`git tag "v$(cat VERSION)"`，推送提交和 tag。工作流会校验 tag 必须等于 `v` + `VERSION`，不一致直接失败。

tag 推送后 `.github/workflows/release.yml` 依次：

- 运行 `make check` 与版本校验；
- 用 GoReleaser v2.19.0 创建 GitHub Release（6 平台归档、裸二进制、`SHA256SUMS`）；`-rc.N` 等预发布 tag 标为 prerelease；
- 构建并发布 6 个 `@raminga/bin-<os>-<cpu>` 平台子包，再发布 `@raminga/dsh`；预发布用 npm dist-tag `next`，正式版用 `latest`，同版本已存在时失败；
- 用 SSH deploy key 把 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`、`plugins/claude/`、`plugins/codex/`、`LICENSE` 和 README 同步到 `Raminga/raminga-plugins`，并打同名 tag。首次推送和空仓库由脚本处理。

工作流需要的 secrets：

| 名称 | 用途 |
| --- | --- |
| `NPM_TOKEN` | 发布到 npm 组织 `raminga`；需要该组织的写权限 |
| `PLUGINS_DEPLOY_KEY` | `Raminga/raminga-plugins` 的 SSH deploy key（可写） |
| `GITHUB_TOKEN` | GitHub 自动提供，用于创建 Release；工作流声明 `contents: write` |

npm 发布启用 `--provenance`，因此 npm job 需要 `id-token: write`。`workflow_dispatch` 只构建和打包（GoReleaser snapshot、`npm publish --dry-run`、不推送 marketplace），用于验证流水线。

## 文档

- 文档索引：[`docs/README.md`](docs/README.md)
- 工程原则：[`docs/development-principles.md`](docs/development-principles.md)
- 架构与技术栈：[`docs/architecture.md`](docs/architecture.md)
- 功能范围与状态：[`docs/features.md`](docs/features.md)
- 安全边界：[`docs/security.md`](docs/security.md)
- 测试方法、阈值与证据：[`docs/testing.md`](docs/testing.md)
- 安装、构建与 CLI：[`docs/install.md`](docs/install.md)

架构取舍记录在 [`docs/adr/`](docs/adr/)；接口或决策变化时同步更新相应
文档与 ADR，不维护第二套重复规范。
