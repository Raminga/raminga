# P4 real-DSH activity acceptance

This directory reproduces the P4 home-activity check without touching the
normal DSH profile, the host on 4321, or `.local/ui-implementation`.

## What it proves

- A real registered `raminga_content_get` executes in the isolated DSH host.
  The home card shows the prototype live card (orb, status badge, chevron) while
  it runs, then the recent card when it finishes.
- Closing the panel writes no terminal. The same operation finishes `ok` after
  the peer resumes, and reopening the panel reads the full record.
- A real tool error renders `失败`; a missing/unsupported read is not turned
  into an empty success.
- The detail view shows the local tool-call fact label, route/evidence summary,
  Journey state association and source. Journey summary text is labelled as
  Agent-generated, not transport evidence.
- Wide (1440×1000) and narrow (390×844) layouts have no page errors or
  horizontal overflow.

## Isolation and fixture

`prepare.mjs` creates two temporary Raminga nodes under
`.local/ui-refresh-20261117/p4-acceptance/` by default:

- `node-a`: the node used by the DSH host; owns `agent/activity.jsonl`;
- `node-b`: a separate peer serving a 90 MiB public file and a small post;
- `dsh-home`: a copy of the isolated DSH profile with `@raminga/dsh` linked to
  this checkout.

The acceptance host also loads a **test-only** `.local` plugin
(`control-plugin/`) that exposes `POST /run` on 127.0.0.1:4333 and calls the
real `ctx.tools.get(name).execute(...)` path. It is never part of the shipped
plugin and is not installed in any user profile.

## Reproduce

From the repository root:

```sh
# 1. Build the shared UI and plugin (do not use DSH config here)
cd packages/ui && npm run build && npm test
cd ../../plugins/dsh && npm run build && npm test

# 2. Create/recreate the isolated two-node fixture (stops only its own nodes)
node scripts/ui-acceptance/p4/prepare.mjs

# 3. Start an isolated DSH web host on a free port (not 4321)
export DSH_HOME=$PWD/.local/ui-refresh-20261117/p4-acceptance/dsh-home
export RAMINGA_DATA_DIR=$PWD/.local/ui-refresh-20261117/p4-acceptance/node-a
export RAMINGA_BIN=$PWD/bin/raminga
dsh web --no-open --host 127.0.0.1 --port 4332

# 4. In another shell, drive the real UI and record evidence
python3 scripts/ui-acceptance/p4/acceptance.py
```

To trigger one tool by hand while the host is open:

```sh
node scripts/ui-acceptance/p4/run-tool.mjs raminga_status '{}'
node scripts/ui-acceptance/p4/run-tool.mjs raminga_content_get \
  '{"peer_id":"<node-b-peer>","path":"posts/p4-small.json"}'
```

Evidence is written to
`.local/ui-refresh-20261117/p4-acceptance/evidence/p4-results.json` plus the
screenshots next to it.

## Notes

- The control plugin is test-only and must not be copied into a release
  profile or shipped in `plugins/dsh`.
- Stop the host and the two fixture daemons after the check. The fixture
  scripts only operate on the directories above.
- The real production UI never calls the control endpoint; it only reads
  activity through the panel bridge.
