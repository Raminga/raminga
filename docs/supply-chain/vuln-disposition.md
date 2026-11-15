# G4 govulncheck disposition

Command: `make vuln` (govulncheck, tool pinned in `go.mod`).
Report: `tests/e2e/evidence/g4/vuln.txt`.

| ID | Module | Fixed in | Reachability | Disposition |
| --- | --- | --- | --- | --- |
| GO-2024-3218 | `github.com/libp2p/go-libp2p-kad-dht@v0.43.0` | **N/A upstream** | Reachable symbols are DHT package init, `NewDHT`, `FindPeer`, `Bootstrap`, `RefreshRoutingTable`, `RoutingTable`, `Close`; no content/provider record path (the node sets `DisableValues` and `DisableProviders`). | **Accepted, Medium (availability only).** The advisory is content censorship/eclipse abuse of a Kademlia DHT. Raminga runs an independent `/raminga/kad/1.0.0` DHT with **no public IPFS bootstrap defaults**, stores only peer-routing hints (no content/provider records), and never uses DHT as the sole path: explicit multiaddr, pinned relays, PeerStore/SQLite cache and direct/reverse streams remain. Impact is degraded peer discovery, not message confidentiality, integrity, sender authentication or authorization. Re-check when upstream publishes a fix; operators may set `dht.enabled=false`. |

The same scan reports 3 vulnerabilities in required modules with **no call trace**
in this codebase; they are not reachable from `raminga` and require no action
beyond the normal dependency upgrade cadence.

No application-level E2EE, message signatures or social-layer authorization is
claimed by this disposition.

## DSH 运行时依赖维护（2026-11-15）

- **状态：已记录，暂缓处理。** `main` 提交 `1d26019` 的 `0.1.0-rc.2` 发布 dry run 通过，DSH 生产依赖审计按包报 2 项高危、1 项中危。一个包的告警可能汇总多份公告。[发布 dry run](https://github.com/Raminga/raminga/actions/runs/43687099706)
- **依赖链。** `@connectrpc/connect-node@1.7.0`（中危，由下游依赖传递）→ `undici@5.29.0`（高危）→ `@fastify/busboy@2.1.1`（高危）。[Undici TLS 公告](https://github.com/advisories/GHSA-2m5v-pch6-74hx) · [Busboy 拒绝服务公告](https://github.com/advisories/GHSA-x8mw-p69m-v3mx) · [Busboy 头部注入公告](https://github.com/advisories/GHSA-gxm5-99cw-xjw9)
- **当前影响判断。** DSH 的回环 HTTPS 使用 Node 原生 `https.request`，证书固定没有经过公告中的 Undici `Agent`。DSH 要求 Node 22+，ConnectRPC 为旧版 Node 提供的 `Headers` 兼容分支不会启用。未发现 DSH 的 ConnectRPC 请求或响应进入 Busboy multipart 解析器的路径。依据本次依赖和调用路径审查，这三条告警暂不列为 `rc.2` 的发布阻塞项。
- **复核时机。** 更新 ConnectRPC，或引入新的 fetch、HTTP 客户端或 multipart 调用时，重新检查依赖和调用路径，并复测 Windows HTTPS 证书固定及连接行为。
