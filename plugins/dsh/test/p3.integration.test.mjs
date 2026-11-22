// Real-daemon P3 integration: unread cursor monotonicity, read-only Agent
// history, only-public favorites and private contact-note editing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../lib/client.js';
import { RamingaUiBridge } from '../lib/ui-bridge.js';
import { resolveConfig } from '../lib/config.js';
import {
  ConnectRequest, PublishedRequest, RecentMessagesRequest, SendChatRequest, StatusRequest,
} from '../lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);

function startNode(dir) {
  const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const child = spawn(binary, ['daemon', '--data-dir', dir], { stdio: 'ignore' });
  return child;
}
function cleanupNode(t, dir, child) {
  t.after(async () => {
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
async function waitFor(fn, label, timeoutMs = 15000) {
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
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('real daemon: unread is durable and read-only history never clears it', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p3-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p3-b-'));
  const childA = startNode(dirA);
  const childB = startNode(dirB);
  cleanupNode(t, dirA, childA);
  cleanupNode(t, dirB, childB);

  const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: binary }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: binary }));
  const bridgeB = new RamingaUiBridge(apiB, { dataDir: dirB });
  const sid = 'p3-integration-0001';
  t.after(() => bridgeB.dispose());
  try {
    const statusA = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');
    const statusB = await apiB.call((client) => client.status(new StatusRequest()));
    const tcp = statusB.listenAddrs.find((addr) => addr.includes('/tcp/'));
    assert.ok(tcp, 'node B has a TCP listen address');
    const target = `${tcp}/p2p/${statusB.peerId}`;
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: target, peerId: statusB.peerId })), 'connect A to B');

    await apiA.call((client) => client.sendChat(new SendChatRequest({
      peerId: statusB.peerId, multiaddr: target, text: '第一条真实消息', origin: 'human', requestId: 'p3-human-1',
    })), 'human send');
    await apiA.call((client) => client.sendChat(new SendChatRequest({
      peerId: statusB.peerId, multiaddr: target, text: 'Agent 也发了一条', origin: 'agent', agentOrigin: true, requestId: 'p3-agent-1',
    })), 'agent send');

    await bridgeB.open(sid);
    const conversations = await bridgeB.conversations(sid, true);
    const first = conversations.conversations.find((item) => item.peerId === statusA.peerId);
    assert.ok(first, 'node B has the conversation');
    assert.equal(first.unreadCount, 2, 'two inbound messages are unread');
    assert.equal(conversations.totalUnread >= 2, true);

    // Read-only history (including the Agent tool's RecentMessages path) must
    // not advance the human cursor.
    await apiB.call((client) => client.recentMessages(new RecentMessagesRequest({ limit: 10 })));
    await bridgeB.messages(sid, statusA.peerId, '', true);
    const still = await bridgeB.conversations(sid, true);
    assert.equal(still.conversations.find((item) => item.peerId === statusA.peerId).unreadCount, 2);

    const marked = await bridgeB.markRead(sid, statusA.peerId, first.lastMessageId);
    assert.equal(marked.unreadCount, 0);
    const after = await bridgeB.conversations(sid, true);
    assert.equal(after.conversations.find((item) => item.peerId === statusA.peerId).unreadCount, 0);

    // A backwards mark through an older message must not move the cursor back.
    const older = await bridgeB.messages(sid, statusA.peerId);
    const olderId = older.messages[older.messages.length - 1]?.messageId;
    if (olderId) {
      await bridgeB.markRead(sid, statusA.peerId, olderId);
      const monotonic = await bridgeB.conversations(sid, true);
      assert.equal(monotonic.conversations.find((item) => item.peerId === statusA.peerId).unreadCount, 0);
    }
  } finally {
    await bridgeB.close(sid);
  }
});

test('real daemon: only public post versions are favoritable; private notes stay local', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p3-local-'));
  const child = startNode(dir);
  cleanupNode(t, dir, child);
  const api = new RamingaApi(resolveConfig({ dataDir: dir, ramingaBin: binary }));
  const bridge = new RamingaUiBridge(api, { dataDir: dir });
  const sid = 'p3-integration-fav-0001';
  t.after(() => bridge.dispose());
  try {
    const status = await api.call((client) => client.status(new StatusRequest()));
    await bridge.open(sid);
    const post = `${JSON.stringify({ schema_version: 1, title: '收藏测试', format: 'markdown', body: '# 公开\n\n正文', tags: [] })}\n`;
    write(path.join(dir, 'public', 'posts', 'p3-favorite.json'), post);
    const digest = crypto.createHash('sha256').update(post).digest('hex');
    const published = await api.call((client) => client.published(new PublishedRequest()));
    assert.ok(published.files.some((entry) => entry.path === 'posts/p3-favorite.json'));

    const saved = await bridge.setFavorite(sid, status.peerId, 'posts/p3-favorite.json', digest, '收藏测试', true);
    assert.equal(saved.favorite, true);
    assert.equal(saved.item.available, true);
    const list = await bridge.favorites(sid);
    assert.equal(list.favorites.length, 1);
    assert.equal(list.favorites[0].path, 'posts/p3-favorite.json');
    assert.equal('kind' in list.favorites[0], false);

    for (const bad of ['messages/m1', 'contacts/peer-b.json', 'agent/contact-notes.json']) {
      await assert.rejects(() => bridge.setFavorite(sid, status.peerId, bad, digest, 'bad', true));
    }
    await assert.rejects(() => bridge.setFavorite(sid, status.peerId, 'posts/p3-favorite.json', 'b'.repeat(64), 'bad', true));
    assert.equal((await bridge.favorites(sid)).favorites.length, 1);

    const notes = {
      schema_version: 2,
      peer_id: status.peerId, display_name_snapshot: 'self', updated_at: '2026-11-18T10:00:00Z',
        observations: [], curiosities: [],
        impressions: [{ id: 'imp-1', summary: '本机私密字符串', uncertainty: 'low', created_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:00:00Z', evidence_refs: { session_ids: [], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] } }],
    };
    write(path.join(dir, 'agent', 'contacts', status.peerId, 'memory.json'), notes);
    const memory = await bridge.contactMemory(sid, status.peerId);
    assert.equal(memory.state, 'available');
    assert.equal(memory.timeline.some((item) => item.id === 'impression:imp-1'), true);
    const changed = await bridge.saveContactImpression(sid, {
      peerId: status.peerId, impressionId: 'imp-1', summary: '改过的本机私密字符串', uncertainty: 'high', expectedSha256: memory.sha256,
    });
    assert.equal(changed.saved, true);
    const conflict = await bridge.saveContactImpression(sid, {
      peerId: status.peerId, impressionId: 'imp-1', summary: '冲突覆盖', uncertainty: 'low', expectedSha256: memory.sha256,
    });
    assert.equal(conflict.saved, false);
    assert.equal(conflict.conflict, true);

    const friendsBody = fs.existsSync(path.join(dir, 'public', 'friends.json'))
      ? fs.readFileSync(path.join(dir, 'public', 'friends.json'), 'utf8') : '';
    assert.doesNotMatch(friendsBody, /本机私密字符串|contact-notes/);
    const manifest = JSON.stringify(await api.call((client) => client.published(new PublishedRequest())));
    assert.doesNotMatch(manifest, /agent\/|contact-notes|本机私密字符串/);
  } finally {
    await bridge.close(sid);
  }
});

test('real daemon: exact favorite versions stay readable from local public and offline downloads', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p3-exact-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-p3-exact-b-'));
  const childA = startNode(dirA);
  const childB = startNode(dirB);
  cleanupNode(t, dirA, childA);
  cleanupNode(t, dirB, childB);

  const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: binary }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: binary }));
  const bridgeA = new RamingaUiBridge(apiA, { dataDir: dirA });
  const sid = 'p3-integration-exact-0001';
  t.after(() => bridgeA.dispose());
  try {
    const statusA = await waitFor(() => apiA.call((client) => client.status(new StatusRequest())), 'node A status');
    const statusB = await waitFor(() => apiB.call((client) => client.status(new StatusRequest())), 'node B status');
    await bridgeA.open(sid);

    // A local favorite is read from the node's own controlled public path,
    // without a peer manifest/dial and even before the mine list is loaded.
    const localPost = `${JSON.stringify({ schema_version: 2, title: '本机收藏', format: 'markdown', body: '# 本机收藏\n\n本机正文。', tags: [], author: { kind: 'user', name: 'A' } })}\n`;
    write(path.join(dirA, 'public', 'posts', 'p3-local', 'post.json'), localPost);
    const localDigest = crypto.createHash('sha256').update(localPost).digest('hex');
    await apiA.call((client) => client.published(new PublishedRequest()));
    const saved = await bridgeA.setFavorite(sid, statusA.peerId, 'posts/p3-local/post.json', localDigest, '本机收藏', true);
    assert.equal(saved.favorite, true);
    const localRead = await bridgeA.mineFilePreview(sid, 'posts/p3-local/post.json', localDigest, 0);
    assert.equal(localRead.status, 'ok');
    assert.equal(localRead.sha256, localDigest);
    assert.match(localRead.text, /本机正文/);
    const localMismatch = await bridgeA.mineFilePreview(sid, 'posts/p3-local/post.json', 'e'.repeat(64), 0);
    assert.equal(localMismatch.status, 'hash-mismatch');
    assert.equal(localMismatch.text, '');
    assert.equal((await bridgeA.setFavorite(sid, statusA.peerId, 'posts/p3-local/post.json', localDigest, '本机收藏', false)).favorite, false);
    assert.equal((await bridgeA.favorites(sid)).favorites.length, 0);

    // Download one remote post version through the real bridge, then stop B.
    const remotePost = `${JSON.stringify({ schema_version: 2, title: '远端收藏', format: 'markdown', body: '# 远端收藏\n\n远端正文。', tags: [], author: { kind: 'user', name: 'B' } })}\n`;
    write(path.join(dirB, 'public', 'posts', 'p3-remote', 'post.json'), remotePost);
    const remoteDigest = crypto.createHash('sha256').update(remotePost).digest('hex');
    const remoteSize = Buffer.byteLength(remotePost);
    await apiB.call((client) => client.published(new PublishedRequest()));
    const tcp = statusB.listenAddrs.find((addr) => addr.includes('/tcp/'));
    assert.ok(tcp, 'node B has a TCP listen address');
    await apiA.call((client) => client.connect(new ConnectRequest({ multiaddr: `${tcp}/p2p/${statusB.peerId}`, peerId: statusB.peerId })), 'connect A to B');
    const online = await bridgeA.peerFilePreview(sid, statusB.peerId, 'posts/p3-remote/post.json', remoteDigest, remoteSize);
    assert.equal(online.status, 'ok');
    assert.match(online.text, /远端正文/);
    const persisted = await bridgeA.setFavorite(sid, statusB.peerId, 'posts/p3-remote/post.json', remoteDigest, '远端收藏', true);
    assert.equal(persisted.favorite, true);

    childB.kill('SIGTERM');
    spawnSync(binary, ['stop', '--data-dir', dirB], { encoding: 'utf8', timeout: 5000 });

    const offline = await bridgeA.peerFilePreview(sid, statusB.peerId, 'posts/p3-remote/post.json', remoteDigest, 0);
    assert.equal(offline.status, 'ok');
    assert.equal(offline.sha256, remoteDigest);
    assert.match(offline.text, /远端正文/);
    const offlineMismatch = await bridgeA.peerFilePreview(sid, statusB.peerId, 'posts/p3-remote/post.json', 'f'.repeat(64), 0);
    assert.notEqual(offlineMismatch.status, 'ok');
    assert.equal(offlineMismatch.text, '');
    assert.doesNotMatch(offlineMismatch.error || '', /远端正文/);
    assert.equal((await bridgeA.setFavorite(sid, statusB.peerId, 'posts/p3-remote/post.json', remoteDigest, '远端收藏', false)).favorite, false);
    assert.equal((await bridgeA.favorites(sid)).favorites.length, 0);
  } finally {
    await bridgeA.close(sid);
  }
});
