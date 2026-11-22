// Stop only this fixture's host and three nodes. Never scans unrelated
// processes and never touches the user's DSH_HOME or ~/.raminga.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B3_ACCEPTANCE_DIR
  ? path.resolve(process.env.B3_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b3-01-bootstrap');
const expected = path.join(repoRoot, '.local', 'prototype-remediation', 'b3-01-bootstrap');
if (root !== expected && !root.startsWith(`${expected}${path.sep}`)) {
  throw new Error(`refusing to clean unexpected B3_ACCEPTANCE_DIR: ${root}`);
}
const bin = path.join(repoRoot, 'bin', 'raminga');
for (const name of ['dsh-44744.pid']) {
  const pidFile = path.join(root, 'evidence', name);
  if (!fs.existsSync(pidFile)) continue;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(`${pidFile}.meta`, { force: true });
}
for (const name of ['node-a', 'node-b', 'node-c']) {
  spawnSync(bin, ['stop', '--data-dir', path.join(root, name)], { encoding: 'utf8', timeout: 15000 });
}
console.log(`cleaned batch3-01 fixture ${root}`);
