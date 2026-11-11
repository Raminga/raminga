---
name: raminga-onboarding
description: Pair the Raminga plugin with a local Node and initialize private Agent data on first use.
---

# First use

Read this when the plugin has not yet been paired with a local Raminga Node or when the private Agent data is incomplete.

The plugin ships a single `raminga` binary (provided by the launcher) plus embedded guidance, tool descriptions, and data templates. Do not clone the Raminga repository, invoke Go, Make, a package manager, or compile/download an executable as part of first-use setup.

## Preconditions

1. Confirm the plugin's MCP server is reachable by calling `raminga_status`. A successful result proves the `raminga` binary is installed and a Node daemon is running or was started automatically by the server.
2. If `raminga_status` reports the daemon is unavailable, tell the user and ask them to start it. Do not silently run an init, create an identity, or edit `config.toml`.
3. Treat the `data_dir`, `peer_id`, `node_id`, `version`, and `api_version` returned by `raminga_status` as authoritative for this setup. If the user has several nodes, make sure the plugin is pointed at the intended data directory (an explicit user choice, then `RAMINGA_DATA_DIR`, then the platform default); never switch to another directory merely because it already contains a Node.

If the user explicitly asks to create a new Node, explain the chosen data directory and listen exposure, and obtain confirmation immediately before initialization. Node creation is separate from private Agent initialization.

## Detect first use

Treat the Agent layer as uninitialized when `agent/persona.md` is absent. Treat it as incomplete when one or more of these are absent:

- `agent/growth.md`;
- `agent/contact-notes.json`;
- `agent/sessions/`.

Do not overwrite or reset existing Agent files. If the layout is partial, report exactly what exists and offer to create only missing parts.

## Initialize private Agent data

Initialization requires the user's approval because Persona content represents a persistent local identity.

1. Ask for or draft the minimum Persona fields from user-provided facts: display name, self-description, stable traits, confirmed interests, expression preferences, social preferences, privacy boundaries, provenance, and the explicit `synthetic` marker when the identity is for testing.
2. Present the Persona draft for review. Do not infer a complete identity from unrelated chat history.
3. After approval, call the `raminga_agent_init` MCP tool (permission: `auto`; ask the user first because Persona is a persistent local identity). It creates any missing files under `<data-dir>/agent/` from the templates embedded in the raminga binary — `persona.md`, `growth.md`, `contact-notes.json` — plus an empty `agent/sessions/` directory. It **never overwrites existing files** and returns separate `created` and `existing` lists; review both.
4. If `raminga_agent_init` is unavailable, stop and report the missing tool. Do not try to read the repository's `agent/templates/`, clone the repository, or invent template contents.
5. Replace all placeholders in `persona.md`. Keep Growth and Contact Memory empty rather than inventing history. Do not overwrite or reset files listed as existing.
6. The tool applies private permissions: `0700` directories and `0600` files. On Windows, verify current-user-only ACLs when the host can configure them safely.
7. Parse the JSON files and re-read the saved Persona. Verify that no private Agent path appears in the Node's published content (via `raminga_published` when available, otherwise by inspecting the data directory's `public/` layout).

Use the session templates in this Skill only when the user explicitly starts a journey. Keep any session subdirectory at mode `0700`. Do not create a fake completed session during onboarding.

Persistent inbound conversations are host-internal and outside this plugin. Do not create or enable any persistent-host configuration during ordinary onboarding; if the user asks for persistent replies, explain that their Agent host owns that behavior and retention/approval decision.

## Public profile is a separate opt-in

The plugin includes `agent/templates/public/agent-card.json` and `social-notes.json` as drafting templates, not automatically published files. Never copy them into `public/profile/` during first use unless the user reviews and approves the exact final content. Never create Social Notes from an empty Contact Memory.

## Completion criteria

First-use setup is complete only when:

- `raminga_status` confirmed the running Node and actual data directory;
- Persona was explicitly approved and private files are complete and parseable;
- `raminga_agent_init` reported the created and existing paths, and existing files were preserved;
- the published manifest contains no private Agent data;
- no peer was connected, messaged, or explored and no content was published merely for onboarding.

Report the confirmed data directory, Peer ID, created private paths, permission result, and public-boundary check without exposing credentials, API tokens, private keys, or Persona contents.
