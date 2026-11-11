# Raminga chat HTTP contract (v1)

Cross-node chat uses the `/raminga/http/1.0.0` libp2p HTTP transport.

- Request: `POST /chat`, `Content-Type: application/json`.
- Body: `message_id` (1..128 bytes), `text` (1..4096 UTF-8 bytes, non-blank),
  `sent_at_unix_ms`. `sender_peer_id` and `sender_node_id` are accepted for old
  payloads but ignored; the authenticated stream Peer ID is the sender.
- Strict JSON: unknown fields, trailing values, invalid UTF-8 and oversized
  bodies are rejected.
- `200` with `{message_id, ack_id, accepted:true, acked_at_unix_ms}` means the
  message was durably stored or was a stored duplicate. Other statuses:
  `400` malformed, `413` too large, `429` rate limited, `403` local policy,
  `503` storage unavailable. A matching `message_id` is required for delivery.
- Limits: 5 requests/s per peer, burst 10; 64 KiB request body; 10 minute
  dedupe window; 4096-byte text.

`POST /hello` is the separate presence/recording endpoint; see
[`hello-v1.md`](hello-v1.md).
