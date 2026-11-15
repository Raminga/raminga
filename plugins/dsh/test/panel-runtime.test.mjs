// Focused lifecycle tests for the DSH main-panel runtime. They use a fake RPC,
// app and timer set: no daemon, no browser and no real subscription are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelRuntime } from '../ui/panel-runtime.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(overrides = {}) {
  return {
    sessionId: 'ui-test-0001',
    status: { peerId: 'peer-a', nodeId: 'node-a', version: 'test', apiVersion: '4', connections: [] },
    statusAt: 1000,
    error: null,
    errorAt: null,
    freshness: 'live',
    stream: { phase: 'open', since: 900, lastOpenAt: 900, error: null },
    events: [{ id: 'e1', kind: 'connection', summary: '连接变更', atUnixMs: 1 }],
    stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
    ...overrides,
  };
}

function fakeTimers() {
  let next = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const cleared = { intervals: [], timeouts: [] };
  return {
    setInterval(callback, ms) {
      const id = next++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) {
      cleared.intervals.push(id);
      intervals.delete(id);
    },
    setTimeout(callback, ms) {
      const id = next++;
      timeouts.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.timeouts.push(id);
      timeouts.delete(id);
    },
    fireInterval(id) {
      const entry = intervals.get(id);
      assert.ok(entry, `interval ${id} should exist`);
      return entry.callback();
    },
    fireTimeout(id) {
      const entry = timeouts.get(id);
      assert.ok(entry, `timeout ${id} should exist`);
      timeouts.delete(id);
      return entry.callback();
    },
    get intervalCount() { return intervals.size; },
    get timeoutCount() { return timeouts.size; },
    get cleared() { return cleared; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeApp() {
  return {
    status: [],
    events: [],
    stats: [],
    contacts: [],
    contactsErrors: [],
    destroyCalls: 0,
    setNodeStatus(value) { this.status.push(value); },
    pushNodeEvent(value) { this.events.push(value); },
    setStats(value) { this.stats.push(value); },
    setContacts(value) { this.contacts.push(value); },
    setContactsError(value) { this.contactsErrors.push(value); },
    conversations: [],
    conversationErrors: [],
    messagePages: [],
    messageContexts: [],
    messageErrors: [],
    activePeer: '',
    setConversations(value) { this.conversations.push(value); },
    setConversationsError(value) { this.conversationErrors.push(value); },
    setMessagePage(value, context) {
      this.messagePages.push(value);
      this.messageContexts.push(context ?? null);
    },
    appendMessagePage(value, context) {
      this.messagePages.push(value);
      this.messageContexts.push(context ?? null);
    },
    setMessagesError(peerId, value) { this.messageErrors.push({ peerId, error: value }); },
    activeConversationPeer() { return this.activePeer; },
    destroy() { this.destroyCalls += 1; },
  };
}

function harness({ open, close, poll, refresh, contacts, connect, checkContact, share, conversations, messages, send, cancelOutbox } = {}) {
  const app = fakeApp();
  const timers = fakeTimers();
  const mountCalls = [];
  const openCalls = [];
  const closeCalls = [];
  const pollCalls = [];
  const refreshCalls = [];
  const contactsCalls = [];
  const conversationCalls = [];
  const messageCalls = [];
  const sendCalls = [];
  const cancelCalls = [];
  const rpc = {
    async open(sessionId) {
      openCalls.push(sessionId);
      return open ? open(sessionId) : { ok: true, value: snapshot() };
    },
    async close(sessionId) {
      closeCalls.push(sessionId);
      return close ? close(sessionId) : { ok: true, value: { openSessions: 0, subscriptions: 0, streamActive: false } };
    },
    async poll(sessionId) {
      pollCalls.push(sessionId);
      return poll ? poll(sessionId) : { ok: true, value: snapshot() };
    },
    async refresh(sessionId) {
      refreshCalls.push(sessionId);
      return refresh ? refresh(sessionId) : { ok: true, value: snapshot() };
    },
  };
  if (contacts) {
    rpc.contacts = async (sessionId, force) => {
      contactsCalls.push({ sessionId, force });
      return contacts(sessionId, force);
    };
  }
  if (conversations) {
    rpc.conversations = async (sessionId, force) => {
      conversationCalls.push({ sessionId, force });
      return conversations(sessionId, force);
    };
  }
  if (messages) {
    rpc.messages = async (sessionId, peerId, before, force) => {
      messageCalls.push({ sessionId, peerId, before, force });
      return messages(sessionId, peerId, before, force);
    };
  }
  if (send) {
    rpc.send = async (sessionId, peerId, text, requestId) => {
      sendCalls.push({ sessionId, peerId, text, requestId });
      return send(sessionId, peerId, text, requestId);
    };
  }
  if (cancelOutbox) {
    rpc.cancelOutbox = async (sessionId, messageId) => {
      cancelCalls.push({ sessionId, messageId });
      return cancelOutbox(sessionId, messageId);
    };
  }
  if (connect) rpc.connect = connect;
  if (checkContact) rpc.checkContact = checkContact;
  if (share) rpc.share = share;
  const viewState = { page: 'contacts', marker: 'view-state' };
  const errors = [];
  const logs = [];
  const runtime = createPanelRuntime({
    rpc,
    viewState,
    resolvePhase: (value) => (value.error ? 'error' : value.stats?.streamActive === false ? 'closed' : value.status ? 'ready' : 'loading'),
    sessionId: 'ui-test-0001',
    onBootError: (error) => errors.push(error),
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    timers,
    mount(_host, options) {
      mountCalls.push(options);
      return app;
    },
  });
  return {
    runtime, app, timers, rpc, viewState, mountCalls, openCalls, closeCalls, pollCalls, refreshCalls,
    contactsCalls, conversationCalls, messageCalls, sendCalls, cancelCalls, errors, logs,
  };
}

test('start opens one lease, polls, and dispose destroys the app, clears timers and closes once', async () => {
  const h = harness();
  assert.equal(h.runtime.start({}), true);
  await flush();

  assert.deepEqual(h.openCalls, ['ui-test-0001']);
  assert.equal(h.mountCalls.length, 1);
  assert.equal(h.mountCalls[0].viewState, h.viewState, 'the adapter-owned view state is passed through');
  assert.deepEqual(h.app.status[0], {
    phase: 'ready',
    status: snapshot().status,
    statusAt: snapshot().statusAt,
    error: null,
    errorAt: null,
    freshness: 'live',
    stream: snapshot().stream,
    stats: snapshot().stats,
  });
  assert.deepEqual(h.app.events, snapshot().events);
  assert.deepEqual(h.app.stats, [snapshot().stats]);
  assert.equal(h.timers.intervalCount, 1);
  assert.equal(h.timers.timeoutCount, 0);
  const pollId = h.runtime.timers.pollTimer;
  assert.ok(pollId);

  await h.timers.fireInterval(pollId);
  await flush();
  assert.equal(h.pollCalls.length, 1);

  h.runtime.dispose();
  assert.equal(h.app.destroyCalls, 1);
  assert.deepEqual(h.closeCalls, ['ui-test-0001']);
  assert.equal(h.timers.intervalCount, 0);
  assert.deepEqual(h.timers.cleared.intervals, [pollId]);
  assert.equal(h.runtime.active, false);

  h.runtime.dispose();
  assert.equal(h.app.destroyCalls, 1, 'second dispose must not destroy twice');
  assert.equal(h.closeCalls.length, 1, 'second dispose must not close twice');
  await flush();
  assert.equal(h.logs.filter(([level]) => level === 'info').length, 1);
});

test('a late open after dispose closes after the open settles, then again', async () => {
  let resolveOpen;
  const h = harness({
    open: () => new Promise((resolve) => { resolveOpen = resolve; }),
  });
  h.runtime.start({});
  h.runtime.dispose();
  assert.equal(h.app.destroyCalls, 1);
  assert.deepEqual(h.closeCalls, ['ui-test-0001'], 'close must be sent even though open has not resolved');
  assert.equal(h.runtime.timers.openAttempted, true);

  resolveOpen({ ok: true, value: snapshot() });
  await flush();
  assert.deepEqual(h.closeCalls, ['ui-test-0001', 'ui-test-0001'], 'late success must be followed by one more close');
  assert.equal(h.timers.intervalCount, 0);
  assert.equal(h.runtime.timers.leaseOpen, true);
  assert.equal(h.runtime.timers.leaseClosed, true);
  assert.deepEqual(h.app.status, [], 'a disposed panel must not render a late snapshot');
});

test('a pending open that fails after dispose still closes the session id again', async () => {
  let rejectOpen;
  const h = harness({
    open: () => new Promise((_resolve, reject) => { rejectOpen = reject; }),
  });
  h.runtime.start({});
  h.runtime.dispose();
  assert.deepEqual(h.closeCalls, ['ui-test-0001']);

  rejectOpen(new Error('open response lost'));
  await flush();
  assert.deepEqual(h.closeCalls, ['ui-test-0001', 'ui-test-0001']);
  assert.equal(h.runtime.timers.leaseOpen, false);
  assert.equal(h.timers.timeoutCount, 0, 'dispose must not leave a retry behind');
  assert.deepEqual(h.app.status, [], 'a disposed panel must not render a late error');
});

test('open failure shows a real error, schedules one retry, and dispose closes the attempted session', async () => {
  const h = harness({
    open: async () => ({ ok: false, error: { message: 'daemon down' } }),
  });
  h.runtime.start({});
  await flush();
  assert.equal(h.app.status.length, 1);
  assert.equal(h.app.status[0].phase, 'error');
  assert.equal(h.app.status[0].error, 'daemon down');
  assert.equal(h.app.status[0].freshness, 'stale');
  assert.ok(h.app.status[0].errorAt > 0);
  assert.equal(h.timers.timeoutCount, 1);
  assert.equal(h.timers.intervalCount, 0);
  const retryId = h.runtime.timers.retryTimer;

  h.runtime.dispose();
  assert.deepEqual(h.timers.cleared.timeouts, [retryId]);
  assert.equal(h.timers.timeoutCount, 0);
  assert.deepEqual(h.closeCalls, ['ui-test-0001'], 'a failed open may still have created a host session');
});

test('refresh and poll failures report errors without dropping the lease; recovery updates the app', async () => {
  let refreshShouldFail = true;
  const h = harness({
    refresh: async () => (refreshShouldFail
      ? { ok: false, error: { message: 'refresh failed' } }
      : { ok: true, value: snapshot({ error: null, stats: { openSessions: 1, subscriptions: 1, streamActive: true } }) }),
    poll: async () => ({ ok: false, error: { message: 'poll failed' } }),
  });
  h.runtime.start({});
  await flush();

  await h.runtime.refresh();
  assert.deepEqual(h.refreshCalls, ['ui-test-0001']);
  assert.equal(h.app.status.at(-1).phase, 'error');
  assert.equal(h.app.status.at(-1).error, 'refresh failed');
  assert.equal(h.runtime.timers.leaseOpen, true);

  await h.runtime.poll(false);
  assert.equal(h.app.status.at(-1).error, 'poll failed');
  assert.equal(h.app.status.at(-1).freshness, 'stale');
  assert.ok(h.app.status.at(-1).errorAt > 0);
  assert.equal(h.app.status.at(-1).status, undefined, 'runtime errors do not erase the last Status');
  assert.equal(h.app.status.at(-1).statusAt, undefined, 'runtime errors do not invent a new read time');

  refreshShouldFail = false;
  await h.runtime.refresh();
  assert.equal(h.app.status.at(-1).phase, 'ready');

  h.runtime.dispose();
  assert.deepEqual(h.closeCalls, ['ui-test-0001']);
});

test('mount failure calls onBootError, never opens a lease and disposes idempotently', () => {
  const h = harness();
  const errors = [];
  const runtime = createPanelRuntime({
    rpc: h.rpc,
    viewState: h.viewState,
    resolvePhase: () => 'ready',
    sessionId: 'ui-test-0001',
    onBootError: (error) => errors.push(error),
    logger: { info() {}, warn() {} },
    timers: h.timers,
    mount() { throw new Error('no host'); },
  });
  assert.equal(runtime.start({}), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no host/);
  assert.equal(h.runtime.active, true, 'unrelated runtime remains active');
  runtime.dispose();
  runtime.dispose();
  assert.deepEqual(h.openCalls, []);
  assert.deepEqual(h.closeCalls, []);
});

test('a throwing UI destroy cannot keep the lease open', async () => {
  const h = harness();
  h.runtime.start({});
  await flush();
  h.app.destroy = () => { throw new Error('destroy failed'); };
  assert.doesNotThrow(() => h.runtime.dispose());
  assert.deepEqual(h.closeCalls, ['ui-test-0001']);
  assert.equal(h.timers.intervalCount, 0);
  assert.ok(h.logs.some(([level, message]) => level === 'warn' && /destroy failed/.test(message)));
});

test('the adapter loads daemon contacts after open, on its timer and after Connect', async () => {
  const contactValue = {
    friends: [{ peerId: 'peer-a', name: 'Alice', connection: 'connected' }],
    freshness: 'live',
    at: 1000,
  };
  let contactReads = 0;
  const connectValue = {
    ok: true,
    peerId: 'peer-b',
    contact: { ok: true, found: true },
    contacts: { friends: [{ peerId: 'peer-b', connection: 'connected' }], freshness: 'live', at: 2000 },
  };
  const h = harness({
    contacts: async () => {
      contactReads += 1;
      return { ok: true, value: contactValue };
    },
    connect: async () => ({ ok: true, value: connectValue }),
    share: async () => ({ ok: true, value: { ok: true, peerId: 'peer-a', addresses: [] } }),
    checkContact: async () => ({ ok: true, value: { ok: true, found: true, contacts: contactValue } }),
  });
  h.runtime.start({});
  await flush();

  assert.deepEqual(h.contactsCalls, [{ sessionId: 'ui-test-0001', force: false }]);
  assert.equal(h.app.contacts.length, 1);
  assert.equal(h.timers.intervalCount, 2, 'one status poll and one contacts refresh timer');
  const contactsTimer = h.runtime.timers.contactsTimer;
  assert.ok(contactsTimer);
  await h.timers.fireInterval(contactsTimer);
  await flush();
  assert.equal(contactReads, 2);

  const options = h.mountCalls[0];
  assert.equal(typeof options.onLoadContacts, 'function');
  assert.equal(typeof options.onConnect, 'function');
  assert.equal(typeof options.onCheckContact, 'function');
  assert.equal(typeof options.onShare, 'function');
  assert.equal(typeof options.onCopyText, 'function');
  const connected = await options.onConnect('/ip4/192.0.2.1/tcp/4001/p2p/peer-b');
  assert.equal(connected.ok, true);
  assert.equal(h.app.contacts.at(-1).friends[0].peerId, 'peer-b');
  const shared = await options.onShare();
  assert.equal(shared.peerId, 'peer-a');

  h.runtime.dispose();
  assert.equal(h.timers.intervalCount, 0, 'both status and contacts timers are cleared');
});


test('conversation polling, messages, send and events share one lease and stop on dispose', async () => {
  const conversationValue = { conversations: [{ peerId: 'peer-a', lastAt: 1000 }], at: 1000, freshness: 'live', error: null, retention: null };
  const messageValue = { peerId: 'peer-a', messages: [{ messageId: 'm1', peerId: 'peer-a', direction: 'out' }], at: 1000, freshness: 'live', error: null, hasMore: false, nextBefore: '', retention: null };
  let events = [];
  const h = harness({
    conversations: async () => ({ ok: true, value: conversationValue }),
    messages: async () => ({ ok: true, value: messageValue }),
    send: async () => ({ ok: true, value: { ok: true, unknown: false, deliveryStatus: 'acked', messageId: 'm2' } }),
    cancelOutbox: async () => ({ ok: true, value: { ok: true, messageId: 'm1', status: 'cancelled' } }),
  });
  // The shared UI has already restored a conversation Peer before mount.
  h.app.activePeer = 'peer-a';
  h.runtime.start({});
  await flush();

  assert.equal(h.conversationCalls.length, 1);
  assert.equal(h.conversationCalls[0].force, false);
  assert.equal(h.messageCalls.length, 1, 'restored conversation reads a persisted page after open');
  assert.deepEqual(h.app.conversations.at(-1), conversationValue);
  assert.deepEqual(h.app.messagePages.at(-1), messageValue);
  assert.equal(h.timers.intervalCount, 3, 'status, conversations and messages timers plus no contacts');
  const conversationsTimer = h.runtime.timers.conversationsTimer;
  const messagesTimer = h.runtime.timers.messagesTimer;
  const pollId = h.runtime.timers.pollTimer;

  await h.timers.fireInterval(conversationsTimer);
  await h.timers.fireInterval(messagesTimer);
  await flush();
  assert.equal(h.conversationCalls.length, 2);
  assert.equal(h.messageCalls.length, 2);

  const options = h.mountCalls[0];
  assert.equal(typeof options.onLoadConversations, 'function');
  assert.equal(typeof options.onLoadMessages, 'function');
  assert.equal(typeof options.onLoadOlder, 'function');
  assert.equal(typeof options.onSend, 'function');
  assert.equal(typeof options.onCancelOutbox, 'function');
  const sent = await options.onSend('peer-a', 'hello', 'req-1');
  assert.equal(sent.deliveryStatus, 'acked');
  assert.deepEqual(h.sendCalls[0], { sessionId: 'ui-test-0001', peerId: 'peer-a', text: 'hello', requestId: 'req-1' });
  assert.equal(h.messageCalls.length, 3, 'send re-reads the persisted page');
  assert.equal(h.conversationCalls.length, 3, 'send re-reads the conversation summary');
  const cancelled = await options.onCancelOutbox('peer-a', 'm1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(h.cancelCalls[0], { sessionId: 'ui-test-0001', messageId: 'm1' });
  assert.equal(h.messageCalls.length, 4, 'cancel re-reads the persisted page');

  // A chat event only schedules one bounded refresh; events are never the
  // durable fact source.
  const eventSnapshot = snapshot({
    events: [{ id: 'e-chat', kind: 'chat', peerId: 'peer-a', messageId: 'm3', text: 'inbound', atUnixMs: 2 }],
  });
  await h.runtime.poll(false).catch(() => {});
  // poll returns the default snapshot without our event; drive apply directly
  // through the public runtime by using a poll result instead.
  // (The fake poll above is replaced for this event.)
  h.rpc.poll = async () => ({ ok: true, value: eventSnapshot });
  await h.runtime.poll(false);
  assert.ok(h.timers.timeoutCount >= 1, 'chat event debounces a refresh');
  const eventTimer = h.runtime.timers.eventRefreshTimer;
  await h.timers.fireTimeout(eventTimer);
  await flush();
  assert.ok(h.messageCalls.length >= 5);

  h.runtime.dispose();
  assert.equal(h.timers.intervalCount, 0, 'all status, conversations and messages timers are cleared');
  assert.equal(h.timers.timeoutCount, 0, 'event refresh timers are cleared');
  assert.equal(h.app.destroyCalls, 1);
  assert.deepEqual(h.closeCalls, ['ui-test-0001']);
  void pollId;
});

test('a message page resolving after dispose is not rendered', async () => {
  let resolveMessages;
  const h = harness({
    conversations: async () => ({ ok: true, value: { conversations: [], at: 1000, freshness: 'live', error: null } }),
    messages: () => new Promise((resolve) => { resolveMessages = resolve; }),
  });
  h.app.activePeer = 'peer-a';
  h.runtime.start({});
  await flush();
  assert.equal(h.messageCalls.length, 1);
  h.runtime.dispose();
  resolveMessages({ ok: true, value: { peerId: 'peer-a', messages: [{ messageId: 'late', peerId: 'peer-a', direction: 'in' }], at: 2000, freshness: 'live', error: null } });
  await flush();
  assert.equal(h.app.messagePages.length, 0, 'late page is dropped after lease cleanup');
  assert.equal(h.app.destroyCalls, 1);
});


test('latest refresh and user older pages use independent per-Peer queues', async () => {
  const latest = deferred();
  const firstOlder = deferred();
  const secondOlder = deferred();
  const calls = [];
  let latestCalls = 0;
  const h = harness({
    conversations: async () => ({ ok: true, value: { conversations: [], at: 1000, freshness: 'live', error: null } }),
    messages: (_session, _peer, before) => {
      calls.push(before);
      if (before === 'cursor-1') return firstOlder.promise;
      if (before === 'cursor-2') return secondOlder.promise;
      latestCalls += 1;
      return latestCalls === 1 ? latest.promise : Promise.resolve({
        ok: true,
        value: {
          peerId: 'peer-a', messages: [{ messageId: 'newest', peerId: 'peer-a', direction: 'in' }],
          at: 2000, freshness: 'live', error: null, hasMore: true, nextBefore: 'latest-cursor', retention: null,
        },
      });
    },
  });
  h.app.activePeer = 'peer-a';
  h.runtime.start({});
  await flush();
  const options = h.mountCalls[0];

  const first = options.onLoadOlder('peer-a', 'cursor-1', { token: 7 });
  const second = options.onLoadOlder('peer-a', 'cursor-2', { token: 7 });
  await flush();
  assert.deepEqual(calls, ['', 'cursor-1'], 'an older request starts even while the latest page is in flight');
  assert.equal(typeof first.then, 'function');
  assert.equal(typeof second.then, 'function');

  latest.resolve({
    ok: true,
    value: {
      peerId: 'peer-a', messages: [{ messageId: 'latest', peerId: 'peer-a', direction: 'in' }],
      at: 1000, freshness: 'live', error: null, hasMore: true, nextBefore: 'latest-cursor', retention: null,
    },
  });
  await flush();
  firstOlder.resolve({
    ok: true,
    value: {
      peerId: 'peer-a', messages: [{ messageId: 'older-1', peerId: 'peer-a', direction: 'in' }],
      at: 1001, freshness: 'live', error: null, hasMore: true, nextBefore: 'cursor-2', retention: null,
    },
  });
  await flush();
  assert.deepEqual(calls, ['', 'cursor-1', 'cursor-2'], 'the second older page is not overwritten by a background latest read');

  const refresh = options.onLoadMessages('peer-a', false, { token: 7 });
  await flush();
  assert.deepEqual(calls, ['', 'cursor-1', 'cursor-2', '']);
  await refresh;
  secondOlder.resolve({
    ok: true,
    value: {
      peerId: 'peer-a', messages: [{ messageId: 'older-2', peerId: 'peer-a', direction: 'in' }],
      at: 1002, freshness: 'live', error: null, hasMore: false, nextBefore: '', retention: null,
    },
  });
  await flush();
  await first;
  await second;

  const appended = h.app.messagePages
    .filter((value) => value.messages[0]?.messageId.startsWith('older-'))
    .map((value) => value.messages[0].messageId);
  assert.deepEqual(appended, ['older-1', 'older-2'], 'both user older pages are applied in order');
  const olderContexts = h.app.messagePages
    .map((value, index) => ({ value, context: h.app.messageContexts[index] }))
    .filter(({ value }) => value.messages[0]?.messageId.startsWith('older-'))
    .map(({ context }) => context);
  assert.deepEqual(olderContexts, [{ token: 7 }, { token: 7 }],
    'the generation token reaches the host-applied append');
  assert.equal(h.app.messageErrors.length, 0);
  h.runtime.dispose();
});

test('an older-page RPC failure rejects to the UI instead of silently succeeding', async () => {
  const h = harness({
    conversations: async () => ({ ok: true, value: { conversations: [], at: 1000, freshness: 'live', error: null } }),
    messages: (_session, _peer, before) => {
      if (before === 'older-cursor') return Promise.reject(new Error('older read failed'));
      return Promise.resolve({
        ok: true,
        value: {
          peerId: 'peer-a', messages: [{ messageId: 'latest', peerId: 'peer-a', direction: 'in' }],
          at: 1000, freshness: 'live', error: null, hasMore: true, nextBefore: 'older-cursor', retention: null,
        },
      });
    },
  });
  h.app.activePeer = 'peer-a';
  h.runtime.start({});
  await flush();
  const options = h.mountCalls[0];
  await assert.rejects(
    options.onLoadOlder('peer-a', 'older-cursor', { token: 3 }),
    /older read failed/,
  );
  assert.equal(h.app.messageErrors.length, 0, 'the runtime leaves older-page wording to the UI');
  h.runtime.dispose();
});

test('dispose settles queued older requests and drops their pages', async () => {
  const running = deferred();
  const calls = [];
  const h = harness({
    conversations: async () => ({ ok: true, value: { conversations: [], at: 1000, freshness: 'live', error: null } }),
    messages: (_session, _peer, before) => {
      calls.push(before);
      if (before === 'running') return running.promise;
      return Promise.resolve({
        ok: true,
        value: {
          peerId: 'peer-a', messages: [{ messageId: 'latest', peerId: 'peer-a', direction: 'in' }],
          at: 1000, freshness: 'live', error: null, hasMore: true, nextBefore: 'running', retention: null,
        },
      });
    },
  });
  h.app.activePeer = 'peer-a';
  h.runtime.start({});
  await flush();
  const options = h.mountCalls[0];
  const first = options.onLoadOlder('peer-a', 'running', { token: 4 });
  const queued = options.onLoadOlder('peer-a', 'queued', { token: 4 });
  await flush();
  assert.deepEqual(calls, ['', 'running']);
  h.runtime.dispose();
  assert.equal(await queued, null, 'the queued request settles instead of hanging forever');
  running.resolve({
    ok: true,
    value: {
      peerId: 'peer-a', messages: [{ messageId: 'late', peerId: 'peer-a', direction: 'in' }],
      at: 1000, freshness: 'live', error: null, hasMore: false, nextBefore: '', retention: null,
    },
  });
  assert.equal(await first, null, 'an in-flight result after dispose is not applied');
  assert.deepEqual(h.app.messagePages.map((value) => value.messages[0].messageId), ['latest'],
    'the pre-dispose latest page is the only page applied');
});
