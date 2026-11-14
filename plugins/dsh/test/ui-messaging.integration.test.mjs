// Real two-daemon messaging integration for the DSH bridge.
//
// Uses two independent temporary data directories and the repository binary.
// Only loopback test peers are involved; no user contact, DSH profile or
// browser is touched. It covers human send/ACK, inbound reply, queued delivery
// after a peer disconnect, cancellation, restart persistence, provenance and
// idempotent replay.
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
import { ListMessagesRequest, SendChatRequest, StatusRequest } from '../lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const binary = path.join(repoRoot, 'bin', 'raminga');
const canRun = process.platform !== 'win32' && fs.existsSync(binary);

function startDaemon(dir) {
  return spawn(binary, ['daemon', '--data-dir', dir], { stdio: 'ignore' });
}

async function waitUntil(predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function stopDir(dir) {
  spawnSync(binary, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 10000 });
}

async function peerTCPAddr(api) {
  const status = await api.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
  const listen = status.listenAddrs.find((addr) => addr.includes('/tcp/'));
  assert.ok(listen, `peer has no TCP listen address: ${status.listenAddrs.join(', ')}`);
  return { peerId: status.peerId, multiaddr: `${listen}/p2p/${status.peerId}` };
}

async function listPage(api, peerId, before = '') {
  return api.call((client) => client.listMessages(
    new ListMessagesRequest({ peerId, before, limit: 100 }),
    { timeoutMs: 4000 },
  ));
}

test('two real daemons: human send, reply, queue, cancel, restart and replay', {
  skip: !canRun ? `missing ${binary}` : false,
  timeout: 120000,
}, async (t) => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-msg-main-'));
  const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-ui-msg-peer-'));
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
  const peer = await peerTCPAddr(peerApi);
  const mainStatus = await mainApi.call((client) => client.status(new StatusRequest(), { timeoutMs: 3000 }));
  assert.equal(mainStatus.apiVersion, '4');
  assert.equal(mainStatus.maxChatTextBytes > 0, true);

  const connect = await mainApi.call((client) => client.connect({ peerId: peer.peerId, multiaddr: peer.multiaddr }, { timeoutMs: 10000 }));
  assert.equal(connect.peerId, peer.peerId);

  const bridge = new RamingaUiBridge(mainApi);
  t.after(() => bridge.dispose());
  const opened = await bridge.open('ui-msg-integration-0001');
  assert.equal(opened.status.apiVersion, '4');

  const first = await bridge.send('ui-msg-integration-0001', peer.peerId, '你好，来自人工界面', 'ui-int-request-1');
  assert.equal(first.ok, true);
  assert.equal(first.acked, true);
  assert.equal(first.deliveryStatus, 'acked');
  assert.equal(first.replayed, false);

  let peerPage = await listPage(peerApi, mainStatus.peerId);
  assert.equal(peerPage.messages.length, 1);
  assert.equal(peerPage.messages[0].text, '你好，来自人工界面');
  assert.equal(peerPage.messages[0].direction, 'in');

  // Replaying the same idempotency key returns the same persisted message and
  // does not deliver a second copy.
  const replay = await bridge.send('ui-msg-integration-0001', peer.peerId, '你好，来自人工界面', 'ui-int-request-1');
  assert.equal(replay.replayed, true);
  assert.equal(replay.messageId, first.messageId);
  peerPage = await listPage(peerApi, mainStatus.peerId);
  assert.equal(peerPage.messages.length, 1, 'replay must not duplicate the receiver row');

  // The peer replies through the same human local API helper.
  const reply = await peerApi.call((client) => client.sendChat(new SendChatRequest({
    peerId: mainStatus.peerId,
    text: '收到，这是回复',
    origin: 'human',
    agentOrigin: false,
    requestId: 'ui-int-reply-1',
  }), { timeoutMs: 15000 }));
  assert.equal(reply.acked, true);
  let mainPage = await bridge.messages('ui-msg-integration-0001', peer.peerId, '', true);
  await waitUntil(async () => {
    mainPage = await bridge.messages('ui-msg-integration-0001', peer.peerId, '', true);
    return mainPage.messages.some((row) => row.text === '收到，这是回复' && row.direction === 'in');
  }, 'inbound reply in persisted page');
  assert.equal(mainPage.messages.find((row) => row.text === '你好，来自人工界面').origin, 'human');
  assert.equal(mainPage.messages.find((row) => row.text === '收到，这是回复').origin, 'unknown');

  // Conversation summary includes both messages for the Peer.
  let conversations = await bridge.conversations('ui-msg-integration-0001', true);
  const summary = conversations.conversations.find((row) => row.peerId === peer.peerId);
  assert.ok(summary);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.direction, 'in');

  // Stop the peer, queue a message, cancel a second one, then restart and
  // confirm only the queued message is delivered.
  stopDir(peerDir);
  await waitUntil(async () => {
    try {
      return !(await peerApi.probeStatus());
    } catch {
      return true;
    }
  }, 'peer stopped');
  const queued = await bridge.send('ui-msg-integration-0001', peer.peerId, '断线后排队的消息', 'ui-int-request-queue');
  assert.equal(queued.ok, true);
  assert.equal(queued.acked, false);
  assert.equal(queued.deliveryStatus, 'pending');
  const cancelled = await bridge.send('ui-msg-integration-0001', peer.peerId, '这条会被取消', 'ui-int-request-cancel');
  assert.equal(cancelled.deliveryStatus, 'pending');
  const cancel = await bridge.cancelOutbox('ui-msg-integration-0001', cancelled.messageId);
  assert.equal(cancel.ok, true);
  const afterCancel = await bridge.messages('ui-msg-integration-0001', peer.peerId, '', true);
  assert.equal(afterCancel.messages.find((row) => row.messageId === cancelled.messageId).deliveryStatus, 'cancelled');

  peerDaemon = startDaemon(peerDir);
  await waitUntil(() => peerApi.probeStatus(), 'peer restart');
  // The fixture peer listens on an ephemeral port, so reconnect to its new
  // address explicitly. The outbox itself is what retries delivery.
  const restartedPeer = await peerTCPAddr(peerApi);
  await mainApi.call((client) => client.connect({ peerId: restartedPeer.peerId, multiaddr: restartedPeer.multiaddr }, { timeoutMs: 10000 }));
  await waitUntil(async () => {
    const page = await bridge.messages('ui-msg-integration-0001', peer.peerId, '', true);
    return page.messages.find((row) => row.messageId === queued.messageId)?.deliveryStatus === 'acked';
  }, 'queued message acked after peer restart', 45000);
  const peerAfter = await listPage(peerApi, mainStatus.peerId);
  assert.ok(peerAfter.messages.some((row) => row.text === '断线后排队的消息'));
  assert.equal(peerAfter.messages.some((row) => row.text === '这条会被取消'), false, 'cancelled outbox row must not deliver');

  // Durable human relation survives the message window and restart. It is
  // queryable independently from RecentMessages.
  const relations = await mainApi.call((client) => client.listHumanOutboundPeers('', 100));
  assert.ok(relations.peers.some((row) => row.peerId === peer.peerId), 'human send records the relation');

  // Restart the main daemon and reopen a fresh bridge session: history, origin
  // and delivery state come from SQLite, not from in-memory events.
  stopDir(mainDir);
  await waitUntil(async () => {
    try {
      return !(await mainApi.probeStatus());
    } catch {
      return true;
    }
  }, 'main daemon stopped');
  mainDaemon = startDaemon(mainDir);
  await waitUntil(() => mainApi.probeStatus(), 'main daemon restart');
  const reopened = await bridge.open('ui-msg-integration-0002');
  assert.ok(reopened.status?.peerId);
  const restored = await bridge.messages('ui-msg-integration-0002', peer.peerId, '', true);
  const queuedRow = restored.messages.find((row) => row.text === '断线后排队的消息');
  assert.ok(queuedRow, 'queued history survives restart');
  assert.equal(queuedRow.deliveryStatus, 'acked');
  assert.equal(queuedRow.origin, 'human');
  assert.equal(restored.messages.find((row) => row.text === '这条会被取消').deliveryStatus, 'cancelled');

  await bridge.close('ui-msg-integration-0001');
  await bridge.close('ui-msg-integration-0002');
  const stats = bridge.getStats();
  assert.equal(stats.openSessions, 0);
  assert.equal(stats.subscriptions, 0);
});
