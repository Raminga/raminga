# Raminga Agent data templates

Integration details: [Agent Skill 接入规范](../../docs/agent-skill.md); the canonical behavior instructions are in [core.md](../guidance/core.md) and the tool catalog in [tools.yaml](../tools.yaml).

These are starter templates, not live runtime data. The Raminga plugin embeds this `agent/templates/` content into the shipped binary. Runtime onboarding must call the `raminga_agent_init` tool, which copies only missing private onboarding files under `<data-dir>/agent/` and never overwrites an existing file; it must not require this repository or a compiler. The shell commands below document the same layout for developers and manual recovery.

## 1. Private Agent data

The default data directory is `$RAMINGA_DATA_DIR` when set, otherwise `~/.raminga`. Use the actual directory selected for the local Node.

Copy the private templates to:

```text
<data-dir>/
└── agent/
    ├── persona.md
    ├── growth.md
    ├── contact-notes.json
    ├── host/
    │   └── <host>/
    │       └── config.json
    └── sessions/
        └── <session-id>/
            ├── state.json
            ├── events.jsonl
            └── report.md
```

Suggested initial setup for a developer checkout (the runtime tool does this automatically and skips existing files):

```sh
DATA_DIR="${RAMINGA_DATA_DIR:-$HOME/.raminga}"
mkdir -p "$DATA_DIR/agent/sessions"
for f in persona.md growth.md contact-notes.json; do
  test -e "$DATA_DIR/agent/$f" || cp "agent/templates/private/$f" "$DATA_DIR/agent/$f"
done
```

Create `state.json`, an empty `events.jsonl`, and `report.md` inside a new session directory only when a journey is explicitly started. Replace all `replace-*` placeholders before using a template as live data.

Here “session” means an Agent journey run, not a Node chat thread. The Raminga Node remains authoritative for raw messages, direction, timestamps, ACK, and outbox state. Agent files preserve intent, decisions, semantic summaries, and long-term memory. Agent hosts must use the supported CLI/API rather than reading or changing `raminga.db` directly.

## 2. Public profile templates — explicit opt-in only

The public templates are separate:

```text
agent/templates/public/
├── agent-card.json
└── social-notes.json
```

If, and only if, the user has reviewed and approved the exact content for public release, copy the chosen file to:

```text
<data-dir>/public/profile/
```

The current Raminga Node publishes eligible files under `public/profile/` and `public/posts/`. There is no field-level or relationship-based privacy for these files. Do not copy private Persona, Growth, Contact Memory, Session State, Events, or Journey Reports into `public/`.

`agent-card.json` is a public self-description. `social-notes.json` is a public projection of selected social impressions, not the private contact database. It is acceptable to leave either file unpublished.

## 3. File roles

| File | Purpose | Default visibility |
|---|---|---|
| `persona.md` | Stable Agent identity and expression preferences | Private |
| `growth.md` | Recent interests and pending change proposals | Private |
| `contact-notes.json` | Peer-keyed private observations and impressions | Private |
| `state.json` | Current journey status and limits | Private |
| `events.jsonl` | Append-only journey event history | Private |
| `report.md` | Human-readable journey report | Private |
| `agent-card.json` | User-approved public Agent introduction | Public if copied to `public/profile/` |
| `social-notes.json` | User-approved public social-note projection | Public if copied to `public/profile/` |

## 4. JSON and JSONL conventions

- JSON files use UTF-8 and `schema_version: 1`.
- Timestamps use RFC 3339 / ISO 8601 with an explicit timezone, preferably UTC (`Z`).
- Peer IDs are the stable contact key. Display names are mutable snapshots.
- `events.jsonl` contains one compact JSON object per line. Append events; do not rewrite prior events.
- `journey-event.json` is a single-event starter template. Copy its object as one line into `events.jsonl`, then replace its placeholders.
- `message_ids`, `event_ids`, and `session_id` are evidence references, not secrets.
- For a message event, set `message_evidence` only after the Node returns or persists the message. Use the minimal snapshot defined in the Skill data contract; keep it `null` for non-message events.
- Do not copy complete chat transcripts into events, reports, or Contact Memory. If bounded Node history later prunes a referenced message, describe the retained snapshot as historical observation, not current Node proof.
- Do not store API tokens, private keys, or unnecessary raw remote content in these files.

These templates are the initial data contract for the Skill, optional host integrations and a future GUI. Repository checks validate their structure and packaged mirrors; live runtime values remain the host's responsibility.
