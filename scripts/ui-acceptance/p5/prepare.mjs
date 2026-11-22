// Prepare an isolated two-node P5 fixture plus a pristine schema-9 upgrade
// directory and an isolated DSH profile. Everything lives under
// .local/ui-refresh-20261117/p5 by default. This script never touches
// ~/.raminga, the DSH config used by the user, the 4321 host,
// .local/ui-implementation, or the 4332/4333 P4 acceptance host.
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
  PublishedRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'ui-refresh');
const root = process.env.P5_ACCEPTANCE_DIR
  ? path.resolve(process.env.P5_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p5');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const upgradeDir = path.join(root, 'upgrade-v9');
const upgradeBase = path.join(root, 'upgrade-base');
const dshHome = path.join(root, 'dsh-home');
let nodeBAddr = '';
const controlPlugin = path.join(here, 'control-plugin');
const JOURNEY = 'session-p5-01';

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function read(file) {
  return fs.readFileSync(file);
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (Buffer.isBuffer(value)) fs.writeFileSync(file, value);
  else fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
function replaceAll(value, replacements) {
  let out = value;
  for (const [key, replacement] of Object.entries(replacements)) {
    out = out.split(key).join(String(replacement));
  }
  return out;
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
  const logFile = path.join(dir, 'daemon.log');
  fs.rmSync(pidFile, { force: true });
  const child = spawnDetached(bin, ['daemon', '--data-dir', dir], logFile);
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
    } catch (error) {
      last = error;
    }
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
function copyTemplate(template, target, replacements) {
  write(target, replaceAll(fs.readFileSync(template, 'utf8'), replacements));
}
function placeholder(value) {
  return `__${value}__`;
}

function seedNodeAHistory() {
  stop(dirA);
  const db = new DatabaseSync(path.join(dirA, 'raminga.db'));
  try {
    const baseline = Date.now() - 2 * 60 * 60 * 1000;
    const insert = db.prepare(`INSERT OR REPLACE INTO messages
      (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
       origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 120; i += 1) {
      const at = baseline + i * 1000;
      insert.run(
        `hist-p5-in-${String(i + 1).padStart(3, '0')}`,
        b.peerId,
        'in',
        `升级前历史消息 ${i + 1}：这条消息用于验证会话分页与返回位置。`,
        1,
        at,
        at,
        'unknown',
        'received',
        '',
        at,
        '',
      );
    }
    for (let i = 0; i < 3; i += 1) {
      const at = baseline - (3 - i) * 1000;
      insert.run(
        `hist-p5-out-${String(i + 1).padStart(3, '0')}`,
        b.peerId,
        'out',
        `升级前本人回复 ${i + 1}：只用于本地会话回归。`,
        1,
        at,
        at,
        'human',
        'acked',
        '',
        at,
        '',
      );
    }
    const latest = baseline + 119 * 1000;
    db.prepare(`INSERT OR REPLACE INTO conversation_read_state
      (peer_id, last_read_at_ms, last_read_message_id, updated_at_ms)
      VALUES (?, ?, ?, ?)`).run(
      b.peerId,
      latest,
      'hist-p5-in-120',
      latest,
    );
  } finally {
    db.close();
  }
  start(dirA, 'node-a');
}

function writeUpgradeDatabase(dbPath, bPeer) {
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at_ms) VALUES (9, 1);
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL
          CHECK (direction IN ('in','out')), text TEXT NOT NULL,
        acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0,1)),
        created_at_ms INTEGER NOT NULL, acked_at_ms INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'unknown',
        delivery_status TEXT NOT NULL DEFAULT 'unknown',
        delivery_error TEXT NOT NULL DEFAULT '',
        delivery_updated_at_ms INTEGER NOT NULL DEFAULT 0,
        client_request_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX messages_created_idx ON messages (created_at_ms DESC);
      CREATE INDEX messages_created_id_idx ON messages (created_at_ms DESC, message_id DESC);
      CREATE INDEX messages_peer_created_idx ON messages (peer_id, created_at_ms DESC, message_id DESC);
      CREATE TABLE human_outbound_peers (peer_id TEXT PRIMARY KEY, first_at_ms INTEGER NOT NULL, last_at_ms INTEGER NOT NULL);
      CREATE INDEX human_outbound_peers_last_idx ON human_outbound_peers (last_at_ms DESC, peer_id DESC);
      CREATE TABLE public_discoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL, path TEXT NOT NULL,
        sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, fetched_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]', UNIQUE(peer_id, path, sha256)
      );
      CREATE INDEX public_discoveries_fetched_idx ON public_discoveries (fetched_at_ms DESC, id DESC);
      CREATE INDEX public_discoveries_peer_idx ON public_discoveries (peer_id);
      CREATE TABLE known_peers (
        peer_id TEXT PRIMARY KEY, addrs_json TEXT NOT NULL, source TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE outbox (
        message_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, text TEXT NOT NULL,
        bytes INTEGER NOT NULL, multiaddr TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending','acked','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL, next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX outbox_due_idx ON outbox (status, next_attempt_at_ms);
      CREATE TABLE friends (
        peer_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
        addrs_json TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '',
        manually_connected INTEGER NOT NULL DEFAULT 0 CHECK (manually_connected IN (0,1)),
        first_seen_ms INTEGER NOT NULL, last_interaction_ms INTEGER NOT NULL,
        relay_capable INTEGER NOT NULL DEFAULT 0, dht_capable INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX friends_name_unique ON friends(name) WHERE name <> '';
      CREATE TABLE paused_peers (peer_id TEXT PRIMARY KEY, paused_at_ms INTEGER NOT NULL);
    `);
    const now = Date.now();
    const insertMessage = db.prepare(`INSERT INTO messages
      (message_id, peer_id, direction, text, acked, created_at_ms, acked_at_ms,
       origin, delivery_status, delivery_error, delivery_updated_at_ms, client_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertMessage.run('old-in-1', bPeer, 'in', '升级前的第一条消息：雨声很好听。', 1, now - 90000, now - 90000, 'unknown', 'received', '', now - 90000, '');
    insertMessage.run('old-in-2', bPeer, 'in', '升级前的第二条消息：旧联系人还在。', 1, now - 60000, now - 60000, 'unknown', 'received', '', now - 60000, '');
    insertMessage.run('old-out-1', bPeer, 'out', '升级前的回复：那就把雨声记下来。', 1, now - 30000, now - 30000, 'human', 'acked', '', now - 30000, '');
    insertMessage.run('old-out-2', bPeer, 'out', '升级前的待确认旧消息。', 1, now - 20000, now - 20000, 'human', 'acked', '', now - 20000, '');
    const insertFriend = db.prepare(`INSERT INTO friends
      (peer_id, name, addrs_json, description, manually_connected, first_seen_ms, last_interaction_ms, relay_capable, dht_capable)
      VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0)`);
    insertFriend.run(bPeer, '旧联系人·澄野', JSON.stringify([nodeBAddr]), '升级前的联系人备注（私有）', now - 100000, now - 20000);
    db.prepare(`INSERT INTO human_outbound_peers (peer_id, first_at_ms, last_at_ms) VALUES (?, ?, ?)`)
      .run(bPeer, now - 40000, now - 20000);
    db.prepare(`INSERT INTO known_peers (peer_id, addrs_json, source, updated_at_ms, expires_at_ms)
      VALUES (?, ?, 'manual', ?, 0)`).run(bPeer, JSON.stringify([nodeBAddr]), now - 100000);
    db.prepare(`INSERT INTO outbox
      (message_id, peer_id, text, bytes, multiaddr, status, attempts, created_at_ms, expires_at_ms, next_attempt_at_ms, last_error, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 'acked', 1, ?, ?, 0, '', ?)`)
      .run('old-out-2', bPeer, '升级前的待确认旧消息。', Buffer.byteLength('升级前的待确认旧消息。'), nodeBAddr, now - 20000, now + 86400000, now - 19000);
    db.prepare(`INSERT INTO public_discoveries
      (peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
      VALUES (?, ?, ?, ?, ?, 'raminga_content_get', ?)`)
      .run(bPeer, 'posts/p5-b2/post.json', b2Sha, b2.length, now - 50000, JSON.stringify(['raminga_content_get']));
  } finally {
    db.close();
  }
}

function createUpgradeFixture() {
  stop(upgradeBase);
  init(upgradeBase);
  const dbPath = path.join(upgradeBase, 'raminga.db');
  writeUpgradeDatabase(dbPath, b.peerId);

  const upgrades = {
    __PEER_ID__: upgradePeerId,
  };
  copyTemplate(path.join(fixtureRoot, 'upgrade', 'profile', 'index.md'), path.join(upgradeBase, 'public', 'profile', 'index.md'), upgrades);
  copyTemplate(path.join(fixtureRoot, 'upgrade', 'profile', 'agent-card.json'), path.join(upgradeBase, 'public', 'profile', 'agent-card.json'), upgrades);
  copyTemplate(path.join(fixtureRoot, 'upgrade', 'posts', 'legacy-user.json'), path.join(upgradeBase, 'public', 'posts', 'legacy-user.json'), upgrades);
  copyTemplate(path.join(fixtureRoot, 'upgrade', 'posts', 'legacy-agent.json'), path.join(upgradeBase, 'public', 'posts', 'legacy-agent.json'), upgrades);
  fs.mkdirSync(path.join(upgradeBase, 'agent'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(fixtureRoot, 'upgrade', 'agent', 'contact-notes.json'), path.join(upgradeBase, 'agent', 'contact-notes.json'));
  write(path.join(upgradeBase, 'agent', 'persona.md'), '# 旧岸灯 · persona\n\n- 升级前就存在的私有人设。\n');
  write(path.join(upgradeBase, 'agent', 'growth.md'), '# 旧岸灯 · growth\n\n- 升级前就存在的成长记录。\n');
  // A downloaded copy proves the pre-existing discovery row remains readable
  // after migration without inventing a new acquisition.
  const downloadDir = path.join(upgradeBase, 'downloads', b.peerId, 'posts', 'p5-b2');
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.copyFileSync(path.join(dirB, 'public', 'posts', 'p5-b2', 'post.json'), path.join(downloadDir, 'post.json'));
  // Legacy v1 view state is kept next to the data dir so upgrade-check.mjs can
  // compare the same exported normalizer the DSH adapter uses.
  copyTemplate(path.join(fixtureRoot, 'viewstate-v1.json'), path.join(upgradeBase, 'viewstate-v1.json'), upgrades);
  fs.chmodSync(path.join(upgradeBase, 'agent'), 0o700);
  fs.chmodSync(path.join(upgradeBase, 'agent', 'contact-notes.json'), 0o600);

  fs.rmSync(upgradeDir, { recursive: true, force: true });
  fs.cpSync(upgradeBase, upgradeDir, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(upgradeBase, { recursive: true, force: true });
}

function prepareDshHome() {
  fs.rmSync(dshHome, { recursive: true, force: true });
  const sourceHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
  if (!fs.existsSync(sourceHome)) throw new Error(`missing isolated DSH seed profile: ${sourceHome}`);
  fs.cpSync(sourceHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  delete pkg.dependencies['p4-activity-control'];
  pkg.dependencies['p5-acceptance-control'] = `link:${controlPlugin}`;
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  pkg.dsh.profile.bundles = bundles
    .filter((name) => name !== 'p4-activity-control')
    .concat(bundles.includes('@raminga/dsh') ? [] : ['@raminga/dsh'])
    .concat(bundles.includes('p5-acceptance-control') ? [] : ['p5-acceptance-control']);
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.rmSync(path.join(modules, 'p4-activity-control'), { force: true });
  fs.rmSync(path.join(modules, 'p5-acceptance-control'), { force: true });
  fs.symlinkSync(controlPlugin, path.join(modules, 'p5-acceptance-control'), 'dir');
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  return dshHome;
}

// ---------------------------------------------------------------------------
// Build the fixture.
stop(dirA);
stop(dirB);
init(dirA);
init(dirB);

const apiB = await apiFor(dirB);
start(dirB, 'node-b');
const b = await status(apiB, 'node B status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
nodeBAddr = addrB;

let apiA = await apiFor(dirA);
start(dirA, 'node-a');
let a = await status(apiA, 'node A initial status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;
const upgradePeerId = a.peerId;
// First start created the v11 DB. Stop A, seed old history, then restart.
seedNodeAHistory();
apiA = await apiFor(dirA);
a = await status(apiA, 'node A reseeded status');

// Public files for A (legacy profile only, no profile.json).
copyTemplate(path.join(fixtureRoot, 'node-a', 'profile', 'index.md'), path.join(dirA, 'public', 'profile', 'index.md'), { __PEER_ID__: a.peerId });
copyTemplate(path.join(fixtureRoot, 'node-a', 'profile', 'agent-card.json'), path.join(dirA, 'public', 'profile', 'agent-card.json'), { __PEER_ID__: a.peerId });
copyTemplate(path.join(fixtureRoot, 'node-a', 'posts', 'p5-a-legacy-user.json'), path.join(dirA, 'public', 'posts', 'p5-a-legacy-user.json'), { __PEER_ID__: a.peerId });
copyTemplate(path.join(fixtureRoot, 'node-a', 'posts', 'p5-a-legacy-agent.json'), path.join(dirA, 'public', 'posts', 'p5-a-legacy-agent.json'), { __PEER_ID__: a.peerId });
write(path.join(dirA, 'public', 'hello.md'), '# 岸边的公开纸条\n\n这是一份 P5 双节点公开文件。\n');

// Public files for B: profile.json v2 + avatar + two posts (one with image).
const avatar = read(path.join(fixtureRoot, 'avatar.png'));
const avatarSha = sha256(avatar);
const avatarName = `avatar-${avatarSha.slice(0, 8)}.png`;
write(path.join(dirB, 'public', 'profile', avatarName), avatar);
copyTemplate(path.join(fixtureRoot, 'node-b', 'profile', 'profile.json'), path.join(dirB, 'public', 'profile', 'profile.json'), {
  __PEER_ID__: b.peerId,
  __AVATAR_SHA__: avatarSha,
  __AVATAR_SHA8__: avatarSha.slice(0, 8),
});
copyTemplate(path.join(fixtureRoot, 'node-b', 'profile', 'index.md'), path.join(dirB, 'public', 'profile', 'index.md'), { __PEER_ID__: b.peerId });
const postImage = read(path.join(fixtureRoot, 'post.png'));
const postImageSha = sha256(postImage);
const postImageName = `${postImageSha}.png`;
write(path.join(dirB, 'public', 'posts', 'p5-b1', 'images', postImageName), postImage);
copyTemplate(path.join(fixtureRoot, 'node-b', 'posts', 'p5-b1', 'post.json'), path.join(dirB, 'public', 'posts', 'p5-b1', 'post.json'), {
  __PEER_ID__: b.peerId,
  __IMAGE_NAME__: postImageName,
  __IMAGE_SHA__: postImageSha,
  __IMAGE_SIZE__: postImage.length,
});
copyTemplate(path.join(fixtureRoot, 'node-b', 'posts', 'p5-b2', 'post.json'), path.join(dirB, 'public', 'posts', 'p5-b2', 'post.json'), { __PEER_ID__: b.peerId });
const b2 = read(path.join(dirB, 'public', 'posts', 'p5-b2', 'post.json'));
const b2Sha = sha256(b2);

// A connects to B, creating the real local friend records on both sides.
await waitFor(async () => {
  try {
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: addrB, peerId: b.peerId })));
    return true;
  } catch {
    return false;
  }
}, 'connect A to B');
await waitFor(async () => {
  const s = await apiA.call((client) => client.status(new StatusRequest()));
  return (s.peers || []).some((peer) => peer.peerId === b.peerId);
}, 'A sees B connected', 10000);
// Stable display names for the local cards and conversation headers. Names are
// local aliases; the public profile display name remains the remote claim.
spawnSync(bin, ['friends', 'name', 'chengye', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', b.peerId, '在城南经营植物店，喜欢雨声。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'linan', a.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', a.peerId, '海边的产品设计师。', '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'sync', '--data-dir', dirA], { encoding: 'utf8' });

// Private Agent data for A: a real Journey fixture and an evidence-backed
// private impression for B. This is used by contact-profile, timeline and
// Journey evidence checks; it is never copied into public/.
const journeyDir = path.join(dirA, 'agent', 'sessions', JOURNEY);
fs.rmSync(journeyDir, { recursive: true, force: true });
write(path.join(journeyDir, 'state.json'), {
  schema_version: 1,
  session_id: JOURNEY,
  status: 'running',
  mode: 'exploration',
  intent: 'P5 验收：读取澄野的公开植物记录，并保留真实工具证据。',
  limits: { max_visits: 5, max_candidates_per_step: 8, max_chat_round_trips_per_peer: 3, reply_timeout_seconds: 30, max_duration_seconds: 600 },
  discovery_sources: ['local friends'],
  current_peer_id: b.peerId,
  visited_peer_ids: [],
  skipped_peer_ids: [],
  curiosity: [],
  started_at: '2026-11-18T08:00:00Z',
  updated_at: '2026-11-18T08:00:02Z',
  completed_at: null,
  completion_reason: null,
});
write(path.join(journeyDir, 'events.jsonl'), `${JSON.stringify({
  schema_version: 1,
  event_id: 'evt-p5-1',
  sequence: 1,
  timestamp: '2026-11-18T08:00:02Z',
  type: 'visit_started',
  peer_id: b.peerId,
  source_peer_id: null,
  summary: '验收 Journey 开始读取澄野的公开植物记录。',
  evidence_refs: { message_ids: [], content_paths: [], event_ids: [] },
  message_evidence: null,
})}\n`);
write(path.join(journeyDir, 'report.md'), '# Journey Report\n\n- **Session ID:** session-p5-01\n- **Status:** running\n\n## 1. Journey overview\n\nP5 真实工具活动与 Journey 关联验收。\n\n## 2. Travel route\n\n- 澄野（等待读取公开内容）。\n\n## 3. New discoveries\n\n尚未完成。\n');
write(path.join(dirA, 'agent', 'persona.md'), '# 岸灯 · 私有人设\n\n- 稳定特质：慢热、观察细致、不急着下结论。\n- 表达风格：短句，先描述看到的事实，再说自己的猜测。\n- 交流偏好：喜欢听对方讲具体的日常细节。\n- 隐私边界：不把私有人设、成长和联系人印象发给远端。\n');
write(path.join(dirA, 'agent', 'growth.md'), '# 岸灯 · 成长提案\n\n- 待确认：学习在对话里更直接地表达不同意见。\n- 证据：最近三次交流都先附和、后补充。\n');
write(path.join(dirA, 'agent', 'contact-notes.json'), {
  schema_version: 2,
  contacts: [{
    peer_id: b.peerId,
    display_name_snapshot: '澄野',
    updated_at: '2026-11-18T08:10:00Z',
    observations: [{
      id: 'obs-p5-1',
      summary: '澄野公开了一张雨停后的城市植物照片，并说苔藓比昨天更绿。',
      observed_at: '2026-11-18T08:05:00Z',
      evidence_refs: {
        session_ids: [JOURNEY],
        event_ids: ['evt-p5-1'],
        message_ids: ['hist-p5-in-120'],
        content_paths: ['posts/p5-b1/post.json'],
        content_sha256: [],
      },
    }],
    impressions: [{
      id: 'imp-p5-1',
      summary: '只在私下记住：澄野喜欢雨声，也愿意把很小的细节讲清楚。',
      uncertainty: 'medium',
      created_at: '2026-11-18T08:10:00Z',
      updated_at: '2026-11-18T08:10:00Z',
      evidence_refs: { session_ids: [JOURNEY], event_ids: ['evt-p5-1'], message_ids: [], content_paths: ['posts/p5-b1/post.json'], content_sha256: [] },
    }],
    curiosities: [{
      id: 'cur-p5-1',
      question: '下次可以问：那张旧唱片的反面录了什么？',
      created_at: '2026-11-18T08:11:00Z',
      evidence_refs: { session_ids: [JOURNEY], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] },
    }],
  }],
});
fs.chmodSync(path.join(dirA, 'agent'), 0o700);
fs.chmodSync(journeyDir, 0o700);
for (const file of ['persona.md', 'growth.md', 'contact-notes.json']) fs.chmodSync(path.join(dirA, 'agent', file), 0o600);
for (const name of ['activity.jsonl', 'activity.1.jsonl']) fs.rmSync(path.join(dirA, 'agent', name), { force: true });
fs.rmSync(path.join(dirA, 'downloads'), { recursive: true, force: true });
fs.rmSync(path.join(dirA, 'publication'), { recursive: true, force: true });

createUpgradeFixture();
prepareDshHome();

const publishedA = await apiA.call((client) => client.published(new PublishedRequest()));
const publishedB = await apiB.call((client) => client.published(new PublishedRequest()));
const fixture = {
  root,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeAAddr: addrA,
  nodeBAddr: addrB,
  hostPort: 4344,
  controlPort: 4346,
  controlUrl: 'http://127.0.0.1:4346/run',
  nodeAData: dirA,
  nodeBData: dirB,
  dshHome,
  journey: JOURNEY,
  journeyDir,
  bProfilePath: 'posts/p5-b1/post.json',
  bProfileSha: sha256(read(path.join(dirB, 'public', 'posts', 'p5-b1', 'post.json'))),
  bAgentPostPath: 'posts/p5-b2/post.json',
  bAgentPostSha: sha256(read(path.join(dirB, 'public', 'posts', 'p5-b2', 'post.json'))),
  bImagePath: `posts/p5-b1/images/${postImageName}`,
  bImageSha: postImageSha,
  bAvatarPath: `profile/${avatarName}`,
  bAvatarSha: avatarSha,
  aLegacyUserPath: 'posts/p5-a-legacy-user.json',
  aLegacyAgentPath: 'posts/p5-a-legacy-agent.json',
  upgradeDir,
  upgradePeerId,
  history: { count: 120, first: 'hist-p5-in-001', last: 'hist-p5-in-120' },
  publishedA: publishedA.files.length,
  publishedB: publishedB.files.length,
  generatedAt: new Date().toISOString(),
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
