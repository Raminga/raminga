# Raminga 文档索引

> **当前状态（2026-11-12）：** Go 节点已实现并通过 G1–G4.5.1 的本地/Docker 验收；G6 已删除退役的 TypeScript 节点与旧 M1–M5/Phase 文档。G5 的 Claude/Codex/DSH 插件外壳已实现并做过部分真实宿主验证，发布流水线已实现，尚未首发；签名和预发布安装冒烟尚未完成。真实公网 M6-D 在 IPv6 有状态防火墙场景 **PASS** 一次；IPv4 NAT 打洞、M6-R 与第三方 wire 互操作仍 **NOT_TESTED**。技术选型：HTTP + JSON over libp2p（`spec/`）、Connect-RPC over UDS（`api/*.proto`）、纯 Go SQLite（`raminga.db`）、内存 PeerStore + SQLite 少量缓存。

**测试入口：** `make check`；`make e2e` 依次运行 G1+G2+G3；`make e2e-g1` / `make e2e-g2` / `make e2e-g3` 可单独运行。G4 为独立安全/稳定性套件：`make e2e-g4`、`make soak`（30 分钟双 NAT QUIC）、`make fuzz`、`make vuln`、`make licenses`。G4.5/G4.5.1 增加单屏 slash-command `raminga tui`、本地名字别名、报告导出、`make interactive-tui-test`（真实 pty）、`make dist`/`dist-verify`、`make platform-smoke` 与 `make tui-lab-verify LAB=<五个 lab>`。测试方法、阈值与证据约定见 [testing.md](testing.md)。

本目录保存长期有效、版本化的项目知识。

| 任务 | 权威文档 |
| --- | --- |
| 安装、构建、PATH 与首次运行 | [install.md](install.md) |
| 产品边界与非目标 | [vision.md](vision.md) |
| 当前架构、目标网络、技术栈与模块边界 | [architecture.md](architecture.md) |
| **长期工程规则：成熟开源优先、少自研、安全与验收** | **[development-principles.md](development-principles.md)** |
| **第一版三步路线**、全部预期功能、设计要点与当前状态（总表） | [功能与设计清单](features.md) |
| Node 生命周期、身份与操作者关系 | [node.md](node.md) |
| 对内/对外档案与访问语义 | [profile.md](profile.md) |
| 当前跨节点协议与向量 | [protocol.md](protocol.md) · [契约](../spec/chat-http-v1.md) |
| 信任边界、加密与授权 | [security.md](security.md) |
| 测试等级、G4 阈值摘要与验收矩阵 | [testing.md](testing.md) |
| 当前交付范围 | [mvp.md](mvp.md) |
| **DSH 主工作区 UI：已确认布局、真实数据语义、daemon 能力与缺口、分阶段验收** | **[布局与接入约定](dsh-workspace-ui.md)** |
| **公网测试包：`init` 参数、TUI/CLI 走查、Relay/Bootstrap 要求、报告提交、清理（中文）** | **[公网测试指南](public-test-guide.md)** |
| **手动 Docker 实验室：五个拓扑（lan/onesided/symmetric/dualnat/ipv6fw）的亲自操作、cheat sheet、预期输出与 PASS/FAIL 验证** | **[手动 Docker 实验室](manual-lab.md)** |
| **Raminga Agent 插件化：单一来源 `agent/`、工具目录、`raminga mcp` 核心二进制与各宿主插件外壳** | **[agent-skill.md](agent-skill.md)** · [插件分发 ADR](adr/0006-agent-plugin-distribution.md) |
| 漏洞处置与许可证 allowlist | [漏洞处置](supply-chain/vuln-disposition.md) · [许可证 allowlist](supply-chain/license-allowlist.txt) |
| 长期架构决策 | [ADR-0001 Node-first](adr/0001-node-first.md)、[ADR-0002 开放网络](adr/0002-open-interoperability.md)、[ADR-0003 go-libp2p daemon](adr/0003-go-libp2p-node-daemon.md)、[ADR-0004 非全屏 TUI](adr/0004-inline-tui.md)、[ADR-0006 Agent 插件分发](adr/0006-agent-plugin-distribution.md) |

Go 模块的公共 API、端口与依赖方向由各 `internal/` 包和 [architecture.md](architecture.md) 描述。跨节点 wire 以 `spec/` 为权威；本地 API 以 `api/*.proto`（Connect-RPC over UDS）为权威。真实发布前复审兼容与迁移。

**状态规则**：设计使用 Proposed（待确定）、Accepted（已采纳）、Superseded（被取代）；验收使用 PASS / FAIL / BLOCKED / NOT_TESTED。架构中的目标能力不得当作已实现。修改接口时同步更新测试和受影响的文档；不要维护第二套重复的 docs/contracts。

临时本地工作记录存放 `.local/`，不提交 Git。测试证据默认输出到 `tests/e2e/evidence/`，该目录不提交证据。参与开发见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
