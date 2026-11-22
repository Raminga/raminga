// Isolated second-batch item 6 fixture. Reuses the accepted first-batch A
// fixture so A/B are real local nodes with public posts, an ordinary public
// file and a real friendship, then removes A's legacy profile to exercise the
// empty public-state, seeds private markers, and wires the isolated DSH host.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { ConnectRequest, StatusRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B6_ACCEPTANCE_DIR
  ? path.resolve(process.env.B6_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-06-settings');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dshHome = path.join(root, 'dsh-home');
const hostPort = Number(process.env.B6_HOST_PORT || 4392);
const controlPort = Number(process.env.B6_CONTROL_PORT || 4357);
const bin = path.join(repoRoot, 'bin', 'raminga');
const a1Prepare = path.join(repoRoot, 'scripts', 'ui-acceptance', 'a1', 'prepare.mjs');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const controlSource = path.join(here, 'control-plugin');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-a1', 'post.png');
const markers = {
  persona: 'B2-06-PRIVATE-PERSONA-MARKER',
  growth: 'B2-06-PRIVATE-GROWTH-MARKER',
  memory: 'B2-06-PRIVATE-MEMORY-MARKER',
  draft: 'B2-06-PRIVATE-DRAFT-MARKER',
};
const oldProfile = {
  agentName: '旧潮汐 Agent',
  agentDescription: '旧版本简介：只在退潮时出门。',
  agentInterests: ['潮汐', '旧信'],
  agentConversationStyle: '缓慢、温和',
  humanName: '旧岸',
  humanBioMarkdown: '旧版本的人类介绍，喜欢把信留在窗边。',
};
const fullProfile = {
  agentName: '潮汐信使',
  agentDescription: '收集退潮后的信，也替人保管没有寄出的句子。',
  agentInterests: ['潮汐', '旧信', '星辰'],
  agentConversationStyle: '好奇、耐心，先听完再回答。',
  humanName: '岸灯',
  humanBioMarkdown: '喜欢在夜里整理旧信，也愿意认识新的朋友。',
};

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(a1Prepare)) throw new Error(`missing ${a1Prepare}`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
if (!fs.existsSync(avatarSource)) throw new Error(`missing avatar fixture: ${avatarSource}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : value);
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
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function wireDshHome() {
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
  pkg.dependencies['b2-06-control'] = `link:${controlSource}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh', 'b2-06-control');
  write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control', 'b2-06-control']) {
    fs.rmSync(path.join(modules, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { recursive: true, force: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  fs.symlinkSync(controlSource, path.join(modules, 'b2-06-control'), 'dir');
}

// Build the accepted real-node fixture, then stop both nodes while we change
// their private/public seed so the running content scan never sees a partial
// directory.
stop(dirA);
stop(dirB);
const prepared = spawnSync(process.execPath, [a1Prepare], {
  cwd: repoRoot,
  env: { ...process.env, A1_ACCEPTANCE_DIR: root, A1_HOST_PORT: String(hostPort) },
  encoding: 'utf8',
  timeout: 240000,
});
if (prepared.status !== 0) {
  throw new Error(`first-batch A fixture prepare failed:\n${prepared.stderr || prepared.stdout}`);
}
process.stdout.write(prepared.stdout);
stop(dirA);
stop(dirB);

// Empty public-profile state for the first screens. The ordinary hello.md and
// posts remain, so the public-file entry has real content.
fs.rmSync(path.join(dirA, 'public', 'profile'), { recursive: true, force: true });
fs.writeFileSync(path.join(dirA, 'public', 'hello.md'), '# 岸边的公开纸条\n\n这是第二批第 6 项隔离公开文件。\n');

// Private-only markers. contact-notes.json stays valid v2 JSON; the top-level
// marker field is ignored by the reader and must never appear in public.
write(path.join(dirA, 'agent', 'persona.md'), `# 私有人格\n\n${markers.persona}\n`);
write(path.join(dirA, 'agent', 'growth.md'), `# 成长\n\n${markers.growth}\n`);
write(path.join(dirA, 'agent', 'contact-notes.json'), `${JSON.stringify({
  schema_version: 2,
  private_marker: markers.memory,
  contacts: [],
}, null, 2)}\n`);

wireDshHome();

// Restart the isolated nodes after the filesystem seed.
start(dirB, 'node-b');
const apiB = await apiFor(dirB);
const b = await status(apiB, 'node B status');
const addrB = `${tcpAddr(b)}/p2p/${b.peerId}`;
start(dirA, 'node-a');
const apiA = await apiFor(dirA);
const a = await status(apiA, 'node A status');
const addrA = `${tcpAddr(a)}/p2p/${a.peerId}`;

await waitFor(async () => {
  try {
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: addrB, peerId: b.peerId })));
    return true;
  } catch { return false; }
}, 'connect A to B');
await waitFor(async () => {
  try {
    await apiB.call((client) => client.connect(new ConnectRequest({ multiaddr: addrA, peerId: a.peerId })));
    return true;
  } catch { return false; }
}, 'connect B to A');
await waitFor(async () => {
  const left = await apiA.call((client) => client.status(new StatusRequest()));
  return (left.peers || []).some((peer) => peer.peerId === b.peerId);
}, 'A sees B connected', 15000);

const fixture = {
  root,
  hostPort,
  controlPort,
  dshHome,
  nodeA: a.peerId,
  nodeB: b.peerId,
  nodeAAddr: addrA,
  nodeBAddr: addrB,
  nodeAData: dirA,
  nodeBData: dirB,
  avatarSource,
  markers,
  oldProfile,
  fullProfile,
  files: {
    hello: 'notes/hello.txt',
    profile: 'profile/profile.json',
    index: 'profile/index.md',
  },
  posts: {
    userId: 'posts/old-user.json',
    agentId: 'posts/old-agent.json',
    image: 'posts/a-image/post.json',
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify(fixture, null, 2));
