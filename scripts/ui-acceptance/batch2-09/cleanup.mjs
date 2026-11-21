// Stop only the isolated batch2-09 host/node processes. Safe to run after an
// interrupted acceptance: it never scans or kills unrelated processes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B9_ACCEPTANCE_DIR
  ? path.resolve(process.env.B9_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-09-human-avatar');
const expected = path.join(repoRoot, '.local', 'prototype-remediation', 'b2-09-human-avatar');
if (root !== expected && !root.startsWith(`${expected}${path.sep}`)) {
  throw new Error(`refusing to clean unexpected B9_ACCEPTANCE_DIR: ${root}`);
}
const bin = path.join(repoRoot, 'bin', 'raminga');
const pidFile = path.join(root, 'evidence', 'dsh-4406.pid');

if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(`${pidFile}.meta`, { force: true });
}
for (const name of ['node-a', 'node-b']) {
  spawnSync(bin, ['stop', '--data-dir', path.join(root, name)], { encoding: 'utf8', timeout: 15000 });
}
console.log(`cleaned batch2-09 fixture ${root}`);
