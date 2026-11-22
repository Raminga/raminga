// Isolated first-batch-C fixture. Everything lives under
// .local/prototype-remediation/c1 by default. It creates two real local nodes,
// real retained messages, a real public profile/address book and one Journey
// with message evidence, but never touches ~/.raminga, the user's DSH_HOME,
// the desktop, 4354, 4362 or their data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DownloadPeerFileRequest,
  ListMessagesRequest,
  OutboxListRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.C1_ACCEPTANCE_DIR
  ? path.resolve(process.env.C1_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'c1');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const controlPort = Number(process.env.C1_CONTROL_PORT || 4337);
const hostPort = Number(process.env.C1_HOST_PORT || 4366);
const INBOUND = 24;
const POSTS = [
  'c1-tide-01', 'c1-tide-02', 'c1-tide-03', 'c1-tide-04', 'c1-tide-05', 'c1-tide-06',
];

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
async function waitFor(fn, label, timeoutMs = 30000) {
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
async function status(api, label) {
  return waitFor(() => api.call((client) => client.status(new StatusRequest())), label);
}
function tcpAddr(statusValue) {
  const addr = (statusValue.listenAddrs || []).find((item) => item.includes('/tcp/'));
  if (!addr) throw new Error('node has no TCP listen address');
  return addr;
}
async function download(api, peerId, relative) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const frames = await api.call(async (client) => {
        const stream = await client.downloadPeerFile(new DownloadPeerFileRequest({
          peerId, path: relative, recordDiscovery: true, discoverySource: 'raminga_content_get',
        }), { timeoutMs: 30000 });
        const collected = [];
        for await (const frame of stream) {
          collected.push({
            phase: String(frame.phase ?? ''), path: String(frame.path ?? ''),
            sha256: String(frame.sha256 ?? ''), totalBytes: Number(frame.totalBytes) || 0,
            error: String(frame.error ?? ''), discoveryRecorded: frame.discoveryRecorded === true,
            discoveryError: String(frame.discoveryError ?? ''),
          });
        }
        return collected;
      }, `下载 ${relative}`);
      const last = frames.at(-1);
      if (!last || last.phase !== 'complete' || last.error.length > 0) {
        throw new Error(`download ${relative} failed: ${last?.error || 'no complete frame'}`);
      }
      return last;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 320));
    }
  }
  throw new Error(`download ${relative} exhausted retries`);
}
function writeSession(dir, id, { startedAt, updatedAt, outboundMessageId, peerId }) {
  const sessionDir = path.join(dir, 'agent', 'sessions', id);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  write(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    session_id: id,
    status: 'completed',
    mode: 'exploration',
    intent: '沿着一封回信，确认联系人档案和会话的往返路径。',
    limits: {
      max_visits: 5, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3,
      reply_timeout_seconds: 30, max_duration_seconds: 600,
    },
    discovery_sources: ['local friends'],
    current_peer_id: null,
    visited_peer_ids: [peerId],
    skipped_peer_ids: [],
    curiosity: [],
    started_at: startedAt,
    updated_at: updatedAt,
    completed_at: updatedAt,
    completion_reason: '完成档案与会话往返复验',
  });
  const events = [
    {
      schema_version: 1, event_id: `evt-${id}-1`, sequence: 1, timestamp: '2026-11-18T09:00:00Z',
      type: 'session_started', peer_id: null, source_peer_id: null,
      summary: '开始核对联系人档案与会话的返回位置。', evidence_refs: { message_ids: [], content_paths: [], event_ids: [] }, message_evidence: null,
    },
    {
      schema_version: 1, event_id: `evt-${id}-2`, sequence: 2, timestamp: '2026-11-18T09:02:00Z',
      type: 'visit_started', peer_id: peerId, source_peer_id: null,
      summary: '读取公开档案与通讯录。', evidence_refs: { message_ids: [], content_paths: ['profile/index.md'], event_ids: [] }, message_evidence: null,
    },
    {
      schema_version: 1, event_id: `evt-${id}-3`, sequence: 3, timestamp: '2026-11-18T09:04:00Z',
      type: 'content_read', peer_id: peerId, source_peer_id: null,
      summary: '读了一页关于潮汐与旧信件的公开动态。', evidence_refs: { message_ids: [], content_paths: ['posts/c1-tide-01/post.json'], event_ids: [] }, message_evidence: null,
    },
    {
      schema_version: 1, event_id: `evt-${id}-4`, sequence: 4, timestamp: '2026-11-18T09:06:00Z',
      type: 'message_sent', peer_id: peerId, source_peer_id: null,
      summary: '先留了一句问候。', evidence_refs: { message_ids: [outboundMessageId], content_paths: [], event_ids: [] },
      message_evidence: {
        message_id: outboundMessageId, peer_id: peerId, direction: 'out',
        summary: '先留了一句问候。', observed_at: '2026-11-18T09:06:00Z',
        created_at_unix_ms: '', acked: true, acked_at_unix_ms: '', content_sha256: '',
      },
    },
  ];
  write(path.join(sessionDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  write(path.join(sessionDir, 'report.md'), '# Journey Report\n\n这次漫游确认了联系人档案、会话和证据引用之间的返回路径。\n');
  for (const name of ['state.json', 'events.jsonl', 'report.md']) fs.chmodSync(path.join(sessionDir, name), 0o600);
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
    if (/control$/.test(name)) delete pkg.dependencies[name];
  }
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dependencies['c1-return-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'c1-return-control');
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control']) {
    fs.rmSync(path.join(modules, name), { force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'c1-return-control'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
stop(dirA);
stop(dirB);
init(dirA);
init(dirB);

const apiB = await apiFor(dirB);
start(dirB, 'node-b');
const b = await status(apiB, 'node B status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;

const apiA = await apiFor(dirA);
start(dirA, 'node-a');
const a = await status(apiA, 'node A status');

write(path.join(dirA, 'public', 'profile', 'index.md'), '# 小舟\n\n本机隔离验收节点 A。喜欢把回信留在同一个窗口里。\n');
write(path.join(dirA, 'agent', 'persona.md'), '# 小舟\n\n安静地记录往返。\n');
write(path.join(dirA, 'agent', 'growth.md'), '# 成长\n\n暂无提案。\n');

write(path.join(dirB, 'public', 'profile', 'index.md'), '# 林岸\n\n住在潮汐线附近，收集旧信和雨声。\n');
write(path.join(dirB, 'public', 'profile', 'agent-card.json'), {
  schema_version: 1,
  display_name: '林岸的 Agent',
  description: '慢一点回信，先把海边的事看完。',
  interests: ['潮汐', '旧信', '雨声'],
  conversation_style: '不急着追问，喜欢把一句话放一会儿。',
  updated_at: '2026-11-18T08:00:00Z',
});
for (let index = 0; index < POSTS.length; index += 1) {
  const name = POSTS[index];
  const title = [
    '潮汐退去以后的第一封信',
    '旧抽屉里的蓝色邮票',
    '雨天码头边的三块石头',
    '把没有寄出的句子折好',
    '傍晚的潮声比昨天慢',
    '最后一班船开走之后',
  ][index];
  write(path.join(dirB, 'public', 'posts', name, 'post.json'), {
    schema_version: 2,
    id: name,
    title,
    format: 'markdown',
    author: { peer_id: b.peerId, kind: index === 5 ? 'agent' : 'user', display_name: index === 5 ? '林岸的 Agent' : '林岸' },
    published_at: `2026-11-1${index}T09:00:00Z`,
    updated_at: `2026-11-1${index}T09:00:00Z`,
    tags: ['潮汐', '旧信'],
    summary: `第 ${index + 1} 页公开笔记，记录潮水退去以后留下的一点细节。`,
    body: `# ${title}\n\n${Array.from({ length: 4 }, (_, line) => `这是第 ${index + 1} 页的第 ${line + 1} 段，写的是潮水退去后的石阶、盐味和没有寄出的信。`).join('\n\n')}`,
    images: [],
    revision: 1,
  });
}

// Both directions are real connections, so B's generated friends.json lists A.
await waitFor(async () => {
  try {
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: addrB, peerId: b.peerId })));
    return true;
  } catch { return false; }
}, 'connect A to B');
const aAddr = `${tcpAddr(a)}/p2p/${a.peerId}`;
await waitFor(async () => {
  try {
    await apiB.call((client) => client.connect(new ConnectRequest({ multiaddr: aAddr, peerId: a.peerId })));
    return true;
  } catch { return false; }
}, 'connect B to A');
await waitFor(async () => {
  const s = await apiA.call((client) => client.status(new StatusRequest()));
  return (s.peers || []).some((peer) => peer.peerId === b.peerId);
}, 'A sees B connected', 15000);

spawnSync(bin, ['friends', 'name', 'lin-an', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', b.peerId, '潮汐线附近的联系人。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'xiao-zhou', a.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', a.peerId, '把回信留在同一个窗口里的人。', '--data-dir', dirB], { encoding: 'utf8' });
const syncB = spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
if (syncB.status !== 0) throw new Error(`friends sync B failed: ${syncB.stderr || syncB.stdout}`);

const outboundResult = await apiA.call((client) => client.sendChat(new SendChatRequest({
  peerId: b.peerId,
  multiaddr: addrB,
  text: '先留一句：我会从档案里的那封信回来。',
  origin: 'human',
  agentOrigin: false,
  requestId: 'c1-outbound-1',
})), 'send outbound A to B');
const outboundMessageId = String(outboundResult.messageId || '');
if (!outboundMessageId) throw new Error('outbound message was not persisted');
const inboundIds = [];
for (let index = 0; index < INBOUND; index += 1) {
  const text = index === INBOUND - 1
    ? '这是最后一条未读回信：窗口还开着，潮声也还在。'
    : `第 ${index + 1} 封回信：潮水退到石阶下面。我把今天看见的盐味、旧邮票和没寄出的句子都留在这里，等你从档案回来的时候再一起读。`;
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: a.peerId,
    multiaddr: aAddr,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `c1-inbound-${String(index + 1).padStart(2, '0')}`,
  })), `send inbound ${index + 1}`);
  const id = String(result.messageId || '');
  if (!id) throw new Error(`inbound ${index + 1} was not persisted`);
  inboundIds.push(id);
}

// Wait for every real send to be ACKed and retained before restarting A for
// the scroll fixture. A pending outbox entry must not be stranded by the
// restart, and the unread count must match the retained rows.
await waitFor(async () => {
  const page = await apiA.call((client) => client.listMessages(new ListMessagesRequest({
    peerId: b.peerId, limit: INBOUND + 10,
  })));
  return page.messages.length >= INBOUND + 1;
}, 'all inbound messages retained by A', 60000);
await waitFor(async () => {
  const outbox = await apiB.call((client) => client.outboxList(new OutboxListRequest()));
  return Number(outbox.stats?.pending || 0) === 0;
}, 'B outbox drained', 60000);

writeSession(dirA, 'c1-journey', {
  startedAt: '2026-11-18T09:00:00Z',
  updatedAt: '2026-11-18T09:06:00Z',
  outboundMessageId,
  peerId: b.peerId,
});

// Download every post so A has a real post-detail regression target.
for (const name of POSTS) await download(apiA, b.peerId, `posts/${name}/post.json`);
await download(apiA, b.peerId, 'profile/index.md');
await download(apiA, b.peerId, 'friends.json');

// Add enough ordinary contacts to make the list a real scroller. These rows
// are local test data only; B remains the only contact with messages/unread.
stop(dirA);
const dbPath = path.join(dirA, 'raminga.db');
const db = new DatabaseSync(dbPath);
try {
  const insert = db.prepare(`INSERT OR REPLACE INTO friends
    (peer_id,name,addrs_json,description,manually_connected,first_seen_ms,last_interaction_ms,relay_capable,dht_capable)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (let index = 1; index <= 10; index += 1) {
    const suffix = String(index).padStart(2, '0');
    insert.run(`12D3KooWC1FixtureFriend${'x'.repeat(30)}${suffix}`, `lin-${suffix}`,
      '[]', index === 1 ? '列表滚动测试联系人。' : '', 1, now - 1000 * index, now - 500 * index, 0, 0);
  }
} finally {
  db.close();
}
start(dirA, 'node-a');
const restartedA = await status(apiA, 'node A after fixtures');
const addrAFinal = `${tcpAddr(restartedA)}/p2p/${restartedA.peerId}`;

prepareDshHome();
const fixture = {
  root,
  hostPort,
  controlPort,
  dshHome,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeAAddr: addrAFinal,
  nodeBAddr: addrB,
  nodeAData: dirA,
  nodeBData: dirB,
  unreadCount: inboundIds.length,
  outboundMessageId,
  inboundMessageIds: inboundIds,
  journeyId: 'c1-journey',
  journeyEvidenceSeq: 4,
  posts: POSTS.map((name) => `posts/${name}/post.json`),
  postTitles: [
    '潮汐退去以后的第一封信',
    '旧抽屉里的蓝色邮票',
    '雨天码头边的三块石头',
    '把没有寄出的句子折好',
    '傍晚的潮声比昨天慢',
    '最后一班船开走之后',
  ],
  generatedAt: new Date().toISOString(),
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
