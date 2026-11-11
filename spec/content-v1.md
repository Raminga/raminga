# Raminga public content contract (v1)

Served over `/raminga/http/1.0.0` from `<data-dir>/public/`.

## `GET /manifest`

```json
{"version":1,"peer_id":"...","generated_at_unix_ms":0,"total":0,
 "entries":[{"path":"profile/index.md","size":1,"modified_unix_ms":0,"sha256":"..."}]}
```

`?offset=&limit=` are optional; the server caps entries, sorts by path and keeps
each JSON page under 64 KiB. `total` is the full entry count. Entries are files
under `profile/` and `posts/` that survived the scan, plus generated
`friends.json`. Paths use `/`, are relative and valid UTF-8. Symlinks, hidden
entries, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.tmp`, `~$*`, `*.swp` and
non-regular files are skipped. Per-file and per-directory limits omit excess.

## `GET /files/<path>`

Only an entry in the current manifest is served. `..`, absolute paths,
backslashes and NUL are rejected before disk access. Responses use
`application/octet-stream`, `X-Content-Type-Options: nosniff`, SHA-256 ETag,
Range support and a bounded write deadline.

Both routes require the local `authorize` policy and are rate-limited and
recorded after a 2xx response.

## `public/friends.json`

```json
{"version":1,"friends":[{"name":"","peer_id":"...","addrs":[],"description":""}]}
```

SQLite is authoritative. The program rewrites atomically when the serialised
set changes (at start, every 10 minutes, or explicit sync). Only name, Peer ID,
public/circuit addresses and description are exported; internal timestamps,
manual/pause flags and private addresses are not.
