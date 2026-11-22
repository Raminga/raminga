# Raminga 文档

最新预发布版是 [v0.1.0-rc.3 预发布版](https://github.com/Raminga/raminga/releases/tag/v0.1.0-rc.3)。选择 [DSH 图形界面](quick-start.md#在-dsh-中完成第一次聊天)或[独立终端](quick-start.md#在独立终端中完成第一次聊天)，完成一次连接和双向聊天。

## 使用者

- [双节点快速开始](quick-start.md) · 安装、交换节点地址、连接和双向聊天。
- [用户手册](user-guide.md) · 联系人、投递状态、离线、公开内容、Agent 参与、备份和排错。
- [安装与构建](install.md) · 各平台归档、校验、DSH/Claude Code/Codex 插件和升级。
- [产品愿景](vision.md) · [功能与设计清单](features.md) · [当前交付范围](mvp.md)

## 节点运维

- [节点生命周期与数据目录](node.md) · [后台运行与日志](install.md#5-后台运行与日志) · [防火墙与端口](install.md#6-防火墙--端口)
- [DHT 配置与诊断](dht.md) · [公网测试指南](public-test-guide.md) · [Docker 网络实验室](manual-lab.md)
- [安全与授权](security.md) · [公开内容](public-content.md) · [档案与访问语义](profile.md)

## 开发与 Agent 接入

- [贡献指南](../CONTRIBUTING.md) · [开发原则](development-principles.md) · [测试与验收](testing.md)
- [架构](architecture.md) · [跨节点协议](protocol.md) · [聊天 wire 契约](../spec/chat-http-v1.md) · [本地 API 定义](../api/)
- [Agent 插件与工具](agent-skill.md) · [DSH 工作区布局与接入约定](dsh-workspace-ui.md) · [P5 验收报告](../reports/p5-acceptance-2026-11-18.md)
- 架构决策 · [Node-first](adr/0001-node-first.md) · [开放网络](adr/0002-open-interoperability.md) · [Go/libp2p daemon](adr/0003-go-libp2p-node-daemon.md) · [内联 TUI](adr/0004-inline-tui.md) · [Agent 插件分发](adr/0006-agent-plugin-distribution.md)
- 供应链 · [漏洞处置](supply-chain/vuln-disposition.md) · [许可证清单](supply-chain/license-allowlist.txt)

实现与设计状态以各页标注为准。跨节点 wire 以 [spec/](../spec/) 为准，本地 API 以 [api/](../api/) 的 Protobuf 定义为准。测试证据默认保存在本地 `tests/e2e/evidence/`。
