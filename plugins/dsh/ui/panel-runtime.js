// Host-agnostic lifecycle driver for one DSH main-panel lease.
//
// This file has no React and no DOM dependency. The DSH client adapter mounts
// the shared UI and calls this runtime; Node tests call the same code with fake
// timers/RPC/app objects. It owns exactly one panel lease and one Events
// subscription per mount:
//   start -> open (once) -> poll -> dispose -> close (best effort, repeated)
// The open result can be lost or rejected even though the host created a lease.
// A close is therefore attempted as soon as one was requested, and once more
// after a pending open settles (success or failure). This ordering covers both
// "close arrives before the host handles open" and "close arrives while open is
// in flight"; retry timers are cleared instead of relying on the idle reaper.

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function remoteValue(result) {
  if (result === null || typeof result !== 'object') throw new Error('Raminga Remote returned no result');
  if (result.ok !== true) throw new Error(result.error?.message ?? 'Raminga Remote failed');
  return result.value;
}

const defaultTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Clipboard access belongs to the host adapter. The shared UI only receives
 * this narrow function and shows a manual selection fallback if it rejects.
 */
async function defaultCopyText(text) {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('clipboard is unavailable');
  }
  await clipboard.writeText(text);
  return true;
}

/**
 * @param {object} options
 * @param {{open: Function, poll: Function, refresh: Function, close: Function,
 *   contacts?: Function, connect?: Function, checkContact?: Function, share?: Function}} options.rpc
 * @param {(host: HTMLElement, mountOptions: object) => object} options.mount
 * @param {object} options.viewState
 * @param {(snapshot: object) => string} options.resolvePhase
 * @param {string} options.sessionId
 * @param {(error: Error) => void} options.onBootError
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {{setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {number} [options.pollMs]
 * @param {number} [options.retryMs]
 * @param {number} [options.contactsPollMs]
 * @param {number} [options.conversationsPollMs]
 * @param {number} [options.messagesPollMs]
 * @param {(text: string) => Promise<boolean>} [options.copyText]
 */
export function createPanelRuntime({
  rpc,
  mount,
  viewState,
  resolvePhase,
  sessionId,
  onBootError,
  logger = console,
  timers = defaultTimers,
  pollMs = 1000,
  retryMs = 3000,
  contactsPollMs = 4000,
  conversationsPollMs = 4000,
  messagesPollMs = 3000,
  activityPollMs = 1500,
  copyText = defaultCopyText,
}) {
  let disposed = false;
  let openAttempted = false;
  let closeRequested = false;
  let leaseOpen = false;
  let leaseClosed = false;
  let closeInFlight = false;
  let closeQueued = false;
  let pollTimer = null;
  let retryTimer = null;
  let contactsTimer = null;
  let conversationsTimer = null;
  let messagesTimer = null;
  let eventRefreshTimer = null;
  let activityTimer = null;
  let activityInFlight = false;
  // A disposed runtime must ignore late activity reads even if a host promise
  // resolves after its timers were cleared.
  let activityGeneration = 0;
  let inFlight = false;
  let contactsInFlight = false;
  let contactsQueuedForce = false;
  let conversationsInFlight = false;
  let conversationsQueuedForce = false;
  // Latest refreshes and user-requested older pages are independent streams.
  // A background refresh must never overwrite a queued older request, and each
  // older call gets its own promise so the UI can keep an honest busy/error
  // state instead of silently dropping a click.
  const latestMessageReads = new Map();
  const olderMessageReads = new Map();
  let lastStreamPhase = null;
  let leaseReady = false;
  let app = null;

  function closeLease() {
    if (!openAttempted) return;
    closeRequested = true;
    queueClose();
  }

  function queueClose() {
    if (closeInFlight) {
      // A second close is required when dispose() raced with an unsettled
      // open: the first close may have reached the host before open did.
      closeQueued = true;
      return;
    }
    closeInFlight = true;
    let result;
    try {
      result = rpc.close(sessionId);
    } catch (error) {
      closeInFlight = false;
      logger.warn?.('[raminga-ui] panel close failed', errorText(error));
      return;
    }
    Promise.resolve(result).then((value) => {
      const stats = remoteValue(value);
      leaseClosed = true;
      logger.info?.('[raminga-ui] panel closed', JSON.stringify(stats));
    }).catch((error) => {
      logger.warn?.('[raminga-ui] panel close failed', errorText(error));
    }).finally(() => {
      closeInFlight = false;
      if (closeQueued) {
        closeQueued = false;
        queueClose();
      }
    });
  }

  function showError(error) {
    if (disposed || app === null) return;
    // Keep the last Status in the view for its timestamp, but never present it
    // as live after a failed refresh; the bridge supplies statusAt/freshness
    // on the next successful poll.
    app.setNodeStatus({
      phase: 'error',
      error: errorText(error),
      errorAt: Date.now(),
      freshness: 'stale',
    });
  }

  function apply(snapshot) {
    if (disposed || app === null) return;
    const streamPhase = snapshot.stream?.phase ?? snapshot.stats?.streamPhase ?? null;
    const reopened = streamPhase === 'open' && lastStreamPhase !== null && lastStreamPhase !== 'open';
    lastStreamPhase = streamPhase;
    app.setNodeStatus({
      phase: resolvePhase(snapshot),
      status: snapshot.status,
      statusAt: snapshot.statusAt,
      error: snapshot.error,
      errorAt: snapshot.errorAt,
      freshness: snapshot.freshness,
      stream: snapshot.stream,
      stats: snapshot.stats,
    });
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    for (const event of events) app.pushNodeEvent(event);
    app.setStats(snapshot.stats);
    if (reopened && typeof rpc.contacts === 'function') void loadContacts(true);
    if (reopened) void loadConversations(true);
    if (events.some((event) => event?.kind === 'chat' || event?.kind === 'ack')) {
      scheduleConversationRefresh();
    }
    if (reopened) {
      const peer = activeConversationPeer();
      if (peer.length > 0) void loadMessages(peer, { force: true });
    }
  }

  /**
   * Read the daemon-backed contact list. A failed read is shown as an error
   * while keeping any previous rows; it is never turned into an empty list.
   */
  async function loadContacts(force) {
    if (disposed || app === null || typeof rpc.contacts !== 'function') return null;
    if (contactsInFlight) {
      if (force === true) contactsQueuedForce = true;
      return null;
    }
    contactsInFlight = true;
    try {
      const value = remoteValue(await rpc.contacts(sessionId, force === true));
      if (disposed || app === null) return null;
      app.setContacts(value);
      return value;
    } catch (error) {
      if (!disposed && app !== null) app.setContactsError(errorText(error));
      return null;
    } finally {
      contactsInFlight = false;
      if (contactsQueuedForce && !disposed) {
        contactsQueuedForce = false;
        void loadContacts(true);
      }
    }
  }

  function activeConversationPeer() {
    if (app === null || typeof app.activeConversationPeer !== 'function') return '';
    const peer = app.activeConversationPeer();
    return typeof peer === 'string' ? peer : '';
  }

  /** Read Peer-grouped conversation summaries; errors keep the last rows. */
  async function loadConversations(force) {
    if (disposed || app === null || typeof rpc.conversations !== 'function') return null;
    if (conversationsInFlight) {
      if (force === true) conversationsQueuedForce = true;
      return null;
    }
    conversationsInFlight = true;
    try {
      const value = remoteValue(await rpc.conversations(sessionId, force === true));
      if (disposed || app === null) return null;
      if (typeof app.setConversations === 'function') app.setConversations(value);
      return value;
    } catch (error) {
      if (!disposed && app !== null && typeof app.setConversationsError === 'function') {
        app.setConversationsError(errorText(error));
      }
      return null;
    } finally {
      conversationsInFlight = false;
      if (conversationsQueuedForce && !disposed) {
        conversationsQueuedForce = false;
        void loadConversations(true);
      }
    }
  }

  function latestReadFor(peer) {
    let state = latestMessageReads.get(peer);
    if (!state) {
      state = { running: null, queuedForce: false };
      latestMessageReads.set(peer, state);
    }
    return state;
  }

  function olderReadFor(peer) {
    let state = olderMessageReads.get(peer);
    if (!state) {
      state = { running: false, queue: [] };
      olderMessageReads.set(peer, state);
    }
    return state;
  }

  /**
   * Read the latest page. At most one request per Peer is in flight; a forced
   * follow-up is coalesced after it. This stream never touches the older
   * cursor and never replaces a user-requested older page.
   */
  function loadLatestMessages(peer, force) {
    const state = latestReadFor(peer);
    if (state.running !== null) {
      if (force === true) state.queuedForce = true;
      return state.running;
    }
    state.running = (async () => {
      try {
        const value = remoteValue(await rpc.messages(sessionId, peer, '', force === true));
        if (disposed || app === null) return null;
        if (typeof app.setMessagePage === 'function') app.setMessagePage(value);
        return value;
      } catch (error) {
        if (!disposed && app !== null && typeof app.setMessagesError === 'function') {
          app.setMessagesError(peer, errorText(error));
        }
        return null;
      }
    })();
    const settle = () => {
      state.running = null;
      if (state.queuedForce && !disposed) {
        state.queuedForce = false;
        void loadLatestMessages(peer, true);
      }
    };
    state.running.then(settle, settle);
    return state.running;
  }

  function pumpOlderMessages(peer) {
    const state = olderReadFor(peer);
    if (state.running || state.queue.length === 0) return;
    const entry = state.queue.shift();
    state.running = true;
    (async () => {
      try {
        const value = remoteValue(await rpc.messages(sessionId, peer, entry.before, true));
        if (disposed || app === null) {
          entry.resolve(null);
          return;
        }
        // The app receives the generation token it supplied. A close/reopen of
        // the same Peer increments that generation, so a late older page can
        // no longer move the new visit's cursor or scroll position.
        if (typeof app.appendMessagePage === 'function') {
          app.appendMessagePage(value, entry.token === undefined ? undefined : { token: entry.token });
        }
        entry.resolve(value);
      } catch (error) {
        entry.reject(error);
      } finally {
        state.running = false;
        if (!disposed) pumpOlderMessages(peer);
      }
    })();
  }

  function loadOlderMessages(peer, before, token) {
    return new Promise((resolve, reject) => {
      olderReadFor(peer).queue.push({ before, token, resolve, reject });
      pumpOlderMessages(peer);
    });
  }

  /**
   * Read one conversation page. `before` loads strictly older retained rows and
   * is queued per Peer (never overwritten by a latest refresh); no `before`
   * loads the latest page through the coalesced latest channel.
   */
  function loadMessages(peerId, { before = '', force = false, token } = {}) {
    if (disposed || app === null || typeof rpc.messages !== 'function') return Promise.resolve(null);
    const peer = typeof peerId === 'string' ? peerId : '';
    if (peer.length === 0) return Promise.resolve(null);
    if (before.length > 0) return loadOlderMessages(peer, before, token);
    return loadLatestMessages(peer, force === true);
  }

  async function sendMessage(peerId, text, requestId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.send !== 'function') throw new Error('Raminga send is unavailable');
    const value = remoteValue(await rpc.send(sessionId, peerId, text, requestId));
    if (!disposed) {
      await loadMessages(peerId, { force: true });
      await loadConversations(true);
    }
    return value;
  }

  async function cancelMessage(peerId, messageId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.cancelOutbox !== 'function') throw new Error('Raminga outbox cancel is unavailable');
    const value = remoteValue(await rpc.cancelOutbox(sessionId, messageId));
    if (!disposed) await loadMessages(peerId, { force: true });
    return value;
  }

  /** Coalesce a burst of chat/ACK events into one bounded snapshot refresh. */
  function scheduleConversationRefresh() {
    if (disposed || app === null || eventRefreshTimer !== null) return;
    eventRefreshTimer = timers.setTimeout(() => {
      eventRefreshTimer = null;
      if (disposed || app === null) return;
      void loadConversations(true);
      const peer = activeConversationPeer();
      if (peer.length > 0) void loadMessages(peer, { force: true });
    }, 120);
  }

  async function connect(input) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.connect !== 'function') throw new Error('Raminga connect is unavailable');
    const value = remoteValue(await rpc.connect(sessionId, input));
    if (!disposed && app !== null && value?.contacts) app.setContacts(value.contacts);
    return value;
  }

  async function checkContact(peerId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.checkContact !== 'function') throw new Error('Raminga contact check is unavailable');
    const value = remoteValue(await rpc.checkContact(sessionId, peerId));
    if (!disposed && app !== null && value?.contacts) app.setContacts(value.contacts);
    return value;
  }

  async function share() {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.share !== 'function') throw new Error('Raminga share is unavailable');
    return remoteValue(await rpc.share(sessionId));
  }

  // Stage-6 reads are explicit page/filter actions. They are not polled, so a
  // closed panel cannot leave a timer behind; every wrapper checks disposal
  // before returning a late value to the app.
  async function readDiscoveries(familiar, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.discoveries !== 'function') throw new Error('Raminga discovery is unavailable');
    return remoteValue(await rpc.discoveries(sessionId, familiar === true, force === true));
  }

  async function refreshDiscoveries(familiar) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.refreshDiscoveries !== 'function') throw new Error('Raminga discovery refresh is unavailable');
    return remoteValue(await rpc.refreshDiscoveries(sessionId, familiar === true));
  }

  async function readDiscoveryContent(id) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.discoveryContent !== 'function') throw new Error('Raminga content is unavailable');
    return remoteValue(await rpc.discoveryContent(sessionId, id));
  }

  async function markConversationRead(peerId, messageId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.markRead !== 'function') throw new Error('Raminga read cursor is unavailable');
    return remoteValue(await rpc.markRead(sessionId, peerId, messageId));
  }

  async function readFavorites(before, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.favorites !== 'function') throw new Error('Raminga favorites are unavailable');
    return remoteValue(await rpc.favorites(sessionId, before || '', force === true));
  }

  async function setFavorite(peerId, filePath, sha256, title, favorite) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.setFavorite !== 'function') throw new Error('Raminga favorites are unavailable');
    return remoteValue(await rpc.setFavorite(sessionId, peerId, filePath, sha256, title, favorite === true));
  }

  async function readPeerDiscoveries(peerId, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerDiscoveries !== 'function') throw new Error('Raminga peer discoveries are unavailable');
    return remoteValue(await rpc.peerDiscoveries(sessionId, peerId, force === true));
  }

  async function readContactMemory(peerId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.contactMemory !== 'function') throw new Error('Raminga contact memory is unavailable');
    return remoteValue(await rpc.contactMemory(sessionId, peerId));
  }

  async function saveContactImpression(input) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.saveContactImpression !== 'function') throw new Error('Raminga contact memory editing is unavailable');
    return remoteValue(await rpc.saveContactImpression(sessionId, input));
  }

  async function readHumanOutbound(force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.humanOutbound !== 'function') throw new Error('Raminga relations are unavailable');
    return remoteValue(await rpc.humanOutbound(sessionId, force === true));
  }

  async function readMine(force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.mine !== 'function') throw new Error('Raminga local profile is unavailable');
    return remoteValue(await rpc.mine(sessionId, force === true));
  }

  async function readPeerProfile(peerId, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerProfile !== 'function') throw new Error('Raminga peer profile is unavailable');
    return remoteValue(await rpc.peerProfile(sessionId, peerId, force === true));
  }

  async function readPeerFriends(peerId, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerFriends !== 'function') throw new Error('Raminga peer address book is unavailable');
    return remoteValue(await rpc.peerFriends(sessionId, peerId, force === true));
  }

  async function readContactProjection() {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.contactProjection !== 'function') throw new Error('Raminga contact projection is unavailable');
    return remoteValue(await rpc.contactProjection(sessionId));
  }

  async function readPeerManifest(peerId, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerManifest !== 'function') throw new Error('Raminga peer manifest is unavailable');
    return remoteValue(await rpc.peerManifest(sessionId, peerId, force === true));
  }

  async function readPeerFilePreview(peerId, filePath, sha256, sizeBytes) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerFilePreview !== 'function') throw new Error('Raminga peer content is unavailable');
    return remoteValue(await rpc.peerFilePreview(sessionId, peerId, filePath, sha256, sizeBytes));
  }

  async function readPeerPostMeta(peerId, filePath, sha256, sizeBytes) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerPostMeta !== 'function') throw new Error('Raminga post image metadata is unavailable');
    return remoteValue(await rpc.peerPostMeta(sessionId, peerId, filePath, sha256, sizeBytes));
  }

  async function readMineFilePreview(filePath, sha256, sizeBytes) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.mineFilePreview !== 'function') throw new Error('Raminga local public content is unavailable');
    return remoteValue(await rpc.mineFilePreview(sessionId, filePath, sha256, sizeBytes));
  }

  async function readPeerNodeInfo(peerId, force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.peerNodeInfo !== 'function') throw new Error('Raminga peer node information is unavailable');
    return remoteValue(await rpc.peerNodeInfo(sessionId, peerId, force === true));
  }

  async function revealDiscovery(id) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.revealDiscovery !== 'function') throw new Error('Raminga reveal is unavailable');
    return remoteValue(await rpc.revealDiscovery(sessionId, id));
  }

  async function revealFile(subject, peerId, filePath, sha256, sizeBytes) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.revealFile !== 'function') throw new Error('Raminga file reveal is unavailable');
    return remoteValue(await rpc.revealFile(sessionId, subject, peerId, filePath, sha256, sizeBytes));
  }

  async function readBootstrap() {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.bootstrap !== 'function') throw new Error('Raminga bootstrap view is unavailable');
    return remoteValue(await rpc.bootstrap(sessionId));
  }

  async function addBootstrap(shareCode) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.addBootstrap !== 'function') throw new Error('Raminga bootstrap edit is unavailable');
    return remoteValue(await rpc.addBootstrap(sessionId, shareCode));
  }

  async function removeBootstrap(peerId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.removeBootstrap !== 'function') throw new Error('Raminga bootstrap edit is unavailable');
    return remoteValue(await rpc.removeBootstrap(sessionId, peerId));
  }

  async function readJourney(force) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.journey !== 'function') throw new Error('Raminga journey is unavailable');
    return remoteValue(await rpc.journey(sessionId, force === true));
  }

  async function readPublicDraft(draftId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.publicDraft !== 'function') throw new Error('Raminga public draft read is unavailable');
    return remoteValue(await rpc.publicDraft(sessionId, draftId));
  }

  async function readPublicDrafts(kind) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.publicDrafts !== 'function') throw new Error('Raminga public draft list is unavailable');
    return remoteValue(await rpc.publicDrafts(sessionId, kind));
  }

  async function savePublicDraft(input) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.savePublicDraft !== 'function') throw new Error('Raminga public draft save is unavailable');
    return remoteValue(await rpc.savePublicDraft(sessionId, input));
  }

  async function putPublicDraftImage(draftId, role, filename, dataBase64) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.putPublicDraftImage !== 'function') throw new Error('Raminga draft image upload is unavailable');
    return remoteValue(await rpc.putPublicDraftImage(sessionId, draftId, role, filename, dataBase64));
  }

  async function readPublicDraftAsset(draftId, assetId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.publicDraftAsset !== 'function') throw new Error('Raminga private draft image is unavailable');
    return remoteValue(await rpc.publicDraftAsset(sessionId, draftId, assetId));
  }

  async function importPublicPost(filePath) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.importPublicPost !== 'function') throw new Error('Raminga post editing is unavailable');
    return remoteValue(await rpc.importPublicPost(sessionId, filePath));
  }

  async function deletePublicDraft(draftId, expectedRevision) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.deletePublicDraft !== 'function') throw new Error('Raminga draft delete is unavailable');
    return remoteValue(await rpc.deletePublicDraft(sessionId, draftId, expectedRevision));
  }

  async function publishPublicDraft(draftId, expectedRevision, expectedPublishedSha256, requestId = '') {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.publishPublicDraft !== 'function') throw new Error('Raminga publication is unavailable');
    const result = remoteValue(await rpc.publishPublicDraft(sessionId, draftId, expectedRevision, expectedPublishedSha256, requestId));
    if (result && (result.status === 'published' || result.status === 'already_published' || result.status === 'partial')) {
      // The daemon already returned the same-snapshot files/digest. Refresh the
      // local published list only after that response, never before.
      if (typeof app?.reloadMine === 'function') void app.reloadMine();
    }
    return result;
  }

  async function savePrivateAgent(field, content, expectedSha256) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.savePrivateAgent !== 'function') throw new Error('Raminga private Agent save is unavailable');
    return remoteValue(await rpc.savePrivateAgent(sessionId, field, content, expectedSha256));
  }

  async function readLocatedMessage(peerId, messageId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.locateMessage !== 'function') throw new Error('Raminga message lookup is unavailable');
    return remoteValue(await rpc.locateMessage(sessionId, peerId, messageId));
  }

  async function setFriendName(peerId, name) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.setFriendName !== 'function') throw new Error('Raminga contact editing is unavailable');
    return remoteValue(await rpc.setFriendName(sessionId, peerId, name));
  }

  async function setFriendDescription(peerId, description) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.setFriendDescription !== 'function') throw new Error('Raminga contact editing is unavailable');
    return remoteValue(await rpc.setFriendDescription(sessionId, peerId, description));
  }

  /**
   * Passive activity read. This never writes a terminal event; the host store
   * only records real tool execute calls. A failed read clears stale live
   * marks in the app instead of leaving the previous "running" card.
   */
  async function loadActivity(force = false) {
    if (disposed || app === null || typeof rpc.activity !== 'function') return null;
    if (activityInFlight) return null;
    activityInFlight = true;
    const generation = activityGeneration;
    try {
      const value = remoteValue(await rpc.activity(sessionId, 100));
      if (disposed || generation !== activityGeneration || app === null) return null;
      if (typeof app.setActivity === 'function') app.setActivity(value);
      return value;
    } catch (error) {
      if (!disposed && generation === activityGeneration && app !== null && typeof app.setActivityError === 'function') {
        app.setActivityError(errorText(error));
      }
      return null;
    } finally {
      activityInFlight = false;
      void force;
    }
  }

  async function readActivityDetail(operationId) {
    if (disposed) throw new Error('Raminga panel is closed');
    if (typeof rpc.activityDetail !== 'function') throw new Error('Raminga activity detail is unavailable');
    return remoteValue(await rpc.activityDetail(operationId));
  }

  async function open() {
    if (disposed) return;
    openAttempted = true;
    try {
      const snapshot = remoteValue(await rpc.open(sessionId));
      leaseOpen = true;
      if (disposed || closeRequested) {
        // A close was requested while open was pending. The host may have
        // created the lease after that close reached it, so close it again now
        // that the open result is known.
        closeLease();
        return;
      }
      apply(snapshot);
      if (!leaseReady) {
        leaseReady = true;
        // Page-specific reads (discoveries/mine/journey) must wait for the
        // bridge lease; calling them before open would return "lease not open".
        app?.onLeaseReady?.();
      }
      if (pollTimer === null) pollTimer = timers.setInterval(() => { void poll(false); }, pollMs);
      if (contactsTimer === null && typeof rpc.contacts === 'function') {
        contactsTimer = timers.setInterval(() => { void loadContacts(false); }, contactsPollMs);
      }
      if (conversationsTimer === null && typeof rpc.conversations === 'function') {
        conversationsTimer = timers.setInterval(() => { void loadConversations(false); }, conversationsPollMs);
      }
      if (messagesTimer === null && typeof rpc.messages === 'function') {
        messagesTimer = timers.setInterval(() => {
          const peer = activeConversationPeer();
          if (peer.length > 0) void loadMessages(peer, { force: false });
        }, messagesPollMs);
      }
      if (activityTimer === null && typeof rpc.activity === 'function') {
        activityTimer = timers.setInterval(() => { void loadActivity(false); }, activityPollMs);
      }
      if (typeof rpc.contacts === 'function') void loadContacts(false);
      void loadConversations(false);
      if (typeof rpc.activity === 'function') void loadActivity(true);
      const restoredPeer = activeConversationPeer();
      if (restoredPeer.length > 0) void loadMessages(restoredPeer, { force: true });
    } catch (error) {
      if (disposed || closeRequested) {
        // A failed/lost open can still have created a host-side lease. Re-issue
        // close after the open has settled so cleanup does not wait for idle.
        closeLease();
        return;
      }
      showError(error);
      if (retryTimer === null) {
        retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          void open();
        }, retryMs);
      }
    }
  }

  async function poll(force) {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const method = force ? rpc.refresh : rpc.poll;
      const snapshot = remoteValue(await method(sessionId));
      if (disposed) return;
      apply(snapshot);
      if (force) {
        if (typeof rpc.contacts === 'function') void loadContacts(true);
        void loadConversations(true);
        if (typeof rpc.activity === 'function') void loadActivity(true);
        const peer = activeConversationPeer();
        if (peer.length > 0) void loadMessages(peer, { force: true });
      }
    } catch (error) {
      if (disposed) return;
      showError(error);
    } finally {
      inFlight = false;
    }
  }

  function start(host) {
    if (disposed) return false;
    try {
      const mountOptions = {
        viewState,
        onRefresh: () => { void poll(true); },
        onShare: () => share(),
        onCopyText: (text) => copyText(text),
      };
      // The shared UI distinguishes "daemon-backed capability missing" from a
      // loading list. Older hosts that lack these methods must not be given a
      // loader that can never resolve.
      if (typeof rpc.contacts === 'function') {
        mountOptions.onLoadContacts = (force) => loadContacts(force);
      }
      if (typeof rpc.setFriendName === 'function') {
        mountOptions.onSetFriendName = (peerId, name) => setFriendName(peerId, name);
      }
      if (typeof rpc.setFriendDescription === 'function') {
        mountOptions.onSetFriendDescription = (peerId, description) => setFriendDescription(peerId, description);
      }
      if (typeof rpc.connect === 'function') mountOptions.onConnect = (input) => connect(input);
      if (typeof rpc.contactCard === 'function') {
        mountOptions.onContactCard = async (peerId, addressScopes) => remoteValue(await rpc.contactCard(sessionId, peerId, addressScopes));
      }
      if (typeof rpc.previewContactCard === 'function') {
        mountOptions.onPreviewContactCard = async (input) => remoteValue(await rpc.previewContactCard(sessionId, input));
      }
      if (typeof rpc.checkContact === 'function') mountOptions.onCheckContact = (peerId) => checkContact(peerId);
      if (typeof rpc.conversations === 'function') {
        mountOptions.onLoadConversations = (force) => loadConversations(force);
      }
      if (typeof rpc.messages === 'function') {
        mountOptions.onLoadMessages = (peerId, force, context) => loadMessages(peerId, {
          force: force === true,
          token: context?.token,
        });
        mountOptions.onLoadOlder = (peerId, before, context) => loadMessages(peerId, {
          before,
          force: true,
          token: context?.token,
        });
      }
      if (typeof rpc.markRead === 'function') {
        mountOptions.onMarkRead = (peerId, messageId) => markConversationRead(peerId, messageId);
      }
      if (typeof rpc.favorites === 'function') {
        mountOptions.onLoadFavorites = (before, force) => readFavorites(before, force);
      }
      if (typeof rpc.setFavorite === 'function') {
        mountOptions.onSetFavorite = (input) => setFavorite(input.peerId, input.path, input.sha256, input.title, input.favorite);
      }
      if (typeof rpc.peerDiscoveries === 'function') {
        mountOptions.onLoadPeerDiscoveries = (peerId, force) => readPeerDiscoveries(peerId, force);
      }
      if (typeof rpc.contactMemory === 'function') {
        mountOptions.onLoadContactMemory = (peerId) => readContactMemory(peerId);
      }
      if (typeof rpc.saveContactImpression === 'function') {
        mountOptions.onSaveContactImpression = (input) => saveContactImpression(input);
      }
      if (typeof rpc.send === 'function') mountOptions.onSend = (peerId, text, requestId) => sendMessage(peerId, text, requestId);
      if (typeof rpc.cancelOutbox === 'function') {
        mountOptions.onCancelOutbox = (peerId, messageId) => cancelMessage(peerId, messageId);
      }
      if (typeof rpc.discoveries === 'function') {
        mountOptions.onLoadDiscoveries = (familiar, force) => readDiscoveries(familiar, force);
      }
      if (typeof rpc.refreshDiscoveries === 'function') {
        mountOptions.onRefreshDiscoveries = (familiar) => refreshDiscoveries(familiar);
      }
      if (typeof rpc.discoveryContent === 'function') {
        mountOptions.onLoadDiscoveryContent = (id) => readDiscoveryContent(id);
      }
      if (typeof rpc.humanOutbound === 'function') {
        mountOptions.onLoadHumanOutbound = (force) => readHumanOutbound(force);
      }
      if (typeof rpc.mine === 'function') {
        mountOptions.onLoadMine = (force) => readMine(force);
      }
      if (typeof rpc.peerProfile === 'function') {
        mountOptions.onLoadPeerProfile = (peerId, force) => readPeerProfile(peerId, force);
      }
      if (typeof rpc.peerFriends === 'function') {
        mountOptions.onLoadPeerFriends = (peerId, force) => readPeerFriends(peerId, force);
      }
      if (typeof rpc.contactProjection === 'function') {
        mountOptions.onLoadContactProjection = () => readContactProjection();
      }
      if (typeof rpc.peerManifest === 'function') {
        mountOptions.onLoadPeerManifest = (peerId, force) => readPeerManifest(peerId, force);
      }
      if (typeof rpc.peerFilePreview === 'function') {
        mountOptions.onLoadPeerFileContent = (peerId, filePath, sha256, sizeBytes) => readPeerFilePreview(peerId, filePath, sha256, sizeBytes);
      }
      if (typeof rpc.peerPostMeta === 'function') {
        mountOptions.onLoadPeerPostMeta = (peerId, filePath, sha256, sizeBytes) => readPeerPostMeta(peerId, filePath, sha256, sizeBytes);
      }
      if (typeof rpc.mineFilePreview === 'function') {
        mountOptions.onLoadMineFileContent = (filePath, sha256, sizeBytes) => readMineFilePreview(filePath, sha256, sizeBytes);
      }
      if (typeof rpc.peerNodeInfo === 'function') {
        mountOptions.onLoadPeerNodeInfo = (peerId, force) => readPeerNodeInfo(peerId, force);
      }
      if (typeof rpc.revealDiscovery === 'function') {
        mountOptions.onRevealDiscovery = (id) => revealDiscovery(id);
      }
      if (typeof rpc.revealFile === 'function') {
        mountOptions.onRevealFile = (subject, peerId, filePath, sha256, sizeBytes) => revealFile(subject, peerId, filePath, sha256, sizeBytes);
      }
      if (typeof rpc.bootstrap === 'function') {
        mountOptions.onLoadBootstrap = () => readBootstrap();
      }
      if (typeof rpc.addBootstrap === 'function') {
        mountOptions.onAddBootstrap = (shareCode) => addBootstrap(shareCode);
      }
      if (typeof rpc.removeBootstrap === 'function') {
        mountOptions.onRemoveBootstrap = (peerId) => removeBootstrap(peerId);
      }
      if (typeof rpc.journey === 'function') {
        mountOptions.onLoadJourney = (force) => readJourney(force);
      }
      if (typeof rpc.journeyReport === 'function') {
        mountOptions.onLoadJourneyReport = async (journeyId) => {
          if (disposed) throw new Error('Raminga panel is closed');
          return remoteValue(await rpc.journeyReport(sessionId, journeyId));
        };
      }
      if (typeof rpc.activity === 'function') {
        // Capability flag for the shared UI; polling is owned by this runtime.
        mountOptions.onLoadActivity = () => loadActivity(true);
      }
      if (typeof rpc.activityDetail === 'function') {
        mountOptions.onLoadActivityDetail = (operationId) => readActivityDetail(operationId);
      }
      if (typeof rpc.savePrivateAgent === 'function') {
        mountOptions.onSavePrivateAgent = (field, content, expectedSha256) => savePrivateAgent(field, content, expectedSha256);
      }      if (typeof rpc.publicDraft === 'function') {
        mountOptions.onLoadPublicDraft = (draftId) => readPublicDraft(draftId);
      }
      if (typeof rpc.publicDrafts === 'function') {
        mountOptions.onLoadPublicDrafts = (kind) => readPublicDrafts(kind);
      }
      if (typeof rpc.savePublicDraft === 'function') {
        mountOptions.onSavePublicDraft = (input) => savePublicDraft(input);
      }
      if (typeof rpc.putPublicDraftImage === 'function') {
        mountOptions.onPutPublicDraftImage = (draftId, role, filename, dataBase64) => putPublicDraftImage(draftId, role, filename, dataBase64);
      }
      if (typeof rpc.publicDraftAsset === 'function') {
        mountOptions.onLoadPublicDraftAsset = (draftId, assetId) => readPublicDraftAsset(draftId, assetId);
      }
      if (typeof rpc.importPublicPost === 'function') {
        mountOptions.onImportPublicPost = (filePath) => importPublicPost(filePath);
      }
      if (typeof rpc.deletePublicDraft === 'function') {
        mountOptions.onDeletePublicDraft = (draftId, expectedRevision) => deletePublicDraft(draftId, expectedRevision);
      }
      if (typeof rpc.publishPublicDraft === 'function') {
        mountOptions.onPublishPublicDraft = publishPublicDraft;
      }
      if (typeof rpc.locateMessage === 'function') {
        mountOptions.onLocateMessage = (peerId, messageId) => readLocatedMessage(peerId, messageId);
      }
      app = mount(host, mountOptions);
    } catch (error) {
      disposed = true;
      onBootError?.(error);
      return false;
    }
    void open();
    return true;
  }

  function dispose() {
    if (disposed) return;
    // Start a pending draft flush while the host RPC callbacks are still
    // usable. The UI debounces edits; a panel close inside that window must
    // still attempt the private save rather than silently dropping it.
    try { app?.flushDrafts?.(); } catch { /* the panel is being torn down */ }
    disposed = true;
    if (pollTimer !== null) {
      timers.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (contactsTimer !== null) {
      timers.clearInterval(contactsTimer);
      contactsTimer = null;
    }
    if (conversationsTimer !== null) {
      timers.clearInterval(conversationsTimer);
      conversationsTimer = null;
    }
    if (messagesTimer !== null) {
      timers.clearInterval(messagesTimer);
      messagesTimer = null;
    }
    if (eventRefreshTimer !== null) {
      timers.clearTimeout(eventRefreshTimer);
      eventRefreshTimer = null;
    }
    if (activityTimer !== null) {
      timers.clearInterval(activityTimer);
      activityTimer = null;
    }
    activityGeneration += 1;
    activityInFlight = false;
    // A disposed panel must settle queued older promises. The UI ignores them
    // after destroy, but returning a forever-pending request would leave its
    // busy state behind in any host that outlives this runtime.
    for (const state of olderMessageReads.values()) {
      while (state.queue.length > 0) state.queue.shift().resolve(null);
    }
    try {
      app?.destroy();
    } catch (error) {
      logger.warn?.('[raminga-ui] panel destroy failed', errorText(error));
    } finally {
      app = null;
      // Even if open() has not resolved yet (or already failed), ask the host
      // to release this session id now. A late open result triggers one more
      // idempotent close from open() itself.
      closeLease();
    }
  }

  return {
    start,
    dispose,
    poll,
    refresh() { return poll(true); },
    get active() { return !disposed; },
    /** Diagnostics for focused tests; not used by the renderer. */
    get timers() {
      return {
        pollTimer, retryTimer, contactsTimer, conversationsTimer, messagesTimer, eventRefreshTimer, activityTimer,
        inFlight, contactsInFlight, conversationsInFlight,
        messagesInFlight: [...latestMessageReads.values()].some((state) => state.running !== null)
          || [...olderMessageReads.values()].some((state) => state.running),
        openAttempted, closeRequested, leaseOpen, leaseClosed, activityInFlight, activityGeneration,
      };
    },
  };
}

export { errorText, remoteValue };
