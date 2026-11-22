// Prepare an isolated two-node fixture for the P4 real-DSH activity check.
// Everything lives under .local/ui-refresh-20261117/p4-acceptance by default;
// it never touches ~/.raminga, the 4321 host or .local/ui-implementation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest, PublishedRequest, StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.P4_ACCEPTANCE_DIR
  ? path.resolve(process.env.P4_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const JOURNEY = 'session-p4-01';
const HUGE = 90 * 1024 * 1024;

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
fs.mkdirSync(root, { recursive: true });

function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
}
function init(dir) {
  if (fs.existsSync(path.join(dir, 'api.token'))) return;
  const result = spawnSync(bin, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`init ${dir} failed: ${result.stderr || result.stdout}`);
}
function start(dir, name) {
  const child = spawn(bin, ['daemon', '--data-dir', dir], { stdio: 'ignore', detached: true });
  child.unref();
  fs.writeFileSync(path.join(root, `${name}.pid`), String(child.pid));
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (Buffer.isBuffer(value)) {
    fs.writeFileSync(file, value);
    return;
  }
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
async function waitFor(fn, label, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last ?? new Error(`timed out waiting for ${label}`);
}
function post(peerId, displayName, id, title, body) {
  return JSON.stringify({
    schema_version: 2,
    id,
    title,
    format: 'markdown',
    author: { peer_id: peerId, kind: 'user', display_name: displayName },
    published_at: '2026-11-18T05:40:00Z',
    updated_at: '2026-11-18T05:40:00Z',
    tags: ['P4', '验收'],
    body,
    images: [],
    revision: 1,
  });
}
function publishPost(dir, peerId, displayName, id, title, body) {
  const value = post(peerId, displayName, id, title, body);
  write(path.join(dir, 'public', 'posts', `${id}.json`), value);
  return { path: `posts/${id}.json`, sha256: crypto.createHash('sha256').update(value).digest('hex'), title };
}

stop(dirA);
stop(dirB);
init(dirA);
init(dirB);
start(dirB, 'node-b');
const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: bin }));
const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: bin }));
const statusB = await waitFor(() => apiB.call((client) => client.status(new StatusRequest())), 'node B status');
// Node A may be auto-started by the DSH host later. Start it now so the fixture
// can publish/connect and verify both identities before the web host boots.
start(dirA, 'node-a');
const statusA = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');

write(path.join(dirA, 'public', 'profile', 'index.md'), '# 验收本人\n\nP4 隔离验收节点 A。\n');
write(path.join(dirB, 'public', 'profile', 'index.md'), '# 验收 B\n\nP4 隔离验收节点 B。\n');

const small = publishPost(dirB, statusB.peerId, '验收 B', 'p4-small', 'P4 小文件', '# P4 小文件\n\n真实工具读取的公开内容。');
const hugeBytes = crypto.randomBytes(HUGE);
const hugeSha = crypto.createHash('sha256').update(hugeBytes).digest('hex');
write(path.join(dirB, 'public', 'posts', 'p4-huge.bin'), hugeBytes);
const huge = { path: 'posts/p4-huge.bin', sha256: hugeSha, title: 'P4 大文件' };
await waitFor(async () => {
  const published = await apiB.call((client) => client.published(new PublishedRequest()));
  return published.files.some((entry) => entry.path === huge.path);
}, 'node B publish files');

const tcp = statusB.listenAddrs.find((addr) => addr.includes('/tcp/'));
if (!tcp) throw new Error('node B has no TCP listen address');
await apiA.call((client) => client.connect(new ConnectRequest({
  multiaddr: `${tcp}/p2p/${statusB.peerId}`,
  peerId: statusB.peerId,
})), 'connect A to B');

const sessionDir = path.join(dirA, 'agent', 'sessions', JOURNEY);
fs.rmSync(sessionDir, { recursive: true, force: true });
write(path.join(sessionDir, 'state.json'), {
  schema_version: 1,
  session_id: JOURNEY,
  status: 'running',
  mode: 'exploration',
  intent: 'P4 验收：读取 B 的公开内容并保留真实工具证据。',
  limits: { max_visits: 5, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3, reply_timeout_seconds: 30, max_duration_seconds: 600 },
  discovery_sources: ['local friends'],
  current_peer_id: statusB.peerId,
  visited_peer_ids: [],
  skipped_peer_ids: [],
  curiosity: [],
  started_at: '2026-11-18T06:00:00Z',
  updated_at: '2026-11-18T06:00:02Z',
  completed_at: null,
  completion_reason: null,
});
write(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
  schema_version: 1,
  event_id: 'evt-p4-1',
  sequence: 1,
  timestamp: '2026-11-18T06:00:02Z',
  type: 'visit_started',
  peer_id: statusB.peerId,
  source_peer_id: null,
  summary: '验收 Journey 开始读取 B 的公开内容。',
  evidence_refs: { message_ids: [], content_paths: [], event_ids: [] },
  message_evidence: null,
})}\n`);
write(path.join(sessionDir, 'report.md'), '# Journey Report\n\n- **Session ID:** session-p4-01\n- **Status:** running\n\n## 1. Journey overview\n\nP4 真实工具活动验收。\n\n## 2. Travel route\n\n- 验收 B。\n\n## 3. New discoveries\n\n- 读取公开内容。\n\n## 4. Conversations\n\n暂无。\n\n## 5. Personal reflection\n\n只记录真实工具返回的证据。\n\n## 6. Next curiosity\n\n继续观察公开内容。\n');
write(path.join(dirA, 'agent', 'persona.md'), '# Persona\n\nP4 验收 Agent。\n');
write(path.join(dirA, 'agent', 'growth.md'), '# Growth\n\n暂无。\n');
write(path.join(dirA, 'agent', 'contact-notes.json'), { schema_version: 2, contacts: [] });
fs.chmodSync(path.join(dirA, 'agent'), 0o700);
fs.chmodSync(sessionDir, 0o700);
for (const name of ['activity.jsonl', 'activity.1.jsonl']) fs.rmSync(path.join(dirA, 'agent', name), { force: true });
fs.rmSync(path.join(dirA, 'downloads'), { recursive: true, force: true });

const fixture = {
  root,
  nodeA: statusA.peerId,
  nodeB: statusB.peerId,
  nodeBAddr: `${tcp}/p2p/${statusB.peerId}`,
  smallPath: small.path,
  smallSha: small.sha256,
  hugePath: huge.path,
  hugeSha,
  hugeBytes: HUGE,
  journey: JOURNEY,
  nodeBData: dirB,
  nodeAData: dirA,
  controlUrl: 'http://127.0.0.1:4333/run',
  generatedAt: new Date().toISOString(),
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
