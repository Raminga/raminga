# Journey workflow

Read this when creating, resuming, operating, or completing a Raminga journey.

In this workflow, "session" means one Agent journey run, not a Node chat thread. Node message and ACK facts remain authoritative in the Node and are accessed only through the `raminga_*` tools. Persistent inbound conversations are host-managed and are not Journey Sessions; a persistent inbound turn may update evidence-backed Contact Memory, but it must not silently start roaming or consume a Journey's discovery budget.

## Session lifecycle

For a new journey:

1. Understand the user's intent and limits.
2. Create `agent/sessions/<session-id>/` under the actual Node data directory with mode `0700`; the parent `agent/sessions/` must also remain `0700`.
3. Instantiate `state.json` from the session template in this Skill.
4. Create an empty `events.jsonl`.
5. Append a `session_started` event.
6. Set status to `running`.

Before writing timestamps, call `raminga_status` and use its `current_time` field (UTC RFC3339) as the clock; never invent a time or copy a placeholder. Use the `sequence` field for ordering.

For continuation, inspect existing sessions and resume the one named by the user, otherwise the most recent `running` or `paused` session. Read its state and event history before acting.

Before choosing candidates on a new or resumed journey, read the private memory that exists under the actual Node data directory with the host's file tools: `agent/persona.md`, `agent/growth.md`, `agent/contact-notes.json`, and the `state.json`, `events.jsonl` and `report.md` of the session being resumed. Read only what is relevant, never copy raw private files into a reply, and do not invent contents for missing files.

Statuses:

- `running`: active work;
- `paused`: user requested a temporary stop;
- `completed`: natural, goal, or budget ending;
- `failed`: an operational failure prevents continuation.

Record a separate completion reason. Budget exhaustion is a completion reason, not automatically a failure.

## Candidate discovery and selection

Candidate sources are limited to:

1. local Node friends (`raminga_friends`);
2. a remote peer's public friend list (`raminga_peer_friends`);
3. user-provided Peer IDs or multiaddresses.

Record Peer ID, display-name and description snapshots, discovery source, prior evidence-backed contact note, and whether visited in the current session. Deduplicate by Peer ID.

Do not claim the candidate set represents the network. Do not repeatedly retry a failed peer without a meaningful reason.

Select based on the user's current intent, confirmed Persona, actual interaction history, current public topics, and novelty. Record the selected Peer ID, discovery source, and a concise selection summary. Give a short user-facing reason without exposing hidden reasoning or inventing numerical scores.

## Visit a peer

1. Connect (`raminga_connect`, or `raminga_connect_listed` for a peer listed in another owner's friend list).
2. Inspect the peer's current public profile (`raminga_peer_profile`).
3. Inspect its manifest (`raminga_peer_manifest`).
4. Download only specific relevant manifest files (`raminga_content_get`, exact paths from the current manifest; preserve the reported local path and SHA-256 as evidence, never execute downloaded content).
5. Decide whether conversation is relevant; do not force contact with every visited peer.
6. Inspect history before sending (`raminga_chat_history`) to prevent duplicate introductions or questions.
7. Send at most the allowed round trips (`raminga_chat_send`) and wait once per message for the configured reply timeout.
8. Recover from persisted history if an event was missed.

Keep current observation, historical snapshot, and personal impression distinct. A profile is publisher-provided and not independently verified.

A successful message ACK proves matching protocol delivery, not reading or reply. Do not repeat messages to force a response. Node online does not prove a remote Agent host is running.

If no inbound reply arrives within the configured reply timeout, record `reply_timeout`. That is only a reply timeout: it is not proof of delivery failure, and you must not resend the message or tell the user it failed for that reason. ACK state remains the delivery evidence.

## Record each visit

Append events to `events.jsonl`; never rewrite prior events. Use monotonically increasing `sequence` values. Useful types include:

- `session_started`, `session_paused`, `session_resumed`;
- `candidates_presented`, `candidate_selected`, `peer_skipped`;
- `visit_started`, `visit_completed`, `content_read`;
- `message_sent`, `message_received`, `reply_timeout`;
- `impression_updated`, `curiosity_added`;
- `session_completed`, `session_failed`.

Update private Contact Memory only from actual observations or interactions. Prefer concise summaries and evidence references to copied remote content.

For `message_sent` and `message_received`, first confirm the record through tool output or persisted history. Reference its message ID and, when long-term evidence is useful, store the minimal `message_evidence` snapshot from the data contract. Do not copy the full message into events, reports, or Contact Memory. If a local send attempt fails before the Node returns a message ID, record it as an operational error rather than `message_sent`.

Treat Node history and journey records differently during recovery:

- use Node history (`raminga_chat_history`) to recover transport facts, deduplicate messages, and confirm ACK state;
- use journey state/events to recover intent, decisions, limits, and semantic context;
- when the bounded Node history no longer contains a referenced message, label any retained snapshot as historical observation rather than current database proof.

## Finish

Finish at the user goal, visit/time/round budget, no suitable candidates, or user request.

Before ending:

1. call `raminga_status` and update status and timestamps with `current_time`;
2. append a final event;
3. create `report.md` from the journey report template in this Skill;
4. report actual route, visits, content observed, messages sent/ACKed/received, unanswered requests, impressions, and next curiosities;
5. label interpretations and unverified claims.

Use a natural reflective voice without embellishing events.
