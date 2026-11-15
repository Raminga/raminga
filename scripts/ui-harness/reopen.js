// Simulated-host remount fixture for the shared Raminga UI.
//
// This is NOT DSH. It reproduces the ordering that matters for the real host
// panel: the React-owned host is removed from the document first, then the
// effect cleanup calls app.destroy(); a later native entry mounts a fresh host
// with the same adapter-owned viewState object. The product surface and the
// persisted message-ID anchors are the same bundle used by the DSH adapter.
(() => {
  const PEER = '12D3KooWReopenFixturePeer9yQ4Xz7mN2vK8sT5rB3cD6fG1hJ';
  const BASE = Date.UTC(2026, 10, 14, 2, 0, 0);
  const all = [];

  function add(id, text, at) {
    all.push({
      messageId: id,
      peerId: PEER,
      direction: 'in',
      text,
      acked: true,
      createdAt: at,
      ackedAt: null,
      deliveryStatus: 'received',
      deliveryError: '',
      origin: 'unknown',
      deliveryUpdatedAt: null,
      clientRequestId: '',
    });
  }

  for (let n = 1; n <= 7; n += 1) {
    add(`pre-${String(n).padStart(4, '0')}`, `更早保留消息 ${String(n).padStart(4, '0')}`, BASE - 10_000 + n * 10);
  }
  for (let n = 1; n <= 520; n += 1) {
    add(
      `seed-${String(n).padStart(4, '0')}`,
      `Codex 阶段5重挂验收 ${String(n).padStart(4, '0')}/0520：受控节点消息。`,
      BASE + n * 20,
    );
  }

  const viewState = RamingaUI.createViewState();
  const status = document.getElementById('fixtureState');
  const detachButton = document.getElementById('detachDestroy');
  const remountButton = document.getElementById('remount');
  let app = null;
  let host = null;
  let latestCalls = 0;
  let olderCalls = 0;
  let unmountCalls = 0;

  const friend = {
    peerId: PEER,
    name: '重挂验收 Peer',
    description: '仅用于模拟宿主卸载重挂',
    connection: 'connected',
    connections: 1,
    directConnections: 1,
    relayConnections: 0,
    paused: false,
  };

  function contactsPage() {
    return {
      friends: [friend], at: Date.now(), error: null, errorAt: null,
      freshness: 'live', connectionFreshness: 'live', total: 1,
    };
  }

  function conversationsPage() {
    const newest = all[all.length - 1];
    return {
      conversations: [{
        peerId: PEER, lastMessageId: newest.messageId, direction: newest.direction,
        preview: newest.text, lastAt: newest.createdAt, deliveryStatus: newest.deliveryStatus,
        origin: newest.origin, messageCount: all.length,
      }],
      at: Date.now(), error: null, errorAt: null, freshness: 'live',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0].createdAt,
        maxStoredMessages: 50000,
      },
    };
  }

  function latestPage() {
    const rows = all.slice(-100);
    return {
      peerId: PEER, messages: rows, at: Date.now(), error: null, errorAt: null,
      freshness: 'live', hasMore: all.length > rows.length,
      nextBefore: rows[0]?.messageId ?? '',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0]?.createdAt ?? null,
        maxStoredMessages: 50000,
      },
    };
  }

  function olderPage(before) {
    const index = all.findIndex((row) => row.messageId === before);
    if (index <= 0) return null;
    const start = Math.max(0, index - 100);
    const rows = all.slice(start, index);
    return {
      peerId: PEER, messages: rows, at: Date.now(), error: null, errorAt: null,
      freshness: 'live', hasMore: start > 0,
      nextBefore: start > 0 ? rows[0].messageId : '',
      retention: {
        retainedMessages: all.length,
        oldestRetainedAt: all[0]?.createdAt ?? null,
        maxStoredMessages: 50000,
      },
    };
  }

  function nodeStatus() {
    return {
      phase: 'ready',
      status: {
        peerId: PEER, nodeId: 'reopen-fixture-node', version: 'fixture', apiVersion: '3',
        connections: [{ peerId: PEER, route: 'direct', transport: 'tcp' }], peers: [],
      },
      statusAt: Date.now(), error: null, errorAt: null, freshness: 'live',
      stream: { phase: 'open', since: Date.now(), lastOpenAt: Date.now(), error: null },
      stats: { openSessions: 1, subscriptions: 1, streamActive: true, streamPhase: 'open' },
    };
  }

  function shadow() {
    return host?.shadowRoot ?? null;
  }

  function updateStatus() {
    const root = shadow();
    const anchored = viewState.pages.messages.chatAnchors[PEER];
    status.textContent = [
      'fixture: 527 条真实形状消息；模拟宿主挂载，非 DSH',
      `mounted=${app !== null}  latestCalls=${latestCalls}  olderCalls=${olderCalls}  unmountCalls=${unmountCalls}`,
      `anchor=${anchored ? `${anchored.messageId}@${anchored.offset}${anchored.atBottom ? ':bottom' : ''}` : '—'}`,
      `rows=${root ? root.querySelectorAll('#messageList .rm-message').length : 0}  scrollTop=${root ? root.querySelector('#messageList')?.scrollTop ?? 0 : 0}`,
      `restore=${root ? (root.querySelector('#messageRestoreNote')?.textContent || '—') : '—'}`,
    ].join('\n');
  }

  function mountPanel() {
    if (app !== null) throw new Error('panel is already mounted');
    host = document.createElement('div');
    host.id = 'panelHost';
    host.style.display = 'block';
    host.style.width = '100%';
    host.style.height = '100%';
    document.getElementById('mount').replaceChildren(host);
    app = RamingaUI.mountRamingaApp(host, {
      viewState,
      onLoadContacts: async () => contactsPage(),
      onLoadConversations: async () => conversationsPage(),
      onLoadMessages: async () => {
        latestCalls += 1;
        updateStatus();
        return latestPage();
      },
      onLoadOlder: async (_peerId, before) => {
        olderCalls += 1;
        updateStatus();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const value = olderPage(before);
        if (!value) throw new Error('fixture has no page for this cursor');
        return value;
      },
      onSend: async () => {
        throw new Error('this remount fixture does not send messages');
      },
    });
    app.setContacts(contactsPage());
    app.setConversations(conversationsPage());
    app.setNodeStatus(nodeStatus());
    // Simulate the real DSH runtime's open(): if the persisted view state still
    // has a conversation, read its bounded latest page after remount.
    if (viewState.pages.messages.peerId === PEER) app.setMessagePage(latestPage());
    updateStatus();
    return app;
  }

  async function detachThenDestroy() {
    if (app === null) return false;
    const oldApp = app;
    const oldHost = host;
    app = null;
    host = null;
    oldHost.remove();
    unmountCalls += 1;
    updateStatus();
    // Let the browser/JS task observe the detached DOM before cleanup, exactly
    // like a React effect cleanup that runs after the host subtree is removed.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    oldApp.destroy();
    updateStatus();
    return true;
  }

  function snapshot() {
    const root = shadow();
    if (!root) {
      return {
        mounted: false,
        anchor: viewState.pages.messages.chatAnchors[PEER] ?? null,
        draft: viewState.drafts[`chat:${PEER}`] ?? '',
        rows: [],
      };
    }
    const list = root.querySelector('#messageList');
    const rows = [...root.querySelectorAll('#messageList .rm-message')];
    const listRect = list?.getBoundingClientRect();
    return {
      mounted: app !== null,
      anchor: viewState.pages.messages.chatAnchors[PEER] ?? null,
      draft: root.querySelector('#messageInput')?.value ?? '',
      rows: rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          id: row.dataset.messageId,
          top: rect.top,
          offset: listRect ? rect.top - listRect.top : 0,
        };
      }),
      listScrollTop: list?.scrollTop ?? 0,
      listScrollHeight: list?.scrollHeight ?? 0,
      listClientHeight: list?.clientHeight ?? 0,
      listTop: listRect?.top ?? 0,
      listBottom: listRect?.bottom ?? 0,
      restoreNote: root.querySelector('#messageRestoreNote')?.textContent ?? '',
      restoreNoteHidden: root.querySelector('#messageRestoreNote')?.hidden ?? true,
      restoreActionHidden: root.querySelector('#messageRestoreAction')?.hidden ?? true,
      restoreActionText: root.querySelector('#messageRestoreAction')?.textContent ?? '',
      restoreLatestHidden: root.querySelector('#messageRestoreLatest')?.hidden ?? true,
      loadOlderHidden: root.querySelector('#loadOlder')?.hidden ?? true,
      activePeer: app?.activeConversationPeer?.() ?? '',
    };
  }

  detachButton.addEventListener('click', () => { void detachThenDestroy(); });
  remountButton.addEventListener('click', () => {
    if (app !== null) return;
    mountPanel();
    updateStatus();
  });

  mountPanel();
  updateStatus();

  window.__reopenFixture = {
    peer: PEER,
    get all() { return all; },
    get viewState() { return viewState; },
    get mounted() { return app !== null; },
    snapshot,
    latestPage,
    updateStatus,
  };
})();
