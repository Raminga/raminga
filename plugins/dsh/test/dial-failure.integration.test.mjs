// Focused real-daemon regression for the stage-4 error mapping.
//
// A live local daemon rejects a dial to a closed remote port with
// Code.Unavailable. The UI detail must keep the real dial error and must not
// rewrite it as "local daemon is not running / auto-start failed".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RamingaApi } from '../lib/client.js';
import { resolveConfig } from '../lib/config.js';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);
const deadAddress = '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';

test('a real remote dial failure keeps the dial error and local Status health', {
  skip: !canRun ? `missing ${binary}` : false,
  timeout: 30000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-dial-failure-'));
  const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const bridge = new RamingaUiBridge(
    new RamingaApi(resolveConfig({ dataDir: dir, ramingaBin: binary })),
    { connectTimeoutMs: 10000 },
  );
  t.after(() => {
    bridge.dispose();
    spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const opened = await bridge.open('ui-dial-failure-0001');
  assert.ok(opened.status?.peerId, 'the isolated local daemon must be running');
  const result = await bridge.connect('ui-dial-failure-0001', deadAddress);
  assert.equal(result.ok, false);
  assert.equal(result.invalid, false);
  assert.match(result.error, /连接节点没有完成/);
  assert.match(result.error, /connection refused|all dials failed/i);
  assert.match(result.error, /本机节点在这次操作前可以访问/);
  assert.match(result.error, /不是自动启动失败/);
  assert.doesNotMatch(result.error, /node is not running at|tried to auto-start/);

  const after = await bridge.poll('ui-dial-failure-0001', true);
  assert.ok(after.status?.peerId, 'the local daemon must still answer Status');
  assert.equal(after.error, null);
});
