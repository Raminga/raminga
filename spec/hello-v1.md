# Raminga `/hello` contract (v1)

`POST /hello` on `/raminga/http/1.0.0` records a Raminga-level interaction.

- Body: empty. A non-empty body is rejected with `400`.
- The caller is the authenticated libp2p stream Peer ID; no identity is read
  from headers or body.
- `200` with an empty body means the caller passed local `authorize`.
  `403` means local policy denied and the receiver records no friend row.
- Per-peer rate limiting and the p2phttp per-peer/global concurrency limits
  apply; excess is `429`.
- On success the receiver upserts a non-manual friend row using PeerStore
  addresses (with the existing storage filter). Missing usable addresses still
  creates an empty-address row.
- A manual `Connect` by the caller records its own row as manual and sends
  `/hello`; this endpoint never sets or clears the receiver's manual flag.
