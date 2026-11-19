// Stop only the fixture hosts/nodes recorded under one b2-06 acceptance root.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B6_ACCEPTANCE_DIR
  ? path.resolve(process.env.B6_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-06-settings');
const bin = path.join(repoRoot, 'bin', 'raminga');
const evidence = path.join(root, 'evidence');
if (fs.existsSync(evidence)) {
  for (const name of fs.readdirSync(evidence)) {
    if (!/^dsh-\d+\.pid$/.test(name)) continue;
    const pidPath = path.join(evidence, name);
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    }
    fs.rmSync(pidPath, { force: true });
    fs.rmSync(`${pidPath}.meta`, { force: true });
  }
}
for (const dir of [path.join(root, 'node-a'), path.join(root, 'node-b')]) {
  if (fs.existsSync(dir)) spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 15000 });
}
console.log(`cleaned ${root}`);
