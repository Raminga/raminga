# Raminga

**Decentralized, node-first P2P social network.**

Raminga 以独立 **Raminga Node** 为基础单位。节点可以发布内容、维护关系并提供结构化档案；获得授权的客户端或 AI Agent 可以操作节点，但 AI、DSH 和内置智能体都不是节点运行的前提。长期目标是开放、可独立实现的网络协议。

> **当前状态（2026-11-12）：** Go 节点已实现并通过 G1–G4.5.1 的本地/Docker 验收；G6 已删除退役的 TypeScript 节点、Node workspace、旧脚本/测试、PoC 与历史 M1–M5/Phase 文档。G5 的 Claude/Codex/DSH 插件外壳已实现并做过部分真实宿主验证，发布流水线、签名和预发布安装冒烟尚未完成。真实公网 M6-D 在 IPv6 有状态防火墙场景 **PASS** 一次；IPv4 NAT 打洞与 M6-R 计数仍 **NOT_TESTED**（Docker 不等于公网）；TCP 双 NAT direct 通常 BLOCKED（Docker 偶见 simultaneous-open，非确定性）。

## 快速开始

取得对应平台的归档（根目录自带 `install.sh` / `install.ps1`）：

```sh
tar xzf raminga_<os>_<arch>.tar.gz
cd raminga_<os>_<arch>
sh ./install.sh
raminga
```

Windows PowerShell：

```powershell
Expand-Archive -Path .\raminga_<os>_<arch>.zip -DestinationPath .\raminga-dist
cd .\raminga-dist\raminga_<os>_<arch>
powershell -ExecutionPolicy Bypass -File .\install.ps1
raminga
```

不带子命令的 `raminga` 在终端里会确保该数据目录的 daemon 在后台运行，然后打开 TUI；在管道里只打印帮助。停止、重启、升级：

```sh
raminga stop
raminga restart          # 切换到刚安装的新版本
```

systemd 服务器用 `sudo ./install.sh --service`；由 systemd 管理时请用 `sudo systemctl stop|restart raminga`，CLI 会拒绝直接操作。自动启动的日志在 `<data-dir>/daemon.log`（0600，超过 10 MiB 轮转）。

默认数据目录是 `$RAMINGA_DATA_DIR`，否则 `~/.raminga`；`--data-dir` 仍可覆盖。完整的平台选择、校验、`--prefix`、服务安装、自定义数据目录迁移、源码构建与故障排查见 [docs/install.md](docs/install.md)。

## 开始开发

要求 Go 1.27。`go.mod` 在仓库根（module `github.com/Raminga/raminga`）。

```sh
make check      # vet/lint/buf lint/单测/fuzz 种子
make test       # 单测/集成
make e2e-g1     # G1 Docker：LAN 直连聊天/重启/单实例/API 边界
make e2e-g2     # G2 Docker：双 NAT QUIC direct/Relay 故障切换/DHT/配额/单侧/PeerStore
make e2e-g3     # G3：Go Docker e2e（IPv6/单侧/协议封锁/netem/对称 NAT/双 NAT/ipv6fw）
make e2e        # G1 + G2 + G3
make e2e-g4     # G4 安全/稳定性
make lab-up LAB=dualnat   # 手动 lab；详见 docs/manual-lab.md
make interactive-tui-test # 真实 pty 驱动 TUI
```

`raminga tui` 是单屏 slash-command 测试面板，只通过本地 UDS Connect API 操作 daemon；TUI 退出不停止节点。节点不要求 Go/Node 环境变量；Docker 只是受控模拟。

## 架构

| 路径 | 边界 |
| --- | --- |
| `cmd/raminga/` | daemon + CLI 入口 |
| `internal/{identity,storage,network,protocol,node,profile,social,api,config,tui}/` | 模块化单体；`node` 编排，`network` 持有 go-libp2p |
| `api/` | 本地 API 的 `.proto`（语言中立，buf 管理） |
| `spec/` | 跨节点 wire 的 `.proto` 与语言无关测试向量 |
| `tests/e2e/` | Go e2e runner、手动 lab 与默认证据输出目录（不提交证据） |
| `plugins/dsh/` | TypeScript DSH 薄插件（connect-es，own package.json） |

**进程模型：** `raminga daemon` 是节点状态唯一来源；不带子命令的 `raminga` 只负责确保 daemon 已运行并打开 TUI，`raminga stop/restart` 通过本地 `Shutdown` RPC 生命周期，`raminga chat/status/...` 与 TUI 都是本地 API 客户端；测试 harness 通过同一 API 驱动 daemon，不直接打开 go-libp2p 或复制 PeerStore。

**本地 API：** Connect-RPC（connect-go）over Unix domain socket，`api/*.proto` 由 `buf` 管理；token + 0600；server-streaming 事件；测试专用操作在显式 flag 后且默认关闭；**不监听网络端口**。

**数据目录：** `identity/`（libp2p protobuf Ed25519）、`raminga.db`（SQLite，纯 Go 驱动；业务数据 + bootstrap cache/known peers/pinned relays/peer names）、`config.toml`、本地 API socket/token（0600）。PeerStore 运行时在内存，重启后经 DHT 重新发现。

**分发（G5，发布流水线未完成）：** 单静态二进制（`CGO_ENABLED=0`）覆盖 darwin/linux/windows 的 arm64/amd64；DSH 插件经 npm `optionalDependencies` 携带平台二进制。安装与插件说明见 [docs/install.md](docs/install.md)。

## 协议与第三方接入（目标能力）

- **本地 API：** UDS + Connect-RPC + `api/*.proto`；第三方客户端无需导入 TypeScript 包。
- **跨节点 wire：** HTTP over libp2p `/raminga/http/1.0.0`，`POST /chat` JSON；契约与向量见 [`spec/chat-http-v1.md`](spec/chat-http-v1.md) 与 [`spec/chat-http-v1-vectors.json`](spec/chat-http-v1-vectors.json)。
- **无需官方准入：** 符合协议的节点不应被要求注册官方账号、申请官方 API Key、使用唯一官方引导节点或取得运营商批准。各节点自主决定连接、限流、可见性及授权。
- **仍处于 Experimental 阶段：** Relay、DCUtR 与恢复的主要证据来自 Docker 受控测试；真实公网只有一次 IPv6 有状态防火墙打洞证据，IPv4 NAT、Raminga DHT 的公网行为、正式 E2EE/授权尚未验收。M6-R 与 IPv4 NAT M6-D 保持 NOT_TESTED，不能用 Docker 结果冒充公网 PASS。

## 文档与开发

从 [文档索引](docs/README.md) 按需查阅；参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本地开发笔记可存于忽略提交的 `.local/`；节点运行数据位于 `.raminga/`。测试结果按 PASS/FAIL/BLOCKED/NOT_TESTED 如实记录，证据默认写到忽略提交的 `tests/e2e/evidence/`。

## License

[Apache-2.0](LICENSE)。
