// Stop only the isolated B4 host and its A/B nodes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B4_ACCEPTANCE_DIR
  ? path.resolve(process.env.B4_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'batch4-01');
const allowed = path.join(repoRoot, '.local', 'prototype-remediation');
if (root !== allowed && !root.startsWith(`${allowed}${path.sep}`)) {
  throw new Error(`refusing to clean unexpected B4_ACCEPTANCE_DIR: ${root}`);
}
const fixturePath = path.join(root, 'fixture.json');
const fixture = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
// A stale pid file cannot prove that the recorded process still belongs to
// this fixture, so cleanup never signals it. acceptance.py terminates the host
// process it started itself in its finally block; this script stops only the
// two isolated nodes by their owned data directories.
const bin = path.join(repoRoot, 'bin', 'raminga');
for (const name of ['node-a', 'node-b']) {
  spawnSync(bin, ['stop', '--data-dir', path.join(root, name)], { encoding: 'utf8', timeout: 15000 });
}
console.log(`cleaned batch4-01 fixture ${root}`);
