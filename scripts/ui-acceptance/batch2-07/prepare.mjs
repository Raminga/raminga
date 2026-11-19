// Isolated second-batch item 7 fixture. Reuses the accepted first-batch C
// two-node fixture (real contacts, 24 inbound messages, one human outbound and
// a Journey message evidence), then adds a published profile with a real
// avatar, two long inbound messages and one legacy unknown-origin row. No
// user account, DSH configuration or real contact is touched.
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
  ListMessagesRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B7_ACCEPTANCE_DIR
  ? path.resolve(process.env.B7_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-07-chat');
const hostPort = Number(process.env.B7_HOST_PORT || 4398);
const controlPort = Number(process.env.B7_CONTROL_PORT || 4363);
const bin = path.join(repoRoot, 'bin', 'raminga');
const c1Prepare = path.join(repoRoot, 'scripts', 'ui-acceptance', 'c1', 'prepare.mjs');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-a1', 'post.png');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(c1Prepare)) throw new Error(`missing ${c1Prepare}`);
if (!fs.existsSync(avatarSource)) throw new Error(`missing avatar fixture: ${avatarSource}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 12000 });
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
function tcpAddr(value) {
  const addr = (value.listenAddrs || []).find((item) => item.includes('/tcp/'));
  if (!addr) throw new Error('node has no TCP listen address');
  return addr;
}

// Reuse the accepted C fixture instead of duplicating node init, profile,
// posts, real messages, Journey evidence and DSH home wiring.
const prepared = spawnSync(process.execPath, [c1Prepare], {
  cwd: repoRoot,
  env: {
    ...process.env,
    C1_ACCEPTANCE_DIR: root,
    C1_HOST_PORT: String(hostPort),
    C1_CONTROL_PORT: String(controlPort),
  },
  encoding: 'utf8',
  timeout: 300000,
});
if (prepared.status !== 0) {
  throw new Error(`first-batch C fixture prepare failed:\n${prepared.stderr || prepared.stdout}`);
}
process.stdout.write(prepared.stdout);

const fixturePath = path.join(root, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const dirAFromFixture = fixture.nodeAData;
const dirBFromFixture = fixture.nodeBData;
const peerB = fixture.nodeB;

stop(dirAFromFixture);
stop(dirBFromFixture);

// B publishes a real profile v2 with a verified PNG avatar. The existing
// agent-card stays in place; profile.json is the current structured profile.
const avatar = fs.readFileSync(avatarSource);
const avatarSha = sha256(avatar);
const avatarName = `avatar-${avatarSha.slice(0, 8)}.png`;
fs.writeFileSync(path.join(dirBFromFixture, 'public', 'profile', avatarName), avatar);
const profile = {
  schema_version: 2,
  agent: {
    name: '潮汐线旁的林岸',
    description: '慢一点回信，先把海边的事看完。',
    interests: ['潮汐', '旧信', '雨声'],
    conversation_style: '不急着追问，喜欢把一句话放一会儿。',
    avatar: avatarName,
    avatar_sha256: avatarSha,
    avatar_mime: 'image/png',
  },
  human: {
    name: '林岸',
    bio_markdown: '住在潮汐线附近，收集旧信和雨声。也愿意认识新的朋友。',
  },
  updated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(dirBFromFixture, 'public', 'profile', 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);

// The legacy row has no origin field and no delivery confirmation. It is an
// isolated old-shape fixture row, not a synthetic "current" send.
const db = new DatabaseSync(path.join(dirAFromFixture, 'raminga.db'));
let legacyId = 'legacy-b2-07-unknown';
try {
  const oldest = db.prepare('SELECT MIN(created_at_ms) AS at FROM messages WHERE peer_id = ?').get(peerB);
  const createdAt = Math.max(1, Number(oldest?.at || Date.now()) - 60_000);
  db.prepare(`INSERT OR REPLACE INTO messages
    (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms, origin,
     delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
    VALUES (?, ?, 'out', ?, 0, ?, 0, 'unknown', 'unknown', '', 0, '')`)
    .run(legacyId, peerB, '旧版客户端留下的消息，来源没有记录。', createdAt);
} finally {
  db.close();
}

start(dirBFromFixture, 'node-b');
const apiB = await apiFor(dirBFromFixture);
const b = await status(apiB, 'node B status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
start(dirAFromFixture, 'node-a');
const apiA = await apiFor(dirAFromFixture);
const a = await status(apiA, 'node A status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;

for (const action of [
  () => apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: addrB, peerId: b.peerId }))),
  () => apiB.call((client) => client.connect(new ConnectRequest({ multiaddr: addrA, peerId: a.peerId }))),
]) {
  await waitFor(async () => {
    try { await action(); return true; } catch { return false; }
  }, 'connect fixture nodes');
}
await waitFor(async () => {
  const left = await apiA.call((client) => client.status(new StatusRequest()));
  return (left.peers || []).some((peer) => peer.peerId === b.peerId);
}, 'A sees B connected', 15000);

const longChinese = [
  '这是一条用于检查窄屏换行的真实长消息：退潮以后，石阶上留下了一层很薄的盐。',
  '我把没有寄出的信重新读了一遍，又把潮位记在本子上，连同旧邮票、雨声和一盏没有关掉的灯。',
  '如果下次风小一点，也许可以沿着海岸多走一会儿，把旧灯塔和晚归的船都听完。',
  '这些话留在本机，只给下一次重逢留一个开头。',
].join('\n');
const longUnbroken = '潮'.repeat(420) + 'RamingaWindowEdge'.repeat(24);
const longIds = [];
for (const [index, text] of [longChinese, longUnbroken].entries()) {
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: a.peerId,
    multiaddr: addrA,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `b2-07-long-${index + 1}`,
  })), `send long inbound ${index + 1}`);
  const id = String(result.messageId || '');
  if (!id) throw new Error(`long inbound ${index + 1} was not persisted`);
  longIds.push(id);
}
const expectedMessages = Number(fixture.unreadCount || 0) + 1 + 1 + longIds.length;
await waitFor(async () => {
  const page = await apiA.call((client) => client.listMessages(new ListMessagesRequest({
    peerId: peerB, limit: expectedMessages + 5,
  })));
  return page.messages.length >= expectedMessages;
}, 'A retains all fixture messages', 60000);

const next = {
  ...fixture,
  root,
  hostPort,
  controlPort,
  profile,
  avatarPath: `profile/${avatarName}`,
  avatarSha256: avatarSha,
  legacyMessageId: legacyId,
  longInboundIds: longIds,
  longChinese,
  longUnbroken,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(fixturePath, `${JSON.stringify(next, null, 2)}\n`);
console.log(JSON.stringify(next, null, 2));
