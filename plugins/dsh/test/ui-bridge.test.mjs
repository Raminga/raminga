// Deterministic host-bridge lifecycle tests.
//
// These use a fake RamingaApi so initialization failure, close-before-open and
// close-during-open orderings are exercised without a daemon or an idle wait.
// The real-daemon smoke path stays in bridge.integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi({ ensure = async () => ({}) } = {}) {
  return {
    ensure,
    async call() {
      throw new Error('fake api call should not be reached in these cases');
    },
  };
}

test('an initialization failure releases its open session immediately', async () => {
  const gate = deferred();
  const bridge = new RamingaUiBridge(fakeApi({ ensure: () => gate.promise }));

  const opening = bridge.open('ui-bridge-initfail-0001');
  assert.equal(bridge.getStats().openSessions, 1, 'the session is visible before ensure resolves');

  gate.reject(new Error('daemon initialization failed'));
  await assert.rejects(opening, /daemon initialization failed/);

  const stats = bridge.getStats();
  assert.equal(stats.openSessions, 0, 'no idle timeout is required to release the failed open');
  assert.equal(stats.subscriptions, 0);
  assert.equal(stats.streamActive, false);
  assert.equal(stats.sessionsOpened, 1);
  assert.equal(stats.sessionsClosed, 1);
  bridge.dispose();
});

test('close during a pending open rejects the late result and leaves no lease', async () => {
  const gate = deferred();
  const bridge = new RamingaUiBridge(fakeApi({ ensure: () => gate.promise }));

  const opening = bridge.open('ui-bridge-pending-0001');
  assert.equal(bridge.getStats().openSessions, 1);

  const closed = await bridge.close('ui-bridge-pending-0001');
  assert.equal(closed.openSessions, 0);
  assert.equal(closed.subscriptions, 0);

  gate.resolve({});
  await assert.rejects(opening, /lease was closed/);

  const stats = bridge.getStats();
  assert.equal(stats.openSessions, 0);
  assert.equal(stats.subscriptions, 0);
  assert.equal(stats.sessionsClosed, 1, 'the closed session is counted once');
  bridge.dispose();
});

test('a close that arrives before a delayed open blocks lease resurrection', async () => {
  const bridge = new RamingaUiBridge(fakeApi());

  const closed = await bridge.close('ui-bridge-reordered-0001');
  assert.equal(closed.openSessions, 0);
  assert.equal(closed.subscriptions, 0);

  await assert.rejects(bridge.open('ui-bridge-reordered-0001'), /lease was closed/);
  const stats = bridge.getStats();
  assert.equal(stats.openSessions, 0, 'a late open must not recreate a closed session');
  assert.equal(stats.subscriptions, 0);
  assert.equal(stats.sessionsOpened, 0);
  bridge.dispose();
});

test('close remains idempotent for unknown and malformed session ids', async () => {
  const bridge = new RamingaUiBridge(fakeApi());
  for (const id of ['ui-unknown-0001', '', undefined, 42]) {
    const stats = await bridge.close(id);
    assert.equal(stats.openSessions, 0);
    assert.equal(stats.subscriptions, 0);
  }
  bridge.dispose();
});

const PEER_A = '12D3KooWabcdefghijklmnopqrstuvwxyz';
const PEER_B = '12D3KooWzyxwvutsrqponmlkjihgfedcba';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

function connection(peerId, route = 'direct') {
  return {
    peerId,
    direction: 'inbound',
    transport: 'tcp',
    route,
    direct: route === 'direct',
    limited: route !== 'direct',
    remoteMultiaddr: `/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`,
  };
}

function statusResponse({ connections = [], startedAtUnixMs = 1000 } = {}) {
  return {
    peerId: PEER_A,
    nodeId: 'node-a',
    version: 'test',
    protocolVersion: '1',
    apiVersion: '4',
    startedAtUnixMs,
    currentTime: 'now',
    listenAddrs: [],
    connections,
    peers: [],
  };
}

/** Controllable Events subscriber fake: no timers, streams or daemon. */
function fakeStream() {
  let handlers = null;
  let starts = 0;
  let stops = 0;
  const phases = [];
  return {
    subscribe(_api, onEvent, onError, onState) {
      starts += 1;
      handlers = { onEvent, onError, onState };
      onState('connecting');
      queueMicrotask(() => {
        if (handlers === null) return;
        phases.push('open');
        handlers.onState('open');
      });
      return () => {
        stops += 1;
        const current = handlers;
        handlers = null;
        phases.push('closed');
        current?.onState('closed');
      };
    },
    emit(raw) {
      handlers.onEvent(raw);
    },
    fail(error) {
      handlers.onError(error);
      phases.push('reconnecting');
      handlers.onState('reconnecting');
    },
    reopen() {
      phases.push('connecting', 'open');
      handlers.onState('connecting');
      handlers.onState('open');
    },
    get starts() { return starts; },
    get stops() { return stops; },
    phases,
  };
}

test('a connection event re-reads Status and never flips a Peer by itself', async () => {
  const stream = fakeStream();
  let reads = 0;
  let connections = [connection(PEER_A)];
  const bridge = new RamingaUiBridge({
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      return statusResponse({ connections });
    },
  }, { subscribe: stream.subscribe, reconcileDelayMs: 5, statusTtlMs: 60_000 });
  try {
    const opened = await bridge.open('ui-events-0001');
    assert.equal(opened.freshness, 'live');
    assert.equal(opened.status.connections.length, 1);
    assert.equal(reads, 1);

    connections = [];
    stream.emit({
      atUnixMs: 12345,
      connection: { peerId: PEER_A, kind: 'disconnected', direction: 'inbound', transport: 'tcp', route: 'direct' },
    });

    const before = await bridge.poll('ui-events-0001', false);
    assert.equal(reads, 1, 'the event itself must not trigger a synchronous read');
    assert.equal(before.status.connections.length, 1, 'one disconnect event must not edit the last Status');
    assert.equal(before.events.length, 1);
    assert.equal(before.events[0].kind, 'connection');
    assert.match(before.events[0].summary, /连接变更/);
    assert.doesNotMatch(before.events[0].summary, /离线/);

    await waitFor(() => bridge.getStats().statusReads === 2, 'Status re-read after connection event');
    const after = await bridge.poll('ui-events-0001', false);
    assert.equal(after.status.connections.length, 0);
    assert.equal(after.freshness, 'live');
    assert.equal(after.stats.reconcileRuns, 2);
  } finally {
    bridge.dispose();
  }
});

test('an event that lands during a Status read causes one trailing read', async () => {
  const stream = fakeStream();
  let reads = 0;
  const gates = [];
  const api = {
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      if (reads === 1) return statusResponse({ connections: [connection(PEER_A)] });
      return new Promise((resolve) => gates.push(resolve));
    },
  };
  const bridge = new RamingaUiBridge(api, {
    subscribe: stream.subscribe,
    reconcileDelayMs: 0,
    statusTtlMs: 60_000,
  });
  try {
    await bridge.open('ui-race-read-0001');
    stream.emit({ atUnixMs: 1, connection: { peerId: PEER_A, kind: 'connected' } });
    await waitFor(() => reads === 2, 'first event read');

    stream.emit({
      atUnixMs: 2,
      connection: { peerId: PEER_A, kind: 'disconnected' },
    });
    await delay(10); // let the debounce timer join the in-flight read
    gates.shift()(statusResponse({ connections: [connection(PEER_A)] }));
    await waitFor(() => reads === 3, 'trailing event read');

    gates.shift()(statusResponse({ connections: [] }));
    await waitFor(() => bridge.getStats().statusReads === 3, 'trailing read applied');
    const snapshot = await bridge.poll('ui-race-read-0001', false);
    assert.equal(snapshot.status.connections.length, 0);
    assert.equal(bridge.getStats().reconcileCoalesced, 1);
    assert.equal(bridge.getStats().reconcileRuns, 2);
  } finally {
    bridge.dispose();
  }
});

test('concurrent refreshes share one daemon Status read', async () => {
  const stream = fakeStream();
  let reads = 0;
  let release = null;
  const api = {
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      if (reads === 1) return statusResponse();
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const bridge = new RamingaUiBridge(api, {
    subscribe: stream.subscribe,
    statusTtlMs: 60_000,
  });
  try {
    await bridge.open('ui-coalesce-0001');
    const results = [
      bridge.poll('ui-coalesce-0001', true),
      bridge.poll('ui-coalesce-0001', true),
      bridge.poll('ui-coalesce-0001', true),
    ];
    await waitFor(() => reads === 2 && bridge.getStats().reconcileCoalesced === 2, 'joined refreshes');
    release(statusResponse({ startedAtUnixMs: 2000 }));
    const snapshots = await Promise.all(results);

    assert.equal(reads, 2, 'three concurrent refreshes must produce one upstream read');
    assert.equal(bridge.getStats().statusReads, 2);
    for (const snapshot of snapshots) assert.equal(snapshot.status.startedAtUnixMs, '2000');
  } finally {
    bridge.dispose();
  }
});

test('a dropped stream keeps the last Status with its time, read failure adds an error, reopen restores live state', async () => {
  const stream = fakeStream();
  let phase = 'initial';
  let reads = 0;
  const api = {
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      if (phase === 'fail') throw new Error('node unreachable');
      if (phase === 'recovered') return statusResponse({ startedAtUnixMs: 2000, connections: [] });
      return statusResponse({ connections: [connection(PEER_A)] });
    },
  };
  const bridge = new RamingaUiBridge(api, {
    subscribe: stream.subscribe,
    statusTtlMs: 60_000,
  });
  try {
    const opened = await bridge.open('ui-recovery-0001');
    const firstStatusAt = opened.statusAt;
    assert.equal(opened.freshness, 'live');

    stream.fail(new Error('stream dropped'));
    const stale = await bridge.poll('ui-recovery-0001', false);
    assert.equal(stale.freshness, 'stale');
    assert.equal(stale.error, null, 'a stream break is not a Status read failure');
    assert.equal(stale.status.connections.length, 1, 'the last snapshot is retained, not replaced with zero');
    assert.equal(stale.statusAt, firstStatusAt, 'the retained snapshot keeps its read time');
    assert.equal(stale.stream.phase, 'reconnecting');
    assert.equal(stale.stream.error, 'stream dropped');
    assert.equal(stale.stats.streamActive, false);
    assert.equal(stale.stats.subscriptions, 0);

    phase = 'fail';
    const failed = await bridge.poll('ui-recovery-0001', true);
    assert.equal(failed.error, 'node unreachable');
    assert.ok(failed.errorAt > 0);
    assert.equal(failed.freshness, 'stale');
    assert.equal(failed.status.connections.length, 1, 'read failure must not fabricate an empty live snapshot');
    assert.equal(failed.statusAt, firstStatusAt);

    phase = 'recovered';
    const readsBefore = reads;
    // Keep the post-recovery read on a later wall-clock millisecond so this
    // test proves the read time advanced rather than only that it changed.
    await delay(5);
    stream.reopen();
    const duringRecovery = await bridge.poll('ui-recovery-0001', false);
    assert.equal(duringRecovery.stream.phase, 'open');
    assert.equal(
      duringRecovery.freshness,
      'stale',
      'the pre-reconnect Status must not be presented as live before the post-open read',
    );
    await waitFor(() => bridge.getStats().streamPhase === 'open' && reads > readsBefore, 'recovery read');
    await waitFor(() => bridge.getStats().lastError === null, 'recovered error state');
    const live = await bridge.poll('ui-recovery-0001', false);
    assert.equal(live.freshness, 'live');
    assert.equal(live.error, null);
    assert.equal(live.stream.phase, 'open');
    assert.equal(live.stream.error, null);
    assert.equal(live.status.startedAtUnixMs, '2000');
    assert.ok(live.statusAt > firstStatusAt);
    assert.equal(live.stats.subscriptions, 1);
  } finally {
    bridge.dispose();
  }
});

test('close cancels a queued connection reconcile and discards an in-flight read', async () => {
  const stream = fakeStream();
  let reads = 0;
  let release = null;
  const api = {
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      if (reads <= 2) return statusResponse();
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const bridge = new RamingaUiBridge(api, {
    subscribe: stream.subscribe,
    reconcileDelayMs: 20,
    statusTtlMs: 60_000,
  });
  try {
    await bridge.open('ui-cleanup-0001');
    stream.emit({ atUnixMs: 1, connection: { peerId: PEER_A, kind: 'disconnected' } });
    await bridge.close('ui-cleanup-0001');
    await delay(50);
    assert.equal(reads, 1, 'closing the last lease must clear the debounce timer');
    assert.equal(bridge.getStats().openSessions, 0);
    assert.equal(bridge.getStats().streamStops, 1);

    // A read already in flight is discarded after the lease closes.
    await bridge.open('ui-cleanup-0002');
    const pending = bridge.poll('ui-cleanup-0002', true);
    await waitFor(() => reads === 3 && release !== null, 'in-flight read');
    await bridge.close('ui-cleanup-0002');
    release(statusResponse({ startedAtUnixMs: 2000 }));
    await assert.rejects(pending, /panel lease was closed/);
    await flush();
    assert.equal(bridge.getStats().statusReads, 2, 'the old-generation result must not be applied');
    assert.equal(bridge.getStats().openSessions, 0);
  } finally {
    bridge.dispose();
  }
});

test('parallel panels share one stream and concurrent status reads; leases close independently', async () => {
  const stream = fakeStream();
  let reads = 0;
  const api = {
    ensure: async () => ({}),
    call: async () => {
      reads += 1;
      return statusResponse();
    },
  };
  const bridge = new RamingaUiBridge(api, { subscribe: stream.subscribe });
  try {
    const [first, second] = await Promise.all([
      bridge.open('ui-parallel-0001'),
      bridge.open('ui-parallel-0002'),
    ]);
    assert.equal(first.stats.streamStarts, 1);
    assert.equal(second.stats.streamStarts, 1);
    assert.equal(second.stats.openSessions, 2);
    assert.equal(second.stats.subscriptions, 1);
    assert.equal(stream.starts, 1);
    assert.equal(reads, 1, 'parallel opens join the same initial read');

    const duplicate = await bridge.open('ui-parallel-0001');
    assert.equal(duplicate.stats.openSessions, 2);
    assert.equal(duplicate.stats.sessionsOpened, 2, 'reopening one id does not create another lease');
    assert.equal(duplicate.stats.streamStarts, 1);

    const oneClosed = await bridge.close('ui-parallel-0001');
    assert.equal(oneClosed.openSessions, 1);
    assert.equal(oneClosed.subscriptions, 1);
    assert.equal(oneClosed.streamStops, 0);
    assert.equal(stream.stops, 0);

    const allClosed = await bridge.close('ui-parallel-0002');
    assert.equal(allClosed.openSessions, 0);
    assert.equal(allClosed.subscriptions, 0);
    assert.equal(allClosed.streamStops, 1);
    assert.equal(stream.stops, 1);
    await bridge.close('ui-parallel-0002');
    assert.equal(stream.stops, 1, 'repeated close stays idempotent');
  } finally {
    bridge.dispose();
  }
});

test('a read from a closed lease generation cannot populate a newly opened panel', async () => {
  const stream = fakeStream();
  const gates = [];
  const bridge = new RamingaUiBridge({
    ensure: async () => ({}),
    call: async () => new Promise((resolve) => gates.push(resolve)),
  }, { subscribe: stream.subscribe });
  try {
    const oldOpening = bridge.open('ui-generation-0001');
    const oldRejected = assert.rejects(oldOpening, /panel lease was closed/);
    await waitFor(() => gates.length === 1, 'first lease read');
    await bridge.close('ui-generation-0001');

    const newOpening = bridge.open('ui-generation-0002');
    await waitFor(() => gates.length === 2, 'new lease read');
    gates[0](statusResponse({ startedAtUnixMs: 1000, connections: [connection(PEER_A)] }));
    await flush();
    assert.equal(bridge.getStats().statusReads, 0, 'the old result is discarded');

    gates[1](statusResponse({ startedAtUnixMs: 2000, connections: [connection(PEER_B)] }));
    const opened = await newOpening;
    assert.equal(opened.status.startedAtUnixMs, '2000');
    assert.equal(opened.status.connections[0].peerId, PEER_B);
    assert.equal(opened.stats.sessionsOpened, 2);
    await oldRejected;
  } finally {
    bridge.dispose();
  }
});
