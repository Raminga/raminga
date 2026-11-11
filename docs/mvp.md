# MVP 与里程碑

Status: Accepted (scope); **Go G1–G4.5.1 implemented and local/Docker accepted; G6 TS retirement done; G5 release pipeline and broader real-network validation pending**.

## v0.1 产品闭环

两台独立设备运行各自的 Raminga Node；发现或通过邀请建立连接；经授权查看对方的允许公开档案；各自发布并交换最小社交内容；本地数据可恢复；第三方 Agent 可以通过受控节点操作接口参与但不是必需。

不要求内置 Agent、AI 宠物、推荐广场、订阅服务、移动端、多设备并发合并。v0.1 优先验证两个官方节点；第三方完全独立实现的互操作验收是明确的**后续开放协议里程碑**，不阻塞最初网络 PoC。

## 实施阶段

| 阶段 | 交付及验收 |
| --- | --- |
| A 架构与工程骨架 | Node-first 模块、文档、CLI 状态、边界校验与 CI |
| B 网络 PoC | 持久 Peer ID、直连消息；实测局域网和跨公网；可选中继 |
| C 身份与档案 | 身份验证、授权访问、Profile 公私视图、撤销负向测试 |
| D 社交与持久化 | 发布、关系、最小事件同步、重启恢复和去重 |
| E 节点操作接口 | 外部 Agent/CLI 可通过正式授权接口操作；不依赖 AI 运行时 |
| F 可靠性与试用 | 断线恢复、安全和 E2E 测试、小规模真实用户验证 |
| G 开放互操作 | 规范冻结并公开可执行测试向量；至少一个不依赖官方核心包的独立节点实现与官方节点互通，验证非官方引导/已知地址接入 |

## 阶段 B 的当前工作计划：Go 节点（G1–G6）

> 功能范围与当前状态见 [features.md](features.md)，测试方法与阈值见 [testing.md](testing.md)。历史 TS 实现与旧验收记录已随 G6 删除。

| 子阶段 | 核心交付 | 状态 |
| --- | --- | --- |
| G1 | Go 骨架、身份/存储、本地 API、CLI、LAN 聊天 | **PASS（local + Docker）** |
| G2 | go-libp2p、TCP/QUIC、Relay v2、DCUtR、DHT、AutoNAT、PeerStore | **PASS（Docker；TCP direct 通常 BLOCKED）** |
| G3/G3.1 | IPv6/防火墙/单侧/协议封锁/netem/对称 NAT/双 NAT、五个 lab | **PASS（Docker）** |
| G4 | 安全/稳定性、outbox、soak、fuzz/vuln/licenses | **PASS（Docker）** |
| G4.5/G4.5.1 | TUI、报告、6 平台 dist、平台冒烟、TUI-first labs | **PASS（local + Docker）** |
| G6 | 退役 TS 实现/旧脚本/历史文档 | **PASS（2026-11-01）** |
| G5 | DSH 插件与分发 | **NOT_STARTED** |
| M6 | 真实公网 M6-R/M6-D | **PARTIAL**：M6-D IPv6 有状态防火墙 PASS ×1；IPv4 NAT 与 M6-R **NOT_TESTED**（真实设备手工测试） |

真实公网 M6 需要两台异地设备和真实公网 Relay；当前环境不满足，不能用 Docker 代替。

## 从封闭原型到开放网络的验收边界

- 阶段 B 的同一实现间联网测试证明传输 PoC，不证明第三方兼容。
- 阶段 E 的第三方客户端/Agent 使用官方 Node API，不等于第三方独立实现了 Raminga 网络节点。
- 阶段 G 才验证开放协议的跨实现互操作；不要求特定编程语言，但必须不依赖 Raminga 官方核心实现。
- 网络不使用强制官方注册/许可才能加入，节点可以自设信任/访问策略。对公网不可达、需要中继或离线等情况，如实记录。

## 记录要求

每个阶段必须区分：已实现、已自动测试、已人工测试、未验证。跨公网及 NAT 测试不能被同机双进程测试取代。未有实测日志前不声称已完成。
