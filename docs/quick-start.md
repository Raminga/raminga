# 双节点快速开始

准备两台在同一局域网、能相互访问的设备，分别称为 A 和 B。两边使用同一版本，并让节点在操作期间保持运行。下面的 TUI 流程以 v0.1.0-rc.2 的两个本机隔离节点走查，使用不同端口和数据目录通过 TCP 直连。

## 在 DSH 中完成第一次聊天

1. 两边按[DSH 安装说明](install.md#dsh)安装固定版本插件，重新打开相应 profile，从宿主侧栏进入 **Raminga**。首次打开 DSH 可能先出现预览版说明和登录/API Key 引导；Agent 会话需要配置模型，Raminga 的人工聊天可直接通过节点操作。
2. 在顶部“我的”页点击“分享节点信息”，把完整节点地址通过已有渠道发给朋友。确认地址适用于对方网络。如果提示“没有可直接分享的地址”，先检查监听配置和网络；单独的 Peer ID 仍需要已知地址或可用的地址发现路径。
3. 在“联系人”页点击“＋ 添加联系人”，粘贴对方完整地址，点击“连接”。看到“连接成功”后点击“查看联系人”，核对 Peer ID 和“已连接”状态。
4. 在联系人行的“⋯”中选择“编辑名称和备注”，可以设置例如 `xiaobei` 的本地名字。名字只能含小写字母、数字、连字符，并以字母或数字开头，最多 32 个字符。名字和备注会更新公开的 `friends.json`。
5. 点击联系人姓名进入对话，输入消息并发送。让对方回复一条，双方核对收到的文字和发出消息的“协议已接收”状态。该状态表示对端节点接受消息，阅读状态仍未知。

![DSH 中实际收发消息后的 Raminga 对话界面](images/raminga-dsh-chat.png)

这条界面流程在 macOS arm64、DSH 0.2.2-rc.3、Raminga rc.2 上验证。演示使用两个本机隔离节点，DSH 界面发送、另一节点通过 CLI 回复，并核对双方历史。loopback 地址由 CLI 状态读取后手动组装；分享面板在该配置下只提供 Peer ID。跨设备地址分享、系统剪贴板及 Agent 模型执行未纳入本次验收。

## 在独立终端中完成第一次聊天

## 1. 两边安装并启动

从 [v0.1.0-rc.3 发布页](https://github.com/Raminga/raminga/releases/tag/v0.1.0-rc.3) 下载适合各自系统与架构的归档和 `SHA256SUMS`，按[安装指南](install.md#2-安装预编译包)校验并安装。以下是 Apple Silicon 的归档示例。

```sh
tar xzf raminga_darwin_arm64.tar.gz
cd raminga_darwin_arm64
sh ./install.sh
```

按安装器的提示加载 PATH 或打开新终端。两边运行：

```sh
raminga version
raminga
```

在交互终端运行 `raminga` 会启动本地节点并打开 TUI。首次启动会创建节点身份。已打开 TUI 时，可输入 `/help` 看可用命令。Windows 安装方法见[安装指南](install.md#2-安装预编译包)，该版本尚无 Windows 实机验收。

## 2. 交换节点地址

两边在 TUI 输入 `/status`，找到对方设备可访问的**局域网 TCP 地址**，复制完整一行并通过已有聊天渠道发给朋友。完整地址的格式类似 `/ip4/192.168.1.20/tcp/4001/p2p/…`，末尾包含完整 Peer ID。两台设备之间要选局域网网卡的地址，`127.0.0.1` 只在本机可达。

`/copy` 会尝试复制一个默认可用地址。若选到了别的网络，或终端不支持剪贴板序列，直接从 `/status` 选中正确的地址。第一次连接优先用完整地址。仅有 Peer ID 时还需要已有地址记录或可用的 DHT 查找路径。

## 3. 连接并确认好友

A 输入 `/connect`，接一个空格，再粘贴 B 的完整地址并回车。B 可用同样的方式连接 A。连接成功后，两边都可以用 `/peers` 查看联系人，核对 Peer ID 和连接状态。连接成功即可登记好友，无需发送或接受申请。

用 `/name` 给对方起名。A 输入 `/name PEER_ID xiaobei`，把 `PEER_ID` 换成 B 的完整 Peer ID。B 可用相同办法给 A 取名，例如 `anan`。

## 4. 各发一条消息

A 输入 `/chat xiaobei`，看到提示符变为 `xiaobei>` 后输入「今天见！」并回车。B 收到后输入 `/chat` 加 A 的本地名字或完整 Peer ID，再回复「收到！」。两边各看到一条入站消息，且发出的消息显示 `✓`，就完成了双向聊天。`✓` 表示对端节点确认写入，并不表示朋友已经阅读。

输入为空时按 Esc 可退出当前聊天。`/quit` 关闭终端界面，节点仍在后台运行。要停止独立节点，在 shell 运行 `raminga stop`。

## 使用 CLI 操作

先按第 1 步启动节点，再打开第二个终端。运行 `raminga status` 查看本机的 `listen_addrs` 和 Peer ID。如果监听地址缺少 `/p2p/` 后缀，分享前在选中的地址后附上 `/p2p/` 和本机完整 Peer ID。以下示例中，变量值替换为对方实际提供的信息。两边分别执行，换成各自要发送的文字。

```sh
friend_addr='对方的完整地址'
friend_peer='对方的完整 Peer ID'
raminga connect "$friend_addr"
raminga friends list
raminga chat send --to "$friend_peer" --text '你好，Raminga！'
raminga chat history --limit 10
```

发送时确认 `acked: true`，再到对方的历史里确认出现入站消息。若连接或消息未成功，见[用户手册](user-guide.md#常见问题)。
