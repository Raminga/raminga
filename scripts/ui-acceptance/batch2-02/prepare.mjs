// Isolated second-batch item 2 fixture: a real contact list with a verified
// public avatar, a long public name without avatar, an offline local-only row,
// real unread messages and one real public-address-book clue.
//
// Everything lives under .local/prototype-remediation/b2-contacts by default
// and never touches ~/.raminga, the user's DSH_HOME, the real desktop, 4354,
// 4362, 4366, 4370 or any previous acceptance fixture.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { stopRecordedHosts } from './cleanup.mjs';
import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DisconnectPeerRequest,
  ListMessagesRequest,
  OutboxListRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.B2_ACCEPTANCE_DIR
  ? path.resolve(process.env.B2_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-contacts');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dirC = path.join(root, 'node-c');
const dirE = path.join(root, 'node-e');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-refresh', 'avatar.png');
const controlPort = Number(process.env.B2_CONTROL_PORT || 4339);
const hostPort = Number(process.env.B2_HOST_PORT || 4372);
const INBOUND = 7;
const FILLERS = 8;
const D_PEER = `12D3KooWB2ContactsOfflineD${'x'.repeat(28)}`;
const D_NAME = 'offline-contact-with-long-name-1';
const PUBLIC_B_NAME = '潮汐线旁的林岸';
const PUBLIC_B_DESCRIPTION = '慢一点回信，先把海边的事看完。喜欢潮汐、旧信和雨声。';
const PUBLIC_C_NAME = '潮声与旧信记录者·在岸边整理每一次潮汐退去后的细节';
const PUBLIC_C_DESCRIPTION = '把潮水退去以后留下的石阶、盐味和没有寄出的信记下来。';

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
function writePublicProfile(dir, { displayName, description, interests, style, withAvatar }) {
  const profileDir = path.join(dir, 'public', 'profile');
  write(path.join(profileDir, 'index.md'), `# ${displayName}\n\n${description}\n`);
  if (withAvatar) {
    fs.mkdirSync(profileDir, { recursive: true });
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
    human: { name: '林岸', bio_markdown: '住在潮汐线附近，收集旧信和雨声。' },
    updated_at: iso(5 * 60 * 1000),
  });
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
  pkg.dependencies['b2-contacts-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'b2-contacts-control');
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control', 'b2-contacts-control']) {
    fs.rmSync(path.join(modules, name), { force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'b2-contacts-control'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
// A previous acceptance run may have crashed before stopping its DSH Web host.
// Kill only the process recorded by this fixture, then stop/recreate the nodes.
stopRecordedHosts(root);
for (const dir of [dirA, dirB, dirC, dirE]) stop(dir);
for (const dir of [dirA, dirB, dirC, dirE]) init(dir);

const apiB = await apiFor(dirB);
const apiC = await apiFor(dirC);
const apiE = await apiFor(dirE);
start(dirB, 'node-b');
start(dirC, 'node-c');
start(dirE, 'node-e');
const b = await status(apiB, 'node B status');
const c = await status(apiC, 'node C status');
const e = await status(apiE, 'node E status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
const addrC = `${tcpAddr(c)}/p2p/${c.peerId}`;
const addrE = `${tcpAddr(e)}/p2p/${e.peerId}`;

writePublicProfile(dirB, {
  displayName: PUBLIC_B_NAME,
  description: PUBLIC_B_DESCRIPTION,
  interests: ['潮汐', '旧信', '雨声'],
  style: '不急着追问，喜欢把一句话放一会儿。',
  withAvatar: true,
});
writePublicProfile(dirC, {
  displayName: PUBLIC_C_NAME,
  description: PUBLIC_C_DESCRIPTION,
  interests: ['潮声', '旧信'],
  style: '先记录，再慢慢回信。',
  withAvatar: false,
});
write(path.join(dirE, 'public', 'profile', 'index.md'), '# 星云收集者\n\n喜欢收集星云与天文影像。\n');
write(path.join(dirE, 'public', 'profile', 'agent-card.json'), {
  schema_version: 1,
  display_name: '星云收集者',
  description: '喜欢收集星云与天文影像。',
  interests: ['星云', '天文'],
  conversation_style: '慢慢分享最近看到的星光。',
  updated_at: iso(20 * 60 * 1000),
});

const apiA = await apiFor(dirA);
start(dirA, 'node-a');
const a = await status(apiA, 'node A status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;

await connect(apiA, b.peerId, addrB, 'connect A to B');
await connect(apiA, c.peerId, addrC, 'connect A to C');
await waitPeers(apiA, [b.peerId, c.peerId]);

// Both directions are real connections, so B's generated friends.json lists A.
await connect(apiB, a.peerId, addrA, 'connect B to A');
await connect(apiB, c.peerId, addrC, 'connect B to C');
await connect(apiB, e.peerId, addrE, 'connect B to E');
await waitPeers(apiB, [a.peerId, c.peerId, e.peerId]);

const inboundIds = [];
for (let index = 0; index < INBOUND; index += 1) {
  const text = index === INBOUND - 1
    ? '最后一条未读：窗口还开着，潮声也还在。'
    : `第 ${index + 1} 封回信：潮水退到石阶下面。我把今天看见的盐味、旧邮票和没寄出的句子留在这里，等你回来再一起读。`;
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: a.peerId,
    multiaddr: addrA,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `b2-inbound-${String(index + 1).padStart(2, '0')}`,
  })), `send inbound ${index + 1}`);
  const id = String(result.messageId || '');
  if (!id) throw new Error(`inbound ${index + 1} was not persisted`);
  inboundIds.push(id);
}

spawnSync(bin, ['friends', 'name', 'lin-an', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', b.peerId, '潮汐线附近的联系人。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'chao-sheng', c.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', c.peerId, '没有消息，也没有公开头像。', '--data-dir', dirA], { encoding: 'utf8' });

spawnSync(bin, ['friends', 'name', 'xiao-zhou', a.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', a.peerId, '把回信留在同一个窗口里的人。', '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'chao-sheng', c.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'star-collector', e.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', e.peerId, '喜欢收集星云与天文影像。', '--data-dir', dirB], { encoding: 'utf8' });
const syncB = spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
if (syncB.status !== 0) throw new Error(`friends sync B failed: ${syncB.stderr || syncB.stdout}`);
const friendsJsonB = path.join(dirB, 'public', 'friends.json');
const claims = JSON.parse(fs.readFileSync(friendsJsonB, 'utf8')).friends || [];
if (!claims.some((item) => item.peer_id === e.peerId)) {
  throw new Error(`B public friends.json does not contain the clue peer: ${friendsJsonB}`);
}

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

// E is a real node used to create a real public-address-book claim. It is
// stopped before the UI test so a clue view has no reachable target to dial.
stop(dirE);

// Stop A to add local-only rows (offline contact + scroll fillers). These are
// local friend records, not remote reads or invented directory claims.
stop(dirA);
const db = new DatabaseSync(path.join(dirA, 'raminga.db'));
try {
  const insert = db.prepare(`INSERT OR REPLACE INTO friends
    (peer_id,name,addrs_json,description,manually_connected,first_seen_ms,last_interaction_ms,relay_capable,dht_capable)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const stamp = Date.now();
  insert.run(D_PEER, D_NAME, '[]',
    '对方没有公开 Agent 卡片；本机只保留了这条联系人记录。', 0,
    stamp - 20 * 60 * 1000, stamp - 19 * 60 * 1000, 0, 0);
  for (let index = 1; index <= FILLERS; index += 1) {
    const suffix = String(index).padStart(2, '0');
    insert.run(`12D3KooWB2ContactsFiller${'x'.repeat(30)}${suffix}`, `zz-filler-${suffix}`,
      '[]', index === 1 ? '仅用于列表滚动的本机记录。' : '', 1,
      stamp - index * 1000, stamp - index * 500, 0, 0);
  }
} finally {
  db.close();
}
start(dirA, 'node-a');
const restartedA = await status(apiA, 'node A after fixtures');
const addrAFinal = `${tcpAddr(restartedA)}/p2p/${restartedA.peerId}`;
await connect(apiA, b.peerId, addrB, 'reconnect A to B after fixtures');
await connect(apiA, c.peerId, addrC, 'reconnect A to C after fixtures');
await waitPeers(apiA, [b.peerId, c.peerId]);

// B still holds a socket to the pre-restart A process. Close it explicitly
// before reconnecting so the fixture's first UI-driven send cannot reuse a
// dead connection (the previous "A did not retain the new unread message"
// failure).
try {
  await apiB.call((client) => client.disconnectPeer(new DisconnectPeerRequest({ peerId: a.peerId })));
} catch {
  // B may have already dropped the stale socket.
}
await connect(apiB, a.peerId, addrAFinal, 'reconnect B to A after fixture restart');
await connect(apiB, c.peerId, addrC, 'reconnect B to C after fixture restart');
await waitPeers(apiB, [a.peerId, c.peerId]);
await waitPeers(apiA, [b.peerId, c.peerId]);

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
  nodeE: e.peerId,
  nodeAData: dirA,
  nodeBData: dirB,
  nodeCData: dirC,
  nodeEData: dirE,
  nodeAAddr: addrAFinal,
  nodeBAddr: addrB,
  nodeCAddr: addrC,
  nodeEAddr: addrE,
  unreadCount: inboundIds.length,
  inboundMessageIds: inboundIds,
  offlinePeer: D_PEER,
  offlineName: D_NAME,
  cluePeer: e.peerId,
  clueName: 'star-collector',
  clueDescription: '喜欢收集星云与天文影像。',
  localB: { name: 'lin-an', description: '潮汐线附近的联系人。' },
  localC: { name: 'chao-sheng', description: '没有消息，也没有公开头像。' },
  publicB: { displayName: PUBLIC_B_NAME, description: PUBLIC_B_DESCRIPTION },
  publicC: { displayName: PUBLIC_C_NAME, description: PUBLIC_C_DESCRIPTION },
  avatar: { path: avatarPath, sha256: avatarSha, bytes: avatarBytes.length, source: avatarSource },
  fillerCount: FILLERS,
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
