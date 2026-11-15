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
  const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
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
  assert.ok(open.status?.apiVersion === '4', `unexpected API version: ${open.status?.apiVersion}`);
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
  const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
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
  const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
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
    const init = spawnSync(binary, ['init', '--data-dir', dir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
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
    'init', '--data-dir', mainDir, '--listen', '/ip4/127.0.0.1/tcp/0',
    '--announce', '/ip4/203.0.113.10/tcp/4001',
    '--announce', '/ip4/192.168.1.10/tcp/4001', '--json',
  ], { encoding: 'utf8' });
  assert.equal(initMain.status, 0, initMain.stderr || initMain.stdout);
  const initPeer = spawnSync(binary, ['init', '--data-dir', peerDir, '--listen', '/ip4/127.0.0.1/tcp/0', '--json'], { encoding: 'utf8' });
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
