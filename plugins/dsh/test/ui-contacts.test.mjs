// Stage 4 bridge tests: contacts normalization, input validation, Connect
// result separation and share-address filtering. Real daemons are covered in
// bridge.integration.test.mjs; this file uses a routed fake client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

const PEER_A = 'QmTeCeUvFAgTuTXxZe2EQtZqGkc9HMJCf1LfGgvqsufWXB';
const PEER_B = 'QmYk5u2Gap4VJfmRRxBLvU5HnnQsKqvNzj7eM4mBHxzzo9';
const PEER_C = 'QmecWF7coMwrrnApJ2DpxUqV9giciixafaTEDBH9A29caS';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    direction: 'outbound',
    transport: 'tcp',
    route,
    direct: route === 'direct',
    limited: route !== 'direct',
    remoteMultiaddr: `/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`,
  };
}

function statusResponse({
  connections = [],
  advertisedAddrs = [],
  relays = [],
  startedAtUnixMs = 1000,
} = {}) {
  return {
    peerId: PEER_A,
    nodeId: 'node-a',
    version: 'test',
    protocolVersion: '1',
    apiVersion: '4',
    startedAtUnixMs,
    currentTime: 'now',
    listenAddrs: ['/ip4/127.0.0.1/tcp/4001'],
    advertisedAddrs,
    connections,
    peers: [],
    network: { relays },
  };
}

function friend(peerId, { name = '', description = '', paused = false } = {}) {
  return {
    peerId,
    name,
    description,
    addrs: [`/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`],
    manuallyConnected: true,
    firstSeenUnixMs: 1000,
    lastInteractionUnixMs: 2000,
    paused,
    relayCapable: false,
    dhtCapable: false,
  };
}

function connectResponse(peerId, { reused = false, multiaddr = '' } = {}) {
  return {
    peerId,
    transport: 'tcp',
    direct: true,
    limited: false,
    remoteMultiaddr: multiaddr,
    route: 'direct',
    relayPeerId: '',
    reused,
    requestedTransport: '',
    transportChanged: false,
    source: 'explicit',
    attempts: [],
    note: '',
  };
}

/** Routed fake: counts only the daemon call that the bridge actually makes. */
function routedApi(state) {
  const calls = { status: 0, listFriends: 0, connect: [] };
  return {
    calls,
    api: {
      ensure: async () => ({}),
      async call(fn) {
        return fn({
          async status() {
            calls.status += 1;
            const value = typeof state.status === 'function' ? state.status() : state.status;
            if (value instanceof Error) throw value;
            return value;
          },
          async listFriends() {
            calls.listFriends += 1;
            const value = typeof state.friends === 'function' ? state.friends() : state.friends;
            if (value instanceof Error) throw value;
            return { friends: value };
          },
          async connect(request) {
            calls.connect.push(request);
            if (typeof state.onConnect === 'function') state.onConnect(request);
            if (state.connectGate) return state.connectGate.promise;
            if (state.connectError) throw state.connectError;
            return state.connectResponse ?? connectResponse(PEER_B, { multiaddr: request.multiaddr });
          },
        });
      },
    },
  };
}

function fakeStream() {
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
    fail(error) {
      handlers?.onError(error);
      handlers?.onState('reconnecting');
    },
  };
}

async function setup(state, options = {}) {
  const stream = state.stream ?? fakeStream();
  state.stream = stream;
  const routed = routedApi(state);
  const bridge = new RamingaUiBridge(routed.api, {
    subscribe: stream.subscribe,
    statusTtlMs: 60_000,
    contactsTtlMs: 60_000,
    ...options,
  });
  const opened = await bridge.open(options.sessionId ?? 'ui-contacts-0001');
  return { bridge, calls: routed.calls, opened, stream };
}

test('contacts come from ListFriends and only a fresh Status proves connection state', async () => {
  const state = {
    status: statusResponse({ connections: [connection(PEER_B)] }),
    friends: [friend(PEER_A, { name: 'Alice' }), friend(PEER_B, { name: 'Bob' })],
  };
  const { bridge } = await setup(state);
  try {
    const live = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(live.total, 2);
    assert.equal(live.freshness, 'live');
    assert.equal(live.connectionFreshness, 'live');
    const a = live.friends.find((item) => item.peerId === PEER_A);
    const b = live.friends.find((item) => item.peerId === PEER_B);
    assert.equal(a.connection, 'disconnected');
    assert.equal(b.connection, 'connected');
    assert.equal(b.connections, 1);

    state.status = new Error('status read failed');
    const stale = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(stale.connectionFreshness, 'unknown');
    assert.equal(stale.statusFreshness, 'stale');
    for (const item of stale.friends) assert.equal(item.connection, 'unknown');
    assert.equal(stale.friends.length, 2, 'a Status failure never removes the contact rows');
    assert.match(stale.statusError, /status read failed/);
  } finally {
    bridge.dispose();
  }
});

test('a true empty contacts list is distinct from a failed read', async () => {
  const state = { status: statusResponse(), friends: [] };
  const { bridge } = await setup(state);
  try {
    const empty = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(empty.freshness, 'live');
    assert.equal(empty.total, 0);
    assert.equal(empty.error, null);

    state.friends = new Error('list friends failed');
    const failed = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(failed.freshness, 'unavailable');
    assert.equal(failed.total, 0);
    assert.match(failed.error, /list friends failed/);
  } finally {
    bridge.dispose();
  }
});

test('a failed refresh retains previous contacts with their read time as stale', async () => {
  const state = { status: statusResponse(), friends: [friend(PEER_A)] };
  const { bridge } = await setup(state);
  try {
    const first = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(first.total, 1);
    const firstAt = first.at;
    state.friends = new Error('refresh failed');
    const stale = await bridge.contacts('ui-contacts-0001', true);
    assert.equal(stale.total, 1);
    assert.equal(stale.friends[0].peerId, PEER_A);
    assert.equal(stale.freshness, 'stale');
    assert.equal(stale.at, firstAt);
    assert.match(stale.error, /refresh failed/);
  } finally {
    bridge.dispose();
  }
});

test('invalid connect input is rejected without any daemon dial', async () => {
  const state = { status: statusResponse(), friends: [] };
  const { bridge, calls } = await setup(state);
  try {
    const empty = await bridge.connect('ui-contacts-0001', '   ');
    assert.equal(empty.ok, false);
    assert.equal(empty.invalid, true);
    assert.equal(empty.contact.ok, false);
    assert.equal(calls.connect.length, 0);

    const badPeer = await bridge.connect('ui-contacts-0001', 'not-a-peer-id');
    assert.equal(badPeer.invalid, true);
    assert.match(badPeer.error, /Peer ID/);

    const noCircuitTarget = await bridge.connect('ui-contacts-0001', '/ip4/127.0.0.1/tcp/4001');
    assert.equal(noCircuitTarget.invalid, true);
    assert.match(noCircuitTarget.error, /\/p2p\//);

    const badAddress = await bridge.connect('ui-contacts-0001', '/ip4/not-an-ip/tcp/4001/p2p/' + PEER_B);
    assert.equal(badAddress.invalid, true);

    const badCircuit = await bridge.connect('ui-contacts-0001', `/ip4/198.51.100.1/tcp/4001/p2p/${PEER_B}/p2p-circuit`);
    assert.equal(badCircuit.invalid, true);
    assert.match(badCircuit.error, /中继地址/);
    assert.equal(calls.connect.length, 0, 'invalid input must never reach Connect');
  } finally {
    bridge.dispose();
  }
});

test('a full multiaddr dial verifies ListFriends and Status after success', async () => {
  const address = `/ip4/192.0.2.10/tcp/4001/p2p/${PEER_B}`;
  const state = {
    status: statusResponse(),
    friends: [],
    onConnect(request) {
      assert.equal(request.multiaddr, address);
      state.friends = [friend(PEER_B, { name: 'Bob' })];
      state.status = statusResponse({ connections: [connection(PEER_B)] });
    },
    connectResponse: connectResponse(PEER_B, { multiaddr: address }),
  };
  const { bridge } = await setup(state);
  try {
    const result = await bridge.connect('ui-contacts-0001', `  ${address}  `);
    assert.equal(result.ok, true);
    assert.equal(result.invalid, false);
    assert.equal(result.peerId, PEER_B);
    assert.equal(result.route, 'direct');
    assert.equal(result.contact.ok, true);
    assert.equal(result.contact.found, true);
    assert.equal(result.status.ok, true);
    assert.ok(result.contacts);
    assert.equal(result.contacts.total, 1);
    assert.equal(result.contacts.friends[0].connection, 'connected');
  } finally {
    bridge.dispose();
  }
});

test('a successful dial stays successful when the contact refresh fails or lags', async () => {
  const address = `/ip4/192.0.2.10/tcp/4001/p2p/${PEER_B}`;
  const refreshState = {
    status: statusResponse(),
    friends: [],
    connectResponse: connectResponse(PEER_B, { multiaddr: address }),
  };
  refreshState.onConnect = () => { refreshState.friends = new Error('friend write unavailable'); };
  const first = await setup(refreshState);
  try {
    const result = await first.bridge.connect('ui-contacts-0001', address);
    assert.equal(result.ok, true, 'dial success is independent of the contact refresh');
    assert.equal(result.contact.ok, false);
    assert.equal(result.contact.found, false);
    assert.match(result.contact.error, /friend write unavailable/);
    assert.equal(result.status.ok, true);
  } finally {
    first.bridge.dispose();
  }

  const notSaved = {
    status: statusResponse(),
    friends: [],
    connectResponse: connectResponse(PEER_B, { multiaddr: address }),
  };
  const second = await setup(notSaved, { sessionId: 'ui-contacts-0002' });
  try {
    const result = await second.bridge.connect('ui-contacts-0002', address);
    assert.equal(result.ok, true);
    assert.equal(result.contact.ok, true);
    assert.equal(result.contact.found, false, 'the bridge must not fabricate a persisted friend row');
    assert.equal(result.contacts.total, 0);
  } finally {
    second.bridge.dispose();
  }
});

test('reused connections do not add a duplicate contact', async () => {
  const state = {
    status: statusResponse({ connections: [connection(PEER_B)] }),
    friends: [friend(PEER_B, { name: 'Bob' })],
    connectResponse: connectResponse(PEER_B, { reused: true }),
  };
  const { bridge } = await setup(state);
  try {
    const result = await bridge.connect('ui-contacts-0001', PEER_B);
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.contact.ok, true);
    assert.equal(result.contact.found, true);
    assert.equal(result.contacts.total, 1);
    assert.equal(result.contacts.friends.filter((item) => item.peerId === PEER_B).length, 1);
  } finally {
    bridge.dispose();
  }
});

test('share uses advertised and active relay addresses, never listen or loopback', async () => {
  const relayAddr = `/ip4/198.51.100.2/tcp/4001/p2p/${PEER_C}/p2p-circuit/p2p/${PEER_A}`;
  const state = {
    friends: [],
    status: statusResponse({
      advertisedAddrs: [
        '/ip4/203.0.113.5/tcp/4001',
        `/ip4/192.168.1.5/tcp/4001/p2p/${PEER_A}`,
        `/ip4/127.0.0.1/tcp/4001/p2p/${PEER_A}`,
        `/ip4/0.0.0.0/tcp/4001/p2p/${PEER_A}`,
        `/ip6/::1/tcp/4001/p2p/${PEER_A}`,
        `/ip4/203.0.113.9/tcp/4001/p2p/${PEER_C}`,
      ],
      relays: [
        { reservationStatus: 'active', expiresAtUnixMs: Date.now() + 60_000, relayedAddr: relayAddr },
        { reservationStatus: 'active', expiresAtUnixMs: Date.now() - 1, relayedAddr: relayAddr },
        { reservationStatus: 'lost', expiresAtUnixMs: Date.now() + 60_000, relayedAddr: relayAddr },
      ],
    }),
  };
  const { bridge } = await setup(state);
  try {
    const share = await bridge.share('ui-contacts-0001');
    assert.equal(share.ok, true);
    assert.equal(share.peerId, PEER_A);
    assert.equal(share.stale, false);
    const addresses = share.addresses.map((item) => item.multiaddr);
    assert.equal(addresses.length, 3);
    assert.ok(addresses.some((value) => value.startsWith('/ip4/203.0.113.5/tcp/4001/p2p/')));
    assert.ok(addresses.some((value) => value.startsWith('/ip4/192.168.1.5/tcp/4001/p2p/')));
    assert.equal(addresses.includes(relayAddr), true);
    assert.equal(addresses.some((value) => value.includes('127.0.0.1')), false);
    assert.equal(addresses.some((value) => value.includes('0.0.0.0')), false);
    assert.equal(addresses.some((value) => value.includes('::1')), false);
    assert.equal(addresses.some((value) => value.includes(PEER_C) && !value.includes('p2p-circuit')), false);
    assert.equal(share.addresses.filter((item) => item.scope === 'private').length, 1);
    assert.equal(share.addresses.filter((item) => item.kind === 'relay').length, 1);

    state.status = statusResponse({ advertisedAddrs: ['/ip4/127.0.0.1/tcp/4001'] });
    const noUsable = await bridge.share('ui-contacts-0001');
    assert.equal(noUsable.ok, true);
    assert.equal(noUsable.addresses.length, 0);
    assert.equal(noUsable.peerId, PEER_A, 'the full Peer ID remains shareable');

    state.status = new Error('node unavailable');
    const stale = await bridge.share('ui-contacts-0001');
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.match(stale.error, /node unavailable/);
    assert.equal(stale.peerId, PEER_A);
  } finally {
    bridge.dispose();
  }
});

test('share reports an error instead of inventing an identity when Status never succeeded', async () => {
  const state = { status: new Error('daemon down'), friends: [] };
  const { bridge } = await setup(state);
  try {
    const share = await bridge.share('ui-contacts-0001');
    assert.equal(share.ok, false);
    assert.equal(share.peerId, null);
    assert.equal(share.addresses.length, 0);
    assert.match(share.error, /daemon down/);
  } finally {
    bridge.dispose();
  }
});

test('a late connect result from a closed lease cannot populate a new panel', async () => {
  const address = `/ip4/192.0.2.10/tcp/4001/p2p/${PEER_B}`;
  const gate = deferred();
  const state = {
    status: statusResponse(),
    friends: [],
    connectGate: gate,
    connectResponse: connectResponse(PEER_B, { multiaddr: address }),
  };
  const stream = fakeStream();
  const routed = routedApi(state);
  const bridge = new RamingaUiBridge(routed.api, {
    subscribe: stream.subscribe,
    statusTtlMs: 60_000,
    contactsTtlMs: 60_000,
  });
  try {
    await bridge.open('ui-contacts-old-0001');
    const late = bridge.connect('ui-contacts-old-0001', address);
    await waitFor(() => routed.calls.connect.length === 1, 'connect start');
    await bridge.close('ui-contacts-old-0001');
    const reopened = await bridge.open('ui-contacts-new-0002');
    assert.equal(reopened.status?.peerId, PEER_A);

    gate.resolve(connectResponse(PEER_B, { multiaddr: address }));
    // If the closed lease's post-connect refresh still ran, it would read this
    // row and (incorrectly) populate the newly opened session.
    state.friends = [friend(PEER_B)];
    const result = await late;
    assert.equal(result.ok, true, 'the real server-side dial is not rewritten as a failure');
    assert.equal(result.contact.ok, false, 'a closed page must not claim contact verification');

    state.friends = [];
    const contacts = await bridge.contacts('ui-contacts-new-0002', false);
    assert.equal(contacts.total, 0, 'the old connect must not overwrite the new lease list');
  } finally {
    bridge.dispose();
  }
});

test('checkContact re-reads ListFriends without dialing again', async () => {
  const state = { status: statusResponse(), friends: [] };
  const { bridge, calls } = await setup(state);
  try {
    const missing = await bridge.checkContact('ui-contacts-0001', PEER_B);
    assert.equal(missing.ok, true);
    assert.equal(missing.found, false);
    assert.equal(calls.connect.length, 0, 'a check never dials');

    state.friends = [friend(PEER_B, { name: 'Bob' })];
    const found = await bridge.checkContact('ui-contacts-0001', PEER_B);
    assert.equal(found.ok, true);
    assert.equal(found.found, true);
    assert.equal(found.contacts.total, 1);
    assert.equal(calls.connect.length, 0);

    const invalid = await bridge.checkContact('ui-contacts-0001', 'not a peer');
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /Peer ID/);
  } finally {
    bridge.dispose();
  }
});
