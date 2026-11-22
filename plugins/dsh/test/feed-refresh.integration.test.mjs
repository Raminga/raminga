// Real two-node Feed refresh integration. It uses temporary data directories
// and the local binary; it never touches ~/.raminga or a user DSH profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../lib/client.js';
import { RamingaUiBridge } from '../lib/ui-bridge.js';
import { resolveConfig } from '../lib/config.js';
import {
  ConnectRequest,
  DownloadPeerFileRequest,
  ListDiscoveriesRequest,
  PublishedRequest,
  SendChatRequest,
  StatusRequest,
} from '../lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
}
function postBody(peerId, id, title) {
  return Buffer.from(`${JSON.stringify({
    schema_version: 2,
    id,
    title,
    format: 'markdown',
    author: { peer_id: peerId, kind: 'agent', display_name: '小澜' },
    published_at: '2026-11-22T08:00:00Z',
    updated_at: '2026-11-22T08:00:00Z',
    tags: ['refresh'],
    summary: `${title} 摘要`,
    body: `# ${title}\n\n真实双节点刷新正文。`,
    images: [],
    revision: 1,
  })}\n`);
}
function startNode(dir) {
  const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const child = spawn(binary, ['daemon', '--data-dir', dir], { stdio: 'ignore' });
  return child;
}
function stopNode(child, dir) {
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 8000 });
}
function cleanup(t, dir, child) {
  t.after(() => {
    stopNode(child, dir);
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
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last ?? new Error(`timed out waiting for ${label}`);
}
function tcpAddr(status) {
  const addr = (status.listenAddrs || []).find((item) => item.includes('/tcp/'));
  assert.ok(addr, 'node has a TCP listen address');
  return addr;
}
async function download(api, peerId, relative) {
  const last = await api.call(async (client) => {
    const stream = await client.downloadPeerFile(new DownloadPeerFileRequest({
      peerId, path: relative, recordDiscovery: true, discoverySource: 'raminga_content_get',
    }), { timeoutMs: 30000 });
    let final = null;
    for await (const frame of stream) final = frame;
    return final;
  }, `download ${relative}`);
  assert.equal(last?.phase, 'complete');
  assert.equal(String(last?.error ?? ''), '');
  assert.equal(last?.discoveryRecorded, true);
}

test('real two nodes: explicit refresh imports a new v2 post, skips duplicates, refreshes same path and keeps old posts offline', { skip: !canRun ? `missing ${binary}` : false, timeout: 90000 }, async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-refresh-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-refresh-b-'));
  let childA = startNode(dirA);
  let childB = startNode(dirB);
  cleanup(t, dirA, childA);
  cleanup(t, dirB, childB);
  const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: binary }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: binary }));
  const bridge = new RamingaUiBridge(apiA, { dataDir: dirA });
  const sid = 'feed-refresh-integration-0001';
  t.after(() => bridge.dispose());
  try {
    const statusA = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');
    const statusB = await waitFor(() => apiB.call((client) => client.status(new StatusRequest())), 'node B status');
    const target = `${tcpAddr(statusB)}/p2p/${statusB.peerId}`;
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: target, peerId: statusB.peerId })), 'connect A to B');
    await apiA.call((client) => client.sendChat(new SendChatRequest({
      peerId: statusB.peerId, multiaddr: target, text: '请让新动态进入有过交流列表。',
      origin: 'human', agentOrigin: false, requestId: 'refresh-human-1',
    })), 'human send A to B');

    const old = postBody(statusB.peerId, 'refresh-old', '刷新前已收录');
    write(path.join(dirB, 'public', 'posts', 'refresh-old', 'post.json'), old);
    await apiB.call((client) => client.published(new PublishedRequest()), 'refresh B manifest');
    await download(apiA, statusB.peerId, 'posts/refresh-old/post.json');
    await bridge.open(sid);

    const before = await bridge.discoveries(sid, false, true);
    assert.equal(before.items.some((item) => item.title === '刷新前已收录'), true);
    const newBody = postBody(statusB.peerId, 'refresh-new', '仅点击刷新后出现');
    write(path.join(dirB, 'public', 'posts', 'refresh-new', 'post.json'), newBody);
    await apiB.call((client) => client.published(new PublishedRequest()), 'refresh B manifest after new post');
    let localOnly = await bridge.discoveries(sid, true, true);
    assert.equal(localOnly.items.some((item) => item.path === 'posts/refresh-new/post.json'), false, 'page/TTL/local reads never fetch a post');

    let refreshed = await bridge.refreshDiscoveries(sid, true);
    assert.equal(refreshed.refresh.familiar, true);
    assert.equal(refreshed.refresh.imported, 1);
    assert.ok(refreshed.refresh.checkedPeers >= 1);
    assert.equal(refreshed.items.some((item) => item.path === 'posts/refresh-new/post.json' && item.title === '仅点击刷新后出现'), true);
    const rowPage = await apiA.call((client) => client.listDiscoveries(new ListDiscoveriesRequest({
      peerId: statusB.peerId, limit: 100, postCandidatesOnly: true,
    })));
    const newRows = (rowPage.discoveries ?? []).filter((row) => row.path === 'posts/refresh-new/post.json');
    assert.equal(newRows.length, 1);
    assert.equal(String(newRows[0].source), 'raminga_ui_refresh');

    refreshed = await bridge.refreshDiscoveries(sid, true);
    assert.equal(refreshed.refresh.imported, 0);
    assert.ok(refreshed.refresh.skipped >= 1);
    const afterRepeat = await apiA.call((client) => client.listDiscoveries(new ListDiscoveriesRequest({
      peerId: statusB.peerId, limit: 100, postCandidatesOnly: true,
    })));
    assert.equal((afterRepeat.discoveries ?? []).filter((row) => row.path === 'posts/refresh-new/post.json').length, 1, 'repeated refresh must not duplicate evidence');

    // Same path, new SHA: v2 post.json is replaced and the explicit refresh
    // records the new version instead of reusing the old copy.
    const changed = postBody(statusB.peerId, 'refresh-new', '同路径的新版本');
    write(path.join(dirB, 'public', 'posts', 'refresh-new', 'post.json'), changed);
    await apiB.call((client) => client.published(new PublishedRequest()), 'refresh B manifest after change');
    refreshed = await bridge.refreshDiscoveries(sid, true);
    assert.equal(refreshed.refresh.imported, 1);
    assert.equal(refreshed.items.some((item) => item.title === '同路径的新版本'), true);

    // The single download slot now holds the new version. The older evidence
    // row is preserved in the index, but the Feed must show exactly one
    // readable card for this peer/path in both filters instead of a stale
    // generic "post" card next to the working version.
    const revisionCards = refreshed.items.filter((item) => item.path === 'posts/refresh-new/post.json');
    assert.equal(revisionCards.length, 1, 'same path revision produces one Feed card');
    assert.equal(revisionCards[0].title, '同路径的新版本');
    assert.equal(revisionCards[0].contentState, 'available');
    assert.equal(refreshed.items.some((item) => item.title === '仅点击刷新后出现'), false, 'old version card is superseded');
    const allAfterRevision = await bridge.discoveries(sid, false, true);
    const familiarAfterRevision = await bridge.discoveries(sid, true, true);
    assert.equal(allAfterRevision.items.filter((item) => item.path === 'posts/refresh-new/post.json').length, 1, 'all filter also shows one card');
    assert.equal(familiarAfterRevision.items.filter((item) => item.path === 'posts/refresh-new/post.json').length, 1, 'familiar filter also shows one card');
    const revisionRows = await apiA.call((client) => client.listDiscoveries(new ListDiscoveriesRequest({
      peerId: statusB.peerId, limit: 100, postCandidatesOnly: true,
    })));
    assert.equal((revisionRows.discoveries ?? []).filter((row) => row.path === 'posts/refresh-new/post.json').length, 2,
      'both exact versions remain in the private index');

    // Stop the only candidate peer: the old verified cards stay visible and
    // the refresh reports a failure instead of clearing the Feed.
    childB.kill('SIGTERM');
    await new Promise((resolve) => childB.once('exit', resolve));
    refreshed = await bridge.refreshDiscoveries(sid, true);
    assert.equal(refreshed.refresh.failed >= 1, true);
    assert.equal(refreshed.items.some((item) => item.title === '同路径的新版本'), true, 'offline peer keeps the previous cards');
    assert.equal(refreshed.refresh.checkedPeers >= 1, true);
  } finally {
    await bridge.close(sid);
  }
});
