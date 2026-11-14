// Simulated-host pagination fixture for the shared Raminga UI.
//
// This is NOT DSH. It mounts the same browser bundle through the public
// mountRamingaApp API and supplies >500 persisted messages with:
//   - a 100-row latest page whose nextBefore changes on every auto refresh;
//   - a keyset older-page loader with a small RPC delay;
//   - continuous latest refreshes and occasional new inbound rows;
//   - an explicit one-shot failure control for retry evidence.
// The fixed message IDs and equal-timestamp pairs are stable keys, not fake
// success signals. All status text stays outside the product surface.
(() => {
  const PEER = '12D3KooWPaginationFixturePeer9yQ4Xz7mN2vK8sT5rB3cD6fG1hJ';
  const BASE = Date.UTC(2026, 10, 14, 1, 0, 0);
  const all = [];
  let nextLive = 0;

  function add(id, text, at, direction = 'in') {
    all.push({
      messageId: id,
      peerId: PEER,
      direction,
      text,
      acked: true,
      createdAt: at,
      ackedAt: direction === 'out' ? at + 1 : null,
      deliveryStatus: direction === 'out' ? 'acked' : 'received',
      deliveryError: '',
      origin: direction === 'out' ? 'human' : 'unknown',
      deliveryUpdatedAt: null,
      clientRequestId: direction === 'out' ? `fixture-${id}` : '',
    });
  }

  // Seven rows retained before the 520-message acceptance stream.
  for (let n = 1; n <= 7; n += 1) {
    add(`pre-${String(n).padStart(4, '0')}`, `更早保留消息 ${String(n).padStart(4, '0')}`, BASE - 10_000 + n * 10);
  }
  // 520 messages, paired into equal timestamps so message ID must break ties.
  // The stream is oldest-first; UI sort and merge must still be stable.
  for (let n = 1; n <= 520; n += 1) {
    add(
      `seed-${String(n).padStart(4, '0')}`,
      `Codex 历史分页验收 ${String(n).padStart(4, '0')}/0520：受控节点消息。`,
      BASE + Math.floor((n - 1) / 2) * 260,
    );
  }

  const state = {
    latestCalls: 0,
    olderCalls: 0,
    olderCursors: [],
    failures: 0,
    consistencyErrors: 0,
    paused: false,
    failNextOlder: false,
    olderFault: '',
    initialFault: '',
    autoRefresh: 0,
    liveRows: 0,
    lastError: '',
  };

  const fixtureOut = document.getElementById('fixtureState');
  const toggle = document.getElementById('toggleRefresh');
  const failNext = document.getElementById('failNext');
  const stallOlder = document.getElementById('stallOlder');
  const emptyCursorOlder = document.getElementById('emptyCursorOlder');
  const breakInitial = document.getElementById('breakInitial');
  let app = null;
  let autoTimer = null;

  const friend = {
    peerId: PEER,
    name: '分页夹具',
    description: '仅用于浏览器分页自测',
    connection: 'connected',
    connections: 1,
    directConnections: 1,
    relayConnections: 0,
    paused: false,
  };

  function contactsPage() {
    return {
      friends: [friend],
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      connectionFreshness: 'live',
      total: 1,
    };
  }

  function conversationsPage() {
    const newest = all[all.length - 1];
    return {
      conversations: [{
        peerId: PEER,
        lastMessageId: newest.messageId,
        direction: newest.direction,
        preview: newest.text,
        lastAt: newest.createdAt,
        deliveryStatus: newest.deliveryStatus,
        origin: newest.origin,
        messageCount: all.length,
      }],
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0].createdAt,
        maxStoredMessages: 50000,
      },
    };
  }

  function latestPage(overrides = {}) {
    const rows = all.slice(-100);
    return {
      peerId: PEER,
      messages: rows,
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      hasMore: all.length > rows.length,
      nextBefore: rows[0]?.messageId ?? '',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0]?.createdAt ?? null,
        maxStoredMessages: 50000,
      },
      ...overrides,
    };
  }

  function olderPage(before) {
    const index = all.findIndex((row) => row.messageId === before);
    if (index <= 0) return null;
    const start = Math.max(0, index - 100);
    const rows = all.slice(start, index);
    return {
      peerId: PEER,
      messages: rows,
      at: Date.now(),
      error: null,
      errorAt: null,
      freshness: 'live',
      hasMore: start > 0,
      nextBefore: start > 0 ? rows[0].messageId : '',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0]?.createdAt ?? null,
        maxStoredMessages: 50000,
      },
    };
  }

  function addLiveRow() {
    nextLive += 1;
    state.liveRows += 1;
    const id = `live-${String(nextLive).padStart(4, '0')}`;
    add(id, `分页期间新收到的消息 ${String(nextLive).padStart(4, '0')}`, Date.now());
    return id;
  }

  function refreshLatest() {
    if (!app || state.paused) return;
    if (app.activeConversationPeer() !== PEER) return;
    state.autoRefresh += 1;
    // Every refresh moves the latest page's own nextBefore, exactly like the
    // real daemon page. The UI must ignore it after its older window starts.
    app.setMessagePage(latestPage());
    if (state.autoRefresh % 4 === 0) addLiveRow();
    updateStatus();
  }

  function updateStatus() {
    const rendered = host.shadowRoot
      ? host.shadowRoot.querySelectorAll('#messageList .rm-message').length
      : 0;
    fixtureOut.textContent = [
      `fixture: 527 seed/pre rows + ${state.liveRows} live`,
      `rendered=${rendered ?? '—'}  olderCalls=${state.olderCalls}  latestCalls=${state.latestCalls}  autoRefresh=${state.autoRefresh}`,
      `olderCursors=${state.olderCursors.length > 0 ? state.olderCursors.join(',') : '—'}`,
      `failures=${state.failures}  consistencyErrors=${state.consistencyErrors}  paused=${state.paused}`,
      `failNext=${state.failNextOlder}  olderFault=${state.olderFault || '—'}  initialFault=${state.initialFault || '—'}`,
    ].join('\n');
  }

  function startAutoRefresh() {
    if (autoTimer !== null) return;
    autoTimer = setInterval(refreshLatest, 300);
  }

  toggle.addEventListener('click', () => {
    state.paused = !state.paused;
    toggle.textContent = state.paused ? '恢复自动刷新' : '暂停自动刷新';
    updateStatus();
  });
  failNext.addEventListener('click', () => {
    state.failNextOlder = true;
    updateStatus();
  });
  stallOlder.addEventListener('click', () => {
    state.olderFault = 'stall';
    updateStatus();
  });
  emptyCursorOlder.addEventListener('click', () => {
    state.olderFault = 'empty';
    updateStatus();
  });
  breakInitial.addEventListener('click', () => {
    state.initialFault = 'missing';
    updateStatus();
  });

  const host = document.getElementById('mount');
  app = RamingaUI.mountRamingaApp(host, {
    viewState: RamingaUI.createViewState(),
    onLoadContacts: async () => contactsPage(),
    onLoadConversations: async () => conversationsPage(),
    onLoadMessages: async () => {
      state.latestCalls += 1;
      updateStatus();
      if (state.initialFault === 'missing') {
        state.initialFault = '';
        state.consistencyErrors += 1;
        // hasMore=true without a cursor is a consistency error, not an end.
        return latestPage({ messages: [], hasMore: true, nextBefore: '' });
      }
      return latestPage();
    },
    onSend: async (peerId, text, requestId) => {
      const id = `out-${Date.now()}`;
      add(id, text, Date.now(), 'out');
      state.autoRefresh += 1;
      return {
        ok: true, unknown: false, invalid: false, peerId, requestId, messageId: id,
        replayed: false, acked: true, deliveryStatus: 'acked', outboxStatus: 'acked',
        error: null, detail: null, at: Date.now(),
      };
    },
    onLoadOlder: async (_peerId, before) => {
      state.olderCalls += 1;
      state.olderCursors.push(before);
      updateStatus();
      await new Promise((resolve) => setTimeout(resolve, 140));
      if (state.failNextOlder) {
        state.failNextOlder = false;
        state.failures += 1;
        state.lastError = '夹具模拟读取更早消息失败';
        updateStatus();
        throw new Error(state.lastError);
      }
      if (state.olderFault !== '') {
        const fault = state.olderFault;
        state.olderFault = '';
        state.consistencyErrors += 1;
        updateStatus();
        return {
          ...latestPage(),
          messages: [],
          hasMore: true,
          // 'stall' repeats the current cursor; 'empty' omits it entirely.
          nextBefore: fault === 'stall' ? before : '',
        };
      }
      const value = olderPage(before);
      if (!value) throw new Error('夹具没有该游标的更早页');
      return value;
    },
  });
  app.setContacts(contactsPage());
  app.setConversations(conversationsPage());
  app.setNodeStatus({
    phase: 'ready',
    status: {
      peerId: PEER,
      nodeId: 'pagination-fixture-node',
      version: 'fixture',
      apiVersion: '3',
      connections: [{ peerId: PEER, route: 'direct', transport: 'tcp' }],
      peers: [],
    },
    statusAt: Date.now(),
    error: null,
    errorAt: null,
    freshness: 'live',
    stream: { phase: 'open', since: Date.now(), lastOpenAt: Date.now(), error: null },
    stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
  });
  startAutoRefresh();
  updateStatus();

  window.__paginationFixture = {
    peer: PEER,
    get all() { return all; },
    get state() { return state; },
    get mounted() { return app !== null; },
    renderedMessageCount() {
      const shadow = host.shadowRoot;
      return shadow ? shadow.querySelectorAll('#messageList .rm-message').length : 0;
    },
    snapshot() {
      const shadow = host.shadowRoot;
      if (!shadow) return { rows: [] };
      const rows = [...shadow.querySelectorAll('#messageList .rm-message')];
      return {
        total: all.length,
        rows: rows.map((row) => ({
          id: row.dataset.messageId,
          text: row.querySelector('.rm-message-bubble')?.textContent ?? '',
        })),
        loadOlderHidden: shadow.querySelector('#loadOlder')?.hidden ?? true,
        loadOlderText: shadow.querySelector('#loadOlder')?.textContent ?? '',
        olderError: shadow.querySelector('#messageOlderError')?.textContent ?? '',
        olderErrorHidden: shadow.querySelector('#messageOlderError')?.hidden ?? true,
        historyRetryHidden: shadow.querySelector('#messageHistoryRetry')?.hidden ?? true,
        historyRetryText: shadow.querySelector('#messageHistoryRetry')?.textContent ?? '',
        stateHidden: shadow.querySelector('#messageState')?.hidden ?? true,
        stateTitle: shadow.querySelector('#messageStateTitle')?.textContent ?? '',
        stateBody: shadow.querySelector('#messageStateBody')?.textContent ?? '',
        restoreNote: shadow.querySelector('#messageRestoreNote')?.textContent ?? '',
        restoreNoteHidden: shadow.querySelector('#messageRestoreNote')?.hidden ?? true,
        draft: shadow.querySelector('#messageInput')?.value ?? '',
        listTop: shadow.querySelector('#messageList')?.getBoundingClientRect().top ?? 0,
        listScrollTop: shadow.querySelector('#messageList')?.scrollTop ?? 0,
      };
    },
    setPaused(value) {
      state.paused = value === true;
      toggle.textContent = state.paused ? '恢复自动刷新' : '暂停自动刷新';
      updateStatus();
    },
    runLatestRefresh() {
      if (!app || app.activeConversationPeer() !== PEER) return false;
      app.setMessagePage(latestPage());
      state.autoRefresh += 1;
      updateStatus();
      return true;
    },
    failNextOlder() {
      state.failNextOlder = true;
      updateStatus();
    },
    stallNextOlder() {
      state.olderFault = 'stall';
      updateStatus();
    },
    emptyCursorNextOlder() {
      state.olderFault = 'empty';
      updateStatus();
    },
    breakNextInitial() {
      state.initialFault = 'missing';
      updateStatus();
    },
  };
})();
