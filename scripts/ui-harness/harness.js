// Local browser harness for the shared Raminga UI. This is NOT a DSH host:
// it simulates one main-workspace host by mounting/destroying the same public
// mount API the DSH adapter calls. Node/status data below is explicitly mock.
(() => {
  const mount = document.querySelector('#mount');
  const stateOut = document.querySelector('#harnessState');
  const viewOut = document.querySelector('#harnessView');
  const statusButtons = [...document.querySelectorAll('[data-status]')];
  let app = null;
  let viewState = RamingaUI.createViewState();
  let currentStatus = 'loading';
  const log = [];

  const mockStatus = {
    peerId: '12D3KooWHarnessPeer9yQ4Xz7mN2vK8sT5rB3cD6fG1hJ',
    nodeId: 'harness-node-9yQ4Xz7mN2vK8sT5rB3cD6fG',
    version: '0.1.0-harness',
    protocolVersion: '1',
    apiVersion: '3',
    startedAtUnixMs: Date.now() - 86_400_000,
    currentTime: new Date().toISOString(),
    listenAddrs: ['/ip4/127.0.0.1/tcp/49711'],
    connections: [
      { peerId: '12D3KooWPeerDirect5rB3cD6fG1hJ2vK8sT5', route: 'direct', transport: 'quic', direction: 'outbound', direct: true, limited: false, remoteMultiaddr: '/ip4/192.0.2.10/udp/4001/quic-v1' },
      { peerId: '12D3KooWPeerDirect5rB3cD6fG1hJ2vK8sT5', route: 'relay', transport: 'tcp', direction: 'inbound', direct: false, limited: false, remoteMultiaddr: '/ip4/198.51.100.4/tcp/4001' },
      { peerId: '12D3KooWPeerRelay7mN2vK8sT5rB3cD6fG1hJ', route: 'relay', transport: 'tcp', direction: 'outbound', direct: false, limited: false, remoteMultiaddr: '/ip4/203.0.113.8/tcp/4001' },
    ],
    peers: [],
    maxChatTextBytes: 4096,
    maxStoredMessages: 50000,
  };

  const mockContacts = {
    friends: [
      {
        peerId: '12D3KooWQ7h2dYpXk3nV8sT5rB4cD6fG1hJ9mN2qR7wY4zA8eC3',
        name: '林野',
        description: '喜欢在雨天散步，也做一些木工。',
        connection: 'connected',
        connections: 1,
        directConnections: 1,
        relayConnections: 0,
        paused: false,
      },
      {
        peerId: '12D3KooWM4t8sV2yK9pR5cD7fG1hJ3mN6qT8wY2zA4eC7bF9dH5',
        name: '',
        description: '之前聊过公开内容。',
        connection: 'disconnected',
        connections: 0,
        directConnections: 0,
        relayConnections: 0,
        paused: false,
      },
    ],
    at: Date.now() - 1200,
    error: null,
    errorAt: null,
    freshness: 'live',
    connectionFreshness: 'live',
    statusAt: Date.now() - 300,
    statusError: null,
    statusFreshness: 'live',
    total: 2,
  };

  const mockShare = {
    ok: true,
    peerId: mockStatus.peerId,
    at: Date.now() - 500,
    stale: false,
    error: null,
    addresses: [
      { kind: 'direct', scope: 'public', multiaddr: `${mockStatus.peerId}` },
      { kind: 'direct', scope: 'private', multiaddr: '/ip4/192.168.1.23/tcp/49711' },
      { kind: 'relay', scope: 'public', multiaddr: '/ip4/198.51.100.8/tcp/4001/p2p/12D3KooWRelayHarness8yQ4Xz7mN2vK8sT5rB3cD6fG1hJ' },
    ],
  };
  mockShare.addresses[0].multiaddr = `/ip4/203.0.113.23/tcp/49711/p2p/${mockStatus.peerId}`;
  mockShare.addresses[1].multiaddr = `/ip4/192.168.1.23/tcp/49711/p2p/${mockStatus.peerId}`;
  mockShare.addresses[2].multiaddr = `/ip4/198.51.100.8/tcp/4001/p2p/12D3KooWRelayHarness8yQ4Xz7mN2vK8sT5rB3cD6fG1hJ/p2p-circuit/p2p/${mockStatus.peerId}`;

  let contacts = mockContacts;

  // Simulated conversation data for the local mount harness only. Production
  // DSH receives these objects from the real daemon bridge.
  const friendA = mockContacts.friends[0].peerId;
  const friendB = mockContacts.friends[1].peerId;
  const retained = new Map([
    [friendA, [
      { messageId: 'h-a-2', peerId: friendA, direction: 'out', text: '这是人工界面发出的消息。', acked: true, createdAt: Date.now() - 60_000, ackedAt: Date.now() - 59_000, deliveryStatus: 'acked', deliveryError: '', origin: 'human', deliveryUpdatedAt: Date.now() - 59_000, clientRequestId: 'h-req-a-2' },
      { messageId: 'h-a-1', peerId: friendA, direction: 'in', text: '你好，这是一条收到的消息。', acked: true, createdAt: Date.now() - 120_000, ackedAt: null, deliveryStatus: 'received', deliveryError: '', origin: 'unknown', deliveryUpdatedAt: null, clientRequestId: '' },
    ]],
    [friendB, [
      { messageId: 'h-b-1', peerId: friendB, direction: 'in', text: '<b>这是纯文本</b>，不会作为 HTML 执行。', acked: true, createdAt: Date.now() - 300_000, ackedAt: null, deliveryStatus: 'received', deliveryError: '', origin: 'unknown', deliveryUpdatedAt: null, clientRequestId: '' },
    ]],
  ]);
  let tempSend = 0;

  function conversationPage() {
    const conversations = [];
    for (const [peerId, rows] of retained) {
      if (rows.length === 0) continue;
      const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
      const last = sorted[0];
      conversations.push({
        peerId,
        lastMessageId: last.messageId,
        direction: last.direction,
        preview: last.text,
        lastAt: last.createdAt,
        deliveryStatus: last.deliveryStatus,
        origin: last.origin,
        messageCount: rows.length,
      });
    }
    conversations.sort((a, b) => b.lastAt - a.lastAt);
    return {
      conversations,
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      retention: { retainedMessages: [...retained.values()].reduce((n, rows) => n + rows.length, 0), oldestRetainedAt: Date.now() - 300_000, maxStoredMessages: 50000 },
    };
  }

  function messagePage(peerId, older = false) {
    const rows = retained.get(peerId) ?? [];
    return {
      peerId,
      messages: older ? [] : [...rows].sort((a, b) => b.createdAt - a.createdAt),
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      hasMore: false,
      nextBefore: '',
      retention: { retainedMessages: rows.length, oldestRetainedAt: rows.length > 0 ? Math.min(...rows.map((row) => row.createdAt)) : null, maxStoredMessages: 50000 },
    };
  }

  function stats(mode) {
    if (mode === 'ready') {
      return { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open', streamStarts: 1, streamStops: 0, eventsSeen: 2, eventsForwarded: 2, sessionsOpened: 1, sessionsClosed: 0, lastEventAt: Date.now(), lastError: null };
    }
    if (mode === 'stale') {
      return { openSessions: 1, subscriptions: 0, streamActive: false, streamPhase: 'reconnecting', streamStarts: 1, streamStops: 0, eventsSeen: 1, eventsForwarded: 1, sessionsOpened: 1, sessionsClosed: 0, lastEventAt: Date.now() - 6000, lastError: 'harness: event stream dropped' };
    }
    if (mode === 'error') {
      return { openSessions: 1, subscriptions: 0, streamActive: false, streamPhase: 'open', streamStarts: 1, streamStops: 0, eventsSeen: 1, eventsForwarded: 1, sessionsOpened: 1, sessionsClosed: 0, lastEventAt: Date.now() - 3000, lastError: 'harness: daemon status timed out' };
    }
    if (mode === 'closed') {
      return { openSessions: 1, subscriptions: 0, streamActive: false, streamPhase: 'closed', streamStarts: 1, streamStops: 1, eventsSeen: 1, eventsForwarded: 1, sessionsOpened: 1, sessionsClosed: 0, lastEventAt: Date.now() - 9000, lastError: 'harness: event stream closed' };
    }
    return { openSessions: 1, subscriptions: 0, streamActive: false, streamPhase: 'connecting', streamStarts: 0, streamStops: 0, eventsSeen: 0, eventsForwarded: 0, sessionsOpened: 1, sessionsClosed: 0, lastEventAt: null, lastError: null };
  }

  function applyStatus(mode) {
    currentStatus = mode;
    statusButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.status === mode)));
    if (!app) return;
    const now = Date.now();
    const stream = (phase, error = null) => ({ phase, since: now - 4000, lastOpenAt: phase === 'open' ? now - 4000 : now - 60000, error });
    if (mode === 'loading') {
      app.setNodeStatus({ phase: 'loading', status: null, statusAt: null, error: null, freshness: 'loading', stream: stream('connecting'), stats: stats('loading') });
    } else if (mode === 'ready') {
      app.setNodeStatus({ phase: 'ready', status: mockStatus, statusAt: now - 300, error: null, freshness: 'live', stream: stream('open'), stats: stats('ready') });
    } else if (mode === 'stale') {
      app.setNodeStatus({ phase: 'stale', status: mockStatus, statusAt: now - 12000, error: null, freshness: 'stale', stream: stream('reconnecting', 'harness: event stream dropped'), stats: stats('stale') });
    } else if (mode === 'error') {
      app.setNodeStatus({ phase: 'error', status: mockStatus, statusAt: now - 5000, error: 'harness: daemon status timed out', errorAt: now, freshness: 'stale', stream: stream('open'), stats: stats('error') });
    } else {
      app.setNodeStatus({ phase: 'closed', status: mockStatus, statusAt: now - 9000, error: null, freshness: 'stale', stream: stream('closed'), stats: stats('closed') });
    }
    stateOut.textContent = `模拟 ${mode} · 已挂载`;
    describeView();
  }

  function describeView() {
    const explore = viewState.pages?.explore ?? {};
    const contacts = viewState.pages?.contacts ?? {};
    viewOut.textContent = [
      `page=${viewState.page}`,
      `filter=${explore.filter}`,
      `exploreQuery=${JSON.stringify(explore.query ?? '')}`,
      `contactQuery=${JSON.stringify(contacts.query ?? '')}`,
    ].join(' · ');
  }

  function mountApp() {
    if (app) return;
    app = RamingaUI.mountRamingaApp(mount, {
      viewState,
      onRefresh() {
        log.push('refresh');
        applyStatus('loading');
        stateOut.textContent = '模拟刷新中…';
        setTimeout(() => applyStatus('ready'), 450);
      },
      onLoadContacts: async () => {
        log.push('contacts');
        return contacts;
      },
      onConnect: async (input) => {
        log.push('connect');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const value = String(input || '').trim();
        if (value.length === 0 || (!value.includes('/p2p/') && !value.startsWith('12D3'))) {
          return { ok: false, invalid: true, error: '请输入 Peer ID 或包含 /p2p/ 的完整地址。' };
        }
        const match = /\/p2p\/([A-Za-z0-9]+)$/.exec(value);
        const peerId = match ? match[1] : value;
        contacts = {
          ...contacts,
          at: Date.now(),
          total: contacts.total + 1,
          friends: [
            { peerId, name: '新的联系人', description: '', connection: 'connected', connections: 1, directConnections: 1, relayConnections: 0, paused: false },
            ...contacts.friends,
          ],
        };
        app?.setContacts(contacts);
        return {
          ok: true,
          peerId,
          route: 'direct',
          transport: 'tcp',
          reused: false,
          contact: { ok: true, found: true },
          status: { ok: true },
          contacts,
        };
      },
      onCheckContact: async () => ({ ok: true, found: true, contacts }),
      onShare: async () => ({ ...mockShare, at: Date.now() - 500 }),
      onLoadConversations: async () => conversationPage(),
      onLoadMessages: async (peerId, force) => { log.push(`messages:${peerId}:${force}`); return messagePage(peerId); },
      onLoadOlder: async (peerId) => messagePage(peerId, true),
      onSend: async (peerId, text, requestId) => {
        const row = {
          messageId: `harness-out-${Date.now()}-${tempSend += 1}`,
          peerId,
          direction: 'out',
          text,
          acked: true,
          createdAt: Date.now(),
          ackedAt: Date.now(),
          deliveryStatus: 'acked',
          deliveryError: '',
          origin: 'human',
          deliveryUpdatedAt: Date.now(),
          clientRequestId: requestId,
        };
        retained.set(peerId, [row, ...(retained.get(peerId) ?? [])]);
        app?.setConversations(conversationPage());
        return {
          ok: true, unknown: false, invalid: false, peerId, requestId,
          messageId: row.messageId, replayed: false, acked: true,
          deliveryStatus: 'acked', outboxStatus: 'acked', error: null, detail: null, at: Date.now(),
        };
      },
      onCancelOutbox: async (peerId, messageId) => {
        retained.set(peerId, (retained.get(peerId) ?? []).map((row) => (
          row.messageId === messageId ? { ...row, deliveryStatus: 'cancelled', deliveryError: 'cancelled by local user', acked: false } : row
        )));
        app?.setConversations(conversationPage());
        return { ok: true, messageId, status: 'cancelled', error: null, at: Date.now() };
      },
      onCopyText: async (text) => {
        if (globalThis.navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        return false;
      },
    });
    app.setContacts(contacts);
    app.setConversations(conversationPage());
    log.push('mount');
    stateOut.textContent = currentStatus === 'loading' ? '已挂载，等待模拟状态' : `模拟 ${currentStatus} · 已挂载`;
    describeView();
  }

  function destroyApp(reason) {
    if (!app) return;
    app.destroy();
    app = null;
    log.push(reason ?? 'destroy');
    stateOut.textContent = '已卸载';
    describeView();
  }

  statusButtons.forEach((button) => {
    button.addEventListener('click', () => applyStatus(button.dataset.status));
  });
  document.querySelector('#pushEvent').addEventListener('click', () => {
    if (!app) return;
    app.pushNodeEvent({
      id: `harness-${Date.now()}`,
      kind: 'connection',
      atUnixMs: Date.now(),
      summary: '模拟事件 · 连接变更',
    });
    stateOut.textContent = '已推送一条模拟事件';
  });
  document.querySelector('#remount').addEventListener('click', () => {
    destroyApp('remount:destroy');
    mountApp();
    applyStatus(currentStatus);
  });
  document.querySelector('#destroy').addEventListener('click', () => destroyApp('user-destroy'));
  document.querySelector('#reset').addEventListener('click', () => {
    destroyApp('reset:destroy');
    viewState = RamingaUI.createViewState();
    mountApp();
    applyStatus(currentStatus);
  });
  window.addEventListener('beforeunload', () => destroyApp('page-unload'));

  window.__ramingaHarness = {
    mountApp,
    destroyApp,
    applyStatus,
    get mounted() { return app !== null; },
    get viewState() { return viewState; },
    get logs() { return [...log]; },
    get currentStatus() { return currentStatus; },
  };

  mountApp();
  applyStatus('ready');
})();
