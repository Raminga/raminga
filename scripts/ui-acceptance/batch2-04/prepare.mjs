// Isolated second-batch item 4 fixture: a real multi-day conversation with a
// long message, a real public-profile/post/file visit through the Raminga API,
// a real public-address-book clue, a fixture Journey report backed by those
// real reads, private contact memory, and a contact with no records.
//
// The message text and IDs come from real daemon sends. Because the daemon
// clock cannot create several calendar days in one run, the fixture stops A
// once and rewrites only created/acked timestamps in the test DB. Text,
// direction, IDs, ACK state and message ordering are not invented.
//
// Everything lives under .local/prototype-remediation/b2-04-interactions and
// never touches ~/.raminga, the user's DSH_HOME, the real desktop, or ports
// 4378/4345/4380/4347.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { stopRecordedHosts, stopFixtureNodes } from './cleanup.mjs';
import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DownloadPeerFileRequest,
  GetPeerFriendsRequest,
  GetPeerManifestRequest,
  GetPeerProfileRequest,
  ListMessagesRequest,
  PublishedRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.B4_ACCEPTANCE_DIR
  ? path.resolve(process.env.B4_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-04-interactions');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dirE = path.join(root, 'node-e');
const dirC = path.join(root, 'node-c');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-refresh', 'avatar.png');
const hostPort = Number(process.env.B4_HOST_PORT || 4382);
const controlPort = Number(process.env.B4_CONTROL_PORT || 4349);
const markerBoot = 'B2-04-PRIVATE-';
const A_NAME = '本机交互验收 Agent';
const A_DESC = '隔离验收中的本机公开 Agent，不包含任何私有记忆。';
const B_NAME = '潮汐线旁的林岸';
const B_DESC = '慢一点回信，先把海边的事看完。喜欢潮汐、旧信和雨声。';
const B_STYLE = '不急着追问，喜欢把一句话放一会儿；如果聊到海边，会先听完再回答。';
const B_NOTE = '潮汐线附近的联系人，公开备注保留-B2-04';
const C_NAME = '没有交互记录的联系人';
const C_NOTE = '只有联系人记录，没有消息、漫游或私有印象。';
const CLUE_NAME = 'star-collector';
const LONG_MARK = 'B2-04-LONG-ORIGINAL-END';

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
if (!fs.existsSync(avatarSource)) throw new Error(`missing avatar fixture: ${avatarSource}`);

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(300);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(true));
  });
}
if (!(await portFree(hostPort)) || !(await portFree(controlPort))) {
  throw new Error(`host/control port ${hostPort}/${controlPort} is busy; refusing to touch a live fixture`);
}
stopRecordedHosts(root);
stopFixtureNodes(root);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

const avatarBytes = fs.readFileSync(avatarSource);
const avatarSha = crypto.createHash('sha256').update(avatarBytes).digest('hex');
const avatarName = `avatar-${avatarSha.slice(0, 8)}.png`;
const avatarPath = `profile/${avatarName}`;
const now = new Date();
const isoAt = (daysAgo, hour, minute = 0) => new Date(
  now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute, 0, 0,
).toISOString();
const dayMs = (daysAgo, hour, minute = 0) => Date.parse(isoAt(daysAgo, hour, minute));

function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`), { mode });
  try { fs.chmodSync(file, mode); } catch { /* platform ACL */ }
}

function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 10000 });
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
  const out = fs.openSync(path.join(root, `${name}.log`), 'a');
  const child = spawn(bin, ['daemon', '--data-dir', dir], { stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(path.join(root, `${name}.pid`), String(child.pid));
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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

function connect(api, targetPeer, targetAddr, label) {
  return waitFor(async () => {
    try {
      await api.call((client) => client.connect(new ConnectRequest({ multiaddr: targetAddr, peerId: targetPeer })));
      return true;
    } catch { return false; }
  }, label, 30000);
}

async function waitPeers(api, peerIds) {
  return waitFor(async () => {
    const value = await api.call((client) => client.status(new StatusRequest()));
    return peerIds.every((peerId) => (value.peers || []).some((peer) => peer.peerId === peerId));
  }, 'peer connections visible', 20000);
}

function writePublicProfile(dir, { displayName, description, interests, style, humanName, humanBio }) {
  const profileDir = path.join(dir, 'public', 'profile');
  write(path.join(profileDir, 'index.md'), `# ${displayName}\n\n${description}\n`, 0o644);
  write(path.join(profileDir, 'profile.json'), {
    schema_version: 2,
    agent: {
      name: displayName,
      description,
      interests,
      conversation_style: style,
      avatar: avatarName,
      avatar_sha256: avatarSha,
      avatar_mime: 'image/png',
    },
    human: { name: humanName, bio_markdown: humanBio },
    updated_at: isoAt(5, 12),
  }, 0o644);
  write(path.join(dir, 'public', avatarPath), avatarBytes, 0o644);
}

async function downloadOnce(api, peerId, relative) {
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
  }, `获取 ${relative}`);
  const last = frames.at(-1);
  if (!last || last.phase !== 'complete' || last.error.length > 0) {
    throw new Error(`download ${relative} failed: ${last?.error || 'no complete frame'}`);
  }
  if (!last.discoveryRecorded) throw new Error(`download ${relative} did not record discovery: ${last.discoveryError}`);
  return last;
}

function prepareDshHome() {
  fs.rmSync(dshHome, { recursive: true, force: true });
  fs.cpSync(seedHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const name of Object.keys(pkg.dependencies)) {
    if (/control$/.test(name) || name === '@raminga/dsh') delete pkg.dependencies[name];
  }
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dependencies['b2-04-interactions-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'b2-04-interactions-control');
  write(packagePath, pkg, 0o644);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control', 'b2-contacts-control', 'b3-contact-profile-control', 'b2-04-interactions-control']) {
    fs.rmSync(path.join(modules, name), { force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'b2-04-interactions-control'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
for (const dir of [dirA, dirB, dirE, dirC]) init(dir);
const apiA = await apiFor(dirA);
const apiB = await apiFor(dirB);
const apiE = await apiFor(dirE);
const apiC = await apiFor(dirC);

start(dirB, 'node-b');
start(dirE, 'node-e');
start(dirC, 'node-c');
const b = await status(apiB, 'node B status');
const e = await status(apiE, 'node E status');
const c = await status(apiC, 'node C status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
const addrE = `${tcpAddr(e)}/p2p/${e.peerId}`;
const addrC = `${tcpAddr(c)}/p2p/${c.peerId}`;

// B's public profile, post and file.
writePublicProfile(dirB, {
  displayName: B_NAME,
  description: B_DESC,
  interests: ['潮汐观测', '旧信与邮戳', '雨声录音', '海边植物'],
  style: B_STYLE,
  humanName: '林岸',
  humanBio: '住在潮汐线附近，收集旧信和雨声。',
});
write(path.join(dirB, 'public', 'posts', 'tide-notes', 'post.json'), {
  schema_version: 2,
  id: 'tide-notes',
  format: 'markdown',
  title: '退潮以后留下的石阶',
  summary: '把今天的潮位、盐味和没有寄出的句子记下来。',
  body: '退潮以后，石阶上会留下一层很薄的盐。\n\n我沿着岸边走了很久，把看见的旧邮票和潮位一起记在本子里。',
  tags: ['潮汐', '旧信'],
  author: { peer_id: b.peerId, kind: 'user', display_name: B_NAME },
  published_at: isoAt(3, 11),
}, 0o644);
write(path.join(dirB, 'public', 'docs', 'tide-notes.md'), '# 潮汐笔记\n\n今天退潮后，石阶上留下了一层很薄的盐。\n', 0o644);

// B has a real non-self public address-book claim (E).
await connect(apiB, e.peerId, addrE, 'connect B to E');
await waitPeers(apiB, [e.peerId]);
const nameE = spawnSync(bin, ['friends', 'name', CLUE_NAME, e.peerId, '--data-dir', dirB], { encoding: 'utf8' });
if (nameE.status !== 0) throw new Error(`friends name E on B failed: ${nameE.stderr || nameE.stdout}`);
const describeE = spawnSync(bin, ['friends', 'describe', e.peerId, '公开通讯录中的陌生线索，尚未访问。', '--data-dir', dirB], { encoding: 'utf8' });
if (describeE.status !== 0) throw new Error(`friends describe E on B failed: ${describeE.stderr || describeE.stdout}`);

// Start A, connect to B and C, and create real two-way messages.
start(dirA, 'node-a');
const a = await status(apiA, 'node A status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;
await connect(apiA, b.peerId, addrB, 'connect A to B');
await connect(apiA, c.peerId, addrC, 'connect A to C');
await waitPeers(apiA, [b.peerId, c.peerId]);
await connect(apiB, a.peerId, addrA, 'connect B to A');
await waitPeers(apiB, [a.peerId]);

const messageTexts = [];
for (let index = 0; index < 10; index += 1) {
  const text = index === 7
    ? `${'退潮以后，我把没有寄出的信重新读了一遍。'.repeat(18)}\n${'石子路上有盐，旧灯塔的灯语还留在本子里。'.repeat(4)}\n${LONG_MARK}`
    : `B2-04 发来的真实消息 ${String(index + 1).padStart(2, '0')}：今天潮位和旧信都记下来了。`;
  if (Buffer.byteLength(text, 'utf8') > 4000) throw new Error('long fixture message exceeds chat limit');
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: a.peerId,
    multiaddr: addrA,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `b2-04-in-${String(index + 1).padStart(2, '0')}`,
  })), `send inbound ${index + 1}`);
  if (!String(result.messageId || '')) throw new Error(`inbound ${index + 1} was not persisted`);
  messageTexts.push({ direction: 'in', index: index + 1, text, id: String(result.messageId) });
}
for (let index = 0; index < 10; index += 1) {
  const text = `B2-04 本机发出的真实消息 ${String(index + 1).padStart(2, '0')}：海风比昨天小一点。`;
  const result = await apiA.call((client) => client.sendChat(new SendChatRequest({
    peerId: b.peerId,
    multiaddr: addrB,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `b2-04-out-${String(index + 1).padStart(2, '0')}`,
  })), `send outbound ${index + 1}`);
  if (!String(result.messageId || '')) throw new Error(`outbound ${index + 1} was not persisted`);
  messageTexts.push({ direction: 'out', index: index + 1, text, id: String(result.messageId) });
}

// Real public reads: profile, manifest, post and file. These write discovery
// evidence on A and are the source of the Journey visit events below.
const peerProfile = await apiA.call((client) => client.getPeerProfile(new GetPeerProfileRequest({ peerId: b.peerId })));
const manifest = await waitFor(async () => {
  const value = await apiA.call((client) => client.getPeerManifest(new GetPeerManifestRequest({
    peerId: b.peerId, offset: 0, limit: 500,
  })));
  const paths = new Set((value.entries || []).map((entry) => entry.path));
  return paths.has('posts/tide-notes/post.json') && paths.has('docs/tide-notes.md') ? value : null;
}, 'B public manifest contains post and file', 30000);
const postEntry = manifest.entries.find((entry) => entry.path === 'posts/tide-notes/post.json');
const docEntry = manifest.entries.find((entry) => entry.path === 'docs/tide-notes.md');
const downloadedPost = await downloadOnce(apiA, b.peerId, postEntry.path);
// The public-content fetch limiter is per second; two real downloads need a
// short, explicit gap rather than a retry loop that looks like flakiness.
await new Promise((resolve) => setTimeout(resolve, 1200));
const downloadedDoc = await downloadOnce(apiA, b.peerId, docEntry.path);
const peerFriends = await apiA.call((client) => client.getPeerFriends(new GetPeerFriendsRequest({ peerId: b.peerId })));
const clueClaim = (peerFriends.friends || []).find((item) => (item.peerId || item.peer_id) === e.peerId);
if (!clueClaim) throw new Error(`B public friends does not contain E: ${JSON.stringify(peerFriends)}`);

// B's public note on A and B's public friends.json with E.
const nameBOnA = spawnSync(bin, ['friends', 'name', 'lin-an', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
if (nameBOnA.status !== 0) throw new Error(`friends name B on A failed: ${nameBOnA.stderr || nameBOnA.stdout}`);
const describeBOnA = spawnSync(bin, ['friends', 'describe', b.peerId, B_NOTE, '--data-dir', dirA], { encoding: 'utf8' });
if (describeBOnA.status !== 0) throw new Error(`friends describe B on A failed: ${describeBOnA.stderr || describeBOnA.stdout}`);
const nameCOnA = spawnSync(bin, ['friends', 'name', 'no-history', c.peerId, '--data-dir', dirA], { encoding: 'utf8' });
if (nameCOnA.status !== 0) throw new Error(`friends name C on A failed: ${nameCOnA.stderr || nameCOnA.stdout}`);
const describeCOnA = spawnSync(bin, ['friends', 'describe', c.peerId, C_NOTE, '--data-dir', dirA], { encoding: 'utf8' });
if (describeCOnA.status !== 0) throw new Error(`friends describe C on A failed: ${describeCOnA.stderr || describeCOnA.stdout}`);
const syncB = spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
if (syncB.status !== 0) throw new Error(`friends sync B failed: ${syncB.stderr || syncB.stdout}`);
const friendsJsonB = path.join(dirB, 'public', 'friends.json');
const claimsB = JSON.parse(fs.readFileSync(friendsJsonB, 'utf8')).friends || [];
if (!claimsB.some((item) => item.peer_id === e.peerId && item.name === CLUE_NAME)) {
  throw new Error(`B public friends.json does not contain E: ${friendsJsonB}`);
}

// All 20 real messages must be retained by A before timestamps are moved.
await waitFor(async () => {
  const page = await apiA.call((client) => client.listMessages(new ListMessagesRequest({
    peerId: b.peerId, limit: 100,
  })));
  return page.messages.length >= 20;
}, 'all 20 two-way messages retained by A', 60000);

// Stop A and move only the timestamps into three real calendar days. This is
// the one fixture-only metadata operation; message text/IDs/direction stay as
// sent by the real daemon.
stop(dirA);
const db = new DatabaseSync(path.join(dirA, 'raminga.db'));
let updatedMessages;
try {
  const rows = db.prepare(`SELECT message_id, direction, text, created_at_ms, acked_at_ms
    FROM messages WHERE peer_id=? ORDER BY created_at_ms, message_id`).all(b.peerId);
  if (rows.length !== 20) throw new Error(`expected 20 retained messages, got ${rows.length}`);
  const longRow = rows.find((row) => String(row.text).includes(LONG_MARK));
  if (!longRow) throw new Error('long message was not retained');
  const others = rows.filter((row) => row.message_id !== longRow.message_id);
  const slots = [
    { daysAgo: 3, hours: [9, 10, 11, 12, 13, 14, 15] },
    { daysAgo: 1, hours: [9, 10, 11, 12, 13, 14, 15] },
    { daysAgo: 0, hours: [9, 10, 11, 12, 13, 14] },
  ].flatMap((day) => day.hours.map((hour) => dayMs(day.daysAgo, hour)));
  const slotsForOthers = slots.filter((_, index) => index !== 3);
  const longSlot = slots[3];
  const assignments = new Map();
  assignments.set(longRow.message_id, longSlot);
  others.forEach((row, index) => assignments.set(row.message_id, slotsForOthers[index]));
  const update = db.prepare(`UPDATE messages
    SET created_at_ms=?, acked_at_ms=CASE WHEN acked_at_ms > 0 THEN ? ELSE 0 END,
        delivery_updated_at_ms=CASE WHEN delivery_updated_at_ms > 0 THEN ? ELSE 0 END
    WHERE message_id=?`);
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const at = assignments.get(row.message_id);
      update.run(at, at + 1000, at + 1000, row.message_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  updatedMessages = db.prepare(`SELECT message_id, direction, text, created_at_ms, acked_at_ms
    FROM messages WHERE peer_id=? ORDER BY created_at_ms, message_id`).all(b.peerId);
} finally {
  db.close();
}
const longMessage = updatedMessages.find((row) => String(row.text).includes(LONG_MARK));
if (!longMessage) throw new Error('long message missing after timestamp fixture');
const evidenceMessage = updatedMessages.find((row) => row.direction === 'in' && row.message_id !== longMessage.message_id);
if (!evidenceMessage) throw new Error('no short inbound evidence message');

// A can now have a public profile and note; C has no records at all.
writePublicProfile(dirA, {
  displayName: A_NAME,
  description: A_DESC,
  interests: ['本机验收'],
  style: '只读公开资料。',
  humanName: '验收者',
  humanBio: '隔离验收中的本机用户。',
});
write(path.join(dirA, 'public', 'notes', 'readme.md'), '# 本机公开文件\n\n这里只有公开文件，不包含私有印象。\n', 0o644);

const sessionId = 'b2-04-visit';
const noDateSessionId = 'b2-04-no-date';
const sessionDir = path.join(dirA, 'agent', 'sessions', sessionId);
const noDateDir = path.join(dirA, 'agent', 'sessions', noDateSessionId);
for (const dir of [path.join(dirA, 'agent'), path.join(dirA, 'agent', 'sessions'), sessionDir, noDateDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* platform ACL */ }
}
write(path.join(sessionDir, 'state.json'), {
  schema_version: 1,
  session_id: sessionId,
  status: 'completed',
  mode: 'exploration',
  intent: '拜访潮汐线旁的林岸，读公开资料，记录真实交流与一条公开通讯录线索。',
  limits: { max_visits: 1, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3, reply_timeout_seconds: 30, max_duration_seconds: 600 },
  discovery_sources: ['raminga_friends', 'peer_friends'],
  current_peer_id: b.peerId,
  visited_peer_ids: [b.peerId],
  skipped_peer_ids: [],
  curiosity: [],
  started_at: isoAt(3, 8, 50),
  updated_at: isoAt(3, 16, 30),
  completed_at: isoAt(3, 16, 30),
  completion_reason: 'goal',
});
const longId = String(longMessage.message_id);
const inboundId = String(evidenceMessage.message_id);
const outboundRow = updatedMessages.find((row) => row.direction === 'out');
if (!outboundRow) throw new Error('no outbound message for journey evidence');
const events = [
  { schema_version: 1, event_id: 'e1', sequence: 1, timestamp: isoAt(3, 8, 55), type: 'session_started', peer_id: null, source_peer_id: null, summary: '开始拜访 B，先读取公开资料。', evidence_refs: { message_ids: [], content_paths: [], event_ids: [] } },
  { schema_version: 1, event_id: 'e2', sequence: 2, timestamp: isoAt(3, 9, 0), type: 'visit_started', peer_id: b.peerId, source_peer_id: null, summary: '连接并开始实际访问 B。', evidence_refs: { message_ids: [], content_paths: [], event_ids: [] } },
  { schema_version: 1, event_id: 'e3', sequence: 3, timestamp: isoAt(3, 9, 3), type: 'content_read', peer_id: b.peerId, source_peer_id: null, summary: '读取 B 的公开资料、公开动态与潮汐笔记。', evidence_refs: { message_ids: [], content_paths: [postEntry.path, docEntry.path], event_ids: [] } },
  { schema_version: 1, event_id: 'e4', sequence: 4, timestamp: isoAt(3, 9, 40), type: 'message_received', peer_id: b.peerId, source_peer_id: null, summary: '收到 B 的真实消息。', evidence_refs: { message_ids: [inboundId], content_paths: [], event_ids: [] }, message_evidence: { message_id: inboundId, peer_id: b.peerId, direction: 'in', created_at_unix_ms: String(evidenceMessage.created_at_ms), acked: true, acked_at_unix_ms: null, content_sha256: null, summary: 'B 的真实消息证据。', observed_at: isoAt(3, 9, 40) } },
  { schema_version: 1, event_id: 'e5', sequence: 5, timestamp: isoAt(3, 9, 45), type: 'message_sent', peer_id: b.peerId, source_peer_id: null, summary: '向 B 发出真实消息。', evidence_refs: { message_ids: [String(outboundRow.message_id)], content_paths: [], event_ids: [] }, message_evidence: { message_id: String(outboundRow.message_id), peer_id: b.peerId, direction: 'out', created_at_unix_ms: String(outboundRow.created_at_ms), acked: true, acked_at_unix_ms: String(outboundRow.acked_at_ms), content_sha256: null, summary: '本机发出的真实消息证据。', observed_at: isoAt(3, 9, 45) } },
  { schema_version: 1, event_id: 'e6', sequence: 6, timestamp: isoAt(3, 10, 10), type: 'candidate_selected', peer_id: e.peerId, source_peer_id: b.peerId, summary: `从 B 的公开通讯录看到 ${CLUE_NAME}；只记录线索，没有访问或建立联系。`, evidence_refs: { message_ids: [], content_paths: [], event_ids: [] } },
  { schema_version: 1, event_id: 'e7', sequence: 7, timestamp: isoAt(3, 15, 30), type: 'visit_completed', peer_id: b.peerId, source_peer_id: null, summary: '完成对 B 的公开资料访问并结束本轮交流。', evidence_refs: { message_ids: [inboundId], content_paths: [postEntry.path, docEntry.path], event_ids: [] } },
  { schema_version: 1, event_id: 'e8', sequence: 8, timestamp: isoAt(3, 16, 20), type: 'session_completed', peer_id: null, source_peer_id: null, summary: '旅程完成。', evidence_refs: { message_ids: [], content_paths: [], event_ids: [] } },
];
write(path.join(sessionDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
write(path.join(sessionDir, 'report.md'), [
  '# Journey Report',
  '',
  `- **Session ID:** ${sessionId}`,
  `- **Started at:** ${isoAt(3, 8, 50)}`,
  `- **Completed at:** ${isoAt(3, 16, 30)}`,
  '- **Status:** completed',
  '- **User intent:** 拜访潮汐线旁的林岸并记录真实交流。',
  '',
  '## 1. Journey overview',
  '',
  '这次拜访实际读取了林岸的公开资料、动态和潮汐笔记，也通过真实消息交流了潮汐与旧信。公开通讯录里的 star-collector 只作为来源声明记录，没有访问或建立联系。',
  '',
  '## 2. Travel route',
  '',
  `- 本机 → ${B_NAME}（实际访问；下载 ${postEntry.path} 与 ${docEntry.path}）`,
  '',
  '## 5. Personal reflection',
  '',
  '表达克制，愿意慢一点回信；这只是私有印象，不是对方确认的事实。',
  '',
].join('\n'));

write(path.join(noDateDir, 'state.json'), {
  schema_version: 1,
  session_id: noDateSessionId,
  status: 'completed',
  mode: 'exploration',
  intent: '缺少记录时间的旧报告。',
  limits: {},
  discovery_sources: [],
  current_peer_id: null,
  visited_peer_ids: [b.peerId],
  skipped_peer_ids: [],
  curiosity: [],
  started_at: '',
  updated_at: '',
  completed_at: null,
  completion_reason: '',
});
write(path.join(noDateDir, 'events.jsonl'), '');
write(path.join(noDateDir, 'report.md'), [
  '# Journey Report',
  '',
  '这份旧报告没有可用的记录时间，保留为日期未知的漫游报告摘要，不推测日期。',
  '',
].join('\n'));

const impressionSummary = `开始时的私有印象：${'表达克制，愿意慢慢把一句话说完；聊到潮汐和旧信时会先听，再回答。'.repeat(4)}`;
const contactNotes = {
  schema_version: 2,
  unknown_top: 'B2-04-KEEP-TOP',
  contacts: [{
    peer_id: b.peerId,
    display_name_snapshot: B_NAME,
    updated_at: isoAt(3, 16),
    unknown_contact: 'B2-04-KEEP-CONTACT',
    observations: [{
      id: 'obs-tide-1',
      summary: `读过 B 的公开动态《退潮以后留下的石阶》和潮汐笔记；证据是本机下载副本 ${postEntry.path} 与 ${docEntry.path}。`,
      observed_at: isoAt(3, 9, 3),
      unknown_observation: 'B2-04-KEEP-OBS',
      evidence_refs: {
        session_ids: [sessionId],
        event_ids: [`${sessionId}:3`],
        message_ids: [],
        content_paths: [postEntry.path, docEntry.path],
        content_sha256: [downloadedPost.sha256, downloadedDoc.sha256],
      },
    }],
    impressions: [{
      id: 'imp-b2-04',
      summary: impressionSummary,
      uncertainty: 'medium',
      created_at: isoAt(3, 15, 50),
      updated_at: isoAt(3, 15, 50),
      unknown_impression: 'B2-04-KEEP-IMP',
      evidence_refs: {
        session_ids: [sessionId],
        event_ids: [`${sessionId}:7`],
        message_ids: [inboundId],
        content_paths: [postEntry.path],
        content_sha256: [downloadedPost.sha256],
      },
    }],
    curiosities: [{
      id: 'cur-tide-1',
      question: '下次可以问问退潮后石阶上的盐和旧灯塔的灯语。',
      created_at: isoAt(3, 15, 55),
      unknown_curiosity: 'B2-04-KEEP-CUR',
      evidence_refs: { session_ids: [sessionId], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] },
    }],
  }],
};
write(path.join(dirA, 'agent', 'contact-notes.json'), contactNotes);
fs.chmodSync(path.join(dirA, 'agent', 'contact-notes.json'), 0o600);

// Restart A and finish the real public state: A's note, friends.json and scan.
start(dirA, 'node-a');
const restartedA = await status(apiA, 'node A after fixture files');
const addrAFinal = `${tcpAddr(restartedA)}/p2p/${restartedA.peerId}`;
await connect(apiA, b.peerId, addrB, 'reconnect A to B after fixture restart');
await waitPeers(apiA, [b.peerId]);
try {
  await apiB.call((client) => client.connect(new ConnectRequest({ multiaddr: addrAFinal, peerId: restartedA.peerId })));
} catch { /* B may already have the connection */ }
await waitPeers(apiB, [restartedA.peerId]);
const syncA = spawnSync(bin, ['friends', 'sync', '--data-dir', dirA], { encoding: 'utf8' });
if (syncA.status !== 0) throw new Error(`friends sync A failed: ${syncA.stderr || syncA.stdout}`);
const published = await apiA.call((client) => client.published(new PublishedRequest()));
const manifestPaths = (published.files || []).map((entry) => entry.path);
if (!manifestPaths.includes('friends.json') || !manifestPaths.includes('profile/profile.json')) {
  throw new Error(`A published manifest is missing required public files: ${JSON.stringify(manifestPaths)}`);
}
const friendsJsonA = path.join(dirA, 'public', 'friends.json');
const claimsA = JSON.parse(fs.readFileSync(friendsJsonA, 'utf8')).friends || [];
const noteA = claimsA.find((item) => item.peer_id === b.peerId);
if (!noteA || noteA.description !== B_NOTE) {
  throw new Error(`A public note for B was not preserved: ${JSON.stringify(noteA)}`);
}

// Stop C and E: C only needs a real contact record, and B's public claim is
// already written. B and A remain online for the DSH acceptance.
stop(dirC);
stop(dirE);
prepareDshHome();

function hashPublic(dir) {
  const files = {};
  const rootDir = path.join(dir, 'public');
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files[child] = crypto.createHash('sha256').update(fs.readFileSync(path.join(rootDir, child))).digest('hex');
    }
  };
  if (fs.existsSync(rootDir)) walk('');
  return files;
}

const fixture = {
  root,
  generatedAt: new Date().toISOString(),
  hostPort,
  controlPort,
  dshHome,
  nodeA: restartedA.peerId,
  nodeB: b.peerId,
  nodeC: c.peerId,
  nodeE: e.peerId,
  nodeAData: dirA,
  nodeBData: dirB,
  nodeCData: dirC,
  nodeEData: dirE,
  nodeAAddr: addrAFinal,
  nodeBAddr: addrB,
  nodeCAddr: addrC,
  nodeEAddr: addrE,
  publicA: { name: A_NAME, description: A_DESC },
  publicB: { displayName: B_NAME, description: B_DESC, style: B_STYLE },
  publicNote: { peerId: b.peerId, description: B_NOTE },
  cNote: C_NOTE,
  clue: { peerId: e.peerId, name: CLUE_NAME, sourcePeerId: b.peerId },
  post: { path: postEntry.path, sha256: downloadedPost.sha256, sizeBytes: Number(postEntry.size) },
  doc: { path: docEntry.path, sha256: downloadedDoc.sha256, sizeBytes: Number(docEntry.size) },
  sessionId,
  noDateSessionId,
  reportLine: '这次拜访实际读取了林岸的公开资料、动态和潮汐笔记，也通过真实消息交流了潮汐与旧信。',
  longMessageId: longId,
  longMessageText: String(longMessage.text),
  evidenceMessageId: inboundId,
  evidenceMessageText: String(evidenceMessage.text),
  outboundMessageId: String(outboundRow.message_id),
  messages: updatedMessages.map((row) => ({
    id: String(row.message_id),
    direction: String(row.direction),
    text: String(row.text),
    at: Number(row.created_at_ms),
    atIso: new Date(Number(row.created_at_ms)).toISOString(),
  })),
  originalImpression: impressionSummary,
  markerPrefix: markerBoot,
  publicFilesBefore: hashPublic(dirA),
};
write(path.join(root, 'fixture.json'), fixture, 0o644);
console.log(JSON.stringify(fixture, null, 2));
