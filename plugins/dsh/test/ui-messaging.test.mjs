// Focused bridge tests for conversation summaries, message pages, human sends
// and cancellation. No daemon or browser is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

const PEER_A = '12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe';
const PEER_B = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';

function statusResponse() {
  return {
    peerId: PEER_A,
    nodeId: 'node-a',
    version: 'test',
    protocolVersion: '1',
    apiVersion: '4',
    startedAtUnixMs: 1000,
    currentTime: 'now',
    listenAddrs: [],
    connections: [],
    peers: [],
    maxChatTextBytes: 4096,
    maxStoredMessages: 50000,
  };
}

function streamFake() {
  let handlers = null;
  return {
    subscribe(_api, onEvent, onError, onState) {
      handlers = { onEvent, onError, onState };
      onState('connecting');
      queueMicrotask(() => handlers?.onState('open'));
      return () => {
        const current = handlers;
        handlers = null;
        current?.onState('closed');
      };
    },
    emit(raw) { handlers?.onEvent(raw); },
  };
}

function page(messages, overrides = {}) {
  return {
    messages,
    nextBefore: '',
    hasMore: false,
    retention: { retainedMessages: messages.length, oldestRetainedAtUnixMs: 1000, maxStoredMessages: 50000 },
    ...overrides,
  };
}

function message(id, peerId = PEER_A, overrides = {}) {
  return {
    messageId: id,
    peerId,
    direction: 'out',
    text: `text-${id}`,
    acked: false,
    createdAtUnixMs: 1000,
    ackedAtUnixMs: 0,
    deliveryStatus: 'pending',
    deliveryError: '',
    origin: 'human',
    deliveryUpdatedAtUnixMs: 1000,
    clientRequestId: `req-${id}`,
    ...overrides,
  };
}

function harness(handlers = {}) {
  const stream = streamFake();
  const calls = { conversations: [], messages: [], sends: [], cancels: [] };
  const client = {
    async status() { return statusResponse(); },
    async listConversations(req) {
      calls.conversations.push(req);
      if (handlers.conversations) return handlers.conversations(req);
      return { conversations: [], nextBefore: '', hasMore: false, retention: { retainedMessages: 0, oldestRetainedAtUnixMs: 0, maxStoredMessages: 50000 } };
    },
    async listMessages(req) {
      calls.messages.push(req);
      if (handlers.messages) return handlers.messages(req);
      return page([]);
    },
    async sendChat(req) {
      calls.sends.push(req);
      if (handlers.sendChat) return handlers.sendChat(req);
      return {
        messageId: 'out-1', acked: true, ackMessageId: 'out-1', ackId: 'a-1', error: '',
        deliveryStatus: 'acked', outboxStatus: 'acked', replayed: false, requestId: req.requestId,
      };
    },
    async outboxCancel(req) {
      calls.cancels.push(req);
      if (handlers.outboxCancel) return handlers.outboxCancel(req);
      return { cancelled: true, status: 'cancelled' };
    },
  };
  const bridge = new RamingaUiBridge({
    ensure: async () => ({}),
    call: async (fn) => fn(client),
  }, {
    subscribe: stream.subscribe,
    statusTtlMs: 60_000,
    conversationsTtlMs: 60_000,
    messagesTtlMs: 0,
  });
  return { bridge, calls, stream };
}

test('conversation summaries and per-Peer pages expose retention and stable cursors', async () => {
  const h = harness({
    conversations: () => ({
      conversations: [{
        peerId: PEER_A, lastMessageId: 'm2', direction: 'out', preview: 'hello', lastAtUnixMs: 2000,
        deliveryStatus: 'pending', origin: 'human', messageCount: 2,
      }],
      nextBefore: 'next-conversation-cursor',
      hasMore: true,
      retention: { retainedMessages: 2, oldestRetainedAtUnixMs: 1000, maxStoredMessages: 50000 },
    }),
    messages: (req) => page([
      message('m2', PEER_A, { createdAtUnixMs: 2000 }),
      message('m1', PEER_A, { createdAtUnixMs: 1000, deliveryStatus: 'acked', acked: true }),
    ], { nextBefore: 'next-message-cursor', hasMore: true }),
  });
  try {
    await h.bridge.open('ui-messaging-0001');
    const list = await h.bridge.conversations('ui-messaging-0001');
    assert.equal(list.at > 0, true);
    assert.equal(list.conversations[0].peerId, PEER_A);
    assert.equal(list.conversations[0].deliveryStatus, 'pending');
    assert.equal(list.retention.retainedMessages, 2);
    assert.equal(h.calls.conversations[0].limit, 100);

    const first = await h.bridge.messages('ui-messaging-0001', PEER_A);
    assert.equal(first.messages.length, 2);
    assert.equal(first.messages[0].messageId, 'm2');
    assert.equal(first.messages[1].deliveryStatus, 'acked');
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, 'next-message-cursor');

    const older = await h.bridge.messages('ui-messaging-0001', PEER_A, 'next-message-cursor');
    assert.equal(older.freshness, 'live');
    assert.equal(h.calls.messages.at(-1).before, 'next-message-cursor');
    assert.equal(h.calls.messages.at(-1).peerId, PEER_A);

    // An invalid peer never reaches the daemon.
    const invalid = await h.bridge.messages('ui-messaging-0001', 'not a peer');
    assert.match(invalid.error, /Peer ID/);
    assert.equal(h.calls.messages.length, 2);

    // Caches are per Peer: reading B must not return A's page.
    await h.bridge.messages('ui-messaging-0001', PEER_B);
    assert.equal(h.calls.messages.at(-1).peerId, PEER_B);
    assert.equal(h.calls.messages.length, 3);
  } finally {
    h.bridge.dispose();
  }
});

test('a failed refresh keeps the last page and marks it stale', async () => {
  let fail = false;
  const h = harness({
    messages: () => {
      if (fail) throw new Error('node read failed');
      return page([message('m1')], { hasMore: false });
    },
  });
  try {
    await h.bridge.open('ui-messaging-0002');
    const live = await h.bridge.messages('ui-messaging-0002', PEER_A);
    assert.equal(live.messages.length, 1);
    assert.equal(live.freshness, 'live');
    fail = true;
    const stale = await h.bridge.messages('ui-messaging-0002', PEER_A, '', true);
    assert.match(stale.error, /node read failed/);
    assert.equal(stale.messages.length, 1, 'the retained page is not replaced by an empty one');
    assert.equal(stale.freshness, 'stale');
  } finally {
    h.bridge.dispose();
  }
});

test('human send uses the explicit operator origin and an idempotency key', async () => {
  const h = harness();
  try {
    await h.bridge.open('ui-messaging-0003');
    const result = await h.bridge.send('ui-messaging-0003', PEER_A, 'hello', 'req-123');
    assert.equal(result.ok, true);
    assert.equal(result.acked, true);
    assert.equal(result.deliveryStatus, 'acked');
    assert.equal(h.calls.sends.length, 1);
    assert.equal(h.calls.sends[0].origin, 'human');
    assert.equal(h.calls.sends[0].agentOrigin, false);
    assert.equal(h.calls.sends[0].requestId, 'req-123');
    assert.equal(h.calls.sends[0].text, 'hello');
  } finally {
    h.bridge.dispose();
  }
});

test('an RPC-error send is unknown, not silently retried', async () => {
  const h = harness({
    sendChat: () => { throw new Error('deadline exceeded'); },
  });
  try {
    await h.bridge.open('ui-messaging-0004');
    const result = await h.bridge.send('ui-messaging-0004', PEER_A, 'hello', 'req-unknown');
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.match(result.error, /可能已经保存/);
    assert.match(result.detail, /deadline exceeded/);
    assert.equal(h.calls.sends.length, 1, 'the bridge does not retry behind the user');
    assert.equal(h.bridge.getStats().sendUnknowns, 1);

    // A later persisted row can be reconciled by the UI via clientRequestId.
    h.calls.messages.length = 0;
    await h.bridge.messages('ui-messaging-0004', PEER_A, '', true);
    assert.equal(h.calls.messages.length, 1);
  } finally {
    h.bridge.dispose();
  }
});

test('rejects daemon-over-limit text locally and cancels only through OutboxCancel', async () => {
  const h = harness();
  try {
    const opened = await h.bridge.open('ui-messaging-0005');
    assert.equal(opened.status.maxChatTextBytes, 4096);
    const tooLong = await h.bridge.send('ui-messaging-0005', PEER_A, 'x'.repeat(4097), 'req-long');
    assert.equal(tooLong.invalid, true);
    assert.equal(h.calls.sends.length, 0, 'over-limit text is rejected before the daemon');
    const empty = await h.bridge.send('ui-messaging-0005', PEER_A, '   ', 'req-empty');
    assert.equal(empty.invalid, true);
    const badRequest = await h.bridge.send('ui-messaging-0005', PEER_A, 'hi', 'bad request id');
    assert.equal(badRequest.invalid, true);

    const cancelled = await h.bridge.cancelOutbox('ui-messaging-0005', 'out-1');
    assert.equal(cancelled.ok, true);
    assert.deepEqual(h.calls.cancels.map((req) => req.messageId), ['out-1']);
    assert.equal(h.bridge.getStats().cancels, 1);
  } finally {
    h.bridge.dispose();
  }
});

test('closing the last lease rejects late message reads and leaves no session cache', async () => {
  const h = harness();
  const opened = await h.bridge.open('ui-messaging-0006');
  assert.ok(opened.status);
  await h.bridge.close('ui-messaging-0006');
  await assert.rejects(h.bridge.messages('ui-messaging-0006', PEER_A), /lease is not open|closed/);
  await assert.rejects(h.bridge.conversations('ui-messaging-0006'), /lease is not open|closed/);
  const stats = h.bridge.getStats();
  assert.equal(stats.openSessions, 0);
  assert.equal(stats.subscriptions, 0);
  h.bridge.dispose();
});
