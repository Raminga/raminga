// Isolated first-batch-B fixture. Everything lives under
// .local/prototype-remediation/b1 by default and never touches ~/.raminga, the
// user's DSH_HOME, 4354, 4321/4332, or the real desktop.
//
// A = the local node opened by the isolated DSH web host.
// B = a separate peer whose real public file keeps a content_get running while
//     B is paused. A also has multiple Journey directories (short title, long
//     old instruction, old/legacy, and a missing-message reference).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  PublishedRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.B1_ACCEPTANCE_DIR
  ? path.resolve(process.env.B1_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b1');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const controlPort = Number(process.env.B1_CONTROL_PORT || 4336);
const hostPort = Number(process.env.B1_HOST_PORT || 4362);
const HUGE = 40 * 1024 * 1024;
const MESSAGE_TEXT = '你好，这是一条隔离验收中的真实消息。';
const CLEARED_MESSAGE = 'msg-b1-cleared-0001';

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}
function spawnDetached(command, args, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(command, args, { stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.closeSync(out);
  return child;
}
function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 8000 });
}
function init(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const result = spawnSync(bin, [
    'init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0',
    '--no-bootstrap-preset', '--json',
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`init ${dir} failed: ${result.stderr || result.stdout}`);
}
function start(dir, name) {
  const pidFile = path.join(root, `${name}.pid`);
  fs.rmSync(pidFile, { force: true });
  const child = spawnDetached(bin, ['daemon', '--data-dir', dir], path.join(root, `${name}.log`));
  fs.writeFileSync(pidFile, String(child.pid));
  return child;
}
async function waitFor(fn, label, timeoutMs = 25000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw last ?? new Error(`timed out waiting for ${label}`);
}
async function apiFor(dir) {
  return new RamingaApi(resolveConfig({ dataDir: dir, ramingaBin: bin }));
}
function tcpAddr(statusValue) {
  const addr = (statusValue.listenAddrs || []).find((item) => item.includes('/tcp/'));
  if (!addr) throw new Error('node has no TCP listen address');
  return addr;
}
function writeSession(dir, id, {
  status = 'completed', mode = 'exploration', intent = '', startedAt, updatedAt,
  completedAt = null, completionReason = null, currentPeerId = '', visited = [],
  events = [], report = '',
}) {
  const sessionDir = path.join(dir, 'agent', 'sessions', id);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  write(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    session_id: id,
    status,
    mode,
    intent,
    limits: {
      max_visits: 5, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3,
      reply_timeout_seconds: 30, max_duration_seconds: 600,
    },
    discovery_sources: ['local friends'],
    current_peer_id: currentPeerId || null,
    visited_peer_ids: visited,
    skipped_peer_ids: [],
    curiosity: [],
    started_at: startedAt,
    updated_at: updatedAt,
    completed_at: completedAt,
    completion_reason: completionReason,
  });
  const lines = events.map((event) => JSON.stringify({
    schema_version: 1,
    event_id: `evt-${id}-${event.sequence}`,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    peer_id: event.peerId || null,
    source_peer_id: null,
    summary: event.summary || '',
    evidence_refs: {
      message_ids: event.messageIds || [],
      content_paths: event.contentPaths || [],
      event_ids: [],
    },
    message_evidence: event.messageEvidence || null,
  }));
  write(path.join(sessionDir, 'events.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  if (report) write(path.join(sessionDir, 'report.md'), report);
  fs.chmodSync(sessionDir, 0o700);
}

function prepareDshHome() {
  fs.rmSync(dshHome, { recursive: true, force: true });
  fs.cpSync(seedHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const name of Object.keys(pkg.dependencies)) {
    if (name === 'p4-activity-control' || name === 'b1-activity-control') delete pkg.dependencies[name];
  }
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dependencies['b1-activity-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => name !== 'p4-activity-control' && name !== 'b1-activity-control' && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'b1-activity-control');
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.rmSync(path.join(modules, 'p4-activity-control'), { force: true });
  fs.rmSync(path.join(modules, 'b1-activity-control'), { force: true });
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'b1-activity-control'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
stop(dirA);
stop(dirB);
init(dirA);
init(dirB);

const apiB = await apiFor(dirB);
start(dirB, 'node-b');
const b = await waitFor(() => apiB.call((client) => client.status(new StatusRequest())), 'node B status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;

const apiA = await apiFor(dirA);
start(dirA, 'node-a');
const a = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');

write(path.join(dirA, 'public', 'profile', 'index.md'), '# 验收本人\n\n第一批 B 隔离验收节点 A。\n');
write(path.join(dirB, 'public', 'profile', 'index.md'), '# 验收 B\n\n第一批 B 隔离验收节点 B。\n');
const note = JSON.stringify({
  schema_version: 2,
  id: 'b1-note',
  title: '一张旧地图的边缘',
  format: 'markdown',
  author: { peer_id: b.peerId, kind: 'agent', display_name: '验收 B' },
  published_at: '2026-11-17T09:00:00Z',
  updated_at: '2026-11-17T09:00:00Z',
  tags: ['旧地图', '验收'],
  body: '# 一张旧地图的边缘\n\n这是一份用于 Journey 内容证据的真实公开笔记。',
  images: [],
  revision: 1,
});
write(path.join(dirB, 'public', 'posts', 'b1-note.json'), note);
const noteSha = sha256(note);

const hugeBytes = crypto.randomBytes(HUGE);
const hugeSha = sha256(hugeBytes);
write(path.join(dirB, 'public', 'posts', 'b1-huge.bin'), hugeBytes);

await waitFor(async () => {
  const published = await apiB.call((client) => client.published(new PublishedRequest()));
  return published.files.some((entry) => entry.path === 'posts/b1-huge.bin');
}, 'node B publish huge file');

await apiA.call((client) => client.connect(new ConnectRequest({
  multiaddr: addrB,
  peerId: b.peerId,
})), 'connect A to B');

const send = await apiA.call((client) => client.sendChat(new SendChatRequest({
  peerId: b.peerId,
  multiaddr: addrB,
  text: MESSAGE_TEXT,
  origin: 'human',
  agentOrigin: false,
  requestId: 'b1-fixture-message-1',
})), 'send fixture message');
const messageId = String(send.messageId || '');
if (messageId.length === 0) throw new Error('fixture message was not persisted with a message ID');

fs.mkdirSync(path.join(dirA, 'agent', 'sessions'), { recursive: true, mode: 0o700 });
const eventsMain = [
  { sequence: 1, timestamp: '2026-11-18T08:00:00Z', type: 'session_started', summary: '开始一段安静的拜访。' },
  { sequence: 2, timestamp: '2026-11-18T08:02:00Z', type: 'candidate_selected', peerId: b.peerId, summary: '从本地联系人中选择了验收 B。' },
  { sequence: 3, timestamp: '2026-11-18T08:04:00Z', type: 'visit_started', peerId: b.peerId, summary: '开始读取对方的公开资料。' },
  { sequence: 4, timestamp: '2026-11-18T08:05:00Z', type: 'content_read', peerId: b.peerId, summary: '读了一份关于旧地图的公开笔记。', contentPaths: ['posts/b1-note.json'] },
  {
    sequence: 5,
    timestamp: '2026-11-18T08:08:00Z',
    type: 'message_sent',
    peerId: b.peerId,
    summary: '发出了一条真实的问候消息。',
    messageIds: [messageId],
    messageEvidence: {
      message_id: messageId,
      peer_id: b.peerId,
      direction: 'out',
      summary: '一条真实的问候消息。',
      observed_at: '2026-11-18T08:08:00Z',
      created_at_unix_ms: '',
      acked: true,
      acked_at_unix_ms: '',
      content_sha256: '',
    },
  },
  { sequence: 6, timestamp: '2026-11-18T08:10:00Z', type: 'curiosity_added', peerId: b.peerId, summary: '想知道那张旧地图还缺了哪一角。' },
];
writeSession(dirA, 'b1-main', {
  intent: '认识喜欢旧地图的新朋友',
  startedAt: '2026-11-18T08:00:00Z',
  updatedAt: '2026-11-18T08:12:00Z',
  completedAt: '2026-11-18T08:12:00Z',
  completionReason: '完成了这次拜访',
  currentPeerId: '',
  visited: [b.peerId],
  events: eventsMain,
  report: '# 一次旧地图的拜访\n\n拜访了验收 B，读了一份关于旧地图的公开笔记，并发出了一条真实消息。\n\n## 反思\n\n旧地图的边缘留白，也许正是下一次旅行的入口。\n',
});

writeSession(dirA, 'b1-long', {
  intent: '请先读取全部公开内容，然后整理一份很长的总结，并且继续访问下一个对象，完成之后写报告，最后把这次旅行里所有值得记住的细节都保留下来。',
  startedAt: '2026-11-17T14:00:00Z',
  updatedAt: '2026-11-17T14:30:00Z',
  completedAt: '2026-11-17T14:30:00Z',
  completionReason: '按用户要求结束',
  visited: [b.peerId],
  events: [
    { sequence: 1, timestamp: '2026-11-17T14:01:00Z', type: 'observation', peerId: b.peerId, summary: '读到一段没有配图的公开笔记。' },
    {
      sequence: 2,
      timestamp: '2026-11-17T14:02:00Z',
      type: 'message_sent',
      peerId: b.peerId,
      summary: '一条只在历史观察里保留的消息。',
      messageIds: [CLEARED_MESSAGE],
      messageEvidence: {
        message_id: CLEARED_MESSAGE,
        peer_id: b.peerId,
        direction: 'out',
        summary: '这条消息已不在当前保留范围。',
        observed_at: '2026-11-17T14:02:00Z',
        created_at_unix_ms: '',
        acked: false,
        acked_at_unix_ms: '',
        content_sha256: '',
      },
    },
  ],
});

writeSession(dirA, 'b1-old', {
  intent: '',
  startedAt: '2024-10-01T03:00:00Z',
  updatedAt: '2024-10-01T03:20:00Z',
  completedAt: '2024-10-01T03:20:00Z',
  completionReason: '',
  visited: [],
  events: [],
});

// A candidate that was never visited. The route must stay empty, the current
// object must be labelled outside it, and peer search must still find it.
writeSession(dirA, 'b1-current', {
  intent: '只查看了候选线索',
  startedAt: '2026-11-11T10:00:00Z',
  updatedAt: '2026-11-11T10:05:00Z',
  completedAt: '2026-11-11T10:05:00Z',
  completionReason: '只记录了候选线索，没有开始访问',
  currentPeerId: b.peerId,
  visited: [],
  events: [
    { sequence: 1, timestamp: '2026-11-11T10:01:00Z', type: 'candidate_selected', peerId: b.peerId, summary: '在公开线索里看到验收 B，还没有开始访问。' },
    { sequence: 2, timestamp: '2026-11-11T10:04:00Z', type: 'curiosity_added', peerId: b.peerId, summary: '想知道那张旧地图还缺了哪一角。' },
  ],
});

const extra = [
  ['b1-s4', '雨后的公开清单', '2026-11-16T10:00:00Z', '2026-11-16T10:20:00Z'],
  ['b1-s5', '读一读旧地图的注释', '2026-11-15T10:00:00Z', '2026-11-15T10:20:00Z'],
  ['b1-s6', '在通讯录里找一条线索', '2026-11-14T10:00:00Z', '2026-11-14T10:20:00Z'],
  ['b1-s7', '一次没有留下摘要的拜访', '2026-11-13T10:00:00Z', '2026-11-13T10:20:00Z'],
  ['b1-s8', '把旧的公开笔记再读一遍', '2026-11-12T10:00:00Z', '2026-11-12T10:20:00Z'],
];
for (const [id, intent, startedAt, updatedAt] of extra) {
  writeSession(dirA, id, {
    intent,
    startedAt,
    updatedAt,
    completedAt: updatedAt,
    completionReason: '完成',
    visited: [b.peerId],
    events: [
      { sequence: 1, timestamp: startedAt, type: 'visit_completed', peerId: b.peerId, summary: `${intent}，记录了这次访问。` },
    ],
  });
}

write(path.join(dirA, 'agent', 'persona.md'), '# Persona\n\n第一批 B 隔离验收 Agent。\n');
write(path.join(dirA, 'agent', 'growth.md'), '# Growth\n\n暂无。\n');
write(path.join(dirA, 'agent', 'contact-notes.json'), { schema_version: 2, contacts: [] });
fs.chmodSync(path.join(dirA, 'agent'), 0o700);
for (const name of ['activity.jsonl', 'activity.1.jsonl']) fs.rmSync(path.join(dirA, 'agent', name), { force: true });
fs.rmSync(path.join(dirA, 'downloads'), { recursive: true, force: true });

const dsh = prepareDshHome();
const fixture = {
  root,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeBAddr: addrB,
  hugePath: 'posts/b1-huge.bin',
  hugeSha,
  hugeBytes: HUGE,
  notePath: 'posts/b1-note.json',
  noteSha,
  messageId,
  messageText: MESSAGE_TEXT,
  clearedMessageId: CLEARED_MESSAGE,
  journeys: ['b1-main', 'b1-long', 'b1-old', 'b1-current', 'b1-s4', 'b1-s5', 'b1-s6', 'b1-s7', 'b1-s8'],
  activeJourney: 'b1-active',
  nodeAData: dirA,
  nodeBData: dirB,
  dshHome: dsh,
  hostPort,
  controlPort,
  controlUrl: `http://127.0.0.1:${controlPort}/run`,
  generatedAt: new Date().toISOString(),
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
