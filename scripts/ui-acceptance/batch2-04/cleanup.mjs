// Stop only the isolated batch2-04 fixture nodes and prune dead host records.
// This script never signals a recorded host PID and never touches the user's
// DSH profile, ~/.raminga, the desktop host, or ports used by other fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B4_ACCEPTANCE_DIR
  ? path.resolve(process.env.B4_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-04-interactions');
const bin = path.join(repoRoot, 'bin', 'raminga');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prune dead pid/meta records only. A recorded number is not proof of process identity. */
export function stopRecordedHosts(acceptanceRoot = root) {
  const evidence = path.join(acceptanceRoot, 'evidence');
  if (!fs.existsSync(evidence)) return [];
  const pruned = [];
  for (const name of fs.readdirSync(evidence)) {
    if (!/^dsh-\d+\.pid$/.test(name)) continue;
    const pidFile = path.join(evidence, name);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const port = name.match(/^dsh-(\d+)\.pid$/)[1];
    if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) {
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(`${pidFile}.meta`, { force: true });
      pruned.push({ pid, port, action: 'pruned' });
      continue;
    }
    console.warn(`refusing to signal recorded host pid=${pid} port=${port}; `
      + 'the PID may have been reused and its Popen owner is gone');
  }
  return pruned;
}

/** Stop fixture nodes through the normal local API/CLI path. */
export function stopFixtureNodes(acceptanceRoot = root) {
  const stopped = [];
  for (const name of ['node-a', 'node-b', 'node-e', 'node-c']) {
    const dir = path.join(acceptanceRoot, name);
    if (!fs.existsSync(dir)) continue;
    const result = spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 10000 });
    stopped.push({ name, status: result.status });
  }
  return stopped;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stoppedHosts = stopRecordedHosts();
  const stoppedNodes = stopFixtureNodes();
  console.log(JSON.stringify({ root, stoppedHosts, stoppedNodes }, null, 2));
}
