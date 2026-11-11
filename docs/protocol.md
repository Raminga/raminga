# 跨节点协议

Status: **Current — HTTP over libp2p, `/raminga/http/1.0.0`, chat route `/chat`**。
权威契约与示例向量：[`spec/chat-http-v1.md`](../spec/chat-http-v1.md) 和
[`spec/chat-http-v1-vectors.json`](../spec/chat-http-v1-vectors.json)。开放参与原则见
[ADR-0002](adr/0002-open-interoperability.md)。

## 范围

只定义聊天/ACK；不定义档案、社交发布、文件传输、离线消息或正式 E2EE。Network
只负责 libp2p 传输和 HTTP-over-libp2p 的公共层（`internal/p2phttp`）。

## 标识与传输

- libp2p protocol ID：`/raminga/http/1.0.0`；请求 `POST /chat`，JSON。
- 传输：TCP/QUIC + Noise/TLS + Yamux/QUIC，包含 Relay v2 limited 连接。
- **发送者身份只取认证后的 libp2p stream Peer ID**；请求中的 `sender_peer_id` /
  `sender_node_id` 仅为旧 payload 兼容而接受，解码后丢弃，不能改变归属。
- 严格 JSON：拒绝未知字段、尾随数据、非法 UTF-8、错误 content type 和超限 body。
- 200 且 `message_id` 匹配的 ACK 才表示“已持久化或重复命中已存消息”；400/413/
  429/403/503 都不是送达。
- `POST /hello`（空 body）记录一次 Raminga 交互，接收方按认证 Peer ID 写入
  非手动好友行；契约见 [`spec/hello-v1.md`](../spec/hello-v1.md)。
- 公开内容 `GET /manifest`、`GET /files/<path>` 与 `friends.json` 契约见
  [`spec/content-v1.md`](../spec/content-v1.md)。
- 后续 Raminga 服务路由（如 `/manifest`、`/files`）用
  `n.recordInteraction("name", handler)` 包一层即可在 2xx 后异步记录好友；
  `/healthz` 与原始 libp2p 连接不记录。

## 限额与去重

- 文本 ≤4096 UTF-8 字节；单条请求 body 受 `limits.max_message_bytes`（默认 1 MiB）
  和 p2phttp MaxBody 限制；message_id ≤128 字节。
- 接收限流默认 5/s burst 10；去重 LRU 4096 条 / 10 分钟，key 为
  `(认证 Peer ID, message_id)`。
- ACK 使用随机 `ack_id`；不信任 payload 中的 ACK 发送者字段。

## 演进与边界

- Experimental；字段/状态/限额可能调整，变更须同步 `spec/`。
- 没有正式版本协商、应用层签名、E2EE 或跨进程 replay 防护；Peer ID 认证不是
  授权，本地 `authorize` 仍决定 403。
- 真实的公网 NAT/Relay 行为仍 **NOT_TESTED**；Docker 只是受控模拟。
- 已退役的 TypeScript wire 和旧 protobuf chat wire 不在本仓库中，当前树不再实现它们。
