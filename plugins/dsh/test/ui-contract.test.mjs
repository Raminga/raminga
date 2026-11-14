// Contract checks for the DSH panel adapter. These do not replace the real
// host verification; they keep the supported mounting declaration, the Remote
// manifest, and the generated browser artifact from drifting apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { TYPERT, UI_INVOCATIONS } from '../lib/ui-typert.js';
import { RamingaUiBridge, mapDaemonEvent } from '../lib/ui-bridge.js';
import { subscribeEvents } from '../lib/events.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function statusResponse() {
  return {
    peerId: '12D3KooWabcdefghijklmnop',
    nodeId: 'node-test',
    version: 'test',
    protocolVersion: '1',
    apiVersion: '4',
    startedAtUnixMs: 1,
    currentTime: 'now',
    listenAddrs: [],
    connections: [],
    peers: [],
  };
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('package declares the supported DSH client mounting path', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ]);
  assert.equal(manifest.exports['./client'], './lib/ui-client.js');
  assert.equal(manifest.exports['./typert'], './lib/ui-typert.js');
});

test('Host Typert manifest names all bridge methods and their parameters', () => {
  assert.equal(TYPERT.package, '@raminga/dsh');
  assert.equal(TYPERT.face, 'host');
  assert.deepEqual(UI_INVOCATIONS.map((entry) => entry.method), [
    'open', 'poll', 'refresh', 'close', 'contacts', 'setFriendName', 'setFriendDescription', 'connect', 'checkContact', 'share',
    'conversations', 'messages', 'send', 'cancelOutbox', 'discoveries', 'discoveryContent',
    'humanOutbound', 'mine', 'peerProfile', 'journey', 'locateMessage',
  ]);
  for (const entry of UI_INVOCATIONS) {
    assert.equal(entry.service, 'ramingaUi');
    assert.equal(entry.namespace, 'ramingaUi');
    assert.equal(entry.parameters[0].name, 'sessionId');
    assert.equal(entry.parameters[0].codec.mode, 'strict');
    assert.equal(entry.result.mode, 'strict');
  }
  const byMethod = Object.fromEntries(UI_INVOCATIONS.map((entry) => [entry.method, entry]));
  assert.deepEqual(byMethod.contacts.parameters.map((item) => item.name), ['sessionId', 'force']);
  assert.deepEqual(byMethod.setFriendName.parameters.map((item) => item.name), ['sessionId', 'peerId', 'name']);
  assert.deepEqual(byMethod.setFriendDescription.parameters.map((item) => item.name), ['sessionId', 'peerId', 'description']);
  assert.deepEqual(byMethod.connect.parameters.map((item) => item.name), ['sessionId', 'input']);
  assert.deepEqual(byMethod.checkContact.parameters.map((item) => item.name), ['sessionId', 'peerId']);
  assert.equal(byMethod.share.parameters.length, 1);
  assert.deepEqual(byMethod.conversations.parameters.map((item) => item.name), ['sessionId', 'force']);
  assert.deepEqual(byMethod.messages.parameters.map((item) => item.name), ['sessionId', 'peerId', 'before', 'force']);
  assert.deepEqual(byMethod.send.parameters.map((item) => item.name), ['sessionId', 'peerId', 'text', 'requestId']);
  assert.deepEqual(byMethod.cancelOutbox.parameters.map((item) => item.name), ['sessionId', 'messageId']);
  assert.deepEqual(byMethod.discoveries.parameters.map((item) => item.name), ['sessionId', 'familiar', 'force']);
  assert.deepEqual(byMethod.discoveryContent.parameters.map((item) => item.name), ['sessionId', 'id']);
  assert.deepEqual(byMethod.humanOutbound.parameters.map((item) => item.name), ['sessionId', 'force']);
  assert.deepEqual(byMethod.mine.parameters.map((item) => item.name), ['sessionId', 'force']);
  assert.deepEqual(byMethod.peerProfile.parameters.map((item) => item.name), ['sessionId', 'peerId', 'force']);
  assert.deepEqual(byMethod.journey.parameters.map((item) => item.name), ['sessionId', 'force']);
  assert.deepEqual(byMethod.locateMessage.parameters.map((item) => item.name), ['sessionId', 'peerId', 'messageId']);
});

test('browser artifact uses the native main workspace and sidebar panel slots', () => {
  const bundle = fs.readFileSync(path.join(root, 'lib', 'ui-client.js'), 'utf8');
  assert.match(bundle, /ctx\.remote\.\$mount/);
  assert.match(bundle, /slots\.inject\('main'/);
  assert.match(bundle, /slots\.inject\('sidebar\.panellist'/);
  assert.match(bundle, /key: PANEL_ID/);
  assert.match(bundle, /id: PANEL_ID/);
  assert.match(bundle, /ramingaUi\//);
  assert.match(bundle, /createPanelRuntime/);
  assert.match(bundle, /dsh-frame-leading-clearance/);
  assert.match(bundle, /isolation:\s*isolate/);
  assert.doesNotMatch(bundle, /sidebar\.right\.pane\.tab|sidebarRightTabs|sidebarRight|sidebar\.footer\.action/);
  assert.doesNotMatch(bundle, /document\.body|createElement\('iframe'\)/);
  assert.doesNotMatch(bundle, /api\.token|raminga\.db|api\.endpoint|cert_sha256|Bearer /);
});

test('the lazy client registers exactly one native main panel and sidebar entry', async () => {
  const code = fs.readFileSync(path.join(root, 'lib', 'ui-client.js'), 'utf8');
  let factory;
  const lifecycle = [];
  const context = {
    window: {
      __ModuleLoader__: {
        load(options) {
          assert.equal(options.id, '@raminga/dsh');
          factory = options.factory;
        },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(code, context, { filename: 'ui-client.js' });
  assert.equal(typeof factory, 'function');

  const ReactStub = {
    createElement(type, props, ...children) { return { type, props, children }; },
    useRef(initial) { return { current: initial }; },
    useState(initial) { return [initial, () => {}]; },
    useEffect() {},
  };
  const plugin = factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require(${name})`);
  });
  assert.deepEqual(Array.from(plugin.inject), ['remote', 'slots', 'layout']);

  const registrations = [];
  const disposers = [];
  const slots = {
    inject(name, callback) {
      assert.ok(['main', 'sidebar.panellist'].includes(name), `unexpected slot ${name}`);
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const rpc = {
    open: async () => ({ ok: true, value: {} }),
    poll: async () => ({ ok: true, value: {} }),
    refresh: async () => ({ ok: true, value: {} }),
    close: async () => ({ ok: true, value: {} }),
  };
  const ctx = {
    remote: { async $mount() { return () => {}; } },
    slots,
    get(name) { return name === 'remote.ramingaUi' ? rpc : undefined; },
    effect(fn) {
      const dispose = fn();
      lifecycle.push(dispose);
      return dispose;
    },
  };
  await plugin.apply(ctx);

  assert.equal(registrations.length, 2);
  const main = registrations.find((entry) => entry.options.name === 'main');
  const entry = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.ok(main, 'main slot must be registered');
  assert.ok(entry, 'sidebar.panellist must be registered');
  assert.equal(main.options.key, 'raminga');
  assert.equal(entry.options.id, 'raminga');
  assert.equal(entry.options.label(), 'Raminga');
  assert.equal(typeof main.component, 'function');
  assert.equal(typeof entry.component, 'function');
  assert.equal(registrations.some(({ options }) => options.name === 'sidebar.right.pane.tab'), false);
  assert.equal(registrations.some(({ options }) => options.name === 'sidebar.footer.action'), false);
  for (const dispose of lifecycle) if (typeof dispose === 'function') dispose();
});

test('daemon event mapping exposes feedback and inbound text for reconciliation', () => {
  const connection = mapDaemonEvent({
    atUnixMs: 12345,
    connection: { peerId: '12D3KooWabcdefghijklmnop', direction: 'inbound', transport: 'tcp', route: 'direct' },
  });
  assert.equal(connection.kind, 'connection');
  assert.match(connection.summary, /连接变更/);
  assert.match(connection.summary, /inbound/);
  assert.equal(connection.atUnixMs, 12345);

  const chat = mapDaemonEvent({
    atUnixMs: 22222,
    chatReceived: { messageId: 'm1', fromPeerId: '12D3KooWabcdefghijklmnop', text: 'secret body', accepted: true },
  });
  assert.equal(chat.kind, 'chat');
  assert.match(chat.summary, /收到消息/);
  assert.equal(chat.text, 'secret body', 'the local UI needs plain text to merge an inbound row');
  assert.doesNotMatch(chat.summary, /secret body/, 'the status-event summary does not duplicate the body');
});

test('closing a panel while open() is still awaiting readiness never starts Events', async () => {
  const ready = deferred();
  let statusCalls = 0;
  const bridge = new RamingaUiBridge({
    ensure: () => ready.promise,
    call: async () => {
      statusCalls += 1;
      return statusResponse();
    },
  });
  try {
    const opening = bridge.open('ui-race-0001');
    await bridge.close('ui-race-0001');
    ready.resolve({
      events: () => {
        throw new Error('Events must not start after close');
      },
    });
    await assert.rejects(opening, /panel lease was closed/);
    assert.equal(statusCalls, 0);
    assert.equal(bridge.getStats().streamStarts, 0);
    assert.equal(bridge.getStats().streamActive, false);
    assert.equal(bridge.getStats().subscriptions, 0);
  } finally {
    bridge.dispose();
  }
});

test('closing a panel while Status is in flight stops the already-open Events stream', async () => {
  const status = deferred();
  let statusCalls = 0;
  let eventCalls = 0;
  const bridge = new RamingaUiBridge({
    ensure: async () => ({
      events: (_request, { signal }) => {
        eventCalls += 1;
        return (async function* stream() {
          yield { toJson: () => ({ heartbeat: true }) };
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
        })();
      },
    }),
    call: async () => {
      statusCalls += 1;
      return status.promise;
    },
  });
  try {
    const opening = bridge.open('ui-race-0002');
    // Subscription is established before the first Status read by design.
    await waitFor(() => statusCalls === 1 && eventCalls === 1, 'Status and Events');
    await bridge.close('ui-race-0002');
    const closed = bridge.getStats();
    assert.equal(closed.openSessions, 0);
    assert.equal(closed.streamStarts, 1);
    assert.equal(closed.streamStops, 1);
    assert.equal(closed.streamActive, false);
    assert.equal(closed.subscriptions, 0);

    status.resolve(statusResponse());
    await assert.rejects(opening, /panel lease was closed/);
    assert.equal(bridge.getStats().streamActive, false);
  } finally {
    bridge.dispose();
  }
});

test('disposing while open() is awaiting readiness never starts Events', async () => {
  const ready = deferred();
  const bridge = new RamingaUiBridge({
    ensure: () => ready.promise,
    call: async () => statusResponse(),
  });
  const opening = bridge.open('ui-race-0003');
  bridge.dispose();
  ready.resolve({
    events: () => {
      throw new Error('Events must not start after dispose');
    },
  });
  await assert.rejects(opening, /panel lease was closed/);
  const stats = bridge.getStats();
  assert.equal(stats.openSessions, 0);
  assert.equal(stats.streamStarts, 0);
  assert.equal(stats.streamActive, false);
});

test('subscription count follows the shared real stream, not the session count', async () => {
  let eventStreams = 0;
  const bridge = new RamingaUiBridge({
    ensure: async () => ({
      events: (_request, { signal }) => {
        eventStreams += 1;
        return (async function* stream() {
          yield { toJson: () => ({ heartbeat: true }) };
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
        })();
      },
    }),
    call: async () => statusResponse(),
  });
  try {
    const first = await bridge.open('ui-stream-0001');
    const second = await bridge.open('ui-stream-0002');
    assert.equal(first.stats.subscriptions, 1);
    assert.equal(second.stats.openSessions, 2);
    assert.equal(second.stats.subscriptions, 1, 'two panels still share one Events stream');
    assert.equal(eventStreams, 1);
    assert.equal(second.stats.streamStarts, 1);

    const oneClosed = await bridge.close('ui-stream-0001');
    assert.equal(oneClosed.openSessions, 1);
    assert.equal(oneClosed.subscriptions, 1);
    assert.equal(oneClosed.streamStops, 0);

    const allClosed = await bridge.close('ui-stream-0002');
    assert.equal(allClosed.openSessions, 0);
    assert.equal(allClosed.subscriptions, 0);
    assert.equal(allClosed.streamActive, false);
    assert.equal(allClosed.streamStops, 1);
  } finally {
    bridge.dispose();
  }
});

test('a dropped Events stream is reported inactive instead of looking subscribed', async () => {
  const bridge = new RamingaUiBridge({
    ensure: async () => ({
      events: () => (async function* stream() {
        yield { toJson: () => ({ heartbeat: true }) };
        throw new Error('stream dropped');
      })(),
    }),
    call: async () => statusResponse(),
  });
  try {
    await bridge.open('ui-drop-0001');
    await waitFor(() => {
      const stats = bridge.getStats();
      return stats.lastError === 'stream dropped' && stats.streamActive === false;
    }, 'dropped stream state');
    const stats = bridge.getStats();
    assert.equal(stats.subscriptions, 0);
    assert.equal(stats.openSessions, 1);
  } finally {
    bridge.dispose();
  }
});

test('events cancellation during api.ensure never opens the stream', async () => {
  const ready = deferred();
  let eventsCalls = 0;
  const phases = [];
  const stop = subscribeEvents(
    { ensure: () => ready.promise },
    () => {},
    () => {},
    (phase) => phases.push(phase),
  );
  stop();
  ready.resolve({
    events: () => {
      eventsCalls += 1;
      return (async function* stream() {})();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventsCalls, 0);
  assert.deepEqual(phases, ['connecting', 'closed']);
});

test('events stop aborts the live stream signal and reports one closed state', async () => {
  let signal;
  const phases = [];
  const errors = [];
  const stop = subscribeEvents(
    {
      ensure: async () => ({
        events: (_request, options) => {
          signal = options.signal;
          return (async function* stream() {
            yield { toJson: () => ({ heartbeat: true }) };
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          })();
        },
      }),
    },
    () => {},
    (error) => errors.push(error),
    (phase) => phases.push(phase),
  );
  await waitFor(() => phases.includes('open'), 'Events open');
  stop();
  await waitFor(() => signal.aborted, 'stream abort');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(phases, ['connecting', 'open', 'closed']);
  assert.deepEqual(errors, []);
});

test('events stop cancels the reconnect backoff timer', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let reconnectTimer = null;
  let clearedTimer = null;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = originalSetTimeout(callback, ms, ...args);
    if (ms === 5000) reconnectTimer = timer;
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer === reconnectTimer) clearedTimer = timer;
    return originalClearTimeout(timer);
  };
  try {
    const phases = [];
    const stop = subscribeEvents(
      {
        ensure: async () => ({
          events: () => (async function* stream() {
            throw new Error('stream dropped');
          })(),
        }),
      },
      () => {},
      () => {},
      (phase) => phases.push(phase),
    );
    await waitFor(() => phases.includes('reconnecting'), 'reconnect backoff');
    assert.ok(reconnectTimer, 'reconnect sleep should schedule one timer');
    stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clearedTimer, reconnectTimer);
    assert.equal(phases.at(-1), 'closed');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('a clean Events stream end is a disconnect and resubscribes', async () => {
  let streams = 0;
  const phases = [];
  const errors = [];
  const stop = subscribeEvents(
    {
      ensure: async () => ({
        events: () => {
          streams += 1;
          return (async function* stream() {
            yield { toJson: () => ({ heartbeat: true, atUnixMs: 1 }) };
          })();
        },
      }),
    },
    () => {},
    (error) => errors.push(error),
    (phase) => phases.push(phase),
    { reconnectDelayMs: 10 },
  );
  try {
    await waitFor(() => phases.filter((phase) => phase === 'open').length >= 2, 'reopened Events stream');
    assert.ok(streams >= 2, 'a clean end must open a new stream');
    assert.equal(phases[0], 'connecting');
    assert.ok(phases.includes('open'));
    assert.ok(phases.includes('reconnecting'));
    assert.ok(errors.some((error) => /结束/.test(error.message)));
  } finally {
    stop();
  }
  await waitFor(() => phases.at(-1) === 'closed', 'closed after stop');
});
