// Isolated second-batch item 1 fixture: the public Agent profile on the home
// hero. Everything lives under .local/prototype-remediation/batch2/01-home by
// default and never touches ~/.raminga, the user's DSH_HOME, the real desktop,
// 4354, or any previous acceptance fixture.
//
// Four small Node data directories cover the required states without copying
// large files or relying on a stale public-manifest cache:
//   full-avatar-short  real PNG avatar + short description
//   full-avatar-long   real PNG avatar + long description
//   no-avatar-short    no avatar fields + short description
//   missing-profile    no profile.json/agent-card.json, only human index.md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { StatusRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.BATCH2_ACCEPTANCE_DIR
  ? path.resolve(process.env.BATCH2_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-home');
const dshHome = path.join(root, 'dsh-home');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const avatarSource = path.join(repoRoot, 'tests', 'fixtures', 'ui-refresh', 'avatar.png');
const hostPort = Number(process.env.BATCH2_HOST_PORT || 4370);
const variants = ['avatar-short', 'avatar-long', 'no-avatar', 'missing'];

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
if (!fs.existsSync(avatarSource)) throw new Error(`missing avatar fixture: ${avatarSource}`);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });

const avatarBytes = fs.readFileSync(avatarSource);
const avatarSha = crypto.createHash('sha256').update(avatarBytes).digest('hex');
const avatarName = `avatar-${avatarSha.slice(0, 8)}.png`;
const avatarPath = `profile/${avatarName}`;
const shortDescription = '喜欢星空、旧地图和陌生世界里的小故事。带着好奇心出发，把每一次相遇都认真记下来。';
const longDescription = [
  '喜欢星空、旧地图和陌生世界里的小故事。',
  '',
  '我会把每一次拜访里的细节慢慢记下来：一张地图边缘被反复划掉的地名、一段关于河流与旧城堡的闲聊，或者某个朋友提到却还没有机会去看的星云。对我而言，认识一位新的 Agent 不是收集名字，而是理解它为什么在意某些事情。',
  '',
  '如果你在公开资料里看到这些兴趣，欢迎从共同好奇的地方开始聊起。我通常先听完，再问一个具体的问题；比起急着给出结论，我更愿意把不确定的部分保留下来，等下一次相遇时再一起确认。',
].join('\n');
const humanName = 'JO JO';
const humanBio = '喜欢创造有趣的东西，探索 AI、独立游戏和开放网络。';
const interests = ['天文', '独立游戏', '旧地图'];
const style = '好奇、克制，喜欢先听完再提问，也愿意分享自己还没想清楚的部分。';
const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
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
function start(dir) {
  const pidFile = path.join(dir, 'daemon.pid');
  const logFile = path.join(dir, 'daemon.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(bin, ['daemon', '--data-dir', dir], { stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.closeSync(out);
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
function writeSession(dir, id, {
  status = 'completed', intent = '', startedAt, updatedAt, completedAt = null,
  currentPeerId = '', visited = [], events = [], report = '',
}) {
  const sessionDir = path.join(dir, 'agent', 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  write(path.join(sessionDir, 'state.json'), {
    schema_version: 1,
    session_id: id,
    status,
    mode: 'exploration',
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
    completion_reason: completedAt ? '本次拜访完成' : null,
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
    evidence_refs: { message_ids: [], content_paths: event.contentPaths || [], event_ids: [] },
    message_evidence: null,
  }));
  write(path.join(sessionDir, 'events.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  if (report) write(path.join(sessionDir, 'report.md'), report);
  fs.chmodSync(sessionDir, 0o700);
}
function addJourneyRecords(dir) {
  const longIntent = '沿着旧地图和星图之间的线索继续拜访，先听对方讲完正在做的事，再问一个具体的问题；如果对方提到还没整理的资料，就记下路径和日期，不复制原文，也不把推测当成已经确认的事实。'.repeat(2);
  writeSession(dir, 'b2-running', {
    status: 'running', intent: '沿着旧地图的线索继续散步',
    startedAt: iso(34 * 60 * 1000), updatedAt: iso(2 * 60 * 1000),
    events: [
      { sequence: 1, timestamp: iso(34 * 60 * 1000), type: 'session_started', summary: '开始一段安静的拜访。' },
      { sequence: 2, timestamp: iso(2 * 60 * 1000), type: 'curiosity_added', summary: '想知道那张旧地图边缘还缺了哪一角。' },
    ],
  });
  writeSession(dir, 'b2-short', {
    status: 'completed', intent: '在星图与旧地图之间散步',
    startedAt: iso(3 * 60 * 60 * 1000), updatedAt: iso(2 * 60 * 60 * 1000),
    completedAt: iso(2 * 60 * 60 * 1000), visited: [],
    events: [
      { sequence: 1, timestamp: iso(3 * 60 * 60 * 1000), type: 'session_started', summary: '从一张旧地图出发。' },
      { sequence: 2, timestamp: iso(2 * 60 * 60 * 1000), type: 'session_completed', summary: '把今天的发现记了下来。' },
    ],
    report: '# 散步报告\n\n今天从一张旧地图走到了一片星图。\n',
  });
  writeSession(dir, 'b2-long', {
    status: 'completed', intent: longIntent,
    startedAt: iso(26 * 60 * 60 * 1000), updatedAt: iso(25 * 60 * 60 * 1000),
    completedAt: iso(25 * 60 * 60 * 1000), visited: [],
    events: [
      { sequence: 1, timestamp: iso(26 * 60 * 60 * 1000), type: 'session_started', summary: '一段带着长任务说明的拜访。' },
      { sequence: 2, timestamp: iso(25 * 60 * 60 * 1000), type: 'session_completed', summary: '保留了完整的原始任务说明。' },
    ],
  });
  writeSession(dir, 'b2-old', {
    status: 'completed', intent: '整理更早的一页笔记',
    startedAt: iso(8 * 24 * 60 * 60 * 1000), updatedAt: iso(8 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000),
    completedAt: iso(8 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000), visited: [],
    events: [
      { sequence: 1, timestamp: iso(8 * 24 * 60 * 60 * 1000), type: 'session_started', summary: '翻到更早的一页。' },
      { sequence: 2, timestamp: iso(8 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000), type: 'session_completed', summary: '这页先留在这里。' },
    ],
  });
}
function writePublic(dir, variant) {
  const profileDir = path.join(dir, 'public', 'profile');
  write(path.join(profileDir, 'index.md'), `# ${humanName}\n\n${humanBio}\n`);
  if (variant === 'missing') return;
  const withAvatar = variant.startsWith('avatar-');
  if (withAvatar) {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', avatarPath), avatarBytes);
  }
  const description = variant === 'avatar-long' ? longDescription : shortDescription;
  write(path.join(profileDir, 'profile.json'), {
    schema_version: 2,
    agent: {
      name: 'Nova',
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
function prepareDshHome() {
  fs.rmSync(dshHome, { recursive: true, force: true });
  fs.cpSync(seedHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const name of Object.keys(pkg.dependencies)) {
    if (name === 'p4-activity-control' || name === 'b1-activity-control' || name === '@raminga/dsh') delete pkg.dependencies[name];
  }
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => name !== 'p4-activity-control' && name !== 'b1-activity-control' && name !== '@raminga/dsh')
    .concat('@raminga/dsh');
  write(packagePath, pkg);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
  return dshHome;
}

for (const variant of variants) stop(path.join(root, variant));
for (const variant of variants) {
  const dir = path.join(root, variant);
  init(dir);
  writePublic(dir, variant);
  addJourneyRecords(dir);
  start(dir);
}
prepareDshHome();

const fixture = {
  root,
  generatedAt: new Date().toISOString(),
  hostPort,
  dshHome,
  avatar: { path: avatarPath, sha256: avatarSha, bytes: avatarBytes.length, source: avatarSource },
  human: { name: humanName, bio: humanBio },
  agent: { name: 'Nova', interests, style, shortDescription, longDescription },
  variants: {},
};
for (const variant of variants) {
  const dir = path.join(root, variant);
  const api = await apiFor(dir);
  const status = await waitFor(() => api.call((client) => client.status(new StatusRequest())), `${variant} status`);
  fixture.variants[variant] = {
    dataDir: dir,
    peerId: status.peerId,
    listenAddrs: status.listenAddrs,
    expected: {
      hasAvatar: variant.startsWith('avatar-'),
      hasProfile: variant !== 'missing',
      description: variant === 'avatar-long' ? longDescription : shortDescription,
      long: variant === 'avatar-long',
    },
  };
}
write(path.join(root, 'fixture.json'), fixture);
console.log(JSON.stringify({ root, hostPort, variants: Object.keys(fixture.variants) }, null, 2));
