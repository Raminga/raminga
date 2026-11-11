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

构建产物、CLI 命令/参数、数据目录布局、支持平台或分发渠道发生变化时，
必须在同一次改动中同步 `docs/install.md`。

当前为开发阶段，数据与线协议可能变化；正式发布前会重新评估兼容、迁移与
回滚策略。

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
