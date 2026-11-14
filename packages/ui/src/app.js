// Native Raminga main-workspace UI.
//
// This module owns only the five-page visual workspace, local navigation and
// rendering of generic NodeStatus/NodeEvent values supplied by a host. It never
// opens a daemon socket, reads a token, or imports DSH. The host adapter owns
// daemon access, lifecycle and subscription cleanup.
import { renderPrimaryNav, updatePrimaryNav } from './components/navigation.js';
import {
  contactCheckOutcome,
  contactDisplayName,
  contactInitial,
  contactListState,
  connectionStateText,
  contactsEmptyStaleText,
  contactsReadErrorText,
  contactsStaleText,
  connectOutcome,
  shareText as buildShareText,
  addressScopeText,
} from './contacts.js';
import {
  NODE_PHASES,
  connectionFactText,
  connectionSummary,
  formatClock,
  formatRelative,
  nodePhaseText,
  nodePillText,
  refreshedText,
  routeFactText,
  shortPeer,
  subscriptionText,
} from './node-status.js';
import { isMainPage, pageForNav } from './router.js';
import {
  copyViewState,
  getDraft as readDraft,
  normalizeViewState,
  setDraft as storeDraft,
} from './view-state.js';
import {
  contentStateSummary,
  discoveryListState,
  evidenceLocations,
  formatDateTime,
  journeyDirectionText,
  journeyEventLabel,
  journeyMessageRefs,
  journeyModeText,
  journeySessionTitle,
  journeyStatusText,
  journeyTimeText,
  minePostsStateText,
  mineProfileStateText,
  postMatchesQuery,
  profileLabel,
  shortPeerText,
} from './content.js';
import { plainExcerpt, renderSafeMarkdown } from './safe-content.js';
import {
  conversationListState,
  conversationStatusLabel,
  conversationStatusTone,
  conversationSummaryText,
  countTextBytes,
  deliveryStatusText,
  deliveryStatusTone,
  eventMessage,
  isCancelable,
  mergeMessages,
  messageClock,
  messageListState,
  messageTimeText,
  previewText,
  sendOutcome,
} from './messages.js';

/**
 * Resolve the display phase for one host snapshot. A snapshot error wins over
 * a stale status, and a stopped event stream is reported as closed instead of
 * leaving the last "ready" state on screen.
 * @param {{status?: object|null, error?: string|null, stats?: {streamActive?: boolean}|null}} snapshot
 * @returns {'loading'|'ready'|'stale'|'error'|'closed'}
 */
export function resolveNodePhase(snapshot = {}) {
  if (snapshot.error) return 'error';
  const streamPhase = snapshot.stream?.phase ?? snapshot.stats?.streamPhase;
  if (snapshot.freshness === 'live') return 'ready';
  if (snapshot.freshness === 'unavailable' && !snapshot.status) return 'error';
  if (snapshot.freshness === 'stale') {
    if (streamPhase === 'closed') return 'closed';
    return snapshot.status ? 'stale' : 'loading';
  }
  // Backward-compatible shape for hosts that only send status + stats.
  if (snapshot.stats && snapshot.stats.streamActive === false) {
    return streamPhase === 'reconnecting' || streamPhase === 'connecting' ? 'stale' : 'closed';
  }
  if (streamPhase === 'reconnecting' || streamPhase === 'connecting') {
    return snapshot.status ? 'stale' : 'loading';
  }
  if (snapshot.status) return 'ready';
  return 'loading';
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function detailRow(label, value, useCode = false) {
  const row = element('div');
  const key = element('span');
  key.textContent = label;
  const valueNode = element(useCode ? 'code' : 'span');
  valueNode.textContent = value || '—';
  row.append(key, valueNode);
  return row;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

function selectorValue(value) {
  const text = String(value ?? '');
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(text);
  return text.replace(/["\\]/g, '\\$&');
}

/**
 * Mount the five-page workspace into a ShadowRoot-backed host element.
 * @param {ShadowRoot} root
 * @param {{onRefresh?: () => void, viewState?: object}} [options]
 */
export function createRamingaApp(root, options = {}) {
  const doc = root.ownerDocument ?? document;
  const win = doc.defaultView ?? globalThis;
  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  const controller = new AbortController();

  const view = normalizeViewState(options.viewState);
  const hostView = options.viewState && typeof options.viewState === 'object' && !Array.isArray(options.viewState)
    ? options.viewState
    : null;
  let destroyed = false;
  let currentPage = isMainPage(view.page) ? view.page : 'explore';
  let saveFrame = null;
  let pendingRefresh = false;
  let lastNodeAnnouncement = '';
  // scrollTop that the app itself assigned. The matching scroll event is a
  // layout/restore side effect, not a reader move, so it must not overwrite a
  // saved message anchor while the panel is being restored.
  let expectedProgrammaticScroll = null;
  let restoreRun = 0;
  let hostReady = false;

  const pageEls = {
    explore: $('#page-explore'),
    contacts: $('#page-contacts'),
    raminga: $('#page-raminga'),
    messages: $('#page-messages'),
    mine: $('#page-mine'),
  };
  const nodeState = {
    phase: 'loading',
    status: null,
    statusAt: 0,
    error: null,
    errorAt: 0,
    freshness: 'loading',
    stream: null,
    stats: null,
    events: [],
  };
  const contactsCapable = typeof options.onLoadContacts === 'function';
  const contactsState = {
    data: contactsCapable
      ? { friends: [], at: 0, freshness: 'loading', error: '' }
      : { friends: [], at: 0, freshness: 'unavailable', error: '联系人读取暂不可用' },
    transportError: contactsCapable ? '' : '联系人读取暂不可用',
    selectedPeerId: '',
  };
  let contactsRetrying = false;
  const conversationsCapable = typeof options.onLoadConversations === 'function';
  const messagesCapable = typeof options.onLoadMessages === 'function';
  const sendsCapable = typeof options.onSend === 'function';
  const cancelsCapable = typeof options.onCancelOutbox === 'function';
  const conversationsState = {
    data: conversationsCapable
      ? { conversations: [], at: 0, freshness: 'loading', error: '' }
      : { conversations: [], at: 0, freshness: 'unavailable', error: '会话列表读取暂不可用' },
    transportError: conversationsCapable ? '' : '会话列表读取暂不可用',
  };
  let conversationsRetrying = false;
  const discoveriesCapable = typeof options.onLoadDiscoveries === 'function';
  const discoveryContentCapable = typeof options.onLoadDiscoveryContent === 'function';
  const mineCapable = typeof options.onLoadMine === 'function';
  const journeyCapable = typeof options.onLoadJourney === 'function';
  const peerProfileCapable = typeof options.onLoadPeerProfile === 'function';
  const locateMessageCapable = typeof options.onLocateMessage === 'function';
  const emptyDiscoveries = (familiar = false) => ({
    items: [], at: null, error: null, errorAt: null, freshness: 'loading',
    familiar, scanned: 0, truncated: false, relationComplete: !familiar, ignored: 0,
  });
  const discoveryByFilter = new Map();
  // One explicit read per filter at a time. The cache is per filter, so a late
  // response for the filter the reader just left may fill that filter's cache
  // but can never replace the filter currently on screen. A force request that
  // arrives during an in-flight read is coalesced into one follow-up.
  const discoveryRequests = new Map();
  const discoveryStale = new Set();
  const DISCOVERY_REVALIDATE_MS = 15_000;
  const mineState = { data: null, error: '', requestSeq: 0, retrying: false };
  const JOURNEY_REVALIDATE_MS = 15_000;
  const journeyState = {
    data: null,
    error: '',
    retrying: false,
    request: null,
  };
  const profileState = {
    peerId: '',
    data: null,
    error: '',
    requestSeq: 0,
    retrying: false,
  };
  const profileReturn = {
    page: 'explore',
    peerId: '',
    triggerRef: '',
    // The source page is display:none while the profile is open. Chromium
    // collapses its scrollTop to 0, so this is the only trustworthy reading
    // position until the profile closes.
    scroll: null,
    open: false,
  };
  let profileTriggerRef = '';
  // A pointer press can move focus (and scroll the page) before the click
  // handler runs. Remember the visible position from before that default
  // action so a focus-induced 0 cannot replace the reader's position.
  let profilePressScroll = null;
  const postContent = new Map();
  let locateSeq = 0;
  const locateRequests = new Map();
  function createChatState(peerId = '') {
    return {
      peerId,
      items: [],
      at: 0,
      error: '',
      freshness: 'loading',
      retention: null,
      // The latest page and the older-than window have independent cursors.
      // A routine latest refresh must never move historyCursor backwards.
      latestLoaded: false,
      historyHasMore: false,
      historyCursor: '',
      // `historyEnded` is only set by an explicit hasMore=false page. A missing
      // or non-advancing cursor with hasMore=true is an unknown boundary, not an
      // end, and must keep its already-loaded rows reachable.
      historyEnded: false,
      historyError: '',
      historyRetryMode: '',
      historyRetrying: false,
      historyRetryPending: false,
      loadingOlder: false,
      olderError: '',
      requestSeq: 0,
      restoreScroll: 0,
      restoreWindow: false,
      restoreAnchor: null,
      anchorMissing: false,
      restoreLoading: false,
      restorePages: 0,
      pendingRestore: false,
      firstPage: true,
      focusMessageId: '',
      focusNotice: '',
      focusProbe: 0,
      focusBusy: false,
      generation: 0,
      // The surface and trigger that opened this chat. It survives a host
      // remount through view state; an absent/!= selected Peer source means the
      // back action falls back to the conversation index.
      returnPage: '',
      returnPeer: '',
    };
  }
  // One loaded window per Peer. Switching conversations must not throw away
  // the older rows or the forward cursor, and a background latest refresh
  // must not overwrite either of them.
  const chatStates = new Map();
  let chat = createChatState('');
  const appliedMessagePages = new WeakSet();
  const sendTasks = new Map();
  let sendSeq = 0;
  let composerComposing = false;
  const cancellingIds = new Set();
  let composerNotice = null;
  let composerDetailText = '';
  let addAttempt = 0;
  let checkAttempt = 0;
  let addContactPeerId = '';
  let addContactPending = false;
  let checkPending = false;
  let shareAttempt = 0;
  let currentShare = null;

  const nodeTrigger = $('#nodeTrigger');
  const nodeDot = $('#nodeDot');
  const nodeLabel = $('#nodeLabel');
  const nodeLive = $('#nodeLive');

  const statusDialog = $('#statusDialog');
  const noticeDialog = $('#noticeDialog');
  const addContactDialog = $('#addContactDialog');
  const shareDialog = $('#shareDialog');
  const statusRefresh = $('#statusRefresh');
  const exploreRefresh = $('#exploreRefresh');
  const exploreSearchToggle = $('#exploreSearchToggle');
  const exploreSearch = $('#exploreSearch');
  const exploreQuery = $('#exploreQuery');
  const contactQuery = $('#contactQuery');
  const contactList = $('#contactList');
  const contactsMeta = $('#contactsMeta');
  const contactsMetaRetry = $('#contactsMetaRetry');
  const contactsStateActions = $('#contactsStateAction');
  const contactsRetryAction = $('#contactsStateRetry');
  const contactsShareAction = $('#contactsShareAction');
  const contactsSection = $('#contactsState');
  const messagesIndex = $('#messagesIndex');
  const conversationView = $('#conversationView');
  const conversationBack = $('#conversationBack');
  const conversationName = $('#conversationName');
  const conversationPeerId = $('#conversationPeerId');
  const conversationState = $('#conversationState');
  const conversationAvatar = $('#conversationAvatar');
  const conversationQuery = $('#conversationQuery');
  const conversationList = $('#conversationList');
  const conversationsMeta = $('#conversationsMeta');
  const conversationsMetaRetry = $('#conversationsMetaRetry');
  const messagesStateSection = $('#messagesState');
  const messageList = $('#messageList');
  const messageStateSection = $('#messageState');
  const messageStale = $('#messageStale');
  const messageFocusNote = $('#messageFocusNote');
  const messageRetry = $('#messageRetry');
  const messageOlderError = $('#messageOlderError');
  const messageHistoryRetry = $('#messageHistoryRetry');
  const messageRestoreNote = $('#messageRestoreNote');
  const messageRestoreActions = $('#messageRestoreActions');
  const messageRestoreAction = $('#messageRestoreAction');
  const messageRestoreLatest = $('#messageRestoreLatest');
  const loadOlder = $('#loadOlder');
  const messageRetention = $('#messageRetention');
  const composer = $('#composer');
  const messageInput = $('#messageInput');
  const messageSend = $('#messageSend');
  const messageCounter = $('#messageCounter');
  const composerStatus = $('#composerStatus');
  const composerTech = $('#composerTech');
  const technicalDialog = $('#technicalDialog');
  const technicalHeading = $('#technicalHeading');
  const technicalIntro = $('#technicalIntro');
  const technicalRaw = $('#technicalRaw');
  const composerActions = $('#composerActions');
  const sendReconcile = $('#sendReconcile');
  const sendRestore = $('#sendRestore');
  const addContactForm = $('#addContactForm');
  const addContactInput = $('#addContactInput');
  const addContactSubmit = $('#addContactSubmit');
  const addContactView = $('#addContactView');
  const addContactCheck = $('#addContactCheck');
  const addContactFeedback = $('#addContactFeedback');
  const addContactFeedbackTitle = $('#addContactFeedbackTitle');
  const addContactFeedbackBody = $('#addContactFeedbackBody');
  const addContactFeedbackContact = $('#addContactFeedbackContact');
  const addContactFeedbackStatus = $('#addContactFeedbackStatus');
  const addContactFeedbackDetail = $('#addContactFeedbackDetail');
  const addContactFeedbackRaw = $('#addContactFeedbackRaw');
  const shareLoading = $('#shareLoading');
  const shareContent = $('#shareContent');
  const sharePeerId = $('#sharePeerId');
  const shareAddresses = $('#shareAddresses');
  const shareAddressNote = $('#shareAddressNote');
  const shareStaleNote = $('#shareStaleNote');
  const shareFailure = $('#shareFailure');
  const shareFailureBody = $('#shareFailureBody');
  const shareFailureDetail = $('#shareFailureDetail');
  const shareFailureRaw = $('#shareFailureRaw');
  const shareManual = $('#shareManual');
  const shareCopyStatus = $('#shareCopyStatus');
  const shareCopy = $('#shareCopy');
  const shareRetry = $('#shareRetry');
  const mineIdentity = $('#mineIdentity');
  const mineSummary = $('#mineIdentitySummary');
  const mineDetails = $('#mineIdentityDetails');
  const mineIdentityAction = $('#mineIdentityAction');
  const mineRefresh = $('#mineRefresh');
  const mineProfileStatus = $('#mineProfileStatus');
  const mineProfileContent = $('#mineProfileContent');
  const mineProfileNote = $('#mineProfileNote');
  const mineContentStatus = $('#mineContentStatus');
  const mineContentNote = $('#mineContentNote');
  const minePostList = $('#minePostList');
  const mineRetry = $('#mineRetry');
  const discoveryMeta = $('#discoveryMeta');
  const discoveryMetaRetry = $('#discoveryMetaRetry');
  const discoveryList = $('#discoveryList');
  const ramingaSelfPanel = $('#ramingaSelfPanel');
  const ramingaSelf = $('#ramingaSelf');
  const ramingaSelfNote = $('#ramingaSelfNote');
  const ramingaGrowthPanel = $('#ramingaGrowthPanel');
  const ramingaGrowth = $('#ramingaGrowth');
  const ramingaGrowthNote = $('#ramingaGrowthNote');
  const ramingaJourneyPanel = $('#ramingaJourneyPanel');
  const ramingaJourneyMeta = $('#ramingaJourneyMeta');
  const ramingaSessionList = $('#ramingaSessionList');
  const ramingaRecordsBar = $('#ramingaRecordsBar');
  const ramingaRecordsStatus = $('#ramingaRecordsStatus');
  const ramingaRefresh = $('#ramingaRefresh');
  const profileView = $('#profileView');
  const profileBack = $('#profileBack');
  const profileAvatar = $('#profileAvatar');
  const profileName = $('#profileName');
  const profilePeerId = $('#profilePeerId');
  const profileSource = $('#profileSource');
  const profileStale = $('#profileStale');
  const profileError = $('#profileError');
  const profileRetry = $('#profileRetry');
  const profileBody = $('#profileBody');
  const profileBodyNote = $('#profileBodyNote');
  const profileAgentNote = $('#profileAgentNote');
  const profileAgentSummary = $('#profileAgentSummary');
  const profileAgentName = $('#profileAgentName');
  const profileAgentDescription = $('#profileAgentDescription');
  const profileAgentOpen = $('#profileAgentOpen');
  const agentCardDialog = $('#agentCardDialog');
  const agentCardSource = $('#agentCardSource');
  const agentCardBody = $('#agentCardBody');
  const shareNode = $('#shareNode');
  const statusTech = $('#statusTech');
  const noticeNote = $('#noticeNote');

  const dialogTriggers = new Map();
  // One independent technical-detail surface for composer RPC errors and
  // per-message persisted delivery errors. It deliberately does not live in
  // the conversation flow, so opening it never shrinks the message list or
  // stacks another scroll area inside the composer.
  let technicalReturn = null;

  function pageTracksScroll(pageName) {
    // While a conversation is open the messages page scroll is the index's
    // saved position; the conversation keeps its own per-Peer scroll.
    return Boolean(view.pages[pageName]) && !(pageName === 'messages' && contactsState.selectedPeerId);
  }

  function visiblePageScroll(pageName) {
    const page = pageEls[pageName];
    if (!page || page.hidden) return null;
    return Math.max(0, page.scrollTop || 0);
  }

  function writeHostView() {
    if (!hostView) return;
    view.page = currentPage;
    if (profileReturn.open && pageTracksScroll(profileReturn.page)) {
      // Profile reads can trigger late scroll events (the profile is its own
      // scroller). Never read the display:none source page in that state: it
      // reports 0 and would overwrite the snapshot taken on profile entry.
      view.pages[profileReturn.page].scroll = Math.max(0, Number(profileReturn.scroll) || 0);
    } else if (pageTracksScroll(currentPage)) {
      const live = visiblePageScroll(currentPage);
      // A hidden page has no meaningful scroll position. Skipping it also
      // keeps late hide/scroll events from erasing a saved position.
      if (live !== null) view.pages[currentPage].scroll = live;
    }
    copyViewState(hostView, view);
  }

  function scheduleSave() {
    if (destroyed) return;
    if (typeof win.requestAnimationFrame !== 'function') {
      writeHostView();
      return;
    }
    if (saveFrame !== null) return;
    saveFrame = win.requestAnimationFrame(() => {
      saveFrame = null;
      writeHostView();
    });
  }

  function saveNow() {
    if (saveFrame !== null) {
      if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(saveFrame);
      saveFrame = null;
    }
    writeHostView();
  }

  function restorePageScrollAfterFocus(pageName, expected) {
    if (!pageTracksScroll(pageName)) return;
    const page = pageEls[pageName];
    if (!page || page.hidden) return;
    const value = Math.max(0, Number(expected) || 0);
    if (Math.abs(Number(page.scrollTop) - value) >= 1) page.scrollTop = value;
    if (typeof win.requestAnimationFrame !== 'function') return;
    // A browser that ignores preventScroll (or a hide/unhide layout flush) can
    // apply a late scroll after focus. Re-assert once, but never fight a real
    // reader move: only replace an actual 0 with the captured non-zero value.
    win.requestAnimationFrame(() => {
      if (destroyed || profileReturn.open || page.hidden || value === 0) return;
      if (Number(page.scrollTop) === 0) {
        page.scrollTop = value;
        // A focus/layout scroll may already have queued its own save. Persist
        // the reasserted position immediately so a quick panel unmount cannot
        // leave the host view at the late 0.
        saveNow();
      }
    });
  }

  function showPage(pageName, { save = true } = {}) {
    if (destroyed) return;
    const next = isMainPage(pageName) ? pageName : 'explore';
    if (!profileView.hidden && view.profile.returnPage !== next) closePeerProfile({ restoreFocus: false });
    if (save) {
      const live = visiblePageScroll(currentPage);
      if (live !== null && pageTracksScroll(currentPage)) view.pages[currentPage].scroll = live;
    }
    currentPage = next;
    view.page = next;
    for (const [name, page] of Object.entries(pageEls)) {
      page.hidden = name !== next;
    }
    const active = pageEls[next];
    active.hidden = false;
    active.scrollTop = view.pages[next].scroll;
    if (next === 'messages' && contactsState.selectedPeerId) active.scrollTop = 0;
    updatePrimaryNav(root, next);
    ensurePageData(next);
    if (save) scheduleSave();
  }

  function stateCard(titleEl, bodyEl, actionEl, { title, body, action = null, tone = 'unavailable' }) {
    titleEl.textContent = title;
    bodyEl.textContent = body;
    const card = titleEl.closest('.rm-state');
    if (card) card.dataset.tone = tone;
    actionEl.hidden = action === null;
    actionEl.onclick = action === null ? null : action.run;
    if (action !== null) actionEl.textContent = action.label;
  }

  function renderMarkdownInto(node, markdown) {
    node.replaceChildren(renderSafeMarkdown(doc, markdown));
  }

  function discoveryDataFor(familiar) {
    return discoveryByFilter.get(familiar ? 'familiar' : 'all') ?? null;
  }

  function discoveryKeyFor(familiar) {
    return familiar ? 'familiar' : 'all';
  }

  function discoveryRefreshing() {
    return discoveryRequests.has(discoveryKeyFor(view.pages.explore.filter === 'familiar'));
  }

  function discoveryCacheNeedsRead(familiar) {
    const key = discoveryKeyFor(familiar);
    if (discoveryStale.has(key)) return true;
    const data = discoveryByFilter.get(key);
    if (!data || data.at === null) return true;
    const at = Number(data.at);
    return !(at > 0) || Date.now() - at > DISCOVERY_REVALIDATE_MS;
  }

  /**
   * A manual send is recorded in the same daemon transaction that persists the
   * outbound row, so a pending row already qualifies as "you sent a message".
   * Only the familiar filter changes; the all-content feed is unaffected.
   * Unknown send results do not call this until a persisted human row is read.
   */
  function markHumanOutboundPersisted() {
    if (destroyed) return;
    discoveryStale.add('familiar');
    if (currentPage === 'explore' && view.pages.explore.filter === 'familiar') {
      ensureDiscoveriesFresh(true);
    }
  }

  function notePersistedHumanOutbound(messages) {
    if (!Array.isArray(messages)) return;
    const task = contactsState.selectedPeerId ? taskFor(contactsState.selectedPeerId) : null;
    // Only an unknown send needs the persisted row to close the loop. A normal
    // conversation read must not invalidate the familiar cache on every open;
    // external relation changes remain reachable through revalidation/refresh.
    if (!task) return;
    const persistedHuman = messages.some((message) => message
      && message.direction === 'out'
      && message.origin === 'human'
      && taskMatchesMessage(task, message));
    if (persistedHuman) markHumanOutboundPersisted();
  }

  function ensureDiscoveriesFresh(force = false) {
    if (destroyed || !hostReady || !discoveriesCapable) return;
    const familiar = view.pages.explore.filter === 'familiar';
    if (!force && !discoveryCacheNeedsRead(familiar)) return;
    const key = discoveryKeyFor(familiar);
    const inFlight = discoveryRequests.get(key);
    if (inFlight) {
      if (force === true) inFlight.forceQueued = true;
      return;
    }
    const data = discoveryByFilter.get(key);
    // A stale marker (for example after a persisted human send) must bypass
    // the host bridge TTL; an ordinary page-entry revalidation may let the
    // bridge coalesce with its own recent read.
    const mustForce = force === true
      || discoveryStale.has(key)
      || !data
      || data.at === null;
    refreshDiscoveries(mustForce);
  }

  function updateDiscoveryMeta(data, state) {
    const notes = [];
    if (data?.error) {
      notes.push(`上次刷新没有完成：${data.error}`);
    }
    if (data?.truncated) {
      notes.push(`这次检查了 ${data.scanned} 条获取记录，可能还有更多未检查。`);
    }
    if (view.pages.explore.filter === 'familiar' && data && data.relationComplete === false) {
      notes.push('你发过消息的节点没有完整读取，筛选结果可能不完整。');
    }
    if (data && data.ignored > 0) {
      notes.push(`另有 ${data.ignored} 个文件不是可识别的公开帖子，未列入动态。`);
    }
    if (state.kind === 'ready' && state.total !== state.items.length) {
      notes.push(`当前显示 ${state.items.length} 条，匹配搜索的公开内容共 ${state.total} 条。`);
    }
    const note = notes.join(' ');
    discoveryMeta.textContent = note;
    discoveryMeta.hidden = note.length === 0;
    discoveryMetaRetry.hidden = !(discoveriesCapable && Boolean(data?.error) && state.kind !== 'error');
    discoveryMetaRetry.textContent = discoveryRefreshing() ? '正在重试…' : '重试读取';
    discoveryMetaRetry.onclick = discoveriesCapable ? () => { void refreshDiscoveries(true); } : null;
  }

  function postSourceRows(item) {
    return [
      ['获取方式', item.source === 'raminga_content_get'
        ? 'Agent 获取（raminga_content_get）'
        : item.source
          ? `Agent 获取（${item.source}）`
          : 'Agent 获取（来源未记录）'],
      ['获取时间', item.fetchedAt > 0 ? formatDateTime(item.fetchedAt) : ''],
      ['发布时间', item.publishedAt ? formatDateTime(item.publishedAt) : ''],
      ['公共路径', item.path],
      ['内容版本', item.sha256],
      ['大小', item.sizeBytes > 0 ? `${item.sizeBytes} 字节` : ''],
      ['本地副本', item.contentState === 'unreadable' ? '不可读取' : '已核对'],
    ];
  }

  function sourceDetails({ rows, note, focusKey = '' }) {
    const details = element('details', 'rm-source-details');
    const summary = element('summary', 'rm-source-summary');
    summary.textContent = '来源详情';
    if (focusKey) summary.dataset.focusKey = focusKey;
    const body = element('div', 'rm-source-body');
    const facts = element('dl', 'rm-source-facts');
    for (const [label, value] of rows) {
      if (!value) continue;
      const row = element('div', 'rm-source-fact');
      const term = element('dt');
      term.textContent = label;
      const detail = element('dd');
      detail.textContent = value;
      row.append(term, detail);
      facts.append(row);
    }
    if (facts.childElementCount > 0) body.append(facts);
    if (note) {
      const noteEl = element('p', 'rm-source-note');
      noteEl.textContent = note;
      body.append(noteEl);
    }
    details.append(summary, body);
    return details;
  }

  function focusRestoreKey(node) {
    if (!node || node.nodeType !== 1) return '';
    const active = root.activeElement;
    return active?.dataset?.focusKey ?? '';
  }

  function postOwnerLabel(item) {
    return String(item.authorName ?? '').trim() || contactFor(item.peerId)?.name || shortPeerText(item.peerId) || '未知作者';
  }

  function renderDiscoveryList(items) {
    const focusKey = focusRestoreKey(discoveryList);
    const pageScroll = pageEls.explore.scrollTop;
    discoveryList.replaceChildren();
    for (const item of items) {
      const article = element('article', 'rm-post');
      article.dataset.postId = item.id;
      const header = element('header', 'rm-post-head');
      const avatar = element('button', 'rm-contact-avatar rm-post-avatar');
      avatar.type = 'button';
      avatar.setAttribute('aria-label', `查看 ${shortPeerText(item.peerId)} 的档案`);
      avatar.dataset.profilePeer = item.peerId;
      avatar.dataset.profileRef = `explore:${item.id}`;
      avatar.dataset.focusKey = `post-author:${item.id}`;
      avatar.textContent = postOwnerLabel(item).slice(0, 1) || '?';
      const copy = element('div', 'rm-post-author');
      const name = element('button', 'rm-post-name');
      name.type = 'button';
      name.dataset.profilePeer = item.peerId;
      name.dataset.profileRef = `explore:${item.id}`;
      name.dataset.focusKey = `post-name:${item.id}`;
      name.textContent = postOwnerLabel(item);
      const meta = element('span', 'rm-post-meta');
      meta.textContent = `${item.authorKind === 'agent' ? 'Agent 署名 · ' : item.authorKind === 'user' ? '用户署名 · ' : ''}${shortPeerText(item.peerId)}`;
      copy.append(name, meta);
      const date = element('time', 'rm-post-time');
      const broughtAt = item.fetchedAt > 0 ? formatDateTime(item.fetchedAt) : '';
      date.textContent = broughtAt ? `Agent 带回 · ${broughtAt}` : 'Agent 带回';
      header.append(avatar, copy, date);
      const title = element('h2', 'rm-post-title');
      title.textContent = item.contentState === 'unreadable' ? '这条公开内容暂时无法读取' : item.title;
      const summary = element('p', 'rm-post-summary');
      summary.textContent = item.contentState === 'unreadable'
        ? '本地副本缺失或损坏；来源信息仍保留。'
        : item.summary || '展开阅读正文。';
      article.append(header, title, summary);
      if (Array.isArray(item.tags) && item.tags.length > 0) {
        const tags = element('div', 'rm-post-tags');
        for (const tag of item.tags) {
          const chip = element('span', 'rm-post-tag');
          chip.textContent = tag;
          tags.append(chip);
        }
        article.append(tags);
      }
      const details = sourceDetails({
        rows: postSourceRows(item),
        note: '来源由本机节点记录；帖子和署名来自发布节点的公开声明。',
        focusKey: `post-source:${item.id}`,
      });
      details.open = view.pages.explore.sourceOpen[item.id] === true;
      details.ontoggle = () => {
        if (destroyed) return;
        if (details.open) view.pages.explore.sourceOpen[item.id] = true;
        else delete view.pages.explore.sourceOpen[item.id];
        scheduleSave();
      };
      const expanded = view.pages.explore.expanded[item.id] === true;
      const actions = element('div', 'rm-post-actions');
      const toggle = element('button', 'rm-quiet rm-post-toggle');
      toggle.type = 'button';
      toggle.dataset.expandPost = item.id;
      toggle.dataset.focusKey = `post-toggle:${item.id}`;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.textContent = expanded ? '收起内容' : '阅读内容';
      actions.append(toggle);
      article.append(details, actions);
      if (expanded) {
        const body = element('div', 'rm-post-body');
        const cached = postContent.get(item.id);
        if (item.contentState === 'unreadable') {
          const failed = element('p', 'rm-list-note');
          failed.textContent = `这条公开内容的本地副本不可读取：${item.contentError || '副本缺失或损坏'}。来源和哈希仍保留，但不能假装仍可阅读。`;
          body.append(failed);
        } else if (!cached || cached.state === 'loading') {
          const loading = element('p', 'rm-list-note');
          loading.textContent = '正在核对本地副本与哈希…';
          body.append(loading);
        } else if (cached.state === 'error') {
          const failed = element('p', 'rm-list-note');
          failed.textContent = `这次没有读到公开内容：${cached.error}`;
          const retry = element('button', 'rm-list-retry');
          retry.type = 'button';
          retry.dataset.retryPost = item.id;
          retry.dataset.focusKey = `post-retry:${item.id}`;
          retry.textContent = '重试读取内容';
          body.append(failed, retry);
        } else {
          const content = element('div', 'rm-rich-text');
          renderMarkdownInto(content, cached.data.post?.bodyMarkdown ?? '');
          body.append(content);
        }
        article.append(body);
        if (!cached && item.contentState !== 'unreadable') void ensurePostContent(item.id);
      }
      discoveryList.append(article);
      if (expanded && focusKey === `post-toggle:${item.id}`) {
        // restored below
      }
    }
    discoveryList.hidden = false;
    if (focusKey) {
      const target = [...discoveryList.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focusKey);
      target?.focus({ preventScroll: true });
    }
    if (pageEls.explore.scrollTop !== pageScroll) pageEls.explore.scrollTop = pageScroll;
  }

  function updateExploreState() {
    const title = $('#exploreStateTitle');
    const body = $('#exploreStateBody');
    const action = $('#exploreStateAction');
    $('#exploreState').hidden = false;
    view.pages.explore.query = exploreQuery.value;
    const familiar = view.pages.explore.filter === 'familiar';
    const data = discoveryDataFor(familiar);
    const state = discoveryListState(data, exploreQuery.value);
    const refreshing = discoveryRefreshing();
    if (exploreRefresh) {
      exploreRefresh.hidden = !discoveriesCapable;
      exploreRefresh.dataset.busy = refreshing ? 'true' : 'false';
      exploreRefresh.setAttribute('aria-busy', refreshing ? 'true' : 'false');
      const label = exploreRefresh.querySelector('span');
      if (label) label.textContent = refreshing ? '刷新中' : '刷新';
    }
    if (!discoveriesCapable) {
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      $('#exploreState').hidden = false;
      updateDiscoveryMeta(data, { kind: 'error', items: [], total: 0 });
      stateCard(title, body, action, {
        tone: 'unavailable',
        title: '公开内容读取暂不可用',
        body: '当前宿主没有提供公开内容索引，不能把联系人清单或本地文件当作 Agent 推荐。',
        action: { label: '查看节点状态', run: () => openDialog(statusDialog, action) },
      });
      return;
    }
    if (state.kind === 'loading') {
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      updateDiscoveryMeta(data, state);
      stateCard(title, body, action, {
        tone: 'unavailable',
        title: '正在整理公开动态',
        body: '正在整理 Agent 带回的公开内容。',
        action: discoveriesCapable ? { label: refreshing ? '正在刷新…' : '刷新动态', run: () => { void refreshDiscoveries(true); } } : null,
      });
      return;
    }
    if (state.kind === 'error') {
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      updateDiscoveryMeta(data, state);
      stateCard(title, body, action, {
        tone: 'error',
        title: '这次没有读到公开动态',
        body: data?.error ? `${data.error} 这不代表没有任何公开内容。` : '公开内容索引读取失败。这不代表没有任何公开内容。',
        action: { label: refreshing ? '正在重试…' : '重试读取', run: () => { void refreshDiscoveries(true); } },
      });
      return;
    }
    if (state.kind === 'search-empty') {
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      updateDiscoveryMeta(data, state);
      stateCard(title, body, action, {
        tone: 'unavailable',
        title: '没有找到匹配的公开内容',
        body: `没有标题、摘要、标签、作者或路径匹配“${exploreQuery.value.trim()}”。`,
        action: {
          label: '清除搜索',
          run: () => {
            exploreQuery.value = '';
            view.pages.explore.query = '';
            updateExploreState();
            saveNow();
            exploreQuery.focus();
          },
        },
      });
      return;
    }
    if (state.kind === 'empty') {
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      updateDiscoveryMeta(data, state);
      stateCard(title, body, action, {
        tone: 'unavailable',
        title: familiar ? '还没有你发过消息的节点带回的内容' : '还没有 Agent 带回的公开内容',
        body: familiar
          ? '这里会显示你本人发过消息的节点带回的公开内容。仅建立联系，或由 Agent 发消息，都不算你本人发过消息。'
          : '当 Agent 从节点获取并核对公开内容后，会出现在这里。联系人清单或旧下载文件不会自动变成动态。',
        action: {
          label: familiar ? '返回发现' : '刷新动态',
          run: familiar ? () => setFilter('all') : () => { void refreshDiscoveries(true); },
        },
      });
      return;
    }
    $('#exploreState').hidden = true;
    updateDiscoveryMeta(data, state);
    renderDiscoveryList(state.items);
  }

  async function ensurePostContent(id, force = false) {
    const existing = postContent.get(id);
    if (!force && existing && existing.state !== 'error') return;
    if (!discoveryContentCapable) {
      postContent.set(id, { state: 'error', error: '当前宿主没有提供受控内容读取。' });
      updateExploreState();
      return;
    }
    postContent.set(id, { state: 'loading' });
    updateExploreState();
    try {
      const value = await options.onLoadDiscoveryContent(id);
      if (destroyed) return;
      if (value && value.ok === true && value.post) {
        postContent.set(id, { state: 'available', data: value });
      } else {
        postContent.set(id, { state: 'error', error: value?.error || '公开内容不可读取' });
      }
    } catch (error) {
      if (!destroyed) postContent.set(id, { state: 'error', error: errorText(error) || '公开内容读取失败' });
    }
    if (!destroyed) updateExploreState();
  }

  function togglePost(id) {
    if (view.pages.explore.expanded[id] === true) delete view.pages.explore.expanded[id];
    else view.pages.explore.expanded[id] = true;
    saveNow();
    updateExploreState();
  }

  function refreshDiscoveries(force = false) {
    if (destroyed || !discoveriesCapable) { updateExploreState(); return; }
    if (!hostReady) return;
    const familiar = view.pages.explore.filter === 'familiar';
    const key = discoveryKeyFor(familiar);
    const existing = discoveryRequests.get(key);
    if (existing) {
      // Coalesce repeated clicks and a send-invalidated read into one trailing
      // force read. Never start a second concurrent read for the same filter.
      if (force === true) existing.forceQueued = true;
      updateExploreState();
      return;
    }
    const request = { forceQueued: false };
    discoveryRequests.set(key, request);
    updateExploreState();
    let pending;
    try {
      // A stale marker means the host bridge's own cache may also be old;
      // force only for those changes, not for every ordinary page entry.
      const hostForce = force === true || discoveryStale.has(key);
      pending = options.onLoadDiscoveries(familiar, hostForce);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void Promise.resolve(pending)
      .then((value) => {
        if (destroyed || discoveryRequests.get(key) !== request) return;
        if (value === null || typeof value !== 'object') {
          throw new Error('公开内容索引没有返回结果');
        }
        discoveryByFilter.set(key, {
          ...value,
          items: Array.isArray(value.items) ? value.items : [],
          familiar,
          relationComplete: familiar ? value.relationComplete === true : true,
        });
        discoveryStale.delete(key);
        if (discoveryKeyFor(view.pages.explore.filter === 'familiar') === key) updateExploreState();
      })
      .catch((error) => {
        if (destroyed || discoveryRequests.get(key) !== request) return;
        const previous = discoveryByFilter.get(key);
        const failure = previous ?? emptyDiscoveries(familiar);
        console.warn('[raminga-ui] discovery refresh failed', errorText(error));
        discoveryByFilter.set(key, {
          ...failure,
          error: errorText(error) || '公开内容索引读取失败',
          errorAt: Date.now(),
        });
        if (discoveryKeyFor(view.pages.explore.filter === 'familiar') === key) updateExploreState();
      })
      .finally(() => {
        if (discoveryRequests.get(key) === request) discoveryRequests.delete(key);
        if (destroyed) return;
        if (discoveryKeyFor(view.pages.explore.filter === 'familiar') === key) updateExploreState();
        if (request.forceQueued) refreshDiscoveries(true);
      });
  }

  function setContactsNotice(text, { retry = false } = {}) {
    const note = typeof text === 'string' ? text : '';
    const retryFocused = root.activeElement === contactsMetaRetry;
    contactsMeta.textContent = note;
    contactsMeta.hidden = note.length === 0;
    contactsMetaRetry.hidden = !(retry && contactsCapable);
    contactsMetaRetry.textContent = contactsRetrying ? '正在重试…' : '重试读取';
    contactsMetaRetry.onclick = contactsCapable ? retryContacts : null;
    if (contactsMetaRetry.hidden && retryFocused) {
      // The stale banner disappeared while its action had focus. Move focus to
      // the list/search instead of letting it fall back to the document body.
      const first = contactList.hidden ? null : contactList.querySelector('button[data-contact-peer]');
      (first ?? contactQuery).focus({ preventScroll: true });
    }
  }

  function showContactsState({ title, body, tone = 'unavailable', primary = null, retry = false, share = false }) {
    contactsSection.hidden = false;
    contactsSection.dataset.tone = tone;
    contactList.hidden = true;
    setContactsNotice('');
    $('#contactsStateTitle').textContent = title;
    $('#contactsStateBody').textContent = body;
    contactsStateActions.hidden = primary === null;
    contactsStateActions.textContent = primary?.label ?? '';
    contactsStateActions.onclick = primary === null ? null : primary.run;
    contactsRetryAction.hidden = retry !== true;
    contactsRetryAction.textContent = contactsRetrying ? '正在重试…' : '重试读取';
    contactsRetryAction.onclick = retry === true ? retryContacts : null;
    contactsShareAction.hidden = !share;
  }

  function fillContactRow(row, friend) {
    const peerId = String(friend?.peerId ?? '');
    row.dataset.contactRow = peerId;
    row.className = 'rm-contact rm-contact-row';
    const state = friend?.connection === 'connected' || friend?.connection === 'disconnected'
      ? friend.connection
      : 'unknown';
    const label = `${contactDisplayName(friend)}，${connectionStateText(state)}`;
    const avatar = row.querySelector(':scope > button[data-profile-peer]') ?? element('button', 'rm-contact-avatar rm-avatar-button');
    avatar.type = 'button';
    avatar.dataset.profilePeer = peerId;
    avatar.dataset.profileRef = `contacts:${peerId}`;
    avatar.dataset.focusKey = `contact-avatar:${peerId}`;
    avatar.setAttribute('aria-label', `查看 ${contactDisplayName(friend)} 的档案`);
    avatar.textContent = contactInitial(friend);
    const main = row.querySelector(':scope > button[data-contact-peer]') ?? element('button', 'rm-contact-main');
    main.type = 'button';
    main.dataset.contactPeer = peerId;
    main.dataset.focusKey = `contact:${peerId}`;
    main.setAttribute('aria-label', `${label}，打开会话入口`);
    const copy = element('span', 'rm-contact-copy');
    const nameLine = element('span', 'rm-contact-name');
    const name = element('b');
    name.textContent = contactDisplayName(friend);
    nameLine.append(name);
    if (friend?.paused === true) {
      const paused = element('span');
      paused.textContent = '已暂停主动连接';
      nameLine.append(paused);
    }
    const id = element('code', 'rm-peer-id');
    id.textContent = peerId;
    copy.append(nameLine, id);
    const description = typeof friend?.description === 'string' ? friend.description.trim() : '';
    if (description.length > 0) {
      const note = element('span', 'rm-contact-note');
      note.textContent = description;
      copy.append(note);
    }
    const badge = element('span', 'rm-contact-state');
    badge.dataset.state = state;
    badge.textContent = connectionStateText(state);
    main.replaceChildren(copy, badge);
    if (row.firstElementChild !== avatar || row.lastElementChild !== main || row.childElementCount !== 2) {
      row.replaceChildren(avatar, main);
    }
  }

  function contactRow(friend) {
    return element('div', 'rm-contact');
  }

  function focusedContactRow() {
    const active = root.activeElement ?? doc.activeElement;
    if (!active || active.nodeType !== 1) return null;
    return active.closest?.('[data-contact-row]') ?? null;
  }

  /**
   * Reconcile rows by stable Peer ID. Existing buttons are updated in place so
   * a focused row survives polling; only rows that really disappeared are
   * removed. The page/list scroll offsets are captured and restored because
   * focusing or inserting rows must not jump the reading position.
   */
  function reconcileContactList(friends) {
    const activeRow = focusedContactRow();
    const activePeer = activeRow?.dataset.contactRow ?? '';
    const activeWasAvatar = Boolean(root.activeElement?.dataset?.profilePeer);
    const rowsBefore = [...contactList.querySelectorAll('[data-contact-row]')];
    const activeIndex = activeRow ? rowsBefore.indexOf(activeRow) : -1;
    const listScroll = contactList.scrollTop;
    const pageScroll = pageEls.contacts.scrollTop;

    const existing = new Map(rowsBefore.map((row) => [row.dataset.contactRow, row]));
    let previous = null;
    for (const friend of friends) {
      const peerId = String(friend?.peerId ?? '');
      let row = existing.get(peerId);
      if (row) existing.delete(peerId);
      else row = contactRow(friend);
      fillContactRow(row, friend);
      if (previous === null) {
        if (contactList.firstElementChild !== row) contactList.insertBefore(row, contactList.firstElementChild);
      } else if (previous.nextElementSibling !== row) {
        contactList.insertBefore(row, previous.nextElementSibling);
      }
      previous = row;
    }
    for (const row of existing.values()) row.remove();

    const rowsAfter = [...contactList.querySelectorAll('[data-contact-row]')];
    const target = activePeer ? rowsAfter.find((row) => row.dataset.contactRow === activePeer) : null;
    if (target) {
      const focusTarget = activeWasAvatar
        ? target.querySelector('button[data-profile-peer]')
        : target.querySelector('button[data-contact-peer]');
      if (focusTarget && root.activeElement !== focusTarget) focusTarget.focus({ preventScroll: true });
    } else if (activeRow) {
      const fallback = rowsAfter[Math.min(Math.max(activeIndex, 0), rowsAfter.length - 1)] ?? null;
      (fallback?.querySelector('button[data-contact-peer]') ?? contactQuery).focus({ preventScroll: true });
    }
    if (contactList.scrollTop !== listScroll) contactList.scrollTop = listScroll;
    if (pageEls.contacts.scrollTop !== pageScroll) pageEls.contacts.scrollTop = pageScroll;
  }

  function retryContacts() {
    if (destroyed || contactsRetrying || !contactsCapable) return;
    contactsRetrying = true;
    // Keep the old rows, read time and error until the new result arrives;
    // setContacts()/setContactsError() replace them when the host answers.
    updateContactsState();
    let request;
    try {
      request = options.onLoadContacts(true);
    } catch (error) {
      request = Promise.reject(error);
    }
    void Promise.resolve(request)
      .catch((error) => {
        if (!destroyed) setContactsError(error);
      })
      .finally(() => {
        if (destroyed) return;
        contactsRetrying = false;
        updateContactsState();
      });
  }

  function clearContactSearch() {
    contactQuery.value = '';
    view.pages.contacts.query = '';
    updateContactsState();
    saveNow();
    contactQuery.focus();
  }

  function updateContactsState() {
    if (destroyed) return;
    const query = contactQuery.value;
    view.pages.contacts.query = query;
    const state = contactListState(contactsState.data, query, contactsState.transportError);
    const activeRow = focusedContactRow();
    if (state.kind === 'ready') {
      const stateHadFocus = contactsSection.contains(root.activeElement);
      contactsSection.hidden = true;
      contactList.hidden = false;
      reconcileContactList(state.friends);
      const stale = contactsStaleText(contactsState.data, contactsState.transportError);
      setContactsNotice(stale, { retry: stale.length > 0 && contactsCapable });
      if (stateHadFocus) {
        const first = contactList.querySelector('button[data-contact-peer]');
        (first ?? contactQuery).focus({ preventScroll: true });
      }
      renderConversation();
      return;
    }
    // The list is being replaced by a state card. Move focus somewhere valid
    // before the focused row is removed.
    if (activeRow) contactQuery.focus({ preventScroll: true });
    contactList.replaceChildren();
    if (state.kind === 'loading') {
      showContactsState({
        title: '正在读取联系人…',
        body: '正在从本机节点读取联系人列表，请稍候。',
        tone: 'unavailable',
      });
    } else if (state.kind === 'error') {
      showContactsState({
        title: '这次没有读到联系人',
        body: contactsReadErrorText(contactsState.data),
        tone: 'error',
        primary: contactsCapable
          ? { label: contactsRetrying ? '正在重试…' : '重试读取', run: retryContacts }
          : {
            label: '查看节点状态',
            run: () => openDialog(statusDialog, contactsStateActions),
          },
      });
    } else if (state.kind === 'empty') {
      if (state.stale) {
        const failed = Boolean(state.error) || Boolean(contactsState.transportError);
        showContactsState({
          title: failed ? '暂时无法确认联系人列表' : '联系人列表可能已过期',
          body: contactsEmptyStaleText(contactsState.data, contactsState.transportError),
          tone: failed ? 'error' : 'unavailable',
          primary: contactsCapable
            ? { label: contactsRetrying ? '正在重试…' : '重试读取', run: retryContacts }
            : null,
          share: true,
        });
      } else {
        showContactsState({
          title: '还没有联系人',
          body: '添加第一个联系人，或把自己的节点信息分享给对方。',
          primary: { label: '添加第一个联系人', run: () => openAddDialog(contactsStateActions) },
          share: true,
        });
      }
    } else {
      const stale = state.stale || Boolean(state.error);
      showContactsState({
        title: '没有找到匹配的联系人',
        body: `没有名称、备注或 Peer ID 匹配“${query.trim()}”。`,
        primary: {
          label: '清除搜索',
          run: clearContactSearch,
        },
        retry: stale,
      });
      if (stale) {
        // The state card carries the retry action next to "清除搜索"; keep the
        // banner text-only so there is one, not two, retry controls.
        setContactsNotice(contactsStaleText(contactsState.data, contactsState.transportError));
      }
    }
    renderConversation();
  }

  function setContacts(value) {
    if (destroyed || value === null || typeof value !== 'object') return;
    const previousAt = Number(contactsState.data?.at) > 0 ? Number(contactsState.data.at) : 0;
    const nextAt = Number(value.at) > 0 ? Number(value.at) : 0;
    // A slower poll can resolve after a Connect/check result. Never let its
    // older ListFriends snapshot replace a newer one in the same panel.
    if (nextAt > 0 && previousAt > 0 && nextAt < previousAt) return;
    contactsState.data = value;
    contactsState.transportError = '';
    updateContactsState();
    updateConversationIndexState();
  }

  function setContactsError(error) {
    if (destroyed) return;
    contactsState.transportError = errorText(error) || '联系人读取失败';
    updateContactsState();
    updateConversationIndexState();
  }

  function contactFor(peerId) {
    const friends = Array.isArray(contactsState.data?.friends) ? contactsState.data.friends : [];
    return friends.find((friend) => friend?.peerId === peerId) ?? null;
  }

  function conversationFriend(peerId) {
    return contactFor(peerId);
  }

  function draftKeyFor(peerId) {
    return `chat:${peerId}`;
  }

  function persistDraft(peerId, value) {
    if (!peerId) return;
    storeDraft(view, draftKeyFor(peerId), value);
    scheduleSave();
  }

  function chatScrollFor(peerId) {
    const map = view.pages.messages.chatScrolls;
    const value = map && typeof map === 'object' ? Number(map[peerId]) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function readChatAnchor(peerId) {
    const map = view.pages.messages.chatAnchors;
    const value = map && typeof map === 'object' ? map[peerId] : null;
    if (!value || typeof value !== 'object' || typeof value.messageId !== 'string' || !value.messageId) {
      return null;
    }
    const offset = Number(value.offset);
    return {
      messageId: value.messageId,
      offset: Number.isFinite(offset) ? offset : 0,
      atBottom: value.atBottom === true,
    };
  }

  function clearChatAnchor(peerId) {
    if (!peerId || !view.pages.messages.chatAnchors) return;
    if (Object.prototype.hasOwnProperty.call(view.pages.messages.chatAnchors, peerId)) {
      delete view.pages.messages.chatAnchors[peerId];
    }
  }

  /**
   * "No layout" and "no visible row" are different facts. A detached or
   * hidden panel has zero geometry and must never erase the last valid
   * reading anchor; only a measured window may update or clear it.
   */
  function messageListHasMeasuredLayout() {
    if (!messageList || !messageList.isConnected || messageList.hidden) return false;
    const page = pageEls.messages;
    if (!page || page.hidden) return false;
    const rect = typeof messageList.getBoundingClientRect === 'function'
      ? messageList.getBoundingClientRect()
      : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  /** Assign a scroll position and remember it as an app-driven scroll. */
  function applyMessageListScrollTop(value) {
    if (!messageList) return;
    const next = Math.max(0, Number(value) || 0);
    messageList.scrollTop = next;
    // Browsers clamp to the real scroll range; remember the actual value so
    // the matching scroll event can be distinguished from a reader move.
    const applied = Number(messageList.scrollTop);
    expectedProgrammaticScroll = Number.isFinite(applied) ? applied : next;
  }

  function scrollEventIsProgrammatic() {
    if (expectedProgrammaticScroll === null) return false;
    const current = Number(messageList?.scrollTop);
    if (Number.isFinite(current) && Math.abs(current - expectedProgrammaticScroll) <= 1) return true;
    expectedProgrammaticScroll = null;
    return false;
  }

  function saveChatScroll({ force = false } = {}) {
    if (destroyed) return;
    const peerId = chat.peerId;
    if (!peerId || !messageList) return;
    // A latest-only window that is still being restored is provisional. It
    // must not overwrite the persisted anchor before the saved row is found
    // or the reader explicitly chooses a different position. This is also why
    // a detached root (zero geometry) and a hidden page keep the anchor.
    if (!force && (chat.pendingRestore || chat.restoreAnchor || chat.anchorMissing || chat.restoreLoading)) {
      return;
    }
    if (!messageList.isConnected || messageList.hidden || pageEls.messages.hidden) return;
    // Late events from a previous Peer must not save that window under the
    // currently selected Peer, even for the pixel fallback.
    if (messageList.dataset.peerId && messageList.dataset.peerId !== peerId) return;
    if (!force && scrollEventIsProgrammatic()) {
      // An app-driven restore/layout scroll must not replace an existing
      // precise anchor. If no anchor exists yet (for example the first latest
      // page or the first explicit older page), fall through once so the
      // stable row under the restored viewport becomes the saved position.
      view.pages.messages.chatScrolls[peerId] = Math.max(0, messageList.scrollTop || 0);
      if (readChatAnchor(peerId)) {
        scheduleSave();
        return;
      }
    }
    view.pages.messages.chatScrolls[peerId] = Math.max(0, messageList.scrollTop || 0);
    // The pixel position is meaningful even in a layout-less test DOM; the
    // message-ID anchor requires real geometry and is preserved otherwise.
    if (!messageListHasMeasuredLayout()) {
      scheduleSave();
      return;
    }
    const anchor = captureVisibleMessageAnchor();
    if (anchor) {
      const atBottom = isMessageListAtBottom();
      view.pages.messages.chatAnchors[peerId] = atBottom
        ? { messageId: anchor.messageId, offset: anchor.offset, atBottom: true }
        : { messageId: anchor.messageId, offset: anchor.offset };
    } else if (messageList.querySelectorAll('.rm-message[data-message-id]').length === 0) {
      // A mounted, measured empty conversation has no row to return to. This
      // is an explicit empty state, not a detach or a transient layout.
      clearChatAnchor(peerId);
    }
    // A measured window with rows but no row at the viewport edge is transient
    // layout; keep the last valid anchor instead of deleting it.
    scheduleSave();
  }

  function saveIndexScroll() {
    view.pages.messages.scroll = Math.max(0, pageEls.messages.scrollTop || 0);
  }

  function resetChatFor(peerId) {
    const cached = chatStates.get(peerId);
    const hasWindow = Boolean(cached && cached.items.length > 0);
    const state = cached ?? createChatState(peerId);
    if (!cached) chatStates.set(peerId, state);
    chat = state;
    chat.peerId = peerId;
    // Invalidate every promise/callback that started before this entry. A
    // close-then-reopen of the same Peer is a new generation even though the
    // cached rows remain useful.
    chat.generation += 1;
    chat.requestSeq += 1;
    chat.loadingOlder = false;
    chat.olderError = '';
    chat.historyRetrying = false;
    chat.historyRetryPending = false;
    chat.focusMessageId = '';
    chat.focusNotice = '';
    chat.focusProbe = 0;
    chat.focusBusy = false;
    chat.pendingRestore = true;
    chat.anchorMissing = false;
    chat.restoreLoading = false;
    chat.restorePages = 0;
    restoreRun += 1;
    // A scroll event still queued for the previous Peer/window must not be
    // compared against this window's app-driven scroll position.
    expectedProgrammaticScroll = null;
    messageList.dataset.peerId = peerId;
    // A cached window keeps its valid (or explicitly ended) history boundary.
    // A previous consistency error also survives a switch so the retry entry is
    // still honest instead of silently pretending the history became clean.
    chat.restoreScroll = hasWindow ? chatScrollFor(peerId) : 0;
    chat.restoreWindow = hasWindow;
    chat.restoreAnchor = readChatAnchor(peerId);
    if (!hasWindow) {
      chat.items = [];
      chat.at = 0;
      chat.error = messagesCapable ? '' : '消息读取暂不可用';
      chat.freshness = messagesCapable ? 'loading' : 'unavailable';
      chat.retention = null;
      chat.latestLoaded = false;
      chat.historyHasMore = false;
      chat.historyCursor = '';
      chat.historyEnded = false;
      chat.historyError = '';
      chat.historyRetryMode = '';
      chat.firstPage = true;
    }
    messageInput.value = readDraft(view, draftKeyFor(peerId));
    composerNotice = null;
    messageOlderError.hidden = true;
    messageOlderError.textContent = '';
    applyComposerStatus('', '', '');
    updateComposerMeta();
  }

  function renderConversation() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId) {
      pageEls.messages.dataset.view = 'index';
      messagesIndex.hidden = false;
      conversationView.hidden = true;
      chat.peerId = '';
      if (messageList) messageList.dataset.peerId = '';
      return;
    }
    if (chat.peerId !== peerId) resetChatFor(peerId);
    const friend = conversationFriend(peerId);
    pageEls.messages.dataset.view = 'conversation';
    messagesIndex.hidden = true;
    conversationView.hidden = false;
    updateConversationBackLabel(peerId);
    conversationName.textContent = friend ? contactDisplayName(friend) : shortPeer(peerId);
    conversationPeerId.textContent = peerId;
    conversationAvatar.textContent = friend ? contactInitial(friend) : '?';
    conversationAvatar.dataset.profilePeer = peerId;
    conversationAvatar.dataset.profileRef = `chat:${peerId}`;
    conversationAvatar.setAttribute('aria-label', `查看 ${friend ? contactDisplayName(friend) : shortPeer(peerId)} 的档案`);
    const state = friend?.connection === 'connected' || friend?.connection === 'disconnected'
      ? friend.connection
      : 'unknown';
    conversationState.dataset.state = state;
    conversationState.textContent = connectionStateText(state);
    renderComposer();
    renderMessageList();
  }

  /** The back target follows the recorded entry source, not the template. */
  function updateConversationBackLabel(peerId) {
    if (!conversationBack) return;
    const valid = Boolean(peerId) && chat.returnPeer === peerId;
    conversationBack.textContent = valid && chat.returnPage === 'contacts'
      ? '← 返回联系人'
      : valid && chat.returnPage === 'raminga'
        ? '← 返回 Raminga'
        : '← 返回对话';
  }

  function openConversation(peerId, { source = 'messages', focus = true, focusMessageId = '' } = {}) {
    if (!peerId) return;
    if (contactsState.selectedPeerId && contactsState.selectedPeerId !== peerId) saveChatScroll();
    // Only save the index position when that index is actually the surface the
    // user opened the chat from. Saving it on a contact entry would overwrite
    // the previous conversation-list position with this page's stale scrollTop.
    if (source !== 'contacts') saveIndexScroll();
    const returnPage = source === 'contacts' ? 'contacts' : source === 'raminga' ? 'raminga' : 'messages';
    contactsState.selectedPeerId = peerId;
    view.pages.messages.peerId = peerId;
    view.pages.messages.returnPage = returnPage;
    view.pages.messages.returnPeer = peerId;
    renderConversation();
    chat.returnPage = returnPage;
    chat.returnPeer = peerId;
    chat.focusMessageId = typeof focusMessageId === 'string' ? focusMessageId : '';
    chat.focusNotice = chat.focusMessageId ? '已在当前保留记录中找到该消息引用。' : '';
    updateConversationBackLabel(peerId);
    showPage('messages');
    // The conversation has its own message scroller; the outer messages page
    // starts at the top and restores the index position when going back.
    pageEls.messages.scrollTop = 0;
    saveNow();
    if (messagesCapable) requestMessages(peerId, true);
    if (focus) messageInput.focus({ preventScroll: true });
  }

  function closeConversation() {
    const peerId = contactsState.selectedPeerId;
    const returnPage = chat.returnPage === 'contacts' || chat.returnPage === 'raminga' ? chat.returnPage : 'messages';
    const focusPeer = chat.returnPeer === peerId ? peerId : '';
    if (peerId) {
      saveChatScroll();
      // Invalidate late pages/results from this visit while keeping the
      // loaded window and cursor cached for a later visit.
      chat.generation += 1;
      chat.requestSeq += 1;
      chat.loadingOlder = false;
    }
    contactsState.selectedPeerId = '';
    view.pages.messages.peerId = '';
    view.pages.messages.returnPage = '';
    view.pages.messages.returnPeer = '';
    chat = createChatState('');
    renderConversation();
    updateConversationIndexState();
    if (returnPage === 'contacts') {
      // showPage(..., {save:false}) must not copy the now-empty chat scroller
      // over the saved conversation-index position. The contact search text
      // already lives in the mounted input and view state.
      showPage('contacts', { save: false });
      pageEls.contacts.scrollTop = view.pages.contacts.scroll;
      const row = focusPeer
        ? contactList.querySelector(`button[data-contact-peer="${selectorValue(focusPeer)}"]`)
        : null;
      (row ?? contactQuery).focus({ preventScroll: true });
    } else if (returnPage === 'raminga') {
      showPage('raminga', { save: false });
      pageEls.raminga.scrollTop = view.pages.raminga.scroll;
      const target = ramingaSessionList.querySelector('[data-session-toggle]') ?? $('#ramingaHeading');
      target?.focus?.({ preventScroll: true });
    } else {
      // An absent, stale or Peer-mismatched source falls back to the index.
      showPage('messages', { save: false });
      pageEls.messages.scrollTop = view.pages.messages.scroll;
      const row = focusPeer
        ? conversationList.querySelector(`button[data-conversation-peer="${selectorValue(focusPeer)}"]`)
        : null;
      (row ?? conversationQuery).focus({ preventScroll: true });
    }
    saveNow();
  }

  function requestMessages(peerId, force = false) {
    if (!messagesCapable || destroyed || !peerId) return;
    const generation = chat.generation;
    const request = ++chat.requestSeq;
    let pending;
    try {
      pending = options.onLoadMessages(peerId, force === true, { token: generation });
    } catch (error) {
      pending = Promise.reject(error);
    }
    void Promise.resolve(pending)
      .then((value) => {
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId
          || contactsState.selectedPeerId !== peerId || request !== chat.requestSeq) return;
        // Hosts may either apply the page themselves (the DSH runtime does) or
        // return it through this narrow loader. The host-applied page is
        // marked, so the same object is never merged and scrolled twice.
        if (value && typeof value === 'object' && value.peerId
          && !appliedMessagePages.has(value)) {
          setMessagePage(value, { token: generation });
        }
      })
      .catch((error) => {
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId
          || contactsState.selectedPeerId !== peerId || request !== chat.requestSeq) return;
        setMessagesError(peerId, errorText(error));
      });
  }

  function requestOlderMessages() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || chat.loadingOlder || !chat.historyHasMore || !messagesCapable) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const generation = chat.generation;
    const cursor = chat.historyCursor;
    chat.loadingOlder = true;
    chat.olderError = '';
    messageOlderError.hidden = true;
    updateMessageListChrome();
    let pending;
    try {
      if (typeof options.onLoadOlder !== 'function') throw new Error('加载更早消息暂不可用');
      pending = options.onLoadOlder(peerId, cursor, { token: generation });
    } catch (error) {
      pending = Promise.reject(error);
    }
    return (async () => {
      try {
        const value = await Promise.resolve(pending);
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId
          || contactsState.selectedPeerId !== peerId) {
          return { ok: false, reason: 'stale' };
        }
        let applied = false;
        if (value && typeof value === 'object' && value.peerId
          && !appliedMessagePages.has(value)) {
          applied = appendMessagePage(value, { token: generation });
        }
        return {
          ok: true,
          applied,
          items: chat.items.length,
          cursor: chat.historyCursor,
          hasMore: chat.historyHasMore,
        };
      } catch (error) {
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId
          || contactsState.selectedPeerId !== peerId) {
          return { ok: false, reason: 'stale' };
        }
        chat.olderError = `读取更早消息失败：${errorText(error) || '未知错误'}。可以重试。`;
        return { ok: false, reason: 'error' };
      } finally {
        if (!destroyed && chat.generation === generation && chat.peerId === peerId
          && contactsState.selectedPeerId === peerId) {
          chat.loadingOlder = false;
          updateMessageListChrome();
        }
      }
    })();
  }

  /**
   * Explicit recovery entry for a persisted reading anchor that is not in the
   * latest page. The reader asked for this anchor, so we may fetch older pages
   * until it is found or the retained end is reached. Nothing is fetched on
   * mount; the loop is bounded and stops on cursor/consistency errors.
   */
  const MAX_RESTORE_PAGES = 40;
  async function restoreAnchorFromHistory() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || !chat.restoreAnchor || !messagesCapable || chat.loadingOlder
      || chat.restoreLoading || !chat.historyHasMore) return;
    const generation = chat.generation;
    const run = ++restoreRun;
    chat.restoreLoading = true;
    chat.restorePages = 0;
    chat.olderError = '';
    updateMessageListChrome();
    try {
      while (!destroyed && run === restoreRun && chat.generation === generation
        && chat.peerId === peerId && contactsState.selectedPeerId === peerId
        && chat.restoreAnchor) {
        if (!chat.historyHasMore || chat.historyError || chat.restorePages >= MAX_RESTORE_PAGES) break;
        const beforeItems = chat.items.length;
        const beforeCursor = chat.historyCursor;
        const result = await requestOlderMessages();
        if (!result.ok) break;
        chat.restorePages += 1;
        if (!chat.restoreAnchor) break;
        // No row and no cursor movement is a stalled page; appendMessagePage
        // has already surfaced the consistency error. Do not loop forever.
        if (chat.items.length === beforeItems && chat.historyCursor === beforeCursor) break;
      }
    } finally {
      if (!destroyed && run === restoreRun && chat.generation === generation
        && chat.peerId === peerId && contactsState.selectedPeerId === peerId) {
        chat.restoreLoading = false;
        updateMessageListChrome();
      }
    }
  }

  /**
   * Explicitly abandon the old anchor and stay at the newest rows. This is the
   * reader's clear signal when the old position is no longer wanted.
   */
  function stayAtLatestMessages() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || !messageList || chat.restoreLoading) return;
    restoreRun += 1;
    clearChatAnchor(peerId);
    chat.restoreAnchor = null;
    chat.anchorMissing = false;
    chat.restorePages = 0;
    expectedProgrammaticScroll = null;
    scrollMessagesToBottom();
    updateMessageListChrome();
    // The scroll above is app-driven, so persist the explicit bottom position
    // explicitly instead of waiting for a reader scroll event.
    saveChatScroll({ force: true });
    saveNow();
  }

  function currentMessageState() {
    const state = messageListState({
      messages: chat.items,
      error: chat.error,
      freshness: chat.freshness,
      peerId: contactsState.selectedPeerId,
    });
    // A first page that claims more history without a usable cursor is a read
    // failure, not an empty conversation. Keep the retry state visible.
    if (state.kind === 'empty' && chat.historyError) {
      return { kind: 'error', messages: [], error: chat.historyError, stale: false };
    }
    return state;
  }

  function pageContextMatches(context, peerId) {
    if (!context || context.token === undefined) return true;
    return chat.generation === context.token && chat.peerId === peerId;
  }

  function pageErrorMessage(page) {
    return typeof page?.error === 'string' ? page.error.trim() : '';
  }

  function pageNextBefore(page) {
    return typeof page?.nextBefore === 'string' ? page.nextBefore : '';
  }

  function historyCursorError(page, { initial = false, preserved = false } = {}) {
    const nextBefore = pageNextBefore(page);
    let reason;
    if (page.hasMore === true) {
      reason = nextBefore.length === 0
        ? '服务端表示还有更早消息，但没有返回可用的继续游标。'
        : '服务端表示还有更早消息，但返回的游标没有前进。';
    } else {
      reason = nextBefore.length === 0
        ? '服务端没有明确历史是否结束，也没有返回可用的继续游标。'
        : '服务端没有明确历史是否结束，返回的游标也没有前进。';
    }
    if (initial) return `${reason}这不代表会话没有更早消息；可以重新读取历史。`;
    if (preserved) return `${reason}已保留此前有效游标和已加载消息，可以重试。`;
    return `${reason}已保留已加载消息，可以重新读取历史。`;
  }

  /**
   * Establish the one-time historical boundary from the first usable latest
   * page. Only an explicit hasMore=false is an end. A hasMore=true page without
   * a usable cursor is an unknown boundary: keep it retryable rather than
   * silently hiding the only older-history entry.
   */
  function applyInitialHistoryBoundary(page) {
    const nextBefore = pageNextBefore(page);
    if (page.hasMore === false) {
      chat.historyHasMore = false;
      chat.historyCursor = '';
      chat.historyEnded = true;
      chat.historyError = '';
      chat.historyRetryMode = '';
      return;
    }
    if (page.hasMore === true && nextBefore.length > 0) {
      chat.historyHasMore = true;
      chat.historyCursor = nextBefore;
      chat.historyEnded = false;
      chat.historyError = '';
      chat.historyRetryMode = '';
      return;
    }
    chat.historyHasMore = false;
    chat.historyCursor = '';
    chat.historyEnded = false;
    chat.historyError = historyCursorError(page, { initial: true });
    chat.historyRetryMode = 'latest';
  }

  /**
   * Advance the older boundary only after a valid cursor move. An overlapping
   * page may legitimately contain no new rows; that alone is not a failure.
   * A page that claims more history but supplies no usable/advancing cursor is
   * a consistency error that preserves the previous boundary and retry entry.
   */
  function applyOlderHistoryBoundary(page) {
    const nextBefore = pageNextBefore(page);
    if (page.hasMore === false) {
      chat.historyHasMore = false;
      chat.historyCursor = '';
      chat.historyEnded = true;
      chat.historyError = '';
      chat.historyRetryMode = '';
      return;
    }
    if (page.hasMore === true && nextBefore.length > 0 && nextBefore !== chat.historyCursor) {
      chat.historyHasMore = true;
      chat.historyCursor = nextBefore;
      chat.historyEnded = false;
      chat.historyError = '';
      chat.historyRetryMode = '';
      return;
    }
    const preserved = chat.historyHasMore && chat.historyCursor.length > 0;
    chat.historyError = historyCursorError(page, { preserved });
    // The previous hasMore/cursor/ended values are intentionally untouched.
    chat.historyRetryMode = preserved ? 'older' : 'latest';
  }

  function markPageApplied(page, applied) {
    if (applied && page && typeof page === 'object') appliedMessagePages.add(page);
    return applied;
  }

  /**
   * Apply the latest page (or a first page). The latest page only initialises
   * the older-history boundary once; routine refreshes may merge newer rows and
   * update freshness, but must never reset the cursor the reader advanced.
   */
  const MAX_FOCUS_PROBE_PAGES = 20;
  async function probeFocusInHistory() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || !chat.focusMessageId || chat.focusBusy || !messagesCapable) return;
    const generation = chat.generation;
    const wanted = chat.focusMessageId;
    if (chat.items.some((message) => message.messageId === wanted)) return;
    chat.focusBusy = true;
    chat.focusProbe = 0;
    chat.focusNotice = '';
    updateMessageListChrome();
    try {
      while (!destroyed && chat.generation === generation && chat.peerId === peerId
        && contactsState.selectedPeerId === peerId && chat.focusMessageId === wanted) {
        if (!chat.historyHasMore || chat.historyError || chat.focusProbe >= MAX_FOCUS_PROBE_PAGES) break;
        const beforeItems = chat.items.length;
        const beforeCursor = chat.historyCursor;
        const result = await requestOlderMessages();
        chat.focusProbe += 1;
        if (!result.ok) break;
        if (!chat.focusMessageId) break;
        if (chat.items.length === beforeItems && chat.historyCursor === beforeCursor) break;
      }
      if (!destroyed && chat.generation === generation && chat.peerId === peerId
        && contactsState.selectedPeerId === peerId && chat.focusMessageId === wanted) {
        if (!chat.historyHasMore) {
          chat.focusNotice = '该消息引用已不在当前保留消息中，无法定位；这里只保留历史观察。';
        } else if (chat.focusProbe >= MAX_FOCUS_PROBE_PAGES) {
          chat.focusNotice = '在本次有界读取的历史消息中没有找到该引用；没有继续扩大范围。';
        } else if (!chat.historyError) {
          chat.focusNotice = `暂时无法定位该消息引用${chat.olderError ? `：${chat.olderError}` : '。'}`;
        }
        if (chat.focusNotice) chat.focusMessageId = '';
      } else if (!destroyed && chat.generation === generation && chat.peerId === peerId
        && contactsState.selectedPeerId === peerId && !chat.focusMessageId) {
        chat.focusNotice = '已在当前保留记录中找到该消息引用。';
      }
    } finally {
      if (!destroyed && chat.generation === generation) {
        chat.focusBusy = false;
        updateMessageListChrome();
      }
    }
  }

  function setMessagePage(page, context) {
    if (destroyed || !page || typeof page !== 'object') return false;
    const peerId = contactsState.selectedPeerId;
    if (!peerId || page.peerId !== peerId || !pageContextMatches(context, peerId)) return false;
    const wasHidden = messageList.hidden;
    const wasAtBottom = isMessageListAtBottom();
    const wasFirstPage = chat.firstPage;
    const previousTop = messageList.scrollTop;
    const visibleAnchor = wasAtBottom ? null : captureVisibleMessageAnchor();
    const pageError = pageErrorMessage(page);
    const pageAt = Number(page.at) > 0 ? Number(page.at) : 0;
    // A late read started before the current one must not move freshness or
    // the read timestamp backwards. Its rows can still merge by stable ID.
    const staleMetadata = chat.at > 0 && pageAt > 0 && pageAt < chat.at;
    chat.items = mergeMessages(chat.items, page.messages, { peerId });
    notePersistedHumanOutbound(page.messages);
    // A successful latest page that is truly empty (and proves there is no
    // older retained page) means the old row cannot be recovered. Clear the
    // stale anchor instead of showing a recovery prompt for an empty chat.
    if (!pageError && chat.items.length === 0 && page.hasMore !== true) {
      clearChatAnchor(peerId);
      chat.restoreAnchor = null;
      chat.anchorMissing = false;
    }
    if (!staleMetadata) {
      if (pageAt > 0) chat.at = pageAt;
      chat.error = pageError;
      chat.freshness = page.freshness || 'live';
      chat.retention = page.retention && typeof page.retention === 'object' ? page.retention : null;
    }
    // Routine latest refreshes never touch the older boundary once it exists
    // (or once an explicit end/consistency error was recorded). Only the first
    // usable page, or an explicit user retry, may establish it.
    if (!pageError && !staleMetadata && (!chat.latestLoaded || chat.historyRetryPending)) {
      applyInitialHistoryBoundary(page);
      chat.latestLoaded = true;
      chat.historyRetryPending = false;
    } else if (pageError) {
      chat.historyRetryPending = false;
    }
    chat.historyRetrying = false;
    chat.firstPage = false;
    messagesRetrying = false;
    // A persisted row may advance while the send task still holds an older
    // pending/unknown RPC outcome (for example, the peer reconnects and the
    // outbox is ACKed). Reconcile only this task's stable requestId/messageId;
    // another message's ACK must never rewrite the composer.
    const task = peerId ? taskFor(peerId) : null;
    if (task) applyPersistedTaskState(task, messageForTask(task));
    renderMessageList();
    renderComposer();
    if (chat.pendingRestore) {
      chat.pendingRestore = false;
      let restored = false;
      if (chat.restoreAnchor) {
        if (chat.restoreAnchor.atBottom === true && chat.items.length > 0) {
          // The reader explicitly left the panel at the newest rows. A later
          // page may add rows, but reopening must still land at the bottom.
          scrollMessagesToBottom();
          restored = true;
          chat.restoreAnchor = null;
          chat.anchorMissing = false;
        } else {
          restored = restoreVisibleMessageAnchor(chat.restoreAnchor);
          if (restored) {
            chat.restoreAnchor = null;
            chat.anchorMissing = false;
          } else {
            chat.anchorMissing = true;
          }
        }
      }
      if (!restored && (chat.restoreWindow || chat.restoreScroll > 0)) {
        // A cached window at scrollTop 0 is still a real restored position;
        // never fall back to the previous Peer's pixel offset in that case.
        applyMessageListScrollTop(chat.restoreScroll);
        restored = true;
      }
      if (!restored) {
        if (wasAtBottom || wasHidden || wasFirstPage || previousTop === 0) scrollMessagesToBottom();
        else applyMessageListScrollTop(previousTop);
      }
    } else if (wasAtBottom || wasHidden) {
      scrollMessagesToBottom();
    } else if (visibleAnchor && restoreVisibleMessageAnchor(visibleAnchor, { keepScreen: true })) {
      // The same visible row stays at the same screen position even when the
      // load-older button above the scroller disappears and the list grows.
    } else {
      applyMessageListScrollTop(previousTop);
    }
    // A failed first read may have consumed the one-shot pending restore. If a
    // later latest page finally contains the saved row, complete the recovery
    // instead of leaving a stale "older history" note forever.
    if (chat.restoreAnchor) {
      if (chat.restoreAnchor.atBottom === true && chat.items.length > 0) {
        scrollMessagesToBottom();
        chat.restoreAnchor = null;
        chat.anchorMissing = false;
      } else if (restoreVisibleMessageAnchor(chat.restoreAnchor)) {
        chat.restoreAnchor = null;
        chat.anchorMissing = false;
      }
    }
    chat.restoreScroll = 0;
    chat.restoreWindow = false;
    updateMessageListChrome();
    if (chat.focusMessageId) void probeFocusInHistory();
    return markPageApplied(page, true);
  }

  /**
   * Append one older page. Failures keep the existing cursor and button so the
   * same request can be retried. Only an explicit hasMore=false ends the
   * history; a hasMore=true page with no usable/advancing cursor keeps the
   * previous boundary and loaded rows and exposes a consistency error instead
   * of pretending the earliest message was reached.
   */
  function appendMessagePage(page, context) {
    if (destroyed || !page || typeof page !== 'object') return false;
    const peerId = contactsState.selectedPeerId;
    if (!peerId || page.peerId !== peerId || !pageContextMatches(context, peerId)) return false;
    const offset = Math.max(0, messageList.scrollHeight - messageList.scrollTop);
    const wasAtBottom = isMessageListAtBottom();
    const visibleAnchor = wasAtBottom ? null : captureVisibleMessageAnchor();
    const pageError = pageErrorMessage(page);
    if (pageError) {
      chat.olderError = `读取更早消息失败：${pageError}。可以重试。`;
      chat.loadingOlder = false;
      updateMessageListChrome();
      return markPageApplied(page, true);
    }
    chat.items = mergeMessages(chat.items, page.messages, { peerId });
    notePersistedHumanOutbound(page.messages);
    if (page.retention) chat.retention = page.retention;
    chat.olderError = '';
    chat.loadingOlder = false;
    chat.historyRetrying = false;
    chat.historyRetryPending = false;
    messagesRetrying = false;
    applyOlderHistoryBoundary(page);
    const task = peerId ? taskFor(peerId) : null;
    if (task) applyPersistedTaskState(task, messageForTask(task));
    renderMessageList();
    if (wasAtBottom) {
      scrollMessagesToBottom();
    } else if (visibleAnchor && restoreVisibleMessageAnchor(visibleAnchor, { keepScreen: true })) {
      // Keep the exact reading row on screen when older rows (or the button
      // above the scroller) change the surrounding layout.
    } else {
      applyMessageListScrollTop(Math.max(0, messageList.scrollHeight - offset));
    }
    if (chat.restoreAnchor) {
      if (chat.restoreAnchor.atBottom === true) {
        scrollMessagesToBottom();
        chat.restoreAnchor = null;
        chat.anchorMissing = false;
      } else if (restoreVisibleMessageAnchor(chat.restoreAnchor)) {
        chat.restoreAnchor = null;
        chat.anchorMissing = false;
      } else if (chat.historyEnded) {
        // Only an explicit end proves the saved row is no longer retained.
        chat.restoreAnchor = null;
        chat.anchorMissing = true;
      }
    }
    updateMessageListChrome();
    if (chat.focusMessageId) void probeFocusInHistory();
    return markPageApplied(page, true);
  }

  function captureVisibleMessageAnchor() {
    if (!messageListHasMeasuredLayout()) return null;
    const listRect = messageList.getBoundingClientRect();
    for (const row of messageList.querySelectorAll('.rm-message[data-message-id]')) {
      // A late scroll event from the previous Peer must not capture a row that
      // is still mounted for that Peer under the new conversation key.
      if (row.dataset.peerId && row.dataset.peerId !== chat.peerId) continue;
      const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null;
      if (!rect || rect.height <= 0 || rect.bottom <= listRect.top + 1) continue;
      const messageId = row.dataset.messageId;
      if (!messageId) continue;
      return { messageId, offset: Math.round(rect.top - listRect.top), top: rect.top };
    }
    return null;
  }

  function restoreVisibleMessageAnchor(anchor, { keepScreen = false } = {}) {
    if (!anchor || !anchor.messageId || !messageList) return false;
    const row = messageList.querySelector(`[data-message-id="${selectorValue(anchor.messageId)}"]`);
    if (!row || typeof row.getBoundingClientRect !== 'function') return false;
    const listRect = messageList.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // In-session refreshes keep the row at the same viewport coordinate, which
    // also compensates for surrounding chrome (for example the load-older
    // button) appearing or disappearing. A persisted anchor has no saved
    // viewport coordinate; it restores the row's offset inside the scroller.
    const delta = keepScreen && Number.isFinite(anchor.top)
      ? rowRect.top - anchor.top
      : (rowRect.top - listRect.top) - Number(anchor.offset || 0);
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
      applyMessageListScrollTop(Math.max(0, messageList.scrollTop + delta));
    }
    return true;
  }

  function setMessagesError(peerId, error) {
    if (destroyed || contactsState.selectedPeerId !== peerId) return;
    chat.error = errorText(error) || '消息读取失败';
    chat.freshness = chat.items.length > 0 ? 'stale' : 'unavailable';
    messagesRetrying = false;
    chat.historyRetrying = false;
    chat.historyRetryPending = false;
    renderMessageList();
  }

  function isMessageListAtBottom() {
    if (!messageList || messageList.hidden) return chat.firstPage;
    return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= 48;
  }

  function scrollMessagesToBottom() {
    if (!messageList || messageList.hidden) return;
    applyMessageListScrollTop(messageList.scrollHeight);
  }

  function focusMessageInput() {
    messageInput.focus({ preventScroll: true });
  }

  /** Restore focus only when the result itself removed the user's control. */
  function keepComposerFocus() {
    const active = root.activeElement;
    if (active === null || active === doc.body || active === messageSend) {
      messageInput.focus({ preventScroll: true });
    }
  }

  function showMessageState(kind, { title, body, action = null, retry = false }) {
    messageStateSection.hidden = false;
    messageStateSection.dataset.tone = kind === 'error' ? 'error' : 'unavailable';
    $('#messageStateTitle').textContent = title;
    $('#messageStateBody').textContent = body;
    const actionEl = $('#messageStateAction');
    actionEl.hidden = action === null;
    actionEl.textContent = action?.label ?? '';
    actionEl.onclick = action === null ? null : action.run;
    const retryEl = $('#messageStateRetry');
    retryEl.hidden = retry !== true;
    retryEl.textContent = messagesRetrying ? '正在重试…' : '重试读取';
    retryEl.onclick = retry === true ? retryMessages : null;
    messageList.hidden = true;
    updateMessageListChrome();
  }

  let messagesRetrying = false;

  function retryMessages() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || messagesRetrying || !messagesCapable) return;
    messagesRetrying = true;
    if (chat.historyError && !chat.historyHasMore) {
      // The generic latest retry is also the real re-read entry for a first
      // page that never supplied a usable older cursor.
      chat.historyRetryPending = true;
      chat.historyRetrying = true;
    }
    chat.freshness = 'loading';
    renderMessageList();
    requestMessages(peerId, true);
  }

  function retryHistoryBoundary() {
    const peerId = contactsState.selectedPeerId;
    if (!peerId || !messagesCapable || chat.historyRetrying || chat.loadingOlder) return;
    if (chat.historyHasMore && chat.historyCursor) {
      requestOlderMessages();
      return;
    }
    // No usable cursor exists, so an older request would be meaningless. Re-read
    // the latest page once, on explicit user action only.
    chat.historyRetrying = true;
    chat.historyRetryPending = true;
    chat.olderError = '';
    updateMessageListChrome();
    requestMessages(peerId, true);
  }

  function updateMessageListChrome() {
    if (messageFocusNote) {
      messageFocusNote.textContent = chat.focusNotice || '';
      messageFocusNote.hidden = !chat.focusNotice;
    }
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    const state = currentMessageState();
    const stale = state.kind === 'ready' && (Boolean(chat.error) || chat.freshness !== 'live');
    let staleText = '';
    if (stale) {
      if (chat.error) staleText = `消息可能不是最新（${chat.at > 0 ? formatRelative(chat.at) : '读取时间未知'}）。最近一次刷新失败，可以重试。`;
      else staleText = `消息可能不是最新（${chat.at > 0 ? formatRelative(chat.at) : '读取时间未知'}）。实时更新恢复后会自动刷新。`;
    }
    messageStale.textContent = staleText;
    messageStale.hidden = staleText.length === 0;
    messageRetry.hidden = !(stale && messagesCapable);
    messageRetry.textContent = messagesRetrying ? '正在重试…' : '重试读取消息';
    messageRetry.onclick = messagesCapable ? retryMessages : null;
    const restoreActionVisible = Boolean(chat.anchorMissing)
      && messagesCapable
      && chat.historyHasMore
      && !chat.historyError;
    // When the dedicated anchor-recovery entry is available, it replaces the
    // generic load-older button so the constrained panel keeps room for the
    // message scroller. If recovery is not possible, load-older stays as-is.
    loadOlder.hidden = !(state.kind === 'ready' && chat.historyHasMore && messagesCapable && !restoreActionVisible);
    loadOlder.textContent = chat.loadingOlder
      ? '正在读取更早消息…'
      : (chat.historyError && chat.historyRetryMode === 'older' ? '重试加载更早消息' : '加载更早消息');
    loadOlder.setAttribute('aria-disabled', String(chat.loadingOlder));
    loadOlder.setAttribute('aria-busy', String(chat.loadingOlder));
    loadOlder.onclick = requestOlderMessages;
    const historyRetryVisible = Boolean(chat.historyError)
      && messagesCapable
      && loadOlder.hidden
      && state.kind !== 'loading';
    messageHistoryRetry.hidden = !historyRetryVisible;
    messageHistoryRetry.textContent = chat.historyRetrying
      ? '正在重新读取…'
      : (chat.historyRetryMode === 'older' ? '重试加载更早消息' : '重新读取历史');
    messageHistoryRetry.setAttribute('aria-disabled', String(chat.historyRetrying));
    messageHistoryRetry.setAttribute('aria-busy', String(chat.historyRetrying));
    messageHistoryRetry.onclick = historyRetryVisible && !chat.historyRetrying ? retryHistoryBoundary : null;
    const olderText = chat.olderError || chat.historyError;
    messageOlderError.textContent = olderText;
    messageOlderError.hidden = olderText.length === 0;
    let restoreText = '';
    if (chat.anchorMissing) {
      if (chat.restoreLoading) {
        restoreText = `正在继续加载更早消息以定位上次阅读位置…（已加载 ${chat.items.length} 条）`;
      } else if (chat.historyHasMore) {
        restoreText = '上次阅读的位置在更早的消息中；可以继续加载更早消息，或直接定位到上次阅读位置。';
      } else if (chat.historyError) {
        restoreText = '上次阅读的位置暂时无法确认；恢复历史读取后再试，或留在最新消息。';
      } else {
        restoreText = '上次阅读的位置不在当前保留的消息中。可以留在最新消息。';
      }
    }
    messageRestoreNote.textContent = restoreText;
    messageRestoreNote.hidden = restoreText.length === 0;
    messageRestoreAction.hidden = !restoreActionVisible;
    messageRestoreAction.textContent = chat.restoreLoading
      ? '正在定位上次阅读位置…'
      : '定位上次阅读位置';
    messageRestoreAction.setAttribute('aria-disabled', String(chat.restoreLoading));
    messageRestoreAction.setAttribute('aria-busy', String(chat.restoreLoading));
    messageRestoreAction.onclick = restoreActionVisible && !chat.restoreLoading
      ? restoreAnchorFromHistory
      : null;
    // Always give the reader an explicit exit from a recovery prompt. This is
    // also the clear signal that removes the old anchor instead of leaving the
    // panel permanently on a stale "older message" position.
    const latestActionVisible = Boolean(chat.anchorMissing) && messagesCapable;
    messageRestoreLatest.hidden = !latestActionVisible;
    messageRestoreLatest.textContent = '留在最新消息';
    messageRestoreLatest.setAttribute('aria-disabled', String(chat.restoreLoading));
    messageRestoreLatest.onclick = latestActionVisible && !chat.restoreLoading
      ? stayAtLatestMessages
      : null;
    messageRestoreActions.hidden = !(restoreActionVisible || latestActionVisible);
    // The retention memo is secondary to the recovery prompt and takes the
    // last row of a constrained conversation panel. Omit it while the reader
    // is deciding between locating the old row and staying at the latest rows.
    if (!chat.anchorMissing && chat.retention && Number(chat.retention.retainedMessages) > 0) {
      const max = Number(chat.retention.maxStoredMessages);
      messageRetention.textContent = `当前保留 ${chat.retention.retainedMessages} 条消息${max > 0 ? `（节点上限 ${max} 条）` : ''}；更早记录可能已被清理，这里不承诺完整历史。`;
      messageRetention.hidden = false;
    } else {
      messageRetention.hidden = true;
    }
  }

  function renderMessageList() {
    if (destroyed) return;
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    messageList.dataset.peerId = peerId;
    const state = currentMessageState();
    if (state.kind !== 'ready') {
      messageList.replaceChildren();
      if (state.kind === 'error' && !chat.error && chat.historyError) {
        // The compact status line and real re-read button above carry this
        // consistency error. Do not render the large empty/error block for it:
        // in the constrained conversation panel that block can push its own
        // explanation out of view and resemble a loading state.
        messageList.hidden = true;
        messageStateSection.hidden = true;
        updateMessageListChrome();
        return;
      }
      if (state.kind === 'loading') {
        showMessageState('loading', {
          title: '正在读取消息…',
          body: '正在从本机节点读取当前保留的消息记录。',
        });
      } else if (state.kind === 'error' || state.kind === 'unavailable') {
        showMessageState('error', {
          title: chat.error ? '这次没有读到消息' : '历史读取没有完成',
          body: `${chat.error || state.error || chat.historyError || '消息读取失败。'}
这不代表当前会话没有消息；可以重试读取。`,
          retry: messagesCapable,
          action: messagesCapable ? null : { label: '查看节点状态', run: () => openDialog(statusDialog, $('#messageStateAction')) },
        });
      } else {
        showMessageState('empty', {
          title: '还没有消息',
          body: '这是当前保留记录中的第一条会话。你可以在下面输入消息开始对话。',
          action: { label: '写第一条消息', run: focusMessageInput },
          retry: false,
        });
      }
      updateMessageListChrome();
      return;
    }

    messageStateSection.hidden = true;
    messageList.hidden = false;
    const active = root.activeElement;
    const activeMessage = active?.closest?.('[data-message-id]')?.dataset.messageId ?? '';
    const activeAction = active?.dataset?.messageAction ?? '';
    const wasAtBottom = isMessageListAtBottom();
    const previousTop = messageList.scrollTop;
    messageList.replaceChildren();
    const ascending = [...state.messages].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return String(a.messageId).localeCompare(String(b.messageId));
    });
    for (const message of ascending) messageList.append(renderMessageRow(message));
    updateMessageListChrome();
    if (activeMessage && activeAction) {
      const target = messageList.querySelector(`[data-message-id="${selectorValue(activeMessage)}"] [data-message-action="${selectorValue(activeAction)}"]`);
      if (target) target.focus({ preventScroll: true });
      else focusMessageInput();
    } else if (activeMessage) {
      // The action was already gone and focus was on the row itself (for
      // example after a successful cancel). Keep the reader's position.
      const row = messageList.querySelector(`[data-message-id="${selectorValue(activeMessage)}"]`);
      if (row) row.focus({ preventScroll: true });
      else focusMessageInput();
    } else if (wasAtBottom) {
      scrollMessagesToBottom();
    } else {
      applyMessageListScrollTop(previousTop);
    }
    if (chat.focusMessageId) {
      const target = messageList.querySelector(`[data-message-id="${selectorValue(chat.focusMessageId)}"]`);
      const focused = root.activeElement;
      const focusIsInsideRow = Boolean(focused?.closest?.('.rm-message'));
      const mayRestore = focused === null || focused === doc.body || focused === messageInput || focusIsInsideRow;
      if (!mayRestore) {
        chat.focusMessageId = '';
      } else if (target) {
        target.focus({ preventScroll: true });
        // Keep the status/action end of the row visible even when a long body
        // or folded error made the row taller than the message scroller.
        const anchor = target.querySelector('.rm-message-actions, .rm-message-meta') ?? target;
        if (typeof anchor.scrollIntoView === 'function') {
          anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        chat.focusMessageId = '';
      }
      // A null target can be a page refresh still in flight; keep the one-shot
      // target until the row appears or the reader moves elsewhere.
    }
  }

  function renderMessageRow(message) {
    const row = element('div', 'rm-message');
    row.dataset.messageId = message.messageId;
    row.dataset.peerId = message.peerId;
    row.dataset.direction = message.direction === 'out' ? 'out' : 'in';
    // Programmatic focus target after an action disappears; not a tab stop.
    row.tabIndex = -1;
    const bubble = element('div', 'rm-message-bubble');
    // Remote text is always text, never HTML or a command.
    bubble.textContent = message.text;
    const meta = element('div', 'rm-message-meta');
    const clock = element('span');
    clock.textContent = messageClock(message.createdAt);
    meta.append(clock);
    if (message.direction === 'out') {
      const status = element('span', 'rm-message-status');
      status.dataset.tone = deliveryStatusTone(message.deliveryStatus);
      status.textContent = deliveryStatusText(message);
      meta.append(status);
      if (message.origin === 'agent') {
        const origin = element('span');
        origin.textContent = 'Agent 发出';
        meta.append(origin);
      }
    }
    row.append(bubble, meta);
    if (message.direction === 'out' && message.deliveryError && ['failed', 'pending', 'unknown'].includes(String(message.deliveryStatus))) {
      // The raw dial/transport text stays available in one independent detail
      // dialog. Keeping it out of the row prevents a cached address list from
      // expanding every message or hiding the cancel action; the message list
      // remains the only scroller in the conversation itself.
      const tech = element('button', 'rm-detail-link rm-message-tech');
      tech.type = 'button';
      tech.dataset.messageAction = 'detail';
      tech.textContent = '投递技术详情';
      tech.setAttribute('aria-haspopup', 'dialog');
      tech.setAttribute('aria-controls', 'technicalDialog');
      tech.onclick = (event) => openMessageDetail(message, event.currentTarget);
      row.append(tech);
    }
    const actions = element('div', 'rm-message-actions');
    if (isCancelable(message) && cancelsCapable) {
      const cancel = element('button', 'rm-quiet');
      cancel.type = 'button';
      cancel.dataset.messageAction = 'cancel';
      cancel.textContent = cancellingIds.has(message.messageId) ? '正在取消…' : '取消待发';
      cancel.setAttribute('aria-disabled', String(cancellingIds.has(message.messageId)));
      cancel.onclick = () => { void cancelPendingMessage(message); };
      actions.append(cancel);
    }
    if (message.direction === 'out' && String(message.deliveryStatus) === 'failed') {
      const retry = element('button', 'rm-quiet');
      retry.type = 'button';
      retry.dataset.messageAction = 'reedit';
      retry.textContent = '重新编辑';
      retry.title = '把这条失败消息放回输入框；再次发送会创建一条新消息';
      retry.onclick = () => restoreMessageText(message);
      actions.append(retry);
    }
    if (actions.childElementCount > 0) row.append(actions);
    return row;
  }

  async function cancelPendingMessage(message) {
    if (!cancelsCapable || cancellingIds.has(message.messageId)) return;
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    const activeBefore = root.activeElement;
    const rowSelector = `[data-message-id="${selectorValue(message.messageId)}"]`;
    // A real mouse click focuses the cancel button. Remember that the user was
    // operating this row so a successful cancel can keep focus in the message
    // list instead of dropping it into the composer or the document body.
    const restoreRowFocus = activeBefore === messageList.querySelector(rowSelector)
      || Boolean(activeBefore?.closest?.(rowSelector));
    const activeTask = taskFor(peerId);
    const taskRequestId = activeTask && taskMatchesMessage(activeTask, message) ? activeTask.requestId : '';
    cancellingIds.add(message.messageId);
    setComposerNotice(peerId, '正在取消这条待发消息…', 'pending', '', { taskRequestId, kind: 'cancel-progress' });
    renderMessageList();
    try {
      const value = await options.onCancelOutbox(peerId, message.messageId);
      if (destroyed || contactsState.selectedPeerId !== peerId) return;
      if (value && value.ok === true) {
        // Keep the composer's task projection honest if the cancelled row is
        // the message this task belongs to. Do not touch a newer send task.
        const current = taskFor(peerId);
        if (current && taskMatchesMessage(current, message)) {
          current.unknown = false;
          current.outcomeStatus = 'cancelled';
          current.outcome = sendOutcome({ ok: true, deliveryStatus: 'cancelled' });
          if (!current.messageId) current.messageId = message.messageId;
        }
        setComposerNotice(peerId, '已取消这条待发消息；不会再自动重试。', 'muted', '', { taskRequestId, kind: 'cancel-success' });
      } else {
        setComposerNotice(
          peerId,
          '取消没有完成；这条消息可能仍会继续自动重试。',
          'error',
          typeof value?.error === 'string' ? value.error : '',
          { taskRequestId, kind: 'cancel-failure' },
        );
      }
    } catch (error) {
      if (!destroyed && contactsState.selectedPeerId === peerId) {
        setComposerNotice(
          peerId,
          '取消没有完成；这条消息可能仍会继续自动重试。',
          'error',
          errorText(error),
          { taskRequestId, kind: 'cancel-failure' },
        );
      }
    } finally {
      cancellingIds.delete(message.messageId);
      if (!destroyed) {
        if (restoreRowFocus) chat.focusMessageId = message.messageId;
        renderMessageList();
        requestMessages(peerId, true);
      }
    }
  }

  function restoreMessageText(message) {
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    if (messageInput.value.trim().length > 0) {
      setComposerNotice(peerId, '输入框里已有新内容，未覆盖。再次发送会创建一条新消息。', 'muted');
      focusMessageInput();
      return;
    }
    messageInput.value = message.text;
    persistDraft(peerId, messageInput.value);
    updateComposerMeta();
    setComposerNotice(peerId, '已放回输入框。再次发送会创建一条新消息，不会复用之前的消息 ID。', 'muted');
    focusMessageInput();
  }

  function newRequestId() {
    const crypto = win.crypto ?? globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function taskFor(peerId) {
    return sendTasks.get(peerId) ?? null;
  }

  const TERMINAL_DELIVERY_STATUSES = new Set(['acked', 'failed', 'cancelled']);

  function deliveryStatusOf(message) {
    return String(message?.deliveryStatus ?? (message?.acked ? 'acked' : 'unknown'));
  }

  /**
   * Match a send task to its persisted row by the stable idempotency key.
   * requestId is preferred; the messageId returned by the daemon is the only
   * fallback. Never use another message (for example "the latest row") because
   * that would copy an unrelated delivery state into the composer.
   */
  function messageForTask(task) {
    if (!task || task.peerId !== contactsState.selectedPeerId) return null;
    const rows = Array.isArray(chat.items) ? chat.items : [];
    if (task.requestId) {
      const byRequest = rows.find((row) => row
        && row.peerId === task.peerId
        && row.direction === 'out'
        && row.clientRequestId
        && row.clientRequestId === task.requestId);
      if (byRequest) return byRequest;
    }
    if (task.messageId) {
      return rows.find((row) => row
        && row.peerId === task.peerId
        && row.direction === 'out'
        && row.messageId === task.messageId) ?? null;
    }
    return null;
  }

  function taskMatchesMessage(task, message) {
    if (!task || !message || message.peerId !== task.peerId) return false;
    if (task.requestId && message.clientRequestId && message.clientRequestId === task.requestId) return true;
    return Boolean(task.messageId && message.messageId && message.messageId === task.messageId);
  }

  /**
   * Copy only the current persisted state for this exact send task. Terminal
   * states replace an older pending/unknown outcome (and drop its stale raw
   * error); a non-terminal page never downgrades a terminal result.
   */
  function applyPersistedTaskState(task, found) {
    if (!task || !found) return false;
    const status = deliveryStatusOf(found);
    const previous = String(task.outcomeStatus ?? '');
    const terminal = TERMINAL_DELIVERY_STATUSES.has(status);
    // A persisted row resolves an ambiguous RPC even when its own evidence is
    // still unknown; pending/terminal states are the normal advancement paths.
    if (!terminal && status !== 'pending' && !(status === 'unknown' && task.unknown)) return false;
    if (!terminal && previous === status) return false;
    if (TERMINAL_DELIVERY_STATUSES.has(previous) && !terminal) return false;
    const error = typeof found.deliveryError === 'string' ? found.deliveryError : '';
    task.outcome = sendOutcome({
      ok: true,
      replayed: false,
      deliveryStatus: status,
      acked: found.acked === true || status === 'acked',
      error,
    });
    task.outcomeStatus = status;
    task.unknown = false;
    if (!task.messageId) task.messageId = String(found.messageId ?? '');
    if (!terminal) return true;
    // A cancel-in-progress notice or a cancel failure that is superseded by an
    // ACK must not keep masking the newly persisted terminal state.
    if (composerNotice
      && composerNotice.peerId === task.peerId
      && composerNotice.taskRequestId === task.requestId
      && (composerNotice.kind === 'cancel-progress'
        || (composerNotice.kind === 'cancel-success' && status !== 'cancelled')
        || (composerNotice.kind === 'cancel-failure' && status === 'acked'))) {
      composerNotice = null;
    }
    return true;
  }

  function normalizedDiagnostic(value) {
    return String(value ?? '').trim().replace(/^dial for outbox:\s*/i, '');
  }

  /** One diagnostic may be a truncated/prefix-tagged copy of the other. */
  function sameDiagnostic(left, right) {
    const a = normalizedDiagnostic(left);
    const b = normalizedDiagnostic(right);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const shorter = Math.min(a.length, b.length);
    if (shorter < 80) return false;
    let shared = 0;
    while (shared < shorter && a[shared] === b[shared]) shared += 1;
    return shared / shorter >= 0.6;
  }

  /** The persisted row owns its raw delivery error; do not print it twice. */
  function composerDetailForTask(task) {
    const detail = composerDetailText.trim();
    if (!detail) return '';
    const found = messageForTask(task);
    const persisted = typeof found?.deliveryError === 'string' ? found.deliveryError.trim() : '';
    if (persisted && sameDiagnostic(detail, persisted)) return '';
    return detail;
  }

  function updateComposerDetail(task = null) {
    const value = task ?? (contactsState.selectedPeerId ? taskFor(contactsState.selectedPeerId) : null);
    composerTech.hidden = composerDetailForTask(value).length === 0;
  }

  function applyComposerStatus(text, tone = '', detail = '') {
    const value = String(text || '');
    composerStatus.textContent = value;
    if (tone) composerStatus.dataset.tone = tone;
    else composerStatus.removeAttribute('data-tone');
    composerDetailText = typeof detail === 'string' ? detail.trim() : '';
    updateComposerDetail();
  }

  function setComposerNotice(peerId, text, tone = '', detail = '', meta = {}) {
    composerNotice = {
      peerId,
      text: String(text || ''),
      tone,
      detail: String(detail || ''),
      taskRequestId: String(meta.taskRequestId || ''),
      kind: String(meta.kind || ''),
    };
    if (contactsState.selectedPeerId === peerId) {
      applyComposerStatus(composerNotice.text, tone, composerNotice.detail);
    }
  }

  function openTechnicalDetail({ title, intro, raw, trigger = null, messageId = '' }) {
    const text = String(raw || '').trim();
    if (!text) return;
    technicalHeading.textContent = String(title || '技术详情');
    technicalIntro.textContent = String(intro || '');
    technicalIntro.hidden = technicalIntro.textContent.length === 0;
    technicalRaw.textContent = text;
    technicalRaw.scrollTop = 0;
    if (technicalRaw.setSelectionRange) technicalRaw.setSelectionRange(0, 0);
    technicalReturn = { messageId: String(messageId || '') };
    openDialog(technicalDialog, trigger ?? root.activeElement ?? doc.activeElement);
  }

  function openComposerDetail() {
    const peerId = contactsState.selectedPeerId;
    const task = peerId ? taskFor(peerId) : null;
    const detail = composerDetailForTask(task);
    if (!detail) return;
    openTechnicalDetail({
      title: '发送技术详情',
      intro: '最近一次发送的原始错误。它只用于排查本机投递尝试；当前投递状态以上方状态和对应消息为准。',
      raw: detail,
      trigger: composerTech,
    });
  }

  function openMessageDetail(message, trigger) {
    const detail = typeof message?.deliveryError === 'string' ? message.deliveryError.trim() : '';
    if (!detail) return;
    const status = deliveryStatusText(message);
    openTechnicalDetail({
      title: '投递技术详情',
      intro: `这条消息在本机记录的状态：${status}。原始错误只说明本机投递尝试，不代表对端已经收到或没有收到。`,
      raw: detail,
      trigger,
      messageId: String(message.messageId || ''),
    });
  }

  function technicalFocusFallback() {
    const messageId = technicalReturn?.messageId;
    if (messageId) {
      const row = messageList.querySelector(`[data-message-id="${selectorValue(messageId)}"]`);
      const action = row?.querySelector('[data-message-action="detail"]');
      if (action) return action;
      if (row) return row;
    }
    return composerTech.hidden ? null : composerTech;
  }

  function updateComposerMeta() {
    if (destroyed) return;
    const limit = Number(nodeState.status?.maxChatTextBytes) > 0 ? Number(nodeState.status.maxChatTextBytes) : 4096;
    const bytes = countTextBytes(messageInput.value);
    const over = bytes > limit;
    messageCounter.textContent = `${bytes} / ${limit} 字节`;
    messageCounter.dataset.over = String(over);
    const peerId = contactsState.selectedPeerId;
    const task = peerId ? taskFor(peerId) : null;
    const empty = messageInput.value.trim().length === 0;
    messageSend.setAttribute('aria-disabled', String(Boolean(task?.sending) || over || empty || !sendsCapable));
    messageSend.title = !sendsCapable
      ? '发送暂不可用'
      : task?.sending ? '正在发送…'
        : over ? '消息超过节点字节限制'
          : empty ? '请输入消息' : '发送消息';
    sendReconcile.hidden = !(task && task.unknown && !task.sending && sendsCapable);
    sendRestore.hidden = !(task && !task.sending && task.outcome?.tone === 'error' && task.outcome?.title === '发送失败');
    updateComposerDetail(task);
  }

  function renderComposer() {
    if (destroyed) return;
    updateComposerMeta();
    const peerId = contactsState.selectedPeerId;
    composer.hidden = !sendsCapable;
    const task = peerId ? taskFor(peerId) : null;
    if (composerNotice && composerNotice.peerId === peerId) {
      applyComposerStatus(composerNotice.text, composerNotice.tone, composerNotice.detail);
    } else if (task?.sending) {
      applyComposerStatus('正在发送…', 'pending', '');
    } else if (task?.outcome) {
      applyComposerStatus(
        `${task.outcome.title}。${task.outcome.body || ''}`,
        task.outcome.tone,
        task.outcome.detail || '',
      );
    } else {
      applyComposerStatus('', '', '');
    }
  }

  function validateMessage(text) {
    if (text.trim().length === 0) return '请输入消息。';
    const limit = Number(nodeState.status?.maxChatTextBytes) > 0 ? Number(nodeState.status.maxChatTextBytes) : 4096;
    const bytes = countTextBytes(text);
    if (bytes > limit) return `消息太长了：${bytes} 字节，当前节点上限 ${limit} 字节。请缩短后再发送。`;
    return '';
  }

  async function submitMessage({ reconcile = false } = {}) {
    if (destroyed || !sendsCapable) return;
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    let task = taskFor(peerId);
    if (task?.sending) return;
    let text;
    let requestId;
    if (reconcile) {
      if (!task || !task.unknown || task.sending) return;
      text = task.text;
      requestId = task.requestId;
    } else {
      text = messageInput.value;
      const invalid = validateMessage(text);
      if (invalid) {
        setComposerNotice(peerId, invalid, 'error');
        focusMessageInput();
        updateComposerMeta();
        return;
      }
      requestId = newRequestId();
      // Clear only the submitted draft. Text typed while this send is in
      // flight remains the user's new draft and is never cleared by the
      // eventual result.
      if (messageInput.value === text) {
        messageInput.value = '';
        persistDraft(peerId, '');
      }
    }
    if (!text.trim() || !requestId) return;
    const attempt = ++sendSeq;
    task = {
      peerId,
      text,
      requestId,
      messageId: '',
      attempt,
      sending: true,
      unknown: false,
      outcome: null,
      outcomeStatus: '',
    };
    sendTasks.set(peerId, task);
    composerNotice = null;
    updateComposerMeta();
    renderComposer();
    let result;
    try {
      result = await options.onSend(peerId, text, requestId);
    } catch (error) {
      result = {
        ok: false,
        unknown: true,
        invalid: false,
        error: '这次发送没有收到节点结果，消息可能已经保存。请先核对，不要直接重发。',
        detail: errorText(error),
      };
    }
    if (destroyed) return;
    const current = taskFor(peerId);
    if (!current || current.attempt !== attempt) return;
    current.sending = false;
    if (!result || typeof result !== 'object') {
      result = { ok: false, unknown: true, error: '没有收到发送结果。' };
    }
    current.messageId = String(result.messageId ?? current.messageId ?? '');
    const resultStatus = String(result.deliveryStatus ?? (result.unknown === true ? 'unknown' : 'unknown'));
    // A page read may already have observed the persisted terminal state while
    // this RPC was in flight. Its older pending/failed response must not
    // regress an ACK that the daemon already recorded.
    const keepTerminal = TERMINAL_DELIVERY_STATUSES.has(String(current.outcomeStatus ?? ''))
      && !TERMINAL_DELIVERY_STATUSES.has(resultStatus);
    if (result.invalid || (result.ok !== true && result.unknown !== true)) {
      current.unknown = false;
      current.outcome = sendOutcome(result);
      current.outcomeStatus = '';
      // A locally rejected send never became a message: put the body back if
      // the user has not started a new draft.
      if (messageInput.value.length === 0 && current.text !== '') {
        messageInput.value = current.text;
        persistDraft(peerId, messageInput.value);
      }
    } else if (result.ok !== true) {
      current.unknown = !keepTerminal;
      if (!keepTerminal) {
        current.outcome = sendOutcome(result);
        current.outcomeStatus = 'unknown';
      }
    } else {
      current.unknown = false;
      // The daemon only returns ok after it persisted the outbound row; the
      // same transaction records the human relation. A pending row therefore
      // qualifies immediately, without waiting for an ACK.
      markHumanOutboundPersisted();
      if (!keepTerminal) {
        current.outcome = sendOutcome(result);
        current.outcomeStatus = resultStatus;
      }
      if (!keepTerminal && resultStatus === 'failed' && messageInput.value.length === 0) {
        // The failed message is already persisted. Put its text back in the
        // editable draft only when the user has not started a new one; a
        // resend creates a clearly labelled new message.
        messageInput.value = current.text;
        persistDraft(peerId, messageInput.value);
      }
    }
    composerNotice = null;
    if (contactsState.selectedPeerId === peerId) {
      renderComposer();
      keepComposerFocus();
    }
    updateComposerMeta();
    if (contactsState.selectedPeerId === peerId) requestMessages(peerId, true);
  }

  function restoreFailedText() {
    const peerId = contactsState.selectedPeerId;
    const task = peerId ? taskFor(peerId) : null;
    if (!peerId || !task || task.sending) return;
    if (messageInput.value.trim().length > 0) {
      setComposerNotice(peerId, '输入框里已有新内容，未覆盖。', 'muted');
      focusMessageInput();
      return;
    }
    messageInput.value = task.text;
    persistDraft(peerId, messageInput.value);
    updateComposerMeta();
    setComposerNotice(peerId, '已放回输入框。再次发送会创建一条新消息。', 'muted');
    focusMessageInput();
  }

  function conversationStateText(state) {
    return conversationStatusLabel(state);
  }

  function fillConversationRow(row, item) {
    const peerId = item.peerId;
    row.dataset.conversationRow = peerId;
    row.className = 'rm-conversation rm-conversation-row';
    const friend = item.friend;
    const name = friend ? contactDisplayName(friend) : shortPeer(peerId);
    const summary = conversationSummaryText(item);
    const status = conversationStatusLabel(item);
    const avatar = row.querySelector(':scope > button[data-profile-peer]') ?? element('button', 'rm-contact-avatar rm-avatar-button');
    avatar.type = 'button';
    avatar.dataset.profilePeer = peerId;
    avatar.dataset.profileRef = `messages:${peerId}`;
    avatar.dataset.focusKey = `conversation-avatar:${peerId}`;
    avatar.setAttribute('aria-label', `查看 ${name} 的档案`);
    avatar.textContent = friend ? contactInitial(friend) : '?';
    const main = row.querySelector(':scope > button[data-conversation-peer]') ?? element('button', 'rm-conversation-main');
    main.type = 'button';
    main.dataset.conversationPeer = peerId;
    main.dataset.focusKey = `conversation:${peerId}`;
    main.setAttribute('aria-label', `${name}。${summary}。${status}。打开会话`);
    const copy = element('span', 'rm-conversation-copy');
    const top = element('span', 'rm-conversation-top');
    const title = element('b');
    title.textContent = name;
    const time = element('span', 'rm-conversation-time');
    time.textContent = item.hasMessages ? messageTimeText(item.lastAt) : '';
    top.append(title, time);
    const preview = element('span', 'rm-conversation-preview');
    preview.textContent = summary;
    const meta = element('span', 'rm-conversation-meta');
    const id = element('code', 'rm-peer-id');
    id.textContent = shortPeer(peerId);
    id.title = peerId;
    const badge = element('span', 'rm-conversation-status');
    badge.dataset.tone = conversationStatusTone(item);
    badge.textContent = status;
    meta.append(id, badge);
    copy.append(top, preview, meta);
    main.replaceChildren(copy);
    if (row.firstElementChild !== avatar || row.lastElementChild !== main || row.childElementCount !== 2) {
      row.replaceChildren(avatar, main);
    }
  }

  function conversationRow(item) {
    return element('div', 'rm-conversation');
  }

  function reconcileConversationList(items) {
    const active = root.activeElement;
    const activeRow = active?.closest?.('[data-conversation-row]') ?? null;
    const activePeer = activeRow?.dataset.conversationRow ?? '';
    const activeWasAvatar = Boolean(active?.dataset?.profilePeer);
    const rowsBefore = [...conversationList.querySelectorAll('[data-conversation-row]')];
    const activeIndex = activeRow ? rowsBefore.indexOf(activeRow) : -1;
    const listScroll = conversationList.scrollTop;
    const pageScroll = pageEls.messages.scrollTop;
    const existing = new Map(rowsBefore.map((row) => [row.dataset.conversationRow, row]));
    let previous = null;
    for (const item of items) {
      let row = existing.get(item.peerId);
      if (row) existing.delete(item.peerId);
      else row = conversationRow(item);
      fillConversationRow(row, item);
      if (previous === null) {
        if (conversationList.firstElementChild !== row) conversationList.insertBefore(row, conversationList.firstElementChild);
      } else if (previous.nextElementSibling !== row) {
        conversationList.insertBefore(row, previous.nextElementSibling);
      }
      previous = row;
    }
    for (const row of existing.values()) row.remove();
    const rowsAfter = [...conversationList.querySelectorAll('[data-conversation-row]')];
    const target = activePeer ? rowsAfter.find((row) => row.dataset.conversationRow === activePeer) : null;
    if (target) {
      const focusTarget = activeWasAvatar
        ? target.querySelector('button[data-profile-peer]')
        : target.querySelector('button[data-conversation-peer]');
      if (focusTarget && root.activeElement !== focusTarget) focusTarget.focus({ preventScroll: true });
    } else if (activeRow) {
      const fallback = rowsAfter[Math.min(Math.max(activeIndex, 0), rowsAfter.length - 1)] ?? null;
      (fallback?.querySelector('button[data-conversation-peer]') ?? conversationQuery).focus({ preventScroll: true });
    }
    if (conversationList.scrollTop !== listScroll) conversationList.scrollTop = listScroll;
    if (pageEls.messages.scrollTop !== pageScroll) pageEls.messages.scrollTop = pageScroll;
  }

  function showConversationState(kind, { title, body, primary = null, retry = false, stale = false }) {
    messagesStateSection.hidden = false;
    messagesStateSection.dataset.tone = kind === 'error' ? 'error' : 'unavailable';
    $('#messagesStateTitle').textContent = title;
    $('#messagesStateBody').textContent = body;
    const action = $('#messagesStateAction');
    action.hidden = primary === null;
    action.textContent = primary?.label ?? '';
    action.onclick = primary === null ? null : primary.run;
    const retryEl = $('#messagesStateRetry');
    retryEl.hidden = retry !== true;
    retryEl.textContent = conversationsRetrying ? '正在重试…' : '重试读取';
    retryEl.onclick = retry ? retryConversations : null;
    conversationList.hidden = true;
    conversationsMeta.hidden = true;
    conversationsMetaRetry.hidden = true;
    if (stale) {
      conversationsMeta.hidden = false;
      conversationsMeta.textContent = '下面是上次成功读取的结果，可能不是最新。';
    }
  }

  function updateConversationIndexState() {
    if (destroyed) return;
    const query = conversationQuery.value;
    view.pages.messages.query = query;
    const state = conversationListState({
      conversations: conversationsState.data,
      contacts: contactsState.data,
      query,
      error: conversationsState.transportError,
      contactsError: contactsState.transportError,
    });
    if (state.kind === 'ready') {
      const active = root.activeElement;
      const inState = messagesStateSection.contains(active);
      messagesStateSection.hidden = true;
      conversationList.hidden = false;
      reconcileConversationList(state.items);
      const staleText = state.error
        ? `最近消息可能不是最新（${state.at > 0 ? formatRelative(state.at) : '读取时间未知'}）。最近一次读取失败，可以重试。`
        : state.stale
          ? `会话可能不是最新（${state.at > 0 ? formatRelative(state.at) : '读取时间未知'}）。实时更新恢复后会自动刷新。`
          : '';
      conversationsMeta.textContent = staleText;
      conversationsMeta.hidden = staleText.length === 0;
      conversationsMetaRetry.hidden = !(staleText && conversationsCapable);
      conversationsMetaRetry.textContent = conversationsRetrying ? '正在重试…' : '重试读取';
      conversationsMetaRetry.onclick = conversationsCapable ? retryConversations : null;
      if (inState) (conversationList.querySelector('button[data-conversation-peer]') ?? conversationQuery).focus({ preventScroll: true });
      return;
    }
    conversationList.replaceChildren();
    if (state.kind === 'search-empty') {
      showConversationState('search-empty', {
        title: '没有找到匹配的会话',
        body: `没有联系人或消息匹配“${query.trim()}”。`,
        primary: { label: '清除搜索', run: clearConversationSearch },
        retry: state.stale,
        stale: state.stale,
      });
      return;
    }
    if (state.kind === 'loading') {
      showConversationState('loading', {
        title: '正在读取对话…',
        body: '正在从本机节点读取当前保留的会话和消息记录。',
      });
      return;
    }
    if (state.kind === 'error') {
      showConversationState('error', {
        title: '这次没有读到对话',
        body: `${state.error || '会话列表读取失败。'}
这不代表没有对话；可以重试读取。`,
        primary: conversationsCapable ? { label: conversationsRetrying ? '正在重试…' : '重试读取', run: retryConversations } : null,
        retry: false,
        stale: state.at > 0,
      });
      return;
    }
    showConversationState('empty', {
      title: '还没有会话',
      body: '打开联系人就可以开始对话，不需要先有消息记录。',
      primary: { label: '去联系人', run: () => { showPage('contacts'); contactQuery.focus({ preventScroll: true }); } },
      retry: state.stale && conversationsCapable,
      stale: state.stale,
    });
  }

  function clearConversationSearch() {
    conversationQuery.value = '';
    view.pages.messages.query = '';
    updateConversationIndexState();
    saveNow();
    conversationQuery.focus();
  }

  function retryConversations() {
    if (!conversationsCapable || conversationsRetrying || destroyed) return;
    conversationsRetrying = true;
    updateConversationIndexState();
    let pending;
    try {
      pending = options.onLoadConversations(true);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void Promise.resolve(pending)
      .catch((error) => { if (!destroyed) setConversationsError(error); })
      .finally(() => {
        if (destroyed) return;
        conversationsRetrying = false;
        updateConversationIndexState();
      });
  }

  function setConversations(value) {
    if (destroyed || value === null || typeof value !== 'object') return;
    const previousAt = Number(conversationsState.data?.at) > 0 ? Number(conversationsState.data.at) : 0;
    const nextAt = Number(value.at) > 0 ? Number(value.at) : 0;
    if (nextAt > 0 && previousAt > 0 && nextAt < previousAt) return;
    conversationsState.data = value;
    conversationsState.transportError = '';
    updateConversationIndexState();
  }

  function setConversationsError(error) {
    if (destroyed) return;
    conversationsState.transportError = errorText(error) || '会话列表读取失败';
    updateConversationIndexState();
  }

  function hideAddFeedback() {
    addContactFeedback.hidden = true;
    addContactFeedbackContact.hidden = true;
    addContactFeedbackStatus.hidden = true;
    addContactFeedbackDetail.hidden = true;
    addContactCheck.hidden = true;
  }

  function showAddFeedback(view) {
    addContactFeedback.hidden = false;
    addContactFeedback.dataset.tone = view.tone || 'partial';
    addContactFeedbackTitle.textContent = view.title || '连接结果';
    addContactFeedbackBody.textContent = view.body || '';
    addContactFeedbackContact.hidden = !view.contactNote;
    addContactFeedbackContact.textContent = view.contactNote || '';
    addContactFeedbackStatus.hidden = !view.statusNote;
    addContactFeedbackStatus.textContent = view.statusNote || '';
    addContactFeedbackDetail.hidden = !view.detail;
    addContactFeedbackRaw.textContent = view.detail || '';
    addContactCheck.hidden = view.showCheck !== true;
    addContactCheck.removeAttribute('aria-disabled');
    addContactCheck.textContent = '重试核对联系人';
    addContactView.hidden = view.showViewContacts !== true;
  }

  function nextAddContactAction() {
    if (!addContactView.hidden) return addContactView;
    if (!addContactCheck.hidden) return addContactCheck;
    if (!addContactSubmit.hidden) return addContactSubmit;
    return addContactInput;
  }

  /**
   * Keep keyboard users inside the open add-contact dialog when a request
   * removes or blurs the control they were using. Native `disabled` removes
   * focus in real browsers, so the request state is expressed with
   * `aria-disabled`/`readonly` and duplicates are guarded in the submit
   * handler. If the user moved to another control while waiting, leave it
   * alone: a late result must not steal focus back.
   */
  function restoreAddContactFocus(view) {
    if (destroyed || !addContactDialog.open) return;
    const active = root.activeElement;
    const lost = active === null || active === doc.body;
    if (view.tone === 'invalid') {
      if (lost || active === addContactSubmit || active === addContactCheck) {
        addContactInput.focus({ preventScroll: true });
      }
      return;
    }
    const hidden = (active === addContactSubmit && addContactSubmit.hidden)
      || (active === addContactCheck && addContactCheck.hidden);
    if (!lost && !hidden) return;
    nextAddContactAction().focus({ preventScroll: true });
  }

  function setAddContactBusy(busy) {
    addContactPending = busy;
    addContactInput.readOnly = busy;
    if (busy) {
      addContactSubmit.setAttribute('aria-disabled', 'true');
    } else {
      addContactSubmit.removeAttribute('aria-disabled');
    }
  }

  function resetAddContact({ keepInput = false } = {}) {
    addAttempt += 1;
    checkAttempt += 1;
    addContactPeerId = '';
    addContactPending = false;
    checkPending = false;
    if (!keepInput) addContactInput.value = '';
    addContactInput.disabled = false;
    addContactInput.readOnly = false;
    addContactSubmit.hidden = false;
    addContactSubmit.disabled = false;
    addContactSubmit.removeAttribute('aria-disabled');
    addContactSubmit.textContent = '连接';
    addContactCheck.disabled = false;
    addContactCheck.removeAttribute('aria-disabled');
    addContactView.hidden = true;
    hideAddFeedback();
  }

  function openAddDialog(trigger) {
    resetAddContact();
    openDialog(addContactDialog, trigger);
    addContactInput.focus({ preventScroll: true });
  }

  async function submitAddContact(event) {
    event.preventDefault();
    if (destroyed || addContactPending) return;
    const value = addContactInput.value.trim();
    if (value.length === 0) {
      showAddFeedback({
        tone: 'invalid',
        title: '请输入 Peer ID 或完整节点地址',
        body: '请先填写 Peer ID 或完整节点地址。',
      });
      addContactInput.focus();
      return;
    }
    if (typeof options.onConnect !== 'function') {
      showAddFeedback({
        tone: 'error',
        title: '现在还不能连接联系人',
        body: '这个入口暂时无法发起连接，请稍后再试。',
      });
      return;
    }
    const attempt = ++addAttempt;
    addContactPeerId = '';
    setAddContactBusy(true);
    addContactSubmit.textContent = '正在连接…';
    addContactView.hidden = true;
    addContactCheck.hidden = true;
    addContactFeedback.hidden = false;
    addContactFeedback.dataset.tone = 'info';
    addContactFeedbackTitle.textContent = '正在连接…';
    addContactFeedbackBody.textContent = '正在等待节点返回结果。这可能需要一些时间。';
    addContactFeedbackContact.hidden = true;
    addContactFeedbackStatus.hidden = true;
    addContactFeedbackDetail.hidden = true;

    let result;
    try {
      result = await options.onConnect(value);
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (destroyed || attempt !== addAttempt || !addContactDialog.open) return;

    const view = connectOutcome(result);
    setAddContactBusy(false);
    if (result?.ok === true) {
      addContactPeerId = String(result.peerId ?? '');
      // Keep the field focusable but non-editable after success. Switching it
      // to `disabled` would drop focus to the document body in Chromium.
      addContactInput.readOnly = true;
      addContactSubmit.hidden = true;
      addContactInput.disabled = false;
    } else {
      addContactInput.disabled = false;
      addContactInput.readOnly = false;
      addContactSubmit.textContent = view.showRetry ? '重试连接' : '连接';
    }
    showAddFeedback(view);
    restoreAddContactFocus(view);
  }

  async function checkContactAgain() {
    if (!addContactPeerId || checkPending || typeof options.onCheckContact !== 'function') return;
    const attempt = ++checkAttempt;
    checkPending = true;
    addContactCheck.setAttribute('aria-disabled', 'true');
    addContactCheck.textContent = '正在核对…';
    let result;
    try {
      result = await options.onCheckContact(addContactPeerId);
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (destroyed || attempt !== checkAttempt || !addContactDialog.open) return;
    checkPending = false;
    addContactCheck.removeAttribute('aria-disabled');
    if (result && result.contacts) setContacts(result.contacts);
    const view = contactCheckOutcome(result);
    showAddFeedback(view);
    addContactView.hidden = view.showViewContacts !== true;
    addContactCheck.hidden = view.showViewContacts === true;
    restoreAddContactFocus(view);
  }

  function viewNewContact() {
    const peerId = addContactPeerId;
    closeDialog(addContactDialog, { restoreFocus: false });
    contactQuery.value = '';
    view.pages.contacts.query = '';
    showPage('contacts');
    updateContactsState();
    saveNow();
    const rows = [...contactList.querySelectorAll('button[data-contact-peer]')];
    const row = rows.find((item) => item.dataset.contactPeer === peerId);
    if (row) {
      row.scrollIntoView?.({ block: 'nearest' });
      row.focus({ preventScroll: true });
    } else {
      $('#addContact').focus({ preventScroll: true });
    }
  }

  function resetShareDialog() {
    shareAttempt += 1;
    currentShare = null;
    shareLoading.hidden = false;
    shareContent.hidden = true;
    shareFailure.hidden = true;
    shareFailureDetail.hidden = true;
    shareAddressNote.hidden = true;
    shareStaleNote.hidden = true;
    shareManual.hidden = true;
    shareManual.value = '';
    shareCopyStatus.textContent = '';
    shareCopyStatus.dataset.tone = '';
    shareCopy.disabled = true;
    shareRetry.hidden = true;
  }

  function openShareDialog(trigger) {
    resetShareDialog();
    openDialog(shareDialog, trigger);
    void loadShare();
  }

  async function loadShare() {
    const attempt = ++shareAttempt;
    currentShare = null;
    shareLoading.hidden = false;
    shareContent.hidden = true;
    shareFailure.hidden = true;
    shareFailureDetail.hidden = true;
    shareManual.hidden = true;
    shareCopyStatus.textContent = '';
    shareCopyStatus.dataset.tone = '';
    shareCopy.disabled = true;
    shareRetry.hidden = true;
    let result;
    try {
      result = typeof options.onShare === 'function'
        ? await options.onShare()
        : { ok: false, error: '分享信息暂时不可用。' };
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (destroyed || attempt !== shareAttempt || !shareDialog.open) return;

    if (!result || result.ok !== true) {
      shareLoading.hidden = true;
      shareContent.hidden = true;
      shareFailure.hidden = false;
      shareFailure.dataset.tone = 'error';
      shareFailureBody.textContent = '这次没有读到本机节点信息，请稍后重试。';
      shareFailureRaw.textContent = String(result?.error || '节点没有返回可读的错误。');
      shareFailureDetail.hidden = false;
      shareRetry.hidden = false;
      shareCopy.disabled = true;
      return;
    }

    currentShare = result;
    shareLoading.hidden = true;
    shareContent.hidden = false;
    sharePeerId.textContent = String(result.peerId || '');
    shareAddresses.replaceChildren();
    const addresses = Array.isArray(result.addresses) ? result.addresses : [];
    for (const address of addresses) {
      const item = element('div', 'rm-share-address');
      const code = element('code');
      code.textContent = String(address.multiaddr || '');
      const scope = element('span');
      scope.textContent = addressScopeText(address);
      item.append(code, scope);
      shareAddresses.append(item);
    }
    if (addresses.length === 0) {
      shareAddressNote.textContent = '没有可直接分享的地址。你仍然可以复制 Peer ID；对方可能需要通过地址发现来连接。';
      shareAddressNote.hidden = false;
    } else {
      shareAddressNote.textContent = '这些地址来自本机公告信息。对方能否连接受网络环境影响，私网地址通常只适合同一局域网。';
      shareAddressNote.hidden = false;
    }
    if (result.stale) {
      shareStaleNote.textContent = `这是 ${refreshedText(result.at)} 的读取结果，可能不是最新。可以重试读取。`;
      shareStaleNote.hidden = false;
    } else {
      shareStaleNote.hidden = true;
    }
    shareCopy.disabled = String(result.peerId || '').length === 0;
  }

  async function copyShareInfo() {
    const text = buildShareText(currentShare);
    if (text.length === 0) return;
    shareCopy.disabled = true;
    try {
      if (typeof options.onCopyText !== 'function') throw new Error('复制能力不可用');
      const copied = await options.onCopyText(text);
      if (copied === false) throw new Error('复制能力不可用');
      shareCopyStatus.textContent = '已复制。粘贴给对方即可。';
      shareCopyStatus.dataset.tone = '';
      shareManual.hidden = true;
    } catch {
      shareCopyStatus.textContent = '复制失败，请手动选择下面的内容。';
      shareCopyStatus.dataset.tone = 'error';
      shareManual.value = text;
      shareManual.hidden = false;
      shareManual.focus({ preventScroll: true });
      shareManual.select();
    } finally {
      shareCopy.disabled = !currentShare || String(currentShare.peerId || '').length === 0;
    }
  }

  function setFilter(filter) {
    view.pages.explore.filter = filter === 'familiar' ? 'familiar' : 'all';
    $$('[data-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === view.pages.explore.filter));
    });
    updateExploreState();
    ensureDiscoveriesFresh(false);
    saveNow();
  }

  function setSearchOpen(open, { focus = false } = {}) {
    view.pages.explore.searchOpen = open;
    exploreSearch.hidden = !open;
    exploreSearchToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (focus) exploreQuery.focus();
    } else {
      exploreQuery.value = '';
      view.pages.explore.query = '';
      updateExploreState();
    }
    saveNow();
  }

  function restoreControls() {
    exploreQuery.value = view.pages.explore.query;
    contactQuery.value = view.pages.contacts.query;
    conversationQuery.value = view.pages.messages.query;
    contactsState.selectedPeerId = view.pages.messages.peerId;
    // Restore the chat entry only when the persisted trigger still belongs to
    // the selected conversation; otherwise the back action must not guess a
    // contact or conversation origin it cannot prove.
    const restoredReturnPage = contactsState.selectedPeerId
      && view.pages.messages.returnPeer === contactsState.selectedPeerId
      && (view.pages.messages.returnPage === 'contacts' || view.pages.messages.returnPage === 'messages' || view.pages.messages.returnPage === 'raminga')
      ? view.pages.messages.returnPage
      : '';
    exploreSearch.hidden = !view.pages.explore.searchOpen;
    exploreSearchToggle.setAttribute('aria-expanded', String(view.pages.explore.searchOpen));
    $$('[data-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === view.pages.explore.filter));
    });
    updateExploreState();
    updateContactsState();
    updateConversationIndexState();
    if (contactsState.selectedPeerId) {
      renderConversation();
      if (restoredReturnPage && chat.peerId === contactsState.selectedPeerId) {
        chat.returnPage = restoredReturnPage;
        chat.returnPeer = contactsState.selectedPeerId;
        updateConversationBackLabel(contactsState.selectedPeerId);
      }
      pageEls.messages.scrollTop = 0;
    }
  }

  function openDialog(dialog, trigger) {
    if (destroyed || dialog.open) return;
    dialogTriggers.set(dialog, trigger ?? root.activeElement ?? doc.activeElement);
    dialog.showModal();
    dialog.querySelector('[data-close-dialog]')?.focus({ preventScroll: true });
  }

  function closeDialog(dialog, { restoreFocus = true } = {}) {
    if (!dialog.open) return;
    const trigger = dialogTriggers.get(dialog);
    // A refresh may replace the message row while the detail dialog is open.
    // Resolve the equivalent control (same message) before closing so focus
    // still returns to the reader's source.
    const detailFallback = dialog === technicalDialog ? technicalFocusFallback() : null;
    dialog.close();
    dialogTriggers.delete(dialog);
    if (dialog === technicalDialog) technicalReturn = null;
    if (!restoreFocus) return;
    const triggerAvailable = Boolean(trigger?.isConnected && !trigger.closest?.('[hidden]'));
    let target = triggerAvailable
      ? trigger
      : (dialog === technicalDialog
        ? (detailFallback?.isConnected ? detailFallback : (messageInput.hidden ? null : messageInput))
        : null);
    if (target) {
      target.focus({ preventScroll: true });
      if (root.activeElement !== target) target = null;
    }
    if (!target) {
      // The source may disappear while its dialog is open. Fall back to the
      // always-present node status entry instead of the document body.
      root.querySelector('#nodeTrigger')?.focus({ preventScroll: true });
    }
  }

  function openNotice(title, body, note = '') {
    $('#noticeHeading').textContent = title;
    $('#noticeBody').textContent = body;
    noticeNote.textContent = note;
    noticeNote.hidden = note.length === 0;
    openDialog(noticeDialog, root.activeElement ?? doc.activeElement);
  }

  function requestRefresh({ visible = false } = {}) {
    if (destroyed) return;
    if (typeof options.onRefresh !== 'function') {
      openNotice(
        '暂时不能刷新',
        '现在无法重新读取节点状态，请稍后再试。',
        '关闭后重新打开页面也可以重新读取。',
      );
      return;
    }
    if (pendingRefresh) return;
    pendingRefresh = true;
    statusRefresh.disabled = true;
    try {
      options.onRefresh();
    } catch (error) {
      pendingRefresh = false;
      statusRefresh.disabled = false;
      if (visible) {
        openNotice(
          '刷新没有完成',
          '这次没有读到新的节点状态，请稍后再试。',
          '如果问题持续，可以关闭后重新打开页面。',
        );
      }
    }
  }

  function renderNodeMeta() {
    const status = nodeState.status;
    const phase = nodeState.phase;
    const pill = nodePillText(phase, status);
    nodeLabel.textContent = pill;
    nodeTrigger.dataset.phase = phase;
    nodeDot.dataset.phase = phase;
    const label = `${pill}。打开节点状态详情`;
    nodeTrigger.setAttribute('aria-label', label);
    nodeTrigger.title = label;
  }

  function statusSnapshotSummary() {
    const status = nodeState.status;
    if (!status) return '—';
    const summary = connectionSummary(status);
    return `${summary.connections} 条连接 · ${summary.peers} 个已连接节点`;
  }

  function renderStatusDialog() {
    const status = nodeState.status;
    const phase = nodeState.phase;
    const statusAt = nodeState.statusAt;
    const fresh = nodeState.freshness;
    const rawError = [nodeState.error, nodeState.stream?.error].filter(Boolean).join(' · ');
    $('#statusPhase').textContent = nodePhaseText(phase);
    $('#statusDot').dataset.phase = phase;
    $('#statusDaemon').textContent = phase === 'ready'
      ? '可访问'
      : phase === 'stale' ? '可访问 · 更新中断'
        : phase === 'error' ? '暂不可用'
          : phase === 'closed' ? '更新已断开' : '读取中';
    $('#statusConnections').textContent = connectionFactText(status, { freshness: fresh, statusAt });
    $('#statusRoutes').textContent = routeFactText(status, { freshness: fresh, statusAt });
    $('#statusRefreshed').textContent = refreshedText(statusAt);
    $('#statusRefreshed').title = statusAt > 0
      ? new Date(statusAt).toLocaleString('zh-CN', { hour12: false })
      : '';
    $('#statusSubscription').textContent = subscriptionText(nodeState.stats);
    $('#statusCounters').textContent = nodeState.stats
      ? `${nodeState.stats.openSessions ?? 0} 个工作区 · ${nodeState.stats.subscriptions ?? 0} 个订阅`
      : '—';
    $('#statusPeerId').textContent = status?.peerId || '—';
    $('#statusNodeId').textContent = status?.nodeId || '—';
    $('#statusVersion').textContent = status
      ? `${status.version || '—'} · API ${status.apiVersion || '—'}`
      : '—';
    $('#statusError').textContent = rawError || '—';
    $('#statusError').title = nodeState.errorAt > 0 ? `最近失败于 ${formatClock(nodeState.errorAt)}` : '';

    const last = nodeState.events[0];
    $('#statusEvent').textContent = last
      ? `${last.summary || last.kind || '事件'} · ${formatClock(last.atUnixMs)}`
      : '暂无';
    const log = $('#statusEventLog');
    log.replaceChildren();
    for (const event of nodeState.events) {
      const item = element('li');
      item.textContent = `${formatClock(event.atUnixMs)} · ${event.summary || event.kind || '事件'}`;
      log.append(item);
    }

    if (phase === 'ready') {
      $('#statusSummary').textContent = status
        ? `${shortPeer(status.peerId)} · ${statusSnapshotSummary()}`
        : '本机服务已响应，但没有返回可展示的信息。';
    } else if (phase === 'stale') {
      $('#statusSummary').textContent = nodeState.stream?.phase === 'open'
        ? `实时更新已恢复，正在重新读取节点状态。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。`
        : `实时更新已中断，正在重试。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。`;
    } else if (phase === 'error') {
      $('#statusSummary').textContent = status
        ? `这次没有读到节点状态，请稍后重试。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。`
        : '这次没有读到节点状态，请稍后重试。';
    } else if (phase === 'closed') {
      $('#statusSummary').textContent = status
        ? `实时更新已断开。下面是 ${refreshedText(statusAt)} 的最近一次结果；关闭后重新打开页面会重新读取。`
        : '实时更新已断开，重新打开页面会重新读取。';
    } else {
      $('#statusSummary').textContent = '正在读取本机节点状态…';
    }

    statusRefresh.disabled = pendingRefresh || nodeState.phase === 'loading';
    statusRefresh.title = typeof options.onRefresh === 'function' ? '刷新节点状态' : '刷新暂时不可用';
  }

  function renderMine() {
    const data = mineState.data;
    const profile = data?.profile ?? null;
    const posts = data?.posts ?? null;
    const profileStatus = mineProfileStateText(profile);
    mineProfileStatus.textContent = profileStatus.text;
    mineProfileStatus.dataset.tone = profileStatus.tone;
    mineProfileContent.replaceChildren();
    mineProfileNote.hidden = true;
    if (data === null) {
      mineProfileNote.textContent = mineCapable
        ? (mineState.error || '正在读取本机公开档案…')
        : '当前宿主没有提供本机公开资料读取。';
      mineProfileNote.hidden = false;
    } else if (profile?.state === 'available') {
      renderMarkdownInto(mineProfileContent, profile.markdown);
    } else if (profile?.state === 'missing') {
      mineProfileNote.textContent = '本机还没有公开用户档案（public/profile/index.md）。这里不会用 Agent 的稳定人格资料当作你的用户资料。';
      mineProfileNote.hidden = false;
    } else {
      mineProfileNote.textContent = `公开用户档案读取失败：${profile?.error || '未知错误'}。这不表示档案不存在。`;
      mineProfileNote.hidden = false;
    }

    const postsStatus = minePostsStateText(posts);
    mineContentStatus.textContent = postsStatus.text;
    mineContentStatus.dataset.tone = postsStatus.tone;
    minePostList.replaceChildren();
    minePostList.hidden = true;
    const notes = [];
    if (data === null) {
      notes.push(mineState.error || '正在读取本机公开内容…');
    } else if (posts?.state === 'error') {
      notes.push(`公开内容读取失败：${posts.error || '未知错误'}。这不表示没有公开内容。`);
    } else if (posts?.state === 'missing') {
      notes.push('本机公开目录不可用，无法读取公开内容。');
    } else if (posts && posts.posts.length === 0) {
      notes.push('还没有明确署名为你的公开内容。公开文件存在本身不能证明是你发布的。');
    }
    if (posts && posts.unattributed > 0) {
      notes.push(`另有 ${posts.unattributed} 个公开文件缺少明确的本人作者声明，未列入“我的公开内容”。`);
    }
    if (posts && posts.agentAuthored > 0) {
      notes.push(`另有 ${posts.agentAuthored} 个公开文件明确标注为 Agent 署名，未算作你的内容。`);
    }
    if (posts && posts.invalid > 0) {
      notes.push(`有 ${posts.invalid} 个公开文件格式损坏或无法读取，未列入。`);
    }
    if (posts?.truncated) notes.push('公开内容超过本次有界扫描上限，列表可能不完整。');
    mineContentNote.textContent = notes.join(' ');
    mineContentNote.hidden = notes.length === 0;
    mineRetry.hidden = !(mineCapable && (data === null || posts?.state === 'error' || profile?.state === 'error'));
    mineRetry.textContent = mineState.retrying ? '正在重试…' : '重试读取公开资料';
    mineRetry.onclick = mineCapable ? () => { void loadMine(true); } : null;

    if (posts?.state === 'available' && posts.posts.length > 0) {
      for (const post of posts.posts) {
        const article = element('article', 'rm-post rm-own-post');
        const head = element('header', 'rm-post-head');
        const avatar = element('span', 'rm-contact-avatar rm-post-avatar');
        avatar.textContent = (profile?.displayName || '我').slice(0, 1) || '我';
        avatar.setAttribute('aria-hidden', 'true');
        const copy = element('div', 'rm-post-author');
        const name = element('b');
        name.textContent = profile?.displayName || '本人署名';
        const meta = element('span', 'rm-post-meta');
        meta.textContent = `用户署名 · ${post.publishedAt ? formatDateTime(post.publishedAt) : '时间未记录'}`;
        copy.append(name, meta);
        head.append(avatar, copy);
        const title = element('h2', 'rm-post-title');
        title.textContent = post.title;
        const summary = element('p', 'rm-post-summary');
        summary.textContent = post.summary || plainExcerpt(post.bodyMarkdown, 140);
        const tags = element('div', 'rm-post-tags');
        for (const tag of post.tags) {
          const chip = element('span', 'rm-post-tag');
          chip.textContent = tag;
          tags.append(chip);
        }
        if (post.tags.length === 0) tags.hidden = true;
        const source = sourceDetails({
          rows: [
            ['来源', '本机公开目录'],
            ['公开路径', post.path],
            ['内容版本', post.sha256],
            ['大小', post.sizeBytes > 0 ? `${post.sizeBytes} 字节` : ''],
          ],
          note: '来自本机公开目录；这是明确署名为你的内容，未从远端重新验证。',
        });
        const details = element('details', 'rm-own-post-body');
        const summaryEl = element('summary');
        summaryEl.textContent = '阅读全文';
        const content = element('div', 'rm-rich-text');
        renderMarkdownInto(content, post.bodyMarkdown);
        details.append(summaryEl, content);
        article.append(head, title, summary, tags, source, details);
        minePostList.append(article);
      }
      minePostList.hidden = false;
    }
    if (!mineCapable) {
      mineProfileNote.textContent = '当前宿主没有提供本机公开资料读取。';
      mineProfileNote.hidden = false;
      mineContentNote.textContent = '当前宿主没有提供本机公开内容读取。';
      mineContentNote.hidden = false;
    }
  }

  function renderJourneyText(panel, target, note, value, label) {
    target.replaceChildren();
    note.hidden = true;
    if (!value || value.state === 'missing') {
      panel.hidden = false;
      note.textContent = `还没有${label}记录。`;
      note.hidden = false;
      return;
    }
    if (value.state === 'error') {
      panel.hidden = false;
      note.textContent = `${label}读取失败：${value.error || '未知错误'}`;
      note.hidden = false;
      return;
    }
    panel.hidden = false;
    renderMarkdownInto(target, value.markdown);
  }

  function journeyCheckFor(peerId, messageId) {
    return journeyState.messageChecks?.get(`${peerId}:${messageId}`) ?? null;
  }

  function renderJourneyRawDetails(rows, label = '记录详情') {
    const details = element('details', 'rm-journey-record');
    const summary = element('summary');
    summary.textContent = label;
    const facts = element('dl', 'rm-journey-facts');
    for (const [keyText, value] of rows) {
      if (!value) continue;
      const row = element('div');
      const key = element('dt');
      key.textContent = keyText;
      const val = element('dd');
      val.textContent = value;
      row.append(key, val);
      facts.append(row);
    }
    if (facts.childElementCount === 0) return null;
    details.append(summary, facts);
    return details;
  }

  function renderJourneySession(session) {
    const expanded = view.pages.raminga.expandedSessions[session.id] === true;
    const article = element('article', 'rm-journey-card');
    const header = element('button', 'rm-journey-head');
    header.type = 'button';
    header.dataset.sessionToggle = session.id;
    header.dataset.focusKey = `journey:${session.id}`;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const copy = element('span', 'rm-journey-copy');
    const title = element('b');
    title.textContent = journeySessionTitle(session);
    const meta = element('span', 'rm-journey-meta');
    const time = journeyTimeText(session);
    meta.textContent = `${session.id}${time ? ` · ${time}` : ''}`;
    copy.append(title, meta);
    const status = journeyStatusText(session.state);
    const chip = element('span', 'rm-journey-status');
    chip.dataset.tone = status.tone;
    chip.textContent = status.label;
    header.append(copy, chip);
    article.append(header);
    if (status.note.length > 0) {
      const note = element('p', 'rm-list-note');
      note.textContent = status.note;
      article.append(note);
    }
    if (session.stateError) {
      const failed = element('p', 'rm-list-note');
      failed.textContent = `state.json 无法解析：${session.stateError}。只展示仍可读取的事件与报告。`;
      article.append(failed);
    }
    if (!expanded) return article;

    const detail = element('div', 'rm-journey-detail');
    if (session.state) {
      const facts = element('dl', 'rm-journey-facts');
      const addFact = (labelText, value) => {
        if (!value) return;
        const row = element('div');
        const key = element('dt');
        key.textContent = labelText;
        const val = element('dd');
        val.textContent = value;
        row.append(key, val);
        facts.append(row);
      };
      addFact('记录状态', status.label);
      addFact('模式', journeyModeText(session.state.mode));
      addFact('开始', formatDateTime(session.state.startedAt));
      addFact('最后保存', formatDateTime(session.state.updatedAt));
      addFact('完成时间', formatDateTime(session.state.completedAt));
      addFact('结束原因', session.state.completionReason);
      addFact('当前对象', session.state.currentPeerId ? shortPeerText(session.state.currentPeerId) : '');
      addFact('访问过', session.state.visitedPeerIds.map(shortPeerText).join('、'));
      addFact('发现来源', session.state.discoverySources.join('、'));
      if (facts.childElementCount > 0) detail.append(facts);
      const sessionRaw = renderJourneyRawDetails([
        ['状态原文', session.state.status],
        ['模式原文', session.state.mode],
        ['会话标识', session.id],
        ['当前对象完整 ID', session.state.currentPeerId],
        ['访问对象完整 ID', session.state.visitedPeerIds.join('\n')],
        ['发现来源', session.state.discoverySources.join('、')],
      ]);
      if (sessionRaw) detail.append(sessionRaw);
    }
    if (session.eventsRead === 'error') {
      const failed = element('p', 'rm-list-note');
      failed.textContent = `events.jsonl 读取失败：${session.eventsError}`;
      detail.append(failed);
    } else if (session.events.length === 0) {
      const empty = element('p', 'rm-list-note');
      empty.textContent = session.eventsRead === 'missing' ? '这次 Journey 没有 events.jsonl。' : 'events.jsonl 中没有可解析的活动。';
      detail.append(empty);
    } else {
      const list = element('ol', 'rm-journey-events');
      for (const event of session.events) {
        const item = element('li');
        item.dataset.sequence = String(event.sequence);
        const line = element('div', 'rm-journey-event-head');
        const seq = element('span', 'rm-journey-sequence');
        seq.textContent = `#${event.sequence}`;
        const label = element('b');
        label.textContent = journeyEventLabel(event);
        const at = element('span', 'rm-journey-event-time');
        at.textContent = event.timestamp ? formatDateTime(event.timestamp) : '';
        line.append(seq, label, at);
        item.append(line);
        if (event.summary) {
          const summary = element('p', 'rm-journey-event-text');
          summary.textContent = event.summary;
          item.append(summary);
        }
        const refs = journeyMessageRefs(event);
        const contentPaths = Array.isArray(event.contentPaths) ? event.contentPaths : [];
        if (event.peerId) {
          const peerRef = element('p', 'rm-journey-peer-ref');
          peerRef.textContent = `相关对象 ${shortPeerText(event.peerId)}`;
          peerRef.title = event.peerId;
          item.append(peerRef);
        }
        const actions = element('div', 'rm-journey-actions');
        if (event.peerId) {
          const related = element('button', 'rm-journey-action');
          related.type = 'button';
          related.dataset.profilePeer = event.peerId;
          related.dataset.profileRef = `raminga:${session.id}:${event.sequence}`;
          related.dataset.focusKey = `journey-peer:${session.id}:${event.sequence}`;
          related.textContent = '查看相关对象';
          related.setAttribute('aria-label', `查看相关对象 ${shortPeerText(event.peerId)}`);
          actions.append(related);
        }
        if (event.peerId && refs.length > 0) {
          const chat = element('button', 'rm-journey-action');
          chat.type = 'button';
          chat.dataset.openJourneyChat = event.peerId;
          chat.dataset.focusKey = `journey-chat:${session.id}:${event.sequence}`;
          chat.textContent = '打开相关会话';
          actions.append(chat);
        }
        for (const ref of refs) {
          if (ref.peerConflict || ref.peerId.length === 0) continue;
          const locate = element('button', 'rm-journey-action');
          locate.type = 'button';
          locate.dataset.locatePeer = ref.peerId;
          locate.dataset.locateMessage = ref.messageId;
          locate.dataset.focusKey = `journey-locate:${session.id}:${event.sequence}:${ref.messageId}`;
          locate.textContent = '核对当前保留消息';
          actions.append(locate);
        }
        if (actions.childElementCount > 0) item.append(actions);
        const results = element('div', 'rm-journey-results');
        for (const ref of refs) {
          if (ref.peerConflict) {
            results.append(journeyCheckNode('unavailable', '引用中的 Peer 不一致，这里不猜测会话，也未跳转。'));
            continue;
          }
          if (ref.peerId.length === 0) {
            results.append(journeyCheckNode('unavailable', '这条引用没有可用的 Peer，无法核对当前消息。'));
            continue;
          }
          const check = journeyCheckFor(ref.peerId, ref.messageId);
          if (!check) continue;
          const node = journeyCheckNode(check.tone, check.text);
          node.dataset.locateResult = ref.messageId;
          results.append(node);
        }
        if (results.childElementCount > 0) item.append(results);
        if (contentPaths.length > 0) {
          const paths = element('p', 'rm-journey-content-paths');
          paths.textContent = `公开内容引用：${contentPaths.join('、')}（不会自动重新抓取）`;
          item.append(paths);
        }
        if (event.messageEvidence) {
          const evidence = event.messageEvidence;
          const box = element('div', 'rm-journey-evidence');
          const evidenceTitle = element('b');
          evidenceTitle.textContent = 'Journey 当时的历史观察';
          const text = element('p');
          text.textContent = `${evidence.summary || '没有摘要'} · ${journeyDirectionText(evidence.direction)}${evidence.observedAt ? ` · 观察于 ${formatDateTime(evidence.observedAt)}` : ''}`;
          const note = element('p', 'rm-list-note');
          note.textContent = '这是当时保存的观察，不是 Node 当前投递或 ACK 状态；核对当前保留消息只以当前记录为准。';
          box.append(evidenceTitle, text, note);
          item.append(box);
        }
        const raw = renderJourneyRawDetails([
          ['事件序号', event.sequence > 0 ? `#${event.sequence}` : ''],
          ['事件类型原文', event.type],
          ['消息 ID', refs.map((ref) => ref.messageId).join('、')],
          ['方向原文', event.messageEvidence?.direction || ''],
          ['当时确认', typeof event.messageEvidence?.acked === 'boolean'
            ? (event.messageEvidence.acked ? '已确认（仅当时）' : '尚未确认（仅当时）')
            : ''],
          ['观察时间', event.messageEvidence?.observedAt ? formatDateTime(event.messageEvidence.observedAt) : ''],
          ['内容版本', event.messageEvidence?.contentSha256 || ''],
          ['内容引用', contentPaths.join('、')],
        ]);
        if (raw) item.append(raw);
        list.append(item);
      }
      detail.append(list);
      if (session.eventsTruncated) {
        const truncated = element('p', 'rm-list-note');
        truncated.textContent = `只展示前 ${session.events.length} 条事件；events.jsonl 还有更多内容。`;
        detail.append(truncated);
      }
      if (session.badEventLines > 0) {
        const bad = element('p', 'rm-list-note');
        bad.textContent = `events.jsonl 有 ${session.badEventLines} 行无法解析，已跳过；其他活动仍按原文展示。`;
        detail.append(bad);
      }
    }
    if (session.reportRead === 'available') {
      const panel = element('section', 'rm-journey-report');
      const heading = element('h3');
      heading.textContent = 'Journey 报告';
      const content = element('div', 'rm-rich-text');
      renderMarkdownInto(content, session.reportMarkdown);
      panel.append(heading, content);
      detail.append(panel);
    } else if (session.reportRead === 'error') {
      const failed = element('p', 'rm-list-note');
      failed.textContent = `report.md 读取失败：${session.reportError}`;
      detail.append(failed);
    }
    article.append(detail);
    return article;
  }

  function journeyCheckNode(tone, text) {
    const node = element('p', 'rm-journey-check');
    node.dataset.tone = tone;
    node.textContent = text;
    return node;
  }

  function journeyCacheNeedsRead() {
    const data = journeyState.data;
    if (data === null || data.state === 'error') return true;
    const at = Number(data.at);
    return !(at > 0) || Date.now() - at > JOURNEY_REVALIDATE_MS;
  }

  function captureJourneyRenderContext() {
    const page = pageEls.raminga;
    const active = root.activeElement;
    const inside = Boolean(active && page.contains(active));
    return {
      scroll: page.scrollTop,
      focusKey: inside ? (active.dataset?.focusKey || (active.id ? `#${active.id}` : '')) : '',
    };
  }

  function restoreJourneyRenderContext(context) {
    if (!context) return;
    if (currentPage === 'raminga') pageEls.raminga.scrollTop = context.scroll;
    if (context.focusKey.length === 0) return;
    const target = context.focusKey.startsWith('#')
      ? root.querySelector(context.focusKey)
      : [...root.querySelectorAll('[data-focus-key]')]
        .find((node) => node.dataset.focusKey === context.focusKey);
    if (target) target.focus({ preventScroll: true });
  }

  function renderJourneyRefreshBar(data) {
    ramingaRecordsBar.hidden = !journeyCapable;
    if (!journeyCapable) return;
    const readAt = Number(data?.at) > 0 ? formatDateTime(data.at) : '';
    const readable = data !== null && data.state !== 'error';
    const partial = readable && (data.persona?.state === 'error'
      || data.growth?.state === 'error'
      || data.sessionsState === 'error');
    let text = '';
    let tone = '';
    if (journeyState.retrying) {
      text = readable && readAt.length > 0
        ? `正在刷新记录…下面仍是 ${readAt} 读取的内容。`
        : '正在读取本机 Agent 记录…';
    } else if (journeyState.error) {
      text = readable && readAt.length > 0
        ? `刷新没有完成，下面仍是 ${readAt} 读取的旧记录。${journeyState.error}`
        : `没有读到 Agent 记录：${journeyState.error}`;
      tone = 'error';
    } else if (data === null) {
      text = '正在读取本机 Agent 记录…';
    } else if (data.state === 'error') {
      text = '没有读到 Agent 记录。';
      tone = 'error';
    } else if (data.state === 'missing') {
      text = readAt.length > 0 ? `${readAt} 读取完成；还没有找到 Agent 记录。` : '还没有找到 Agent 记录。';
    } else if (partial) {
      text = `${readAt.length > 0 ? `${readAt} 读取；` : ''}部分记录读取失败，可以刷新重试。`;
      tone = 'unavailable';
    } else if (data.freshness === 'stale') {
      text = `${readAt.length > 0 ? `${readAt} 读取；` : ''}内容可能不是最新，可以刷新。`;
      tone = 'unavailable';
    } else {
      text = readAt.length > 0 ? `记录读取于 ${readAt}。` : '记录已读取。';
    }
    ramingaRecordsStatus.textContent = text;
    ramingaRecordsStatus.hidden = text.length === 0;
    ramingaRecordsStatus.dataset.tone = tone;
    ramingaRefresh.dataset.focusKey = 'journey-refresh';
    ramingaRefresh.textContent = journeyState.retrying
      ? '正在刷新…'
      : (journeyState.error ? '重试刷新' : '刷新记录');
    ramingaRefresh.setAttribute('aria-busy', journeyState.retrying ? 'true' : 'false');
  }

  function renderJourney() {
    if (destroyed) return;
    const context = captureJourneyRenderContext();
    try {
      const data = journeyState.data;
      const statusAction = $('#ramingaStateAction');
      const stateTitle = $('#ramingaStateTitle');
      const stateBody = $('#ramingaStateBody');
      ramingaSelfPanel.hidden = true;
      ramingaGrowthPanel.hidden = true;
      ramingaJourneyPanel.hidden = true;
      ramingaSessionList.replaceChildren();
      ramingaSessionList.hidden = true;
      $('#ramingaState').hidden = false;
      statusAction.hidden = false;
      statusAction.textContent = '查看节点状态';
      statusAction.onclick = () => openDialog(statusDialog, statusAction);
      renderJourneyRefreshBar(data);

      if (!journeyCapable) {
        stateTitle.textContent = 'Agent 记录读取暂不可用';
        stateBody.textContent = '当前宿主没有提供私有 Agent 资料读取。这里不会用连接数生成日记，也不会把公开内容混入。';
        return;
      }
      if (journeyState.retrying && (data === null || data.state === 'error')) {
        stateTitle.textContent = '正在重新读取 Agent 记录';
        stateBody.textContent = '正在从本机数据目录读取稳定人格、成长提案与 Journey 记录。';
        return;
      }
      if (data === null) {
        stateTitle.textContent = journeyState.error ? '这次没有读到 Agent 记录' : '正在读取 Agent 记录';
        stateBody.textContent = journeyState.error || '正在从本机数据目录读取稳定人格、成长提案与 Journey 记录。';
        return;
      }
      if (data.state === 'missing') {
        if (journeyState.error && !journeyState.retrying) {
          stateTitle.textContent = '这次没有刷新到 Agent 记录';
          stateBody.textContent = `${journeyState.error}。下面保留上次的空结果；这不代表现在一定没有记录，可以再次刷新核对。`;
        } else {
          stateTitle.textContent = '还没有可读取的 Agent 记录';
          stateBody.textContent = '没有找到 agent/persona.md、growth.md 或 sessions/。这不代表没有发生过活动，只是本宿主还没有可读取的记录。';
        }
        return;
      }
      if (data.state === 'error') {
        stateTitle.textContent = 'Agent 私有记录读取失败';
        stateBody.textContent = `${data.sessionsError || journeyState.error || '受控文件读取失败'}。这不代表没有记录，也不据此推测 Agent 正在运行。`;
        return;
      }
      $('#ramingaState').hidden = true;
      renderJourneyText(ramingaSelfPanel, ramingaSelf, ramingaSelfNote, data.persona, ' 稳定人格 ');
      renderJourneyText(ramingaGrowthPanel, ramingaGrowth, ramingaGrowthNote, data.growth, ' 成长提案 ');
      ramingaJourneyPanel.hidden = false;
      const notes = [];
      if (data.sessionsState === 'missing') notes.push('还没有 Journey 记录。一次 Journey 不是聊天线程，也不由连接数生成。');
      if (data.sessionsState === 'error') notes.push(`Journey 列表读取失败：${data.sessionsError}`);
      if (data.sessionsTruncated) notes.push(`只展示最近 ${data.sessions.length} 个 Journey 目录；还有更多未读取。`);
      ramingaJourneyMeta.textContent = notes.join(' ');
      ramingaJourneyMeta.hidden = notes.length === 0;
      ramingaJourneyMeta.dataset.tone = data.sessionsState === 'error' ? 'error' : '';
      for (const session of data.sessions) ramingaSessionList.append(renderJourneySession(session));
      ramingaSessionList.hidden = data.sessions.length === 0;
    } finally {
      restoreJourneyRenderContext(context);
    }
  }

  function loadJourney(force = false) {
    if (destroyed || !journeyCapable) { renderJourney(); return; }
    if (!hostReady) { renderJourney(); return; }
    const existing = journeyState.request;
    if (existing !== null) {
      if (force === true) existing.forceQueued = true;
      journeyState.retrying = true;
      renderJourney();
      return;
    }
    const request = { forceQueued: false };
    journeyState.request = request;
    journeyState.retrying = true;
    renderJourney();
    let pending;
    try {
      pending = options.onLoadJourney(force === true);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return Promise.resolve(pending)
      .then((value) => {
        if (destroyed || journeyState.request !== request) return;
        if (value === null || typeof value !== 'object') throw new Error('Agent 记录没有返回结果');
        const previous = journeyState.data;
        if (value.state === 'error' && previous !== null && previous.state !== 'error') {
          // A failed refresh must not replace a readable older snapshot with an
          // empty error placeholder. Mark the snapshot stale and keep reading.
          throw new Error(value.sessionsError || 'Agent 记录读取失败');
        }
        if (value.state === 'error' && previous === null) journeyState.error = value.sessionsError || 'Agent 记录读取失败';
        else journeyState.error = '';
        journeyState.data = value;
      })
      .catch((error) => {
        if (destroyed || journeyState.request !== request) return;
        const message = errorText(error) || 'Agent 记录读取失败';
        journeyState.error = message;
        if (journeyState.data === null || journeyState.data.state === 'error') {
          journeyState.data = {
            state: 'error', at: Date.now(), sessionsError: message,
            sessions: [], persona: null, growth: null, sessionsState: 'error',
            sessionsTruncated: false, freshness: 'unavailable',
          };
        }
      })
      .finally(() => {
        if (destroyed || journeyState.request !== request) return;
        journeyState.request = null;
        journeyState.retrying = false;
        renderJourney();
        if (request.forceQueued && !destroyed) loadJourney(true);
      });
  }

  function toggleJourneySession(id) {
    if (view.pages.raminga.expandedSessions[id] === true) delete view.pages.raminga.expandedSessions[id];
    else view.pages.raminga.expandedSessions[id] = true;
    saveNow();
    renderJourney();
    const target = [...ramingaSessionList.querySelectorAll('[data-session-toggle]')].find((node) => node.dataset.sessionToggle === id);
    target?.focus({ preventScroll: true });
  }

  async function locateJourneyMessage(peerId, messageId) {
    const key = `${peerId}:${messageId}`;
    journeyState.messageChecks ??= new Map();
    if (!locateMessageCapable) {
      journeyState.messageChecks.set(key, { tone: 'unavailable', text: '当前宿主没有提供历史消息定位。' });
      renderJourney();
      return;
    }
    journeyState.messageChecks.set(key, { tone: '', text: '正在核对当前保留消息…' });
    renderJourney();
    const request = ++locateSeq;
    locateRequests.set(key, request);
    try {
      const result = await options.onLocateMessage(peerId, messageId);
      if (destroyed || locateRequests.get(key) !== request) return;
      if (result?.found === true) {
        const samePeer = !result.peerId || result.peerId === peerId;
        const sameMessage = result.message?.messageId === messageId;
        const sameMessagePeer = !result.message?.peerId || result.message.peerId === peerId;
        if (!samePeer || !sameMessage || !sameMessagePeer) {
          journeyState.messageChecks.set(key, {
            tone: 'unavailable',
            text: '宿主返回的消息与这条引用不一致，未打开其他消息。',
          });
          return;
        }
        journeyState.messageChecks.set(key, {
          tone: 'ready',
          text: `当前保留记录中存在这条消息（${formatDateTime(result.message.createdAt)}）。已打开会话；不会替换为其他消息。`,
        });
        renderJourney();
        openConversation(peerId, { source: 'raminga', focusMessageId: messageId });
        return;
      }
      const message = result?.complete === false
        ? (result.error || '在本次有界查找中没有找到该消息；它可能更早或已被裁剪。')
        : (result?.error || '该消息引用已不在当前保留消息中，无法定位；这里只保留历史观察。');
      journeyState.messageChecks.set(key, { tone: 'unavailable', text: message });
    } catch (error) {
      if (destroyed || locateRequests.get(key) !== request) return;
      journeyState.messageChecks.set(key, {
        tone: 'error',
        text: `这次没有核对到消息引用：${errorText(error)}。不会跳到其他消息。`,
      });
    } finally {
      if (!destroyed && locateRequests.get(key) === request) {
        locateRequests.delete(key);
        renderJourney();
      }
    }
  }

  function profileRefFor(peerId, source, id) {
    return `${source}:${id ?? peerId}`;
  }

  function profileEntryScroll(pageName) {
    const live = visiblePageScroll(pageName);
    const fallback = live ?? Math.max(0, Number(view.pages[pageName]?.scroll) || 0);
    const pressed = profilePressScroll;
    profilePressScroll = null;
    // Focus is applied as the default action of a pointer press, before the
    // click handler opens the profile. If that focus moved the page to 0, the
    // visible position recorded at pointerdown is the real reading position.
    if (
      pressed
      && pressed.page === pageName
      && pressed.scroll > 0
      && fallback === 0
      && Math.abs(Date.now() - pressed.at) <= 1500
    ) {
      return pressed.scroll;
    }
    return fallback;
  }

  function openPeerProfile(peerId, { source = 'contacts', ref = '', trigger = null } = {}) {
    const canonical = typeof peerId === 'string' ? peerId : '';
    if (canonical.length === 0) return;
    const current = currentPage;
    const tracksScroll = pageTracksScroll(current);
    const sourceScroll = tracksScroll
      ? profileEntryScroll(current)
      : Math.max(0, Number(view.pages[current]?.scroll) || 0);
    profileReturn.page = current;
    profileReturn.peerId = contactsState.selectedPeerId;
    profileReturn.scroll = sourceScroll;
    profileReturn.open = true;
    profileTriggerRef = ref || profileRefFor(canonical, source, canonical);
    view.profile = {
      peerId: canonical,
      returnPage: current,
      returnPeer: current === 'messages' ? contactsState.selectedPeerId : '',
      triggerId: profileTriggerRef,
    };
    profileState.peerId = canonical;
    profileState.data = null;
    profileState.error = '';
    if (tracksScroll) view.pages[current].scroll = sourceScroll;
    // Persist the snapshot before hiding the page. Hiding collapses the real
    // scrollTop to 0; the open flag makes later profile scroll events keep
    // using this snapshot instead of reading the hidden page.
    saveNow();
    pageEls[current].hidden = true;
    profileView.hidden = false;
    profileView.scrollTop = 0;
    renderProfile();
    void loadPeerProfile(canonical, false);
  }

  function closePeerProfile({ restoreFocus = true } = {}) {
    if (profileView.hidden) return;
    const sourcePage = isMainPage(view.profile.returnPage) ? view.profile.returnPage : 'explore';
    const tracksScroll = pageTracksScroll(sourcePage);
    const savedScroll = tracksScroll
      ? Math.max(0, Number(profileReturn.scroll) || 0)
      : Math.max(0, Number(view.pages[sourcePage]?.scroll) || 0);
    profileView.hidden = true;
    pageEls[sourcePage].hidden = false;
    if (tracksScroll) view.pages[sourcePage].scroll = savedScroll;
    pageEls[sourcePage].scrollTop = savedScroll;
    view.profile = { peerId: '', returnPage: '', returnPeer: '', triggerId: '' };
    profileState.peerId = '';
    profileState.data = null;
    profileState.error = '';
    saveNow();
    profileReturn.open = false;
    profileReturn.scroll = null;
    updatePrimaryNav(root, sourcePage);
    if (!restoreFocus) {
      if (tracksScroll) restorePageScrollAfterFocus(sourcePage, savedScroll);
      return;
    }
    const ref = profileTriggerRef;
    const target = [...root.querySelectorAll('[data-profile-ref]')].find((node) => node.dataset.profileRef === ref) ?? null;
    if (target) target.focus({ preventScroll: true });
    else root.querySelector('#nodeTrigger')?.focus({ preventScroll: true });
    if (tracksScroll) restorePageScrollAfterFocus(sourcePage, savedScroll);
  }

  async function loadPeerProfile(peerId, force = false) {
    if (!hostReady) {
      profileState.error = '工作区正在连接本机节点，请稍后重试。';
      renderProfile();
      return;
    }
    if (!peerProfileCapable) {
      profileState.error = '当前宿主没有提供对方公开资料读取。';
      renderProfile();
      return;
    }
    const request = ++profileState.requestSeq;
    profileState.retrying = true;
    profileState.error = '';
    renderProfile();
    try {
      const value = await options.onLoadPeerProfile(peerId, force === true);
      if (destroyed || request !== profileState.requestSeq) return;
      if (value === null || typeof value !== 'object') throw new Error('对方公开资料没有返回结果');
      profileState.data = value;
      profileState.error = value.error || '';
    } catch (error) {
      if (destroyed || request !== profileState.requestSeq) return;
      profileState.error = errorText(error) || '对方公开资料读取失败';
    } finally {
      if (!destroyed && request === profileState.requestSeq) {
        profileState.retrying = false;
        renderProfile();
      }
    }
  }

  function renderProfile() {
    const peerId = profileState.peerId;
    const data = profileState.data;
    profilePeerId.textContent = peerId;
    profileAvatar.textContent = (profileLabel(data, peerId) || '?').slice(0, 1);
    profileName.textContent = profileLabel(data, peerId);
    profileBody.replaceChildren();
    profileBodyNote.hidden = true;
    profileError.hidden = true;
    profileRetry.hidden = true;
    profileStale.hidden = true;
    profileAgentSummary.hidden = true;
    profileAgentNote.hidden = true;
    profileAgentOpen.onclick = null;
    profileSource.textContent = '远端声明 · 来自对方公开文件与网络读取，未在本机验证身份。';
    if (data === null) {
      profileBodyNote.textContent = profileState.error || '正在读取对方公开资料…';
      profileBodyNote.hidden = false;
      if (profileState.error) {
        profileError.textContent = profileState.error;
        profileError.hidden = false;
        profileRetry.hidden = !peerProfileCapable;
        profileRetry.textContent = profileState.retrying ? '正在重试…' : '重试读取对方资料';
        profileRetry.onclick = () => { void loadPeerProfile(peerId, true); };
      }
      return;
    }
    if (profileState.error) {
      profileStale.textContent = `这次读取没有完成：${profileState.error}。下面是上次成功结果或仅有的公开信息。`;
      profileStale.hidden = false;
      profileRetry.hidden = false;
      profileRetry.textContent = profileState.retrying ? '正在重试…' : '重试读取对方资料';
      profileRetry.onclick = () => { void loadPeerProfile(peerId, true); };
    }
    if (!data.found) {
      profileBodyNote.textContent = '对方没有公开用户档案。这里只保留 Peer ID 和本地联系人名称，不生成虚构资料。';
      profileBodyNote.hidden = false;
    } else if (data.text) {
      renderMarkdownInto(profileBody, data.text);
    } else {
      profileBodyNote.textContent = '对方公开档案没有正文。';
      profileBodyNote.hidden = false;
    }
    const card = data.agentCard;
    if (card?.state === 'available' && card.card) {
      profileAgentSummary.hidden = false;
      profileAgentName.textContent = card.card.displayName;
      profileAgentDescription.textContent = card.card.description || '对方没有填写 Agent 描述。';
      profileAgentOpen.onclick = () => openAgentCardDialog(card.card, peerId);
    } else if (card?.state === 'error') {
      profileAgentNote.textContent = `对方公开 Agent 资料无法读取：${card.error}。不生成虚构档案。`;
      profileAgentNote.hidden = false;
    } else {
      profileAgentNote.textContent = '对方没有公开 Agent 卡片；用户资料与 Agent 资料分开，不因联系人存在就生成 Agent 档案。';
      profileAgentNote.hidden = false;
    }
  }

  function openAgentCardDialog(card, peerId) {
    agentCardSource.textContent = '来源：对方公开的 Agent 档案 · 远端声明，未验证身份';
    agentCardBody.replaceChildren();
    const facts = element('dl', 'rm-facts');
    const add = (label, value) => {
      if (!value) return;
      const row = element('div');
      const key = element('dt');
      key.textContent = label;
      const val = element('dd');
      val.textContent = value;
      row.append(key, val);
      facts.append(row);
    };
    add('名称', card.displayName);
    add('介绍', card.description);
    add('兴趣', card.interests.join('、'));
    add('交流偏好', card.conversationStyle);
    add('更新时间', formatDateTime(card.updatedAt));
    agentCardBody.append(facts);
    agentCardBody.append(sourceDetails({
      rows: [
        ['公开文件', card.path],
        ['内容版本', card.sha256],
        ['更新时间', formatDateTime(card.updatedAt)],
        ['来源节点', peerId],
      ],
      note: '这是对方公开的 Agent 自我介绍，不证明 Agent 在线，也不证明某条消息由 Agent 发出。',
    }));
    openDialog(agentCardDialog, profileAgentOpen);
  }

  function ensurePageData(page) {
    if (!hostReady || !profileView.hidden) return;
    if (page === 'explore') ensureDiscoveriesFresh(false);
    if (page === 'mine' && mineCapable && mineState.data === null) {
      void loadMine(false);
    }
    if (page === 'raminga' && journeyCapable && journeyCacheNeedsRead()) {
      // Re-entry is a bounded revalidation, not a poll. A manual refresh still
      // forces the host bridge past its own cache.
      void loadJourney(false);
    }
  }

  async function loadMine(force = false) {
    if (destroyed || !mineCapable) { renderMine(); return; }
    if (!hostReady) return;
    const request = ++mineState.requestSeq;
    mineState.retrying = true;
    mineState.error = '';
    renderMine();
    try {
      const value = await options.onLoadMine(force === true);
      if (destroyed || request !== mineState.requestSeq) return;
      if (value === null || typeof value !== 'object') throw new Error('本机公开资料没有返回结果');
      mineState.data = value;
      mineState.error = value.error || '';
    } catch (error) {
      if (destroyed || request !== mineState.requestSeq) return;
      mineState.error = errorText(error) || '本机公开资料读取失败';
    } finally {
      if (!destroyed && request === mineState.requestSeq) {
        mineState.retrying = false;
        renderMine();
      }
    }
  }

  function renderMineIdentity() {
    const phase = nodeState.phase;
    const status = nodeState.status;
    const stale = phase !== 'ready' && Boolean(status);
    mineIdentity.dataset.phase = phase;
    mineDetails.replaceChildren();
    mineDetails.hidden = true;
    mineIdentityAction.hidden = true;
    mineIdentityAction.onclick = null;

    if (status) {
      mineSummary.textContent = `${stale ? '最近一次结果 · ' : '本机节点 · '}${shortPeer(status.peerId)}`;
      mineDetails.hidden = false;
      mineDetails.append(
        detailRow('节点标识', shortPeer(status.peerId), false),
      );
    } else if (phase === 'loading') {
      mineSummary.textContent = '正在读取本机节点信息…';
    } else if (phase === 'error') {
      mineSummary.textContent = '本机节点暂时不可用';
    } else if (phase === 'stale' || phase === 'closed') {
      mineSummary.textContent = '实时更新已中断';
    }

    if (phase === 'error' || phase === 'stale' || phase === 'closed') {
      const note = element('p', 'rm-inline-note');
      note.textContent = phase === 'error'
        ? `${stale ? '暂时读不到本机节点信息，上面保留的是最近一次结果。' : '暂时读不到本机节点信息，请稍后重试。'}`
        : phase === 'stale'
          ? `实时更新已中断，正在重试。上面保留的是 ${refreshedText(nodeState.statusAt)} 的结果。`
          : '实时更新已暂停，刷新可以重新读取。';
      mineDetails.hidden = false;
      mineDetails.append(note);
      mineIdentityAction.hidden = false;
      mineIdentityAction.textContent = phase === 'error' ? '重试读取' : '刷新节点状态';
      mineIdentityAction.onclick = () => requestRefresh({ visible: true });
    } else if (phase === 'ready' && !status) {
      mineSummary.textContent = '本机服务已响应，但没有返回节点信息';
      mineIdentityAction.hidden = false;
      mineIdentityAction.textContent = '重新读取';
      mineIdentityAction.onclick = () => requestRefresh({ visible: true });
    }

    mineRefresh.title = typeof options.onRefresh === 'function' ? '刷新节点状态' : '刷新暂时不可用';
  }

  function setNodeStatus(next = {}) {
    if (destroyed) return;
    nodeState.phase = NODE_PHASES.has(next.phase) ? next.phase : 'loading';
    if ('status' in next) nodeState.status = next.status ?? null;
    if ('statusAt' in next) nodeState.statusAt = Number(next.statusAt) > 0 ? Number(next.statusAt) : 0;
    if ('error' in next) nodeState.error = next.error ?? null;
    if ('errorAt' in next) nodeState.errorAt = Number(next.errorAt) > 0 ? Number(next.errorAt) : 0;
    if ('freshness' in next) nodeState.freshness = next.freshness ?? 'loading';
    if ('stream' in next) nodeState.stream = next.stream ?? null;
    if ('stats' in next) nodeState.stats = next.stats ?? null;
    // Older hosts do not send statusAt; keep the previous display honest by
    // stamping only a successful ready render, never a stale one.
    if (nodeState.phase === 'ready' && nodeState.status && nodeState.statusAt === 0) {
      nodeState.statusAt = Date.now();
    }
    pendingRefresh = false;
    renderNodeMeta();
    renderStatusDialog();
    renderMineIdentity();
    if (contactsState.selectedPeerId) renderComposer();
    // Announce the same fact the visible pill shows, including the current
    // connection count. Updating only on phase changes left the live region
    // saying "0 connections" while the pill already showed 1.
    const announcement = `${nodePhaseText(nodeState.phase)}。${nodePillText(nodeState.phase, nodeState.status)}`;
    if (announcement !== lastNodeAnnouncement) {
      lastNodeAnnouncement = announcement;
      nodeLive.textContent = announcement;
    }
  }

  function pushNodeEvent(event) {
    if (destroyed || !event) return;
    nodeState.events.unshift(event);
    if (nodeState.events.length > 6) nodeState.events.length = 6;
    renderStatusDialog();
    const peerId = contactsState.selectedPeerId;
    if (!peerId) return;
    if (event.kind === 'chat') {
      const message = eventMessage(event);
      if (message && message.peerId === peerId) {
        chat.items = mergeMessages(chat.items, [message], { peerId });
        renderMessageList();
      }
    } else if (event.kind === 'ack' && event.peerId === peerId && event.ackAccepted === true) {
      let changed = false;
      chat.items = chat.items.map((message) => {
        if (message.messageId !== event.messageId || message.direction !== 'out') return message;
        changed = true;
        return { ...message, acked: true, deliveryStatus: 'acked', deliveryError: '', deliveryUpdatedAt: event.atUnixMs };
      });
      if (changed) renderMessageList();
    }
  }

  function setStats(stats) {
    if (destroyed || !stats) return;
    nodeState.stats = stats;
    renderStatusDialog();
  }

  function getDraft(key) {
    return readDraft(view, key);
  }

  function setDraft(key, value) {
    if (destroyed) return;
    storeDraft(view, key, value);
    saveNow();
  }

  // Record the source position before the browser applies pointer focus. The
  // click handler can then tell a real 0 from a focus-induced collapse.
  function rememberProfilePress(event) {
    const target = event.target.closest?.('[data-profile-peer]');
    if (!target || !pageTracksScroll(currentPage)) return;
    const page = pageEls[currentPage];
    if (!page || page.hidden) return;
    profilePressScroll = {
      page: currentPage,
      scroll: Math.max(0, page.scrollTop || 0),
      at: Date.now(),
    };
  }
  root.addEventListener('pointerdown', rememberProfilePress, { capture: true, signal: controller.signal });
  root.addEventListener('mousedown', rememberProfilePress, { capture: true, signal: controller.signal });

  // Any avatar/author entry resolves through the host-controlled profile
  // reader. The ref preserves which surface opened it for the back/focus path.
  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('[data-profile-peer]');
    if (!target) return;
    const peerId = target.dataset.profilePeer;
    if (!peerId) return;
    event.preventDefault();
    openPeerProfile(peerId, {
      source: currentPage,
      ref: target.dataset.profileRef || profileRefFor(peerId, currentPage, peerId),
      trigger: target,
    });
  }, { signal: controller.signal });

  // Navigation: one behavior for both rendered copies.
  root.querySelectorAll('nav').forEach((nav) => {
    nav.innerHTML = renderPrimaryNav(currentPage);
  });
  root.addEventListener('click', (event) => {
    const nav = event.target.closest?.('button[data-nav]');
    if (!nav) return;
    event.preventDefault();
    const page = pageForNav(nav.dataset.nav);
    if (currentPage === 'messages') saveChatScroll();
    if (page === currentPage) {
      if (!profileView.hidden) { closePeerProfile(); return; }
      if (page === 'messages' && contactsState.selectedPeerId) return;
      const active = pageEls[page];
      if (typeof active.scrollTo === 'function') active.scrollTo({ top: 0, behavior: 'smooth' });
      else active.scrollTop = 0;
      return;
    }
    showPage(page);
  }, { signal: controller.signal });

  exploreRefresh.addEventListener('click', () => { void refreshDiscoveries(true); }, { signal: controller.signal });
  exploreSearchToggle.addEventListener('click', () => {
    setSearchOpen(exploreSearch.hidden, { focus: true });
  }, { signal: controller.signal });
  exploreQuery.addEventListener('input', () => {
    updateExploreState();
    scheduleSave();
  }, { signal: controller.signal });
  contactQuery.addEventListener('input', () => {
    updateContactsState();
    scheduleSave();
  }, { signal: controller.signal });
  conversationQuery.addEventListener('input', () => {
    updateConversationIndexState();
    saveNow();
  }, { signal: controller.signal });
  $$('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.filter), { signal: controller.signal });
  });

  $('#addContact').addEventListener('click', (event) => {
    openAddDialog(event.currentTarget);
  }, { signal: controller.signal });
  contactsShareAction.addEventListener('click', (event) => {
    openShareDialog(event.currentTarget);
  }, { signal: controller.signal });
  contactList.addEventListener('click', (event) => {
    const row = event.target.closest?.('button[data-contact-peer]');
    if (!row) return;
    openConversation(row.dataset.contactPeer, { source: 'contacts' });
  }, { signal: controller.signal });
  conversationList.addEventListener('click', (event) => {
    const row = event.target.closest?.('button[data-conversation-peer]');
    if (!row) return;
    openConversation(row.dataset.conversationPeer, { source: 'messages' });
  }, { signal: controller.signal });
  discoveryList.addEventListener('click', (event) => {
    const expand = event.target.closest?.('[data-expand-post]');
    if (expand) { togglePost(expand.dataset.expandPost); return; }
    const retry = event.target.closest?.('[data-retry-post]');
    if (retry) { void ensurePostContent(retry.dataset.retryPost, true); }
  }, { signal: controller.signal });
  ramingaSessionList.addEventListener('click', (event) => {
    const toggle = event.target.closest?.('[data-session-toggle]');
    if (toggle) { toggleJourneySession(toggle.dataset.sessionToggle); return; }
    const locate = event.target.closest?.('[data-locate-message]');
    if (locate) {
      if (!locate.dataset.locatePeer || !locate.dataset.locateMessage) return;
      void locateJourneyMessage(locate.dataset.locatePeer, locate.dataset.locateMessage);
      return;
    }
    const chat = event.target.closest?.('[data-open-journey-chat]');
    if (chat) {
      openConversation(chat.dataset.openJourneyChat, { source: 'raminga' });
    }
  }, { signal: controller.signal });
  profileBack.addEventListener('click', () => closePeerProfile());
  profileView.addEventListener('scroll', scheduleSave, { passive: true, signal: controller.signal });
  $('#conversationBack').addEventListener('click', closeConversation, { signal: controller.signal });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitMessage();
  }, { signal: controller.signal });
  messageInput.addEventListener('input', () => {
    const peerId = contactsState.selectedPeerId;
    if (peerId) persistDraft(peerId, messageInput.value);
    updateComposerMeta();
  }, { signal: controller.signal });
  messageInput.addEventListener('compositionstart', () => {
    composerComposing = true;
  }, { signal: controller.signal });
  messageInput.addEventListener('compositionend', () => {
    composerComposing = false;
  }, { signal: controller.signal });
  messageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || composerComposing || event.keyCode === 229) return;
    if (event.shiftKey) return; // Shift+Enter inserts a newline.
    event.preventDefault();
    void submitMessage();
  }, { signal: controller.signal });
  sendReconcile.addEventListener('click', () => { void submitMessage({ reconcile: true }); }, { signal: controller.signal });
  sendRestore.addEventListener('click', restoreFailedText, { signal: controller.signal });
  composerTech.addEventListener('click', openComposerDetail, { signal: controller.signal });
  messageList.addEventListener('scroll', saveChatScroll, { passive: true, signal: controller.signal });
  addContactForm.addEventListener('submit', submitAddContact, { signal: controller.signal });
  addContactCheck.addEventListener('click', () => { void checkContactAgain(); }, { signal: controller.signal });
  addContactView.addEventListener('click', viewNewContact, { signal: controller.signal });
  shareCopy.addEventListener('click', () => { void copyShareInfo(); }, { signal: controller.signal });
  shareRetry.addEventListener('click', () => { void loadShare(); }, { signal: controller.signal });

  nodeTrigger.addEventListener('click', () => openDialog(statusDialog, nodeTrigger), { signal: controller.signal });
  $('#ramingaStateAction').addEventListener('click', () => openDialog(statusDialog, $('#ramingaStateAction')), { signal: controller.signal });
  ramingaRefresh.addEventListener('click', () => { void loadJourney(true); }, { signal: controller.signal });
  statusRefresh.addEventListener('click', () => requestRefresh({ visible: true }), { signal: controller.signal });
  mineRefresh.addEventListener('click', () => {
    requestRefresh({ visible: true });
    if (mineCapable) void loadMine(true);
  }, { signal: controller.signal });
  shareNode.addEventListener('click', (event) => {
    openShareDialog(event.currentTarget);
  }, { signal: controller.signal });

  for (const dialog of [statusDialog, noticeDialog, addContactDialog, shareDialog, technicalDialog, agentCardDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest?.('[data-close-dialog]')) {
        closeDialog(dialog);
      }
    }, { signal: controller.signal });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    }, { signal: controller.signal });
  }
  addContactDialog.addEventListener('close', () => {
    // A close abandons only the view callback. The server-side dial cannot be
    // cancelled by this UI, so a late result must never overwrite a new form.
    addAttempt += 1;
    checkAttempt += 1;
    addContactPeerId = '';
  }, { signal: controller.signal });
  shareDialog.addEventListener('close', () => {
    shareAttempt += 1;
    currentShare = null;
  }, { signal: controller.signal });

  for (const page of Object.values(pageEls)) {
    page.addEventListener('scroll', () => {
      // A late scroll event from a hidden source page reports 0 and must not
      // queue a save. The profile surface has no persisted scroll of its own
      // either; its scroll events are not view-state changes.
      if (page.hidden) return;
      scheduleSave();
    }, { passive: true, signal: controller.signal });
  }

  restoreControls();
  showPage(currentPage, { save: false });
  renderNodeMeta();
  renderStatusDialog();
  renderMineIdentity();
  renderMine();
  renderJourney();
  if (view.profile.peerId) {
    profileReturn.page = view.profile.returnPage;
    profileReturn.peerId = view.profile.returnPeer;
    profileTriggerRef = view.profile.triggerId;
    profileReturn.scroll = pageTracksScroll(view.profile.returnPage)
      ? Math.max(0, Number(view.pages[view.profile.returnPage]?.scroll) || 0)
      : Math.max(0, Number(view.pages.messages?.scroll) || 0);
    profileReturn.open = true;
    profileState.peerId = view.profile.peerId;
    pageEls[currentPage].hidden = true;
    profileView.hidden = false;
    renderProfile();
    void loadPeerProfile(view.profile.peerId, false);
  } else {
    ensurePageData(currentPage);
  }

  return {
    setNodeStatus,
    pushNodeEvent,
    setStats,
    setContacts,
    setContactsError,
    setConversations,
    setConversationsError,
    setMessagePage,
    appendMessagePage,
    setMessagesError,
    activeConversationPeer: () => contactsState.selectedPeerId,
    onLeaseReady() {
      if (destroyed) return;
      hostReady = true;
      ensurePageData(currentPage);
      if (!profileView.hidden && profileState.peerId) void loadPeerProfile(profileState.peerId, false);
    },
    getDraft,
    setDraft,
    destroy() {
      if (destroyed) return;
      if (chat.peerId) saveChatScroll();
      destroyed = true;
      controller.abort();
      saveNow();
      addAttempt += 1;
      checkAttempt += 1;
      shareAttempt += 1;
      for (const dialog of [statusDialog, noticeDialog, addContactDialog, shareDialog, technicalDialog, agentCardDialog]) {
        if (dialog.open) dialog.close();
      }
      dialogTriggers.clear();
      technicalReturn = null;
      statusTech.open = false;
      root.replaceChildren();
    },
  };
}
