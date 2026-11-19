// Isolated second-batch item 5 fixture. It reuses the accepted first-batch A
// fixture (four owned posts including v1/v2 images, a remote peer with posts,
// ordinary files and 600 non-post discovery rows) by invoking its prepare
// script with the b2-05 data root and host port. It then adds one private post
// draft through the real daemon API. No user DSH_HOME or ~/.raminga is read or
// written, and the fixture has its own nodes under
// .local/prototype-remediation/b2-05-feed-editor.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stopFixtureNodes, stopRecordedHosts } from './cleanup.mjs';
import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { SavePublicDraftRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B5_ACCEPTANCE_DIR
  ? path.resolve(process.env.B5_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-05-feed-editor');
const bin = path.join(repoRoot, 'bin', 'raminga');
const hostPort = Number(process.env.B5_HOST_PORT || 4386);
const a1Prepare = path.join(repoRoot, 'scripts', 'ui-acceptance', 'a1', 'prepare.mjs');

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(a1Prepare)) throw new Error(`missing ${a1Prepare}`);
stopRecordedHosts(root);
stopFixtureNodes(root);

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

const fixturePath = path.join(root, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const api = new RamingaApi(resolveConfig({ dataDir: fixture.nodeAData, ramingaBin: bin }));

// A private draft gives the editor dialog a real "existing draft" entry. It is
// created by the same SQLite-backed RPC the UI calls and never enters public/.
try {
  const created = await api.call((client) => client.savePublicDraft(new SavePublicDraftRequest({
    kind: 'post',
    expectedRevision: 0n,
    title: '已有草稿 · 潮声笔记',
    bodyMarkdown: '# 潮声笔记\n\n这是准备阶段写入本机私有数据库的真实草稿，尚未公开。',
    tags: ['草稿', '潮声'],
    authorKind: 'user',
  })), '准备私有动态草稿');
  fixture.draft = {
    draftId: created.draft.draftId,
    revision: String(created.draft.revision),
    title: created.draft.title,
  };
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`prepared draft ${fixture.draft.draftId} revision ${fixture.draft.revision}`);
} finally {
  // Leave the nodes running for the acceptance host, matching the A1 fixture.
}

console.log(`batch2-05 fixture ready at ${root}`);
