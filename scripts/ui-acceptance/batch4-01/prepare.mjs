// Isolated Feed avatar + explicit-refresh fixture. It reuses the accepted
// two-node C/B2-09 fixture, then gives B a human header name (阿岸) distinct
// from its Agent name (小澜) and copies B's current public profile and both
// avatars into A's verified download tree. No user data is touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { DownloadPeerFileRequest, PublishedRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B4_ACCEPTANCE_DIR
  ? path.resolve(process.env.B4_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'batch4-01');
const bin = path.join(repoRoot, 'bin', 'raminga');
const b2Prepare = path.join(repoRoot, 'scripts', 'ui-acceptance', 'batch2-09', 'prepare.mjs');
const hostPort = Number(process.env.B4_HOST_PORT || 4406);
const controlPort = Number(process.env.B4_CONTROL_PORT || 4371);
// The reused B2-09/C1 adapters recursively remove node data and DSH homes
// under the directory they are given. Never point them at a shared or
// user-owned path: this fixture owns only .local/prototype-remediation.
const allowed = path.join(repoRoot, '.local', 'prototype-remediation');
if (!root.startsWith(`${allowed}${path.sep}`)) {
  throw new Error(`refusing to prepare non-isolated B4_ACCEPTANCE_DIR: ${root}`);
}

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(b2Prepare)) throw new Error(`missing ${b2Prepare}`);
fs.mkdirSync(root, { recursive: true });

const prepared = spawnSync(process.execPath, [b2Prepare], {
  cwd: repoRoot,
  env: {
    ...process.env,
    B9_ACCEPTANCE_DIR: root,
    B9_HOST_PORT: String(hostPort),
    B9_CONTROL_PORT: String(controlPort),
  },
  encoding: 'utf8',
  timeout: 300000,
});
if (prepared.status !== 0) throw new Error(`B2-09 fixture prepare failed:\n${prepared.stderr || prepared.stdout}`);
process.stdout.write(prepared.stdout);

const fixturePath = path.join(root, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const dirB = fixture.nodeBData;
const dirA = fixture.nodeAData;
const profilePath = path.join(dirB, 'public', 'profile', 'profile.json');
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
profile.agent.name = '小澜';
profile.agent.description = '替阿岸整理潮汐笔记的 Agent。';
profile.human.name = '阿岸';
profile.human.bio_markdown = '住在潮汐线附近，收集旧信和雨声。也愿意认识新的朋友。';
profile.updated_at = new Date().toISOString();
fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
fs.writeFileSync(path.join(dirB, 'public', 'profile', 'index.md'),
  '# 阿岸\n\n住在潮汐线附近，收集旧信和雨声。也愿意认识新的朋友。\n');

const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: bin }));
const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: bin }));
await apiB.call((client) => client.published(new PublishedRequest()), 'refresh B published manifest');
const profileFiles = [
  'profile/index.md',
  'profile/profile.json',
  `profile/avatar-${profile.agent.avatar_sha256.slice(0, 8)}.png`,
  `profile/human-avatar-${profile.human.avatar_sha256.slice(0, 8)}.png`,
];
for (const relative of profileFiles) {
  const frames = await apiA.call(async (client) => {
    const stream = await client.downloadPeerFile(new DownloadPeerFileRequest({
      peerId: fixture.nodeB,
      path: relative,
      recordDiscovery: false,
    }), { timeoutMs: 30000 });
    const collected = [];
    for await (const frame of stream) collected.push(frame);
    return collected;
  }, `copy ${relative}`);
  const last = frames.at(-1);
  if (!last || String(last.phase) !== 'complete' || String(last.error ?? '').length > 0) {
    throw new Error(`copy ${relative} failed: ${last?.error || 'no complete frame'}`);
  }
}

const next = {
  ...fixture,
  hostPort,
  controlPort,
  bAgentName: profile.agent.name,
  bHumanName: profile.human.name,
  bAgentAvatarPath: `profile/avatar-${profile.agent.avatar_sha256.slice(0, 8)}.png`,
  bAgentAvatarSha256: profile.agent.avatar_sha256,
  bHumanAvatarPath: `profile/human-avatar-${profile.human.avatar_sha256.slice(0, 8)}.png`,
  bHumanAvatarSha256: profile.human.avatar_sha256,
  bProfileFilesCopiedToA: profileFiles,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(fixturePath, `${JSON.stringify(next, null, 2)}\n`);
console.log(JSON.stringify({
  root, hostPort, controlPort, nodeA: fixture.nodeA, nodeB: fixture.nodeB,
  humanName: profile.human.name, agentName: profile.agent.name,
  humanAvatar: next.bHumanAvatarPath, agentAvatar: next.bAgentAvatarPath,
}, null, 2));
