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
