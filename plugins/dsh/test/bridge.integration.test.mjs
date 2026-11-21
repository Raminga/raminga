// Real-daemon integration test for the panel bridge lifecycle.
//
// Run with: node --test test/bridge.integration.test.mjs
// It uses a temporary Raminga data directory and the repository binary, then
// stops the daemon. No user data, DSH profile, or network peer is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RamingaApi } from '../lib/client.js';
import { resolveConfig } from '../lib/config.js';
import { RamingaUiBridge } from '../lib/ui-bridge.js';
import { StatusRequest, ConnectRequest } from '../lib/gen/raminga/api/v1/api_pb.js';
import { defineRamingaTools } from '../lib/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);

test('bridge reads real Status, opens one Events stream, and disposes it', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-bridge-'));
  const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const config = resolveConfig({ dataDir: dir, ramingaBin: binary });
  const api = new RamingaApi(config);
  const bridge = new RamingaUiBridge(api);
  t.after(() => {
    bridge.dispose();
    spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = await bridge.open('ui-integration-0001');
  assert.ok(open.status?.peerId, 'real daemon Status must carry a Peer ID');
  assert.ok(open.status?.apiVersion === '6', `unexpected API version: ${open.status?.apiVersion}`);
  assert.equal(open.stats.openSessions, 1);
  assert.equal(open.stats.subscriptions, 1);
  assert.equal(open.stats.streamActive, true);
  assert.equal(open.stats.streamStarts, 1);

  const poll = await bridge.poll('ui-integration-0001', false);
  assert.equal(poll.sessionId, 'ui-integration-0001');
  assert.ok(Array.isArray(poll.events));

  // Existing native tool path stays on the same daemon client when the UI
  // bridge is active.
  const statusTool = defineRamingaTools(api).find((tool) => tool.name === 'raminga_status');
  const toolValue = await statusTool.execute({});
  assert.equal(toolValue.peerId, open.status.peerId);

  const closed = await bridge.close('ui-integration-0001');
  assert.equal(closed.openSessions, 0);
  assert.equal(closed.subscriptions, 0);
  assert.equal(closed.streamActive, false);
  assert.equal(closed.streamStops, 1);

  const reopened = await bridge.open('ui-integration-0002');
  assert.equal(reopened.stats.openSessions, 1);
  assert.equal(reopened.stats.streamActive, true);
  assert.equal(reopened.stats.streamStarts, 2);
  bridge.dispose();
  const disposed = bridge.getStats();
  assert.equal(disposed.openSessions, 0);
  assert.equal(disposed.subscriptions, 0);
  assert.equal(disposed.streamActive, false);
  assert.equal(disposed.streamStops, 2);
});

test('the plugin unload disposer stops an open panel subscription', { skip: !canRun ? `missing ${binary}` : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-unload-'));
  const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const previousProfile = process.env.DSH_PROFILE;
  process.env.DSH_PROFILE = 'headless'; // skip the unrelated tool event subscription in this focused test
  t.after(() => {
    if (previousProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previousProfile;
    spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let service;
  const noop = () => () => {};
  const ctx = {
    systemPrompt: { section: noop },
    tools: { register: noop },
    on: noop,
    get: () => undefined,
    provide: (name, value) => {
      if (name === 'ramingaUi') service = value;
      return () => {};
    },
    emit: () => {},
  };
  const { apply } = await import('../lib/index.js');
  const unload = apply(ctx, { dataDir: dir, ramingaBin: binary });
  assert.ok(service, 'plugin must provide the ramingaUi service');
  const opened = await service.open('ui-unload-0001');
  assert.ok(opened.status?.peerId);
  assert.equal(service.getStats().streamActive, true);
  assert.equal(service.getStats().subscriptions, 1);

  unload();
  const disposed = service.getStats();
  assert.equal(disposed.openSessions, 0);
  assert.equal(disposed.subscriptions, 0);
  assert.equal(disposed.streamActive, false);
  assert.equal(disposed.streamStops, 1);
});

function startDaemon(dir) {
  return spawn(binary, ['daemon', '--data-dir', dir], { stdio: 'ignore' });
}

async function waitUntil(predicate, label, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function stopDir(dir) {
  spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 10000 });
}

test('bridge re-reads a full Status and resubscribes after a real daemon restart', { skip: !canRun ? `missing ${binary}` : false, timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-restart-'));
  const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const config = resolveConfig({ dataDir: dir, ramingaBin: binary });
  const api = new RamingaApi(config);
  let daemon = startDaemon(dir);
  t.after(() => {
    if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM');
    stopDir(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitUntil(() => api.probeStatus(), 'daemon start');

  const bridge = new RamingaUiBridge(api);
  t.after(() => bridge.dispose());
  const opened = await bridge.open('ui-real-restart-0001');
  assert.ok(opened.status?.peerId);
  assert.equal(opened.freshness, 'live');
  assert.equal(opened.stats.subscriptions, 1);
  assert.equal(opened.stats.streamPhase, 'open');
  const firstStartedAt = opened.status.startedAtUnixMs;
  const firstStatusAt = opened.statusAt;

  const exited = new Promise((resolve) => daemon.once('exit', resolve));
  stopDir(dir);
  await exited;
  await waitUntil(async () => !(await api.probeStatus()), 'daemon stop');

  // The bridge must mark the retained snapshot stale, not present a fresh
  // zero-connection Status, and keep its original read time.
  await waitUntil(() => {
    const stats = bridge.getStats();
    return stats.streamPhase !== 'open' && stats.streamActive === false;
  }, 'stream down');
  const down = await bridge.poll('ui-real-restart-0001', true);
  assert.ok(down.error, `expected a readable read error, got ${JSON.stringify(down)}`);
  assert.equal(down.status?.startedAtUnixMs, firstStartedAt);
  assert.ok(down.statusAt >= firstStatusAt);
  assert.notEqual(down.freshness, 'live');
  assert.equal(down.stream.phase === 'open', false);

  daemon = startDaemon(dir);
  await waitUntil(() => api.probeStatus(), 'daemon restart');
  let recovered;
  await waitUntil(async () => {
    try {
      const snapshot = await bridge.poll('ui-real-restart-0001', true);
      const stats = bridge.getStats();
      // A read that began before the Events stream reopened is intentionally
      // not marked live; wait for a post-open read and a fresh snapshot.
      if (stats.streamPhase === 'open' && snapshot.freshness === 'live') {
        recovered = snapshot;
        return true;
      }
    } catch {
      // keep retrying while the daemon finishes binding
    }
    return false;
  }, 'Events resubscribe and fresh Status', 25000);
  assert.ok(recovered);
  assert.equal(recovered.error, null);
  assert.equal(recovered.freshness, 'live');
  assert.equal(recovered.stream.phase, 'open');
  assert.equal(recovered.stats.subscriptions, 1);
  assert.equal(recovered.stats.streamStarts, 1, 'the subscriber object is reused while it reconnects');
  assert.ok(recovered.stats.streamOpens >= 2, 'the Events stream must have reopened');
  assert.notEqual(recovered.status.startedAtUnixMs, firstStartedAt, 'the restarted daemon has a new start time');
  assert.ok(recovered.statusAt > firstStatusAt);
});

test('a real connection and disconnect produce Events and fresh Status reconciliation', { skip: !canRun ? `missing ${binary}` : false, timeout: 45000 }, async (t) => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-main-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-peer-'));
  for (const dir of [mainDir, peerDir]) {
    const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr || init.stdout);
  }
  let mainDaemon = startDaemon(mainDir);
  let peerDaemon = startDaemon(peerDir);
  t.after(() => {
    if (mainDaemon && mainDaemon.exitCode === null) mainDaemon.kill('SIGTERM');
    if (peerDaemon && peerDaemon.exitCode === null) peerDaemon.kill('SIGTERM');
    stopDir(mainDir);
    stopDir(peerDir);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(peerDir, { recursive: true, force: true });
  });

  const mainConfig = resolveConfig({ dataDir: mainDir, ramingaBin: binary });
  const peerConfig = resolveConfig({ dataDir: peerDir, ramingaBin: binary });
  const mainApi = new RamingaApi(mainConfig);
  const peerApi = new RamingaApi(peerConfig);
  await waitUntil(() => mainApi.probeStatus(), 'main daemon start');
  await waitUntil(() => peerApi.probeStatus(), 'peer daemon start');

  const bridge = new RamingaUiBridge(mainApi);
  t.after(() => bridge.dispose());
  const opened = await bridge.open('ui-real-events-0001');
  assert.ok(opened.status?.peerId);
  const peerStatus = await peerApi.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
  const listenAddr = peerStatus.listenAddrs.find((addr) => addr.includes('/tcp/'));
  assert.ok(listenAddr, `peer has no TCP listen address: ${peerStatus.listenAddrs.join(', ')}`);
  const multiaddr = `${listenAddr}/p2p/${peerStatus.peerId}`;

  const seen = [];
  const connect = await mainApi.call((client) => client.connect(new ConnectRequest({ multiaddr }), { timeoutMs: 10000 }));
  assert.equal(connect.peerId, peerStatus.peerId);
  await waitUntil(async () => {
    const snapshot = await bridge.poll('ui-real-events-0001', false);
    seen.push(...snapshot.events);
    return seen.some((event) => event.kind === 'connection') && snapshot.status.connections.length === 1;
  }, 'connected Event and fresh Status');
  assert.ok(seen.filter((event) => event.kind === 'connection').length >= 1);
  assert.equal(seen[0].summary.includes('连接变更'), true);

  stopDir(peerDir);
  await waitUntil(async () => {
    const snapshot = await bridge.poll('ui-real-events-0001', true);
    seen.push(...snapshot.events);
    return seen.filter((event) => event.kind === 'connection').length >= 2
      && snapshot.status.connections.length === 0;
  }, 'disconnect Event and fresh zero-connection Status');
  assert.ok(seen.some((event) => event.kind === 'connection' && /连接变更/.test(event.summary)));
  assert.ok(seen.some((event) => event.kind === 'connection'));
  const final = await bridge.poll('ui-real-events-0001', false);
  assert.equal(final.freshness, 'live');
  assert.equal(final.status.connections.length, 0);
  assert.equal(final.stats.subscriptions, 1);
});

test('real contacts: connect, duplicate reuse, share addresses and persistence', { skip: !canRun ? `missing ${binary}` : false, timeout: 60000 }, async (t) => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-stage4-main-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-stage4-peer-'));
  const initMain = spawnSync(binary, [
    'init', '--no-bootstrap-preset', '--data-dir', mainDir, '--listen', '/ip4/127.0.0.1/tcp/0',
    '--announce', '/ip4/203.0.113.10/tcp/4001',
    '--announce', '/ip4/192.168.1.10/tcp/4001', '--json',
  ], { encoding: 'utf8' });
  assert.equal(initMain.status, 0, initMain.stderr || initMain.stdout);
  const initPeer = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', peerDir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
  assert.equal(initPeer.status, 0, initPeer.stderr || initPeer.stdout);
  let mainDaemon = startDaemon(mainDir);
  let peerDaemon = startDaemon(peerDir);
  t.after(() => {
    if (mainDaemon && mainDaemon.exitCode === null) mainDaemon.kill('SIGTERM');
    if (peerDaemon && peerDaemon.exitCode === null) peerDaemon.kill('SIGTERM');
    stopDir(mainDir);
    stopDir(peerDir);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(peerDir, { recursive: true, force: true });
  });

  const mainApi = new RamingaApi(resolveConfig({ dataDir: mainDir, ramingaBin: binary }));
  const peerApi = new RamingaApi(resolveConfig({ dataDir: peerDir, ramingaBin: binary }));
  await waitUntil(() => mainApi.probeStatus(), 'stage4 main daemon start');
  await waitUntil(() => peerApi.probeStatus(), 'stage4 peer daemon start');
  const peerStatus = await peerApi.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
  const peerListen = peerStatus.listenAddrs.find((addr) => addr.includes('/tcp/'));
  assert.ok(peerListen, 'peer has no TCP listen address');
  const peerAddress = `${peerListen}/p2p/${peerStatus.peerId}`;

  let bridge = new RamingaUiBridge(mainApi, { connectTimeoutMs: 15000 });
  const session = 'ui-stage4-real-0001';
  const opened = await bridge.open(session);
  assert.ok(opened.status?.peerId);

  const connected = await bridge.connect(session, peerAddress);
  assert.equal(connected.ok, true, connected.error || 'connect failed');
  assert.equal(connected.peerId, peerStatus.peerId);
  assert.equal(connected.contact.ok, true);
  assert.equal(connected.contact.found, true, 'Connect must persist the friend record');
  assert.equal(connected.status.ok, true);
  assert.equal(connected.contacts.total, 1);
  assert.equal(connected.contacts.friends[0].connection, 'connected');
  assert.equal(connected.contacts.friends[0].peerId, peerStatus.peerId);

  const duplicate = await bridge.connect(session, peerAddress);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.reused, true, 'an already-connected peer should be reused');
  assert.equal(duplicate.contacts.total, 1, 'duplicate Connect must not duplicate the friend');
  assert.equal(duplicate.contacts.friends.filter((friend) => friend.peerId === peerStatus.peerId).length, 1);

  const share = await bridge.share(session);
  assert.equal(share.ok, true);
  assert.equal(share.peerId, opened.status.peerId);
  assert.equal(share.addresses.length, 2, 'both announced addresses should be shareable');
  assert.ok(share.addresses.every((address) => address.multiaddr.endsWith(`/p2p/${opened.status.peerId}`)));
  assert.ok(share.addresses.some((address) => address.scope === 'public' && address.kind === 'direct'));
  assert.ok(share.addresses.some((address) => address.scope === 'private' && address.kind === 'direct'));
  assert.ok(share.addresses.every((address) => !address.multiaddr.includes('/ip4/127.0.0.1/')));
  assert.ok(share.addresses.every((address) => !address.multiaddr.includes('/p2p/' + peerStatus.peerId)));

  // Restart the daemon and reload the panel: ListFriends is the source of truth.
  await bridge.close(session);
  bridge.dispose();
  const exited = new Promise((resolve) => mainDaemon.once('exit', resolve));
  stopDir(mainDir);
  await exited;
  await waitUntil(async () => !(await mainApi.probeStatus()), 'stage4 main daemon stop');
  mainDaemon = startDaemon(mainDir);
  await waitUntil(() => mainApi.probeStatus(), 'stage4 main daemon restart');

  bridge = new RamingaUiBridge(mainApi, { connectTimeoutMs: 15000 });
  t.after(() => bridge.dispose());
  const reopened = await bridge.open('ui-stage4-real-0002');
  assert.equal(reopened.status?.peerId, opened.status.peerId);
  const persisted = await bridge.contacts('ui-stage4-real-0002', true);
  assert.equal(persisted.total, 1, 'the friend must survive a daemon restart');
  assert.equal(persisted.friends[0].peerId, peerStatus.peerId);

  // Dropping the connection does not remove the contact.
  const peerExited = new Promise((resolve) => peerDaemon.once('exit', resolve));
  stopDir(peerDir);
  await peerExited;
  await waitUntil(async () => {
    const contacts = await bridge.contacts('ui-stage4-real-0002', true);
    const friend = contacts.friends.find((item) => item.peerId === peerStatus.peerId);
    return contacts.total === 1 && friend && friend.connection !== 'connected';
  }, 'contact retained after disconnect', 25000);
  const afterDisconnect = await bridge.contacts('ui-stage4-real-0002', true);
  assert.equal(afterDisconnect.total, 1);
  assert.equal(afterDisconnect.friends[0].connection !== 'connected', true);
});

test('real peer manifest, manual file fetch and discovery provenance stay versioned', { skip: !canRun ? `missing ${binary}` : false, timeout: 90000 }, async (t) => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-files-main-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-files-peer-'));
  for (const dir of [mainDir, peerDir]) {
    const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr || init.stdout);
  }
  fs.mkdirSync(path.join(peerDir, 'public', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(peerDir, 'public', 'posts'), { recursive: true });
  fs.writeFileSync(path.join(peerDir, 'public', 'notes', 'hello.md'), '# Peer Hello\n\n直接放在公开目录的正文。');
  const post = {
    schema_version: 1, title: '旧 JSON 帖子', format: 'markdown',
    author: { peer_id: '', kind: 'user', display_name: 'Peer User' },
    published_at: '2026-11-14T10:00:00Z', body: '# 旧 JSON 帖子\n\n兼容正文。',
  };
  // The author mapping must match the peer's actual Peer ID; read it after the
  // peer daemon starts and rewrite the file before the manifest is requested.
  let peerDaemon = startDaemon(peerDir);
  let mainDaemon = null;
  t.after(() => {
    if (mainDaemon && mainDaemon.exitCode === null) mainDaemon.kill('SIGTERM');
    if (peerDaemon && peerDaemon.exitCode === null) peerDaemon.kill('SIGTERM');
    stopDir(mainDir);
    stopDir(peerDir);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(peerDir, { recursive: true, force: true });
  });
  const peerConfig = resolveConfig({ dataDir: peerDir, ramingaBin: binary });
  const peerApi = new RamingaApi(peerConfig);
  await waitUntil(() => peerApi.probeStatus(), 'peer daemon start');
  const peerStatus = await peerApi.call((client) => client.status(new StatusRequest()));
  post.author.peer_id = peerStatus.peerId;
  fs.writeFileSync(path.join(peerDir, 'public', 'posts', 'legacy.json'), JSON.stringify(post));

  const mainConfig = resolveConfig({ dataDir: mainDir, ramingaBin: binary });
  const mainApi = new RamingaApi(mainConfig);
  let revealed = '';
  const bridge = new RamingaUiBridge(mainApi, {
    revealPath: async (absolutePath) => { revealed = absolutePath; },
  });
  t.after(() => bridge.dispose());
  const opened = await bridge.open('ui-real-files-0001');
  assert.ok(opened.status?.peerId);
  fs.writeFileSync(path.join(mainDir, 'public', 'mine-note.md'), '# Local Public\n\nMine list uses Published.\n');
  const mine = await bridge.mine('ui-real-files-0001', true);
  assert.equal(mine.error, null, mine.error || '');
  assert.equal(mine.files.some((file) => file.path === 'mine-note.md'), true, 'Published must drive the Mine file list');
  const addrs = peerStatus.listenAddrs ?? [];
  const addr = addrs.find((value) => value.includes('/tcp/'));
  assert.ok(addr, `peer has no TCP listen address: ${JSON.stringify(addrs)}`);
  const connected = await bridge.connect('ui-real-files-0001', `${addr}/p2p/${peerStatus.peerId}`);
  assert.equal(connected.ok, true, connected.error || connected.detail || '');

  // Add the public address book before the first manifest read so its size and
  // hash are part of the same manifest snapshot.
  fs.writeFileSync(path.join(peerDir, 'public', 'friends.json'), JSON.stringify({
    version: 1,
    friends: [{ name: 'Main Node', peer_id: opened.status.peerId, addrs: [], description: '公开通讯录声明' }],
  }));
  const addressBook = await bridge.peerFriends('ui-real-files-0001', peerStatus.peerId, true);
  assert.equal(addressBook.source, 'remote', addressBook.error || '');
  assert.equal(addressBook.error, null);
  assert.equal(addressBook.friends.length, 1);
  assert.equal(addressBook.friends[0].name, 'Main Node');
  assert.equal(addressBook.friends[0].peerId, opened.status.peerId);
  assert.match(addressBook.friends[0].description, /公开通讯录声明/);

  const manifest = await bridge.peerManifest('ui-real-files-0001', peerStatus.peerId, true);
  assert.equal(manifest.error, null);
  const hello = manifest.entries.find((entry) => entry.path === 'notes/hello.md');
  assert.ok(hello, `hello.md missing from manifest: ${JSON.stringify(manifest.entries)}`);
  const legacy = manifest.entries.find((entry) => entry.path === 'posts/legacy.json');
  assert.ok(legacy);

  const preview = await bridge.peerFilePreview('ui-real-files-0001', peerStatus.peerId, hello.path, hello.sha256, hello.sizeBytes);
  assert.equal(preview.status, 'ok');
  assert.equal(preview.discoveryRecorded, true);
  assert.equal(preview.source, 'raminga_ui_manual');
  assert.match(preview.text, /Peer Hello/);

  const legacyPreview = await bridge.peerFilePreview('ui-real-files-0001', peerStatus.peerId, legacy.path, legacy.sha256, legacy.sizeBytes);
  assert.equal(legacyPreview.status, 'ok');
  assert.equal(legacyPreview.title, '旧 JSON 帖子');
  assert.match(legacyPreview.text, /兼容正文/);

  const discoveries = await bridge.discoveries('ui-real-files-0001', false, true);
  assert.equal(discoveries.items.some((item) => item.path === 'notes/hello.md'), false,
    'ordinary public files stay out of the posts-only Feed');
  assert.ok(discoveries.items.some((item) => item.path === 'posts/legacy.json'),
    'the legacy versioned post remains in the Feed');
  assert.equal(discoveries.ignored, 0,
    'the daemon candidate filter excludes hello.md before the Feed counts ignored rows');
  const refreshedManifest = await bridge.peerManifest('ui-real-files-0001', peerStatus.peerId, true);
  const manualEntry = refreshedManifest.entries.find((entry) => entry.path === 'notes/hello.md');
  assert.equal(manualEntry.source, 'raminga_ui_manual');
  assert.deepEqual(manualEntry.sources, ['raminga_ui_manual']);

  const reveal = await bridge.revealFile(
    'ui-real-files-0001', 'peer', peerStatus.peerId,
    manualEntry.path, manualEntry.sha256, manualEntry.sizeBytes,
  );
  assert.equal(reveal.ok, true, reveal.error || '');
  assert.equal(reveal.path, undefined);
  assert.ok(revealed.endsWith(path.join('downloads', peerStatus.peerId, 'notes', 'hello.md')), revealed);

  const node = await bridge.peerNodeInfo('ui-real-files-0001', peerStatus.peerId, true);
  assert.equal(node.connectionState, 'connected');
  assert.ok(node.currentAddresses.length > 0);

  // Keep only the real downloaded copy, stop the publishing daemon, and open
  // a fresh bridge/panel lease. The peer homepage must recover the persisted
  // discovery evidence and read the same hash locally instead of downloading.
  const peerExited = new Promise((resolve) => peerDaemon.once('exit', resolve));
  stopDir(peerDir);
  await peerExited;
  await waitUntil(async () => {
    const status = await mainApi.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
    return status.connections.length === 0;
  }, 'peer offline before local history recovery');
  bridge.dispose();

  const offlineBridge = new RamingaUiBridge(mainApi, {
    revealPath: async (absolutePath) => { revealed = absolutePath; },
  });
  t.after(() => offlineBridge.dispose());
  await offlineBridge.open('ui-real-files-offline');
  const offlineProfile = await offlineBridge.peerProfile('ui-real-files-offline', peerStatus.peerId, true);
  assert.equal(offlineProfile.source, 'local-copy');
  assert.equal(offlineProfile.manifest.source, 'local-history');
  assert.match(offlineProfile.error, /下载副本|历史副本|本地/);
  const offlineHello = offlineProfile.manifest.entries.find((entry) => entry.path === 'notes/hello.md');
  assert.ok(offlineHello, 'the downloaded hello.md must survive an offline bridge restart');
  assert.equal(offlineHello.contentState, 'available');
  assert.deepEqual(offlineHello.sources, ['raminga_ui_manual']);
  const offlinePreview = await offlineBridge.peerFilePreview(
    'ui-real-files-offline', peerStatus.peerId, offlineHello.path, offlineHello.sha256, offlineHello.sizeBytes,
  );
  assert.equal(offlinePreview.status, 'ok', offlinePreview.error || '');
  assert.equal(offlinePreview.acquisition, 'local-copy');
  assert.match(offlinePreview.text, /Peer Hello/);
  const offlineReveal = await offlineBridge.revealFile(
    'ui-real-files-offline', 'peer', peerStatus.peerId, offlineHello.path, offlineHello.sha256, offlineHello.sizeBytes,
  );
  assert.equal(offlineReveal.status, 'revealed', offlineReveal.error || '');
  assert.ok(revealed.endsWith(path.join('downloads', peerStatus.peerId, 'notes', 'hello.md')), revealed);
});

function shortPeerId(peerId) {
  return peerId.length > 22 ? `${peerId.slice(0, 10)}…${peerId.slice(-8)}` : peerId;
}

test('real dual-node public profile, avatar and user/Agent posts publish atomically', { skip: !canRun ? `missing ${binary}` : false, timeout: 120000 }, async (t) => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-pub-main-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-pub-peer-'));
  for (const dir of [mainDir, peerDir]) {
    const init = spawnSync(binary, ['init', '--no-bootstrap-preset', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr || init.stdout);
  }
  let mainDaemon = startDaemon(mainDir);
  let peerDaemon = startDaemon(peerDir);
  t.after(() => {
    if (mainDaemon && mainDaemon.exitCode === null) mainDaemon.kill('SIGTERM');
    if (peerDaemon && peerDaemon.exitCode === null) peerDaemon.kill('SIGTERM');
    stopDir(mainDir);
    stopDir(peerDir);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(peerDir, { recursive: true, force: true });
  });
  const mainApi = new RamingaApi(resolveConfig({ dataDir: mainDir, ramingaBin: binary }));
  const peerApi = new RamingaApi(resolveConfig({ dataDir: peerDir, ramingaBin: binary }));
  await waitUntil(() => mainApi.probeStatus(), 'publish main daemon start');
  await waitUntil(() => peerApi.probeStatus(), 'publish peer daemon start');
  const peerStatus = await peerApi.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
  const peerListen = peerStatus.listenAddrs.find((addr) => addr.includes('/tcp/'));
  assert.ok(peerListen, 'peer has no TCP listen address');
  const peerAddress = `${peerListen}/p2p/${peerStatus.peerId}`;

  const mainBridge = new RamingaUiBridge(mainApi);
  const peerBridge = new RamingaUiBridge(peerApi);
  t.after(() => {
    mainBridge.dispose();
    peerBridge.dispose();
  });
  const mainSession = 'ui-real-publication-main';
  const peerSession = 'ui-real-publication-peer';
  await mainBridge.open(mainSession);
  await peerBridge.open(peerSession);
  const connected = await mainBridge.connect(mainSession, peerAddress);
  assert.equal(connected.ok, true, connected.error || 'connect failed');

  let profileDraft = (await peerBridge.savePublicDraft(peerSession, {
    kind: 'profile', expectedRevision: 0,
    agentName: 'Nebula', agentDescription: '喜欢星空与独立游戏',
    agentInterests: ['天文', '独立游戏'], agentConversationStyle: '好奇而温和',
    humanName: 'JO JO', humanBioMarkdown: '喜欢创造有趣的东西',
    imageAssetIds: [], tags: [],
  })).draft;
  // A 1x1 PNG, re-encoded by the daemon; its hash/size are the receipt values.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const avatar = await peerBridge.putPublicDraftImage(peerSession, profileDraft.draftId, 'avatar', 'avatar.png', png.toString('base64'));
  profileDraft = (await peerBridge.savePublicDraft(peerSession, {
    draftId: profileDraft.draftId, kind: 'profile', expectedRevision: profileDraft.revision,
    agentName: 'Nebula', agentDescription: '喜欢星空与独立游戏',
    agentInterests: ['天文', '独立游戏'], agentConversationStyle: '好奇而温和',
    humanName: 'JO JO', humanBioMarkdown: '喜欢创造有趣的东西',
    avatarAssetId: avatar.image.assetId, imageAssetIds: [], tags: [],
  })).draft;
  const profileReceipt = await peerBridge.publishPublicDraft(peerSession, profileDraft.draftId, profileDraft.revision, '');
  assert.equal(profileReceipt.status, 'published');
  assert.match(profileReceipt.profilePath, /^profile\/profile\.json$/);
  assert.match(profileReceipt.manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(profileReceipt.files.some((file) => file.path === profileReceipt.profilePath));
  assert.ok(profileReceipt.files.some((file) => file.path.startsWith('profile/avatar-')));

  const remoteProfile = await mainBridge.peerProfile(mainSession, peerStatus.peerId, true);
  assert.equal(remoteProfile.found, true);
  assert.equal(remoteProfile.agentCard.state, 'available');
  assert.equal(remoteProfile.agentCard.card.displayName, 'Nebula');
  assert.equal(remoteProfile.remoteName, 'JO JO');
  assert.match(remoteProfile.agentCard.card.avatarPath, /^profile\/avatar-[a-f0-9]{8}\.png$/);
  assert.match(remoteProfile.agentCard.card.avatarSha256, /^[a-f0-9]{64}$/);
  assert.equal(remoteProfile.agentCard.card.legacyFallback, false);
  const avatarAsset = await peerBridge.publicDraftAsset(peerSession, profileDraft.draftId, avatar.image.assetId);
  assert.equal(avatarAsset.image.assetId, avatar.image.assetId);
  assert.equal(avatarAsset.image.sha256, avatar.image.sha256);
  assert.equal(Buffer.from(avatarAsset.dataBase64, 'base64').length, avatar.image.sizeBytes);
  await assert.rejects(
    peerBridge.publicDraftAsset(peerSession, 'draft-does-not-exist', avatar.image.assetId),
    /不存在|不属于|草稿/,
  );

  async function publishPost(authorKind, title) {
    let draft = (await peerBridge.savePublicDraft(peerSession, {
      kind: 'post', authorKind, expectedRevision: 0, title, bodyMarkdown: `# ${title}\n\n真实双节点正文。`,
      tags: ['双节点'], imageAssetIds: [],
    })).draft;
    draft = (await peerBridge.savePublicDraft(peerSession, {
      draftId: draft.draftId, kind: 'post', authorKind, expectedRevision: draft.revision,
      title, bodyMarkdown: `# ${title}\n\n真实双节点正文。`, tags: ['双节点'], imageAssetIds: [],
    })).draft;
    const receipt = await peerBridge.publishPublicDraft(peerSession, draft.draftId, draft.revision, '');
    assert.equal(receipt.status, 'published', receipt.error);
    return { draft, receipt };
  }

  const userPost = await publishPost('user', '本人发布');
  const agentPost = await publishPost('agent', 'Agent 发布');
  assert.notEqual(userPost.receipt.manifestSha256, agentPost.receipt.manifestSha256);

  // Publish a real v2 image post through the same private-draft -> atomic
  // publish path, then read its metadata and image through the remote bridge.
  let imageDraft = (await peerBridge.savePublicDraft(peerSession, {
    kind: 'post', authorKind: 'user', expectedRevision: 0, title: '真实图文动态',
    bodyMarkdown: '# 真实图文动态\n\n带一张真实公开配图。', tags: ['图文'], imageAssetIds: [],
  })).draft;
  const imageAsset = await peerBridge.putPublicDraftImage(peerSession, imageDraft.draftId, 'image', 'cover.png', png.toString('base64'));
  imageDraft = (await peerBridge.savePublicDraft(peerSession, {
    draftId: imageDraft.draftId, kind: 'post', authorKind: 'user', expectedRevision: imageDraft.revision,
    title: '真实图文动态', bodyMarkdown: '# 真实图文动态\n\n带一张真实公开配图。', tags: ['图文'],
    imageAssetIds: [imageAsset.image.assetId],
  })).draft;
  const imageReceipt = await peerBridge.publishPublicDraft(peerSession, imageDraft.draftId, imageDraft.revision, '');
  assert.equal(imageReceipt.status, 'published', imageReceipt.error);
  const publishedImageFile = imageReceipt.files.find((file) => /^posts\/[a-z0-9-]+\/images\/[a-f0-9]{64}\.png$/.test(file.path));
  assert.ok(publishedImageFile, 'publish receipt is missing the public image file');

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const manifest = await mainBridge.peerManifest(mainSession, peerStatus.peerId, true);
  assert.equal(manifest.source, 'remote');
  for (const receipt of [profileReceipt, userPost.receipt, agentPost.receipt, imageReceipt]) {
    for (const file of receipt.files) {
      assert.ok(manifest.entries.some((entry) => entry.path === file.path), `manifest missing ${file.path}`);
    }
  }
  async function readPost(receipt) {
    const entry = manifest.entries.find((file) => file.path === receipt.postPath);
    assert.ok(entry, `post entry missing: ${receipt.postPath}`);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const preview = await mainBridge.peerFilePreview(mainSession, peerStatus.peerId, entry.path, entry.sha256, entry.sizeBytes);
    assert.equal(preview.ok, true, preview.error);
    assert.ok(preview.post, 'post.json must parse as a versioned post');
    return preview.post;
  }
  const userParsed = await readPost(userPost.receipt);
  const agentParsed = await readPost(agentPost.receipt);
  assert.equal(userParsed.authorKind, 'user');
  assert.equal(agentParsed.authorKind, 'agent');
  assert.equal(agentParsed.authorName, 'Nebula');
  assert.equal(userParsed.authorName, 'JO JO');

  const imageEntry = manifest.entries.find((entry) => entry.path === imageReceipt.postPath);
  assert.ok(imageEntry, 'image post is missing from the remote manifest');
  const imageMeta = await mainBridge.peerPostMeta(mainSession, peerStatus.peerId, imageEntry.path, imageEntry.sha256, imageEntry.sizeBytes);
  assert.equal(imageMeta.found, true, imageMeta.error);
  assert.equal(imageMeta.title, '真实图文动态');
  assert.equal(imageMeta.images.length, 1);
  assert.equal(imageMeta.images[0].publicPath, publishedImageFile.path);
  assert.equal(imageMeta.images[0].sha256, publishedImageFile.sha256);
  assert.equal(imageMeta.images[0].sizeBytes, publishedImageFile.sizeBytes);
  assert.equal(imageMeta.images[0].mime, 'image/png');
  assert.equal(imageMeta.images[0].manifestState, 'available');
  const imagePreview = await mainBridge.peerFilePreview(
    mainSession, peerStatus.peerId, imageMeta.images[0].publicPath,
    imageMeta.images[0].sha256, imageMeta.images[0].sizeBytes,
  );
  assert.equal(imagePreview.status, 'ok', imagePreview.error);
  assert.equal(imagePreview.kind, 'image');
  assert.equal(imagePreview.discoveryRecorded, false, 'embedded post image must not create a separate discovery row');
  assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/);
  const mineWithImage = await peerBridge.mine(peerSession, true);
  const mineImagePost = mineWithImage.files.find((entry) => entry.path === imageReceipt.postPath);
  assert.ok(mineImagePost, 'Mine list is missing the published image post');
  assert.equal(mineImagePost.images.length, 1);
  assert.equal(mineImagePost.images[0].publicPath, publishedImageFile.path);
  const mineImage = await peerBridge.mineFilePreview(
    peerSession, mineImagePost.images[0].publicPath,
    mineImagePost.images[0].sha256, mineImagePost.images[0].sizeBytes,
  );
  assert.equal(mineImage.status, 'ok', mineImage.error);
  assert.equal(mineImage.kind, 'image');
  assert.match(mineImage.dataUrl, /^data:image\/png;base64,/);

  // Existing published posts with no remaining private draft can be imported
  // into controlled editing and update the same public path, keeping origin.
  assert.equal((await peerBridge.deletePublicDraft(peerSession, agentPost.draft.draftId, agentPost.draft.revision)).deleted, true);
  let imported = (await peerBridge.importPublicPost(peerSession, agentPost.receipt.postPath)).draft;
  assert.equal(imported.publishedPath, agentPost.receipt.postPath);
  assert.equal(imported.authorKind, 'agent');
  assert.match(imported.publishedSha256, /^[a-f0-9]{64}$/);
  imported = (await peerBridge.savePublicDraft(peerSession, {
    draftId: imported.draftId, kind: 'post', expectedRevision: imported.revision,
    authorKind: 'agent', title: 'Agent 发布（已编辑）', bodyMarkdown: imported.bodyMarkdown,
    tags: imported.tags, imageAssetIds: imported.images.map((image) => image.assetId),
  })).draft;
  const editedReceipt = await peerBridge.publishPublicDraft(peerSession, imported.draftId, imported.revision, imported.publishedSha256);
  assert.equal(editedReceipt.status, 'published', editedReceipt.error);
  assert.equal(editedReceipt.postPath, agentPost.receipt.postPath);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const editedManifest = await mainBridge.peerManifest(mainSession, peerStatus.peerId, true);
  const editedEntry = editedManifest.entries.find((entry) => entry.path === agentPost.receipt.postPath);
  assert.ok(editedEntry, 'edited original post missing from manifest');
  const editedPreview = await mainBridge.peerFilePreview(mainSession, peerStatus.peerId, editedEntry.path, editedEntry.sha256, editedEntry.sizeBytes);
  assert.equal(editedPreview.ok, true, editedPreview.error);
  assert.equal(editedPreview.post.title, 'Agent 发布（已编辑）');
  assert.equal(editedPreview.post.authorKind, 'agent');

  // Drafts never appear before publish: a second, unpublished Agent draft is
  // private and the public manifest count stays at the committed files.
  const unpublished = (await peerBridge.savePublicDraft(peerSession, {
    kind: 'post', authorKind: 'agent', expectedRevision: 0, title: '未发布草稿',
    bodyMarkdown: '仍在 SQLite', tags: [], imageAssetIds: [],
  })).draft;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await mainBridge.peerManifest(mainSession, peerStatus.peerId, true);
  assert.equal(after.entries.some((entry) => entry.path.includes(unpublished.draftId)), false, 'draft leaked into public manifest');
  assert.equal(after.entries.length, manifest.entries.length, 'unpublished draft changed the manifest');
});
