// Isolated first-batch-A fixture. It never touches ~/.raminga, the user's
// DSH_HOME, the real desktop, 4321/4332 or the p5 directories.
//
// A = the local node that opens the DSH workspace.
// B = a remote peer with a legacy v1 post, a current v2 post with an image, an
// Agent-authored post, profile, address book and ordinary attachments.
// A downloads the posts first and then 600 newer non-post files, so the mixed
// index starts with more than five full file pages. The post-candidate cursor
// must still reach every older post without a larger mixed-row cap.
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
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'ui-a1');
const root = process.env.A1_ACCEPTANCE_DIR
  ? path.resolve(process.env.A1_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'ui-refresh-20261117', 'a1');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dshHome = path.join(root, 'dsh-home');
const hostPort = Number(process.env.A1_HOST_PORT || 4354);
const BULK = 600;

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function read(file) { return fs.readFileSync(file); }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}
function replaceAll(value, replacements) {
  let out = value;
  for (const [key, replacement] of Object.entries(replacements)) out = out.split(key).join(String(replacement));
  return out;
}
function copyTemplate(template, target, replacements = {}) {
  write(target, replaceAll(fs.readFileSync(template, 'utf8'), replacements));
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
  const logFile = path.join(root, `${name}.log`);
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
  // The remote content route has a real per-peer token bucket; the fixture
  // paces real downloads instead of disabling production limits.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 320));
    try {
      return await downloadOnce(api, peerId, relative);
    } catch (error) {
      if (!/429|rate|限流|暂不可用/i.test(String(error?.message ?? error)) || attempt === 5) throw error;
    }
  }
  throw new Error(`download ${relative} exhausted retries`);
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
  const sourceHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
  if (!fs.existsSync(sourceHome)) throw new Error(`missing isolated DSH seed profile: ${sourceHome}`);
  fs.cpSync(sourceHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  delete pkg.dependencies['p4-activity-control'];
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => name !== 'p4-activity-control')
    .concat('@raminga/dsh')
    .filter((name, index, list) => list.indexOf(name) === index);
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.rmSync(path.join(modules, 'p4-activity-control'), { force: true });
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
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
let addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;

const image = read(path.join(fixtureRoot, 'post.png'));
const imageSha = sha256(image);
const imageName = `${imageSha}.png`;

// A: legacy profile, three v1 posts (user / Agent / unknown), one current v2
// image post and a normal public attachment.
copyTemplate(path.join(fixtureRoot, 'node-a', 'profile', 'index.md'), path.join(dirA, 'public', 'profile', 'index.md'), { __PEER_ID__: a.peerId });
for (const name of ['old-user.json', 'old-agent.json', 'old-unknown.json']) {
  copyTemplate(path.join(fixtureRoot, 'node-a', 'posts', name), path.join(dirA, 'public', 'posts', name), { __PEER_ID__: a.peerId });
}
write(path.join(dirA, 'public', 'posts', 'a-image', 'images', imageName), image);
copyTemplate(path.join(fixtureRoot, 'node-a', 'posts', 'a-image', 'post.json'), path.join(dirA, 'public', 'posts', 'a-image', 'post.json'), {
  __PEER_ID__: a.peerId, __IMAGE_NAME__: imageName, __IMAGE_SHA__: imageSha, __IMAGE_SIZE__: image.length,
});
write(path.join(dirA, 'public', 'hello.md'), '# 岸边的公开纸条\n\n这是一份 A1 隔离公开文件。\n');

// B: legacy v1 post, current v2 image post, Agent post, profile and files.
copyTemplate(path.join(fixtureRoot, 'node-b', 'profile', 'index.md'), path.join(dirB, 'public', 'profile', 'index.md'), { __PEER_ID__: b.peerId });
copyTemplate(path.join(fixtureRoot, 'node-b', 'posts', 'old-v1.json'), path.join(dirB, 'public', 'posts', 'old-v1.json'), { __PEER_ID__: b.peerId });
write(path.join(dirB, 'public', 'posts', 'b-image', 'images', imageName), image);
copyTemplate(path.join(fixtureRoot, 'node-b', 'posts', 'b-image', 'post.json'), path.join(dirB, 'public', 'posts', 'b-image', 'post.json'), {
  __PEER_ID__: b.peerId, __IMAGE_NAME__: imageName, __IMAGE_SHA__: imageSha, __IMAGE_SIZE__: image.length,
});
copyTemplate(path.join(fixtureRoot, 'node-b', 'posts', 'b-agent', 'post.json'), path.join(dirB, 'public', 'posts', 'b-agent', 'post.json'), { __PEER_ID__: b.peerId });
for (const name of ['hello.txt', 'broken.txt', 'old-note.md', 'download-me.txt']) {
  write(path.join(dirB, 'public', 'notes', name), read(path.join(fixtureRoot, 'node-b', 'notes', name)));
}

// A connects to B, then real human outbound makes B a familiar peer.
await waitFor(async () => {
  try {
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: addrB, peerId: b.peerId })));
    return true;
  } catch { return false; }
}, 'connect A to B');
await waitFor(async () => {
  const s = await apiA.call((client) => client.status(new StatusRequest()));
  return (s.peers || []).some((peer) => peer.peerId === b.peerId);
}, 'A sees B connected', 10000);
spawnSync(bin, ['friends', 'name', 'chengye', b.peerId, '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'name', 'linan', a.peerId, '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'describe', b.peerId, '在城南经营植物店。', '--data-dir', dirA], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'sync', '--data-dir', dirB], { encoding: 'utf8' });
spawnSync(bin, ['friends', 'sync', '--data-dir', dirA], { encoding: 'utf8' });
const sent = spawnSync(bin, ['chat', 'send', '--to', b.peerId, '--text', 'A1 真实交流关系', '--data-dir', dirA, '--json'], { encoding: 'utf8' });
if (sent.status !== 0) throw new Error(`chat send failed: ${sent.stderr || sent.stdout}`);

// Download the posts first, then 600 newer non-post files. Newer fetched_at
// values put every file ahead of the posts; only a candidate-filtered cursor
// can reach the posts without spending the mixed page budget.
const posts = ['posts/old-v1.json', 'posts/b-image/post.json', 'posts/b-agent/post.json'];
for (const relative of posts) await download(apiA, b.peerId, relative);
await download(apiA, b.peerId, `posts/b-image/images/${imageName}`);
for (const relative of ['profile/index.md', 'friends.json', 'notes/hello.txt', 'notes/broken.txt', 'notes/old-note.md']) {
  await download(apiA, b.peerId, relative);
}
// More than five full discovery pages of non-post rows, newer than the posts.
// They are inserted into the isolated fixture database (not the user's node)
// so the test can exercise the daemon's real 500-row boundary without issuing
// hundreds of downloads. The Feed never reads their bytes because none of
// them is a versioned post.
stop(dirA);
const dbPath = path.join(dirA, 'raminga.db');
const db = new DatabaseSync(dbPath);
try {
  const insert = db.prepare(`INSERT OR IGNORE INTO public_discoveries
    (peer_id, path, sha256, size_bytes, fetched_at_ms, source, sources_json)
    VALUES (?, ?, ?, ?, ?, 'raminga_content_get', ?)`);
  const base = Date.now() + 60_000;
  for (let index = 0; index < BULK; index += 1) {
    const name = `bulk-${String(index).padStart(3, '0')}.txt`;
    insert.run(b.peerId, `notes/bulk/${name}`, 'e'.repeat(64), 20, base + index,
      JSON.stringify(['raminga_content_get']));
  }
  // The historical attachment is the newest peer-file evidence, so the
  // bounded peer-file fallback can still include it while 600 newer ordinary
  // files sit between the posts and today. It does not affect the Feed: its
  // path is not a post candidate.
  db.prepare(`UPDATE public_discoveries SET fetched_at_ms = ?
    WHERE peer_id = ? AND path = 'notes/old-note.md'`).run(base + BULK + 50, b.peerId);
} finally {
  db.close();
}
start(dirA, 'node-a');
const restartedA = await status(apiA, 'node A after fixture rows');
addrA = `${tcpAddr(restartedA)}/p2p/${restartedA.peerId}`;

// The valid attachment stays readable. The broken attachment keeps the same
// byte size but no longer matches the discovery hash, so file readers must
// report a version mismatch with technical detail instead of showing new text.
const brokenPath = path.join(dirA, 'downloads', b.peerId, 'notes', 'broken.txt');
const brokenBytes = read(brokenPath);
brokenBytes[0] = brokenBytes[0] === 0x21 ? 0x3f : 0x21;
fs.writeFileSync(brokenPath, brokenBytes);
// Historical attachment: remove it from B after A has a verified copy.
fs.rmSync(path.join(dirB, 'public', 'notes', 'old-note.md'), { force: true });

prepareDshHome();

const fixture = {
  root,
  hostPort,
  dshHome,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeAAddr: addrA,
  nodeBAddr: addrB,
  nodeAData: dirA,
  nodeBData: dirB,
  posts: {
    aLegacyUser: 'posts/old-user.json',
    aLegacyAgent: 'posts/old-agent.json',
    aLegacyUnknown: 'posts/old-unknown.json',
    aImage: 'posts/a-image/post.json',
    bLegacy: 'posts/old-v1.json',
    bImage: 'posts/b-image/post.json',
    bAgent: 'posts/b-agent/post.json',
  },
  files: {
    hello: 'notes/hello.txt',
    broken: 'notes/broken.txt',
    historical: 'notes/old-note.md',
    download: 'notes/download-me.txt',
    contacts: 'friends.json',
    profile: 'profile/index.md',
  },
  imagePath: `posts/b-image/images/${imageName}`,
  imageSha,
  bulkCount: BULK,
  generatedAt: new Date().toISOString(),
};
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify(fixture, null, 2));
