// Isolated second-batch item 3 fixture: a real public contact profile with a
// verified avatar, bio, interests and conversation style; a long, no-avatar
// profile with one missing field; an online peer with no public profile; and a
// local-only offline contact. A real post and a real public file are downloaded
// through node A so the offline profile keeps historical content.
//
// Everything lives under .local/prototype-remediation/b3-contact-profile by
// default and never touches ~/.raminga, the user's DSH_HOME, the real desktop,
// 4374/4341 or any other acceptance fixture.
import fs from 'node:fs';
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
  DisconnectPeerRequest,
  DownloadPeerFileRequest,
  GetPeerManifestRequest,
  ListMessagesRequest,
  OutboxListRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.B3_ACCEPTANCE_DIR
  ? path.resolve(process.env.B3_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b3-contact-profile');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dirC = path.join(root, 'node-c');
const dirG = path.join(root, 'node-g');
const dirE = path.join(root, 'node-e');
const dirD = path.join(root, 'node-d');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-refresh', 'avatar.png');
const controlPort = Number(process.env.B3_CONTROL_PORT || 4343);
const hostPort = Number(process.env.B3_HOST_PORT || 4376);
const INBOUND = 6;
const D_NAME = 'offline-contact-with-long-name-1';
const PUBLIC_B_NAME = '潮汐线旁的林岸';
const PUBLIC_B_DESCRIPTION = '慢一点回信，先把海边的事看完。喜欢潮汐、旧信和雨声。';
const PUBLIC_B_STYLE = '不急着追问，喜欢把一句话放一会儿；如果聊到海边，会先听完再回答。';
const PUBLIC_C_NAME = '潮声与旧信记录者·在岸边整理每一次潮汐退去后的细节';
const PUBLIC_C_DESCRIPTION = '把潮水退去以后留下的石阶、盐味和没有寄出的信记下来。每天清晨先看潮位，再决定今天是否出门；如果风太大，就留在屋里整理旧邮票。';

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
if (!fs.existsSync(avatarSource)) throw new Error(`missing avatar fixture: ${avatarSource}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

const avatarBytes = fs.readFileSync(avatarSource);
const avatarSha = crypto.createHash('sha256').update(avatarBytes).digest('hex');
const avatarName = `avatar-${avatarSha.slice(0, 8)}.png`;
const avatarPath = `profile/${avatarName}`;
const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`));
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

function writePublicProfile(dir, { displayName, description, interests, style, withAvatar, humanName, humanBio }) {
  const profileDir = path.join(dir, 'public', 'profile');
  write(path.join(profileDir, 'index.md'), `# ${displayName}\n\n${description}\n`);
  if (withAvatar) {
    fs.mkdirSync(path.dirname(path.join(dir, 'public', avatarPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', avatarPath), avatarBytes);
  }
  write(path.join(profileDir, 'profile.json'), {
    schema_version: 2,
    agent: {
      name: displayName,
      description,
      interests,
      conversation_style: style,
      avatar: withAvatar ? avatarName : '',
      avatar_sha256: withAvatar ? avatarSha : '',
      avatar_mime: withAvatar ? 'image/png' : '',
    },
    human: { name: humanName, bio_markdown: humanBio },
    updated_at: iso(5 * 60 * 1000),
  });
}

function writePublicPost(dir, peerId, { id, title, summary, body, tags, publishedAt }) {
  write(path.join(dir, 'public', 'posts', 'tide-notes', 'post.json'), {
    schema_version: 2,
    id,
    format: 'markdown',
    title,
    summary,
    body,
    tags,
    author: { peer_id: peerId, kind: 'user', display_name: PUBLIC_B_NAME },
    published_at: publishedAt,
  });
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
  pkg.dependencies['b3-contact-profile-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'b3-contact-profile-control');
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control', 'b2-contacts-control', 'b3-contact-profile-control']) {
    fs.rmSync(path.join(modules, name), { force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'b3-contact-profile-control'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
// A previous acceptance run may have crashed before stopping its host. Prune
// dead records only; then stop and recreate this fixture's nodes.
stopRecordedHosts(root);
stopFixtureNodes(root);
for (const dir of [dirA, dirB, dirC, dirG, dirE, dirD]) init(dir);

const apiA = await apiFor(dirA);
const apiB = await apiFor(dirB);
const apiC = await apiFor(dirC);
const apiG = await apiFor(dirG);
const apiE = await apiFor(dirE);
const apiD = await apiFor(dirD);
start(dirB, 'node-b');
start(dirC, 'node-c');
start(dirG, 'node-g');
start(dirE, 'node-e');
start(dirD, 'node-d');
const b = await status(apiB, 'node B status');
const c = await status(apiC, 'node C status');
const g = await status(apiG, 'node G status');
const e = await status(apiE, 'node E status');
const d = await status(apiD, 'node D status');
// D is a real, valid Peer ID whose daemon is stopped before the UI test. It
// gives the failure/retry path a real offline target instead of a malformed ID.
stop(dirD);
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
const addrC = `${tcpAddr(c)}/p2p/${c.peerId}`;
const addrG = `${tcpAddr(g)}/p2p/${g.peerId}`;
const addrE = `${tcpAddr(e)}/p2p/${e.peerId}`;

writePublicProfile(dirB, {
  displayName: PUBLIC_B_NAME,
  description: PUBLIC_B_DESCRIPTION,
  interests: ['潮汐观测', '旧信与邮戳', '雨声录音', '海边植物'],
  style: PUBLIC_B_STYLE,
  withAvatar: true,
  humanName: '林岸',
  humanBio: '住在潮汐线附近，收集旧信和雨声。',
});
writePublicPost(dirB, b.peerId, {
  id: 'tide-notes',
  title: '退潮以后留下的石阶',
  summary: '把今天的潮位、盐味和没有寄出的句子记下来。',
  body: '退潮以后，石阶上会留下一层很薄的盐。\n\n我沿着岸边走了很久，把看见的旧邮票和潮位一起记在本子里。',
  tags: ['潮汐', '旧信'],
  publishedAt: iso(55 * 60 * 1000),
});
write(path.join(dirB, 'public', 'docs', 'tide-notes.md'), '# 潮汐笔记\n\n今天退潮后，石阶上留下了一层很薄的盐。\n');
write(path.join(dirB, 'public', 'docs', 'reading-list.md'), '# 旧信阅读清单\n\n- 海岸植物图鉴\n- 旧灯塔的灯语\n');

writePublicProfile(dirC, {
  displayName: PUBLIC_C_NAME,
  description: PUBLIC_C_DESCRIPTION,
  interests: ['潮汐退去后的石阶与盐味', '没有寄出的信和旧邮戳', '雨声与磁带录音', '海岸植物图鉴', '清晨潮位表', '旧灯塔的灯语'],
  style: '',
  withAvatar: false,
  humanName: '阿潮',
  humanBio: '在岸边整理潮汐退去后的细节。',
});
// G is a real online peer with no public profile at all.
fs.rmSync(path.join(dirG, 'public', 'profile'), { recursive: true, force: true });

start(dirA, 'node-a');
const a = await status(apiA, 'node A status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;

await connect(apiA, b.peerId, addrB, 'connect A to B');
await connect(apiA, c.peerId, addrC, 'connect A to C');
await connect(apiA, g.peerId, addrG, 'connect A to G');
await waitPeers(apiA, [b.peerId, c.peerId, g.peerId]);
// B publishes a second, non-self claim (E) in its real friends.json. This
// keeps the historical directory check from being vacuous after A is filtered
// as the local self Peer.
await connect(apiB, e.peerId, addrE, 'connect B to E for a public directory claim');
await waitPeers(apiB, [a.peerId, e.peerId]);

// B -> A gives the fixture real persisted messages without inventing a thread.
await connect(apiB, a.peerId, addrA, 'connect B to A');
await waitPeers(apiB, [a.peerId]);
const inboundIds = [];
for (let index = 0; index < INBOUND; index += 1) {
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: a.peerId,
    multiaddr: addrA,
    text: index === INBOUND - 1
      ? '最后一条：潮声还在，等你回来再聊。'
      : '第一封信：今天的潮位退到石阶下面了。',
    origin: 'human',
    agentOrigin: false,
    requestId: `b3-inbound-${String(index + 1).padStart(2, '0')}`,
  })), `send inbound ${index + 1}`);
  const id = String(result.messageId || '');
  if (!id) throw new Error(`inbound ${index + 1} was not persisted`);
  inboundIds.push(id);
}

// Download one real post and one real public file through node A. This writes
// both the controlled local copies and the discovery evidence the offline
// profile/history-read checks reuse. No fixture cache is copied.
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
const downloadedDoc = await downloadOnce(apiA, b.peerId, docEntry.path);

spawnSync(bin, ['friends', 'name', 'lin-an', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', b.peerId, '潮汐线附近的联系人。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'chao-sheng', c.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', c.peerId, '没有消息，也没有公开头像。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'kong-bai', g.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', g.peerId, '在线，但没有公开档案。', '--data-dir', dirA], { encoding: 'utf8' });

await waitFor(async () => {
  const page = await apiA.call((client) => client.listMessages(new ListMessagesRequest({
    peerId: b.peerId, limit: INBOUND + 10,
  })));
  return page.messages.length >= INBOUND;
}, 'all inbound messages retained by A', 60000);
await waitFor(async () => {
  const outbox = await apiB.call((client) => client.outboxList(new OutboxListRequest()));
  return Number(outbox.stats?.pending || 0) === 0;
}, 'B outbox drained', 60000);

// Stop A to add the local-only offline row, then restart and reconnect. This is
// a local friend record, not a remote read or an invented profile.
stop(dirA);
const db = new DatabaseSync(path.join(dirA, 'raminga.db'));
try {
  const stamp = Date.now();
  db.prepare(`INSERT OR REPLACE INTO friends
    (peer_id,name,addrs_json,description,manually_connected,first_seen_ms,last_interaction_ms,relay_capable,dht_capable)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    d.peerId, D_NAME, '[]',
    '对方没有公开 Agent 卡片；本机只保留了这条联系人记录。', 0,
    stamp - 20 * 60 * 1000, stamp - 19 * 60 * 1000, 0, 0,
  );
} finally {
  db.close();
}
start(dirA, 'node-a');
const restartedA = await status(apiA, 'node A after fixtures');
const addrAFinal = `${tcpAddr(restartedA)}/p2p/${restartedA.peerId}`;
await connect(apiA, b.peerId, addrB, 'reconnect A to B after fixtures');
await connect(apiA, c.peerId, addrC, 'reconnect A to C after fixtures');
await connect(apiA, g.peerId, addrG, 'reconnect A to G after fixtures');
await waitPeers(apiA, [b.peerId, c.peerId, g.peerId]);
try {
  await apiB.call((client) => client.disconnectPeer(new DisconnectPeerRequest({ peerId: a.peerId })));
} catch {
  // B may already have dropped the stale socket.
}
await connect(apiB, a.peerId, addrAFinal, 'reconnect B to A after fixture restart');

// Name the real E claim on B before syncing. A is the local self Peer for the
// UI, so E is the only non-self declaration the archived directory can show.
const nameE = spawnSync(bin, ['friends', 'name', 'star-collector', e.peerId, '--data-dir', dirB], { encoding: 'utf8' });
if (nameE.status !== 0) throw new Error(`friends name E on B failed: ${nameE.stderr || nameE.stdout}`);
const describeE = spawnSync(bin, ['friends', 'describe', e.peerId, '喜欢收集星云与天文影像。', '--data-dir', dirB], { encoding: 'utf8' });
if (describeE.status !== 0) throw new Error(`friends describe E on B failed: ${describeE.stderr || describeE.stdout}`);

// Publish a real public-address-book entry so the profile's address tab has a
// verifiable claim while B is online.
const syncB = spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
if (syncB.status !== 0) throw new Error(`friends sync B failed: ${syncB.stderr || syncB.stdout}`);
const friendsJsonB = path.join(dirB, 'public', 'friends.json');
const claims = JSON.parse(fs.readFileSync(friendsJsonB, 'utf8')).friends || [];
if (!claims.some((item) => item.peer_id === a.peerId)) {
  throw new Error(`B public friends.json does not contain A: ${friendsJsonB}`);
}
if (!claims.some((item) => item.peer_id === e.peerId && item.name === 'star-collector')) {
  throw new Error(`B public friends.json does not contain the non-self E claim: ${friendsJsonB}`);
}

prepareDshHome();

const fixture = {
  root,
  generatedAt: new Date().toISOString(),
  hostPort,
  controlPort,
  dshHome,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeC: c.peerId,
  nodeG: g.peerId,
  nodeE: e.peerId,
  nodeD: d.peerId,
  nodeAData: dirA,
  nodeBData: dirB,
  nodeCData: dirC,
  nodeGData: dirG,
  nodeEData: dirE,
  nodeDData: dirD,
  nodeAAddr: addrAFinal,
  nodeBAddr: addrB,
  nodeCAddr: addrC,
  nodeGAddr: addrG,
  nodeEAddr: addrE,
  unreadCount: inboundIds.length,
  inboundMessageIds: inboundIds,
  offlinePeer: d.peerId,
  offlineName: D_NAME,
  localB: { name: 'lin-an', description: '潮汐线附近的联系人。' },
  localC: { name: 'chao-sheng', description: '没有消息，也没有公开头像。' },
  localG: { name: 'kong-bai', description: '在线，但没有公开档案。' },
  clueName: 'star-collector',
  clueDescription: '喜欢收集星云与天文影像。',
  publicB: { displayName: PUBLIC_B_NAME, description: PUBLIC_B_DESCRIPTION, style: PUBLIC_B_STYLE },
  publicC: { displayName: PUBLIC_C_NAME, description: PUBLIC_C_DESCRIPTION },
  avatar: { path: avatarPath, sha256: avatarSha, bytes: avatarBytes.length, source: avatarSource },
  post: { path: postEntry.path, sha256: downloadedPost.sha256, sizeBytes: Number(postEntry.size) },
  doc: { path: docEntry.path, sha256: downloadedDoc.sha256, sizeBytes: Number(docEntry.size) },
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
