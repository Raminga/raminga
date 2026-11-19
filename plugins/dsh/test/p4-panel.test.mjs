// P4 panel runtime: passive activity polling, generation invalidation after
// dispose, and a failed read that clears stale live state through the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelRuntime } from '../ui/panel-runtime.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const SID = 'ui-test-p4-0001';

function snapshot() {
  return {
    sessionId: SID,
    status: { peerId: 'peer-a', nodeId: 'node-a', version: 'test', apiVersion: '6', connections: [] },
    statusAt: 1000, error: null, errorAt: null, freshness: 'live',
    stream: { phase: 'open', since: 900, lastOpenAt: 900, error: null },
    events: [], stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
  };
}
function activity(overrides = {}) {
  return {
    operations: [], instanceId: 'inst-current-0001', readAt: Date.now(), truncated: false, badLines: 0, error: '', ...overrides,
  };
}
function fakeTimers() {
  let next = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval(callback) { const id = next++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { const id = next++; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    fireInterval(id) {
      const callback = intervals.get(id);
      assert.ok(callback, `interval ${id} exists`);
      return callback();
    },
    get intervalCount() { return intervals.size; },
  };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function fakeApp() {
  return {
    activityValues: [],
    activityErrors: [],
    destroyCalls: 0,
    setNodeStatus() {}, pushNodeEvent() {}, setStats() {},
    setActivity(value) { this.activityValues.push(value); },
    setActivityError(error) { this.activityErrors.push(error); },
    destroy() { this.destroyCalls += 1; },
  };
}

function harness({ activityResult, activityDetailResult } = {}) {
  const calls = { activity: 0, detail: [], close: 0 };
  const app = fakeApp();
  const timers = fakeTimers();
  let mountedOptions = null;
  const rpc = {
    async open() { return { ok: true, value: snapshot() }; },
    async close() { calls.close += 1; return { ok: true, value: { openSessions: 0 } }; },
    async poll() { return { ok: true, value: snapshot() }; },
    async refresh() { return { ok: true, value: snapshot() }; },
    async activity(_sessionId, limit) {
      calls.activity += 1;
      if (activityResult instanceof Error) throw activityResult;
      const value = typeof activityResult === 'function' ? await activityResult(limit) : activity();
      if (value && value.__reject) throw new Error(value.__reject);
      return { ok: true, value };
    },
    async activityDetail(operationId) {
      calls.detail.push(operationId);
      if (activityDetailResult instanceof Error) throw activityDetailResult;
      return { ok: true, value: typeof activityDetailResult === 'function' ? await activityDetailResult(operationId) : { operation: { operationId }, evidence: {}, journey: null, missingReason: '' } };
    },
  };
  const runtime = createPanelRuntime({
    rpc,
    mount: (_host, options) => { mountedOptions = options; return app; },
    viewState: {},
    resolvePhase: () => 'ready',
    sessionId: SID,
    onBootError: () => {},
    timers,
    activityPollMs: 1000,
  });
  return { runtime, app, timers, calls, get options() { return mountedOptions; } };
}

test('runtime reads activity after open, polls it, and force refresh reads again', async () => {
  const h = harness();
  try {
    h.runtime.start({});
    await flush();
    await flush();
    assert.equal(h.calls.activity, 1);
    assert.equal(h.app.activityValues.length, 1);
    assert.ok(h.options.onLoadActivity, 'capability flag is exposed to the shared app');
    assert.ok(h.options.onLoadActivityDetail, 'detail loader is exposed to the shared app');
    assert.ok(h.runtime.timers.activityTimer, 'activity timer started');
    await h.timers.fireInterval(h.runtime.timers.activityTimer);
    await flush();
    assert.equal(h.calls.activity, 2);
    await h.runtime.refresh();
    await flush();
    assert.equal(h.calls.activity, 3);
    const detail = await h.options.onLoadActivityDetail('op-1');
    assert.equal(detail.operation.operationId, 'op-1');
    assert.deepEqual(h.calls.detail, ['op-1']);
  } finally {
    h.runtime.dispose();
  }
});

test('dispose increments generation and ignores a late activity result', async () => {
  const pending = deferred();
  const h = harness({ activityResult: () => pending.promise });
  h.runtime.start({});
  await flush();
  await flush();
  assert.equal(h.calls.activity, 1);
  assert.equal(h.app.activityValues.length, 0, 'read is still in flight');
  const generation = h.runtime.timers.activityGeneration;
  h.runtime.dispose();
  assert.ok(h.runtime.timers.activityGeneration > generation, 'dispose invalidates the read generation');
  assert.equal(h.runtime.timers.activityTimer, null);
  pending.resolve(activity({ instanceId: 'inst-late-0001' }));
  await flush();
  await flush();
  assert.equal(h.app.activityValues.length, 0, 'late result is discarded');
  assert.equal(h.app.activityErrors.length, 0);
});

test('a rejected activity read clears stale live state through setActivityError', async () => {
  const h = harness({ activityResult: new Error('Raminga 插件不可用/已卸载') });
  try {
    h.runtime.start({});
    await flush();
    await flush();
    assert.equal(h.app.activityValues.length, 0);
    assert.equal(h.app.activityErrors.length, 1);
    assert.match(h.app.activityErrors[0], /插件不可用|已卸载/);
  } finally {
    h.runtime.dispose();
  }
});

test('activity detail failure rejects to the app instead of inventing evidence', async () => {
  const h = harness({ activityDetailResult: new Error('detail unavailable') });
  try {
    h.runtime.start({});
    await flush();
    await assert.rejects(() => h.options.onLoadActivityDetail('op-x'), /detail unavailable/);
  } finally {
    h.runtime.dispose();
  }
});
