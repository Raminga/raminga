// Add real retained inbound messages for a repeat run of the batch2-02
// acceptance. It only uses the isolated fixture nodes and never touches the
// user's node or DSH profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DisconnectPeerRequest,
  OutboxListRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.B2_ACCEPTANCE_DIR
  ? path.resolve(process.env.B2_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b2-contacts');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const count = Math.max(1, Math.min(50, Number(process.env.B2_UNREAD_COUNT || 3)));
const tag = String(process.env.B2_UNREAD_TAG || Date.now()).replace(/[^a-zA-Z0-9-]/g, '');

const apiB = new RamingaApi(resolveConfig({ dataDir: fixture.nodeBData, ramingaBin: bin }));
const apiA = new RamingaApi(resolveConfig({ dataDir: fixture.nodeAData, ramingaBin: bin }));

async function statusB() {
  return apiB.call((client) => client.status(new StatusRequest()));
}

async function statusA() {
  return apiA.call((client) => client.status(new StatusRequest()));
}

async function waitFor(predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// A fixture preparation that restarts A leaves B holding a dead socket. Close
// it through the normal local RPC before reconnecting; the subsequent explicit
// Connect resumes the peer. Without this, sendChat can reuse the dead
// connection and the messages stay pending (the earlier repeat-run failure).
try {
  await apiB.call((client) => client.disconnectPeer(new DisconnectPeerRequest({ peerId: fixture.nodeA })));
} catch {
  // No stale connection was present.
}
await waitFor(async () => {
  try {
    await apiB.call((client) => client.connect(new ConnectRequest({
      multiaddr: fixture.nodeAAddr,
      peerId: fixture.nodeA,
    })));
  } catch {
    // An already-live connection is fine; Status below is the proof.
  }
  const status = await statusB();
  return (status.connections || []).some((item) => item.peerId === fixture.nodeA)
    || (status.peers || []).some((item) => item.peerId === fixture.nodeA);
}, 'B to A connection');

const ids = [];
for (let index = 0; index < count; index += 1) {
  const text = index === count - 1
    ? `最后一条未读：窗口还开着，潮声也还在。复验 ${tag}`
    : `第 ${index + 1} 封复验回信：潮水退到石阶下面。把今天看见的盐味和旧邮票留在这里。`;
  const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
    peerId: fixture.nodeA,
    multiaddr: fixture.nodeAAddr,
    text,
    origin: 'human',
    agentOrigin: false,
    requestId: `b2-rerun-${tag}-${String(index + 1).padStart(2, '0')}`,
  })));
  if (!result.messageId) throw new Error(`message ${index + 1} was not persisted`);
  ids.push(result.messageId);
}
// Wait until every new row is either retained by A or provably failed, and
// until B's outbox has drained. A pending outbox is not a retained message.
const target = ids[ids.length - 1];
let retained = false;
let retentionError = '';
const started = Date.now();
while (Date.now() - started < 45000 && !retained) {
  try {
    const page = await apiA.call((client) => client.listMessages({
      peerId: fixture.nodeB,
      limit: 100,
    }));
    retained = page.messages.some((message) => message.messageId === target);
    if (!retained) {
      const outbox = await apiB.call((client) => client.outboxList(new OutboxListRequest()));
      const pending = Number(outbox.stats?.pending || 0);
      if (pending === 0) {
        // The outbox is empty but the target is missing: retrying the same
        // request would be a replay, so report the real state instead of
        // pretending a new send happened.
        retentionError = 'B outbox is empty but A did not retain the target message';
        break;
      }
    }
  } catch (error) {
    retentionError = error instanceof Error ? error.message : String(error);
  }
  if (!retained) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!retained) {
  let diagnostic = '';
  try {
    const [a, b] = await Promise.all([statusA(), statusB()]);
    diagnostic = JSON.stringify({
      aPeers: (a.peers || []).map((item) => item.peerId),
      aConnections: (a.connections || []).map((item) => item.peerId),
      bPeers: (b.peers || []).map((item) => item.peerId),
      bConnections: (b.connections || []).map((item) => item.peerId),
    });
  } catch (error) {
    diagnostic = `status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error(`A did not retain the new unread message (${retentionError || 'timeout'}); ${diagnostic}`);
}
console.log(JSON.stringify({ ok: true, count, ids, retained: target }));
