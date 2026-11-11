# Raminga 安装与构建指南

Status: Current (2026-11-11) · Go 1.27 · 未签名 snapshot。本文所有命令以本仓库当前 Makefile、`.goreleaser.yaml` 和 CLI `--help` 为准。

> **迁移先于第一次运行（最容易搞错的一步）：** 如果旧节点的数据目录不是 `~/.raminga`，必须在第一次运行新版 `raminga` 之前，把**整个旧目录**移到 `~/.raminga`。新版一旦先在默认目录启动，就会生成新的 `identity/key` 和 `raminga.db`；此时再 `mv 旧目录 ~/.raminga`，旧目录会被移到 `~/.raminga/<旧目录名>` 里面，默认目录仍由新身份运行。2026-11-06 实际发生过（旧节点在 `~/.raminga/raminga-test`）。完整检查、正确顺序和恢复步骤见 [§4 迁移](#从自定义数据目录迁移到默认目录第一次运行前)。

## 0. 最短路径

下载/取得对应平台的归档和同目录的 `SHA256SUMS`，解压后运行归档里的安装脚本，然后直接输入 `raminga`：

### macOS / Linux

```sh
tar xzf raminga_<os>_<arch>.tar.gz
cd raminga_<os>_<arch>
sh ./install.sh
```

```sh
raminga
```

### Windows PowerShell

```powershell
Expand-Archive -Path .\raminga_<os>_<arch>.zip -DestinationPath .\raminga-dist
cd .\raminga-dist\raminga_<os>_<arch>
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

打开**新的**终端后：

```powershell
raminga
```

`raminga` 不带子命令时，如果 stdin 和 stdout 都是终端，会确保该数据目录的 daemon 已运行，然后打开 TUI；不是终端时只打印帮助。默认数据目录是 `$RAMINGA_DATA_DIR`，否则 `~/.raminga`；`--data-dir` 仍可覆盖。

停止、重启：

```sh
raminga stop
raminga restart
```

`stop` 在节点本来没运行时也返回 0 并打印 `节点未运行`。`restart` 会先停掉旧进程，再用当前二进制启动，并打印新版本。

自动启动的 daemon 日志在 `<data-dir>/daemon.log`（0600）；超过 10 MiB 时，下次启动先轮转为 `daemon.log.1`。前台 `raminga daemon` 仍把日志写到终端。

升级：重新解压新归档、再运行一次安装脚本，然后：

```sh
raminga restart
```

如果旧数据目录不是默认的 `~/.raminga`，**先按 [§4 迁移](#从自定义数据目录迁移到默认目录第一次运行前) 移动目录，再第一次运行新版**；不要先运行新版让它生成新身份。

服务器（systemd，仅 Linux root）：

```sh
./raminga init --relay-provider --announce /ip4/<公网IPv4>/tcp/4001 --announce /ip4/<公网IPv4>/udp/4001/quic-v1
sudo ./install.sh --service
```

以后升级服务器：解压新归档后再次 `sudo ./install.sh --service`（已有 unit 会 `systemctl restart raminga`）。`--service` 默认使用 `$SUDO_USER` 的 `~/.raminga`；自定义数据目录用 `--data-dir` 传入。只有 `--service` 会写 systemd，脚本不会改防火墙。

macOS 睡眠**不会**被阻止；需要保持在线时仍可用前台 `caffeinate -i raminga daemon`。本项目没有 curl 一行安装、Homebrew、apt、scoop 或 winget 渠道，安装脚本就在归档里。

## 1. 识别系统与架构

| 平台 | 命令 |
| --- | --- |
| macOS / Linux | `uname -sm` |
| Windows PowerShell | `$env:PROCESSOR_ARCHITECTURE` |

映射：

- `x86_64` / `AMD64` → **amd64**
- `arm64` / `aarch64` / `ARM64` → **arm64**
- Apple Silicon 是 **arm64**（不是 amd64）。

归档名来自 `.goreleaser.yaml`，**不含版本号**；版本在二进制里，用 `raminga version` 查看：

```text
raminga_<os>_<arch>.tar.gz      # darwin/linux 归档
raminga_<os>_<arch>.zip         # windows 归档
raminga_<os>_<arch>             # darwin/linux 裸二进制（插件启动器下载）
raminga_windows_<arch>.exe      # windows 裸二进制（插件启动器下载）
```

例如：

```text
raminga_darwin_arm64.tar.gz
raminga_linux_amd64.tar.gz
raminga_windows_amd64.zip
```

每个归档自带同名外层目录；解压后进入 `raminga_<os>_<arch>/`，里面有 `raminga`（Windows 为 `raminga.exe`）、`install.sh`、`install.ps1`、`LICENSE`、`README.md`。校验文件是发布目录里的 `SHA256SUMS`。

## 2. 安装预编译包

先取得归档与同目录的 `SHA256SUMS`（例如 `make dist` 的 `dist/`，或别人连同校验文件一起发给你）。校验时把归档与 `SHA256SUMS` 放在同一目录，或按下面的方式只校验归档本身。

### macOS / Linux

```sh
tar xzf raminga_<os>_<arch>.tar.gz
cd raminga_<os>_<arch>
```

```sh
shasum -a 256 ../raminga_<os>_<arch>.tar.gz   # macOS
sha256sum ../raminga_<os>_<arch>.tar.gz       # Linux
```

对照 `SHA256SUMS`。然后运行安装脚本：

```sh
sh ./install.sh
```

脚本会：

- 非 root 默认安装到 `~/.local/bin/raminga`，root 默认安装到 `/usr/local/bin/raminga`；
- `--prefix DIR` 覆盖目标目录；
- 创建目录并原子替换（先写临时文件再 `mv`）；
- macOS 上尽力删除 `com.apple.quarantine`；
- 打印已安装版本；如果旧节点在运行，提示 `运行 raminga restart 切换到新版本`；
- 目标目录不在 `PATH` 时，把下面一行连同来源注释追加到 shell 配置，重复运行不会重复写入：zsh 写 `~/.zshrc`（或 `$ZDOTDIR/.zshrc`），bash 写 `~/.bashrc`，macOS 的 bash 写 `~/.bash_profile`；
- 如果 `PATH` 里有另一个 `raminga` 排在前面，打印警告，显示它的路径和版本。

```sh
export PATH="$HOME/.local/bin:$PATH"
```

脚本改不了当前终端的 `PATH`，所以写入后会打印要运行的 `source` 命令，新开的终端则自动生效。用 `--prefix` 时写入的是对应目录，所以往临时目录安装时要加 `--no-modify-path`。

以下情况不写配置，只打印上面这一行，由你手动加入：`--no-modify-path`、root 安装、`--service`、无法识别 shell，或配置文件不可写。

如果看到“会先找到 …”的警告，说明运行 `raminga` 时还是旧版：删除或替换旧版，或调整 `PATH` 顺序，然后用 `command -v raminga` 和 `raminga version` 确认。

macOS 若仍被 Gatekeeper 拦截：右键 `raminga` → 属性 → 勾选“解除锁定”，或“更多信息 → 仍要运行”。项目**未做 Authenticode/公证**，安装脚本只能尽力清 quarantine。

手动安装（与脚本等价，路径按需改）：

```sh
mkdir -p "$HOME/.local/bin" && install -m 0755 ./raminga "$HOME/.local/bin/raminga"
```

```sh
sudo install -m 0755 ./raminga /usr/local/bin/raminga
```

Linux 服务器从本机上传：

```sh
scp -i key.pem raminga_<os>_<arch>.tar.gz user@server:/tmp/
ssh -i key.pem user@server 'tar xzf /tmp/raminga_<os>_<arch>.tar.gz -C /tmp && sudo /tmp/raminga_<os>_<arch>/install.sh'
```

### Windows PowerShell

```powershell
Expand-Archive -Path .\raminga_<os>_<arch>.zip -DestinationPath .\raminga-dist
cd .\raminga-dist\raminga_<os>_<arch>
```

```powershell
Get-FileHash .\raminga_<os>_<arch>.zip -Algorithm SHA256
```

对照 `SHA256SUMS` 中对应行的哈希（不区分大小写）。

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 会复制到 `$env:LOCALAPPDATA\Programs\Raminga`，`Unblock-File`，在需要时把该目录加入**用户** PATH（不改机器 PATH），并提示打开新终端。正在运行的 `raminga.exe` 不能覆盖，所以脚本先把旧文件改名为 `raminga.exe.old`，再复制新文件；下次运行会先清理旧的 `.old`。装完同样会打印版本，并在旧节点运行时提示 `运行 raminga restart 切换到新版本`。

SmartScreen 若拦截：右键 `raminga.exe` → 属性 → 勾选“解除锁定” → 确定；或“更多信息 → 仍要运行”。

### systemd 服务安装（Linux，root）

```sh
sudo ./install.sh --service
```

要求 Linux + systemd + root。脚本会：

- 安装到 `/usr/local/bin/raminga`；
- 用 `$SUDO_USER` 作为服务用户；直接以 root 运行时必须用 `--user NAME` 指定用户；
- 写 `/etc/systemd/system/raminga.service`，`ExecStart=/usr/local/bin/raminga daemon --data-dir <用户主目录>/.raminga`，`Restart=on-failure`；
- `systemctl daemon-reload`，新 unit 用 `enable --now`，已存在的 unit 用 `restart`；
- 自定义数据目录通过 `--data-dir DIR` 传入。

`--service` 和 `--prefix` 不能同时使用（服务固定 `/usr/local/bin`）。脚本不修改防火墙；公网 Relay/Bootstrap 的端口放行见 §6。

手工 unit（不使用脚本时）等价内容：

```ini
[Unit]
Description=Raminga node
Wants=network-online.target
After=network-online.target

[Service]
User=youruser
ExecStart=/usr/local/bin/raminga daemon --data-dir /home/youruser/.raminga
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now raminga
journalctl -u raminga -f
```

由 systemd 启动的 daemon 会在 `StatusResponse.supervised` 中报告 `true`。此时 `raminga stop` / `raminga restart` 会拒绝并提示：

```text
节点由 systemd 管理；请用 sudo systemctl stop|restart raminga
```

这是为了避免命令行再启动一个不受 systemd 管理的第二个节点。请用 `sudo systemctl stop raminga` / `sudo systemctl restart raminga`。

## 3. 从源码构建

前置：Go 1.27.x、git；macOS/Linux 还需 `make`。Windows 没有 make 时用下面的 `go build`。

```sh
git clone https://github.com/Raminga/raminga.git
cd raminga
make build
```

产物是 `bin/raminga`（`CGO_ENABLED=0`）。直接 `go build` 时，如果未通过 `-ldflags -X main.version` 指定版本，`raminga version` 会自动附加当前 git 短提交号（工作区有未提交改动时再加 `-dirty`），便于区分协议不同的构建。

```sh
make install                 # 构建后调用 scripts/install.sh
make install PREFIX=/tmp/bin # 指定安装目录
```

等价的手工构建：

```sh
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o raminga ./cmd/raminga
```

Windows PowerShell：

```powershell
$env:CGO_ENABLED="0"
go build -trimpath -ldflags "-s -w" -o raminga.exe .\cmd\raminga
```

快速运行不落盘：

```sh
go run ./cmd/raminga --help
```

### 交叉编译

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/raminga-linux-amd64 ./cmd/raminga
make cross
```

`make cross` 输出到 `.local/cross/<os>-<arch>/raminga`。

### 发布归档

```sh
make dist
make dist-verify
```

`make dist` 生成 `dist/raminga_<os>_<arch>.tar.gz|.zip` 与 `dist/SHA256SUMS`；归档根目录含 `raminga`、`install.sh`、`install.ps1`、`LICENSE`、`README.md`，并自带同名外层目录。发布时还会上传启动器使用的裸二进制 `raminga_<os>_<arch>`（Windows 为 `.exe`），并同样列入 `SHA256SUMS`。GoReleaser snapshot 的裸二进制源文件位于 `dist/<target>/`，`SHA256SUMS` 记录的是发布资产名。`dist-verify` 会校验归档，并把 `SHA256SUMS` 中的裸二进制发布名链接到 `dist/<target>/` 的构建文件后一并校验，因此 snapshot 目录也能通过。

`make dist-check` 用同样的 `release --snapshot` 流程，但把 `dist` 指向临时目录并使用仓库内 `.local/` 缓存，不会写 `dist/`。

## 4. 第一次运行

以下命令假定 `raminga` 已在 PATH；原地运行请把 `raminga` 换成 `./raminga`（Windows 为 `.\raminga.exe`）。

数据目录默认 `$RAMINGA_DATA_DIR`，否则 `~/.raminga`；`--data-dir` 可覆盖。日常只输入：

```sh
raminga
```

它会自动启动该数据目录的 daemon（后台、脱离终端、stdin 接空设备、stdout/stderr 追加到 `<data-dir>/daemon.log`），等到本地 API 可用后打开 TUI。启动期间只打印一次 `正在启动节点…`；15 秒内没有起来会显示日志末尾和日志路径，并以非零退出。并发启动由数据目录锁裁决：一个 daemon 获胜，另一个只是连接到它。

仍可显式初始化、前台运行、单独打开 TUI：

```sh
raminga init --data-dir "$HOME/.raminga"
raminga daemon --data-dir "$HOME/.raminga"
raminga tui --data-dir "$HOME/.raminga"
```

`raminga tui` 保持旧行为：它不会自动启动节点；节点没运行时会提示 `节点未运行`。`raminga daemon` 是前台进程，适合服务器和调试，日志仍在终端。

查看状态、停止、重启：

```sh
raminga status --data-dir "$HOME/.raminga"
raminga stop --data-dir "$HOME/.raminga"
raminga restart --data-dir "$HOME/.raminga"
```

### MCP（插件接入）

各宿主 Agent 外壳按需拉起同一个 `raminga mcp` 子命令，在 stdio 上暴露本地节点工具（状态、好友、公开内容、远端档案/manifest、连接、发消息、消息历史，以及私有 Agent 初始化 `raminga_agent_init`）。它只是 daemon 之上的一层薄封装：`stdout` 全程承载 MCP 协议帧，所有日志/提示只写 `stderr`。MCP 握手不等待 daemon 启动；第一次工具调用时才尝试自动拉起 daemon，拉起失败会在该次调用返回清晰的「节点未运行/启动失败」错误，而不是让宿主看到连接超时。

```sh
raminga mcp --data-dir "$HOME/.raminga"
```

本地 API 现在带一个 `api_version` 字段（当前为 `"2"`）。插件外壳在第一次调用时校验它，发现不兼容时提示重启/升级 daemon，而不是把单个 RPC 的失败暴露给模型。`StatusResponse.current_time` 返回节点当前 UTC 时间（RFC 3339）；Agent 在写 journey state/event 时间戳前应调用 `raminga_status` 并使用该字段。`"2"` 新增 `SendChatRequest.agent_origin`：MCP/DSH 等 Agent 外壳发送时置位，TUI/CLI 人工发送不置位；daemon 只对置位发送执行私有原文、密钥/令牌、本机绝对路径与频率上限检查。新外壳连接旧 daemon（`api_version=1`）会明确拒绝，避免 proto3 忽略未知字段而静默跳过防护。

首次运行的**旧数据目录安全闸**：如果 `--data-dir` 指向的目录已存在且非空，但既无 `identity/` 也无 `config.toml`（疑似旧版或非 Raminga 数据），`raminga mcp` 会**拒绝静默初始化**——只写一条 stderr 警告，不自动生成新身份；确认后请显式 `raminga init --data-dir ...` 迁移或沿用，避免误建第二身份。直接运行 `raminga`（自动拉起 daemon 后打开 TUI）使用同一套旧数据目录与其他已知节点检测，命中时打印相同警告并拒绝自动启动。启动器在 `~/.raminga/bin/<version>/` 缓存的二进制属于 Raminga 自有条目，`raminga.lock`、`daemon.log`/`daemon.log.1`、`api.sock`/`api.token` 等运行期文件同样不计入“非空”；因此全新机器上只有 `bin/` 的默认目录可以直接初始化，含其他未知条目时仍按上述规则拒绝。目标目录**尚无身份**时还会检查 `$RAMINGA_DATA_DIR`、默认 `~/.raminga` 以及本文件记录的迁移旧位置（`~/.raminga/raminga-test`、`~/.raminga-before-migrate`、`~/.raminga-new`、`~/.raminga-new/raminga-test`）；发现含 `identity/key` 的节点就列出这些路径并拒绝自动初始化，避免用户已有身份时误建新身份。

首次私有 Agent 文件用 `raminga_agent_init`（MCP 工具，权限 `auto`；调用前仍须确认 Persona 草稿）创建：它只写 `<data-dir>/agent/`，只创建缺失的 `persona.md`、`growth.md`、`contact-notes.json` 与空的 `sessions/` 目录，绝不覆盖已有文件，返回 `created`/`existing` 清单；不会复制 `public/` 模板或发布内容。该工具要求节点已有 `identity/key`：节点尚未初始化时返回明确错误且不创建任何文件或目录，避免 `agent/` 让数据目录被误判为旧数据目录。DSH 外壳提供同名原生工具，行为一致。

最小客户端示例：

```sh
raminga init --data-dir "$HOME/.raminga/client-a"
```

Relay 示例（`<公网IPv4>`、`<R_PEER_ID>` 必须替换为真实值；`<R_PEER_ID>` 来自 Relay 上的 `raminga status`）。不必写 `--listen`，默认同时监听 IPv4/IPv6 的 TCP/QUIC：

```sh
raminga init --data-dir "$HOME/.raminga/relay" --relay-provider --announce /ip4/<公网IPv4>/tcp/4001 --announce /ip4/<公网IPv4>/udp/4001/quic-v1
```

只有云厂商 1:1 NAT 把公网 IPv4 隐藏在网卡之外时才需要 `--announce`；网卡上已有的公网 IPv6 会自动公告，不要重复写。家庭路由器常阻断入站 IPv6；云服务器需分配 IPv6 并在安全组/主机防火墙放行。没有自动 NAT→IPv6 切换。默认**不会**启用 relay provider、UPnP 或其他额外服务。

```sh
raminga init --data-dir "$HOME/.raminga/client-a" --bootstrap /ip4/<公网IPv4>/tcp/4001/p2p/<R_PEER_ID>
```

**升级已有数据目录：** `raminga init --force --data-dir ... <同一组 flags>` 只重写 `config.toml` 以采用新默认，保留 `identity/key`、Peer ID 和 `raminga.db`；不加 `--force` 时旧配置的 `listen_addrs` 保持原样。

细节见 [公网测试指南](public-test-guide.md)。

### 插件外壳与启动器

Claude Code 外壳位于 `plugins/claude/`，marketplace 清单位于仓库根 `.claude-plugin/marketplace.json`（`source` 为 `./plugins/claude`）。本地开发时可把仓库路径或独立 marketplace 仓库加入后安装 `raminga@raminga-plugins`；本页不把该安装流程写成已验证，需按实际 `claude` 版本执行。

Codex 外壳位于 `plugins/codex/`，repo marketplace 清单位于 `.agents/plugins/marketplace.json`（`source.path` 为 `./plugins/codex`），格式依据 OpenAI 官方插件文档；`mcp.json` 使用 Agent Plugins 1.0.0 的可移植 stdio 格式。DSH 外壳位于 `plugins/dsh/`，以 npm 包方式装进 DSH profile；DSH 使用原生工具而不是 MCP。

Claude/Codex 的 `mcp.json` 都以 `sh` 为 `command`、以插件根变量定位 `bin/raminga-launcher.sh`（Claude 用 `${CLAUDE_PLUGIN_ROOT}`，Codex 用 `${PLUGIN_ROOT}`），因为仓库中生成的 `.sh` 在部分检出/平台上没有可执行位。启动器优先复用 PATH 上**版本精确匹配**固定发布版本的 `raminga`，其次复用 `~/.raminga/bin/<version>/` 缓存，最后按平台下载裸二进制并校验 `SHA256SUMS`。下载在系统临时目录完成，校验通过后才写入缓存；失败时只清理本次创建的临时文件/目录，不会留下空的 `~/.raminga/bin/<version>/`。`make install` 的本地构建通常带 git 版本后缀，不会与固定发布版本精确相等；开发或离线时应显式设置 `RAMINGA_BIN` 指向本地二进制，启动器会跳过版本比对并在 stderr 提示。Windows 上 `sh` 是否可用本机无法验证，保持未决；当前不提供绕过 `sh` 的 Windows 变通方案。

**环境变量与宿主：** Codex 当前不把调用者环境变量传给插件 MCP，`RAMINGA_BIN`、`RAMINGA_DATA_DIR` 在 Codex 下不生效；Codex 外壳因此只使用默认数据目录 `~/.raminga`。`RAMINGA_BIN`/`RAMINGA_DATA_DIR` 适用于 Claude Code 与 DSH。这是宿主限制，第一版接受，不提供绕过的插件配置。

#### 插件工具权限

`agent/tools.yaml` 中所有 Raminga 工具（含 `raminga_connect`、`raminga_connect_listed`、`raminga_chat_send`、`raminga_agent_init`）都是 `permission: auto`：Agent 可以像用户本人一样连接、发消息、回复和初始化私有文件，daemon 的 `agent_origin` 兜底检查负责拦截私有数据外泄与异常频率。该设置**只针对本插件工具**，不放宽宿主自身的命令执行、文件写入、网络等工具。

宿主插件清单本身不能声明“自动允许本插件的 MCP 工具”，需要用户一次性授予仅限本插件的规则：

- Claude Code（`mcp.json` 的 server key 为 `raminga`，插件名也为 `raminga`）：在 `/permissions` 添加 `mcp__plugin_raminga_raminga__*`，或在用户设置中写：

  ```json
  {
    "permissions": {
      "allow": ["mcp__plugin_raminga_raminga__*"]
    }
  }
  ```

  只匹配该插件的 MCP 工具；不要同时允许 `Bash`、`Write`、`WebFetch` 等宿主工具。
- Codex：是否确认由 Codex 的宿主策略决定，不由 Raminga 插件清单声明。实测中 Codex 会对写操作和访问网络的工具按其策略请求确认；连接、发消息等调用在非交互会话下可能因此无法完成。Raminga 不提供绕过宿主审批的配置、环境变量或工具注解变通方案，也不把未经实测的 Codex 配置键写成可用方法。插件只声明如实的 MCP 注解（`readOnlyHint`/`openWorldHint`），不会为了让工具自动执行而改为只读或非开放网络。
- DSH：`CONFIRM_TOOLS` 随目录权限变为空，`tools/pre-execute` 不再对本插件工具发起 `ask`；DSH 自身工具权限不变。

MCP 工具注解与上述一致：会写入或对外发送的工具 `ReadOnlyHint=false`，访问远端的工具 `OpenWorldHint=true`。宿主权限声明依据见 [agent-skill.md §8.1.4](agent-skill.md#814-宿主权限分界)。


### 数据目录内容

`init` 会写 `config.toml`，并创建公开内容目录 `public/profile/`、`public/posts/`；daemon 启动时也会补齐这些目录。`public/friends.json` 由程序生成，手工修改会被下一次同步覆盖。数据目录会出现：

- `config.toml`
- `identity/key`（0600；目录 0700）
- `raminga.lock`
- `raminga.db`
- `api.sock` / `api.token`（0600，daemon 运行时）
- `daemon.log`（自动启动时，0600；轮转文件 `daemon.log.1`）
- `public/profile/`、`public/posts/`（用户发布的公开文件）
- `public/friends.json`（程序生成的只读好友列表）
- 导出报告时的 `reports/`
- 下载远端内容时的 `downloads/<Peer ID>/<path>`（`.part` 断点文件只在下载中短暂存在）

一个数据目录只能运行一个 daemon；同一台机器跑多个节点必须用不同 `--data-dir`（并确保监听端口不冲突）。日常单节点不需要记这些路径。

### 从自定义数据目录迁移到默认目录（第一次运行前）

**顺序不能反：先停旧节点、迁移整个目录，再第一次运行新版 `raminga`。** 新版一旦在默认目录启动，就会创建 `identity/key` 和 `raminga.db`；这时再执行 `mv /path/to/old-data ~/.raminga`，`mv` 不会替换 `~/.raminga`，而是把旧目录移到 `~/.raminga/<旧目录名>` 里（例如 `~/.raminga/raminga-test`）。结果是旧节点还在子目录，默认目录却由新身份运行。

先停旧节点并检查目标目录：

```sh
raminga stop --data-dir /path/to/old-data
ls -d "$HOME/.raminga" 2>/dev/null || echo "目标目录不存在"
```

- **目标不存在：** 直接整体移动，`identity/key` 跟着走，Peer ID 不变：

```sh
mv /path/to/old-data "$HOME/.raminga"
```

- **目标已存在：** 不要直接 `mv`。先看里面有没有身份或数据库：

```sh
ls -la "$HOME/.raminga"
test ! -e "$HOME/.raminga/identity/key"
test ! -e "$HOME/.raminga/raminga.db"
```

  如果目录是空的，先把它改名保留，再把旧目录移进来（不要用会静默失败的 `rmdir`）：

```sh
mv "$HOME/.raminga" "$HOME/.raminga-before-migrate"
mv /path/to/old-data "$HOME/.raminga"
```

  如果已有 `identity/key` 或 `raminga.db`，不要覆盖；先备份或改名，确认要保留哪一份身份，再移动。两份身份都保留着，才有机会找回旧 Peer ID。确认新目录的 Peer ID 正确后，再删除 `~/.raminga-before-migrate`。

移动后先核对身份，再启动：

```sh
raminga status --data-dir "$HOME/.raminga"
```

Peer ID 应与旧节点一致。确认后再运行 `raminga` 或 `raminga restart`。

**已经移错、旧目录变成子目录时，按这个顺序恢复：** 如果旧 daemon 还在子目录里运行，先 `raminga stop --data-dir ~/.raminga/raminga-test`，避免它继续写数据库。

```sh
raminga stop
mv ~/.raminga ~/.raminga-new
mv ~/.raminga-new/raminga-test ~/.raminga
raminga restart
raminga status
```

`raminga status` 里的 Peer ID 必须和旧节点一致。**只有确认 Peer ID 正确后**，才删除多出来的目录：

```sh
rm -rf ~/.raminga-new
```

不要在没有核对 Peer ID 前删除任何目录。**Peer ID 变了说明新版自动创建了新身份，不是数据被删除**；旧身份通常还在被移进去的子目录里（上面的例子是 `~/.raminga-new/raminga-test`），先找回 `identity/key`，不要用删除目录来“修复”。

`raminga.lock` 是运行期文件，可以一起移动；迁移前先 `raminga stop`，避免旧 daemon 还在写数据库。

TUI 底部实时区域显示状态行、输入行和补全/提示；未选聊天对象时提示符为 `>`，已选时为 `<名字>> `。输入非空时 `Ctrl+C` 清空输入，输入为空时退出 TUI（daemon 继续运行）。已选聊天对象时，输入为空按 `Esc` 退出聊天。连接、发送、下载进度显示在状态行，不会写入滚动区。

如果 TUI 启动时发现 daemon 版本与当前程序不同，会打印一次：

```text
! 节点版本 X 与当前程序 Y 不同；运行 raminga restart 切换到新版本
```

按提示 `raminga restart` 即可。TUI 本身仍是本地 API 的薄客户端，不持有节点状态。

断开一个当前连接并持久暂停自动重连（普通 API，不是测试接口；重启后仍暂停；显式 `raminga connect` 或发送聊天会解除暂停）：

```sh
raminga disconnect <peer-id> --data-dir "$HOME/.raminga"
```

好友表（只有已有好友能命名/描述；删除有 pending outbox 时需 `--cancel-pending`）：

```sh
raminga friends list --data-dir "$HOME/.raminga"
raminga friends name <名字> <peer-id> --data-dir "$HOME/.raminga"
raminga friends describe <名字|peer-id> <描述> --data-dir "$HOME/.raminga"
raminga friends remove <名字|peer-id> --data-dir "$HOME/.raminga"
raminga friends sync --data-dir "$HOME/.raminga"
```

`friends name`、`describe`、`remove` 成功后会自动重写 `friends.json`（失败只记日志，不回滚操作）。TUI 对应 `/name <节点> <名字>`、`/describe <节点> <描述>`、`/forget <节点>`，以及 `/published sync`。`/peers` 把好友和已知节点按 Peer ID 合并，每个节点一行并显示完整 Peer ID；`/copy <节点>` 复制对方的完整 Peer ID，`/copy` 不带参数复制本机可用地址。TUI 的 `/name` 先填节点、后填名字；CLI 仍是 `raminga friends name <名字> <节点>`。

公开内容限额在 `config.toml` 的 `[content]`（只有这三个键）：

```toml
[content]
max_file_bytes = 104857600      # 100 MiB
max_posts_bytes = 1073741824    # 1 GiB
max_profile_bytes = 10485760    # 10 MiB
```

`/manifest` 和 `/files/<path>` 通过 libp2p HTTP 提供 `public/` 下的内容；`profile/`、`posts/` 目录中的隐藏文件、临时文件和符号链接不会发布。`friends.json` 只包含名字、Peer ID、公开/中继地址和描述，不包含手动标记、时间或暂停状态。

查看远端内容（CLI）：

```sh
raminga content manifest <名字|Peer ID> --json
raminga content profile <名字|Peer ID>
raminga content friends <名字|Peer ID>
raminga content get <名字|Peer ID> posts/example.txt
raminga content connect <列表所有者> <列表中的名字|Peer ID>
```

TUI 对应 `/view <节点>`、`/posts <节点>`、`/peerfriends <节点>`（显示完整 Peer ID 和地址，都是对方的说法，未验证）、`/connect <列表所有者> <列表中的节点>`（用列表里的地址连接，读取列表本身不会连接）、`/files <节点>`（完整清单，自动翻页）、`/get <节点> <清单路径>`。`/get` 的第二个参数是对方 manifest 里的路径（例如 `posts/hello.md`），不是本地保存位置；文件固定保存到 `<data-dir>/downloads/<Peer ID>/<path>`，用 `/files` 查看可下载路径。`/status` 会先打印每条公告地址的标签，再单独打印完整地址，方便直接选中；长行由终端自然折行，程序不会插入换行，解析前也会去掉所有空白。远端文字会先去除 ANSI/控制序列；只有 Markdown/纯文本作为文字显示，其他文件只提示保存路径。查看会向对方暴露你的 Peer ID 和 IP，并可能把对方记入本地好友表。经中继时只允许首个 manifest 页和 ≤64 KiB 文件；更大的内容会等待约 15 秒直连升级，仍失败则明确要求直连，不会用多条中继连接拼接。

查看本机发布了什么、哪些文件被跳过及原因、`friends.json` 最后变更时间（TUI `/published` 等价，且都会强制重新扫描；TUI `/published sync` 会先重写 `friends.json`）：

```sh
raminga content published --data-dir "$HOME/.raminga"
raminga content published --json --data-dir "$HOME/.raminga"
```

DHT 状态还会显示 `last_publish` / `last_publish_error`（本机地址记录发布结果）：

```sh
raminga dht status --data-dir "$HOME/.raminga"
```

`raminga --help` 和 `raminga <cmd> --help` 是最终命令/flag 权威；TUI 只需 daemon 已启动，不会自行监听端口。

## 5. 后台运行与日志

日常不需要手动后台化：`raminga` 会自动启动脱离终端的 daemon。它使用 `setsid`（Unix）或 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`（Windows），关闭终端不会停止节点。日志追加到 `<data-dir>/daemon.log`，权限 0600；下次启动时如果该文件超过 10 MiB，会先改名为 `daemon.log.1`。

`raminga stop` 通过本地 Connect API 的 `Shutdown` 请求停止，和 SIGTERM 走同一套优雅退出；最多等 15 秒。`raminga restart` 先等旧进程完全释放数据目录锁，再启动当前二进制。

systemd 环境下请用服务管理，不要用 `raminga stop/restart`：

```sh
sudo systemctl stop raminga
sudo systemctl restart raminga
journalctl -u raminga -f
```

临时测试也可以显式前台运行：

```sh
raminga daemon --data-dir "$HOME/.raminga"
```

### macOS

自动启动的 daemon 会脱离终端，但**不会阻止系统睡眠**。需要长时间在线时可以用前台：

```sh
caffeinate -i raminga daemon --data-dir "$HOME/.raminga"
```

当前未验证 launchd plist；需要开机自启时按 systemd 语义自行编写并测试，不要把未验证 plist 当正式支持。

### Windows

自动启动使用 detached process；也可以手动：

```powershell
Start-Process .\raminga.exe -ArgumentList 'daemon','--data-dir',"$HOME\.raminga"
```

停止：

```powershell
.\raminga.exe stop --data-dir "$HOME\.raminga"
```

或 `Stop-Process -Name raminga`（不推荐，优先用 `raminga stop`）。

## 6. 防火墙 / 端口

只有**公网可达的 Relay/Bootstrap 节点**需要入站 TCP+UDP **4001**（默认监听；以 `raminga init --help`/`config.toml` 为准）。普通客户端只需出站。

云主机：在安全组放行 TCP 4001 与 UDP 4001，来源尽量限制为测试网络。主机防火墙示例：

```sh
sudo ufw allow 4001/tcp
sudo ufw allow 4001/udp
sudo ufw status
```

`ufw` 显示 inactive 时它没有在拦截；不要误以为已放行。安装脚本**不会**改防火墙。详见 [公网测试指南 §2](public-test-guide.md#2-前提一台可被外部连接的-raminga-节点)。

## 7. 升级与卸载

### 本地日常节点

```sh
# 解压新归档到新目录
sh ./install.sh
raminga restart
```

`install.sh` 只替换二进制，不自动重启；看到 `运行 raminga restart 切换到新版本` 就按提示做。旧 daemon 不会热替换，`restart` 后 TUI/CLI 才会用新版本。

### systemd 服务器

```sh
# 解压新归档到新目录
sudo ./install.sh --service
sudo systemctl status raminga
```

已有 unit 会被 `systemctl restart`，所以不需要再手动 `raminga restart`。

从 2026-11-06 之前的版本升级时要注意：

- 聊天协议已改为 HTTP over libp2p（`/raminga/http/1.0.0`），**不兼容旧版本**，服务器和所有设备要一起升级。
- 旧的 `peer_names` 表会被删除，之前起的名字会丢失。先连接对方，再用 `/name` 重新起名；只有好友表里的节点才能起名。
- TUI 的好友列表已并入 `/peers`，`/peers <节点>` 显示当前连接和已知地址；CLI 的 `raminga friends ...` 保留。
- 不需要重新 `init`；身份和聊天记录保留。

卸载：

```sh
sudo rm -f /usr/local/bin/raminga
rm -rf "$HOME/.raminga"
```

systemd 服务还要：

```sh
sudo systemctl disable --now raminga
sudo rm -f /etc/systemd/system/raminga.service
sudo systemctl daemon-reload
```

删除数据目录会删除 `identity/key`，下次启动生成**新的 Peer ID**；需要保留身份时先备份/保留 `identity/`。开发阶段不承诺跨版本数据兼容；升级前先备份需要保留的 `raminga.db` 与身份。

## 8. 故障排查

| 现象 | 原因/处理 |
| --- | --- |
| `permission denied` 写 `/usr/local/bin` | 用 `sudo ./install.sh`，或 `sh ./install.sh --prefix "$HOME/.local/bin"` |
| `command not found: raminga` | 运行安装脚本打印的 `source` 命令，或打开新终端；脚本没有写配置时，按它打印的 `export PATH=...` 手动加入 |
| 装了新版，`raminga version` 还是旧版 | 另一个 `raminga` 排在 `PATH` 前面（安装脚本会警告）；用 `command -v raminga` 找到它，删除或替换，或调整 `PATH` 顺序 |
| macOS 提示“无法验证开发者”/quarantine | 安装脚本会尽力 `xattr -d`; 仍被拦截时右键解除锁定；未签名/未公证 |
| `exec format error` | 架构不匹配；重新 `uname -sm`/`$env:PROCESSOR_ARCHITECTURE` 并下载正确归档，或本地 `go build` |
| `raminga` 启动失败并打印 `daemon.log` 末尾 | 看 `<data-dir>/daemon.log`；常见原因是端口占用、config.toml 语法、数据目录权限 |
| `节点未运行` | daemon 没启动/已退出，或 `--data-dir` 不一致；`raminga` 会自动启动，`raminga tui` 不会 |
| 版本不一致提示 | 运行 `raminga restart`；systemd 环境用 `sudo systemctl restart raminga` |
| 节点由 systemd 管理 | 用 `sudo systemctl stop\|restart raminga`；不要用 `raminga stop/restart` 再起一个 |
| `api.sock` 残留 | 不需要手删；新 daemon 会安全替换。`raminga stop` 只看真实 API，残留 socket 不会让启动失败 |
| daemon 启动即退出 | 检查端口占用、config.toml 语法、数据目录权限；必要时前台 `raminga daemon --log-level debug` 诊断 |
| Windows SmartScreen | 属性 → 解除锁定或“更多信息→仍要运行”；未签名 |
| 迁移后 Peer ID 变了 | 先不要删除任何目录：新版可能已在默认目录生成新身份。按 [§4 恢复步骤](#从自定义数据目录迁移到默认目录第一次运行前) 找回旧 `identity/key`，核对 `raminga status` 后再清理 |
| `~/.raminga` 里出现 `raminga-test/` | 典型的 `mv 旧目录 ~/.raminga`（目标已存在）结果；旧节点被移进子目录，默认目录是新身份。按 §4 恢复，不要直接删子目录 |
| `--service`/systemd 是否已验证 | 安装脚本和 unit 示例存在，但尚未验证 systemd 托管；需要时按实际用户/路径手工验证，未验证前不要当作生产部署 |

## 9. 状态与诚实边界

- 当前 `make dist` / `make dist-check` 产物是**未签名 snapshot**；macOS 未 notarize，Windows 未 Authenticode 签名。
- 有归档内的 `install.sh` / `install.ps1` 与 `make install`；没有 Homebrew/scoop/winget/npm 安装器或自动更新渠道，分发/签名渠道尚未实现。
- 归档和顶层目录名**不含版本号**；版本用 `raminga version` 查看。
- Windows 实机曾运行过旧协议的 daemon/TUI/QUIC 打洞，但当前版本未按清单逐项冒烟，状态仍为 **NOT_TESTED**；systemd/launchd 示例需按实际用户/路径调整。Windows 的 `install.ps1` 未在本仓库 CI 中由 PowerShell 实跑。
- 真实公网：M6-D 在 IPv6 有状态防火墙场景真实 **PASS** 一次，IPv4 NAT 打洞与 M6-R 计数仍 **NOT_TESTED**；Docker/lab 不是公网证明。
- HTTP 聊天与内容查看：2026-11-06 在真实网络只验证过直连公网服务器；经中继、打洞、DHT 回退、好友列表找节点在真实网络 **NOT_TESTED**。
- 归档已带外层目录；解压后先进入 `raminga_<os>_<arch>/` 再运行。
