// Isolated second-batch item 8 fixture. Reuses the accepted item-7 two-node
// fixture (real contacts, 26 inbound messages, posts, Journey evidence and a
// published profile), so the navigation checks run against the same lightweight
// real data. No user account, DSH configuration or real contact is touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B8_ACCEPTANCE_DIR
  ? path.resolve(process.env.B8_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-08-nav');
const hostPort = Number(process.env.B8_HOST_PORT || 4404);
const controlPort = Number(process.env.B8_CONTROL_PORT || 4369);
const item7Prepare = path.join(repoRoot, 'scripts', 'ui-acceptance', 'batch2-07', 'prepare.mjs');

if (!fs.existsSync(item7Prepare)) throw new Error(`missing ${item7Prepare}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

const prepared = spawnSync(process.execPath, [item7Prepare], {
  cwd: repoRoot,
  env: {
    ...process.env,
    B7_ACCEPTANCE_DIR: root,
    B7_HOST_PORT: String(hostPort),
    B7_CONTROL_PORT: String(controlPort),
  },
  encoding: 'utf8',
  timeout: 300000,
  stdio: 'pipe',
});
if (prepared.status !== 0) {
  process.stderr.write(prepared.stderr || '');
  process.stdout.write(prepared.stdout || '');
  throw new Error(`item-7 fixture prepare failed with exit ${prepared.status}`);
}
process.stdout.write(prepared.stdout);

// The accepted item-7 fixture has one Journey. Add seven small, real-format
// Journey records so the "all records" list genuinely scrolls; this is fixture
// data on the isolated node, not a UI-only mock.
const fixturePath = path.join(root, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const dirA = fixture.nodeAData;
const peerB = fixture.nodeB;
for (let index = 1; index <= 7; index += 1) {
  const id = `n8-scroll-${String(index).padStart(2, '0')}`;
  const dir = path.join(dirA, 'agent', 'sessions', id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = String(10 + index).padStart(2, '0');
  const state = {
    schema_version: 1,
    session_id: id,
    status: 'completed',
    mode: 'exploration',
    intent: `沿海岸散步 ${String(index).padStart(2, '0')}：整理潮声与回信里的线索。`,
    limits: {
      max_visits: 5, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3,
      reply_timeout_seconds: 30, max_duration_seconds: 600,
    },
    discovery_sources: ['local friends'],
    current_peer_id: null,
    visited_peer_ids: [peerB],
    skipped_peer_ids: [],
    curiosity: [],
    started_at: `2026-11-${day}T09:00:00Z`,
    updated_at: `2026-11-${day}T09:08:00Z`,
    completed_at: `2026-11-${day}T09:08:00Z`,
    completion_reason: '完成一次沿海岸的真实记录整理。',
  };
  const event = {
    schema_version: 1,
    event_id: `evt-${id}-1`,
    sequence: 1,
    timestamp: `2026-11-${day}T09:01:00Z`,
    type: 'visit_started',
    peer_id: peerB,
    source_peer_id: null,
    summary: '读取公开档案与潮汐笔记。',
    evidence_refs: { message_ids: [], content_paths: ['profile/index.md'], event_ids: [] },
    message_evidence: null,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'report.md'), `# 沿海岸散步 ${index}\n\n这次漫游沿着海岸整理潮声与回信里的线索。\n`, { mode: 0o600 });
}
console.log(`prepared item-8 fixture in ${root}`);
