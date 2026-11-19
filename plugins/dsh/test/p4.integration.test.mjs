// Real-daemon P4 integration: only the Agent tool execute wrapper writes
// activity; a real content download yields SHA evidence; a manual download
// never does; chat history records IDs but not message bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../lib/client.js';
import { resolveConfig } from '../lib/config.js';
import { defineRamingaTools } from '../lib/tools.js';
import { AgentActivityStore } from '../lib/activity.js';
import {
  ConnectRequest, DownloadPeerFileRequest, PublishedRequest, SendChatRequest, StatusRequest,
} from '../lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);

function startNode(dir) {
  const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  return spawn(binary, ['daemon', '--data-dir', dir], { stdio: 'ignore' });
}
function cleanupNode(t, dir, child) {
  t.after(async () => {
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
    spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
async function waitFor(fn, label, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last ?? new Error(`timed out waiting for ${label}`);
}

test('real daemon: Agent content_get writes live activity and SHA evidence; manual download does not', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p4-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p4-b-'));
  const childA = startNode(dirA);
  const childB = startNode(dirB);
  cleanupNode(t, dirA, childA);
  cleanupNode(t, dirB, childB);

  const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: binary }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: binary }));
  const store = new AgentActivityStore({ dataDir: dirA, pluginInstanceId: 'inst-p4-integration01' });
  const tools = defineRamingaTools(apiA, { activity: store });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  t.after(() => store.dispose());
  try {
    const statusA = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');
    const statusB = await waitFor(() => apiB.call((client) => client.status(new StatusRequest())), 'node B status');
    const tcp = statusB.listenAddrs.find((addr) => addr.includes('/tcp/'));
    assert.ok(tcp, 'node B has a TCP listen address');
    await apiA.call((client) => client.connect(new ConnectRequest({
      multiaddr: `${tcp}/p2p/${statusB.peerId}`, peerId: statusB.peerId,
    })), 'connect A to B');

    // Publish one large file so a real tool execution can be observed while it
    // is still running. The bytes are deterministic and bounded.
    const payload = Buffer.alloc(16 * 1024 * 1024, 0x61);
    fs.mkdirSync(path.join(dirB, 'public', 'posts'), { recursive: true });
    fs.writeFileSync(path.join(dirB, 'public', 'posts', 'p4-large.json'), payload, { mode: 0o644 });
    const sha = crypto.createHash('sha256').update(payload).digest('hex');
    await waitFor(async () => {
      const published = await apiB.call((client) => client.published(new PublishedRequest()));
      return published.files.some((entry) => entry.path === 'posts/p4-large.json');
    }, 'node B publish');

    // A manual RPC download is not an Agent tool call and must not create a
    // record. Wait for it to finish before asserting the missing activity file.
    await apiA.call(async (client) => {
      for await (const _frame of client.downloadPeerFile(new DownloadPeerFileRequest({
        peerId: statusB.peerId,
        path: 'posts/p4-large.json',
        recordDiscovery: false,
      }))) { /* consume */ }
    }, 'manual download');
    const manualRead = await store.read();
    assert.equal(manualRead.operations.length, 0, 'manual download is not Agent activity');
    assert.equal(manualRead.error, '');

    const contentTool = byName.get('raminga_content_get');
    assert.ok(contentTool, 'generated content tool exists');
    const pending = contentTool.execute({ peer_id: statusB.peerId, path: 'posts/p4-large.json' });
    // Observe the started line while the real download is in flight. Poll
    // briefly; the 16 MiB local transfer is normally still running.
    let sawRunning = false;
    for (let index = 0; index < 400; index += 1) {
      const during = await store.read();
      if (during.operations.some((operation) => operation.state === 'running')) {
        sawRunning = true;
        break;
      }
      if (during.operations.some((operation) => operation.state === 'finished')) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(sawRunning, true, 'real tool execution was observed as running before it finished');
    const result = await pending;
    assert.equal(result.final.sha256, sha);
    assert.equal(result.final.path, 'posts/p4-large.json');
    assert.ok(result.final.discoveryId > 0, 'real Agent fetch recorded a discovery');

    const read = await store.read(20);
    assert.equal(read.operations.length, 1);
    const operation = read.operations[0];
    assert.equal(operation.tool, 'raminga_content_get');
    assert.equal(operation.targetType, 'content');
    assert.equal(operation.target.path, 'posts/p4-large.json');
    assert.equal(operation.state, 'finished');
    assert.equal(operation.result, 'ok');
    assert.equal(operation.evidence.sha256, sha);
    assert.equal(operation.evidence.discovery_id, Number(result.final.discoveryId));
    assert.equal(operation.evidence.peer_id, statusB.peerId);
    assert.ok(operation.endedAt);

    const raw = fs.readFileSync(path.join(dirA, 'agent', 'activity.jsonl'), 'utf8');
    assert.doesNotMatch(raw, new RegExp(dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(raw, /\/Users|\/private\/|\/tmp\//);
    assert.match(raw, new RegExp(sha));

    // Seed one real message with a body marker, then use the Agent history
    // tool. Only message IDs may enter activity; the body must not.
    await apiA.call((client) => client.sendChat(new SendChatRequest({
      peerId: statusB.peerId, multiaddr: `${tcp}/p2p/${statusB.peerId}`,
      text: 'SECRET_CHAT_BODY_P4_MARKER', origin: 'agent', agentOrigin: true, requestId: 'p4-history-1',
    })), 'seed chat');
    const historyTool = byName.get('raminga_chat_history');
    const history = await historyTool.execute({ limit: 10 });
    assert.ok(Array.isArray(history.messages));
    const afterHistory = await store.read(20);
    const historyOperation = afterHistory.operations.find((item) => item.tool === 'raminga_chat_history');
    assert.ok(historyOperation);
    assert.ok(historyOperation.evidence.message_ids.length > 0);
    const rawAfter = fs.readFileSync(path.join(dirA, 'agent', 'activity.jsonl'), 'utf8');
    assert.doesNotMatch(rawAfter, /SECRET_CHAT_BODY_P4_MARKER/);
    assert.equal(afterHistory.operations.filter((item) => item.tool === 'raminga_content_get').length, 1);
  } finally {
    await store.dispose();
  }
});
