// Native Raminga main-workspace UI.
//
// This module owns the three-page visual workspace composition, local navigation and
// rendering of generic NodeStatus/NodeEvent values supplied by a host. It never
// opens a daemon socket, reads a token, or imports DSH. The host adapter owns
// daemon access, lifecycle and subscription cleanup.
import { renderPrimaryNav, updateNavUnread, updatePrimaryNav } from './components/navigation.js';
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
import { pageForNav } from './router.js';
import {
  previewFeedback,
  previewKeyFor,
  revealResultKey,
  renderPostDetail,
  renderPublicFileCard,
  sourceDetails,
} from './components/file-card.js';
import {
  imageStateLabel,
  postImageKey,
  renderPostMedia,
  updatePostImageNode,
} from './components/post-images.js';
import {
  copyViewState,
  getDraft as readDraft,
  normalizeViewState,
  setDraft as storeDraft,
} from './view-state.js';
import {
  discoveryListState,
  formatDateTime,
  journeyMessageRefs,
  minePostsStateText,
  postMatchesQuery,
  profileLabel,
  shortPeerText,
} from './content.js';
import { renderSafeMarkdown } from './safe-content.js';
import {
  acquisitionSourcesLabel,
  addressSourceLabel,
  addressesText,
  connectionStateLabel,
  contentStateText,
  fileInfoLine,
  isPostImagePath,
  isPostPath,
  reachabilityLabel,
} from './public-files.js';
import {
  buildHomeActivity,
  buildHomeAgentModel,
  renderActivityDetail,
  renderHomeActivity,
  renderHomeAgent,
  renderHomeHuman,
} from './pages/home.js';
import {
  normalizeSettingsTab,
  renderSettingsNode,
  showSettingsTab,
  SETTINGS_TABS,
} from './pages/settings.js';
import { renderPrivateField } from './pages/settings-private.js';
import {
  journeyMatches,
  renderJourneyDetail,
  renderJourneyTile,
} from './pages/journey-view.js';
import {
  MEMORY_GROUP_PAGE,
  groupContactMemory,
  memoryBody,
  memoryDateValue,
  memoryEvidenceFocusKey,
  memoryKindLabel,
  memoryPreview,
  memorySourceKind,
  summarizeContactMemory,
} from './memory.js';
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
  messageSourceLabel,
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

function plainSummary(markdown, limit = 120) {
  return String(markdown ?? '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
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

/** Translate persisted uncertainty codes at the display boundary. */
export function uncertaintyText(value) {
  return value === 'low' ? '低' : value === 'medium' ? '中' : value === 'high' ? '高' : '';
}

/** Keep persisted source labels user-facing instead of leaking storage codes. */
export function memorySourceText(value) {
  return String(value ?? '')
    .replace(/确定性\s+(low|medium|high)\b/gi, (_, code) => `确定性 ${uncertaintyText(String(code).toLowerCase())}`)
    .replace(/contact-notes/gi, '私有记忆记录');
}

/**
 * Keep the main workspace readable when the host returns a raw RPC/dial error.
 * The full text stays available in the collapsible technical details; this
 * summary must never contain local paths, multiaddrs or a stack.
 */
export function readFailureSummary(raw, fallback = '这次读取没有完成，请稍后重试。') {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return fallback;
  if (/dial|all dials failed|connection refused|peer may be offline|no route to host|network is unreachable|connection reset/i.test(text)) {
    return '对方当前不可达，可能已离线或地址已过期。请稍后重试。';
  }
  if (/timeout|deadline exceeded|timed out/i.test(text)) {
    return '读取超时，请稍后重试。';
  }
  if (/no addresses|no candidate|缺少可用地址|没有可用地址/i.test(text)) {
    return '本机还没有对方的可用地址，暂时无法读取。';
  }
  if (/permission denied|access denied|not permitted|operation not permitted/i.test(text)) {
    return '本机没有读取这项内容的权限。';
  }
  if (/manifest|公开清单/i.test(text)) {
    return '没有读取到对方当前的公开资料，可以稍后重试。';
  }
  if (/not found|不存在|no such file/i.test(text)) {
    return '这项内容已不在本机保留范围。';
  }
  // Anything long, path-like or implementation-specific is not useful in the
  // primary reading surface; leave the exact value in technical details.
  if (text.length > 80 || /\/(?:Users|home|ip4|ip6|tcp|udp|p2p)\/|[A-Za-z]:\\|\.(?:db|sqlite|json|jsonl)\b|sqlite|goroutine|stack/i.test(text)) {
    return fallback;
  }
  return text.slice(0, 80);
}

function selectorValue(value) {
  const text = String(value ?? '');
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(text);
  return text.replace(/["\\]/g, '\\$&');
}

/**
 * Mount the three-page workspace into a ShadowRoot-backed host element.
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
    const hostView = options.viewState && typeof options.viewState === "object" && !Array.isArray(options.viewState) ? options.viewState : null;
    let destroyed = false;
    let saveFrame = null;
    let pendingRefresh = false;
    let lastNodeAnnouncement = "";
    let expectedProgrammaticScroll = null;
    let restoreRun = 0;
    let hostReady = false;
    const pageEls = {
      explore: $("#page-explore"),
      home: $("#page-home"),
      contacts: $("#page-contacts"),
      messages: $("#page-messages"),
      settings: $("#page-settings"),
      post: $("#page-post"),
      journeys: $("#page-journeys"),
      journey: $("#page-journey")
    };
    const pageElsHas = (name) => Object.prototype.hasOwnProperty.call(pageEls, name) && Boolean(pageEls[name]);
    let currentPage = pageElsHas(view.page) ? view.page : "home";
    const nodeState = {
      phase: "loading",
      status: null,
      statusAt: 0,
      error: null,
      errorAt: 0,
      freshness: "loading",
      stream: null,
      stats: null,
      events: []
    };
    const contactsCapable = typeof options.onLoadContacts === "function";
    const contactsState = {
      data: contactsCapable ? { friends: [], at: 0, freshness: "loading", error: "" } : { friends: [], at: 0, freshness: "unavailable", error: "联系人读取暂不可用" },
      transportError: contactsCapable ? "" : "联系人读取暂不可用",
      selectedPeerId: ""
    };
    let contactsRetrying = false;
    const conversationsCapable = typeof options.onLoadConversations === "function";
    const messagesCapable = typeof options.onLoadMessages === "function";
    const sendsCapable = typeof options.onSend === "function";
    const cancelsCapable = typeof options.onCancelOutbox === "function";
    const conversationsState = {
      data: conversationsCapable ? { conversations: [], at: 0, freshness: "loading", error: "" } : { conversations: [], at: 0, freshness: "unavailable", error: "会话列表读取暂不可用" },
      transportError: conversationsCapable ? "" : "会话列表读取暂不可用"
    };
    let conversationsRetrying = false;
    const discoveriesCapable = typeof options.onLoadDiscoveries === "function";
    const discoveryContentCapable = typeof options.onLoadDiscoveryContent === "function";
    const revealCapable = typeof options.onRevealDiscovery === "function";
    const fileRevealCapable = typeof options.onRevealFile === "function";
    const mineCapable = typeof options.onLoadMine === "function";
    const mineFileContentCapable = typeof options.onLoadMineFileContent === "function";
    const journeyCapable = typeof options.onLoadJourney === "function";
    const activityCapable = typeof options.onLoadActivity === "function";
    const activityDetailCapable = typeof options.onLoadActivityDetail === "function";
    const privateAgentSaveCapable = typeof options.onSavePrivateAgent === "function";
    const publicDraftLoadCapable = typeof options.onLoadPublicDraft === "function";
    const publicDraftSaveCapable = publicDraftLoadCapable && typeof options.onSavePublicDraft === "function";
    const publicDraftImageCapable = publicDraftSaveCapable && typeof options.onPutPublicDraftImage === "function";
    const publicDraftAssetCapable = publicDraftLoadCapable && typeof options.onLoadPublicDraftAsset === "function";
    const publicDraftImportCapable = publicDraftSaveCapable && typeof options.onImportPublicPost === "function";
    const publicDraftListCapable = publicDraftLoadCapable && typeof options.onLoadPublicDrafts === "function";
    const publishDraftCapable = publicDraftSaveCapable && typeof options.onPublishPublicDraft === "function";
    const peerProfileCapable = typeof options.onLoadPeerProfile === "function";
    const peerFriendsCapable = typeof options.onLoadPeerFriends === "function";
    const contactProjectionCapable = typeof options.onLoadContactProjection === "function";
    const peerManifestCapable = typeof options.onLoadPeerManifest === "function";
    const peerFileContentCapable = typeof options.onLoadPeerFileContent === "function";
    const peerNodeInfoCapable = typeof options.onLoadPeerNodeInfo === "function";
    const bootstrapCapable = typeof options.onLoadBootstrap === "function";
    const bootstrapEditCapable = typeof options.onAddBootstrap === "function" && typeof options.onRemoveBootstrap === "function";
    const locateMessageCapable = typeof options.onLocateMessage === "function";
    const markReadCapable = typeof options.onMarkRead === "function";
    const favoritesCapable = typeof options.onLoadFavorites === "function";
    const setFavoriteCapable = favoritesCapable && typeof options.onSetFavorite === "function";
    const peerDiscoveriesCapable = typeof options.onLoadPeerDiscoveries === "function";
    const contactMemoryCapable = typeof options.onLoadContactMemory === "function";
    const saveContactImpressionCapable = contactMemoryCapable && typeof options.onSaveContactImpression === "function";
    const friendNameEditCapable = typeof options.onSetFriendName === "function";
    const friendDescriptionEditCapable = typeof options.onSetFriendDescription === "function";
    const friendEditCapable = friendNameEditCapable || friendDescriptionEditCapable;
    const connectCapable = typeof options.onConnect === "function";
    const contactConnectState = /* @__PURE__ */ new Map();
    const emptyDiscoveries = (familiar = false) => ({
      items: [],
      at: null,
      error: null,
      errorAt: null,
      freshness: "loading",
      familiar,
      scanned: 0,
      truncated: false,
      relationComplete: !familiar,
      ignored: 0
    });
    const discoveryByFilter = /* @__PURE__ */ new Map();
    const discoveryRequests = /* @__PURE__ */ new Map();
    const discoveryStale = /* @__PURE__ */ new Set();
    const DISCOVERY_REVALIDATE_MS = 15e3;
    const DISCOVERY_SCAN_LIMIT = 500;
    const mineState = { data: null, error: "", requestSeq: 0, retrying: false };
    const profileDraftState = {
      loaded: false,
      loading: null,
      loadingSeq: 0,
      saving: false,
      savingPromise: null,
      queuedSave: false,
      publishSeq: 0,
      publishing: false,
      draft: null,
      dirty: false,
      fromFallback: false,
      error: "",
      conflict: false,
      reloadArmed: false,
      avatarFile: null,
      avatarAssetId: "",
      avatarClear: false,
      avatarPreviewUrl: "",
      avatarPreviewObject: false,
      avatarPreviewAssetId: "",
      avatarLoadingAssetId: "",
      avatarError: "",
      avatarRestoreToken: 0,
      humanAvatarFile: null,
      humanAvatarAssetId: "",
      humanAvatarClear: false,
      humanAvatarPreviewUrl: "",
      humanAvatarPreviewObject: false,
      humanAvatarPreviewAssetId: "",
      humanAvatarLoadingAssetId: "",
      humanAvatarError: "",
      humanAvatarRestoreToken: 0,
      receipt: null,
      confirm: false,
      confirmSnapshot: "",
      confirmNotice: "",
      formVersion: 0
    };
    let profileSaveTimer = null;
    const postEditorState = {
      open: false,
      loading: false,
      loaded: false,
      listLoaded: false,
      list: [],
      draft: null,
      pending: [],
      dirty: false,
      saving: false,
      uploading: false,
      publishing: false,
      validatingImages: 0,
      error: "",
      receipt: null,
      confirm: false,
      confirmSnapshot: null,
      confirmNotice: "",
      imported: false,
      requestSeq: 0,
      formVersion: 0,
      draftEpoch: 0,
      draftLoadSeq: 0,
      listSeq: 0,
      // A destructive editor action (opening another post, switching drafts)
      // cannot save an incomplete new post. Keep that private input here until
      // the reader can explicitly recover it; never let the newer draft wipe it.
      stash: null
    };
    let postEditorReturn = null;
    let postEditorReturnFocus = null;
    let postEditorReturnFocusToken = 0;
    let postSaveTimer = null;
    const homeAvatarState = { key: "", url: "", loading: false, requestedKey: "", generation: 0 };
    const homeHumanAvatarState = { key: "", url: "", loading: false, requestedKey: "", generation: 0 };
    const JOURNEY_REVALIDATE_MS = 15e3;
    const journeyState = {
      data: null,
      error: "",
      retrying: false,
      request: null
    };
    let journeyReport = { id: "", original: false, preview: null };
    const activityState = {
      data: null,
      error: "",
      instanceId: "",
      previousInstanceId: "",
      detail: { id: "", data: null, loading: false, error: "", request: 0, pending: null }
    };
    const profileState = {
      peerId: "",
      data: null,
      error: "",
      requestSeq: 0,
      retrying: false,
      friends: { data: null, error: "", requestSeq: 0, retrying: false },
      posts: { data: null, error: "", requestSeq: 0, retrying: false },
      memory: { data: null, error: "", requestSeq: 0, retrying: false },
      node: { data: null, error: "", requestSeq: 0, retrying: false }
    };
    const favoriteReader = {
      item: null,
      preview: null,
      loading: false,
      error: "",
      requestSeq: 0
    };
    const favoritesState = {
      items: [],
      byKey: /* @__PURE__ */ new Map(),
      loaded: false,
      loading: false,
      error: "",
      nextBefore: "",
      hasMore: false,
      pending: /* @__PURE__ */ new Set(),
      actionError: "",
      requestSeq: 0
    };
    let markReadTimer = null;
    let markReadKey = "";
    let markReadSeq = 0;
    let markReadInFlight = false;
    const impressionEditState = { open: false, saving: false, peerId: "", impressionId: "", expectedSha: "" };
    const profileMemoryUi = {
      peerId: "",
      daysShown: 2,
      openGroups: /* @__PURE__ */ new Set(),
      closedGroups: /* @__PURE__ */ new Set(),
      groupLimits: /* @__PURE__ */ new Map(),
      openItems: /* @__PURE__ */ new Set(),
      impressionExpanded: false
    };
    function resetProfileMemoryUi(peerId2 = "") {
      if (profileMemoryUi.peerId === peerId2 && peerId2 !== "") return;
      profileMemoryUi.peerId = peerId2;
      profileMemoryUi.daysShown = 2;
      profileMemoryUi.openGroups.clear();
      profileMemoryUi.closedGroups.clear();
      profileMemoryUi.groupLimits.clear();
      profileMemoryUi.openItems.clear();
      profileMemoryUi.impressionExpanded = false;
      if (profileImpressionStatus) {
        profileImpressionStatus.hidden = true;
        profileImpressionStatus.textContent = "";
        delete profileImpressionStatus.dataset.tone;
      }
    }
    const profileReturn = {
      page: "explore",
      peerId: "",
      triggerRef: "",
      // The source page is display:none while the profile is open. Chromium
      // collapses its scrollTop to 0, so this is the only trustworthy reading
      // position until the profile closes.
      scroll: null,
      open: false,
      // A return from chat may ask for an evidence row that is rendered by a
      // later async memory read. Keep the key until that row exists once.
      focusKey: ""
    };
    let profileTriggerRef = "";
    let postDetailRendering = false;
    let profilePressScroll = null;
    let profileChatPress = null;
    let profileScrollMemory = { tab: "", scroll: 0, at: 0 };
    const postContent = /* @__PURE__ */ new Map();
    const postContentRequests = /* @__PURE__ */ new Map();
    let postContentGeneration = 0;
    const peerPostMetaCapable = typeof options.onLoadPeerPostMeta === "function";
    const postMetaCache = /* @__PURE__ */ new Map();
    const postMetaInflight = /* @__PURE__ */ new Map();
    const postMetaQueue = [];
    let postMetaActive = 0;
    const postImageCache = /* @__PURE__ */ new Map();
    const postImageQueues = [];
    let postImageActive = 0;
    const postImageTimers = /* @__PURE__ */ new Map();
    const postImageObservers = /* @__PURE__ */ new WeakMap();
    const postImageContainerObservers = /* @__PURE__ */ new WeakMap();
    const peerAvatarState = /* @__PURE__ */ new Map();
    const peerHumanAvatarState = /* @__PURE__ */ new Map();
    const verifiedContactProfiles = /* @__PURE__ */ new Map();
    const directoryClues = /* @__PURE__ */ new Map();
    const directorySourceReads = /* @__PURE__ */ new Set();
    let contactProjectionLoading = false;
    let contactProjectionLoaded = false;
    const expandedContactIds = /* @__PURE__ */ new Set();
    let imagePreviewKey = "";
    let imagePreviewTrigger = null;
    let imagePreviewScroll = null;
    const revealResults = /* @__PURE__ */ new Map();
    const profilePreviews = /* @__PURE__ */ new Map();
    const profileExpanded = /* @__PURE__ */ new Set();
    const minePreviews = /* @__PURE__ */ new Map();
    const mineExpanded = /* @__PURE__ */ new Set();
    const bootstrapState = { data: null, error: "", request: null, busy: false, feedback: "", feedbackTone: "" };
    let locateSeq = 0;
    const locateRequests = /* @__PURE__ */ new Map();
    function createChatState(peerId2 = "") {
      return {
        peerId: peerId2,
        items: [],
        at: 0,
        error: "",
        freshness: "loading",
        retention: null,
        // The latest page and the older-than window have independent cursors.
        // A routine latest refresh must never move historyCursor backwards.
        latestLoaded: false,
        historyHasMore: false,
        historyCursor: "",
        // `historyEnded` is only set by an explicit hasMore=false page. A missing
        // or non-advancing cursor with hasMore=true is an unknown boundary, not an
        // end, and must keep its already-loaded rows reachable.
        historyEnded: false,
        historyError: "",
        historyRetryMode: "",
        historyRetrying: false,
        historyRetryPending: false,
        loadingOlder: false,
        olderError: "",
        requestSeq: 0,
        restoreScroll: 0,
        restoreWindow: false,
        restoreAnchor: null,
        anchorMissing: false,
        restoreLoading: false,
        restorePages: 0,
        pendingRestore: false,
        firstPage: true,
        focusMessageId: "",
        focusNotice: "",
        focusProbe: 0,
        focusBusy: false,
        generation: 0,
        // The surface and trigger that opened this chat. It survives a host
        // remount through view state; an absent/!= selected Peer source means the
        // back action falls back to the conversation index.
        returnPage: "",
        returnPeer: "",
        returnJourneyId: "",
        returnJourneyEvent: 0,
        returnJourneyMessage: "",
        returnProfileTab: "interactions",
        returnProfileScroll: 0,
        returnFocus: ""
      };
    }
    const chatStates = /* @__PURE__ */ new Map();
    let chat = createChatState("");
    const appliedMessagePages = /* @__PURE__ */ new WeakSet();
    const sendTasks = /* @__PURE__ */ new Map();
    let sendSeq = 0;
    let composerComposing = false;
    const cancellingIds = /* @__PURE__ */ new Set();
    let composerNotice = null;
    let composerDetailText = "";
    let addAttempt = 0;
    let checkAttempt = 0;
    let addContactPeerId = "";
    let addContactPending = false;
    let checkPending = false;
    let shareAttempt = 0;
    let currentShare = null;
    let editAttempt = 0;
    let editTargetPeerId = "";
    let editOriginal = { name: "", description: "" };
    let editPending = false;
    let quickMenuPeerId = "";
    let quickMenuTrigger = null;
    const privateEditors = {
      persona: { dirty: false, saving: false, expectedSha: "", error: "" },
      growth: { dirty: false, saving: false, expectedSha: "", error: "" }
    };
    let privateSaveSeq = 0;
    let settingsReturnPage = "home";
    let settingsReturnFocus = null;
    let settingsReturnScroll = 0;
    let settingsFocusSeq = 0;
    let settingsDirectEntry = false;
    let settingsFavoriteReturn = null;
    const nodeTrigger = $("#nodeTrigger");
    const nodeDot = $("#nodeDot");
    const nodeLabel = $("#nodeLabel");
    const nodeLive = $("#nodeLive");
    const statusDialog = $("#statusDialog");
    const noticeDialog = $("#noticeDialog");
    const addContactDialog = $("#addContactDialog");
    const shareDialog = $("#shareDialog");
    const statusRefresh = $("#statusRefresh");
    const exploreRefresh = $("#exploreRefresh");
    const exploreSearch = $("#exploreSearch");
    const exploreQuery = $("#exploreQuery");
    const exploreClear = $("#exploreClear");
    const contactQuery = $("#contactQuery");
    const contactList = $("#contactList");
    const contactClues = $("#contactClues");
    const contactClueList = $("#contactClueList");
    const contactCluesNote = $("#contactCluesNote");
    const contactsShare = $("#contactsShare");
    const contactsMessages = $("#contactsMessages");
    const contactsMeta = $("#contactsMeta");
    const contactsMetaRetry = $("#contactsMetaRetry");
    const contactsStateActions = $("#contactsStateAction");
    const contactsRetryAction = $("#contactsStateRetry");
    const contactsShareAction = $("#contactsShareAction");
    const contactAllCount = $("#contactAllCount");
    const contactUnreadCount = $("#contactUnreadCount");
    const contactFilters = $$("[data-contact-filter]");
    const contactsSection = $("#contactsState");
    const messagesIndex = $("#messagesIndex");
    const conversationView = $("#conversationView");
    const conversationBack = $("#conversationBack");
    const conversationIndexBack = $("#conversationIndexBack");
    const conversationName = $("#conversationName");
    const conversationPeerId = $("#conversationPeerId");
    const conversationState = $("#conversationState");
    const conversationAvatar = $("#conversationAvatar");
    const conversationProfile = $("#conversationProfile");
    const conversationMenu = $("#conversationMenu");
    const conversationOrigin = $("#conversationOrigin");
    const conversationLocalNote = $("#conversationLocalNote");
    const contactQuickMenu = $("#contactQuickMenu");
    const conversationQuery = $("#conversationQuery");
    const conversationList = $("#conversationList");
    const conversationsMeta = $("#conversationsMeta");
    const conversationsMetaRetry = $("#conversationsMetaRetry");
    const messagesStateSection = $("#messagesState");
    const messageList = $("#messageList");
    const messageStateSection = $("#messageState");
    const messageStale = $("#messageStale");
    const messageFocusNote = $("#messageFocusNote");
    const messageRetry = $("#messageRetry");
    const messageOlderError = $("#messageOlderError");
    const messageHistoryRetry = $("#messageHistoryRetry");
    const messageRestoreNote = $("#messageRestoreNote");
    const messageRestoreActions = $("#messageRestoreActions");
    const messageRestoreAction = $("#messageRestoreAction");
    const messageRestoreLatest = $("#messageRestoreLatest");
    const loadOlder = $("#loadOlder");
    const messageRetention = $("#messageRetention");
    const composer = $("#composer");
    const composerJump = $("#composerJump");
    const composerOverlay = $("#composerOverlay");
    const messageInput = $("#messageInput");
    const messageSend = $("#messageSend");
    const messageJumpLatest = $("#messageJumpLatest");
    const messageCounter = $("#messageCounter");
    const composerStatus = $("#composerStatus");
    const composerTech = $("#composerTech");
    const technicalDialog = $("#technicalDialog");
    const technicalHeading = $("#technicalHeading");
    const technicalIntro = $("#technicalIntro");
    const technicalRaw = $("#technicalRaw");
    const composerActions = $("#composerActions");
    const sendReconcile = $("#sendReconcile");
    const sendRestore = $("#sendRestore");
    const addContactForm = $("#addContactForm");
    const addContactInput = $("#addContactInput");
    const addContactSubmit = $("#addContactSubmit");
    const addContactView = $("#addContactView");
    const addContactCheck = $("#addContactCheck");
    const addContactFeedback = $("#addContactFeedback");
    const addContactFeedbackTitle = $("#addContactFeedbackTitle");
    const addContactFeedbackBody = $("#addContactFeedbackBody");
    const addContactFeedbackContact = $("#addContactFeedbackContact");
    const addContactFeedbackStatus = $("#addContactFeedbackStatus");
    const addContactFeedbackDetail = $("#addContactFeedbackDetail");
    const addContactFeedbackRaw = $("#addContactFeedbackRaw");
    const shareLoading = $("#shareLoading");
    const shareContent = $("#shareContent");
    const sharePeerId = $("#sharePeerId");
    const shareAddresses = $("#shareAddresses");
    const shareAddressNote = $("#shareAddressNote");
    const shareStaleNote = $("#shareStaleNote");
    const shareFailure = $("#shareFailure");
    const shareFailureBody = $("#shareFailureBody");
    const shareFailureDetail = $("#shareFailureDetail");
    const shareFailureRaw = $("#shareFailureRaw");
    const shareManual = $("#shareManual");
    const shareCopyStatus = $("#shareCopyStatus");
    const shareCopy = $("#shareCopy");
    const shareRetry = $("#shareRetry");
    const mineIdentity = $("#mineIdentity");
    const mineSummary = $("#mineIdentitySummary");
    const mineDetails = $("#mineIdentityDetails");
    const mineIdentityAction = $("#mineIdentityAction");
    const mineRefresh = $("#mineRefresh");
    const mineProfileContent = $("#mineProfileContent");
    const mineContentStatus = $("#mineContentStatus");
    const mineContentNote = $("#mineContentNote");
    const minePostList = $("#minePostList");
    const mineRetry = $("#mineRetry");
    const discoveryMeta = $("#discoveryMeta");
    const discoveryMetaRetry = $("#discoveryMetaRetry");
    const discoveryScope = $("#discoveryScope");
    const discoveryScopeBody = $("#discoveryScopeBody");
    const discoveryList = $("#discoveryList");
    const mineFeedList = $("#mineFeedList");
    const postDetail = $("#postDetail");
    const postDetailState = $("#postDetailState");
    const postDetailStateTitle = $("#postDetailStateTitle");
    const postDetailStateBody = $("#postDetailStateBody");
    const postDetailStateAction = $("#postDetailStateAction");
    const postBack = $("#postBack");
    const mineFeedState = $("#mineFeedState");
    const mineFeedStateTitle = $("#mineFeedStateTitle");
    const mineFeedStateBody = $("#mineFeedStateBody");
    const mineFeedStateAction = $("#mineFeedStateAction");
    const ramingaJourneyMeta = $("#ramingaJourneyMeta");
    const ramingaSessionList = $("#ramingaSessionList");
    const ramingaRecordsStatus = $("#ramingaRecordsStatus");
    const ramingaRefresh = $("#ramingaRefresh");
    const homeAgentAvatar = $("#homeAgentAvatar");
    const homeAgentInitial = $("#homeAgentInitial");
    const homeAgentName = $("#homeAgentName");
    const homeAgentBadge = $("#homeAgentBadge");
    const homeAgentBio = $("#homeAgentBio");
    const homeAgentProfileNote = $("#homeAgentProfileNote");
    const homeAgentProfileNoteText = $("#homeAgentProfileNoteText");
    const homeAgentProfileRetry = $("#homeAgentProfileRetry");
    const homeAgentInterests = $("#homeAgentInterests");
    const homeAgentStyle = $("#homeAgentStyle");
    const homeAgentStatusText = $("#homeAgentStatusText");
    const homeAgentStatusDot = $("#homeAgentStatus .rm-home-status-dot");
    const homeActivityLive = $("#homeActivityLive");
    const homeActivityRecent = $("#homeActivityRecent");
    const homeActivityEmpty = $("#homeActivityEmpty");
    const homeActivityDetail = $("#homeActivityDetail");
    const homeActivityToggle = $("#homeActivityToggle");
    const homeActivityDisclosure = $("#homeActivityDisclosure");
    const homeJourneysAll = $("#homeJourneysAll");
    const homeJourneysEmpty = $("#homeJourneysEmpty");
    const homeJourneyDetails = $("#homeJourneyDetails");
    const journeysBack = $("#journeysBack");
    const journeysRefresh = $("#journeysRefresh");
    const journeysCount = $("#journeysCount");
    const journeysClear = $("#journeysClear");
    const journeysWarning = $("#journeysWarning");
    const journeysScope = $("#journeysScope");
    const journeysScopeBody = $("#journeysScopeBody");
    const journeyQuery = $("#journeyQuery");
    const journeyList = $("#journeyList");
    const journeysState = $("#journeysState");
    const journeysStateTitle = $("#journeysStateTitle");
    const journeysStateBody = $("#journeysStateBody");
    const journeysStateAction = $("#journeysStateAction");
    const journeyBack = $("#journeyBack");
    const journeyDetail = $("#journeyDetail");
    const journeyPageState = $("#journeyState");
    const journeyPageStateTitle = $("#journeyStateTitle");
    const journeyPageStateBody = $("#journeyStateBody");
    const journeyPageStateAction = $("#journeyStateAction");
    const homeHumanTitle = $("#mineIdentityTitle");
    const homeHumanSummary = $("#mineIdentitySummary");
    const homeHumanAvatar = $("#homeHumanAvatar");
    const settingsTrigger = $("#settingsTrigger");
    const settingsClose = $("#settingsClose");
    const settingsHumanStatus = $("#settingsHumanStatus");
    const publicDraftBanner = $("#publicDraftBanner");
    const publicDraftStatus = $("#publicDraftStatus");
    const publicDraftSave = $("#publicDraftSave");
    const publicDraftReload = $("#publicDraftReload");
    const publicPublishButton = $("#publicPublishButton");
    const publicPublishCancel = $("#publicPublishCancel");
    const publicPublishStatus = $("#publicPublishStatus");
    const publicPublishReceipt = $("#publicPublishReceipt");
    const publicPublishReceiptDetails = $("#publicPublishReceiptDetails");
    const publicAvatarInput = $("#publicAvatarInput");
    const publicAvatarClear = $("#publicAvatarClear");
    const publicAvatarPreview = $("#publicAvatarPreview");
    const publicAvatarNote = $("#publicAvatarNote");
    const publicHumanAvatarInput = $("#publicHumanAvatarInput");
    const publicHumanAvatarClear = $("#publicHumanAvatarClear");
    const publicHumanAvatarPreview = $("#publicHumanAvatarPreview");
    const publicHumanAvatarNote = $("#publicHumanAvatarNote");
    const settingsHumanPreview = $("#settingsHumanPreview");
    const publicVersionPreview = $("#publicVersionPreview");
    const publicVersionName = $("#publicVersionName");
    const publicVersionAvatar = $("#publicVersionAvatar");
    const publicVersionDescription = $("#publicVersionDescription");
    const publicVersionInterests = $("#publicVersionInterests");
    const publicVersionStyle = $("#publicVersionStyle");
    const publicVersionHuman = $("#publicVersionHuman");
    const publicVersionNote = $("#publicVersionNote");
    const publicRestorePublished = $("#publicRestorePublished");
    const publicVersionRetry = $("#publicVersionRetry");
    const publicDraftMeta = $("#publicDraftMeta");
    const publicAgentName = $("#publicAgentName");
    const publicAgentDescription = $("#publicAgentDescription");
    const publicAgentInterests = $("#publicAgentInterests");
    const publicAgentStyle = $("#publicAgentStyle");
    const publicHumanName = $("#publicHumanName");
    const publicHumanBio = $("#publicHumanBio");
    const composePost = $("#composePost");
    const postEditorPanel = $("#postEditorPanel");
    const postEditorHeading = $("#postEditorHeading");
    const postEditorDismiss = $("#postEditorDismiss");
    const postEditorStatus = $("#postEditorStatus");
    const postDraftSelect = $("#postDraftSelect");
    const postTitleInput = $("#postTitleInput");
    const postBodyInput = $("#postBodyInput");
    const postTagsInput = $("#postTagsInput");
    const postAuthorKind = $("#postAuthorKind");
    const postAuthorNote = $("#postAuthorNote");
    const postImageInput = $("#postImageInput");
    const postImageList = $("#postImageList");
    const postEditorNote = $("#postEditorNote");
    const postPublishReceipt = $("#postPublishReceipt");
    const postEditorClose = $("#postEditorClose");
    const postRestoreStash = $("#postRestoreStash");
    const postDiscardStash = $("#postDiscardStash");
    const postDraftSave = $("#postDraftSave");
    const postSaveAsNew = $("#postSaveAsNew");
    const postPublishButton = $("#postPublishButton");
    const postPublishCancel = $("#postPublishCancel");
    const postWriteAnother = $("#postWriteAnother");
    const settingsPrivateNote = $("#settingsPrivateNote");
    const favoritesEntry = $("#favoritesEntry");
    const settingsMemoryList = $("#settingsMemoryList");
    const settingsMemoryNote = $("#settingsMemoryNote");
    const settingsMemoryEmpty = $("#settingsMemoryEmpty");
    const settingsFavoritesList = $("#settingsFavoritesList");
    const settingsFavoritesNote = $("#settingsFavoritesNote");
    const settingsFavoritesEmpty = $("#settingsFavoritesEmpty");
    const settingsFavoritesMore = $("#settingsFavoritesMore");
    const favoriteDialog = $("#favoriteDialog");
    const favoriteDialogHeading = $("#favoriteDialogHeading");
    const favoriteDialogMeta = $("#favoriteDialogMeta");
    const favoriteDialogNote = $("#favoriteDialogNote");
    const favoriteDialogBody = $("#favoriteDialogBody");
    const settingsNodeSummary = $("#settingsNodeSummary");
    const settingsNodeStatusLabel = $("#settingsNodeStatusLabel");
    const settingsNodeStatus = $("#settingsNodeStatus");
    const settingsNodeShare = $("#settingsNodeShare");
    const settingsStableInput = $("#settingsStableInput");
    const settingsGrowthInput = $("#settingsGrowthInput");
    const settingsStableSave = $("#settingsStableSave");
    const settingsGrowthSave = $("#settingsGrowthSave");
    const settingsStableReload = $("#settingsStableReload");
    const settingsGrowthReload = $("#settingsGrowthReload");
    const settingsStableMeta = $("#settingsStableMeta");
    const settingsGrowthMeta = $("#settingsGrowthMeta");
    const settingsStableStatus = $("#settingsStableStatus");
    const settingsGrowthStatus = $("#settingsGrowthStatus");
    const profileView = $("#profileView");
    const profileBack = $("#profileBack");
    const profileTabs = $$("#profileView [data-profile-tab]");
    const profileAvatar = $("#profileAvatar");
    const profileName = $("#profileName");
    const profileAgentBadge = $("#profileAgentBadge");
    const profileAgentDescriptionShort = $("#profileAgentDescriptionShort");
    const profileMissingNote = $("#profileMissingNote");
    const profileInterests = $("#profileInterests");
    const profileConversationStyle = $("#profileConversationStyle");
    const profileFreshness = $("#profileFreshness");
    const profileOriginDetails = $("#profileOriginDetails");
    const profilePeerId = $("#profilePeerId");
    const profileSource = $("#profileSource");
    const profileOriginNote = $("#profileOriginNote");
    const profileOriginReadAt = $("#profileOriginReadAt");
    const profileOriginSnapshotAt = $("#profileOriginSnapshotAt");
    const profileOriginCardPath = $("#profileOriginCardPath");
    const profileLocalNote = $("#profileLocalNote");
    const profileCopyPeerInline = $("#profileCopyPeerInline");
    const profileStale = $("#profileStale");
    const profileError = $("#profileError");
    const profileReadDetails = $("#profileReadDetails");
    const profileReadRaw = $("#profileReadRaw");
    const profileRetry = $("#profileRetry");
    const profileBody = $("#profileBody");
    const profileBodyNote = $("#profileBodyNote");
    const profileHumanStrip = $("#profileHumanStrip");
    const profileHumanHeadingLabel = $("#profileHumanHeadingLabel");
    const profileHumanName = $("#profileHumanName");
    const profileHumanAvatar = $("#profileHumanAvatar");
    const profileHumanInitial = $("#profileHumanInitial");
    const profileAgentOpen = $("#profileAgentOpen");
    const profileMessage = $("#profileMessage");
    const profileTabsNav = $("#profileTabsNav");
    const profileAddressStatus = $("#profileAddressStatus");
    const profileAddressNote = $("#profileAddressNote");
    const profileAddressDetails = $("#profileAddressDetails");
    const profileAddressRaw = $("#profileAddressRaw");
    const profileFriendList = $("#profileFriendList");
    const profileAddressEmpty = $("#profileAddressEmpty");
    const profileAddressEmptyTitle = $("#profileAddressEmptyTitle");
    const profileAddressEmptyText = $("#profileAddressEmptyText");
    const profileAddressRetry = $("#profileAddressRetry");
    const profileHumanSummary = $("#profileHumanSummary");
    const profileTimelineStatus = $("#profileTimelineStatus");
    const profileTimeline = $("#profileTimeline");
    const profileTimelineEmpty = $("#profileTimelineEmpty");
    const profileMemoryQuickbar = $("#profileMemoryQuickbar");
    const profileMemoryQuickSummary = $("#profileMemoryQuickSummary");
    const profileMemoryQuickSource = $("#profileMemoryQuickSource");
    const profileImpressionQuickText = $("#profileImpressionQuickText");
    const profileImpressionQuickEdit = $("#profileImpressionQuickEdit");
    const profileMemoryOverview = $("#profileMemoryOverview");
    const profileMemorySummary = $("#profileMemorySummary");
    const profileMemoryKinds = $("#profileMemoryKinds");
    const profileMemorySource = $("#profileMemorySource");
    const profileMemoryTimelineCount = $("#profileMemoryTimelineCount");
    const profileMemoryTimelineNote = $("#profileMemoryTimelineNote");
    const profileMemoryMore = $("#profileMemoryMore");
    const profileInteractionNote = $("#profileInteractionNote");
    const profileMemoryError = $("#profileMemoryError");
    const profileMemoryDetails = $("#profileMemoryDetails");
    const profileMemoryRaw = $("#profileMemoryRaw");
    const profileMemoryRetry = $("#profileMemoryRetry");
    const profileImpressionSummary = $("#profileImpressionSummary");
    const profileImpressionMeta = $("#profileImpressionMeta");
    const profileImpressionToggle = $("#profileImpressionToggle");
    const profileImpressionStatus = $("#profileImpressionStatus");
    const profileImpressionEdit = $("#profileImpressionEdit");
    const profilePostsStatus = $("#profilePostsStatus");
    const profilePostsRefresh = $("#profilePostsRefresh");
    const profilePostsNote = $("#profilePostsNote");
    const profilePostList = $("#profilePostList");
    const profileNodeConnection = $("#profileNodeConnection");
    const profileNodeRoutes = $("#profileNodeRoutes");
    const profileNodeStatusAt = $("#profileNodeStatusAt");
    const profileCopyCurrent = $("#profileCopyCurrent");
    const profileCurrentNote = $("#profileCurrentNote");
    const profileCurrentAddrs = $("#profileCurrentAddrs");
    const profileCopyAnnounced = $("#profileCopyAnnounced");
    const profileAnnouncedNote = $("#profileAnnouncedNote");
    const profileAnnouncedAddrs = $("#profileAnnouncedAddrs");
    const profileNodeRefresh = $("#profileNodeRefresh");
    const profileNodeNote = $("#profileNodeNote");
    const agentCardDialog = $("#agentCardDialog");
    const imagePreviewDialog = $("#imagePreviewDialog");
    const imagePreviewImg = $("#imagePreviewImg");
    const imagePreviewNote = $("#imagePreviewNote");
    const imagePreviewMeta = $("#imagePreviewMeta");
    const imagePreviewCounter = $("#imagePreviewCounter");
    const impressionDialog = $("#impressionDialog");
    const impressionForm = $("#impressionForm");
    const impressionSummaryInput = $("#impressionSummary");
    const impressionUncertainty = $("#impressionUncertainty");
    const impressionDialogNote = $("#impressionDialogNote");
    const impressionSave = $("#impressionSave");
    const editContactDialog = $("#editContactDialog");
    const editContactForm = $("#editContactForm");
    const editContactPeerId = $("#editContactPeerId");
    const editContactName = $("#editContactName");
    const editContactNameClear = $("#editContactNameClear");
    const editContactDescription = $("#editContactDescription");
    const editContactDescriptionClear = $("#editContactDescriptionClear");
    const editContactFeedback = $("#editContactFeedback");
    const editContactFeedbackTitle = $("#editContactFeedbackTitle");
    const editContactFeedbackBody = $("#editContactFeedbackBody");
    const editContactSave = $("#editContactSave");
    const profileEditContact = $("#profileEditContact");
    const profileAddContact = $("#profileAddContact");
    const agentCardSource = $("#agentCardSource");
    const agentCardBody = $("#agentCardBody");
    const statusBootstrap = $("#statusBootstrap");
    const statusBootstrapNote = $("#statusBootstrapNote");
    const statusBootstrapList = $("#statusBootstrapList");
    const statusBootstrapEdit = $("#statusBootstrapEdit");
    const statusBootstrapInput = $("#statusBootstrapInput");
    const statusBootstrapAdd = $("#statusBootstrapAdd");
    const statusBootstrapFeedback = $("#statusBootstrapFeedback");
    const statusBootstrapUpgrade = $("#statusBootstrapUpgrade");
    const statusBootstrapUnavailable = $("#statusBootstrapUnavailable");
    const statusBootstrapCopy = $("#statusBootstrapCopy");
    const statusBootstrapRefresh = $("#statusBootstrapRefresh");
    const statusShareNode = $("#statusShareNode");
    const statusTech = $("#statusTech");
    const noticeNote = $("#noticeNote");
    const dialogTriggers = /* @__PURE__ */ new Map();
    let technicalReturn = null;
    function pageStateFor(pageName) {
      if (pageName === "home") return view.home;
      if (pageName === "settings") return view.settings;
      if (pageName === "post") return view.post;
      if (pageName === "journeys") return view.pages.journeys;
      if (pageName === "journey") return view.journey;
      return view.pages[pageName] ?? null;
    }
    function pageTracksScroll(pageName) {
      return Boolean(pageStateFor(pageName)) && !(pageName === "messages" && contactsState.selectedPeerId);
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
        pageStateFor(profileReturn.page).scroll = Math.max(0, Number(profileReturn.scroll) || 0);
      } else if (pageTracksScroll(currentPage)) {
        const live = visiblePageScroll(currentPage);
        if (live !== null) pageStateFor(currentPage).scroll = live;
      }
      copyViewState(hostView, view);
    }
    function scheduleSave() {
      if (destroyed) return;
      if (typeof win.requestAnimationFrame !== "function") {
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
        if (typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(saveFrame);
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
      if (typeof win.requestAnimationFrame !== "function") return;
      win.requestAnimationFrame(() => {
        if (destroyed || profileReturn.open || page.hidden || value === 0) return;
        if (Number(page.scrollTop) === 0) {
          page.scrollTop = value;
          saveNow();
        }
      });
    }
    function showPage(pageName, { save = true } = {}) {
      if (destroyed) return;
      if (pageName !== "messages") cancelMarkRead();
      const next = pageElsHas(pageName) ? pageName : "home";
      if (next !== "settings") clearSettingsFavoriteReturn();
      if (next !== currentPage) flushPublicDraftEditors();
      if (!profileView.hidden && view.contactProfile.returnPage !== next) closePeerProfile({ restoreFocus: false });
      if (save) {
        const live = visiblePageScroll(currentPage);
        if (live !== null && pageTracksScroll(currentPage)) pageStateFor(currentPage).scroll = live;
      }
      if (currentPage === "post" && next !== "post") clearPostDetail();
      currentPage = next;
      view.page = next;
      for (const [name, page] of Object.entries(pageEls)) {
        page.hidden = name !== next;
      }
      const active = pageEls[next];
      active.hidden = false;
      active.scrollTop = pageStateFor(next).scroll;
      if (next === "messages" && contactsState.selectedPeerId) active.scrollTop = 0;
      updatePrimaryNav(root, next);
      if (next === "settings") settingsTrigger.setAttribute("aria-current", "page");
      else settingsTrigger.removeAttribute("aria-current");
      if (next === "home") renderHome();
      if (next === "settings") renderSettingsView();
      if (next === "post") renderPostDetailPage();
      if (next === "journeys") renderJourneysPage();
      if (next === "journey") renderJourneyDetailPage();
      else $("#journeyReportFrame").replaceChildren();
      if (next === "contacts") updateContactsState();
      ensurePageData(next);
      if (save) scheduleSave();
    }
    function stateCard(titleEl, bodyEl, actionEl, { title, body, action: action2 = null, tone = "unavailable" }) {
      titleEl.textContent = title;
      bodyEl.textContent = body;
      const card = titleEl.closest(".rm-state");
      if (card) card.dataset.tone = tone;
      actionEl.hidden = action2 === null;
      actionEl.onclick = action2 === null ? null : action2.run;
      if (action2 !== null) actionEl.textContent = action2.label;
    }
    function renderMarkdownInto(node, markdown) {
      node.replaceChildren(renderSafeMarkdown(doc, markdown));
    }
    function discoveryDataFor(familiar) {
      return discoveryByFilter.get(familiar ? "familiar" : "all") ?? null;
    }
    function discoveryKeyFor(familiar) {
      return familiar ? "familiar" : "all";
    }
    function discoveryRefreshing() {
      return discoveryRequests.has(discoveryKeyFor(view.pages.explore.filter === "familiar"));
    }
    function discoveryCacheNeedsRead(familiar) {
      const key2 = discoveryKeyFor(familiar);
      if (discoveryStale.has(key2)) return true;
      const data = discoveryByFilter.get(key2);
      if (!data || data.at === null) return true;
      const at = Number(data.at);
      return !(at > 0) || Date.now() - at > DISCOVERY_REVALIDATE_MS;
    }
    function markHumanOutboundPersisted() {
      if (destroyed) return;
      discoveryStale.add("familiar");
      if (currentPage === "explore" && view.pages.explore.filter === "familiar") {
        ensureDiscoveriesFresh(true);
      }
    }
    function notePersistedHumanOutbound(messages) {
      if (!Array.isArray(messages)) return;
      const task = contactsState.selectedPeerId ? taskFor(contactsState.selectedPeerId) : null;
      if (!task) return;
      const persistedHuman = messages.some((message) => message && message.direction === "out" && message.origin === "human" && taskMatchesMessage(task, message));
      if (persistedHuman) markHumanOutboundPersisted();
    }
    function ensureDiscoveriesFresh(force = false) {
      if (destroyed || !hostReady || !discoveriesCapable) return;
      const familiar = view.pages.explore.filter === "familiar";
      if (!force && !discoveryCacheNeedsRead(familiar)) return;
      const key2 = discoveryKeyFor(familiar);
      const inFlight = discoveryRequests.get(key2);
      if (inFlight) {
        if (force === true) inFlight.forceQueued = true;
        return;
      }
      const data = discoveryByFilter.get(key2);
      const mustForce = force === true || discoveryStale.has(key2) || !data || data.at === null;
      refreshDiscoveries(mustForce);
    }
    function updateDiscoveryMeta(data, state) {
      const notes = [];
      if (data?.error) {
        notes.push(`上次刷新没有完成：${data.error}`);
      }
      if (state.kind === "ready" && state.total !== state.items.length) {
        notes.push(`当前显示 ${state.items.length} 条，匹配搜索的公开内容共 ${state.total} 条。`);
      }
      if (favoritesState.actionError) notes.push(favoritesState.actionError);
      const note = notes.join(" ");
      discoveryMeta.textContent = note;
      discoveryMeta.hidden = note.length === 0;
      discoveryMetaRetry.hidden = !(discoveriesCapable && Boolean(data?.error) && state.kind !== "error");
      discoveryMetaRetry.textContent = discoveryRefreshing() ? "正在重试…" : "重试读取";
      discoveryMetaRetry.onclick = discoveriesCapable ? () => {
        void refreshDiscoveries(true);
      } : null;
      updateDiscoveryScope(data, state);
    }
    function updateDiscoveryScope(data, state) {
      if (!discoveryScope || !discoveryScopeBody) return;
      if (view.pages.explore.filter === "mine" || state.kind !== "ready" || !data) {
        discoveryScope.hidden = true;
        discoveryScopeBody.replaceChildren();
        return;
      }
      const notes = [];
      const scanned = Math.max(0, Number(data.scanned) || 0);
      const ignored = Math.max(0, Number(data.ignored) || 0);
      if (ignored > 0) {
        notes.push(`本次读取了 ${scanned} 条获取记录；其中 ${ignored} 条不是可识别的公开帖子，已排除在动态、搜索和计数之外，可在对应联系人的动态中查看 posts/ 下的公开文件。`);
      } else {
        notes.push(`本次读取了 ${scanned} 条帖子候选；普通文件不会占用动态、搜索或计数名额。`);
      }
      if (data.truncated) {
        notes.push(`宿主单次最多读取 ${DISCOVERY_SCAN_LIMIT} 条帖子候选，本次已到该边界；更早的帖子未包含在此快照中，不会被伪装成已读。`);
      }
      if (view.pages.explore.filter === "familiar" && data.relationComplete === false) {
        notes.push("本人或 Agent 实际发过消息的节点没有完整读取，筛选结果可能不完整。");
      }
      notes.push("来源：本机公开内容获取记录；帖子正文仍按本地副本的大小、哈希和版本逐条核对。");
      discoveryScopeBody.replaceChildren();
      for (const text4 of notes) {
        const paragraph = element("p", "rm-discovery-scope-note");
        paragraph.textContent = text4;
        discoveryScopeBody.append(paragraph);
      }
      discoveryScope.hidden = false;
    }
    function focusRestoreKey(node) {
      if (!node || node.nodeType !== 1) return "";
      const active = root.activeElement;
      return active?.dataset?.focusKey ?? "";
    }
    function disposePreviewMedia(node) {
      releasePostImages(node);
      postImageContainerObservers.get(node)?.disconnect?.();
      for (const card of node?.querySelectorAll?.(".rm-post") ?? []) {
        postImageObservers.get(card)?.disconnect?.();
      }
      if (node?.classList?.contains("rm-post")) postImageObservers.get(node)?.disconnect?.();
      for (const media of node.querySelectorAll?.("audio, video, iframe, img") ?? []) {
        try {
          if (media.tagName === "IFRAME") media.srcdoc = "";
          else media.removeAttribute("src");
          if (typeof media.load === "function") media.load();
        } catch {
        }
      }
    }
    function postMetaKeyFor(item) {
      return [item?.peerId ?? "", item?.path ?? "", item?.sha256 ?? "", item?.sizeBytes ?? ""].join("\0");
    }
    function itemWithPostMeta(item) {
      const meta = postMetaCache.get(postMetaKeyFor(item));
      if (!meta?.found) return item;
      return {
        ...item,
        title: meta.title || item.title,
        summary: meta.summary || item.summary,
        tags: Array.isArray(meta.tags) && meta.tags.length > 0 ? meta.tags : item.tags,
        publishedAt: meta.publishedAt || item.publishedAt,
        authorKind: meta.authorKind || item.authorKind,
        authorName: meta.authorName || item.authorName,
        images: Array.isArray(meta.images) ? meta.images : [],
        kind: "markdown",
        mime: "text/markdown",
        previewable: true,
        contentState: "available",
        contentError: ""
      };
    }
    function pumpPostMetaQueue() {
      while (postMetaActive < 3 && postMetaQueue.length > 0) {
        const task = postMetaQueue.shift();
        postMetaActive += 1;
        Promise.resolve().then(task).catch(() => {
        }).finally(() => {
          postMetaActive -= 1;
          pumpPostMetaQueue();
        });
      }
    }
    function ensurePostMeta(item) {
      if (!peerPostMetaCapable || !item || !isPostPath(item.path)) return;
      if (Array.isArray(item.images) && item.images.length > 0) return;
      const key2 = postMetaKeyFor(item);
      if (postMetaCache.has(key2) || postMetaInflight.has(key2)) return;
      postMetaCache.set(key2, { found: false, images: [], error: "" });
      postMetaInflight.set(key2, true);
      postMetaQueue.push(async () => {
        let result = null;
        try {
          result = await options.onLoadPeerPostMeta(item.peerId, item.path, item.sha256, item.sizeBytes);
        } catch (error) {
          result = { found: false, images: [], error: errorText(error) || "动态配图信息读取失败" };
        }
        postMetaInflight.delete(key2);
        if (destroyed) return;
        postMetaCache.set(key2, result && typeof result === "object" ? result : { found: false, images: [], error: "动态配图信息没有返回结果" });
        if (result?.found) {
          if (currentPage === "explore" && view.pages.explore.filter !== "mine") updateExploreState();
          else if (!profileView.hidden) rerenderProfileKeepingPosition();
        }
      });
      pumpPostMetaQueue();
    }
    function observePostMetaCard(card, item) {
      if (!peerPostMetaCapable || !card || !isPostPath(item?.path)) return;
      if (Array.isArray(item.images) && item.images.length > 0) return;
      const key2 = postMetaKeyFor(item);
      if (postMetaCache.has(key2)) return;
      const Observer = win.IntersectionObserver;
      if (typeof Observer !== "function") {
        ensurePostMeta(item);
        return;
      }
      const observer = new Observer((entries) => {
        if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
        observer.disconnect();
        ensurePostMeta(item);
      }, { root: null, rootMargin: "320px" });
      observer.observe(card);
      const previous = postImageObservers.get(card);
      previous?.disconnect?.();
      postImageObservers.set(card, observer);
    }
    function postImageKeyForUi(subject, peerId2, image) {
      return postImageKey(subject, peerId2, image);
    }
    function postImageState(key2) {
      return postImageCache.get(key2) ?? { state: "idle", refs: 0 };
    }
    function schedulePostImageRelease(key2) {
      if (postImageTimers.has(key2)) clearTimeout(postImageTimers.get(key2));
      const timer = setTimeout(() => {
        postImageTimers.delete(key2);
        const entry = postImageCache.get(key2);
        if (!entry || entry.refs > 0) return;
        if (entry.objectUrl && entry.url) {
          try {
            win.URL?.revokeObjectURL?.(entry.url);
          } catch {
          }
          try {
            globalThis.URL?.revokeObjectURL?.(entry.url);
          } catch {
          }
        }
        postImageCache.delete(key2);
      }, 1500);
      postImageTimers.set(key2, timer);
    }
    function retainPostImage(key2) {
      const timer = postImageTimers.get(key2);
      if (timer) {
        clearTimeout(timer);
        postImageTimers.delete(key2);
      }
      const entry = postImageCache.get(key2) ?? { state: "idle", refs: 0 };
      entry.refs = Number(entry.refs ?? 0) + 1;
      postImageCache.set(key2, entry);
      return entry;
    }
    function releasePostImage(key2) {
      const entry = postImageCache.get(key2);
      if (!entry) return;
      entry.refs = Math.max(0, Number(entry.refs ?? 0) - 1);
      if (entry.refs === 0) schedulePostImageRelease(key2);
    }
    function releasePostImages(node) {
      for (const tile of node?.querySelectorAll?.("[data-post-image-key]") ?? []) {
        releasePostImage(tile.dataset.postImageKey ?? "");
      }
    }
    function refreshPostImageNodes(key2) {
      for (const tile of root.querySelectorAll("[data-post-image-key]")) {
        if (tile.dataset.postImageKey !== key2) continue;
        const image = tile.__ramingaImage;
        const index = Number(tile.dataset.index ?? 0);
        const total = Number(tile.dataset.total ?? 1);
        updatePostImageNode(tile, postImageState(key2), {
          image,
          index,
          total,
          title: tile.__ramingaTitle ?? ""
        });
      }
    }
    function applyPostImageState(key2, patch) {
      const entry = postImageCache.get(key2) ?? { state: "idle", refs: 0 };
      Object.assign(entry, patch);
      postImageCache.set(key2, entry);
      refreshPostImageNodes(key2);
    }
    function imageReasonFromPreview(preview, message = "") {
      const status = String(preview?.status ?? "");
      if (status === "not-downloaded") return "not-downloaded";
      if (status === "copy-missing") return "copy-missing";
      if (status === "hash-mismatch") return "hash-mismatch";
      if (status === "unsupported") return "unsupported";
      if (/离线|不可达|连接|超时|没有可核对|没有发起新的下载/.test(message)) return "offline";
      if (/不在.*(?:公开|发布)清单/.test(message)) return "not-published";
      if (/不存在|未下载/.test(message)) return "copy-missing";
      if (/哈希|大小|版本/.test(message)) return "hash-mismatch";
      return "error";
    }
    function objectUrlFromDataUrl(dataUrl, mime) {
      const prefix = `data:${mime};base64,`;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix) || typeof atob !== "function") {
        return { url: dataUrl, objectUrl: false };
      }
      try {
        const binary = atob(dataUrl.slice(prefix.length));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const BlobCtor = win.Blob ?? globalThis.Blob;
        const createObjectUrl = win.URL?.createObjectURL ?? globalThis.URL?.createObjectURL;
        if (typeof BlobCtor !== "function" || typeof createObjectUrl !== "function") {
          return { url: dataUrl, objectUrl: false };
        }
        return { url: createObjectUrl.call(win.URL ?? globalThis.URL, new BlobCtor([bytes], { type: mime })), objectUrl: true };
      } catch {
        return { url: dataUrl, objectUrl: false };
      }
    }
    function validatePostImagePreview(preview, image) {
      if (!preview || typeof preview !== "object") return "受控图片读取没有返回结果";
      if (preview.status !== "ok" || preview.kind !== "image" || typeof preview.dataUrl !== "string" || preview.dataUrl.length === 0) {
        return preview.error || "受控图片读取没有可显示的图片";
      }
      if (preview.mime !== image.mime) return `图片 MIME ${preview.mime || "缺失"} 与帖子声明的 ${image.mime} 不一致`;
      if (String(preview.sha256 ?? "").toLowerCase() !== String(image.sha256).toLowerCase()) return "图片 SHA-256 与帖子声明不一致";
      if (Number(preview.sizeBytes) !== Number(image.sizeBytes)) return "图片大小与帖子声明不一致";
      return "";
    }
    function releaseAllPostImages() {
      for (const timer of postImageTimers.values()) clearTimeout(timer);
      postImageTimers.clear();
      for (const entry of postImageCache.values()) {
        if (entry.objectUrl && entry.url) {
          try {
            win.URL?.revokeObjectURL?.(entry.url);
          } catch {
          }
          try {
            globalThis.URL?.revokeObjectURL?.(entry.url);
          } catch {
          }
        }
      }
      postImageCache.clear();
      postImageQueues.length = 0;
    }
    function pumpPostImageQueue() {
      while (postImageActive < 4 && postImageQueues.length > 0) {
        const task = postImageQueues.shift();
        postImageActive += 1;
        Promise.resolve().then(task).catch(() => {
        }).finally(() => {
          postImageActive -= 1;
          pumpPostImageQueue();
        });
      }
    }
    function ensurePostImage(subject, peerId2, image, { retry = false } = {}) {
      if (!image || typeof image !== "object") return;
      const key2 = postImageKeyForUi(subject, peerId2, image);
      const existing = postImageCache.get(key2);
      if (existing?.state === "loading" || existing?.state === "ready") return;
      if (image.manifestState === "missing") {
        applyPostImageState(key2, {
          state: "error",
          reason: "not-published",
          detail: "对方当前公开清单中没有这张图片的条目"
        });
        return;
      }
      if (image.manifestState === "mismatch") {
        applyPostImageState(key2, {
          state: "error",
          reason: "hash-mismatch",
          detail: "公开清单中的图片大小或哈希与帖子声明不一致"
        });
        return;
      }
      const read = subject === "mine" ? typeof options.onLoadMineFileContent === "function" ? () => options.onLoadMineFileContent(image.publicPath, image.sha256, image.sizeBytes) : null : typeof options.onLoadPeerFileContent === "function" ? () => options.onLoadPeerFileContent(peerId2, image.publicPath, image.sha256, image.sizeBytes) : null;
      if (read === null) {
        applyPostImageState(key2, { state: "error", reason: "unsupported", detail: "当前宿主没有提供受控图片读取" });
        return;
      }
      applyPostImageState(key2, { state: "loading", reason: "", detail: "", url: "", objectUrl: false });
      postImageQueues.push(async () => {
        let preview = null;
        try {
          preview = await read();
        } catch (error) {
          if (destroyed) return;
          applyPostImageState(key2, {
            state: "error",
            reason: imageReasonFromPreview(null, errorText(error)),
            detail: errorText(error) || "图片读取失败"
          });
          return;
        }
        if (destroyed) return;
        const problem = validatePostImagePreview(preview, image);
        if (problem.length > 0) {
          applyPostImageState(key2, {
            state: "error",
            reason: imageReasonFromPreview(preview, problem),
            detail: problem
          });
          return;
        }
        const media = objectUrlFromDataUrl(preview.dataUrl, image.mime);
        applyPostImageState(key2, {
          state: "ready",
          reason: "",
          detail: "",
          url: media.url,
          objectUrl: media.objectUrl,
          mime: image.mime
        });
        const entry = postImageCache.get(key2);
        if (entry && entry.refs === 0) schedulePostImageRelease(key2);
      });
      pumpPostImageQueue();
    }
    function observePostImages(container) {
      const tiles = [...container.querySelectorAll?.("[data-post-image-key]") ?? []];
      if (tiles.length === 0) return;
      postImageContainerObservers.get(container)?.disconnect?.();
      const Observer = win.IntersectionObserver;
      if (typeof Observer !== "function") {
        for (const tile of tiles) {
          const image = tile.__ramingaImage;
          const subject = tile.dataset.subject ?? "";
          ensurePostImage(subject, tile.dataset.peerId ?? "", image);
        }
        return;
      }
      const observer = new Observer((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
          const tile = entry.target;
          observer.unobserve(tile);
          const state = postImageState(tile.dataset.postImageKey ?? "");
          if (state.state !== "idle") continue;
          ensurePostImage(tile.dataset.subject ?? "", tile.dataset.peerId ?? "", tile.__ramingaImage);
        }
      }, { root: null, rootMargin: "300px" });
      postImageContainerObservers.set(container, observer);
      for (const tile of tiles) {
        const state = postImageState(tile.dataset.postImageKey ?? "");
        if (state.state === "ready") updatePostImageNode(tile, state, {
          index: Number(tile.dataset.index ?? 0),
          total: Number(tile.dataset.total ?? 1),
          title: tile.__ramingaTitle ?? ""
        });
        else observer.observe(tile);
      }
    }
    function pageScrollContainer(node) {
      let current = node?.parentElement ?? null;
      while (current && current !== root) {
        if (current.classList?.contains("rm-page")) return current;
        current = current.parentElement;
      }
      return null;
    }
    function openImagePreview(tile, item, images, key2) {
      if (!imagePreviewDialog || !imagePreviewImg) return;
      const state = postImageState(key2);
      if (state.state !== "ready" || !state.url) return;
      const image = tile.__ramingaImage;
      const index = Number(tile.dataset.index ?? 0);
      const total = Number(tile.dataset.total ?? 1);
      const scrollNode = pageScrollContainer(tile) ?? profileView;
      imagePreviewScroll = scrollNode ? { node: scrollNode, top: scrollNode.scrollTop } : null;
      imagePreviewTrigger = tile;
      imagePreviewKey = key2;
      retainPostImage(key2);
      const alt = image?.path ? `${item?.title || "动态"}配图` : "公开动态配图";
      imagePreviewImg.src = state.url;
      imagePreviewImg.alt = alt;
      imagePreviewImg.hidden = false;
      imagePreviewNote.hidden = true;
      imagePreviewNote.textContent = "";
      imagePreviewMeta.textContent = [
        image?.mime === "image/jpeg" ? "JPEG" : image?.mime === "image/png" ? "PNG" : "图片",
        Number(image?.width) > 0 && Number(image?.height) > 0 ? `${image.width}×${image.height}` : "",
        Number(image?.sizeBytes) > 0 ? `${Math.round(Number(image.sizeBytes) / 1024)} KiB` : "",
        "路径/MIME/SHA-256/大小已核对"
      ].filter(Boolean).join(" · ");
      imagePreviewCounter.textContent = total > 1 ? `${index + 1} / ${total}` : "";
      imagePreviewDialog.dataset.subject = tile.dataset.subject ?? "";
      openDialog(imagePreviewDialog, tile);
    }
    function handlePostImageAction(tile, item, images) {
      const key2 = tile.dataset.postImageKey ?? "";
      const image = tile.__ramingaImage;
      const state = postImageState(key2);
      if (state.state === "ready") {
        openImagePreview(tile, item, images, key2);
        return;
      }
      const subject = tile.dataset.subject ?? "";
      ensurePostImage(subject, tile.dataset.peerId ?? "", image, { retry: true });
    }
    function cleanupImagePreview() {
      imagePreviewImg?.removeAttribute("src");
      imagePreviewImg?.setAttribute("hidden", "");
      if (imagePreviewKey) releasePostImage(imagePreviewKey);
      imagePreviewKey = "";
      const scroll2 = imagePreviewScroll;
      imagePreviewScroll = null;
      if (scroll2?.node) scroll2.node.scrollTop = scroll2.top;
      imagePreviewTrigger = null;
    }
    function closeImagePreview() {
      if (!imagePreviewDialog?.open) {
        cleanupImagePreview();
        return;
      }
      closeDialog(imagePreviewDialog);
    }
    function renderFileCard(item, options2) {
      return renderPublicFileCard(item, {
        ...options2,
        sourceOpen: view.pages.explore.sourceOpen,
        save: scheduleSave,
        renderMarkdown: renderMarkdownInto,
        imageStateFor: (key2) => postImageState(key2),
        onImageAction: (tile, item2, images) => handlePostImageAction(tile, item2, images),
        retainImage: (key2) => retainPostImage(key2)
      });
    }
    function renderDiscoveryList(items) {
      const focusKey = focusRestoreKey(discoveryList);
      const pageScroll = pageEls.explore.scrollTop;
      disposePreviewMedia(discoveryList);
      discoveryList.replaceChildren();
      for (const item of items) {
        const reveal = revealResults.get(revealResultKey("explore", item)) ?? null;
        const displayItem = itemWithPostMeta(item);
        const card = renderFileCard(displayItem, {
          subject: "explore",
          expanded: false,
          preview: postContent.get(postContentKey(item)) ?? null,
          showReveal: revealCapable,
          reveal,
          onReveal: revealDiscoveryItem,
          focusKey: `post:${item.id}`,
          onOpenProfile: true,
          onOpenPost: (target, trigger) => openPostDetail(target, "explore", trigger),
          ...favoriteCardOptions(item, `post:${item.id}`)
        });
        discoveryList.append(card);
        observePostMetaCard(card, item);
      }
      discoveryList.hidden = false;
      observePostImages(discoveryList);
      if (focusKey) {
        const target = [...discoveryList.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        target?.focus({ preventScroll: true });
      }
      if (pageEls.explore.scrollTop !== pageScroll) pageEls.explore.scrollTop = pageScroll;
      tryPostEditorReturnFocus();
    }
    function publicVersionKey(item) {
      return [item.path, String(item.sha256 || "").toLowerCase()].join("\0");
    }
    function publicPostEntries(entries) {
      const versions = new Map();
      const attachments = new Set();
      for (const item of entries) {
        if (!item?.path?.startsWith("posts/")) continue;
        const shown = itemWithPostMeta(item);
        const key = publicVersionKey(shown);
        const previous = versions.get(key);
        if (!previous || (previous.kind === "json" && shown.kind === "markdown")) versions.set(key, shown);
        if (isPostPath(shown.path) && shown.kind === "markdown") {
          for (const image of shown.images || []) {
            if (image.publicPath && image.sha256) {
              attachments.add(publicVersionKey({ path: image.publicPath, sha256: image.sha256 }));
            }
          }
        }
      }
      return [...versions.values()].filter((item) => !attachments.has(publicVersionKey(item)));
    }
    function mineFeedItems(data) {
      if (!data) return [];
      let files = Array.isArray(data.files) ? data.files : [];
      if (files.length === 0 && Array.isArray(data.posts?.posts) && data.posts.posts.length > 0) {
        files = data.posts.posts.map((post) => ({
          id: `legacy-mine:${post.path}`,
          peerId: data.peerId ?? "",
          publisherName: data.profile?.displayName || "我",
          path: post.path,
          name: post.path.split("/").pop() || post.path,
          sha256: post.sha256,
          sizeBytes: post.sizeBytes,
          modifiedAt: 0,
          fetchedAt: 0,
          source: "local-public",
          sources: ["local-public"],
          kind: "markdown",
          mime: "text/markdown",
          previewable: true,
          title: post.title,
          summary: post.summary,
          tags: Array.isArray(post.tags) ? post.tags : [],
          publishedAt: post.publishedAt,
          authorKind: post.authorKind,
          authorName: post.authorName,
          images: Array.isArray(post.images) ? post.images : [],
          contentState: "available",
          contentError: ""
        }));
      }
      return publicPostEntries(files);
    }
    function mineFeedCard(item, query) {
      if (!postMatchesQuery(item, query)) return null;
      const key2 = previewKeyFor("mine", item);
      const card = renderFileCard(itemWithPostMeta(item), {
        subject: "mine",
        expanded: false,
        preview: minePreviews.get(key2) ?? null,
        showReveal: fileRevealCapable,
        reveal: revealResults.get(revealResultKey("mine", item)) ?? null,
        onReveal: (target) => {
          void revealFileItem("mine", target);
        },
        focusKey: `mine-feed:${item.path}:${item.sha256}`,
        onOpenProfile: null,
        onOpenPost: (target, trigger) => openPostDetail(target, "mine", trigger),
        edit: publicDraftImportCapable && isPostPath(item.path) && item.kind === "markdown" ? (target, trigger) => {
          void openExistingPostForEdit(item, trigger ?? target);
        } : null,
        ...favoriteCardOptions(item, `mine-feed:${item.path}:${item.sha256}`)
      });
      return card;
    }
    function updateMineFeedState() {
      const title = mineFeedStateTitle;
      const body = mineFeedStateBody;
      const action2 = mineFeedStateAction;
      view.pages.explore.query = exploreQuery.value;
      discoveryList.hidden = true;
      discoveryList.replaceChildren();
      discoveryMeta.hidden = true;
      discoveryMetaRetry.hidden = true;
      discoveryScope.hidden = true;
      discoveryScopeBody.replaceChildren();
      $("#exploreState").hidden = true;
      mineFeedList.hidden = true;
      disposePreviewMedia(mineFeedList);
      mineFeedList.replaceChildren();
      exploreRefresh.hidden = false;
      const refreshing = mineState.retrying;
      exploreRefresh.dataset.busy = refreshing ? "true" : "false";
      exploreRefresh.setAttribute("aria-busy", refreshing ? "true" : "false");
      const label = exploreRefresh.querySelector("span");
      if (label) label.textContent = refreshing ? "刷新中" : "刷新";
      if (!mineCapable) {
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "本机动态读取暂不可用",
          body: "当前宿主没有提供本机公开资料读取。",
          action: { label: "查看节点状态", run: () => openDialog(statusDialog, action2) }
        });
        mineFeedState.hidden = false;
        return;
      }
      if (mineState.data === null) {
        if (!mineState.retrying) void loadMine(false);
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: mineState.error ? "这次没有读到我的动态" : "正在读取我的动态",
          body: mineState.error || "只展示本机 public/ 中已发布的动态。",
          action: mineState.error ? { label: "重试读取", run: () => {
            void loadMine(true);
          } } : null
        });
        mineFeedState.hidden = false;
        return;
      }
      const items = mineFeedItems(mineState.data);
      const query = exploreQuery.value;
      const filtered = items.filter((item) => postMatchesQuery(item, query));
      if (items.length === 0) {
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "还没有公开动态",
          body: "本机 public/posts/ 中还没有可读取的公开动态。",
          action: { label: "返回发现", run: () => setFilter("all") }
        });
        mineFeedState.hidden = false;
        return;
      }
      if (filtered.length === 0) {
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "没有找到匹配的我的动态",
          body: `没有标题、摘要、标签、作者或路径匹配“${query.trim()}”。`,
          action: { label: "清除搜索", run: () => clearExploreSearch({ focus: true }) }
        });
        mineFeedState.hidden = false;
        return;
      }
      mineFeedState.hidden = true;
      for (const item of filtered) {
        const card = mineFeedCard(item, "");
        if (card) mineFeedList.append(card);
      }
      mineFeedList.hidden = false;
      observePostImages(mineFeedList);
    }
    function updateExploreState() {
      if (currentPage === "post") {
        renderPostDetailPage();
        return;
      }
      if (postEditorState.open) renderPostEditorStatus();
      if (view.pages.explore.filter === "mine") {
        updateMineFeedState();
        return;
      }
      mineFeedList.hidden = true;
      mineFeedState.hidden = true;
      const title = $("#exploreStateTitle");
      const body = $("#exploreStateBody");
      const action2 = $("#exploreStateAction");
      $("#exploreState").hidden = false;
      view.pages.explore.query = exploreQuery.value;
      const familiar = view.pages.explore.filter === "familiar";
      const data = discoveryDataFor(familiar);
      const state = discoveryListState(data, exploreQuery.value);
      const refreshing = discoveryRefreshing();
      if (exploreRefresh) {
        exploreRefresh.hidden = !discoveriesCapable;
        exploreRefresh.dataset.busy = refreshing ? "true" : "false";
        exploreRefresh.setAttribute("aria-busy", refreshing ? "true" : "false");
        const label = exploreRefresh.querySelector("span");
        if (label) label.textContent = refreshing ? "刷新中" : "刷新";
      }
      if (!discoveriesCapable) {
        discoveryList.hidden = true;
        discoveryList.replaceChildren();
        $("#exploreState").hidden = false;
        updateDiscoveryMeta(data, { kind: "error", items: [], total: 0 });
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "公开内容读取暂不可用",
          body: "当前宿主没有提供公开内容索引。",
          action: { label: "查看节点状态", run: () => openDialog(statusDialog, action2) }
        });
        return;
      }
      if (state.kind === "loading") {
        discoveryList.hidden = true;
        discoveryList.replaceChildren();
        updateDiscoveryMeta(data, state);
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "正在整理公开动态",
          body: "正在整理本机记录的手动获取与 Agent 获取公开内容。",
          action: discoveriesCapable ? { label: refreshing ? "正在刷新…" : "刷新动态", run: () => {
            void refreshDiscoveries(true);
          } } : null
        });
        return;
      }
      if (state.kind === "error") {
        discoveryList.hidden = true;
        discoveryList.replaceChildren();
        updateDiscoveryMeta(data, state);
        stateCard(title, body, action2, {
          tone: "error",
          title: "这次没有读到公开动态",
          body: data?.error ? `${data.error} 这不代表没有任何公开内容。` : "公开内容索引读取失败。这不代表没有任何公开内容。",
          action: { label: refreshing ? "正在重试…" : "重试读取", run: () => {
            void refreshDiscoveries(true);
          } }
        });
        return;
      }
      if (state.kind === "search-empty") {
        discoveryList.hidden = true;
        discoveryList.replaceChildren();
        updateDiscoveryMeta(data, state);
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: "没有找到匹配的公开内容",
          body: `没有标题、摘要、标签、作者或路径匹配“${exploreQuery.value.trim()}”。`,
          action: { label: "清除搜索", run: () => clearExploreSearch({ focus: true }) }
        });
        return;
      }
      if (state.kind === "empty") {
        discoveryList.hidden = true;
        discoveryList.replaceChildren();
        updateDiscoveryMeta(data, state);
        stateCard(title, body, action2, {
          tone: "unavailable",
          title: familiar ? "有过交流的节点还没有公开帖子" : "还没有获取到公开帖子",
          body: Number(data?.ignored) > 0 ? `本机获取记录里有 ${Number(data.ignored)} 个文件不是可识别的公开帖子，不算动态，也不会进入搜索或计数；posts/ 下的普通文件可到对应联系人的「他的动态」查看。` : familiar ? "这里只显示本人或 Agent 实际发过消息的节点所带回的可识别公开帖子。仅建立联系、浏览档案或 last_interaction 不算有过交流。" : "当你在对方主页手动获取帖子，或 Agent 获取并核对公开帖子后，会出现在这里；两种来源会分别标注。",
          action: {
            label: familiar ? "返回发现" : "刷新动态",
            run: familiar ? () => setFilter("all") : () => {
              void refreshDiscoveries(true);
            }
          }
        });
        return;
      }
      $("#exploreState").hidden = true;
      updateDiscoveryMeta(data, state);
      renderDiscoveryList(state.items);
    }
    function emptyPostView() {
      return {
        id: "",
        peerId: "",
        path: "",
        sha256: "",
        sizeBytes: 0,
        source: "explore",
        filter: "all",
        query: "",
        scroll: 0,
        profileScroll: 0,
        returnFocus: ""
      };
    }
    function postContentKey(item) {
      return [String(item?.id ?? ""), String(item?.sha256 ?? "").toLowerCase()].join("\0");
    }
    function resetPostContentCache() {
      postContentGeneration += 1;
      postContent.clear();
      postContentRequests.clear();
    }
    /** A feed card opens the detail for every published entry, not only a
     * versioned post.json. The host still revalidates the exact path/version. */
    function feedEntryCanOpenDetail(item, source) {
      if (!item) return false;
      const path = String(item.path ?? "");
      const id = String(item.id ?? "");
      if (source === "mine" || source === "peer") return path.startsWith("posts/") && path.length > 0;
      return path.startsWith("posts/") || id.length > 0;
    }
    function needsExplicitPeerFetch(item) {
      return ["not-downloaded", "copy-missing"].includes(String(item?.contentState ?? ""));
    }
    function profileFeedState() {
      const data = profileState.posts.data;
      const localItems = Array.isArray(data?.items) ? data.items : [];
      const profileManifest = profileState.data?.manifest;
      const refreshedManifest = profileState.posts.manifest;
      const manifest = refreshedManifest && (!profileManifest || (refreshedManifest.at ?? 0) >= (profileManifest.at ?? 0))
        ? refreshedManifest : profileManifest;
      const manifestEntries = Array.isArray(manifest?.entries) ? manifest.entries : [];
      const currentEntries = manifest?.source === "remote" ? publicPostEntries(manifestEntries) : [];
      const items = publicPostEntries([...localItems, ...manifestEntries]);
      const candidateParents = new Set(manifestEntries
        .filter((entry) => isPostImagePath(entry.path))
        .map((entry) => entry.path.slice(0, entry.path.lastIndexOf("/images/")) + "/post.json"));
      const discoveryKeys = new Set(localItems.map(publicVersionKey));
      return { data, localItems, manifest, currentEntries, items, candidateParents, discoveryKeys };
    }
    function postDetailItem() {
      const post = view.post;
      if (!post) return null;
      if (post.source === "mine") {
        return mineFeedItems(mineState.data).find((item) => item.path === post.path && (post.sha256 === "" || String(item.sha256 ?? "").toLowerCase() === post.sha256)) ?? null;
      }
      if (post.source === "peer") {
        const item = profileFeedState().items.find((entry) => entry.path === post.path
          && (post.peerId === "" || entry.peerId === "" || entry.peerId === post.peerId)
          && (post.sha256 === "" || String(entry.sha256 ?? "").toLowerCase() === post.sha256)) ?? null;
        return item && !item.peerId && post.peerId ? { ...item, peerId: post.peerId } : item;
      }
      const data = discoveryDataFor(post.filter === "familiar");
      const items = Array.isArray(data?.items) ? data.items : [];
      return items.find((item) => (post.path ? item.path === post.path : post.id && item.id === post.id)
        && (!post.peerId || item.peerId === post.peerId)
        && (!post.sha256 || String(item.sha256 ?? "").toLowerCase() === post.sha256)) ?? null;
    }
    function clearPostDetail() {
      disposePreviewMedia(postDetail);
      postDetail.replaceChildren();
      postDetail.hidden = true;
    }
    function showPostDetailState({ title, body, tone = "unavailable", action: action2 = null }) {
      postDetail.replaceChildren();
      postDetail.hidden = true;
      postDetailState.hidden = false;
      stateCard(postDetailStateTitle, postDetailStateBody, postDetailStateAction, { title, body, action: action2, tone });
    }
    function renderPostDetailPage() {
      if (destroyed || currentPage !== "post" || postDetailRendering) return;
      if (!postDetail || !postDetailState) return;
      const page = pageEls.post;
      const savedScroll = Math.max(0, Number(page?.scrollTop) || 0);
      const active = root.activeElement;
      const activeInDetail = Boolean(active && (postDetail.contains(active) || postDetailState.contains(active) || active === postBack));
      const detailFocusKey = activeInDetail ? active.dataset.focusKey || active.dataset.detailFocus || "" : "";
      let pendingPreview = null;
      postDetailRendering = true;
      try {
        const post = view.post;
        postBack.textContent = post?.source === "peer" ? "← 返回他的动态"
          : post?.source === "mine" ? "← 返回我的动态" : "← 返回动态";
        clearPostDetail();
        postDetailState.hidden = true;
        if (!post || post.id.length === 0 && post.path.length === 0) {
          showPostDetailState({
            title: "这条动态没有可恢复的标识",
            body: "返回动态列表后可以重新打开。",
            action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
          });
          return;
        }
        if (post.source === "mine") {
          if (!mineCapable) {
            showPostDetailState({
              title: "本机动态读取暂不可用",
              body: "当前宿主没有提供本机公开资料读取。",
              action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
            });
            return;
          }
          if (mineState.data === null) {
            const failed = mineState.error.length > 0;
            if (!failed && !mineState.retrying) void loadMine(false);
            showPostDetailState(failed ? {
              title: "这次没有读到我发布的动态",
              body: mineState.error,
              tone: "error",
              action: { label: "重试读取", run: () => {
                void loadMine(true);
              } }
            } : {
              title: "正在读取我发布的动态",
              body: "正在核对本机 public/posts/ 中的帖子。"
            });
            return;
          }
        } else if (post.source === "peer") {
          const peer = post.peerId || view.contactProfile.peerId;
          if (!peer) {
            showPostDetailState({
              title: "这条动态缺少发布节点",
              body: "返回联系人动态后可以重新打开。",
              action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
            });
            return;
          }
          if (!peerProfileCapable && !peerDiscoveriesCapable) {
            showPostDetailState({
              title: "联系人动态读取暂不可用",
              body: "当前宿主没有提供对方公开动态读取。",
              action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
            });
            return;
          }
          preparePeerPostContext(peer);
          if (profileState.data === null && peerProfileCapable && !profileState.retrying && !profileState.error) {
            void loadPeerProfile(peer, false);
          }
          if (profileState.posts.data === null && peerDiscoveriesCapable && !profileState.posts.retrying && !profileState.posts.error) {
            void loadPeerDiscoveries(peer, false);
          }
        } else {
          if (!discoveriesCapable) {
            showPostDetailState({
              title: "公开动态读取暂不可用",
              body: "当前宿主没有提供公开内容索引。",
              action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
            });
            return;
          }
          const data = discoveryDataFor(post.filter === "familiar");
          if (!data || data.at === null && !data.error) {
            ensureDiscoveriesFresh(false);
            showPostDetailState({
              title: "正在打开这条动态",
              body: "正在读取本机获取记录并核对帖子版本。"
            });
            return;
          }
          if (data.at === null && data.error) {
            showPostDetailState({
              title: "这次没有读到这条动态",
              body: data.error,
              tone: "error",
              action: { label: "重试读取", run: () => {
                void refreshDiscoveries(true);
              } }
            });
            return;
          }
        }
        const item = postDetailItem();
        if (item === null) {
          if (post.source === "peer") {
            const peerError = profileState.posts.error || (profileState.data === null ? profileState.error : "");
            const peerLoading = profileState.posts.retrying || profileState.retrying
              || (profileState.posts.data === null && !peerError);
            if (peerLoading) {
              showPostDetailState({
                title: "正在打开这条动态",
                body: "正在读取对方公开动态并核对文件路径与版本。"
              });
              return;
            }
            if (peerError) {
              showPostDetailState({
                title: "这次没有读到这条动态",
                body: peerError,
                tone: "error",
                action: { label: "重试读取", run: () => {
                  const peer = post.peerId || view.contactProfile.peerId;
                  if (peer) void loadPeerDiscoveries(peer, true);
                } }
              });
              return;
            }
          }
          showPostDetailState({
            title: "这条动态已不在当前列表中",
            body: post.source === "mine" ? "本机公开目录或当前发布清单中已经没有这条帖子。"
              : post.source === "peer" ? "对方当前公开清单或本机历史副本中已经没有这个版本。"
                : "可能是本机获取记录已变化，或这条动态已不在当前筛选的缓存里。",
            action: { label: "返回动态", run: () => closePostDetail({ restoreFocus: false }) }
          });
          return;
        }
        const source = post.source === "mine" ? "mine" : post.source === "peer" ? "peer" : "explore";
        const display = itemWithPostMeta(item);
        const preview = source === "mine"
          ? minePreviews.get(previewKeyFor("mine", item)) ?? null
          : source === "peer"
            ? profilePreviews.get(previewKeyFor("peer", item)) ?? null
            : postContent.get(postContentKey(item)) ?? null;
        const reveal = source === "explore"
          ? revealResults.get(`explore:${item.id}`) ?? null
          : revealResults.get(revealResultKey(source, item)) ?? null;
        const profileEvidence = source === "peer" ? profileFeedState().discoveryKeys : null;
        const localEvidence = source !== "peer"
          || item.contentState === "available"
          || profileEvidence.has(publicVersionKey(item));
        const favoriteOptions = favoriteCardOptions(display, `post-detail:${item.id || item.path}`, localEvidence);
        const fetchState = source === "peer" && needsExplicitPeerFetch(item) ? {
          path: item.path,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          busy: preview?.state === "loading",
          error: preview?.state === "error" ? preview.error : ""
        } : null;
        const article = renderPostDetail(display, {
          subject: source,
          preview,
          onOpenProfile: source === "explore",
          edit: source === "mine" && publicDraftImportCapable && isPostPath(item.path) && display.kind === "markdown" ? (target) => {
            void editPostFromDetail(target, `mine-feed:${target.path}:${target.sha256}:edit`);
          } : null,
          showReveal: source === "explore" ? revealCapable : fileRevealCapable,
          onReveal: source === "explore" ? (target) => {
            void revealDiscoveryItem(target);
          } : (target) => {
            void revealFileItem(source, target);
          },
          reveal,
          fetch: fetchState,
          onFetch: source === "peer" ? (target) => {
            void ensureProfilePreview(target);
          } : null,
          sourceOpen: view.pages.explore.sourceOpen,
          save: scheduleSave,
          renderMarkdown: renderMarkdownInto,
          imageStateFor: (keyValue) => postImageState(keyValue),
          onImageAction: (tile, target, images) => handlePostImageAction(tile, target, images),
          retainImage: (keyValue) => retainPostImage(keyValue),
          focusKey: `post-detail:${item.id || item.path}`,
          ...favoriteOptions
        });
        article.dataset.postPage = "detail";
        postDetail.append(article);
        postDetail.hidden = false;
        postDetailState.hidden = true;
        observePostImages(postDetail);
        if (preview === null && (item.contentState === "available" || item.contentState === "downloaded-unverified")) {
          pendingPreview = () => {
            if (destroyed || currentPage !== "post") return;
            if (view.post.path !== post.path || view.post.sha256 !== post.sha256) return;
            if (source === "mine") void ensureMinePreview(item);
            else if (source === "peer") void ensureProfilePreview(item);
            else void ensurePostContent(item);
          };
        }
      } finally {
        postDetailRendering = false;
        if (page && Math.abs(Number(page.scrollTop) - savedScroll) >= 1) page.scrollTop = savedScroll;
        if (detailFocusKey) {
          const target = [...postDetail.querySelectorAll("[data-focus-key], [data-detail-focus]")]
            .find((node) => node.dataset.focusKey === detailFocusKey || node.dataset.detailFocus === detailFocusKey)
            ?? postDetail.querySelector('[data-detail-focus="post-detail"]')
            ?? postBack;
          target?.focus?.({ preventScroll: true });
          if (page && Math.abs(Number(page.scrollTop) - savedScroll) >= 1) page.scrollTop = savedScroll;
        }
        pendingPreview?.();
      }
    }
    function openPostDetail(item, source = "explore", trigger = null) {
      const kind = source === "mine" ? "mine" : source === "peer" ? "peer" : "explore";
      if (!feedEntryCanOpenDetail(item, kind)) return;
      const peerId2 = kind === "peer" ? String(item.peerId || profileState.peerId || "") : String(item.peerId ?? "");
      if (kind === "peer" && (!peerId2 || (item.peerId && item.peerId !== peerId2))) return;
      if (kind !== "peer") view.pages.explore.query = exploreQuery.value;
      const profileScroll = kind === "peer" ? Math.max(0, Number(profileView.scrollTop) || 0) : 0;
      view.post = {
        id: String(item.id ?? ""),
        peerId: peerId2,
        path: String(item.path ?? ""),
        sha256: String(item.sha256 ?? "").toLowerCase(),
        sizeBytes: Number(item.sizeBytes) || 0,
        source: kind,
        filter: kind === "mine" ? "mine" : kind === "peer" ? "all" : view.pages.explore.filter,
        query: kind === "peer" ? "" : exploreQuery.value,
        scroll: 0,
        profileScroll,
        returnFocus: trigger?.dataset?.focusKey
          || (kind === "mine" ? `mine-feed:${item.path}:${item.sha256}`
            : kind === "peer" ? `profile-post:${item.path}:${item.sha256}:open`
              : `post:${item.id}`)
      };
      if (kind === "peer") {
        // The contact profile is an overlay over its source page. Hide it for
        // the detail route without clearing its loaded state or return target.
        profileView.hidden = true;
        showPage("post");
        updatePrimaryNav(root, pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts");
      } else {
        showPage("post");
      }
      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => {
          if (currentPage === "post" && !destroyed) postBack?.focus({ preventScroll: true });
        });
      }
    }
    function closePostDetail({ restoreFocus = true } = {}) {
      if (currentPage !== "post") return;
      const saved = {
        ...emptyPostView(),
        ...view.post || {}
      };
      view.post = emptyPostView();
      if (saved.source === "peer") {
        clearPostDetail();
        const sourcePage = pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts";
        for (const page of Object.values(pageEls)) page.hidden = true;
        currentPage = sourcePage;
        view.page = sourcePage;
        updatePrimaryNav(root, sourcePage);
        view.contactProfile.tab = "posts";
        profileView.hidden = false;
        renderProfile();
        profileView.scrollTop = Math.max(0, Number(saved.profileScroll) || 0);
        profileScrollMemory = { tab: "posts", scroll: profileView.scrollTop, at: Date.now() };
        saveNow();
        if (!restoreFocus) return;
        const restore = () => {
          if (destroyed || currentPage !== sourcePage || profileView.hidden) return;
          const target = saved.returnFocus
            ? [...profileView.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === saved.returnFocus)
            : null;
          (target ?? profileBack)?.focus?.({ preventScroll: true });
          const expected = Math.max(0, Number(saved.profileScroll) || 0);
          if (profileView.scrollTop === 0 || profileView.scrollTop === expected) {
            profileView.scrollTop = expected;
          }
        };
        if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(restore);
        else restore();
        return;
      }
      if (saved.source === "mine" || saved.filter === "mine") view.pages.explore.filter = "mine";
      else if (saved.filter === "familiar") view.pages.explore.filter = "familiar";
      else view.pages.explore.filter = "all";
      view.pages.explore.query = saved.query;
      exploreQuery.value = saved.query;
      const sourceScroll = Math.max(0, Number(view.pages.explore.scroll) || 0);
      showPage("explore", { save: false });
      updateExploreState();
      saveNow();
      if (!restoreFocus) return;
      if (typeof win.requestAnimationFrame !== "function") return;
      win.requestAnimationFrame(() => {
        if (destroyed || currentPage !== "explore") return;
        const page = pageEls.explore;
        const target = saved.returnFocus ? [...page.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === saved.returnFocus) : null;
        if (target) {
          target.focus({ preventScroll: true });
          // Do not clobber a reading position the user changed after Back but
          // before this focus frame. Only finish the route's own restore.
          if (page.scrollTop === 0 || Math.abs(Number(page.scrollTop) - sourceScroll) < 1) {
            restorePageScrollAfterFocus("explore", sourceScroll);
          }
        } else {
          (exploreQuery ?? composePost ?? exploreRefresh)?.focus?.({ preventScroll: true });
        }
      });
    }
    async function editPostFromDetail(item, returnFocusKey = "") {
      if (!item) return;
      closePostDetail({ restoreFocus: false });
      await openExistingPostForEdit(item, null, returnFocusKey);
    }
    async function ensurePostContent(item, force = false) {
      const id = String(item?.id ?? "");
      if (!id) return;
      const key = postContentKey(item);
      const expectedSha = String(item?.sha256 ?? "").toLowerCase();
      const generation = postContentGeneration;
      const existing = postContent.get(key);
      if (!force && existing && existing.state === "available") return;
      if (!discoveryContentCapable) {
        postContent.set(key, { state: "error", error: "当前宿主没有提供受控内容读取。" });
        updateExploreState();
        return;
      }
      const request = (postContentRequests.get(key) ?? 0) + 1;
      postContentRequests.set(key, request);
      postContent.set(key, { state: "loading" });
      updateExploreState();
      try {
        const value = await options.onLoadDiscoveryContent(id);
        if (destroyed || generation !== postContentGeneration || postContentRequests.get(key) !== request) return;
        if (value && typeof value === "object") {
          const returnedSha = String(value.sha256 ?? "").toLowerCase();
          if (expectedSha && returnedSha && returnedSha !== expectedSha) {
            throw new Error("公开内容返回的版本与当前卡片不一致，已停止显示。");
          }
          postContent.set(key, { state: "available", data: value });
        } else {
          postContent.set(key, { state: "error", error: "公开内容读取没有返回结果" });
        }
      } catch (error) {
        if (!destroyed && generation === postContentGeneration && postContentRequests.get(key) === request) {
          postContent.set(key, { state: "error", error: errorText(error) || "公开内容读取失败" });
        }
      }
      if (!destroyed) updateExploreState();
    }
    function togglePost(id, next = null) {
      const expand = next === null ? view.pages.explore.expanded[id] !== true : next === true;
      if (!expand) {
        delete view.pages.explore.expanded[id];
        disposePreviewMedia(root.querySelector(`[data-file-card="explore:${selectorValue(id)}"]`) ?? discoveryList);
      } else {
        view.pages.explore.expanded[id] = true;
      }
      saveNow();
      updateExploreState();
    }
    async function revealDiscoveryItem(item) {
      if (!revealCapable) return;
      const key2 = revealResultKey("explore", item);
      revealResults.set(key2, { state: "loading" });
      updateExploreState();
      try {
        const result = await options.onRevealDiscovery(item.id);
        if (destroyed) return;
        revealResults.set(key2, {
          state: result?.status ?? (result?.ok ? "revealed" : "error"),
          message: result?.error || ""
        });
      } catch (error) {
        if (!destroyed) revealResults.set(key2, { state: "error", message: errorText(error) || "在文件夹中显示失败。" });
      }
      if (!destroyed) updateExploreState();
    }
    function renderDetailForFileSubject(subject) {
      if (currentPage === "post" && view.post.source === subject) renderPostDetailPage();
    }
    async function revealFileItem(subject, item) {
      if (!fileRevealCapable) return;
      const key2 = revealResultKey(subject, item);
      revealResults.set(key2, { state: "loading" });
      if (subject === "mine") renderMine();
      else if (subject === "peer") rerenderProfileKeepingPosition();
      if (subject === "mine") renderDetailForFileSubject(subject);
      try {
        const result = await options.onRevealFile(
          subject === "peer" ? "peer" : "mine",
          item.peerId,
          item.path,
          item.sha256,
          item.sizeBytes
        );
        if (destroyed) return;
        revealResults.set(key2, {
          state: result?.status ?? (result?.ok ? "revealed" : "error"),
          message: result?.error || ""
        });
      } catch (error) {
        if (!destroyed) revealResults.set(key2, { state: "error", message: errorText(error) || "在文件夹中显示失败。" });
      }
      if (destroyed) return;
      if (subject === "mine") renderMine();
      else if (subject === "peer") rerenderProfileKeepingPosition();
      if (subject === "mine") renderDetailForFileSubject(subject);
    }
    function refreshDiscoveries(force = false) {
      if (destroyed || !discoveriesCapable) {
        updateExploreState();
        return;
      }
      if (!hostReady) return;
      const familiar = view.pages.explore.filter === "familiar";
      const key2 = discoveryKeyFor(familiar);
      const existing = discoveryRequests.get(key2);
      if (existing) {
        if (force === true) existing.forceQueued = true;
        updateExploreState();
        return;
      }
      const request = { forceQueued: false };
      discoveryRequests.set(key2, request);
      updateExploreState();
      let pending;
      try {
        const hostForce = force === true || discoveryStale.has(key2);
        pending = options.onLoadDiscoveries(familiar, hostForce);
      } catch (error) {
        pending = Promise.reject(error);
      }
      void Promise.resolve(pending).then((value) => {
        if (destroyed || discoveryRequests.get(key2) !== request) return;
        if (value === null || typeof value !== "object") {
          throw new Error("公开内容索引没有返回结果");
        }
        discoveryByFilter.set(key2, {
          ...value,
          items: Array.isArray(value.items) ? value.items : [],
          familiar,
          relationComplete: familiar ? value.relationComplete === true : true
        });
        resetPostContentCache();
        discoveryStale.delete(key2);
        if (discoveryKeyFor(view.pages.explore.filter === "familiar") === key2) updateExploreState();
      }).catch((error) => {
        if (destroyed || discoveryRequests.get(key2) !== request) return;
        const previous = discoveryByFilter.get(key2);
        const failure = previous ?? emptyDiscoveries(familiar);
        console.warn("[raminga-ui] discovery refresh failed", errorText(error));
        discoveryByFilter.set(key2, {
          ...failure,
          error: errorText(error) || "公开内容索引读取失败",
          errorAt: Date.now()
        });
        if (discoveryKeyFor(view.pages.explore.filter === "familiar") === key2) updateExploreState();
      }).finally(() => {
        if (discoveryRequests.get(key2) === request) discoveryRequests.delete(key2);
        if (destroyed) return;
        if (discoveryKeyFor(view.pages.explore.filter === "familiar") === key2) updateExploreState();
        if (request.forceQueued) refreshDiscoveries(true);
      });
    }
    function favoriteKeyFor(item) {
      return `${String(item?.peerId ?? "")}\0${String(item?.path ?? "")}\0${String(item?.sha256 ?? "").toLowerCase()}`;
    }
    function favoriteFor(item) {
      return favoritesState.byKey.get(favoriteKeyFor(item)) ?? null;
    }
    function favoriteCardState(item) {
      const existing = favoriteFor(item);
      const key2 = favoriteKeyFor(item);
      return {
        key: key2,
        active: Boolean(existing && existing.available !== false ? existing : existing),
        disabled: !setFavoriteCapable || favoritesState.pending.has(key2)
      };
    }
    function favoriteCardOptions(item, focusKey, eligible = true) {
      if (!favoritesCapable || !eligible || !isPostPath(item?.path)) return {};
      return {
        favorite: { ...favoriteCardState(item), key: favoriteKeyFor(item) },
        onFavorite: (target, trigger) => {
          void toggleFavorite(target, trigger);
        },
        focusKey
      };
    }
    function favoriteNoticeText() {
      return favoritesState.actionError || favoritesState.error || "";
    }
    function indexFavorites(items) {
      for (const item of items) {
        if (!item?.peerId || !item?.path || !item?.sha256) continue;
        favoritesState.byKey.set(favoriteKeyFor(item), item);
      }
    }
    async function loadFavorites({ before = "", append = false, force = false } = {}) {
      if (destroyed || !favoritesCapable) return;
      if (!hostReady) return;
      if (favoritesState.loading) return;
      if (!append && favoritesState.loaded && !force) return;
      favoritesState.loading = true;
      const request = ++favoritesState.requestSeq;
      if (!append) favoritesState.error = "";
      renderSettingsFavorites();
      try {
        const value = await Promise.resolve().then(() => options.onLoadFavorites(before, force === true)).catch((error) => ({ favorites: [], error: errorText(error) || "收藏读取失败", hasMore: false, nextBefore: "" }));
        if (destroyed || request !== favoritesState.requestSeq) return;
        if (value?.error) throw new Error(value.error);
        const rows = Array.isArray(value?.favorites) ? value.favorites : [];
        if (append) favoritesState.items = [...favoritesState.items, ...rows];
        else favoritesState.items = rows;
        favoritesState.items = favoritesState.items.filter((item) => item?.peerId && item?.path && item?.sha256);
        favoritesState.byKey.clear();
        indexFavorites(favoritesState.items);
        favoritesState.loaded = true;
        favoritesState.nextBefore = String(value?.nextBefore ?? "");
        favoritesState.hasMore = value?.hasMore === true;
        favoritesState.error = "";
      } catch (error) {
        if (destroyed || request !== favoritesState.requestSeq) return;
        favoritesState.error = readFailureSummary(errorText(error), "收藏读取失败，请稍后重试。");
      } finally {
        if (!destroyed && request === favoritesState.requestSeq) {
          favoritesState.loading = false;
          if (currentPage === "explore") updateExploreState();
          if (!profileView.hidden) rerenderProfileKeepingPosition();
          renderSettingsFavorites();
        }
      }
    }
    async function toggleFavorite(item, trigger = null) {
      if (!setFavoriteCapable || destroyed) return;
      const current = favoriteFor(item);
      const key2 = favoriteKeyFor(item);
      if (favoritesState.pending.has(key2)) return;
      favoritesState.pending.add(key2);
      favoritesState.actionError = "";
      if (trigger) {
        trigger.disabled = true;
        trigger.dataset.pending = "true";
      }
      const nextFavorite = !current;
      try {
        const result = await options.onSetFavorite({
          peerId: item.peerId,
          path: item.path,
          sha256: item.sha256,
          title: item.title || item.name || "",
          favorite: nextFavorite
        });
        if (destroyed) return;
        if (nextFavorite) {
          if (!result?.item) throw new Error("收藏没有返回记录");
          favoritesState.byKey.set(key2, result.item);
          favoritesState.items = [result.item, ...favoritesState.items.filter((entry) => favoriteKeyFor(entry) !== key2)];
        } else {
          favoritesState.byKey.delete(key2);
          favoritesState.items = favoritesState.items.filter((entry) => favoriteKeyFor(entry) !== key2);
        }
        favoritesState.loaded = true;
      } catch (error) {
        if (destroyed) return;
        favoritesState.actionError = `收藏没有保存：${readFailureSummary(errorText(error), "未知错误")}`;
      } finally {
        if (!destroyed) {
          favoritesState.pending.delete(key2);
          if (currentPage === "explore") updateExploreState();
          if (currentPage === "post") renderPostDetailPage();
          if (!profileView.hidden) rerenderProfileKeepingPosition();
          renderSettingsFavorites();
        }
      }
    }
    function selfPeerId() {
      return String(mineState.data?.peerId || nodeState.status?.peerId || "");
    }
    function favoriteIsLocal(item) {
      if (item?.local === true) return true;
      const self = selfPeerId();
      return self.length > 0 && String(item?.peerId ?? "") === self;
    }
    function favoriteCanRead(item) {
      if (!item || item.available !== true) return false;
      return favoriteIsLocal(item) ? mineFileContentCapable : peerFileContentCapable;
    }
    function settingsBackLabel() {
      if (settingsFavoriteReturn) return "← 返回收藏的动态";
      if (!settingsDirectEntry) return "← 返回设置";
      const labels = { home: "主页", explore: "动态", contacts: "联系人", messages: "对话" };
      return `← 返回${labels[settingsReturnPage] || "原页面"}`;
    }
    function updateSettingsFavoriteBackLabel() {
      for (const back of $$("[data-settings-back]")) back.textContent = settingsBackLabel();
    }
    function clearSettingsFavoriteReturn() {
      if (!settingsFavoriteReturn) return;
      settingsFavoriteReturn = null;
      updateSettingsFavoriteBackLabel();
    }
    function openOwnPublicSource(item, trigger) {
      if (!item || typeof item.peerId !== "string" || item.peerId.length === 0) return;
      const settingsPage = pageEls.settings;
      const fromFavorites = currentPage === "settings" && view.settings.tab === "favorites";
      const savedScroll = currentPage === "settings" && settingsPage && !settingsPage.hidden ? Math.max(0, Number(settingsPage.scrollTop) || 0) : Math.max(0, Number(view.settings.scroll) || 0);
      clearSettingsFavoriteReturn();
      settingsFavoriteReturn = fromFavorites ? {
        scroll: savedScroll,
        ref: trigger?.dataset?.profileRef || `settings:${item.id || favoriteKeyFor(item)}`
      } : null;
      view.settings.tab = "public";
      view.settings.index = false;
      if (currentPage !== "settings") showPage("settings");
      else renderSettingsView();
      if (settingsPage) settingsPage.scrollTop = 0;
      profileMessage.hidden = true;
      profileAddContact.hidden = true;
      profileEditContact.hidden = true;
      saveNow();
    }
    function returnToFavoritesFromSource() {
      const snapshot = settingsFavoriteReturn;
      if (!snapshot) return false;
      settingsFavoriteReturn = null;
      view.settings.tab = "favorites";
      view.settings.index = false;
      renderSettingsView();
      const settingsPage = pageEls.settings;
      if (settingsPage) settingsPage.scrollTop = snapshot.scroll;
      saveNow();
      const target = snapshot.ref ? [...root.querySelectorAll("[data-profile-ref]")].find((node) => node.dataset.profileRef === snapshot.ref) : null;
      if (target) target.focus({ preventScroll: true });
      if (settingsPage) {
        if (Math.abs(Number(settingsPage.scrollTop) - snapshot.scroll) >= 1) settingsPage.scrollTop = snapshot.scroll;
        if (typeof win.requestAnimationFrame === "function" && snapshot.scroll > 0) {
          win.requestAnimationFrame(() => {
            if (destroyed || currentPage !== "settings" || settingsFavoriteReturn) return;
            if (Number(settingsPage.scrollTop) === 0) {
              settingsPage.scrollTop = snapshot.scroll;
              saveNow();
            }
          });
        }
      }
      return true;
    }
    function renderFavoriteReader() {
      if (!favoriteDialog || !favoriteDialogBody) return;
      const item = favoriteReader.item;
      if (!item) return;
      favoriteDialogHeading.textContent = item.title || "收藏的动态";
      const when = Number(item.createdAt) > 0 ? formatDateTime(new Date(Number(item.createdAt)).toISOString()) : "时间未知";
      favoriteDialogMeta.textContent = `${favoriteIsLocal(item) ? "本机公开动态" : "远端公开动态"} · 收藏于 ${when} · 版本 ${String(item.sha256 || "").slice(0, 12)}…`;
      const note = favoriteReader.error;
      favoriteDialogNote.hidden = !(note || favoriteReader.loading);
      favoriteDialogNote.dataset.tone = note ? "error" : "";
      favoriteDialogNote.textContent = note || (favoriteReader.loading ? "正在核对并读取收藏版本…" : "");
      favoriteDialogBody.replaceChildren();
      if (!favoriteReader.preview) return;
      const preview = favoriteReader.preview;
      const itemForCard = {
        ...item,
        name: item.path.split("/").pop() || item.path,
        kind: "markdown",
        mime: "text/markdown",
        previewable: true,
        sizeBytes: Number(preview.sizeBytes) || 0,
        contentState: "available"
      };
      const images = preview.post?.images?.map((image) => ({
        ...image,
        publicPath: item.path.replace(/\/post\.json$/, "") + "/" + image.path
      })) ?? [];
      const mediaNode = renderPostMedia(images, {
        variant: "detail",
        subject: favoriteIsLocal(item) ? "mine" : "peer",
        peerId: item.peerId,
        title: item.title,
        stateFor: postImageState,
        retainImage: retainPostImage
      });
      if (mediaNode) {
        mediaNode.addEventListener("click", (event) => {
          const tile = event.target.closest?.("[data-post-image-key]");
          if (!tile) return;
          event.preventDefault();
          event.stopPropagation();
          handlePostImageAction(tile, itemForCard, images, "detail");
        });
        favoriteDialogBody.append(mediaNode);
      }
      favoriteDialogBody.append(previewFeedback(
        { state: "available", data: preview },
        itemForCard,
        { renderMarkdown: renderMarkdownInto }
      ));
      observePostImages(favoriteDialogBody);
    }
    async function readFavorite(item, trigger = null) {
      if (!item || destroyed) return;
      const local = favoriteIsLocal(item);
      if (!item.available) {
        favoriteReader.item = item;
        favoriteReader.preview = null;
        favoriteReader.loading = false;
        favoriteReader.error = "原内容已不在保留范围，不能再阅读；收藏记录仍可在这里取消。";
        renderFavoriteReader();
        openDialog(favoriteDialog, trigger);
        return;
      }
      if (local ? !mineFileContentCapable : !peerFileContentCapable) {
        favoriteReader.item = item;
        favoriteReader.preview = null;
        favoriteReader.loading = false;
        favoriteReader.error = local ? "当前宿主没有提供本机公开内容读取。" : "当前宿主没有提供远端公开内容读取。";
        renderFavoriteReader();
        openDialog(favoriteDialog, trigger);
        return;
      }
      const request = ++favoriteReader.requestSeq;
      favoriteReader.item = item;
      favoriteReader.preview = null;
      favoriteReader.error = "";
      favoriteReader.loading = true;
      renderFavoriteReader();
      openDialog(favoriteDialog, trigger);
      try {
        const value = local ? await options.onLoadMineFileContent(item.path, item.sha256, 0) : await options.onLoadPeerFileContent(item.peerId, item.path, item.sha256, 0);
        if (destroyed || request !== favoriteReader.requestSeq) return;
        if (!value || typeof value !== "object") throw new Error("没有读取到这条动态。");
        if (value.status !== "ok" && value.status !== "resource-error") {
          throw new Error(value.error || "这条收藏版本无法阅读。");
        }
        const samePath = String(value.path || "") === item.path;
        const sameSha = String(value.sha256 || "").toLowerCase() === String(item.sha256 || "").toLowerCase();
        if (!samePath || !sameSha) throw new Error("读取到的内容与收藏版本不一致，未展示。");
        favoriteReader.preview = value;
      } catch (error) {
        if (destroyed || request !== favoriteReader.requestSeq) return;
        favoriteReader.error = `没有读到收藏版本：${readFailureSummary(errorText(error), "可以稍后重试。")}`;
      } finally {
        if (!destroyed && request === favoriteReader.requestSeq) {
          favoriteReader.loading = false;
          renderFavoriteReader();
        }
      }
    }
    function favoriteRow(item) {
      const row = element("article", "rm-favorite-row");
      row.dataset.favoriteId = item.id || favoriteKeyFor(item);
      const copy = element("div", "rm-favorite-copy");
      const title = element("b");
      title.textContent = item.title || item.path;
      const meta = element("p", "rm-list-note");
      const when = Number(item.createdAt) > 0 ? formatDateTime(new Date(Number(item.createdAt)).toISOString()) : "时间未知";
      meta.textContent = `${item.available ? "本地可用" : "原内容已不在保留范围"} · 收藏于 ${when}`;
      meta.dataset.tone = item.available ? "ready" : "unavailable";
      const detail = element("details", "rm-tech rm-favorite-detail");
      const summary = element("summary");
      summary.textContent = "版本与路径";
      const detailBody = element("p", "rm-list-note");
      detailBody.textContent = `公开路径：${item.path} · 版本 SHA-256：${item.sha256}`;
      detail.append(summary, detailBody);
      copy.append(title, meta, detail);
      const actions = element("div", "rm-favorite-actions");
      const read = element("button", "rm-secondary");
      read.type = "button";
      read.dataset.favoriteRead = item.id || favoriteKeyFor(item);
      read.textContent = "阅读这条动态";
      read.disabled = !favoriteCanRead(item);
      read.title = read.disabled ? item.available ? "当前宿主没有提供这条动态的受控读取" : "原内容已不在保留范围" : "";
      read.onclick = () => {
        void readFavorite(item, read);
      };
      const open = element("button", "rm-quiet rm-favorite-source");
      open.type = "button";
      open.dataset.favoriteSource = item.id || favoriteKeyFor(item);
      open.dataset.profileRef = `settings:${item.id || favoriteKeyFor(item)}`;
      open.textContent = "查看来源";
      open.disabled = !item.peerId;
      open.onclick = () => {
        if (!item.peerId) return;
        if (favoriteIsLocal(item)) {
          openOwnPublicSource(item, open);
          return;
        }
        openPeerProfile(item.peerId, { source: "settings", ref: `settings:${item.id || favoriteKeyFor(item)}`, trigger: open });
      };
      const remove = element("button", "rm-quiet rm-favorite-remove");
      remove.type = "button";
      remove.dataset.favoriteCancel = item.id || favoriteKeyFor(item);
      remove.textContent = "取消收藏";
      remove.setAttribute("aria-label", `取消收藏 ${item.title || item.path}`);
      remove.onclick = () => {
        void toggleFavorite(item, remove);
      };
      actions.append(read, open, remove);
      row.append(copy, actions);
      return row;
    }
    function renderSettingsFavorites() {
      if (!settingsFavoritesList) return;
      if (view.settings.index || view.settings.tab !== "favorites") return;
      const note = favoriteNoticeText();
      settingsFavoritesNote.hidden = note.length === 0 && !favoritesState.loading;
      settingsFavoritesNote.dataset.tone = favoritesState.actionError || favoritesState.error ? "error" : "";
      settingsFavoritesNote.textContent = note || (favoritesState.loading ? "正在读取收藏…" : "");
      if (!favoritesCapable) {
        settingsFavoritesList.hidden = true;
        settingsFavoritesEmpty.hidden = false;
        settingsFavoritesEmpty.querySelector("b").textContent = "当前宿主没有提供收藏读取";
        settingsFavoritesEmpty.querySelector("p").textContent = "收藏不会用本地示例代替。";
        settingsFavoritesMore.hidden = true;
        return;
      }
      settingsFavoritesList.replaceChildren();
      for (const item of favoritesState.items) settingsFavoritesList.append(favoriteRow(item));
      settingsFavoritesList.hidden = favoritesState.items.length === 0;
      settingsFavoritesEmpty.hidden = !(favoritesState.loaded && favoritesState.items.length === 0 && !favoritesState.error);
      if (favoritesState.loaded && favoritesState.items.length === 0 && !favoritesState.error) {
        settingsFavoritesEmpty.querySelector("b").textContent = "还没有收藏的动态";
        settingsFavoritesEmpty.querySelector("p").textContent = "在动态卡片上使用星标收藏公开内容。";
      }
      settingsFavoritesMore.hidden = !favoritesState.hasMore;
      settingsFavoritesMore.disabled = favoritesState.loading;
      settingsFavoritesMore.textContent = favoritesState.loading ? "读取中…" : "加载更早收藏";
      if (!favoritesState.loaded && !favoritesState.loading && !favoritesState.error) void loadFavorites({});
    }
    function renderSettingsMemory() {
      if (!settingsMemoryList || view.settings.index || view.settings.tab !== "memory") return;
      const friends = Array.isArray(contactsState.data?.friends) ? contactsState.data.friends : [];
      const error = contactsState.transportError || contactsState.data?.error || "";
      const loading = (contactsState.data === null || contactsState.data?.freshness === "loading") && friends.length === 0;
      settingsMemoryNote.hidden = !(error || loading);
      settingsMemoryNote.dataset.tone = error ? "error" : "";
      settingsMemoryNote.textContent = error ? `联系人列表读取失败：${readFailureSummary(error, "可以稍后重试。")} 私有记忆入口不会用虚构联系人补足。` : loading ? "正在读取联系人…" : "";
      settingsMemoryList.replaceChildren();
      for (const friend of friends) {
        const row = element("article", "rm-memory-contact");
        const copy = element("div", "rm-memory-contact-copy");
        const name = element("b");
        name.textContent = contactDisplayName(friend);
        const summary = element("p", "rm-list-note");
        summary.textContent = friend.description ? String(friend.description) : "打开后读取本机私有印象与真实交互时间线；不会向远端发送。";
        copy.append(name, summary);
        const unread = Math.max(0, Number(friend.unreadCount) || 0);
        if (unread > 0) {
          const badge = element("span", "rm-memory-unread");
          badge.textContent = `${unread > 99 ? "99+" : unread} 条未读`;
          copy.append(badge);
        }
        const open = element("button", "rm-secondary");
        open.type = "button";
        open.textContent = "打开私有印象与时间线";
        open.onclick = () => openPeerProfile(friend.peerId, { source: "settings", ref: `memory:${friend.peerId}`, trigger: open });
        row.append(copy, open);
        settingsMemoryList.append(row);
      }
      settingsMemoryList.hidden = friends.length === 0;
      settingsMemoryEmpty.hidden = friends.length > 0 || loading || contactsState.data === null;
      if (contactsState.data !== null && !error && friends.length === 0 && !loading) {
        settingsMemoryEmpty.querySelector("b").textContent = "还没有联系人记忆";
        settingsMemoryEmpty.querySelector("p").textContent = "添加联系人后，可在这里打开对方的私有印象与真实交互时间线。";
      }
    }
    function setContactsNotice(text4, { retry = false } = {}) {
      const note = typeof text4 === "string" ? text4 : "";
      const retryFocused = root.activeElement === contactsMetaRetry;
      contactsMeta.textContent = note;
      contactsMeta.hidden = note.length === 0;
      contactsMetaRetry.hidden = !(retry && contactsCapable);
      contactsMetaRetry.textContent = contactsRetrying ? "正在重试…" : "重试读取";
      contactsMetaRetry.onclick = contactsCapable ? retryContacts : null;
      if (contactsMetaRetry.hidden && retryFocused) {
        const first = contactList.hidden ? null : contactList.querySelector("button[data-contact-peer]");
        (first ?? contactQuery).focus({ preventScroll: true });
      }
    }
    function showContactsState({ title, body, tone = "unavailable", primary = null, retry = false, share = false }) {
      contactsSection.hidden = false;
      contactsSection.dataset.tone = tone;
      contactList.hidden = true;
      setContactsNotice("");
      $("#contactsStateTitle").textContent = title;
      $("#contactsStateBody").textContent = body;
      contactsStateActions.hidden = primary === null;
      contactsStateActions.textContent = primary?.label ?? "";
      contactsStateActions.onclick = primary === null ? null : primary.run;
      contactsRetryAction.hidden = retry !== true;
      contactsRetryAction.textContent = contactsRetrying ? "正在重试…" : "重试读取";
      contactsRetryAction.onclick = retry === true ? retryContacts : null;
      contactsShareAction.hidden = !share;
    }
    function conversationForPeer(peerId2) {
      const list = Array.isArray(conversationsState.data?.conversations) ? conversationsState.data.conversations : [];
      return list.find((item) => item?.peerId === peerId2) ?? null;
    }
    function profileIsContact(peerId2 = profileState.peerId) {
      return Boolean(peerId2 && contactFor(peerId2));
    }
    function profileContactsKnown() {
      if (!contactsCapable) return true;
      const data = contactsState.data;
      if (data === null) return false;
      return Number(data.at) > 0 || Array.isArray(data.friends) && data.friends.length > 0;
    }
    function totalUnreadCount() {
      const listed = Number(conversationsState.data?.totalUnread);
      if (Number.isFinite(listed) && listed >= 0) return listed;
      const friends = Array.isArray(contactsState.data?.friends) ? contactsState.data.friends : [];
      return friends.reduce((sum, friend) => sum + Math.max(0, Number(friend?.unreadCount) || 0), 0);
    }
    function refreshUnreadBadges() {
      updateNavUnread(root, totalUnreadCount());
      const friends = Array.isArray(contactsState.data?.friends) ? contactsState.data.friends : [];
      const unreadPeers = friends.filter((friend) => Number(friend?.unreadCount) > 0).length;
      if (contactAllCount) contactAllCount.textContent = String(friends.length);
      if (contactUnreadCount) contactUnreadCount.textContent = String(unreadPeers);
      for (const button of contactFilters) {
        const active = button.dataset.contactFilter === view.pages.contacts.filter;
        button.dataset.focusKey = `contact-filter:${button.dataset.contactFilter}`;
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }
    function verifiedContactProfileFor(peerId2) {
      return verifiedContactProfiles.get(String(peerId2 ?? "")) ?? null;
    }
    function avatarKeyForPeer(peerId2, card, manifest) {
      const avatarPath = String(card?.avatarPath ?? "");
      const avatarSha = String(card?.avatarSha256 ?? "").toLowerCase();
      const entry = avatarPath && Array.isArray(manifest?.entries) ? manifest.entries.find((item) => item.path === avatarPath) : null;
      if (!avatarPath || !avatarSha || !entry) return "";
      return `${peerId2}\0${avatarPath}\0${avatarSha}\0${entry.sizeBytes}`;
    }
    function contactRowName(friend) {
      const verified = verifiedContactProfileFor(friend?.peerId);
      return verified?.displayName || contactDisplayName(friend);
    }
    function contactAvatarUrl(peerId2) {
      const verified = verifiedContactProfileFor(peerId2);
      if (!verified?.avatarKey) return "";
      const cached = peerAvatarState.get(String(peerId2));
      return cached?.key === verified.avatarKey && cached.state === "ready" ? cached.url : "";
    }
    function rememberVerifiedContactProfile(peerId2, data) {
      const id = String(peerId2 ?? "");
      if (!id) return;
      const card = data?.agentCard?.state === "available" ? data.agentCard.card : null;
      if (!card) {
        const failed = Boolean(data?.error) || data?.source === "unavailable";
        if (data?.agentCard?.state === "missing" && !failed) verifiedContactProfiles.delete(id);
        return;
      }
      const displayName = String(card.displayName ?? "").trim().slice(0, 80);
      if (!displayName) return;
      const next = {
        peerId: id,
        displayName,
        description: String(card.description ?? "").trim().slice(0, 400),
        interests: Array.isArray(card.interests) ? card.interests.slice(0, 10).map((value) => String(value).slice(0, 80)) : [],
        conversationStyle: String(card.conversationStyle ?? "").trim().slice(0, 300),
        avatarPath: String(card.avatarPath ?? ""),
        avatarSha256: String(card.avatarSha256 ?? "").toLowerCase(),
        avatarMime: String(card.avatarMime ?? ""),
        avatarKey: avatarKeyForPeer(id, card, data?.manifest),
        source: String(data?.source ?? ""),
        at: Number(data?.at) > 0 ? Number(data.at) : Date.now()
      };
      verifiedContactProfiles.delete(id);
      verifiedContactProfiles.set(id, next);
      if (verifiedContactProfiles.size > 128) {
        const oldest = verifiedContactProfiles.keys().next().value;
        if (oldest !== void 0) verifiedContactProfiles.delete(oldest);
      }
    }
    function applyContactAvatar(avatar, friend) {
      if (!avatar) return;
      const peerId2 = String(friend?.peerId ?? "");
      const displayName = contactRowName(friend);
      const url = contactAvatarUrl(peerId2);
      avatar.replaceChildren();
      avatar.dataset.kind = url ? "image" : "initial";
      avatar.setAttribute("aria-label", `查看 ${displayName} 的档案`);
      if (url) {
        const image = element("img", "rm-contact-avatar-img");
        image.src = url;
        image.alt = "";
        image.decoding = "async";
        avatar.append(image);
      } else {
        avatar.textContent = contactInitial({ name: displayName, peerId: peerId2 });
      }
    }
    function refreshContactAvatar(peerId2) {
      const id = String(peerId2 ?? "");
      if (!id) return;
      const row = [...contactList.querySelectorAll("[data-contact-row]")].find((item) => item.dataset.contactRow === id) ?? null;
      const friend = contactFor(id);
      if (!row || !friend) return;
      applyContactAvatar(row.querySelector(":scope > button[data-profile-peer]"), friend);
    }
    function copyContactPeerId(peerId2, trigger) {
      const id = String(peerId2 ?? "");
      if (!id) return;
      const restore = () => {
        if (!trigger?.isConnected) return;
        trigger.textContent = "复制";
        trigger.removeAttribute("data-copied");
      };
      const finish = (ok) => {
        if (trigger?.isConnected) {
          trigger.textContent = ok ? "已复制" : "复制失败";
          trigger.dataset.copied = ok ? "true" : "error";
          setTimeout(() => {
            if (!destroyed) restore();
          }, 1800);
        }
        if (nodeLive) {
          nodeLive.textContent = ok ? "完整 Peer ID 已复制。" : "复制失败，请展开完整 Peer ID 后手动选择。";
        }
      };
      if (typeof options.onCopyText !== "function") {
        finish(false);
        return;
      }
      let request;
      try {
        request = options.onCopyText(id);
      } catch {
        finish(false);
        return;
      }
      Promise.resolve(request).then((copied) => finish(copied !== false)).catch(() => {
        if (!destroyed) finish(false);
      });
    }
    function applyContactPeerIdVisibility(row, peerId2) {
      const ident = row?.querySelector?.(".rm-contact-ident");
      if (!ident) return;
      const expanded = expandedContactIds.has(peerId2);
      const short = ident.querySelector(".rm-peer-id-short");
      const full = ident.querySelector(".rm-peer-id-full");
      const toggle = ident.querySelector("[data-toggle-peer]");
      if (short) short.hidden = expanded;
      if (full) full.hidden = !expanded;
      if (toggle) {
        toggle.textContent = expanded ? "收起标识" : "展开完整标识";
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      }
    }
    function openContactClue(clue, trigger) {
      if (!clue) return;
      const sentence = (value) => {
        const text4 = String(value ?? "").trim();
        return /[。！？.!?]$/.test(text4) ? text4 : `${text4}。`;
      };
      const parts = [`名称：${clue.name}。`, `Peer ID：${clue.peerId}。`];
      if (clue.description) parts.push(`对方公开的简介：${sentence(clue.description)}`);
      parts.push(`来源：${clue.sourceName}的公开通讯录，读取于 ${formatDateTime(clue.at)}。`);
      parts.push("尚未访问：查看线索不会建立连接，不会自动添加联系人，也不会读取该节点的公开档案。");
      openNotice("公开通讯录线索 · 尚未访问", parts.join(" "), "条目由来源节点公开声明；本机没有与目标节点建立联系。");
      if (trigger?.isConnected) dialogTriggers.set(noticeDialog, trigger);
    }
    function renderContactClues() {
      if (!contactClues || !contactClueList) return;
      const clues = [...directoryClues.values()].filter((clue) => clue.peerId && clue.peerId !== selfPeerId() && !contactFor(clue.peerId)).sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
      contactClues.hidden = clues.length === 0;
      if (clues.length === 0) {
        contactClueList.replaceChildren();
        contactCluesNote.textContent = "";
        contactClues.dataset.signature = "";
        return;
      }
      const signature = clues.map((clue) => [
        clue.sourcePeerId,
        clue.peerId,
        clue.name,
        clue.description,
        clue.sourceName,
        clue.at
      ].join("\0")).join("");
      if (contactClues.dataset.signature === signature && contactClueList.childElementCount === clues.length) {
        return;
      }
      contactClues.dataset.signature = signature;
      contactClueList.replaceChildren();
      contactCluesNote.textContent = "以下条目来自本机实际读取的公开通讯录，由来源节点声明；尚未访问，查看不会建立连接或自动添加联系人。";
      for (const clue of clues) {
        const row = element("article", "rm-clue-row");
        row.dataset.cluePeer = clue.peerId;
        row.dataset.clueSource = clue.sourcePeerId;
        const avatar = element("span", "rm-clue-avatar");
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = contactInitial({ name: clue.name, peerId: clue.peerId });
        const copy = element("div", "rm-clue-copy");
        const title = element("div", "rm-clue-title");
        const name = element("b");
        name.textContent = clue.name;
        const badge = element("span", "rm-badge rm-badge-quiet");
        badge.textContent = "未访问";
        title.append(name, badge);
        copy.append(title);
        const descriptionText = String(clue.description ?? "").trim();
        if (descriptionText) {
          const description = element("p", "rm-clue-description");
          description.textContent = descriptionText;
          copy.append(description);
        }
        const peer = element("code", "rm-peer-id");
        peer.textContent = shortPeer(clue.peerId);
        peer.title = clue.peerId;
        copy.append(peer);
        const source = element("p", "rm-clue-source");
        source.textContent = `来源：${clue.sourceName} 的公开通讯录 · ${formatDateTime(clue.at)}`;
        copy.append(source);
        const actions = element("div", "rm-clue-actions");
        const copyButton = element("button", "rm-quiet");
        copyButton.type = "button";
        copyButton.dataset.copyPeer = clue.peerId;
        copyButton.textContent = "复制";
        copyButton.setAttribute("aria-label", `复制 ${clue.name} 的完整 Peer ID`);
        const view2 = element("button", "rm-secondary");
        view2.type = "button";
        view2.dataset.viewClue = clue.peerId;
        view2.textContent = "查看线索";
        view2.setAttribute("aria-label", `查看 ${clue.name} 的公开通讯录线索，不建立连接`);
        actions.append(copyButton, view2);
        row.append(avatar, copy, actions);
        contactClueList.append(row);
      }
    }
    function rememberDirectoryClues(sourcePeerId, data) {
      const source = String(sourcePeerId ?? "");
      if (!source || !data || data.source !== "remote" || data.error) return;
      directorySourceReads.add(source);
      const verified = verifiedContactProfileFor(source);
      const local = contactFor(source);
      const sourceName = verified?.displayName || (local ? contactRowName(local) : shortPeer(source));
      const at = Number(data.at) > 0 ? Number(data.at) : Date.now();
      for (const [key2, clue] of directoryClues) {
        if (clue.sourcePeerId === source) directoryClues.delete(key2);
      }
      const friends = Array.isArray(data.friends) ? data.friends : [];
      for (const friend of friends) {
        const peerId2 = String(friend?.peerId ?? "").trim();
        if (!peerId2 || peerId2 === selfPeerId() || peerId2 === source) continue;
        if (contactFor(peerId2)) continue;
        const key2 = `${source}\0${peerId2}`;
        if (!directoryClues.has(key2) && directoryClues.size >= 80) {
          const oldest = directoryClues.keys().next().value;
          if (oldest !== void 0) directoryClues.delete(oldest);
        }
        directoryClues.set(key2, {
          peerId: peerId2,
          name: String(friend?.name ?? "").trim().slice(0, 120) || shortPeer(peerId2),
          description: String(friend?.description ?? "").trim().slice(0, 280),
          sourcePeerId: source,
          sourceName,
          at
        });
      }
    }
    function applyContactProjection(value) {
      if (!value || typeof value !== "object") return;
      const profiles = Array.isArray(value.profiles) ? value.profiles : [];
      for (const item of profiles) {
        const peerId2 = typeof item?.peerId === "string" ? item.peerId.trim() : "";
        const displayName = typeof item?.displayName === "string" ? item.displayName.trim().slice(0, 80) : "";
        if (!peerId2 || !displayName) continue;
        const verifiedAt = Number(item.verifiedAt) > 0 ? Number(item.verifiedAt) : 0;
        if (verifiedAt === 0) continue;
        const existing = verifiedContactProfiles.get(peerId2);
        if (existing && Number(existing.at) > verifiedAt) continue;
        const avatarKey = typeof item.avatarKey === "string" ? item.avatarKey : "";
        const avatarUrl = typeof item.avatarUrl === "string" ? item.avatarUrl : "";
        const avatarState = typeof item.avatarState === "string" ? item.avatarState : "";
        if (avatarKey && avatarState === "ready" && /^data:image\/(?:png|jpeg);base64,/i.test(avatarUrl)) {
          const cached = peerAvatarState.get(peerId2);
          if (!cached || cached.key !== avatarKey || cached.state !== "ready") {
            peerAvatarState.set(peerId2, { key: avatarKey, state: "ready", url: avatarUrl });
          }
        }
        verifiedContactProfiles.delete(peerId2);
        verifiedContactProfiles.set(peerId2, {
          peerId: peerId2,
          displayName,
          description: typeof item.description === "string" ? item.description.slice(0, 400) : "",
          interests: Array.isArray(item.interests) ? item.interests.slice(0, 10).map((entry) => String(entry).slice(0, 80)) : [],
          conversationStyle: typeof item.conversationStyle === "string" ? item.conversationStyle.slice(0, 300) : "",
          avatarPath: "",
          avatarSha256: typeof item.avatarSha256 === "string" ? item.avatarSha256 : "",
          avatarMime: typeof item.avatarMime === "string" ? item.avatarMime : "",
          avatarKey,
          source: typeof item.source === "string" && item.source ? item.source : "local-projection",
          at: verifiedAt
        });
      }
      if (verifiedContactProfiles.size > 128) {
        const oldest = verifiedContactProfiles.keys().next().value;
        if (oldest !== void 0) verifiedContactProfiles.delete(oldest);
      }
      const clues = Array.isArray(value.clues) ? value.clues : [];
      for (const item of clues) {
        const peerId2 = typeof item?.peerId === "string" ? item.peerId.trim() : "";
        const sourcePeerId = typeof item?.sourcePeerId === "string" ? item.sourcePeerId.trim() : "";
        const name = typeof item?.name === "string" ? item.name.trim().slice(0, 120) : "";
        if (!peerId2 || !sourcePeerId || !name || directorySourceReads.has(sourcePeerId)) continue;
        const key2 = `${sourcePeerId}\0${peerId2}`;
        if (directoryClues.has(key2)) continue;
        if (directoryClues.size >= 80) break;
        directoryClues.set(key2, {
          peerId: peerId2,
          name,
          description: typeof item.description === "string" ? item.description.slice(0, 280) : "",
          sourcePeerId,
          sourceName: typeof item.sourceName === "string" && item.sourceName ? item.sourceName.slice(0, 80) : shortPeer(sourcePeerId),
          at: Number(item.readAt) > 0 ? Number(item.readAt) : Date.now()
        });
      }
      renderContactClues();
      if (currentPage === "contacts" && contactsState.data !== null) updateContactsState();
      if (currentPage === "messages" && contactsState.selectedPeerId && !conversationView.hidden) {
        updateConversationIdentity(contactsState.selectedPeerId);
      }
      const addressNeedsProjection = view.contactProfile.tab === "address" && profileState.friends.data === null && (profileState.friends.error.length > 0 || profileState.friends.retrying);
      if (!profileView.hidden && profileState.peerId && (profileState.data?.agentCard?.state !== "available" || addressNeedsProjection)) {
        rerenderProfileKeepingPosition();
      }
    }
    async function loadContactProjection() {
      if (destroyed || !hostReady || !contactProjectionCapable || contactProjectionLoading || contactProjectionLoaded) return;
      contactProjectionLoading = true;
      try {
        const value = await options.onLoadContactProjection();
        if (destroyed) return;
        if (value && typeof value === "object" && value.state !== "error") applyContactProjection(value);
      } catch (error) {
        console.warn("[raminga-ui] contact projection read failed", errorText(error));
      } finally {
        contactProjectionLoading = false;
        contactProjectionLoaded = true;
      }
    }
    function contactConnectFeedback(state) {
      if (!state) return "";
      if (state.status === "pending") return "正在连接…";
      if (state.status === "success") {
        return [state.title, state.body, state.contactNote, state.statusNote].filter((part) => typeof part === "string" && part.length > 0).join(" ");
      }
      if (state.status === "error") {
        if (state.tone === "invalid") return [state.title, state.body].filter(Boolean).join(" ");
        const reason = state.detail ? readFailureSummary(state.detail, "请稍后重试。") : "";
        return `${state.title}${reason ? `：${reason}` : "。"} 可以重试连接。`;
      }
      return "";
    }
    function renderContactConnect(row, peerId2, displayName) {
      const actions = row.querySelector(":scope > .rm-contact-actions");
      const actionRow = actions?.querySelector(":scope > .rm-contact-action-row");
      if (!actionRow) return;
      const state = contactConnectState.get(peerId2) ?? null;
      const pending = state?.status === "pending";
      let button = actionRow.querySelector(":scope > button[data-connect-peer]");
      if (!button) {
        button = element("button", "rm-contact-connect");
        button.type = "button";
        actionRow.prepend(button);
      }
      button.dataset.connectPeer = peerId2;
      button.dataset.focusKey = `contact-connect:${peerId2}`;
      button.dataset.state = state?.status || "idle";
      button.textContent = pending ? "连接中…" : state?.status === "error" ? "重试连接" : "连接";
      button.setAttribute("aria-label", `${pending ? "正在连接" : state?.status === "error" ? "重试连接" : "连接"} ${displayName}`);
      button.setAttribute("aria-busy", pending ? "true" : "false");
      button.setAttribute("aria-disabled", !connectCapable || pending ? "true" : "false");
      button.title = connectCapable ? `连接到完整 Peer ID：${peerId2}` : "当前宿主没有提供连接能力。";
      let note = row.querySelector(":scope > .rm-contact-connect-note");
      if (!note && (state || !connectCapable)) {
        note = element("p", "rm-contact-connect-note");
        note.setAttribute("role", "status");
        note.setAttribute("aria-live", "polite");
        row.append(note);
      }
      if (!note) return;
      const text4 = connectCapable ? contactConnectFeedback(state) : "";
      note.textContent = text4;
      note.hidden = text4.length === 0;
      if (text4.length > 0) note.dataset.tone = state?.tone || (pending ? "info" : "");
      else delete note.dataset.tone;
      note.title = state?.detail || "";
    }
    function refreshContactConnectRow(peerId2) {
      const id = String(peerId2 ?? "");
      if (!id) return;
      const row = [...contactList.querySelectorAll("[data-contact-row]")].find((item) => item.dataset.contactRow === id) ?? null;
      const friend = contactFor(id);
      if (!row || !friend) return;
      renderContactConnect(row, id, contactRowName(friend));
    }
    function startContactConnect(peerId2) {
      const id = String(peerId2 ?? "");
      if (destroyed || !connectCapable || id.length === 0 || !contactFor(id)) return;
      const current = contactConnectState.get(id);
      if (current?.status === "pending") return;
      const attempt = (Number(current?.attempt) || 0) + 1;
      contactConnectState.set(id, { status: "pending", attempt });
      refreshContactConnectRow(id);
      let request;
      try {
        request = options.onConnect(id);
      } catch (error) {
        request = Promise.reject(error);
      }
      Promise.resolve(request).then((result) => {
        if (destroyed || contactConnectState.get(id)?.attempt !== attempt) return;
        if (result?.contacts) setContacts(result.contacts);
        const outcome = connectOutcome(result);
        contactConnectState.set(id, {
          status: result?.ok === true ? "success" : "error",
          attempt,
          tone: outcome.tone,
          title: outcome.title,
          body: outcome.body,
          contactNote: outcome.contactNote,
          statusNote: outcome.statusNote,
          detail: outcome.detail
        });
        refreshContactConnectRow(id);
      }, (error) => {
        if (destroyed || contactConnectState.get(id)?.attempt !== attempt) return;
        const outcome = connectOutcome({ ok: false, error: errorText(error) });
        contactConnectState.set(id, {
          status: "error",
          attempt,
          tone: outcome.tone,
          title: outcome.title,
          body: outcome.body,
          contactNote: "",
          statusNote: "",
          detail: outcome.detail
        });
        refreshContactConnectRow(id);
      });
    }
    function fillContactRow(row, friend) {
      const peerId2 = String(friend?.peerId ?? "");
      row.dataset.contactRow = peerId2;
      row.className = "rm-contact rm-contact-row";
      const state = friend?.connection === "connected" || friend?.connection === "disconnected" ? friend.connection : "unknown";
      const unread = Math.max(0, Number(friend?.unreadCount) || 0);
      const verified = verifiedContactProfileFor(peerId2);
      const displayName = contactRowName(friend);
      const localName = typeof friend?.name === "string" ? friend.name.trim() : "";
      const label = `${displayName}，${connectionStateText(state)}${unread > 0 ? `，${unread} 条未读` : ""}`;
      const avatar = row.querySelector(":scope > button[data-profile-peer]") ?? element("button", "rm-contact-avatar rm-avatar-button");
      avatar.type = "button";
      avatar.dataset.profilePeer = peerId2;
      avatar.dataset.profileRef = `contacts-avatar:${peerId2}`;
      avatar.dataset.focusKey = `contact-avatar:${peerId2}`;
      applyContactAvatar(avatar, friend);
      const main = row.querySelector(":scope > button[data-contact-peer]") ?? element("button", "rm-contact-main");
      main.type = "button";
      main.dataset.contactPeer = peerId2;
      main.dataset.focusKey = `contact:${peerId2}`;
      main.dataset.profileRef = `contacts:${peerId2}`;
      main.setAttribute("aria-label", `${label}，打开 ${displayName} 的个人首页`);
      const copy = element("span", "rm-contact-copy");
      const nameLine = element("span", "rm-contact-name");
      const name = element("b");
      name.textContent = displayName;
      if (verified?.displayName) name.title = `公开 Agent 名称（${verified.source === "local-copy" ? "本机已核对副本" : "最近读取"}）`;
      nameLine.append(name);
      const badge = element("span", "rm-contact-state");
      badge.dataset.state = state;
      badge.textContent = connectionStateText(state);
      if (state !== "connected") badge.title = "本机当前没有活动连接；这不等于对方永久离线。";
      nameLine.append(badge);
      if (friend?.paused === true) {
        const paused = element("span", "rm-contact-paused");
        paused.textContent = "已暂停主动连接";
        nameLine.append(paused);
      }
      copy.append(nameLine);
      if (verified?.description) {
        const publicNote = element("span", "rm-contact-note");
        publicNote.textContent = verified.description;
        publicNote.title = "对方公开 Agent 卡片中的简介";
        copy.append(publicNote);
      }
      const localDescription = typeof friend?.description === "string" ? friend.description.trim() : "";
      const localPieces = [];
      if (verified?.displayName) {
        if (localName && localName !== verified.displayName) localPieces.push(localName);
        if (localDescription && localDescription !== verified.description) localPieces.push(localDescription);
      } else if (localDescription) {
        localPieces.push(localDescription);
      }
      if (localPieces.length > 0) {
        const localNote = element("span", "rm-contact-local-note");
        const localLabel = element("span", "rm-contact-note-label");
        localLabel.textContent = "本机备注";
        const localText = element("span");
        localText.textContent = localPieces.join(" · ");
        localNote.append(localLabel, localText);
        copy.append(localNote);
      }
      const conversation = conversationForPeer(peerId2);
      if (conversation && (conversation.hasMessages || conversation.preview)) {
        const recent = element("span", "rm-contact-recent");
        const source = conversation.direction === "in" ? "对方" : conversation.origin === "human" ? "本人" : conversation.origin === "agent" ? "Agent" : "来源未知";
        const preview = conversation.preview || "（空消息）";
        recent.textContent = `最近：${preview}`;
        recent.dataset.origin = source;
        recent.setAttribute("aria-label", `最近消息，${source}：${preview}`);
        copy.append(recent);
      } else {
        const recent = element("span", "rm-contact-recent");
        recent.textContent = "还没有消息";
        recent.dataset.empty = "true";
        copy.append(recent);
      }
      main.replaceChildren(copy);
      row.dataset.unread = unread > 0 ? "true" : "false";
      const actions = row.querySelector(":scope > .rm-contact-actions") ?? element("div", "rm-contact-actions");
      let time = actions.querySelector(":scope > .rm-contact-time");
      if (conversation?.lastAt > 0) {
        if (!time) {
          time = element("time", "rm-contact-time");
          actions.prepend(time);
        }
        time.textContent = messageTimeText(conversation.lastAt);
        time.dateTime = new Date(conversation.lastAt).toISOString();
        time.hidden = false;
      } else if (time) {
        time.hidden = true;
        time.textContent = "";
        time.removeAttribute("datetime");
      }
      let actionRow = actions.querySelector(":scope > .rm-contact-action-row");
      if (!actionRow) {
        actionRow = element("div", "rm-contact-action-row");
        actions.append(actionRow);
      }
      const chat2 = actionRow.querySelector(":scope > button[data-chat-peer]") ?? element("button", "rm-contact-chat");
      chat2.type = "button";
      chat2.dataset.chatPeer = peerId2;
      chat2.dataset.focusKey = `contact-chat:${peerId2}`;
      chat2.setAttribute("aria-label", unread > 0 ? `打开与 ${displayName} 的对话，${unread} 条未读` : `打开与 ${displayName} 的对话`);
      if (!chat2.querySelector("svg")) {
        chat2.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.5-4.6A7.5 7.5 0 1 1 20 11.5Z"/><path d="M8.5 11.5h7M8.5 8.5h4.5"/></svg>';
      }
      chat2.querySelector(".rm-contact-unread")?.remove();
      chat2.dataset.unread = unread > 0 ? "true" : "false";
      if (unread > 0) {
        const unreadBadge = element("span", "rm-contact-unread");
        unreadBadge.setAttribute("aria-label", `${unread} 条未读`);
        unreadBadge.textContent = unread > 99 ? "99+" : String(unread);
        chat2.append(unreadBadge);
      }
      const menu = actionRow.querySelector(":scope > button[data-quick-peer]") ?? element("button", "rm-quick-trigger");
      menu.type = "button";
      menu.dataset.quickPeer = peerId2;
      menu.dataset.quickRef = `contacts-menu:${peerId2}`;
      menu.textContent = "⋯";
      menu.hidden = !friendEditCapable;
      menu.setAttribute("aria-label", `更多操作：${displayName}`);
      menu.setAttribute("aria-haspopup", friendEditCapable ? "menu" : "false");
      menu.setAttribute("aria-controls", "contactQuickMenu");
      menu.setAttribute("aria-expanded", String(!contactQuickMenu.hidden && quickMenuPeerId === peerId2));
      const connect2 = actionRow.querySelector(":scope > button[data-connect-peer]") ?? element("button", "rm-contact-connect");
      connect2.type = "button";
      connect2.dataset.connectPeer = peerId2;
      if (actionRow.firstElementChild !== connect2 || actionRow.lastElementChild !== menu) {
        actionRow.replaceChildren(connect2, chat2, menu);
      }
      const ident = row.querySelector(":scope > .rm-contact-ident") ?? element("div", "rm-contact-ident");
      let identLabel = ident.querySelector(":scope > .rm-contact-id-label");
      if (!identLabel) {
        identLabel = element("span", "rm-contact-id-label");
        identLabel.textContent = "节点标识";
        ident.prepend(identLabel);
      }
      let shortId = ident.querySelector(":scope > .rm-peer-id-short");
      if (!shortId) {
        shortId = element("code", "rm-peer-id rm-peer-id-short");
        ident.append(shortId);
      }
      shortId.textContent = shortPeer(peerId2);
      shortId.title = peerId2;
      let fullId = ident.querySelector(":scope > .rm-peer-id-full");
      if (!fullId) {
        fullId = element("code", "rm-peer-id rm-peer-id-full");
        fullId.hidden = true;
        ident.append(fullId);
      }
      fullId.textContent = peerId2;
      let toggle = ident.querySelector(":scope > [data-toggle-peer]");
      if (!toggle) {
        toggle = element("button", "rm-quiet rm-contact-id-toggle");
        toggle.type = "button";
        toggle.dataset.togglePeer = peerId2;
        toggle.setAttribute("aria-label", `展开 ${displayName} 的完整 Peer ID`);
        ident.append(toggle);
      }
      toggle.dataset.togglePeer = peerId2;
      let copyButton = ident.querySelector(":scope > [data-copy-peer]");
      if (!copyButton) {
        copyButton = element("button", "rm-quiet rm-contact-id-copy");
        copyButton.type = "button";
        copyButton.textContent = "复制";
        copyButton.setAttribute("aria-label", `复制 ${displayName} 的完整 Peer ID`);
        ident.append(copyButton);
      }
      copyButton.dataset.copyPeer = peerId2;
      copyButton.setAttribute("aria-label", `复制 ${displayName} 的完整 Peer ID`);
      let connectNote = row.querySelector(":scope > .rm-contact-connect-note");
      if (!connectNote) {
        connectNote = element("p", "rm-contact-connect-note");
        connectNote.setAttribute("role", "status");
        connectNote.setAttribute("aria-live", "polite");
      }
      if (row.firstElementChild !== avatar || row.childElementCount !== 5 || row.lastElementChild !== connectNote || actions.parentElement !== row || ident.parentElement !== row) {
        row.replaceChildren(avatar, main, actions, ident, connectNote);
      }
      applyContactPeerIdVisibility(row, peerId2);
      renderContactConnect(row, peerId2, displayName);
    }
    function contactRow(friend) {
      return element("div", "rm-contact");
    }
    function focusedContactRow() {
      const active = root.activeElement ?? doc.activeElement;
      if (!active || active.nodeType !== 1) return null;
      return active.closest?.("[data-contact-row]") ?? null;
    }
    function reconcileContactList(friends) {
      const activeRow = focusedContactRow();
      const activePeer = activeRow?.dataset.contactRow ?? "";
      const activeWasAvatar = Boolean(root.activeElement?.dataset?.profilePeer);
      const activeWasChat = Boolean(root.activeElement?.dataset?.chatPeer);
      const activeWasConnect = Boolean(root.activeElement?.dataset?.connectPeer);
      const activeWasToggle = Boolean(root.activeElement?.dataset?.togglePeer);
      const activeWasCopy = Boolean(root.activeElement?.dataset?.copyPeer);
      const rowsBefore = [...contactList.querySelectorAll("[data-contact-row]")];
      const activeIndex = activeRow ? rowsBefore.indexOf(activeRow) : -1;
      const listScroll = contactList.scrollTop;
      const pageScroll = pageEls.contacts.scrollTop;
      const existing = new Map(rowsBefore.map((row) => [row.dataset.contactRow, row]));
      let previous = null;
      for (const friend of friends) {
        const peerId2 = String(friend?.peerId ?? "");
        let row = existing.get(peerId2);
        if (row) existing.delete(peerId2);
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
      const rowsAfter = [...contactList.querySelectorAll("[data-contact-row]")];
      const target = activePeer ? rowsAfter.find((row) => row.dataset.contactRow === activePeer) : null;
      if (target) {
        const focusTarget = activeWasAvatar ? target.querySelector("button[data-profile-peer]") : activeWasChat ? target.querySelector("button[data-chat-peer]") : activeWasConnect ? target.querySelector("button[data-connect-peer]") : activeWasToggle ? target.querySelector("[data-toggle-peer]") : activeWasCopy ? target.querySelector("[data-copy-peer]") : target.querySelector("button[data-contact-peer]");
        if (focusTarget && root.activeElement !== focusTarget) focusTarget.focus({ preventScroll: true });
      } else if (activeRow) {
        const fallback = rowsAfter[Math.min(Math.max(activeIndex, 0), rowsAfter.length - 1)] ?? null;
        (fallback?.querySelector("button[data-contact-peer]") ?? contactQuery).focus({ preventScroll: true });
      }
      if (contactList.scrollTop !== listScroll) contactList.scrollTop = listScroll;
      if (pageEls.contacts.scrollTop !== pageScroll) pageEls.contacts.scrollTop = pageScroll;
    }
    function retryContacts() {
      if (destroyed || contactsRetrying || !contactsCapable) return;
      contactsRetrying = true;
      updateContactsState();
      let request;
      try {
        request = options.onLoadContacts(true);
      } catch (error) {
        request = Promise.reject(error);
      }
      void Promise.resolve(request).catch((error) => {
        if (!destroyed) setContactsError(error);
      }).finally(() => {
        if (destroyed) return;
        contactsRetrying = false;
        updateContactsState();
      });
    }
    function clearContactSearch() {
      contactQuery.value = "";
      view.pages.contacts.query = "";
      updateContactsState();
      saveNow();
      contactQuery.focus();
    }
    function updateContactsState() {
      if (destroyed) return;
      const query = contactQuery.value;
      view.pages.contacts.query = query;
      const filter = view.pages.contacts.filter === "unread" ? "unread" : "all";
      const state = contactListState(
        contactsState.data,
        query,
        contactsState.transportError,
        filter,
        verifiedContactProfileFor
      );
      refreshUnreadBadges();
      renderContactClues();
      const activeRow = focusedContactRow();
      if (state.kind === "ready") {
        const stateHadFocus = contactsSection.contains(root.activeElement);
        contactsSection.hidden = true;
        contactList.hidden = false;
        reconcileContactList(state.friends);
        const stale = contactsStaleText(contactsState.data, contactsState.transportError);
        setContactsNotice(stale, { retry: stale.length > 0 && contactsCapable });
        if (stateHadFocus) {
          const first = contactList.querySelector("button[data-contact-peer]");
          (first ?? contactQuery).focus({ preventScroll: true });
        }
        renderConversation();
        return;
      }
      if (activeRow) contactQuery.focus({ preventScroll: true });
      contactList.replaceChildren();
      if (state.kind === "loading") {
        showContactsState({
          title: "正在读取联系人…",
          body: "正在从本机节点读取联系人列表，请稍候。",
          tone: "unavailable"
        });
      } else if (state.kind === "error") {
        showContactsState({
          title: "这次没有读到联系人",
          body: contactsReadErrorText(contactsState.data),
          tone: "error",
          primary: contactsCapable ? { label: contactsRetrying ? "正在重试…" : "重试读取", run: retryContacts } : {
            label: "查看节点状态",
            run: () => openDialog(statusDialog, contactsStateActions)
          }
        });
      } else if (state.kind === "empty") {
        if (state.stale) {
          const failed = Boolean(state.error) || Boolean(contactsState.transportError);
          showContactsState({
            title: failed ? "暂时无法确认联系人列表" : "联系人列表可能已过期",
            body: contactsEmptyStaleText(contactsState.data, contactsState.transportError),
            tone: failed ? "error" : "unavailable",
            primary: contactsCapable ? { label: contactsRetrying ? "正在重试…" : "重试读取", run: retryContacts } : null,
            share: true
          });
        } else {
          showContactsState({
            title: "还没有联系人",
            body: "添加第一个联系人，或把自己的节点信息分享给对方。",
            primary: { label: "添加第一个联系人", run: () => openAddDialog(contactsStateActions) },
            share: true
          });
        }
      } else if (state.kind === "unread-empty") {
        showContactsState({
          title: query.trim() ? "没有匹配的未读联系人" : "暂时没有未读消息",
          body: query.trim() ? `有未读的联系人中没有名称、备注或 Peer ID 匹配“${query.trim()}”。` : "所有保留的入站消息都已读，或联系人还没有新消息。升级后从当前记录开始计未读。",
          primary: {
            label: query.trim() ? "清除搜索" : "查看全部联系人",
            run: query.trim() ? clearContactSearch : () => {
              view.pages.contacts.filter = "all";
              updateContactsState();
              saveNow();
            }
          },
          retry: state.stale
        });
      } else {
        const stale = state.stale || Boolean(state.error);
        showContactsState({
          title: "没有找到匹配的联系人",
          body: `没有名称、备注或 Peer ID 匹配“${query.trim()}”。`,
          primary: {
            label: "清除搜索",
            run: clearContactSearch
          },
          retry: stale
        });
        if (stale) {
          setContactsNotice(contactsStaleText(contactsState.data, contactsState.transportError));
        }
      }
      renderConversation();
    }
    function setContacts(value) {
      if (destroyed || value === null || typeof value !== "object") return;
      const previousAt = Number(contactsState.data?.at) > 0 ? Number(contactsState.data.at) : 0;
      const nextAt = Number(value.at) > 0 ? Number(value.at) : 0;
      if (nextAt > 0 && previousAt > 0 && nextAt < previousAt) return;
      contactsState.data = value;
      contactsState.transportError = "";
      refreshUnreadBadges();
      updateContactsState();
      updateConversationIndexState();
      if (currentPage === "messages" && contactsState.selectedPeerId && !conversationView.hidden) {
        updateConversationIdentity(contactsState.selectedPeerId);
      }
      if (currentPage === "settings" && !view.settings.index) renderSettingsMemory();
      if (!profileView.hidden && profileState.peerId) rerenderProfileKeepingPosition();
    }
    function setContactsError(error) {
      if (destroyed) return;
      contactsState.transportError = errorText(error) || "联系人读取失败";
      updateContactsState();
      updateConversationIndexState();
      if (currentPage === "settings" && !view.settings.index) renderSettingsMemory();
    }
    function contactFor(peerId2) {
      const friends = Array.isArray(contactsState.data?.friends) ? contactsState.data.friends : [];
      return friends.find((friend) => friend?.peerId === peerId2) ?? null;
    }
    function conversationFriend(peerId2) {
      return contactFor(peerId2);
    }
    const FRIEND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
    function normalizedFriendEditValue(value) {
      const candidate = value && typeof value === "object" && value.friend && typeof value.friend === "object" ? value.friend : value;
      return candidate && typeof candidate === "object" ? candidate : null;
    }
    function editResultError(value) {
      if (value === false) return "宿主没有完成保存。";
      if (!value || typeof value !== "object") return "";
      if (value.ok === false) return String(value.error ?? "保存没有完成。");
      return "";
    }
    function applyEditedFriend(friend, fallback = null) {
      const peerId2 = String(fallback?.peerId ?? friend?.peerId ?? editTargetPeerId);
      if (!peerId2) return;
      const data = contactsState.data;
      const index = Array.isArray(data?.friends) ? data.friends.findIndex((item) => String(item?.peerId ?? "") === peerId2) : -1;
      if (index < 0) return;
      const previous = data.friends[index];
      data.friends[index] = {
        ...previous,
        ...friend ?? {},
        ...fallback ?? {},
        peerId: peerId2
      };
      updateContactsState();
      if (profileState.peerId === peerId2 && profileState.data) {
        profileState.data = { ...profileState.data, localName: String(data.friends[index].name ?? "") };
        renderProfile();
      }
    }
    function closeContactQuickMenu({ restoreFocus = true, quiet = false } = {}) {
      const trigger = quickMenuTrigger;
      contactQuickMenu.hidden = true;
      contactQuickMenu.replaceChildren();
      contactQuickMenu.removeAttribute("style");
      quickMenuPeerId = "";
      quickMenuTrigger = null;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && trigger?.isConnected && !quiet) trigger.focus({ preventScroll: true });
    }
    function quickMenuItems() {
      return [...contactQuickMenu.querySelectorAll('button[role="menuitem"]')];
    }
    function focusQuickMenuItem(index) {
      const items = quickMenuItems();
      if (items.length === 0) return;
      const next = (index % items.length + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }
    function openContactQuickMenu(trigger, peerId2) {
      if (!friendEditCapable || !trigger || !peerId2) return;
      if (!contactFor(peerId2)) return;
      if (!contactQuickMenu.hidden && quickMenuTrigger === trigger) {
        closeContactQuickMenu();
        return;
      }
      closeContactQuickMenu({ restoreFocus: false, quiet: true });
      quickMenuPeerId = peerId2;
      quickMenuTrigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      const edit = element("button");
      edit.type = "button";
      edit.setAttribute("role", "menuitem");
      edit.dataset.quickAction = "edit";
      edit.textContent = friendNameEditCapable && friendDescriptionEditCapable ? "编辑名称和备注" : friendNameEditCapable ? "编辑名称" : "编辑备注";
      edit.onclick = () => {
        closeContactQuickMenu({ restoreFocus: false, quiet: true });
        openEditContact(peerId2, trigger);
      };
      const note = element("p", "rm-quick-menu-note");
      note.setAttribute("role", "none");
      note.textContent = "只保存到本机并更新公开的 friends.json，不修改对方档案。";
      contactQuickMenu.append(edit, note);
      contactQuickMenu.hidden = false;
      const rect = trigger.getBoundingClientRect();
      const origin = root.host?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
      const width = contactQuickMenu.offsetWidth || 210;
      const height = contactQuickMenu.offsetHeight || 80;
      const availableWidth = Number(origin.width) > 0 ? Number(origin.width) : Number(win.innerWidth) || 1024;
      const availableHeight = Number(origin.height) > 0 ? Number(origin.height) : Number(win.innerHeight) || 768;
      let left = rect.right - Number(origin.left) - width;
      if (left < 8) left = 8;
      if (left + width > availableWidth - 8) left = Math.max(8, availableWidth - width - 8);
      let top = rect.bottom - Number(origin.top) + 6;
      if (top + height > availableHeight - 8) top = rect.top - Number(origin.top) - height - 6;
      if (top < 8) top = 8;
      contactQuickMenu.style.left = `${Math.round(left)}px`;
      contactQuickMenu.style.top = `${Math.round(top)}px`;
      edit.focus({ preventScroll: true });
    }
    contactQuickMenu.addEventListener("keydown", (event) => {
      const items = quickMenuItems();
      const current = items.indexOf(root.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeContactQuickMenu();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        focusQuickMenuItem(current + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusQuickMenuItem(current - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusQuickMenuItem(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusQuickMenuItem(items.length - 1);
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeContactQuickMenu();
      }
    }, { signal: controller.signal });
    function setEditFeedback({ title = "", body = "", tone = "" } = {}) {
      editContactFeedbackTitle.textContent = title;
      editContactFeedbackBody.textContent = body;
      editContactFeedback.hidden = title.length === 0 && body.length === 0;
      if (tone) editContactFeedback.dataset.tone = tone;
      else editContactFeedback.removeAttribute("data-tone");
    }
    function setEditBusy(busy) {
      editPending = busy;
      editContactName.readOnly = busy;
      editContactDescription.readOnly = busy;
      editContactNameClear.setAttribute("aria-disabled", String(busy || !friendNameEditCapable));
      editContactDescriptionClear.setAttribute("aria-disabled", String(busy || !friendDescriptionEditCapable));
      editContactSave.setAttribute("aria-disabled", String(busy));
      editContactSave.textContent = busy ? "正在保存…" : "保存";
    }
    function openEditContact(peerId2, trigger = null) {
      if (!friendEditCapable || !peerId2) return;
      const friend = contactFor(peerId2);
      if (!friend) return;
      closeContactQuickMenu({ restoreFocus: false, quiet: true });
      editAttempt += 1;
      editTargetPeerId = peerId2;
      editOriginal = {
        name: typeof friend.name === "string" ? friend.name : "",
        description: typeof friend.description === "string" ? friend.description : ""
      };
      editContactPeerId.textContent = peerId2;
      editContactName.value = editOriginal.name;
      editContactDescription.value = editOriginal.description;
      editContactName.disabled = !friendNameEditCapable;
      editContactDescription.disabled = !friendDescriptionEditCapable;
      editContactNameClear.hidden = !friendNameEditCapable;
      editContactDescriptionClear.hidden = !friendDescriptionEditCapable;
      editContactName.placeholder = "留空则显示短 Peer ID";
      setEditFeedback();
      setEditBusy(false);
      openDialog(editContactDialog, trigger);
      (friendNameEditCapable ? editContactName : editContactDescription).focus({ preventScroll: true });
    }
    function validateEditContact(name, description) {
      if (name.length > 0 && !FRIEND_NAME_PATTERN.test(name)) {
        return { field: "name", message: "名称只允许小写字母、数字和 -，最多 32 个字符；留空可清除名称。" };
      }
      if ([...description].length > 280) {
        return { field: "description", message: "备注最多 280 个字符。" };
      }
      for (const char of description) {
        if (char.codePointAt(0) < 32 || char.codePointAt(0) === 127) {
          return { field: "description", message: "备注不能包含控制字符。" };
        }
      }
      return null;
    }
    async function submitEditContact(event) {
      event.preventDefault();
      if (destroyed || editPending || !editTargetPeerId) return;
      const peerId2 = editTargetPeerId;
      const name = editContactName.value.trim();
      const description = editContactDescription.value.trim();
      const invalid = validateEditContact(name, description);
      if (invalid) {
        setEditFeedback({ title: "还没有保存", body: invalid.message, tone: "invalid" });
        (invalid.field === "name" ? editContactName : editContactDescription).focus({ preventScroll: true });
        return;
      }
      const nameChanged = friendNameEditCapable && name !== editOriginal.name;
      const descriptionChanged = friendDescriptionEditCapable && description !== editOriginal.description;
      if (!nameChanged && !descriptionChanged) {
        closeDialog(editContactDialog);
        return;
      }
      const attempt = ++editAttempt;
      setEditBusy(true);
      setEditFeedback({ title: "正在保存联系人资料…", body: "只更新本机联系人记录和公开的 friends.json。", tone: "info" });
      const failures = [];
      let savedName = false;
      let savedDescription = false;
      let latest = null;
      if (nameChanged) {
        try {
          const value = await options.onSetFriendName(peerId2, name);
          const failure = editResultError(value);
          if (failure) throw new Error(failure);
          latest = normalizedFriendEditValue(value);
          savedName = true;
        } catch (error) {
          failures.push({ field: "name", message: errorText(error) || "名称没有保存。" });
        }
      }
      if (descriptionChanged) {
        try {
          const value = await options.onSetFriendDescription(peerId2, description);
          const failure = editResultError(value);
          if (failure) throw new Error(failure);
          latest = normalizedFriendEditValue(value) ?? latest;
          savedDescription = true;
        } catch (error) {
          failures.push({ field: "description", message: errorText(error) || "备注没有保存。" });
        }
      }
      if (destroyed || attempt !== editAttempt || !editContactDialog.open) return;
      setEditBusy(false);
      const fallback = {
        peerId: peerId2,
        name: savedName ? name : editOriginal.name,
        description: savedDescription ? description : editOriginal.description
      };
      if (latest || savedName || savedDescription) applyEditedFriend(latest, fallback);
      if (failures.length === 0) {
        closeDialog(editContactDialog);
        return;
      }
      if (savedName) editOriginal.name = name;
      if (savedDescription) editOriginal.description = description;
      const title = failures.length === (nameChanged ? 1 : 0) + (descriptionChanged ? 1 : 0) ? "没有保存修改" : "只保存了部分修改";
      setEditFeedback({
        title,
        body: failures.map((item) => `${item.field === "name" ? "名称" : "备注"}：${item.message}`).join(" "),
        tone: "error"
      });
      if (failures[0].field === "name" && friendNameEditCapable) editContactName.focus({ preventScroll: true });
      else if (friendDescriptionEditCapable) editContactDescription.focus({ preventScroll: true });
    }
    function draftKeyFor(peerId2) {
      return `chat:${peerId2}`;
    }
    function persistDraft(peerId2, value) {
      if (!peerId2) return;
      storeDraft(view, draftKeyFor(peerId2), value);
      scheduleSave();
    }
    function chatScrollFor(peerId2) {
      const map = view.pages.messages.chatScrolls;
      const value = map && typeof map === "object" ? Number(map[peerId2]) : 0;
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    function readChatAnchor(peerId2) {
      const map = view.pages.messages.chatAnchors;
      const value = map && typeof map === "object" ? map[peerId2] : null;
      if (!value || typeof value !== "object" || typeof value.messageId !== "string" || !value.messageId) {
        return null;
      }
      const offset = Number(value.offset);
      return {
        messageId: value.messageId,
        offset: Number.isFinite(offset) ? offset : 0,
        atBottom: value.atBottom === true
      };
    }
    function clearChatAnchor(peerId2) {
      if (!peerId2 || !view.pages.messages.chatAnchors) return;
      if (Object.prototype.hasOwnProperty.call(view.pages.messages.chatAnchors, peerId2)) {
        delete view.pages.messages.chatAnchors[peerId2];
      }
    }
    function messageListHasMeasuredLayout() {
      if (!messageList || !messageList.isConnected || messageList.hidden) return false;
      const page = pageEls.messages;
      if (!page || page.hidden) return false;
      const rect = typeof messageList.getBoundingClientRect === "function" ? messageList.getBoundingClientRect() : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    }
    function applyMessageListScrollTop(value) {
      if (!messageList) return;
      const next = Math.max(0, Number(value) || 0);
      messageList.scrollTop = next;
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
      const peerId2 = chat.peerId;
      if (!peerId2 || !messageList) return;
      if (!force && (chat.pendingRestore || chat.restoreAnchor || chat.anchorMissing || chat.restoreLoading)) {
        return;
      }
      if (!messageList.isConnected || messageList.hidden || pageEls.messages.hidden) return;
      if (messageList.dataset.peerId && messageList.dataset.peerId !== peerId2) return;
      if (!force && scrollEventIsProgrammatic()) {
        view.pages.messages.chatScrolls[peerId2] = Math.max(0, messageList.scrollTop || 0);
        if (readChatAnchor(peerId2)) {
          scheduleSave();
          return;
        }
      }
      view.pages.messages.chatScrolls[peerId2] = Math.max(0, messageList.scrollTop || 0);
      if (!messageListHasMeasuredLayout()) {
        scheduleSave();
        return;
      }
      const anchor = captureVisibleMessageAnchor();
      if (anchor) {
        const atBottom = isMessageListAtBottom();
        view.pages.messages.chatAnchors[peerId2] = atBottom ? { messageId: anchor.messageId, offset: anchor.offset, atBottom: true } : { messageId: anchor.messageId, offset: anchor.offset };
      } else if (messageList.querySelectorAll(".rm-message[data-message-id]").length === 0) {
        clearChatAnchor(peerId2);
      }
      scheduleSave();
    }
    function saveIndexScroll() {
      if (currentPage !== "messages" || contactsState.selectedPeerId || pageEls.messages.hidden) return;
      view.pages.messages.scroll = Math.max(0, pageEls.messages.scrollTop || 0);
    }
    function resetChatFor(peerId2) {
      const cached = chatStates.get(peerId2);
      const hasWindow = Boolean(cached && cached.items.length > 0);
      const state = cached ?? createChatState(peerId2);
      if (!cached) chatStates.set(peerId2, state);
      chat = state;
      chat.peerId = peerId2;
      chat.generation += 1;
      chat.requestSeq += 1;
      chat.loadingOlder = false;
      chat.olderError = "";
      chat.historyRetrying = false;
      chat.historyRetryPending = false;
      chat.focusMessageId = "";
      chat.focusNotice = "";
      chat.focusProbe = 0;
      chat.focusBusy = false;
      chat.pendingRestore = true;
      chat.anchorMissing = false;
      chat.restoreLoading = false;
      chat.restorePages = 0;
      restoreRun += 1;
      expectedProgrammaticScroll = null;
      messageList.dataset.peerId = peerId2;
      chat.restoreScroll = hasWindow ? chatScrollFor(peerId2) : 0;
      chat.restoreWindow = hasWindow;
      chat.restoreAnchor = readChatAnchor(peerId2);
      if (!hasWindow) {
        chat.items = [];
        chat.at = 0;
        chat.error = messagesCapable ? "" : "消息读取暂不可用";
        chat.freshness = messagesCapable ? "loading" : "unavailable";
        chat.retention = null;
        chat.latestLoaded = false;
        chat.historyHasMore = false;
        chat.historyCursor = "";
        chat.historyEnded = false;
        chat.historyError = "";
        chat.historyRetryMode = "";
        chat.firstPage = true;
      }
      messageInput.value = readDraft(view, draftKeyFor(peerId2));
      composerNotice = null;
      messageOlderError.hidden = true;
      messageOlderError.textContent = "";
      applyComposerStatus("", "", "");
      updateComposerMeta();
    }
    function updateConversationIdentity(peerId2) {
      const id = String(peerId2 ?? "");
      if (!id) return;
      const friend = conversationFriend(id);
      const identityFriend = friend ?? { peerId: id };
      const displayName = contactRowName(identityFriend);
      const verified = verifiedContactProfileFor(id);
      const localName = typeof friend?.name === "string" ? friend.name.trim() : "";
      const localDescription = typeof friend?.description === "string" ? friend.description.trim() : "";
      const localPieces = [];
      if (verified && localName && localName !== verified.displayName) localPieces.push(`本机备注：${localName}`);
      if (verified && localDescription && localDescription !== verified.description) localPieces.push(localDescription);
      conversationName.textContent = displayName;
      conversationPeerId.textContent = id;
      applyContactAvatar(conversationAvatar, identityFriend);
      conversationAvatar.dataset.profilePeer = id;
      conversationAvatar.dataset.profileRef = `chat:${id}`;
      conversationLocalNote.textContent = localPieces.join(" · ");
      conversationLocalNote.hidden = localPieces.length === 0;
      conversationProfile.hidden = !peerProfileCapable;
      conversationProfile.dataset.profilePeer = id;
      conversationProfile.dataset.profileRef = `chat-profile:${id}`;
      conversationProfile.setAttribute("aria-label", `查看 ${displayName} 的档案`);
      conversationMenu.hidden = !(friendEditCapable && friend);
      conversationMenu.dataset.quickPeer = id;
      conversationMenu.dataset.quickRef = `chat-menu:${id}`;
      conversationMenu.setAttribute("aria-expanded", String(!contactQuickMenu.hidden && quickMenuPeerId === id));
      const state = friend?.connection === "connected" || friend?.connection === "disconnected" ? friend.connection : "unknown";
      conversationState.dataset.state = state;
      conversationState.textContent = connectionStateText(state);
    }
    function renderConversation() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) {
        pageEls.messages.dataset.view = "index";
        messagesIndex.hidden = false;
        conversationView.hidden = true;
        chat.peerId = "";
        if (messageList) messageList.dataset.peerId = "";
        return;
      }
      if (chat.peerId !== peerId2) resetChatFor(peerId2);
      pageEls.messages.dataset.view = "conversation";
      messagesIndex.hidden = true;
      conversationView.hidden = false;
      updateConversationBackLabel(peerId2);
      updateConversationIdentity(peerId2);
      renderComposer();
      renderMessageList();
    }
    function updateConversationBackLabel(peerId2) {
      if (!conversationBack) return;
      const valid = Boolean(peerId2) && chat.returnPeer === peerId2;
      const origin = valid && chat.returnPage === "contacts" ? "联系人列表"
        : valid && chat.returnPage === "profile" ? "联系人档案"
          : valid && chat.returnPage === "home" ? "主页"
            : valid && chat.returnPage === "journey" && chat.returnJourneyId ? "漫游证据"
              : "会话列表";
      conversationBack.textContent = valid && chat.returnPage === "contacts" ? "← 返回联系人" : valid && chat.returnPage === "profile" ? "← 返回联系人档案" : valid && chat.returnPage === "home" ? "← 返回主页" : valid && chat.returnPage === "journey" && chat.returnJourneyId ? "← 返回漫游" : "← 返回对话";
      if (conversationOrigin) conversationOrigin.textContent = `入口来源：${origin}`;
    }
    function openMessagesIndex(source = "home") {
      const from = pageElsHas(source) && source !== "messages" && source !== "settings" ? source : "home";
      view.pages.messages.indexReturnPage = from;
      showPage("messages");
      if (contactsState.selectedPeerId) {
        renderConversation();
        saveNow();
        return;
      }
      pageEls.messages.scrollTop = view.pages.messages.scroll;
      conversationQuery.focus?.({ preventScroll: true });
      saveNow();
    }
    function openConversation(peerId2, {
      source = "messages",
      focus = true,
      focusMessageId = "",
      journeyId = "",
      journeyEvent = 0,
      journeyMessageId = "",
      profileTab = "interactions",
      profileScroll = 0,
      returnFocus = ""
    } = {}) {
      if (!peerId2) return;
      settingsFocusSeq += 1;
      if (contactsState.selectedPeerId && contactsState.selectedPeerId !== peerId2) saveChatScroll();
      if (source === "messages" && !contactsState.selectedPeerId) saveIndexScroll();
      const profileSource2 = source === "profile" && view.contactProfile.peerId === peerId2;
      const returnPage = source === "contacts" ? "contacts" : profileSource2 ? "profile" : source === "home" || source === "raminga" ? "home" : source === "journey" && typeof journeyId === "string" && journeyId.length > 0 ? "journey" : "messages";
      const tab = ["interactions", "posts", "address"].includes(profileTab) ? profileTab : "interactions";
      const scroll2 = Math.max(0, Math.floor(Number(profileScroll) || 0));
      const focusKey = typeof returnFocus === "string" ? returnFocus.slice(0, 512) : "";
      if (returnPage === "profile") {
        profileReturn.open = false;
        profileView.hidden = true;
      }
      contactsState.selectedPeerId = peerId2;
      view.pages.messages.peerId = peerId2;
      view.pages.messages.returnPage = returnPage;
      view.pages.messages.returnPeer = peerId2;
      view.pages.messages.returnJourneyId = returnPage === "journey" ? journeyId : "";
      view.pages.messages.returnJourneyEvent = returnPage === "journey" && Number.isSafeInteger(Number(journeyEvent)) ? Number(journeyEvent) : 0;
      view.pages.messages.returnJourneyMessage = returnPage === "journey" && typeof journeyMessageId === "string" ? journeyMessageId : "";
      view.pages.messages.returnProfileTab = returnPage === "profile" ? tab : "interactions";
      view.pages.messages.returnProfileScroll = returnPage === "profile" ? scroll2 : 0;
      view.pages.messages.returnFocus = returnPage === "profile" || returnPage === "contacts" ? focusKey : "";
      renderConversation();
      chat.returnPage = returnPage;
      chat.returnPeer = peerId2;
      chat.returnJourneyId = returnPage === "journey" ? journeyId : "";
      chat.returnJourneyEvent = returnPage === "journey" ? Math.max(0, Math.floor(Number(journeyEvent) || 0)) : 0;
      chat.returnJourneyMessage = returnPage === "journey" && typeof journeyMessageId === "string" ? journeyMessageId : "";
      chat.returnProfileTab = returnPage === "profile" ? tab : "interactions";
      chat.returnProfileScroll = returnPage === "profile" ? scroll2 : 0;
      chat.returnFocus = returnPage === "profile" || returnPage === "contacts" ? focusKey : "";
      chat.focusMessageId = typeof focusMessageId === "string" ? focusMessageId : "";
      chat.focusNotice = chat.focusMessageId ? "已在当前保留记录中找到该消息引用。" : "";
      updateConversationBackLabel(peerId2);
      showPage("messages");
      pageEls.messages.scrollTop = 0;
      saveNow();
      if (messagesCapable) requestMessages(peerId2, true);
      if (focus) messageInput.focus({ preventScroll: true });
    }
    function closeConversation() {
      settingsFocusSeq += 1;
      cancelMarkRead();
      const peerId2 = contactsState.selectedPeerId;
      const profileReturnPage = chat.returnPage === "profile" && view.contactProfile.peerId === peerId2;
      const returnPage = chat.returnPage === "contacts" || chat.returnPage === "home" || profileReturnPage || chat.returnPage === "journey" && chat.returnJourneyId ? chat.returnPage : "messages";
      const renderKey = chat.returnPeer === peerId2 ? `journey-evidence:${chat.returnJourneyId}:${chat.returnJourneyEvent}:${chat.returnJourneyMessage}` : "";
      const focusPeer = chat.returnPeer === peerId2 ? peerId2 : "";
      const returnProfileTab = chat.returnProfileTab;
      const returnProfileScroll = chat.returnProfileScroll;
      const returnFocus = chat.returnFocus;
      if (peerId2) {
        saveChatScroll();
        chat.generation += 1;
        chat.requestSeq += 1;
        chat.loadingOlder = false;
      }
      contactsState.selectedPeerId = "";
      view.pages.messages.peerId = "";
      view.pages.messages.returnPage = "";
      view.pages.messages.returnPeer = "";
      view.pages.messages.returnJourneyId = "";
      view.pages.messages.returnJourneyEvent = 0;
      view.pages.messages.returnJourneyMessage = "";
      view.pages.messages.returnProfileTab = "interactions";
      view.pages.messages.returnProfileScroll = 0;
      view.pages.messages.returnFocus = "";
      chat = createChatState("");
      renderConversation();
      updateConversationIndexState();
      if (returnPage === "profile" && view.contactProfile.peerId === peerId2) {
        restoreProfileAfterConversation(peerId2, returnProfileTab, returnProfileScroll, returnFocus);
        return;
      }
      if (returnPage === "contacts") {
        showPage("contacts", { save: false });
        pageEls.contacts.scrollTop = view.pages.contacts.scroll;
        let target = null;
        if (focusPeer) {
          target = returnFocus.startsWith("contact-chat:") ? contactList.querySelector(`button[data-chat-peer="${selectorValue(focusPeer)}"]`) : contactList.querySelector(`button[data-contact-peer="${selectorValue(focusPeer)}"]`);
        }
        if (!target && view.pages.contacts.filter === "unread") {
          target = contactFilters.find((button) => button.dataset.contactFilter === "unread") ?? null;
        }
        (target ?? contactQuery).focus({ preventScroll: true });
      } else if (returnPage === "journey") {
        showPage("journey", { save: false });
        pageEls.journey.scrollTop = view.journey.scroll;
        saveNow();
        const target = [...journeyDetail.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === renderKey);
        (target ?? journeyBack).focus?.({ preventScroll: true });
        return;
      } else if (returnPage === "home") {
        showPage("home", { save: false });
        pageEls.home.scrollTop = view.home.scroll;
        const target = ramingaSessionList.querySelector("[data-journey-open]") ?? homeAgentName;
        target?.focus?.({ preventScroll: true });
      } else {
        showPage("messages", { save: false });
        pageEls.messages.scrollTop = view.pages.messages.scroll;
        const row = focusPeer ? conversationList.querySelector(`button[data-conversation-peer="${selectorValue(focusPeer)}"]`) : null;
        (row ?? conversationQuery).focus({ preventScroll: true });
      }
      saveNow();
    }
    function requestMessages(peerId2, force = false) {
      if (!messagesCapable || destroyed || !peerId2) return;
      const generation = chat.generation;
      const request = ++chat.requestSeq;
      let pending;
      try {
        pending = options.onLoadMessages(peerId2, force === true, { token: generation });
      } catch (error) {
        pending = Promise.reject(error);
      }
      void Promise.resolve(pending).then((value) => {
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId2 || contactsState.selectedPeerId !== peerId2 || request !== chat.requestSeq) return;
        if (value && typeof value === "object" && value.peerId && !appliedMessagePages.has(value)) {
          setMessagePage(value, { token: generation });
        }
      }).catch((error) => {
        if (destroyed || chat.generation !== generation || chat.peerId !== peerId2 || contactsState.selectedPeerId !== peerId2 || request !== chat.requestSeq) return;
        setMessagesError(peerId2, errorText(error));
      });
    }
    function requestOlderMessages() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || chat.loadingOlder || !chat.historyHasMore || !messagesCapable) {
        return Promise.resolve({ ok: false, reason: "unavailable" });
      }
      const generation = chat.generation;
      const cursor = chat.historyCursor;
      chat.loadingOlder = true;
      chat.olderError = "";
      messageOlderError.hidden = true;
      updateMessageListChrome();
      let pending;
      try {
        if (typeof options.onLoadOlder !== "function") throw new Error("加载更早消息暂不可用");
        pending = options.onLoadOlder(peerId2, cursor, { token: generation });
      } catch (error) {
        pending = Promise.reject(error);
      }
      return (async () => {
        try {
          const value = await Promise.resolve(pending);
          if (destroyed || chat.generation !== generation || chat.peerId !== peerId2 || contactsState.selectedPeerId !== peerId2) {
            return { ok: false, reason: "stale" };
          }
          let applied = false;
          if (value && typeof value === "object" && value.peerId && !appliedMessagePages.has(value)) {
            applied = appendMessagePage(value, { token: generation });
          }
          return {
            ok: true,
            applied,
            items: chat.items.length,
            cursor: chat.historyCursor,
            hasMore: chat.historyHasMore
          };
        } catch (error) {
          if (destroyed || chat.generation !== generation || chat.peerId !== peerId2 || contactsState.selectedPeerId !== peerId2) {
            return { ok: false, reason: "stale" };
          }
          chat.olderError = `读取更早消息失败：${errorText(error) || "未知错误"}。可以重试。`;
          return { ok: false, reason: "error" };
        } finally {
          if (!destroyed && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2) {
            chat.loadingOlder = false;
            updateMessageListChrome();
          }
        }
      })();
    }
    const MAX_RESTORE_PAGES = 40;
    async function restoreAnchorFromHistory() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || !chat.restoreAnchor || !messagesCapable || chat.loadingOlder || chat.restoreLoading || !chat.historyHasMore) return;
      const generation = chat.generation;
      const run = ++restoreRun;
      chat.restoreLoading = true;
      chat.restorePages = 0;
      chat.olderError = "";
      updateMessageListChrome();
      try {
        while (!destroyed && run === restoreRun && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2 && chat.restoreAnchor) {
          if (!chat.historyHasMore || chat.historyError || chat.restorePages >= MAX_RESTORE_PAGES) break;
          const beforeItems = chat.items.length;
          const beforeCursor = chat.historyCursor;
          const result = await requestOlderMessages();
          if (!result.ok) break;
          chat.restorePages += 1;
          if (!chat.restoreAnchor) break;
          if (chat.items.length === beforeItems && chat.historyCursor === beforeCursor) break;
        }
      } finally {
        if (!destroyed && run === restoreRun && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2) {
          chat.restoreLoading = false;
          updateMessageListChrome();
        }
      }
    }
    function stayAtLatestMessages() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || !messageList || chat.restoreLoading) return;
      restoreRun += 1;
      clearChatAnchor(peerId2);
      chat.restoreAnchor = null;
      chat.anchorMissing = false;
      chat.restorePages = 0;
      expectedProgrammaticScroll = null;
      scrollMessagesToBottom();
      updateMessageListChrome();
      saveChatScroll({ force: true });
      saveNow();
    }
    function currentMessageState() {
      const state = messageListState({
        messages: chat.items,
        error: chat.error,
        freshness: chat.freshness,
        peerId: contactsState.selectedPeerId
      });
      if (state.kind === "empty" && chat.historyError) {
        return { kind: "error", messages: [], error: chat.historyError, stale: false };
      }
      return state;
    }
    function pageContextMatches(context, peerId2) {
      if (!context || context.token === void 0) return true;
      return chat.generation === context.token && chat.peerId === peerId2;
    }
    function pageErrorMessage(page) {
      return typeof page?.error === "string" ? page.error.trim() : "";
    }
    function pageNextBefore(page) {
      return typeof page?.nextBefore === "string" ? page.nextBefore : "";
    }
    function historyCursorError(page, { initial = false, preserved = false } = {}) {
      const nextBefore = pageNextBefore(page);
      let reason;
      if (page.hasMore === true) {
        reason = nextBefore.length === 0 ? "服务端表示还有更早消息，但没有返回可用的继续游标。" : "服务端表示还有更早消息，但返回的游标没有前进。";
      } else {
        reason = nextBefore.length === 0 ? "服务端没有明确历史是否结束，也没有返回可用的继续游标。" : "服务端没有明确历史是否结束，返回的游标也没有前进。";
      }
      if (initial) return `${reason}这不代表会话没有更早消息；可以重新读取历史。`;
      if (preserved) return `${reason}已保留此前有效游标和已加载消息，可以重试。`;
      return `${reason}已保留已加载消息，可以重新读取历史。`;
    }
    function applyInitialHistoryBoundary(page) {
      const nextBefore = pageNextBefore(page);
      if (page.hasMore === false) {
        chat.historyHasMore = false;
        chat.historyCursor = "";
        chat.historyEnded = true;
        chat.historyError = "";
        chat.historyRetryMode = "";
        return;
      }
      if (page.hasMore === true && nextBefore.length > 0) {
        chat.historyHasMore = true;
        chat.historyCursor = nextBefore;
        chat.historyEnded = false;
        chat.historyError = "";
        chat.historyRetryMode = "";
        return;
      }
      chat.historyHasMore = false;
      chat.historyCursor = "";
      chat.historyEnded = false;
      chat.historyError = historyCursorError(page, { initial: true });
      chat.historyRetryMode = "latest";
    }
    function applyOlderHistoryBoundary(page) {
      const nextBefore = pageNextBefore(page);
      if (page.hasMore === false) {
        chat.historyHasMore = false;
        chat.historyCursor = "";
        chat.historyEnded = true;
        chat.historyError = "";
        chat.historyRetryMode = "";
        return;
      }
      if (page.hasMore === true && nextBefore.length > 0 && nextBefore !== chat.historyCursor) {
        chat.historyHasMore = true;
        chat.historyCursor = nextBefore;
        chat.historyEnded = false;
        chat.historyError = "";
        chat.historyRetryMode = "";
        return;
      }
      const preserved = chat.historyHasMore && chat.historyCursor.length > 0;
      chat.historyError = historyCursorError(page, { preserved });
      chat.historyRetryMode = preserved ? "older" : "latest";
    }
    function markPageApplied(page, applied) {
      if (applied && page && typeof page === "object") appliedMessagePages.add(page);
      return applied;
    }
    const MAX_FOCUS_PROBE_PAGES = 20;
    async function probeFocusInHistory() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || !chat.focusMessageId || chat.focusBusy || !messagesCapable) return;
      const generation = chat.generation;
      const wanted = chat.focusMessageId;
      if (chat.items.some((message) => message.messageId === wanted)) return;
      chat.focusBusy = true;
      chat.focusProbe = 0;
      chat.focusNotice = "";
      updateMessageListChrome();
      try {
        while (!destroyed && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2 && chat.focusMessageId === wanted) {
          if (!chat.historyHasMore || chat.historyError || chat.focusProbe >= MAX_FOCUS_PROBE_PAGES) break;
          const beforeItems = chat.items.length;
          const beforeCursor = chat.historyCursor;
          const result = await requestOlderMessages();
          chat.focusProbe += 1;
          if (!result.ok) break;
          if (!chat.focusMessageId) break;
          if (chat.items.length === beforeItems && chat.historyCursor === beforeCursor) break;
        }
        if (!destroyed && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2 && chat.focusMessageId === wanted) {
          if (!chat.historyHasMore) {
            chat.focusNotice = "该消息引用已不在当前保留消息中，无法定位；这里只保留历史观察。";
          } else if (chat.focusProbe >= MAX_FOCUS_PROBE_PAGES) {
            chat.focusNotice = "在本次有界读取的历史消息中没有找到该引用；没有继续扩大范围。";
          } else if (!chat.historyError) {
            chat.focusNotice = `暂时无法定位该消息引用${chat.olderError ? `：${chat.olderError}` : "。"}`;
          }
          if (chat.focusNotice) chat.focusMessageId = "";
        } else if (!destroyed && chat.generation === generation && chat.peerId === peerId2 && contactsState.selectedPeerId === peerId2 && !chat.focusMessageId) {
          chat.focusNotice = "已在当前保留记录中找到该消息引用。";
        }
      } finally {
        if (!destroyed && chat.generation === generation) {
          chat.focusBusy = false;
          updateMessageListChrome();
        }
      }
    }
    function setMessagePage(page, context) {
      if (destroyed || !page || typeof page !== "object") return false;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || page.peerId !== peerId2 || !pageContextMatches(context, peerId2)) return false;
      const wasHidden = messageList.hidden;
      const wasAtBottom = isMessageListAtBottom();
      const wasFirstPage = chat.firstPage;
      const previousTop = messageList.scrollTop;
      const visibleAnchor = wasAtBottom ? null : captureVisibleMessageAnchor();
      const pageError = pageErrorMessage(page);
      const pageAt = Number(page.at) > 0 ? Number(page.at) : 0;
      const staleMetadata = chat.at > 0 && pageAt > 0 && pageAt < chat.at;
      chat.items = mergeMessages(chat.items, page.messages, { peerId: peerId2 });
      notePersistedHumanOutbound(page.messages);
      if (!pageError && chat.items.length === 0 && page.hasMore !== true) {
        clearChatAnchor(peerId2);
        chat.restoreAnchor = null;
        chat.anchorMissing = false;
      }
      if (!staleMetadata) {
        if (pageAt > 0) chat.at = pageAt;
        chat.error = pageError;
        chat.freshness = page.freshness || "live";
        chat.retention = page.retention && typeof page.retention === "object" ? page.retention : null;
      }
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
      const task = peerId2 ? taskFor(peerId2) : null;
      if (task) applyPersistedTaskState(task, messageForTask(task));
      renderMessageList();
      renderComposer();
      if (chat.pendingRestore) {
        chat.pendingRestore = false;
        let restored = false;
        if (chat.restoreAnchor) {
          if (chat.restoreAnchor.atBottom === true && chat.items.length > 0) {
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
      } else {
        applyMessageListScrollTop(previousTop);
      }
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
      else scheduleMarkRead();
      return markPageApplied(page, true);
    }
    function appendMessagePage(page, context) {
      if (destroyed || !page || typeof page !== "object") return false;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || page.peerId !== peerId2 || !pageContextMatches(context, peerId2)) return false;
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
      chat.items = mergeMessages(chat.items, page.messages, { peerId: peerId2 });
      notePersistedHumanOutbound(page.messages);
      if (page.retention) chat.retention = page.retention;
      chat.olderError = "";
      chat.loadingOlder = false;
      chat.historyRetrying = false;
      chat.historyRetryPending = false;
      messagesRetrying = false;
      applyOlderHistoryBoundary(page);
      const task = peerId2 ? taskFor(peerId2) : null;
      if (task) applyPersistedTaskState(task, messageForTask(task));
      renderMessageList();
      if (wasAtBottom) {
        scrollMessagesToBottom();
      } else if (visibleAnchor && restoreVisibleMessageAnchor(visibleAnchor, { keepScreen: true })) {
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
          chat.restoreAnchor = null;
          chat.anchorMissing = true;
        }
      }
      updateMessageListChrome();
      if (chat.focusMessageId) void probeFocusInHistory();
      else scheduleMarkRead();
      return markPageApplied(page, true);
    }
    function captureVisibleMessageAnchor() {
      if (!messageListHasMeasuredLayout()) return null;
      const listRect = messageList.getBoundingClientRect();
      for (const row of messageList.querySelectorAll(".rm-message[data-message-id]")) {
        if (row.dataset.peerId && row.dataset.peerId !== chat.peerId) continue;
        const rect = typeof row.getBoundingClientRect === "function" ? row.getBoundingClientRect() : null;
        if (!rect || rect.height <= 0 || rect.bottom <= listRect.top + 1) continue;
        const messageId2 = row.dataset.messageId;
        if (!messageId2) continue;
        return { messageId: messageId2, offset: Math.round(rect.top - listRect.top), top: rect.top };
      }
      return null;
    }
    function restoreVisibleMessageAnchor(anchor, { keepScreen = false } = {}) {
      if (!anchor || !anchor.messageId || !messageList) return false;
      const row = messageList.querySelector(`[data-message-id="${selectorValue(anchor.messageId)}"]`);
      if (!row || typeof row.getBoundingClientRect !== "function") return false;
      const listRect = messageList.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const delta = keepScreen && Number.isFinite(anchor.top) ? rowRect.top - anchor.top : rowRect.top - listRect.top - Number(anchor.offset || 0);
      if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
        applyMessageListScrollTop(Math.max(0, messageList.scrollTop + delta));
      }
      return true;
    }
    function setMessagesError(peerId2, error) {
      if (destroyed || contactsState.selectedPeerId !== peerId2) return;
      chat.error = errorText(error) || "消息读取失败";
      chat.freshness = chat.items.length > 0 ? "stale" : "unavailable";
      messagesRetrying = false;
      chat.historyRetrying = false;
      chat.historyRetryPending = false;
      renderMessageList();
    }
    function isMessageListAtBottom() {
      if (!messageList || messageList.hidden) return chat.firstPage;
      return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= 48;
    }
    function updateJumpToLatest() {
      if (!composerJump || !messageJumpLatest) return;
      const visible = currentPage === "messages"
        && !conversationView.hidden
        && !pageEls.messages.hidden
        && !messageList.hidden
        && chat.items.length > 0;
      composerJump.hidden = !(visible && !isMessageListAtBottom());
    }
    function jumpToLatestMessages() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      stayAtLatestMessages();
      updateMessageListChrome();
      updateJumpToLatest();
      if (!composer.hidden) focusMessageInput();
      else {
        const rows = messageList.querySelectorAll('.rm-message[data-message-id]');
        rows[rows.length - 1]?.focus({ preventScroll: true });
      }
      scheduleMarkRead();
    }
    function scrollMessagesToBottom() {
      if (!messageList || messageList.hidden) return;
      applyMessageListScrollTop(messageList.scrollHeight);
    }
    function cancelMarkRead() {
      if (markReadTimer !== null) {
        win.clearTimeout(markReadTimer);
        markReadTimer = null;
      }
      markReadKey = "";
      markReadSeq += 1;
    }
    function latestReadableMessage() {
      const state = currentMessageState();
      if (state.kind !== "ready" || !Array.isArray(state.messages) || state.messages.length === 0) return null;
      return [...state.messages].sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
        return String(left.messageId).localeCompare(String(right.messageId));
      }).at(-1) ?? null;
    }
    function markReadEligible() {
      if (!markReadCapable || destroyed || doc.visibilityState !== "visible") return false;
      if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
      if (currentPage !== "messages" || conversationView.hidden) return false;
      const pageId = pageEls.messages;
      if (!pageId || pageId.hidden) return false;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return false;
      if (!messageList || messageList.hidden) return false;
      // A pending evidence/last-read restore is not a human decision to read
      // the newest retained message.
      if (chat.pendingRestore || chat.focusMessageId || chat.focusBusy || chat.restoreLoading) return false;
      const active = root.activeElement ?? doc.activeElement;
      if (!active || active === doc.body || !conversationView.contains(active)) return false;
      if (!isMessageListAtBottom()) return false;
      return Boolean(latestReadableMessage());
    }
    function scheduleMarkRead() {
      if (!markReadCapable || destroyed) return;
      if (!markReadEligible()) {
        cancelMarkRead();
        return;
      }
      const peerId2 = contactsState.selectedPeerId;
      const latest = latestReadableMessage();
      if (!peerId2 || !latest?.messageId) return;
      const key2 = `${peerId2}\0${latest.messageId}`;
      if (markReadKey === key2 || markReadInFlight) return;
      markReadKey = key2;
      if (markReadTimer !== null) win.clearTimeout(markReadTimer);
      const seq = ++markReadSeq;
      markReadTimer = win.setTimeout(() => {
        markReadTimer = null;
        if (seq !== markReadSeq) return;
        if (!markReadEligible()) {
          cancelMarkRead();
          return;
        }
        void flushMarkRead(peerId2, latest.messageId, key2, seq);
      }, 500);
    }
    async function flushMarkRead(peerId2, messageId2, key2, seq) {
      if (!markReadCapable || markReadInFlight || seq !== markReadSeq) return;
      markReadInFlight = true;
      try {
        const result = await options.onMarkRead(peerId2, messageId2);
        if (destroyed || seq !== markReadSeq) return;
        const unread = Math.max(0, Number(result?.unreadCount) || 0);
        const conversations = conversationsState.data;
        if (conversations && Array.isArray(conversations.conversations)) {
          const row = conversations.conversations.find((item) => item?.peerId === peerId2);
          if (row) {
            const previous = Math.max(0, Number(row.unreadCount) || 0);
            row.unreadCount = unread;
            row.lastReadMessageId = result?.lastReadMessageId || messageId2;
            row.lastReadAt = Number(result?.lastReadAt) || Date.now();
            if (Number.isFinite(Number(conversations.totalUnread))) {
              conversations.totalUnread = Math.max(0, Number(conversations.totalUnread) - previous + unread);
            }
          }
        }
        const friend = contactFor(peerId2);
        if (friend) friend.unreadCount = unread;
        markReadKey = key2;
        refreshUnreadBadges();
        updateConversationIndexState();
        updateContactsState();
      } catch (error) {
        console.warn("[raminga-ui] mark read failed", errorText(error));
        markReadKey = "";
      } finally {
        markReadInFlight = false;
        if (!destroyed && markReadEligible()) {
          const newest = latestReadableMessage();
          const newestKey = newest?.messageId ? `${contactsState.selectedPeerId}\0${newest.messageId}` : "";
          if (newestKey && newestKey !== markReadKey && newest?.messageId !== messageId2) scheduleMarkRead();
        }
      }
    }
    function focusMessageInput() {
      messageInput.focus({ preventScroll: true });
    }
    function keepComposerFocus() {
      const active = root.activeElement;
      if (active === null || active === doc.body || active === messageSend) {
        messageInput.focus({ preventScroll: true });
      }
    }
    function showMessageState(kind, { title, body, action: action2 = null, retry = false }) {
      messageStateSection.hidden = false;
      messageStateSection.dataset.tone = kind === "error" ? "error" : "unavailable";
      $("#messageStateTitle").textContent = title;
      $("#messageStateBody").textContent = body;
      const actionEl = $("#messageStateAction");
      actionEl.hidden = action2 === null;
      actionEl.textContent = action2?.label ?? "";
      actionEl.onclick = action2 === null ? null : action2.run;
      const retryEl = $("#messageStateRetry");
      retryEl.hidden = retry !== true;
      retryEl.textContent = messagesRetrying ? "正在重试…" : "重试读取";
      retryEl.onclick = retry === true ? retryMessages : null;
      messageList.hidden = true;
      updateMessageListChrome();
    }
    let messagesRetrying = false;
    function retryMessages() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || messagesRetrying || !messagesCapable) return;
      messagesRetrying = true;
      if (chat.historyError && !chat.historyHasMore) {
        chat.historyRetryPending = true;
        chat.historyRetrying = true;
      }
      chat.freshness = "loading";
      renderMessageList();
      requestMessages(peerId2, true);
    }
    function retryHistoryBoundary() {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2 || !messagesCapable || chat.historyRetrying || chat.loadingOlder) return;
      if (chat.historyHasMore && chat.historyCursor) {
        requestOlderMessages();
        return;
      }
      chat.historyRetrying = true;
      chat.historyRetryPending = true;
      chat.olderError = "";
      updateMessageListChrome();
      requestMessages(peerId2, true);
    }
    function updateMessageListChrome() {
      updateJumpToLatest();
      if (messageFocusNote) {
        messageFocusNote.textContent = chat.focusNotice || "";
        messageFocusNote.hidden = !chat.focusNotice;
      }
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      const state = currentMessageState();
      const stale = state.kind === "ready" && (Boolean(chat.error) || chat.freshness !== "live");
      let staleText = "";
      if (stale) {
        if (chat.error) staleText = `消息可能不是最新（${chat.at > 0 ? formatRelative(chat.at) : "读取时间未知"}）。最近一次刷新失败，可以重试。`;
        else staleText = `消息可能不是最新（${chat.at > 0 ? formatRelative(chat.at) : "读取时间未知"}）。实时更新恢复后会自动刷新。`;
      }
      messageStale.textContent = staleText;
      messageStale.hidden = staleText.length === 0;
      messageRetry.hidden = !(stale && messagesCapable);
      messageRetry.textContent = messagesRetrying ? "正在重试…" : "重试读取消息";
      messageRetry.onclick = messagesCapable ? retryMessages : null;
      const restoreActionVisible = Boolean(chat.anchorMissing) && messagesCapable && chat.historyHasMore && !chat.historyError;
      loadOlder.hidden = !(state.kind === "ready" && chat.historyHasMore && messagesCapable && !restoreActionVisible);
      loadOlder.textContent = chat.loadingOlder ? "正在读取更早消息…" : chat.historyError && chat.historyRetryMode === "older" ? "重试加载更早消息" : "加载更早消息";
      loadOlder.setAttribute("aria-disabled", String(chat.loadingOlder));
      loadOlder.setAttribute("aria-busy", String(chat.loadingOlder));
      loadOlder.onclick = requestOlderMessages;
      const historyRetryVisible = Boolean(chat.historyError) && messagesCapable && loadOlder.hidden && state.kind !== "loading";
      messageHistoryRetry.hidden = !historyRetryVisible;
      messageHistoryRetry.textContent = chat.historyRetrying ? "正在重新读取…" : chat.historyRetryMode === "older" ? "重试加载更早消息" : "重新读取历史";
      messageHistoryRetry.setAttribute("aria-disabled", String(chat.historyRetrying));
      messageHistoryRetry.setAttribute("aria-busy", String(chat.historyRetrying));
      messageHistoryRetry.onclick = historyRetryVisible && !chat.historyRetrying ? retryHistoryBoundary : null;
      const olderText = chat.olderError || chat.historyError;
      messageOlderError.textContent = olderText;
      messageOlderError.hidden = olderText.length === 0;
      let restoreText = "";
      if (chat.anchorMissing) {
        if (chat.restoreLoading) {
          restoreText = `正在继续加载更早消息以定位上次阅读位置…（已加载 ${chat.items.length} 条）`;
        } else if (chat.historyHasMore) {
          restoreText = "上次阅读的位置在更早的消息中；可以继续加载更早消息，或直接定位到上次阅读位置。";
        } else if (chat.historyError) {
          restoreText = "上次阅读的位置暂时无法确认；恢复历史读取后再试，或留在最新消息。";
        } else {
          restoreText = "上次阅读的位置不在当前保留的消息中。可以留在最新消息。";
        }
      }
      messageRestoreNote.textContent = restoreText;
      messageRestoreNote.hidden = restoreText.length === 0;
      messageRestoreAction.hidden = !restoreActionVisible;
      messageRestoreAction.textContent = chat.restoreLoading ? "正在定位上次阅读位置…" : "定位上次阅读位置";
      messageRestoreAction.setAttribute("aria-disabled", String(chat.restoreLoading));
      messageRestoreAction.setAttribute("aria-busy", String(chat.restoreLoading));
      messageRestoreAction.onclick = restoreActionVisible && !chat.restoreLoading ? restoreAnchorFromHistory : null;
      const latestActionVisible = Boolean(chat.anchorMissing) && messagesCapable;
      messageRestoreLatest.hidden = !latestActionVisible;
      messageRestoreLatest.textContent = "留在最新消息";
      messageRestoreLatest.setAttribute("aria-disabled", String(chat.restoreLoading));
      messageRestoreLatest.onclick = latestActionVisible && !chat.restoreLoading ? stayAtLatestMessages : null;
      messageRestoreActions.hidden = !(restoreActionVisible || latestActionVisible);
      if (!chat.anchorMissing && chat.retention && Number(chat.retention.retainedMessages) > 0) {
        const max = Number(chat.retention.maxStoredMessages);
        messageRetention.textContent = `当前保留 ${chat.retention.retainedMessages} 条消息${max > 0 ? `（节点上限 ${max} 条）` : ""}；更早记录可能已被清理，这里不承诺完整历史。`;
        messageRetention.hidden = false;
      } else {
        messageRetention.hidden = true;
      }
    }
    function chatIdentityAvatars() {
      const agent = homeAgentModel();
      const agentRequest = currentHomeAvatarRequest();
      const agentUrl = agentRequest && homeAvatarState.key === agentRequest.key ? homeAvatarState.url : "";
      const humanName = mineState.data?.profile?.state === "available"
        ? String(mineState.data.profile.displayName ?? "").trim()
        : String(mineState.data?.publicProfile?.profile?.humanName ?? "").trim();
      return {
        human: {
          url: agent.human.available ? agent.human.avatarUrl : "",
          initial: agent.human.available ? (agent.human.avatarInitial || "关") : "人"
        },
        agent: {
          url: agentUrl,
          initial: agent.avatarInitial || "A"
        },
        unknown: { url: "", initial: "?" }
      };
    }
    function renderMessageList() {
      if (destroyed) return;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      messageList.dataset.peerId = peerId2;
      const state = currentMessageState();
      if (state.kind !== "ready") {
        messageList.replaceChildren();
        if (state.kind === "error" && !chat.error && chat.historyError) {
          messageList.hidden = true;
          messageStateSection.hidden = true;
          updateMessageListChrome();
          return;
        }
        if (state.kind === "loading") {
          showMessageState("loading", {
            title: "正在读取消息…",
            body: "正在从本机节点读取当前保留的消息记录。"
          });
        } else if (state.kind === "error" || state.kind === "unavailable") {
          showMessageState("error", {
            title: chat.error ? "这次没有读到消息" : "历史读取没有完成",
            body: `${chat.error || state.error || chat.historyError || "消息读取失败。"}
这不代表当前会话没有消息；可以重试读取。`,
            retry: messagesCapable,
            action: messagesCapable ? null : { label: "查看节点状态", run: () => openDialog(statusDialog, $("#messageStateAction")) }
          });
        } else {
          showMessageState("empty", {
            title: "还没有消息",
            body: "这是当前保留记录中的第一条会话。你可以在下面输入消息开始对话。",
            action: { label: "写第一条消息", run: focusMessageInput },
            retry: false
          });
        }
        updateMessageListChrome();
        return;
      }
      messageStateSection.hidden = true;
      messageList.hidden = false;
      const active = root.activeElement;
      const activeMessage = active?.closest?.("[data-message-id]")?.dataset.messageId ?? "";
      const activeAction = active?.dataset?.messageAction ?? "";
      const wasAtBottom = isMessageListAtBottom();
      const previousTop = messageList.scrollTop;
      messageList.replaceChildren();
      const ascending = [...state.messages].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return String(a.messageId).localeCompare(String(b.messageId));
      });
      if (ascending.some((message) => message.direction === "out")
        && mineCapable && mineState.data === null && !mineState.retrying && !mineState.error) {
        void loadMine(false);
      }
      const identities = chatIdentityAvatars();
      let previousRun = "";
      for (const message of ascending) {
        const direction = message.direction === "out" ? "out" : "in";
        const origin = direction === "out" ? normalizeMessageOrigin(message.origin) : "peer";
        const run = `${direction}:${origin}`;
        messageList.append(renderMessageRow(message, {
          showIdentity: direction === "out" && run !== previousRun,
          identity: direction === "out" ? identities[origin] : null
        }));
        previousRun = run;
      }
      updateMessageListChrome();
      if (activeMessage && activeAction) {
        const target = messageList.querySelector(`[data-message-id="${selectorValue(activeMessage)}"] [data-message-action="${selectorValue(activeAction)}"]`);
        if (target) target.focus({ preventScroll: true });
        else focusMessageInput();
      } else if (activeMessage) {
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
        const focusIsInsideRow = Boolean(focused?.closest?.(".rm-message"));
        const mayRestore = focused === null || focused === doc.body || focused === messageInput || focusIsInsideRow;
        if (!mayRestore) {
          chat.focusMessageId = "";
        } else if (target) {
          target.focus({ preventScroll: true });
          const anchor = target.querySelector(".rm-message-actions, .rm-message-meta") ?? target;
          if (typeof anchor.scrollIntoView === "function") {
            anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          chat.focusMessageId = "";
        }
      }
      scheduleMarkRead();
    }
    function normalizeMessageOrigin(value) {
      const origin = String(value ?? "");
      return origin === "human" || origin === "agent" ? origin : "unknown";
    }
    function renderMessageRow(message, { showIdentity = false, identity = null } = {}) {
      const row = element("div", "rm-message");
      row.dataset.messageId = message.messageId;
      row.dataset.peerId = message.peerId;
      row.dataset.direction = message.direction === "out" ? "out" : "in";
      row.tabIndex = -1;
      const line = element("div", "rm-message-line");
      if (message.direction === "out") {
        const originKey = normalizeMessageOrigin(message.origin);
        const avatar = element("div", "rm-message-identity");
        avatar.dataset.origin = originKey;
        avatar.setAttribute("aria-hidden", "true");
        if (showIdentity) {
          if (identity?.url) {
            const image = element("img", "rm-message-identity-img");
            image.src = identity.url;
            image.alt = "";
            image.decoding = "async";
            avatar.append(image);
          } else {
            const initial = element("span", "rm-message-identity-initial");
            initial.textContent = identity?.initial || "?";
            avatar.append(initial);
          }
        } else {
          avatar.className = "rm-message-identity is-spacer";
        }
        line.append(avatar);
      }
      const bubble = element("div", "rm-message-bubble");
      bubble.textContent = message.text;
      line.append(bubble);
      const meta = element("div", "rm-message-meta");
      const origin = element("span", "rm-message-origin");
      origin.dataset.origin = message.direction === "in" ? "peer" : String(message.origin ?? "unknown");
      origin.textContent = messageSourceLabel(message);
      const clock = element("span");
      clock.textContent = messageClock(message.createdAt);
      meta.append(origin, clock);
      if (message.direction === "out") {
        const status = element("span", "rm-message-status");
        status.dataset.tone = deliveryStatusTone(message.deliveryStatus);
        status.textContent = deliveryStatusText(message);
        meta.append(status);
      }
      row.append(line, meta);
      if (message.direction === "out" && message.deliveryError && ["failed", "pending", "unknown"].includes(String(message.deliveryStatus))) {
        const tech = element("button", "rm-detail-link rm-message-tech");
        tech.type = "button";
        tech.dataset.messageAction = "detail";
        tech.textContent = "投递技术详情";
        tech.setAttribute("aria-haspopup", "dialog");
        tech.setAttribute("aria-controls", "technicalDialog");
        tech.onclick = (event) => openMessageDetail(message, event.currentTarget);
        row.append(tech);
      }
      const actions = element("div", "rm-message-actions");
      if (isCancelable(message) && cancelsCapable) {
        const cancel = element("button", "rm-quiet");
        cancel.type = "button";
        cancel.dataset.messageAction = "cancel";
        cancel.textContent = cancellingIds.has(message.messageId) ? "正在取消…" : "取消待发";
        cancel.setAttribute("aria-disabled", String(cancellingIds.has(message.messageId)));
        cancel.onclick = () => {
          void cancelPendingMessage(message);
        };
        actions.append(cancel);
      }
      if (message.direction === "out" && String(message.deliveryStatus) === "failed") {
        const retry = element("button", "rm-quiet");
        retry.type = "button";
        retry.dataset.messageAction = "reedit";
        retry.textContent = "重新编辑";
        retry.title = "把这条失败消息放回输入框；再次发送会创建一条新消息";
        retry.onclick = () => restoreMessageText(message);
        actions.append(retry);
      }
      if (actions.childElementCount > 0) row.append(actions);
      return row;
    }
    async function cancelPendingMessage(message) {
      if (!cancelsCapable || cancellingIds.has(message.messageId)) return;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      const activeBefore = root.activeElement;
      const rowSelector = `[data-message-id="${selectorValue(message.messageId)}"]`;
      const restoreRowFocus = activeBefore === messageList.querySelector(rowSelector) || Boolean(activeBefore?.closest?.(rowSelector));
      const activeTask = taskFor(peerId2);
      const taskRequestId = activeTask && taskMatchesMessage(activeTask, message) ? activeTask.requestId : "";
      cancellingIds.add(message.messageId);
      setComposerNotice(peerId2, "正在取消这条待发消息…", "pending", "", { taskRequestId, kind: "cancel-progress" });
      renderMessageList();
      try {
        const value = await options.onCancelOutbox(peerId2, message.messageId);
        if (destroyed || contactsState.selectedPeerId !== peerId2) return;
        if (value && value.ok === true) {
          const current = taskFor(peerId2);
          if (current && taskMatchesMessage(current, message)) {
            current.unknown = false;
            current.outcomeStatus = "cancelled";
            current.outcome = sendOutcome({ ok: true, deliveryStatus: "cancelled" });
            if (!current.messageId) current.messageId = message.messageId;
          }
          setComposerNotice(peerId2, "已取消这条待发消息；不会再自动重试。", "muted", "", { taskRequestId, kind: "cancel-success" });
        } else {
          setComposerNotice(
            peerId2,
            "取消没有完成；这条消息可能仍会继续自动重试。",
            "error",
            typeof value?.error === "string" ? value.error : "",
            { taskRequestId, kind: "cancel-failure" }
          );
        }
      } catch (error) {
        if (!destroyed && contactsState.selectedPeerId === peerId2) {
          setComposerNotice(
            peerId2,
            "取消没有完成；这条消息可能仍会继续自动重试。",
            "error",
            errorText(error),
            { taskRequestId, kind: "cancel-failure" }
          );
        }
      } finally {
        cancellingIds.delete(message.messageId);
        if (!destroyed) {
          if (restoreRowFocus) chat.focusMessageId = message.messageId;
          renderMessageList();
          requestMessages(peerId2, true);
        }
      }
    }
    function restoreMessageText(message) {
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      if (messageInput.value.trim().length > 0) {
        setComposerNotice(peerId2, "输入框里已有新内容，未覆盖。再次发送会创建一条新消息。", "muted");
        focusMessageInput();
        return;
      }
      messageInput.value = message.text;
      persistDraft(peerId2, messageInput.value);
      updateComposerMeta();
      setComposerNotice(peerId2, "已放回输入框。再次发送会创建一条新消息，不会复用之前的消息 ID。", "muted");
      focusMessageInput();
    }
    function newRequestId() {
      const crypto = win.crypto ?? globalThis.crypto;
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
      return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
    function taskFor(peerId2) {
      return sendTasks.get(peerId2) ?? null;
    }
    const TERMINAL_DELIVERY_STATUSES = /* @__PURE__ */ new Set(["acked", "failed", "cancelled"]);
    function deliveryStatusOf(message) {
      return String(message?.deliveryStatus ?? (message?.acked ? "acked" : "unknown"));
    }
    function messageForTask(task) {
      if (!task || task.peerId !== contactsState.selectedPeerId) return null;
      const rows = Array.isArray(chat.items) ? chat.items : [];
      if (task.requestId) {
        const byRequest = rows.find((row) => row && row.peerId === task.peerId && row.direction === "out" && row.clientRequestId && row.clientRequestId === task.requestId);
        if (byRequest) return byRequest;
      }
      if (task.messageId) {
        return rows.find((row) => row && row.peerId === task.peerId && row.direction === "out" && row.messageId === task.messageId) ?? null;
      }
      return null;
    }
    function taskMatchesMessage(task, message) {
      if (!task || !message || message.peerId !== task.peerId) return false;
      if (task.requestId && message.clientRequestId && message.clientRequestId === task.requestId) return true;
      return Boolean(task.messageId && message.messageId && message.messageId === task.messageId);
    }
    function applyPersistedTaskState(task, found) {
      if (!task || !found) return false;
      const status = deliveryStatusOf(found);
      const previous = String(task.outcomeStatus ?? "");
      const terminal = TERMINAL_DELIVERY_STATUSES.has(status);
      if (!terminal && status !== "pending" && !(status === "unknown" && task.unknown)) return false;
      if (!terminal && previous === status) return false;
      if (TERMINAL_DELIVERY_STATUSES.has(previous) && !terminal) return false;
      const error = typeof found.deliveryError === "string" ? found.deliveryError : "";
      task.outcome = sendOutcome({
        ok: true,
        replayed: false,
        deliveryStatus: status,
        acked: found.acked === true || status === "acked",
        error
      });
      task.outcomeStatus = status;
      task.unknown = false;
      if (!task.messageId) task.messageId = String(found.messageId ?? "");
      if (!terminal) return true;
      if (composerNotice && composerNotice.peerId === task.peerId && composerNotice.taskRequestId === task.requestId && (composerNotice.kind === "cancel-progress" || composerNotice.kind === "cancel-success" && status !== "cancelled" || composerNotice.kind === "cancel-failure" && status === "acked")) {
        composerNotice = null;
      }
      return true;
    }
    function normalizedDiagnostic(value) {
      return String(value ?? "").trim().replace(/^dial for outbox:\s*/i, "");
    }
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
    function composerDetailForTask(task) {
      const detail = composerDetailText.trim();
      if (!detail) return "";
      const found = messageForTask(task);
      const persisted = typeof found?.deliveryError === "string" ? found.deliveryError.trim() : "";
      if (persisted && sameDiagnostic(detail, persisted)) return "";
      return detail;
    }
    function updateComposerOverlay() {
      const hasStatus = composerStatus.textContent.trim().length > 0;
      composerStatus.hidden = !hasStatus;
      const hasTech = !composerTech.hidden;
      const hasActions = !composerActions.hidden;
      const wasHidden = composerOverlay.hidden;
      const wasAtBottom = !messageList.hidden && isMessageListAtBottom();
      composerOverlay.hidden = composer.hidden || !(hasStatus || hasTech || hasActions);
      if (wasHidden && !composerOverlay.hidden && wasAtBottom) scrollMessagesToBottom();
    }
    function updateComposerDetail(task = null) {
      const value = task ?? (contactsState.selectedPeerId ? taskFor(contactsState.selectedPeerId) : null);
      composerTech.hidden = composerDetailForTask(value).length === 0;
      updateComposerOverlay();
    }
    function applyComposerStatus(text4, tone = "", detail = "") {
      const value = String(text4 || "");
      composerStatus.textContent = value;
      if (tone) composerStatus.dataset.tone = tone;
      else composerStatus.removeAttribute("data-tone");
      composerDetailText = typeof detail === "string" ? detail.trim() : "";
      updateComposerDetail();
    }
    function setComposerNotice(peerId2, text4, tone = "", detail = "", meta = {}) {
      composerNotice = {
        peerId: peerId2,
        text: String(text4 || ""),
        tone,
        detail: String(detail || ""),
        taskRequestId: String(meta.taskRequestId || ""),
        kind: String(meta.kind || "")
      };
      if (contactsState.selectedPeerId === peerId2) {
        applyComposerStatus(composerNotice.text, tone, composerNotice.detail);
      }
    }
    function openTechnicalDetail({ title, intro, raw, trigger = null, messageId: messageId2 = "" }) {
      const text4 = String(raw || "").trim();
      if (!text4) return;
      technicalHeading.textContent = String(title || "技术详情");
      technicalIntro.textContent = String(intro || "");
      technicalIntro.hidden = technicalIntro.textContent.length === 0;
      technicalRaw.textContent = text4;
      technicalRaw.scrollTop = 0;
      if (technicalRaw.setSelectionRange) technicalRaw.setSelectionRange(0, 0);
      technicalReturn = { messageId: String(messageId2 || "") };
      openDialog(technicalDialog, trigger ?? root.activeElement ?? doc.activeElement);
    }
    function openComposerDetail() {
      const peerId2 = contactsState.selectedPeerId;
      const task = peerId2 ? taskFor(peerId2) : null;
      const detail = composerDetailForTask(task);
      if (!detail) return;
      openTechnicalDetail({
        title: "发送技术详情",
        intro: "最近一次发送的原始错误。它只用于排查本机投递尝试；当前投递状态以上方状态和对应消息为准。",
        raw: detail,
        trigger: composerTech
      });
    }
    function openMessageDetail(message, trigger) {
      const detail = typeof message?.deliveryError === "string" ? message.deliveryError.trim() : "";
      if (!detail) return;
      const status = deliveryStatusText(message);
      openTechnicalDetail({
        title: "投递技术详情",
        intro: `这条消息在本机记录的状态：${status}。原始错误只说明本机投递尝试，不代表对端已经收到或没有收到。`,
        raw: detail,
        trigger,
        messageId: String(message.messageId || "")
      });
    }
    function technicalFocusFallback() {
      const messageId2 = technicalReturn?.messageId;
      if (messageId2) {
        const row = messageList.querySelector(`[data-message-id="${selectorValue(messageId2)}"]`);
        const action2 = row?.querySelector('[data-message-action="detail"]');
        if (action2) return action2;
        if (row) return row;
      }
      return composerTech.hidden ? null : composerTech;
    }
    function updateComposerMeta() {
      if (destroyed) return;
      const limit = Number(nodeState.status?.maxChatTextBytes) > 0 ? Number(nodeState.status.maxChatTextBytes) : 4096;
      const bytes = countTextBytes(messageInput.value);
      const over = bytes > limit;
      messageCounter.textContent = over ? `${bytes} / ${limit} 字节 · 超过上限` : `${bytes} / ${limit} 字节`;
      messageCounter.dataset.over = String(over);
      messageCounter.hidden = bytes === 0 && !over;
      const peerId2 = contactsState.selectedPeerId;
      const task = peerId2 ? taskFor(peerId2) : null;
      const empty = messageInput.value.trim().length === 0;
      messageSend.setAttribute("aria-disabled", String(Boolean(task?.sending) || over || empty || !sendsCapable));
      messageSend.title = !sendsCapable ? "发送暂不可用" : task?.sending ? "正在发送…" : over ? "消息超过节点字节限制" : empty ? "请输入消息" : "发送消息";
      sendReconcile.hidden = !(task && task.unknown && !task.sending && sendsCapable);
      sendRestore.hidden = !(task && !task.sending && task.outcome?.tone === "error" && task.outcome?.title === "发送失败");
      sendRestore.textContent = task?.sending ? "正在重试…" : "重试发送";
      composerActions.hidden = sendReconcile.hidden && sendRestore.hidden;
      updateComposerDetail(task);
    }
    function renderComposer() {
      if (destroyed) return;
      updateComposerMeta();
      const peerId2 = contactsState.selectedPeerId;
      composer.hidden = !sendsCapable;
      const task = peerId2 ? taskFor(peerId2) : null;
      if (composerNotice && composerNotice.peerId === peerId2) {
        applyComposerStatus(composerNotice.text, composerNotice.tone, composerNotice.detail);
      } else if (task?.sending) {
        applyComposerStatus("正在发送…", "pending", "");
      } else if (task?.outcome) {
        applyComposerStatus(
          `${task.outcome.title}。${task.outcome.body || ""}`,
          task.outcome.tone,
          task.outcome.detail || ""
        );
      } else {
        applyComposerStatus("", "", "");
      }
      updateComposerOverlay();
    }
    function selectedDraftValue(peerId2) {
      return contactsState.selectedPeerId === peerId2
        ? messageInput.value
        : readDraft(view, draftKeyFor(peerId2));
    }
    /** Restore a failed send only into that same conversation, never the
     * currently visible editor and never over a newer draft. */
    function restoreFailedSendDraft(peerId2, text4) {
      if (!peerId2 || !text4) return;
      if (selectedDraftValue(peerId2).length > 0) return;
      if (contactsState.selectedPeerId === peerId2) messageInput.value = text4;
      persistDraft(peerId2, text4);
    }
    function clearSuccessfulSendDraft(peerId2, text4) {
      if (!peerId2) return;
      if (contactsState.selectedPeerId === peerId2) {
        if (messageInput.value !== text4) return;
        messageInput.value = "";
        persistDraft(peerId2, "");
        return;
      }
      if (readDraft(view, draftKeyFor(peerId2)) === text4) persistDraft(peerId2, "");
    }
    function validateMessage(text4) {
      if (text4.trim().length === 0) return "请输入消息。";
      const limit = Number(nodeState.status?.maxChatTextBytes) > 0 ? Number(nodeState.status.maxChatTextBytes) : 4096;
      const bytes = countTextBytes(text4);
      if (bytes > limit) return `消息太长了：${bytes} 字节，当前节点上限 ${limit} 字节。请缩短后再发送。`;
      return "";
    }
    async function submitMessage({ reconcile = false, retry = false } = {}) {
      if (destroyed || !sendsCapable) return;
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      let task = taskFor(peerId2);
      if (task?.sending) return;
      let text4;
      let requestId;
      const retryingFailed = retry === true && task?.outcome?.title === "发送失败";
      if (reconcile) {
        if (!task || !task.unknown || task.sending) return;
        text4 = task.text;
        requestId = task.requestId;
      } else if (retryingFailed) {
        text4 = task.text;
        requestId = task.requestId;
      } else {
        text4 = messageInput.value;
        const invalid = validateMessage(text4);
        if (invalid) {
          setComposerNotice(peerId2, invalid, "error");
          focusMessageInput();
          updateComposerMeta();
          return;
        }
        requestId = newRequestId();
        if (messageInput.value === text4) {
          messageInput.value = "";
          persistDraft(peerId2, "");
        }
      }
      if (!text4.trim() || !requestId) return;
      const attempt = ++sendSeq;
      task = {
        peerId: peerId2,
        text: text4,
        requestId,
        messageId: "",
        attempt,
        sending: true,
        unknown: false,
        outcome: null,
        outcomeStatus: ""
      };
      sendTasks.set(peerId2, task);
      composerNotice = null;
      updateComposerMeta();
      renderComposer();
      let result;
      try {
        result = await options.onSend(peerId2, text4, requestId);
      } catch (error) {
        result = {
          ok: false,
          unknown: true,
          invalid: false,
          error: "这次发送没有收到节点结果，消息可能已经保存。请先核对，不要直接重发。",
          detail: errorText(error)
        };
      }
      if (destroyed) return;
      const current = taskFor(peerId2);
      if (!current || current.attempt !== attempt) return;
      current.sending = false;
      if (!result || typeof result !== "object") {
        result = { ok: false, unknown: true, error: "没有收到发送结果。" };
      }
      current.messageId = String(result.messageId ?? current.messageId ?? "");
      const resultStatus = String(result.deliveryStatus ?? (result.unknown === true ? "unknown" : "unknown"));
      const keepTerminal = TERMINAL_DELIVERY_STATUSES.has(String(current.outcomeStatus ?? "")) && !TERMINAL_DELIVERY_STATUSES.has(resultStatus);
      if (result.invalid || result.ok !== true && result.unknown !== true) {
        current.unknown = false;
        current.outcome = sendOutcome(result);
        current.outcomeStatus = "";
        // The editor may now show another conversation or a newer draft in
        // this one. Keep the failed body in its original conversation draft.
        restoreFailedSendDraft(peerId2, current.text);
      } else if (result.ok !== true) {
        current.unknown = !keepTerminal;
        if (!keepTerminal) {
          current.outcome = sendOutcome(result);
          current.outcomeStatus = "unknown";
        }
      } else {
        current.unknown = false;
        markHumanOutboundPersisted();
        if (!keepTerminal) {
          current.outcome = sendOutcome(result);
          current.outcomeStatus = resultStatus;
        }
        if (retryingFailed && resultStatus !== "failed") {
          clearSuccessfulSendDraft(peerId2, current.text);
        }
        if (!keepTerminal && resultStatus === "failed") {
          restoreFailedSendDraft(peerId2, current.text);
        }
      }
      // Never clear a notice that belongs to the conversation now on screen.
      if (composerNotice === null || composerNotice.peerId === peerId2) composerNotice = null;
      if (contactsState.selectedPeerId === peerId2) {
        renderComposer();
        keepComposerFocus();
      }
      updateComposerMeta();
      if (contactsState.selectedPeerId === peerId2) requestMessages(peerId2, true);
    }
    function retryFailedSend() {
      const peerId2 = contactsState.selectedPeerId;
      const task = peerId2 ? taskFor(peerId2) : null;
      if (!peerId2 || !task || task.sending || task.outcome?.title !== "发送失败") return;
      if (messageInput.value.trim().length === 0) {
        messageInput.value = task.text;
        persistDraft(peerId2, messageInput.value);
      }
      void submitMessage({ retry: true });
    }
    function conversationStateText(state) {
      return conversationStatusLabel(state);
    }
    function fillConversationRow(row, item) {
      const peerId2 = item.peerId;
      row.dataset.conversationRow = peerId2;
      row.className = "rm-conversation rm-conversation-row";
      const friend = item.friend;
      const name = friend ? contactDisplayName(friend) : shortPeer(peerId2);
      const summary = conversationSummaryText(item);
      const status = conversationStatusLabel(item);
      const avatar = row.querySelector(":scope > button[data-profile-peer]") ?? element("button", "rm-contact-avatar rm-avatar-button");
      avatar.type = "button";
      avatar.dataset.profilePeer = peerId2;
      avatar.dataset.profileRef = `messages:${peerId2}`;
      avatar.dataset.focusKey = `conversation-avatar:${peerId2}`;
      avatar.setAttribute("aria-label", `查看 ${name} 的档案`);
      avatar.textContent = friend ? contactInitial(friend) : "?";
      const main = row.querySelector(":scope > button[data-conversation-peer]") ?? element("button", "rm-conversation-main");
      main.type = "button";
      main.dataset.conversationPeer = peerId2;
      main.dataset.focusKey = `conversation:${peerId2}`;
      main.setAttribute("aria-label", `${name}。${summary}。${status}。打开会话`);
      const copy = element("span", "rm-conversation-copy");
      const top = element("span", "rm-conversation-top");
      const title = element("b");
      title.textContent = name;
      const time = element("span", "rm-conversation-time");
      time.textContent = item.hasMessages ? messageTimeText(item.lastAt) : "";
      const unread = Math.max(0, Number(item.unreadCount) || 0);
      if (unread > 0) {
        const unreadBadge = element("span", "rm-conversation-unread");
        unreadBadge.textContent = unread > 99 ? "99+" : String(unread);
        unreadBadge.setAttribute("aria-label", `${unread} 条未读`);
        time.append(" ", unreadBadge);
      }
      top.append(title, time);
      const preview = element("span", "rm-conversation-preview");
      preview.textContent = summary;
      const meta = element("span", "rm-conversation-meta");
      const id = element("code", "rm-peer-id");
      id.textContent = shortPeer(peerId2);
      id.title = peerId2;
      const badge = element("span", "rm-conversation-status");
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
      return element("div", "rm-conversation");
    }
    function reconcileConversationList(items) {
      const active = root.activeElement;
      const activeRow = active?.closest?.("[data-conversation-row]") ?? null;
      const activePeer = activeRow?.dataset.conversationRow ?? "";
      const activeWasAvatar = Boolean(active?.dataset?.profilePeer);
      const rowsBefore = [...conversationList.querySelectorAll("[data-conversation-row]")];
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
      const rowsAfter = [...conversationList.querySelectorAll("[data-conversation-row]")];
      const target = activePeer ? rowsAfter.find((row) => row.dataset.conversationRow === activePeer) : null;
      if (target) {
        const focusTarget = activeWasAvatar ? target.querySelector("button[data-profile-peer]") : target.querySelector("button[data-conversation-peer]");
        if (focusTarget && root.activeElement !== focusTarget) focusTarget.focus({ preventScroll: true });
      } else if (activeRow) {
        const fallback = rowsAfter[Math.min(Math.max(activeIndex, 0), rowsAfter.length - 1)] ?? null;
        (fallback?.querySelector("button[data-conversation-peer]") ?? conversationQuery).focus({ preventScroll: true });
      }
      if (conversationList.scrollTop !== listScroll) conversationList.scrollTop = listScroll;
      if (pageEls.messages.scrollTop !== pageScroll) pageEls.messages.scrollTop = pageScroll;
    }
    function showConversationState(kind, { title, body, primary = null, retry = false, stale = false }) {
      messagesStateSection.hidden = false;
      messagesStateSection.dataset.tone = kind === "error" ? "error" : "unavailable";
      $("#messagesStateTitle").textContent = title;
      $("#messagesStateBody").textContent = body;
      const action2 = $("#messagesStateAction");
      action2.hidden = primary === null;
      action2.textContent = primary?.label ?? "";
      action2.onclick = primary === null ? null : primary.run;
      const retryEl = $("#messagesStateRetry");
      retryEl.hidden = retry !== true;
      retryEl.textContent = conversationsRetrying ? "正在重试…" : "重试读取";
      retryEl.onclick = retry ? retryConversations : null;
      conversationList.hidden = true;
      conversationsMeta.hidden = true;
      conversationsMetaRetry.hidden = true;
      if (stale) {
        conversationsMeta.hidden = false;
        conversationsMeta.textContent = "下面是上次成功读取的结果，可能不是最新。";
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
        contactsError: contactsState.transportError
      });
      if (state.kind === "ready") {
        const active = root.activeElement;
        const inState = messagesStateSection.contains(active);
        messagesStateSection.hidden = true;
        conversationList.hidden = false;
        reconcileConversationList(state.items);
        const staleText = state.error ? `最近消息可能不是最新（${state.at > 0 ? formatRelative(state.at) : "读取时间未知"}）。最近一次读取失败，可以重试。` : state.stale ? `会话可能不是最新（${state.at > 0 ? formatRelative(state.at) : "读取时间未知"}）。实时更新恢复后会自动刷新。` : "";
        conversationsMeta.textContent = staleText;
        conversationsMeta.hidden = staleText.length === 0;
        conversationsMetaRetry.hidden = !(staleText && conversationsCapable);
        conversationsMetaRetry.textContent = conversationsRetrying ? "正在重试…" : "重试读取";
        conversationsMetaRetry.onclick = conversationsCapable ? retryConversations : null;
        if (inState) (conversationList.querySelector("button[data-conversation-peer]") ?? conversationQuery).focus({ preventScroll: true });
        return;
      }
      conversationList.replaceChildren();
      if (state.kind === "search-empty") {
        showConversationState("search-empty", {
          title: "没有找到匹配的会话",
          body: `没有联系人或消息匹配“${query.trim()}”。`,
          primary: { label: "清除搜索", run: clearConversationSearch },
          retry: state.stale,
          stale: state.stale
        });
        return;
      }
      if (state.kind === "loading") {
        showConversationState("loading", {
          title: "正在读取对话…",
          body: "正在从本机节点读取当前保留的会话和消息记录。"
        });
        return;
      }
      if (state.kind === "error") {
        showConversationState("error", {
          title: "这次没有读到对话",
          body: `${state.error || "会话列表读取失败。"}
这不代表没有对话；可以重试读取。`,
          primary: conversationsCapable ? { label: conversationsRetrying ? "正在重试…" : "重试读取", run: retryConversations } : null,
          retry: false,
          stale: state.at > 0
        });
        return;
      }
      showConversationState("empty", {
        title: "还没有会话",
        body: "打开联系人就可以开始对话，不需要先有消息记录。",
        primary: { label: "去联系人", run: () => {
          showPage("contacts");
          contactQuery.focus({ preventScroll: true });
        } },
        retry: state.stale && conversationsCapable,
        stale: state.stale
      });
    }
    function clearConversationSearch() {
      conversationQuery.value = "";
      view.pages.messages.query = "";
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
      void Promise.resolve(pending).catch((error) => {
        if (!destroyed) setConversationsError(error);
      }).finally(() => {
        if (destroyed) return;
        conversationsRetrying = false;
        updateConversationIndexState();
      });
    }
    function setConversations(value) {
      if (destroyed || value === null || typeof value !== "object") return;
      const previousAt = Number(conversationsState.data?.at) > 0 ? Number(conversationsState.data.at) : 0;
      const nextAt = Number(value.at) > 0 ? Number(value.at) : 0;
      if (nextAt > 0 && previousAt > 0 && nextAt < previousAt) return;
      conversationsState.data = value;
      conversationsState.transportError = "";
      refreshUnreadBadges();
      updateConversationIndexState();
      updateContactsState();
    }
    function setConversationsError(error) {
      if (destroyed) return;
      conversationsState.transportError = errorText(error) || "会话列表读取失败";
      updateConversationIndexState();
    }
    function hideAddFeedback() {
      addContactFeedback.hidden = true;
      addContactFeedbackContact.hidden = true;
      addContactFeedbackStatus.hidden = true;
      addContactFeedbackDetail.hidden = true;
      addContactCheck.hidden = true;
    }
    function showAddFeedback(view2) {
      addContactFeedback.hidden = false;
      addContactFeedback.dataset.tone = view2.tone || "partial";
      addContactFeedbackTitle.textContent = view2.title || "连接结果";
      addContactFeedbackBody.textContent = view2.body || "";
      addContactFeedbackContact.hidden = !view2.contactNote;
      addContactFeedbackContact.textContent = view2.contactNote || "";
      addContactFeedbackStatus.hidden = !view2.statusNote;
      addContactFeedbackStatus.textContent = view2.statusNote || "";
      addContactFeedbackDetail.hidden = !view2.detail;
      addContactFeedbackRaw.textContent = view2.detail || "";
      addContactCheck.hidden = view2.showCheck !== true;
      addContactCheck.removeAttribute("aria-disabled");
      addContactCheck.textContent = "重试核对联系人";
      addContactView.hidden = view2.showViewContacts !== true;
    }
    function nextAddContactAction() {
      if (!addContactView.hidden) return addContactView;
      if (!addContactCheck.hidden) return addContactCheck;
      if (!addContactSubmit.hidden) return addContactSubmit;
      return addContactInput;
    }
    function restoreAddContactFocus(view2) {
      if (destroyed || !addContactDialog.open) return;
      const active = root.activeElement;
      const lost = active === null || active === doc.body;
      if (view2.tone === "invalid") {
        if (lost || active === addContactSubmit || active === addContactCheck) {
          addContactInput.focus({ preventScroll: true });
        }
        return;
      }
      const hidden = active === addContactSubmit && addContactSubmit.hidden || active === addContactCheck && addContactCheck.hidden;
      if (!lost && !hidden) return;
      nextAddContactAction().focus({ preventScroll: true });
    }
    function setAddContactBusy(busy) {
      addContactPending = busy;
      addContactInput.readOnly = busy;
      if (busy) {
        addContactSubmit.setAttribute("aria-disabled", "true");
      } else {
        addContactSubmit.removeAttribute("aria-disabled");
      }
    }
    function resetAddContact({ keepInput = false } = {}) {
      addAttempt += 1;
      checkAttempt += 1;
      addContactPeerId = "";
      addContactPending = false;
      checkPending = false;
      if (!keepInput) addContactInput.value = "";
      addContactInput.disabled = false;
      addContactInput.readOnly = false;
      addContactSubmit.hidden = false;
      addContactSubmit.disabled = false;
      addContactSubmit.removeAttribute("aria-disabled");
      addContactSubmit.textContent = "连接";
      addContactCheck.disabled = false;
      addContactCheck.removeAttribute("aria-disabled");
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
          tone: "invalid",
          title: "请输入 Peer ID 或完整节点地址",
          body: "请先填写 Peer ID 或完整节点地址。"
        });
        addContactInput.focus();
        return;
      }
      if (typeof options.onConnect !== "function") {
        showAddFeedback({
          tone: "error",
          title: "现在还不能连接联系人",
          body: "这个入口暂时无法发起连接，请稍后再试。"
        });
        return;
      }
      const attempt = ++addAttempt;
      addContactPeerId = "";
      setAddContactBusy(true);
      addContactSubmit.textContent = "正在连接…";
      addContactView.hidden = true;
      addContactCheck.hidden = true;
      addContactFeedback.hidden = false;
      addContactFeedback.dataset.tone = "info";
      addContactFeedbackTitle.textContent = "正在连接…";
      addContactFeedbackBody.textContent = "正在等待节点返回结果。这可能需要一些时间。";
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
      // Hosts that return the post-connect contact snapshot update the list now,
      // instead of relying on a later poll before "查看联系人" can find the row.
      if (result?.contacts) setContacts(result.contacts);
      const view2 = connectOutcome(result);
      setAddContactBusy(false);
      if (result?.ok === true) {
        addContactPeerId = String(result.peerId ?? "");
        addContactInput.readOnly = true;
        addContactSubmit.hidden = true;
        addContactInput.disabled = false;
      } else {
        addContactInput.disabled = false;
        addContactInput.readOnly = false;
        addContactSubmit.textContent = view2.showRetry ? "重试连接" : "连接";
      }
      showAddFeedback(view2);
      restoreAddContactFocus(view2);
    }
    async function checkContactAgain() {
      if (!addContactPeerId || checkPending || typeof options.onCheckContact !== "function") return;
      const attempt = ++checkAttempt;
      checkPending = true;
      addContactCheck.setAttribute("aria-disabled", "true");
      addContactCheck.textContent = "正在核对…";
      let result;
      try {
        result = await options.onCheckContact(addContactPeerId);
      } catch (error) {
        result = { ok: false, error: errorText(error) };
      }
      if (destroyed || attempt !== checkAttempt || !addContactDialog.open) return;
      checkPending = false;
      addContactCheck.removeAttribute("aria-disabled");
      if (result && result.contacts) setContacts(result.contacts);
      const view2 = contactCheckOutcome(result);
      showAddFeedback(view2);
      addContactView.hidden = view2.showViewContacts !== true;
      addContactCheck.hidden = view2.showViewContacts === true;
      restoreAddContactFocus(view2);
    }
    function viewNewContact() {
      const peerId2 = addContactPeerId;
      closeDialog(addContactDialog, { restoreFocus: false });
      contactQuery.value = "";
      view.pages.contacts.query = "";
      // "查看联系人" is an explicit jump to the newly added row. A new contact
      // often has no unread messages, so keeping the previous unread-only filter
      // would hide exactly the row the user asked to see. Only this navigation
      // resets the filter; ordinary filter switches stay untouched.
      view.pages.contacts.filter = "all";
      showPage("contacts");
      updateContactsState();
      saveNow();
      const row = contactList.querySelector(`button[data-contact-peer="${selectorValue(peerId2)}"]`);
      if (row) {
        row.scrollIntoView?.({ block: "nearest" });
        row.focus({ preventScroll: true });
      } else {
        (contactList.querySelector("button[data-contact-peer]") ?? $("#addContact")).focus({ preventScroll: true });
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
      shareManual.value = "";
      shareCopyStatus.textContent = "";
      shareCopyStatus.dataset.tone = "";
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
      shareCopyStatus.textContent = "";
      shareCopyStatus.dataset.tone = "";
      shareCopy.disabled = true;
      shareRetry.hidden = true;
      let result;
      try {
        result = typeof options.onShare === "function" ? await options.onShare() : { ok: false, error: "分享信息暂时不可用。" };
      } catch (error) {
        result = { ok: false, error: errorText(error) };
      }
      if (destroyed || attempt !== shareAttempt || !shareDialog.open) return;
      if (!result || result.ok !== true) {
        shareLoading.hidden = true;
        shareContent.hidden = true;
        shareFailure.hidden = false;
        shareFailure.dataset.tone = "error";
        shareFailureBody.textContent = "这次没有读到本机节点信息，请稍后重试。";
        shareFailureRaw.textContent = String(result?.error || "节点没有返回可读的错误。");
        shareFailureDetail.hidden = false;
        shareRetry.hidden = false;
        shareCopy.disabled = true;
        return;
      }
      currentShare = result;
      shareLoading.hidden = true;
      shareContent.hidden = false;
      sharePeerId.textContent = String(result.peerId || "");
      shareAddresses.replaceChildren();
      const addresses = Array.isArray(result.addresses) ? result.addresses : [];
      for (const address of addresses) {
        const item = element("div", "rm-share-address");
        const code = element("code");
        code.textContent = String(address.multiaddr || "");
        const scope = element("span");
        scope.textContent = addressScopeText(address);
        item.append(code, scope);
        shareAddresses.append(item);
      }
      if (addresses.length === 0) {
        shareAddressNote.textContent = "没有可直接分享的地址。你仍然可以复制 Peer ID；对方可能需要通过地址发现来连接。";
        shareAddressNote.hidden = false;
      } else {
        shareAddressNote.textContent = "这些地址来自本机公告信息。对方能否连接受网络环境影响，私网地址通常只适合同一局域网。";
        shareAddressNote.hidden = false;
      }
      if (result.stale) {
        const reason = String(result.error || "").trim();
        const streamOnly = /实时更新/.test(reason);
        shareStaleNote.textContent = streamOnly
          ? `这是 ${refreshedText(result.at)} 成功读取的节点信息；实时更新尚未恢复，可能不是最新。可以在弹窗内重试。`
          : reason
            ? `这是 ${refreshedText(result.at)} 成功读取的节点信息；最近一次刷新失败，可能不是最新。可以在弹窗内重试。`
            : `这是 ${refreshedText(result.at)} 成功读取的节点信息，可能不是最新。可以在弹窗内重试。`;
        shareStaleNote.hidden = false;
        shareRetry.hidden = false;
      } else {
        shareStaleNote.hidden = true;
        shareRetry.hidden = true;
      }
      shareCopy.disabled = String(result.peerId || "").length === 0;
    }
    async function copyShareInfo() {
      const text4 = buildShareText(currentShare);
      if (text4.length === 0) return;
      shareCopy.disabled = true;
      try {
        if (typeof options.onCopyText !== "function") throw new Error("复制能力不可用");
        const copied = await options.onCopyText(text4);
        if (copied === false) throw new Error("复制能力不可用");
        shareCopyStatus.textContent = "已复制。粘贴给对方即可。";
        shareCopyStatus.dataset.tone = "";
        shareManual.hidden = true;
      } catch {
        shareCopyStatus.textContent = "复制失败，请手动选择下面的内容。";
        shareCopyStatus.dataset.tone = "error";
        shareManual.value = text4;
        shareManual.hidden = false;
        shareManual.focus({ preventScroll: true });
        shareManual.select();
      } finally {
        shareCopy.disabled = !currentShare || String(currentShare.peerId || "").length === 0;
      }
    }
    function setContactFilter(filter) {
      view.pages.contacts.filter = filter === "unread" ? "unread" : "all";
      refreshUnreadBadges();
      updateContactsState();
      pageEls.contacts.scrollTop = 0;
      saveNow();
    }
    function setFilter(filter) {
      view.pages.explore.filter = filter === "familiar" || filter === "mine" ? filter : "all";
      $$("[data-filter]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.filter === view.pages.explore.filter));
      });
      updateExploreState();
      if (view.pages.explore.filter === "mine") {
        if (mineCapable && mineState.data === null) void loadMine(false);
      } else {
        ensureDiscoveriesFresh(false);
      }
      saveNow();
    }
    function updateExploreSearchState() {
      view.pages.explore.searchOpen = true;
      exploreSearch.hidden = false;
      if (exploreClear) exploreClear.hidden = exploreQuery.value.length === 0;
    }
    function clearExploreSearch({ focus = false } = {}) {
      exploreQuery.value = "";
      view.pages.explore.query = "";
      updateExploreSearchState();
      updateExploreState();
      saveNow();
      if (focus) exploreQuery.focus({ preventScroll: true });
    }
    function restoreControls() {
      exploreQuery.value = view.pages.explore.query;
      contactQuery.value = view.pages.contacts.query;
      conversationQuery.value = view.pages.messages.query;
      contactsState.selectedPeerId = view.pages.messages.peerId;
      const restoredReturnPage = contactsState.selectedPeerId && view.pages.messages.returnPeer === contactsState.selectedPeerId && ["contacts", "messages", "home", "settings", "journey", "profile"].includes(view.pages.messages.returnPage) && (view.pages.messages.returnPage !== "journey" || view.pages.messages.returnJourneyId.length > 0) && (view.pages.messages.returnPage !== "profile" || view.contactProfile.peerId === contactsState.selectedPeerId) ? view.pages.messages.returnPage : "";
      updateExploreSearchState();
      $$("[data-filter]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.filter === view.pages.explore.filter));
      });
      updateExploreState();
      updateContactsState();
      updateConversationIndexState();
      if (contactsState.selectedPeerId) {
        renderConversation();
        if (restoredReturnPage && chat.peerId === contactsState.selectedPeerId) {
          chat.returnPage = restoredReturnPage;
          chat.returnPeer = contactsState.selectedPeerId;
          chat.returnJourneyId = restoredReturnPage === "journey" ? view.pages.messages.returnJourneyId : "";
          chat.returnJourneyEvent = restoredReturnPage === "journey" ? view.pages.messages.returnJourneyEvent : 0;
          chat.returnJourneyMessage = restoredReturnPage === "journey" ? view.pages.messages.returnJourneyMessage : "";
          chat.returnProfileTab = restoredReturnPage === "profile" ? view.pages.messages.returnProfileTab : "interactions";
          chat.returnProfileScroll = restoredReturnPage === "profile" ? view.pages.messages.returnProfileScroll : 0;
          chat.returnFocus = ["contacts", "profile"].includes(restoredReturnPage) ? view.pages.messages.returnFocus : "";
          updateConversationBackLabel(contactsState.selectedPeerId);
        }
        pageEls.messages.scrollTop = 0;
      }
    }
    function openDialog(dialog, trigger) {
      if (destroyed || dialog.open) return;
      if (dialog !== editContactDialog) closeContactQuickMenu({ restoreFocus: false, quiet: true });
      dialogTriggers.set(dialog, trigger ?? root.activeElement ?? doc.activeElement);
      dialog.showModal();
      if (dialog === statusDialog) void loadBootstrap(false);
      dialog.querySelector("[data-close-dialog]")?.focus({ preventScroll: true });
    }
    function closeDialog(dialog, { restoreFocus = true } = {}) {
      if (!dialog.open) return;
      const trigger = dialogTriggers.get(dialog);
      const detailFallback = dialog === technicalDialog ? technicalFocusFallback() : null;
      const previewKey = dialog === imagePreviewDialog ? imagePreviewKey : "";
      dialog.close();
      dialogTriggers.delete(dialog);
      if (dialog === technicalDialog) technicalReturn = null;
      if (!restoreFocus) return;
      const triggerAvailable = Boolean(trigger?.isConnected && !trigger.closest?.("[hidden]"));
      const previewFallback = previewKey ? [...root.querySelectorAll("[data-post-image-key]")].find((node) => node.dataset.postImageKey === previewKey) ?? null : null;
      let target = triggerAvailable ? trigger : dialog === technicalDialog ? detailFallback?.isConnected ? detailFallback : messageInput.hidden ? null : messageInput : dialog === imagePreviewDialog && previewFallback?.isConnected ? previewFallback : null;
      if (target) {
        target.focus({ preventScroll: true });
        if (root.activeElement !== target) target = null;
      }
      if (!target) {
        root.querySelector("#nodeTrigger")?.focus({ preventScroll: true });
      }
    }
    function openNotice(title, body, note = "") {
      $("#noticeHeading").textContent = title;
      $("#noticeBody").textContent = body;
      noticeNote.textContent = note;
      noticeNote.hidden = note.length === 0;
      openDialog(noticeDialog, root.activeElement ?? doc.activeElement);
    }
    function requestRefresh({ visible = false } = {}) {
      if (destroyed) return;
      if (typeof options.onRefresh !== "function") {
        openNotice(
          "暂时不能刷新",
          "现在无法重新读取节点状态，请稍后再试。",
          "关闭后重新打开页面也可以重新读取。"
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
            "刷新没有完成",
            "这次没有读到新的节点状态，请稍后再试。",
            "如果问题持续，可以关闭后重新打开页面。"
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
      const label = `节点状态：${pill}。打开节点状态详情`;
      nodeTrigger.setAttribute("aria-label", label);
      nodeTrigger.title = label;
    }
    function statusSnapshotSummary() {
      const status = nodeState.status;
      if (!status) return "—";
      const summary = connectionSummary(status);
      return `${summary.connections} 条连接 · ${summary.peers} 个已连接节点`;
    }
    function bootstrapEntries() {
      const entries = Array.isArray(bootstrapState.data?.entries) ? bootstrapState.data.entries : [];
      if (entries.length > 0) return entries;
      // Older hosts expose only flat DhtStatus strings. Keep that view
      // readable without inventing saved/online state.
      return (Array.isArray(bootstrapState.data?.peers) ? bootstrapState.data.peers : []).map((value) => {
        const match = /\/p2p\/([^/]+)$/.exec(String(value));
        return { peerId: match ? match[1] : "", addrs: [String(value)], online: false, paused: false, savedAt: null };
      });
    }
    function bootstrapFeedback(text, tone = "") {
      bootstrapState.feedback = text;
      bootstrapState.feedbackTone = tone;
      statusBootstrapFeedback.textContent = text;
      statusBootstrapFeedback.dataset.tone = tone;
      statusBootstrapFeedback.hidden = text === "";
    }
    function updateBootstrapControls() {
      const data = bootstrapState.data;
      const editable = bootstrapCapable && bootstrapEditCapable && data?.editable === true && data?.requiresUpgrade !== true;
      statusBootstrapEdit.hidden = !editable;
      statusBootstrapAdd.disabled = bootstrapState.busy;
      statusBootstrapInput.disabled = bootstrapState.busy;
      statusBootstrapRefresh.disabled = bootstrapState.busy;
      statusBootstrapCopy.disabled = bootstrapState.busy || bootstrapEntries().every((entry) => entry.addrs.length === 0);
      statusBootstrap.dataset.busy = bootstrapState.busy ? "true" : "false";
      statusBootstrapUpgrade.hidden = data?.requiresUpgrade !== true;
      statusBootstrapUnavailable.hidden = bootstrapCapable;
      if (!editable && !bootstrapState.busy && statusBootstrapInput === root.activeElement) statusBootstrapRefresh.focus({ preventScroll: true });
    }
    async function loadBootstrap(force = false) {
      if (!bootstrapCapable || bootstrapState.request !== null) return;
      if (!force && bootstrapState.data !== null) return;
      const request = { force };
      bootstrapState.request = request;
      bootstrapState.busy = true;
      statusBootstrapNote.textContent = "正在读取引导节点设置…";
      statusBootstrapNote.dataset.tone = "";
      updateBootstrapControls();
      try {
        const value = await options.onLoadBootstrap();
        if (destroyed || bootstrapState.request !== request) return;
        bootstrapState.data = value;
        bootstrapState.error = value?.error || "";
      } catch (error) {
        if (destroyed || bootstrapState.request !== request) return;
        bootstrapState.data = null;
        bootstrapState.error = errorText(error) || "引导节点设置读取失败";
      } finally {
        if (bootstrapState.request === request) {
          bootstrapState.request = null;
          bootstrapState.busy = false;
        }
      }
      if (!destroyed) renderBootstrap();
    }
    function bootstrapPeerLabel(entry) {
      if (entry.online) return "已连接";
      if (entry.paused) return "已暂停（主动断开）";
      if (entry.addrs.length === 0) return "已保存 · 暂缺地址";
      return "已保存 · 暂未连通";
    }
    function renderBootstrap() {
      if (!bootstrapCapable) {
        statusBootstrapNote.textContent = "当前宿主没有提供引导节点管理。";
        statusBootstrapNote.dataset.tone = "unavailable";
        statusBootstrapList.replaceChildren();
        statusBootstrapFeedback.hidden = true;
        statusBootstrapCopy.disabled = true;
        statusBootstrapRefresh.hidden = true;
        statusBootstrapRefresh.disabled = true;
        statusBootstrapEdit.hidden = true;
        statusBootstrapUpgrade.hidden = true;
        statusBootstrapUnavailable.hidden = false;
        return;
      }
      statusBootstrapRefresh.hidden = false;
      const entries = bootstrapEntries();
      statusBootstrapList.replaceChildren();
      for (const entry of entries) {
        const item = element("li", "rm-address-item rm-bootstrap-item");
        item.dataset.bootstrapPeer = entry.peerId;
        const copy = element("div", "rm-bootstrap-copy");
        if (entry.addrs.length === 0) {
          const code = element("code");
          code.textContent = entry.peerId || "（地址不可用）";
          copy.append(code);
        } else {
          for (const addr of entry.addrs) {
            const code = element("code");
            code.textContent = addr;
            copy.append(code);
          }
        }
        const meta = element("span", "rm-bootstrap-state");
        meta.dataset.state = entry.online ? "online" : entry.paused ? "paused" : "saved";
        meta.textContent = bootstrapPeerLabel(entry);
        copy.append(meta);
        item.append(copy);
        if (bootstrapEditCapable && bootstrapState.data?.editable === true) {
          const remove = element("button", "rm-quiet");
          remove.type = "button";
          remove.dataset.bootstrapRemove = entry.peerId;
          remove.setAttribute("aria-label", `移除引导节点 ${entry.peerId}`);
          remove.textContent = "移除";
          remove.disabled = bootstrapState.busy;
          item.append(remove);
        }
        statusBootstrapList.append(item);
      }
      if (bootstrapState.error) {
        statusBootstrapNote.textContent = `引导节点设置读取失败：${bootstrapState.error}。`;
        statusBootstrapNote.dataset.tone = "error";
      } else if (bootstrapState.data === null) {
        statusBootstrapNote.textContent = "尚未读取。展开这项或点击刷新设置。";
        statusBootstrapNote.dataset.tone = "";
      } else if (entries.length === 0) {
        statusBootstrapNote.textContent = "尚未配置引导节点。保存一个 Raminga 节点地址后，DHT 会把它作为引导候选；保存不等于在线。";
        statusBootstrapNote.dataset.tone = "unavailable";
      } else {
        const at = bootstrapState.data.at ? ` · ${formatDateTime(bootstrapState.data.at)} 读取` : "";
        const online = entries.filter((entry) => entry.online).length;
        const paused = entries.filter((entry) => entry.paused).length;
        statusBootstrapNote.textContent = `已保存 ${entries.length} 个引导节点 · ${online} 个当前已连接${paused > 0 ? ` · ${paused} 个已主动断开` : ""}${at}。保存与在线分开显示。`;
        statusBootstrapNote.dataset.tone = "";
      }
      statusBootstrapNote.hidden = false;
      updateBootstrapControls();
    }
    async function addBootstrapPeer() {
      if (!bootstrapEditCapable || bootstrapState.busy) return;
      const value = statusBootstrapInput.value;
      if (value.trim() === "") {
        bootstrapFeedback("请填写包含 /p2p/<peer-id> 的节点地址。", "error");
        statusBootstrapInput.focus({ preventScroll: true });
        return;
      }
      bootstrapState.busy = true;
      let refocusInput = false;
      bootstrapFeedback("正在保存引导节点…");
      updateBootstrapControls();
      try {
        const result = await options.onAddBootstrap(value);
        if (destroyed) return;
        statusBootstrapInput.value = "";
        bootstrapFeedback(result?.changed === false
          ? "该地址已在引导节点列表中，未重复添加。"
          : "已保存引导节点；是否连通会在列表中单独更新。");
        await loadBootstrap(true);
      } catch (error) {
        if (destroyed) return;
        bootstrapFeedback(errorText(error) || "保存引导节点失败", "error");
        refocusInput = true;
      } finally {
        bootstrapState.busy = false;
        if (!destroyed) {
          updateBootstrapControls();
          if (refocusInput) statusBootstrapInput.focus({ preventScroll: true });
        }
      }
    }
    async function removeBootstrapPeer(peerId) {
      if (!bootstrapEditCapable || bootstrapState.busy || peerId === "") return;
      bootstrapState.busy = true;
      bootstrapFeedback("正在移除引导节点标记…");
      updateBootstrapControls();
      try {
        const result = await options.onRemoveBootstrap(peerId);
        if (destroyed) return;
        bootstrapFeedback(result?.changed === false
          ? "该引导节点已不在列表中。"
          : "已移除引导节点标记；Peer 地址、联系人和主动断开记录保留。");
        await loadBootstrap(true);
      } catch (error) {
        if (destroyed) return;
        bootstrapFeedback(errorText(error) || "移除引导节点失败", "error");
      } finally {
        bootstrapState.busy = false;
        if (!destroyed) updateBootstrapControls();
      }
    }
    function renderStatusDialog() {
      const status = nodeState.status;
      const phase = nodeState.phase;
      const statusAt = nodeState.statusAt;
      const fresh = nodeState.freshness;
      const rawError = [nodeState.error, nodeState.stream?.error].filter(Boolean).join(" · ");
      $("#statusPhase").textContent = nodePhaseText(phase);
      $("#statusDot").dataset.phase = phase;
      $("#statusDaemon").textContent = phase === "ready" ? "可访问" : phase === "stale" ? "可访问 · 更新中断" : phase === "error" ? "暂不可用" : phase === "closed" ? "更新已断开" : "读取中";
      $("#statusConnections").textContent = connectionFactText(status, { freshness: fresh, statusAt });
      $("#statusRoutes").textContent = routeFactText(status, { freshness: fresh, statusAt });
      $("#statusRefreshed").textContent = refreshedText(statusAt);
      $("#statusRefreshed").title = statusAt > 0 ? new Date(statusAt).toLocaleString("zh-CN", { hour12: false }) : "";
      $("#statusSubscription").textContent = subscriptionText(nodeState.stats);
      $("#statusCounters").textContent = nodeState.stats ? `${nodeState.stats.openSessions ?? 0} 个工作区 · ${nodeState.stats.subscriptions ?? 0} 个订阅` : "—";
      $("#statusPeerId").textContent = status?.peerId || "—";
      $("#statusNodeId").textContent = status?.nodeId || "—";
      $("#statusVersion").textContent = status ? `${status.version || "—"} · API ${status.apiVersion || "—"}` : "—";
      $("#statusError").textContent = rawError || "—";
      $("#statusError").title = nodeState.errorAt > 0 ? `最近失败于 ${formatClock(nodeState.errorAt)}` : "";
      const last = nodeState.events[0];
      $("#statusEvent").textContent = last ? `${last.summary || last.kind || "事件"} · ${formatClock(last.atUnixMs)}` : "暂无";
      const log = $("#statusEventLog");
      log.replaceChildren();
      for (const event of nodeState.events) {
        const item = element("li");
        item.textContent = `${formatClock(event.atUnixMs)} · ${event.summary || event.kind || "事件"}`;
        log.append(item);
      }
      if (phase === "ready") {
        $("#statusSummary").textContent = status ? `${shortPeer(status.peerId)} · ${statusSnapshotSummary()}` : "本机服务已响应，但没有返回可展示的信息。";
      } else if (phase === "stale") {
        $("#statusSummary").textContent = nodeState.stream?.phase === "open" ? `实时更新已恢复，正在重新读取节点状态。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。` : `实时更新已中断，正在重试。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。`;
      } else if (phase === "error") {
        $("#statusSummary").textContent = status ? `这次没有读到节点状态，请稍后重试。下面是 ${refreshedText(statusAt)} 的最近一次结果，可能不是当前状态。` : "这次没有读到节点状态，请稍后重试。";
      } else if (phase === "closed") {
        $("#statusSummary").textContent = status ? `实时更新已断开。下面是 ${refreshedText(statusAt)} 的最近一次结果；关闭后重新打开页面会重新读取。` : "实时更新已断开，重新打开页面会重新读取。";
      } else {
        $("#statusSummary").textContent = "正在读取本机节点状态…";
      }
      statusRefresh.disabled = pendingRefresh || nodeState.phase === "loading";
      statusRefresh.title = typeof options.onRefresh === "function" ? "刷新节点状态" : "刷新暂时不可用";
    }
    async function ensureMinePreview(item) {
      const key2 = previewKeyFor("mine", item);
      const existing = minePreviews.get(key2);
      if (existing?.state === "loading") return;
      if (!mineFileContentCapable) {
        minePreviews.set(key2, { state: "error", error: "当前宿主没有提供本机公开文件的按需读取。" });
        renderMine();
        return;
      }
      minePreviews.set(key2, { state: "loading" });
      renderMine();
      if (currentPage === "post") renderPostDetailPage();
      try {
        const value = await options.onLoadMineFileContent(item.path, item.sha256, item.sizeBytes);
        if (destroyed) return;
        if (value && typeof value === "object") {
          const expectedSha = String(item.sha256 ?? "").toLowerCase();
          const returnedSha = String(value.sha256 ?? "").toLowerCase();
          if (value.path && value.path !== item.path) throw new Error("本机公开文件返回的路径与请求不一致，已停止显示。");
          if (expectedSha && returnedSha && returnedSha !== expectedSha) {
            throw new Error("本机公开文件返回的版本与请求不一致，已停止显示。");
          }
          minePreviews.set(key2, { state: "available", data: value });
        } else {
          minePreviews.set(key2, { state: "error", error: "本机公开文件读取没有返回结果" });
        }
      } catch (error) {
        if (!destroyed) minePreviews.set(key2, { state: "error", error: errorText(error) || "本机公开文件读取失败" });
      }
      if (!destroyed) {
        renderMine();
        if (currentPage === "post") renderPostDetailPage();
      }
    }
    function toggleMineFile(item, next) {
      const key2 = previewKeyFor("mine", item);
      if (!next) {
        mineExpanded.delete(key2);
        disposePreviewMedia(minePostList);
      } else {
        mineExpanded.add(key2);
      }
      renderMine();
    }
    function homeAgentModel() {
      const model = buildHomeAgentModel({
        mine: mineState.data,
        error: mineState.error,
        capable: mineCapable
      });
      const agentRequest = currentHomeAvatarRequest();
      model.avatarUrl = agentRequest && homeAvatarState.key === agentRequest.key ? homeAvatarState.url : "";
      const v2 = mineState.data?.publicProfile?.state === "available" ? mineState.data.publicProfile.profile : null;
      const humanAvatar = v2?.humanAvatarPath
        ? { path: v2.humanAvatarPath, sha256: v2.humanAvatarSha256 }
        : null;
      const humanKey = publishedAvatarKey(humanAvatar);
      model.human.avatarUrl = humanKey && homeHumanAvatarState.key === humanKey ? homeHumanAvatarState.url : "";
      return model;
    }
    function currentHomeHumanAvatarRequest() {
      const v2 = mineState.data?.publicProfile?.state === "available" ? mineState.data.publicProfile.profile : null;
      const humanAvatarPath = String(v2?.humanAvatarPath ?? "");
      const humanAvatarSha = String(v2?.humanAvatarSha256 ?? "").toLowerCase();
      if (!humanAvatarPath || !humanAvatarSha) return null;
      const file = Array.isArray(mineState.data?.files)
        ? mineState.data.files.find((item) => item.path === humanAvatarPath
          && String(item.sha256 ?? "").toLowerCase() === humanAvatarSha)
        : null;
      if (!file || !mineFileContentCapable) return null;
      return {
        path: humanAvatarPath,
        sha256: humanAvatarSha,
        sizeBytes: file.sizeBytes,
        mime: v2.humanAvatarMime || file.mime || "",
        key: `${humanAvatarPath}\u0000${humanAvatarSha}\u0000${file.sizeBytes}`
      };
    }
    function currentHomeAvatarRequest() {
      const data = mineState.data;
      const card = data?.agentCard?.state === "available" ? data.agentCard.card : null;
      const avatarPath = card?.avatarPath || "";
      const file = avatarPath && Array.isArray(data?.files) ? data.files.find((item) => item.path === avatarPath) : null;
      if (!avatarPath || !file || !mineFileContentCapable) return null;
      return {
        avatarPath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        key: `${avatarPath}\0${file.sha256}\0${file.sizeBytes}`
      };
    }
    function renderHomeAvatarDependents() {
      renderHome();
      if (currentPage === "settings" && view.settings.tab === "public") {
        renderProfileAvatar();
        renderProfileHumanAvatar();
        renderProfileDraftStatus();
      }
      if (!conversationView.hidden) renderMessageList();
    }
    function refreshHomeAvatar() {
      const request = currentHomeAvatarRequest();
      if (!request) {
        // A removal or a different public version invalidates the old read.
        homeAvatarState.generation += 1;
        homeAvatarState.key = "";
        homeAvatarState.url = "";
        homeAvatarState.loading = false;
        homeAvatarState.requestedKey = "";
        if (!destroyed) renderHomeAvatarDependents();
        return;
      }
      if (homeAvatarState.key === request.key && homeAvatarState.url) return;
      if (homeAvatarState.loading && homeAvatarState.requestedKey === request.key) return;
      // Start the latest key immediately. The previous read is invalidated by
      // the generation bump, so a slow old response cannot win.
      const generation = ++homeAvatarState.generation;
      homeAvatarState.loading = true;
      homeAvatarState.requestedKey = request.key;
      const finish = (url) => {
        if (destroyed || generation !== homeAvatarState.generation) return;
        homeAvatarState.loading = false;
        homeAvatarState.requestedKey = "";
        homeAvatarState.key = url ? request.key : "";
        homeAvatarState.url = url;
        renderHomeAvatarDependents();
        // If the published avatar changed while this read was in flight,
        // immediately read the newest key instead of leaving the stale one.
        const current = currentHomeAvatarRequest();
        if (current && current.key !== request.key) refreshHomeAvatar();
      };
      void options.onLoadMineFileContent(request.avatarPath, request.sha256, request.sizeBytes).then((preview) => {
        finish(preview?.status === "ok" && preview.kind === "image" && preview.dataUrl ? preview.dataUrl : "");
      }).catch(() => {
        finish("");
      });
    }
    function refreshHomeHumanAvatar() {
      const request = currentHomeHumanAvatarRequest();
      if (!request) {
        // Removal, a different public version or a missing manifest entry
        // invalidates any older read immediately.
        homeHumanAvatarState.generation += 1;
        homeHumanAvatarState.key = "";
        homeHumanAvatarState.url = "";
        homeHumanAvatarState.loading = false;
        homeHumanAvatarState.requestedKey = "";
        if (!destroyed) renderHomeAvatarDependents();
        return;
      }
      if (homeHumanAvatarState.key === request.key && homeHumanAvatarState.url) return;
      if (homeHumanAvatarState.loading && homeHumanAvatarState.requestedKey === request.key) return;
      const generation = ++homeHumanAvatarState.generation;
      homeHumanAvatarState.loading = true;
      homeHumanAvatarState.requestedKey = request.key;
      const finish = (url) => {
        if (destroyed || generation !== homeHumanAvatarState.generation) return;
        homeHumanAvatarState.loading = false;
        homeHumanAvatarState.requestedKey = "";
        homeHumanAvatarState.key = url ? request.key : "";
        homeHumanAvatarState.url = url;
        renderHomeAvatarDependents();
        const current = currentHomeHumanAvatarRequest();
        if (current && current.key !== request.key) refreshHomeHumanAvatar();
      };
      void options.onLoadMineFileContent(request.path, request.sha256, request.sizeBytes).then((preview) => {
        finish(preview?.status === "ok" && preview.kind === "image" && preview.dataUrl ? preview.dataUrl : "");
      }).catch(() => {
        finish("");
      });
    }
    function homeActivityModel() {
      return buildHomeActivity({
        activity: activityState.data,
        activityCapable,
        activityError: activityState.error,
        journey: journeyState.data,
        journeyError: journeyState.error,
        capable: journeyCapable,
        previousInstanceId: activityState.previousInstanceId,
        peerLabel: (peerId2) => {
          const friend = contactFor(peerId2);
          return friend ? contactDisplayName(friend) : shortPeer(peerId2);
        }
      });
    }
    function activityFeaturedSessionId() {
      const model = homeActivityModel();
      if (!activityCapable) return model.session?.id ?? "";
      if (model.kind === "running" && model.target?.kind === "journey" && model.target.journeyId) {
        return model.target.journeyId;
      }
      return model.kind === "journey-live" || model.kind === "journey-paused" ? model.session?.id ?? "" : "";
    }
    function visibleActivityCard() {
      const model = homeActivityModel();
      return model.kind === "recent" ? homeActivityRecent : model.kind === "running" || model.kind === "journey-live" || model.kind === "journey-paused" ? homeActivityLive : null;
    }
    function ensureActivityDetail(operationId) {
      const detail = activityState.detail;
      if (!operationId || !activityDetailCapable) return Promise.resolve(null);
      if (detail.id === operationId) {
        if (detail.pending) return detail.pending;
        if (detail.loading || detail.data !== null || detail.error) return Promise.resolve(detail.data);
      }
      detail.id = operationId;
      detail.data = null;
      detail.error = "";
      detail.loading = true;
      const request = ++detail.request;
      let pending;
      try {
        pending = options.onLoadActivityDetail(operationId);
      } catch (error) {
        pending = Promise.reject(error);
      }
      const task = Promise.resolve(pending).then((value) => {
        if (destroyed || detail.request !== request) return null;
        if (value === null || typeof value !== "object") throw new Error("工具活动详情没有返回结果");
        detail.data = value;
        detail.error = "";
        return value;
      }).catch((error) => {
        if (destroyed || detail.request !== request) return null;
        detail.error = errorText(error) || "工具活动详情读取失败";
        return null;
      }).finally(() => {
        if (destroyed || detail.request !== request) return;
        detail.loading = false;
        detail.pending = null;
        renderHome();
        if (currentPage === "journey") renderJourneyDetailPage();
      });
      detail.pending = task;
      return task;
    }
    function toggleActivityDetail(model, forceOpen = null) {
      if (!model?.showDetail) return;
      const open = forceOpen === null ? !view.home.activityExpanded : forceOpen === true;
      view.home.activityExpanded = open;
      if (open && model.operation?.operationId) ensureActivityDetail(model.operation.operationId);
      saveNow();
      renderHome();
    }
    function activateHomeActivity(model) {
      const target = model?.target;
      if (target?.kind === "journey" && target.journeyId) {
        openJourneyFromActivity(model);
        return;
      }
      if (target?.kind === "messages" && target.peerId) {
        openConversation(target.peerId, { source: "home" });
        return;
      }
      if (target?.kind === "peer" && target.peerId) {
        if (peerProfileCapable) {
          openPeerProfile(target.peerId, { source: "home", ref: `activity:${model.operation?.operationId || ""}` });
        } else {
          openConversation(target.peerId, { source: "home" });
        }
        return;
      }
      toggleActivityDetail(model, true);
    }
    function renderHome() {
      if (destroyed) return;
      const agent = homeAgentModel();
      const activity = homeActivityModel();
      agent.statusText = activity.statusText;
      agent.statusTone = activity.statusTone;
      renderHomeAgent(doc, {
        avatar: homeAgentAvatar,
        initial: homeAgentInitial,
        name: homeAgentName,
        badge: homeAgentBadge,
        bio: homeAgentBio,
        notice: homeAgentProfileNote,
        noticeText: homeAgentProfileNoteText,
        interests: homeAgentInterests,
        style: homeAgentStyle,
        statusText: homeAgentStatusText,
        statusDot: homeAgentStatusDot
      }, agent);
      if (homeAgentProfileRetry) {
        const retry = Boolean(agent.needsRetry && mineCapable);
        homeAgentProfileRetry.hidden = !retry;
        homeAgentProfileRetry.onclick = retry ? () => {
          void loadMine(true);
        } : null;
      }
      renderHomeHuman(doc, {
        title: homeHumanTitle,
        summary: homeHumanSummary,
        avatar: homeHumanAvatar,
        profile: mineProfileContent,
        renderMarkdown: renderMarkdownInto
      }, agent);
      if (homeActivityDisclosure) homeActivityDisclosure.hidden = !activityCapable;
      renderHomeActivity(doc, {
        live: homeActivityLive,
        recent: homeActivityRecent,
        empty: homeActivityEmpty,
        detail: homeActivityDetail,
        toggle: homeActivityToggle
      }, activity);
      for (const card of [homeActivityLive, homeActivityRecent]) {
        if (!card) continue;
        card.setAttribute("aria-controls", "homeActivityDetail");
        card.dataset.focusKey = "home-activity-card";
        card.onclick = card.hidden ? null : () => {
          if (activity.target?.kind && activity.target.kind !== "none") activateHomeActivity(activity);
          else toggleActivityDetail(activity, true);
        };
      }
      if (homeActivityToggle) {
        const canExpand = Boolean(activity.showDetail);
        if (!canExpand) view.home.activityExpanded = false;
        homeActivityToggle.hidden = !canExpand;
        homeActivityToggle.disabled = !canExpand;
        homeActivityToggle.onclick = () => toggleActivityDetail(activity);
        homeActivityToggle.setAttribute("aria-expanded", view.home.activityExpanded ? "true" : "false");
        homeActivityToggle.textContent = view.home.activityExpanded ? "收起详情" : "查看详情";
        const expanded = canExpand && view.home.activityExpanded;
        homeActivityDetail.hidden = !expanded;
        const card = visibleActivityCard();
        if (card) card.setAttribute("aria-expanded", expanded ? "true" : "false");
        if (expanded) {
          const selectedId = activityState.detail.id || activity.operation?.operationId || "";
          const selectedOperation = selectedId ? activity.history.find((item) => item.operationId === selectedId) || (activity.operation?.operationId === selectedId ? activity.operation : null) : null;
          if (selectedOperation?.operationId) ensureActivityDetail(selectedOperation.operationId);
          const detailActivity = selectedOperation ? { ...activity, operation: selectedOperation } : activity;
          homeActivityDetail.replaceChildren();
          if (selectedOperation) {
            const detail = activityState.detail;
            const same = detail.id === selectedOperation.operationId;
            renderActivityDetail(doc, homeActivityDetail, detailActivity, same ? detail.data : null, {
              loading: same && detail.loading,
              error: same ? detail.error : "",
              currentInstanceId: activity.instanceId,
              peerLabel: (peerId2) => {
                const friend = contactFor(peerId2);
                return friend ? contactDisplayName(friend) : shortPeer(peerId2);
              }
            });
          } else if (activity.session) {
            const note = doc.createElement("p");
            note.className = "rm-list-note rm-activity-summary-note";
            note.textContent = "Agent 生成的 Journey 摘要，不是传输证据；本机工具调用记录单独来自 activity.jsonl，两者不互相改写。";
            const link = doc.createElement("button");
            link.type = "button";
            link.className = "rm-journey-action";
            link.dataset.activityJourney = activity.session.id;
            link.textContent = "打开这段漫游详情";
            homeActivityDetail.append(note, link);
            if (activity.history.length > 0) {
              const historyWrap = doc.createElement("div");
              historyWrap.className = "rm-activity-history-wrap";
              renderActivityDetail(doc, historyWrap, { ...activity, operation: null }, null, {
                currentInstanceId: activity.instanceId,
                peerLabel: (peerId2) => {
                  const friend = contactFor(peerId2);
                  return friend ? contactDisplayName(friend) : shortPeer(peerId2);
                }
              });
              homeActivityDetail.append(historyWrap);
            }
          } else {
            renderActivityDetail(doc, homeActivityDetail, activity, null, {
              currentInstanceId: activity.instanceId,
              peerLabel: (peerId2) => {
                const friend = contactFor(peerId2);
                return friend ? contactDisplayName(friend) : shortPeer(peerId2);
              }
            });
          }
          homeActivityDetail.hidden = false;
        }
      }
      renderMineIdentity();
      renderSettingsNode({ label: settingsNodeStatusLabel, summary: settingsNodeSummary }, {
        phase: nodeState.phase,
        status: nodeState.status,
        summary: nodeStatusSummaryText()
      });
    }
    function nodeStatusSummaryText() {
      if (!nodeState.status) {
        return nodeState.phase === "loading" ? "正在读取本机节点状态…" : "";
      }
      const phase = resolveNodePhase({
        status: nodeState.status,
        stats: nodeState.stats,
        freshness: nodeState.freshness,
        error: nodeState.error,
        stream: nodeState.stream
      });
      return `${nodePhaseText(phase)} · ${nodePillText(phase, nodeState.status)}`;
    }
    function renderPrivateEditors() {
      if (destroyed) return;
      const data = journeyState.data;
      const readError = journeyState.error || (data?.state === "error" ? data.sessionsError : "");
      const fields = [
        ["persona", data?.persona ?? null, settingsStableInput, settingsStableSave, settingsStableMeta, settingsStableStatus],
        ["growth", data?.growth ?? null, settingsGrowthInput, settingsGrowthSave, settingsGrowthMeta, settingsGrowthStatus]
      ];
      for (const [field, value, input, save, meta, status] of fields) {
        const editor = privateEditors[field];
        if (!editor.dirty) editor.expectedSha = value?.sha256 ?? "";
        if (value?.state === "available" && !editor.dirty) {
          editor.expectedSha = value.sha256 ?? "";
        }
        renderPrivateField({
          input,
          status,
          meta,
          save
        }, field, value, {
          dirty: editor.dirty,
          error: editor.error || (readError && !editor.dirty ? `读取失败：${readError}` : ""),
          saving: editor.saving,
          capable: privateAgentSaveCapable && journeyCapable
        });
        if (!privateAgentSaveCapable || !journeyCapable) {
          save.disabled = true;
        }
      }
      if (settingsPrivateNote.hidden) {
        settingsPrivateNote.hidden = journeyCapable;
        if (!journeyCapable) {
          settingsPrivateNote.textContent = "当前宿主没有提供私有 Agent 记录读取或保存。";
          settingsPrivateNote.hidden = false;
          settingsPrivateNote.dataset.tone = "error";
        }
      }
    }
    async function savePrivateEditor(field) {
      if (!privateAgentSaveCapable || !journeyCapable) return;
      const editor = privateEditors[field];
      if (editor.saving) return;
      const input = field === "persona" ? settingsStableInput : settingsGrowthInput;
      const content = input.value;
      const expectedSha = editor.expectedSha;
      editor.saving = true;
      editor.error = "";
      const seq = ++privateSaveSeq;
      renderPrivateEditors();
      const result = await Promise.resolve().then(() => options.onSavePrivateAgent(field, content, expectedSha)).catch((error) => ({ saved: false, error: errorText(error) || "私有资料保存失败", conflict: false }));
      if (destroyed) return;
      editor.saving = false;
      if (result?.saved === true) {
        editor.dirty = false;
        editor.expectedSha = String(result.sha256 || "");
        editor.error = "";
        if (journeyState.data) {
          journeyState.data = {
            ...journeyState.data,
            [field]: { state: "available", markdown: content, error: "", sha256: editor.expectedSha }
          };
        }
        settingsPrivateNote.textContent = `已保存 ${field === "persona" ? "persona.md" : "growth.md"}${result.sha256 ? ` · SHA-256 ${String(result.sha256).slice(0, 12)}…` : ""}${result.savedAt ? ` · ${formatDateTime(result.savedAt)}` : ""}。仅本机可见。`;
        settingsPrivateNote.hidden = false;
        settingsPrivateNote.dataset.tone = "ready";
      } else if (result?.conflict === true) {
        editor.dirty = true;
        editor.error = result.error || "文件已在别处修改，未覆盖；请重新读取后再保存。";
        settingsPrivateNote.textContent = editor.error;
        settingsPrivateNote.hidden = false;
        settingsPrivateNote.dataset.tone = "error";
      } else {
        editor.dirty = true;
        editor.error = result?.error || "保存没有完成；输入已保留，原文件未被覆盖。";
        settingsPrivateNote.textContent = editor.error;
        settingsPrivateNote.hidden = false;
        settingsPrivateNote.dataset.tone = "error";
      }
      renderPrivateEditors();
    }
    function splitList(value) {
      return String(value ?? "").split(/[,，\n]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0).slice(0, 10);
    }
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const Reader = win.FileReader ?? globalThis.FileReader;
        if (typeof Reader !== "function") {
          reject(new Error("当前环境没有文件读取能力"));
          return;
        }
        const reader = new Reader();
        reader.onerror = () => reject(new Error("读取本地图片失败"));
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : "");
        };
        reader.readAsDataURL(file);
      });
    }
    function imageSize(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
          const value = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
          URL.revokeObjectURL(url);
          resolve(value);
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("图片无法解码"));
        };
        image.src = url;
      });
    }
    const draftAssetCache = /* @__PURE__ */ new Map();
    const draftAssetPending = /* @__PURE__ */ new Map();
    const draftAssetGeneration = /* @__PURE__ */ new Map();
    function draftAssetScopeGeneration(scope) {
      return draftAssetGeneration.get(scope) ?? 0;
    }
    function bumpDraftAssetScope(scope) {
      draftAssetGeneration.set(scope, draftAssetScopeGeneration(scope) + 1);
    }
    function releaseDraftAsset(scope, draftId, assetId) {
      const key2 = `${scope}:${draftId}:${assetId}`;
      const entry = draftAssetCache.get(key2);
      if (entry?.url && entry.objectUrl) {
        try {
          URL.revokeObjectURL(entry.url);
        } catch {
        }
      }
      draftAssetCache.delete(key2);
      draftAssetPending.delete(key2);
    }
    function releaseDraftAssetScope(scope) {
      bumpDraftAssetScope(scope);
      for (const key2 of [...draftAssetCache.keys()]) {
        if (!key2.startsWith(`${scope}:`)) continue;
        const [, draftId, assetId] = key2.split(":");
        releaseDraftAsset(scope, draftId, assetId);
      }
    }
    function releaseAllDraftAssets() {
      releaseDraftAssetScope("profile");
      releaseDraftAssetScope("post");
    }
    function base64ToBytes(raw) {
      const value = String(raw ?? "").replace(/\s+/g, "");
      if (value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error("草稿图片不是有效 base64");
      }
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    function bytesToBase64(bytes) {
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
    function assetObjectUrl(bytes, mime) {
      const type = mime === "image/jpeg" ? "image/jpeg" : "image/png";
      if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
        try {
          return { url: URL.createObjectURL(new Blob([bytes], { type })), objectUrl: true };
        } catch {
        }
      }
      return { url: `data:${type};base64,${bytesToBase64(bytes)}`, objectUrl: false };
    }
    function ensureDraftAssetPreview(scope, draftId, image) {
      const assetId = String(image?.assetId ?? "");
      if (!publicDraftAssetCapable || draftId.length === 0 || assetId.length === 0) return Promise.resolve(null);
      const key2 = `${scope}:${draftId}:${assetId}`;
      const cached = draftAssetCache.get(key2);
      if (cached) return Promise.resolve(cached);
      const pending = draftAssetPending.get(key2);
      if (pending) return pending;
      const generation = draftAssetScopeGeneration(scope);
      const promise = Promise.resolve().then(() => options.onLoadPublicDraftAsset(draftId, assetId)).then((result) => {
        if (destroyed || generation !== draftAssetScopeGeneration(scope)) return null;
        const meta = result?.image || image;
        if (!result || meta?.assetId !== assetId) throw new Error("草稿图片响应与请求不一致");
        const bytes = base64ToBytes(result.dataBase64);
        if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new Error("草稿图片为空或超过 8 MiB");
        const { url, objectUrl } = assetObjectUrl(bytes, meta.mime || image.mime);
        const entry = { url, objectUrl, image: { ...image, ...meta } };
        draftAssetCache.set(key2, entry);
        return entry;
      }).catch((error) => {
        if (!destroyed && generation === draftAssetScopeGeneration(scope)) {
          draftAssetCache.set(key2, { error: errorText(error) || "草稿图片读取失败" });
        }
        return null;
      }).finally(() => {
        if (draftAssetPending.get(key2) === promise) draftAssetPending.delete(key2);
      });
      draftAssetPending.set(key2, promise);
      return promise;
    }
    function releaseProfileAvatarPreview() {
      if (profileDraftState.avatarPreviewObject && profileDraftState.avatarPreviewUrl) {
        try { URL.revokeObjectURL(profileDraftState.avatarPreviewUrl); } catch { /* detached test DOM */ }
      }
      profileDraftState.avatarPreviewUrl = "";
      profileDraftState.avatarPreviewObject = false;
      profileDraftState.avatarPreviewAssetId = "";
    }
    function releaseProfileHumanAvatarPreview() {
      if (profileDraftState.humanAvatarPreviewObject && profileDraftState.humanAvatarPreviewUrl) {
        try { URL.revokeObjectURL(profileDraftState.humanAvatarPreviewUrl); } catch { /* detached test DOM */ }
      }
      profileDraftState.humanAvatarPreviewUrl = "";
      profileDraftState.humanAvatarPreviewObject = false;
      profileDraftState.humanAvatarPreviewAssetId = "";
    }
    /** Key of the local public bytes that back a published avatar. A draft
     * source can only borrow the loaded home URL when path, hash and manifest
     * size all still match; otherwise an older public image could appear while
     * a newer draft is selected. */
    function publishedAvatarKey(avatar) {
      const path = String(avatar?.path ?? "");
      const sha = String(avatar?.sha256 ?? "").toLowerCase();
      if (!path || !sha) return "";
      const file = Array.isArray(mineState.data?.files)
        ? mineState.data.files.find((item) => item.path === path)
        : null;
      const size = Number(file?.sizeBytes) > 0 ? Number(file.sizeBytes) : 0;
      return `${path}\u0000${sha}\u0000${size}`;
    }

    function fallbackProfileDraft() {
      const publicProfile = mineState.data?.publicProfile?.state === "available" ? mineState.data.publicProfile.profile : null;
      const card = mineState.data?.agentCard?.state === "available" ? mineState.data.agentCard.card : null;
      const human = mineState.data?.profile?.state === "available" ? mineState.data.profile : null;
      const humanIndexName = human?.displayName && human.displayName !== "关联人类" ? human.displayName : "";
      const avatar = publicProfile?.avatarPath
        ? { assetId: "", sha256: publicProfile.avatarSha256, mime: publicProfile.avatarMime, path: publicProfile.avatarPath }
        : card?.avatarPath
          ? { assetId: "", sha256: card.avatarSha256, mime: card.avatarMime, path: card.avatarPath }
          : null;
      const humanAvatar = publicProfile?.humanAvatarPath
        ? { assetId: "", sha256: publicProfile.humanAvatarSha256, mime: publicProfile.humanAvatarMime, path: publicProfile.humanAvatarPath }
        : null;
      return {
        draftId: "profile",
        kind: "profile",
        revision: 0,
        agentName: publicProfile?.agentName || card?.displayName || "",
        agentDescription: publicProfile?.agentDescription || card?.description || "",
        agentInterests: publicProfile?.agentInterests || card?.interests || [],
        agentConversationStyle: publicProfile?.agentConversationStyle || card?.conversationStyle || "",
        humanName: publicProfile?.humanName || humanIndexName,
        humanBioMarkdown: publicProfile?.humanBioMarkdown || (human ? String(human.markdown).replace(/^#.*$/m, "").trim() : ""),
        avatar,
        humanAvatar,
        publishedSha256: "",
        publishedRevision: 0,
        publishedPath: ""
      };
    }

    function profileFormValues() {
      return {
        agentName: publicAgentName.value,
        agentDescription: publicAgentDescription.value,
        agentInterests: splitList(publicAgentInterests.value),
        agentConversationStyle: publicAgentStyle.value,
        humanName: publicHumanName.value,
        humanBioMarkdown: publicHumanBio.value
      };
    }

    function sameProfileValues(left, right) {
      return Boolean(left && right
        && left.agentName === right.agentName
        && left.agentDescription === right.agentDescription
        && left.agentConversationStyle === right.agentConversationStyle
        && left.humanName === right.humanName
        && left.humanBioMarkdown === right.humanBioMarkdown
        && (left.agentInterests || []).join("\u0000") === (right.agentInterests || []).join("\u0000"));
    }

    function profileDraftValues(draft) {
      return {
        agentName: draft?.agentName || "",
        agentDescription: draft?.agentDescription || "",
        agentInterests: draft?.agentInterests || [],
        agentConversationStyle: draft?.agentConversationStyle || "",
        humanName: draft?.humanName || "",
        humanBioMarkdown: draft?.humanBioMarkdown || ""
      };
    }

    function profileImageMatchesSelection(draftImage, { file, assetId, clear }) {
      if (file !== null) return false;
      const image = draftImage || null;
      if (clear) return image === null;
      if (assetId) return String(image?.assetId || "") === assetId;
      return image === null || String(image?.assetId || "") === "";
    }

    function profileDraftMatchesCurrent(draft = profileDraftState.draft) {
      if (!draft) return false;
      if (!sameProfileValues(profileFormValues(), profileDraftValues(draft))) return false;
      if (!profileImageMatchesSelection(draft.avatar, {
        file: profileDraftState.avatarFile,
        assetId: profileDraftState.avatarAssetId,
        clear: profileDraftState.avatarClear
      })) return false;
      return profileImageMatchesSelection(draft.humanAvatar, {
        file: profileDraftState.humanAvatarFile,
        assetId: profileDraftState.humanAvatarAssetId,
        clear: profileDraftState.humanAvatarClear
      });
    }

    function adoptProfileDraftBaseline(receipt) {
      if (!receipt) return;
      const current = profileDraftState.draft || {};
      const avatar = Object.prototype.hasOwnProperty.call(receipt, "avatar")
        ? receipt.avatar ?? null
        : current.avatar ?? null;
      const humanAvatar = Object.prototype.hasOwnProperty.call(receipt, "humanAvatar")
        ? receipt.humanAvatar ?? null
        : current.humanAvatar ?? null;
      profileDraftState.draft = { ...current, ...receipt, avatar, humanAvatar };
      profileDraftState.fromFallback = false;
      profileDraftState.conflict = false;
    }

    function profileAvatarSelectionMatches(request) {
      return Boolean(request
        && profileDraftState.avatarFile === request.avatarFile
        && profileDraftState.avatarAssetId === request.avatarAssetId
        && profileDraftState.avatarClear === request.clearAvatar);
    }

    function profileHumanAvatarSelectionMatches(request) {
      return Boolean(request
        && profileDraftState.humanAvatarFile === request.humanAvatarFile
        && profileDraftState.humanAvatarAssetId === request.humanAvatarAssetId
        && profileDraftState.humanAvatarClear === request.clearHumanAvatar);
    }

    function restoreProfileAvatarFromDraft(draft, fallbackAvatar = null) {
      const avatar = draft?.avatar || fallbackAvatar || null;
      releaseProfileAvatarPreview();
      profileDraftState.avatarFile = null;
      profileDraftState.avatarAssetId = avatar?.assetId || "";
      profileDraftState.avatarClear = false;
      profileDraftState.avatarLoadingAssetId = "";
      if (profileDraftState.draft) {
        profileDraftState.draft = { ...profileDraftState.draft, avatar };
      }
      renderProfileAvatar();
    }

    function restoreProfileHumanAvatarFromDraft(draft, fallbackAvatar = null) {
      const avatar = draft?.humanAvatar || fallbackAvatar || null;
      releaseProfileHumanAvatarPreview();
      profileDraftState.humanAvatarFile = null;
      profileDraftState.humanAvatarAssetId = avatar?.assetId || "";
      profileDraftState.humanAvatarClear = false;
      profileDraftState.humanAvatarLoadingAssetId = "";
      if (profileDraftState.draft) {
        profileDraftState.draft = { ...profileDraftState.draft, humanAvatar: avatar };
      }
      renderProfileHumanAvatar();
    }

    function setProfileForm(draft) {
      if (!draft) return;
      releaseDraftAssetScope("profile");
      releaseProfileAvatarPreview();
      releaseProfileHumanAvatarPreview();
      publicAgentName.value = draft.agentName || "";
      publicAgentDescription.value = draft.agentDescription || "";
      publicAgentInterests.value = (draft.agentInterests || []).join("，");
      publicAgentStyle.value = draft.agentConversationStyle || "";
      publicHumanName.value = draft.humanName || "";
      publicHumanBio.value = draft.humanBioMarkdown || "";
      profileDraftState.avatarAssetId = draft.avatar?.assetId || "";
      profileDraftState.avatarClear = false;
      profileDraftState.avatarFile = null;
      profileDraftState.avatarError = "";
      profileDraftState.avatarRestoreToken += 1;
      profileDraftState.humanAvatarAssetId = draft.humanAvatar?.assetId || "";
      profileDraftState.humanAvatarClear = false;
      profileDraftState.humanAvatarFile = null;
      profileDraftState.humanAvatarError = "";
      profileDraftState.humanAvatarRestoreToken += 1;
      profileDraftState.formVersion += 1;
      profileDraftState.dirty = false;
      profileDraftState.reloadArmed = false;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      profileDraftState.confirmNotice = "";
      if (publicPublishButton) publicPublishButton.textContent = "检查发布内容";
      if (publicPublishCancel) publicPublishCancel.hidden = true;
      renderProfileAvatar();
      renderProfileHumanAvatar();
      renderHumanPreview();
      renderPublicVersionPreview();
    }

    function renderProfileAvatar() {
      if (!publicAvatarPreview) return;
      const image = publicAvatarPreview.querySelector("img");
      if (!image) return;
      image.hidden = false;
      const avatar = profileDraftState.draft?.avatar || null;
      const assetId = profileDraftState.avatarAssetId;
      const showPlaceholder = (empty, label) => {
        image.src = "assets/raminga-mark-gradient.svg";
        publicAvatarPreview.dataset.loading = "false";
        publicAvatarPreview.dataset.empty = empty ? "true" : "false";
        publicAvatarPreview.setAttribute("aria-label", label);
      };
      if (profileDraftState.avatarPreviewUrl) {
        image.src = profileDraftState.avatarPreviewUrl;
        publicAvatarPreview.dataset.empty = "false";
        publicAvatarPreview.dataset.loading = "false";
        publicAvatarPreview.setAttribute("aria-label", "Agent 头像预览");
        return;
      }
      if (publicDraftAssetCapable && assetId && avatar?.assetId === assetId) {
        image.removeAttribute("src");
        publicAvatarPreview.dataset.empty = "false";
        publicAvatarPreview.dataset.loading = "true";
        publicAvatarPreview.setAttribute("aria-label", "正在读取 Agent 草稿头像");
        profileDraftState.avatarLoadingAssetId = assetId;
        void ensureDraftAssetPreview("profile", "profile", avatar).then((entry) => {
          if (destroyed || profileDraftState.avatarAssetId !== assetId || profileDraftState.avatarLoadingAssetId !== assetId) return;
          profileDraftState.avatarLoadingAssetId = "";
          if (!entry?.url) {
            profileDraftState.avatarError = "草稿头像读取失败；保存或发布时会重新校验。";
            showPlaceholder(true, "Agent 头像暂时无法显示");
            renderProfileDraftStatus();
            return;
          }
          profileDraftState.avatarError = "";
          profileDraftState.avatarPreviewUrl = entry.url;
          profileDraftState.avatarPreviewObject = entry.objectUrl === true;
          profileDraftState.avatarPreviewAssetId = assetId;
          image.src = entry.url;
          publicAvatarPreview.dataset.loading = "false";
          publicAvatarPreview.dataset.empty = "false";
          publicAvatarPreview.setAttribute("aria-label", "Agent 头像预览");
          renderProfileDraftStatus();
        });
        return;
      }
      const homeKey = publishedAvatarKey(avatar);
      if (!profileDraftState.avatarClear && avatar && homeKey && homeAvatarState.key === homeKey && homeAvatarState.url) {
        image.src = homeAvatarState.url;
        publicAvatarPreview.dataset.loading = "false";
        publicAvatarPreview.dataset.empty = "false";
        publicAvatarPreview.setAttribute("aria-label", "Agent 公开头像");
        return;
      }
      if (!profileDraftState.avatarClear && avatar) {
        image.src = "assets/raminga-mark-gradient.svg";
        publicAvatarPreview.dataset.loading = "true";
        publicAvatarPreview.dataset.empty = "false";
        publicAvatarPreview.setAttribute("aria-label", "正在读取已公开的 Agent 头像");
        return;
      }
      showPlaceholder(true, "尚未设置 Agent 头像");
    }

    function renderProfileHumanAvatar() {
      if (!publicHumanAvatarPreview) return;
      const image = publicHumanAvatarPreview.querySelector("img");
      if (!image) return;
      image.hidden = false;
      const avatar = profileDraftState.draft?.humanAvatar || null;
      const assetId = profileDraftState.humanAvatarAssetId;
      const showPlaceholder = (empty, label) => {
        image.src = "assets/raminga-mark-gradient.svg";
        publicHumanAvatarPreview.dataset.loading = "false";
        publicHumanAvatarPreview.dataset.empty = empty ? "true" : "false";
        publicHumanAvatarPreview.setAttribute("aria-label", label);
      };
      if (profileDraftState.humanAvatarPreviewUrl) {
        image.src = profileDraftState.humanAvatarPreviewUrl;
        publicHumanAvatarPreview.dataset.empty = "false";
        publicHumanAvatarPreview.dataset.loading = "false";
        publicHumanAvatarPreview.setAttribute("aria-label", "关联人类头像预览");
        return;
      }
      if (publicDraftAssetCapable && assetId && avatar?.assetId === assetId) {
        image.removeAttribute("src");
        publicHumanAvatarPreview.dataset.empty = "false";
        publicHumanAvatarPreview.dataset.loading = "true";
        publicHumanAvatarPreview.setAttribute("aria-label", "正在读取关联人类草稿头像");
        profileDraftState.humanAvatarLoadingAssetId = assetId;
        void ensureDraftAssetPreview("profile", "profile", avatar).then((entry) => {
          if (destroyed || profileDraftState.humanAvatarAssetId !== assetId || profileDraftState.humanAvatarLoadingAssetId !== assetId) return;
          profileDraftState.humanAvatarLoadingAssetId = "";
          if (!entry?.url) {
            profileDraftState.humanAvatarError = "人类头像草稿读取失败；保存或发布时会重新校验。";
            showPlaceholder(true, "关联人类头像暂时无法显示");
            renderProfileDraftStatus();
            return;
          }
          profileDraftState.humanAvatarError = "";
          profileDraftState.humanAvatarPreviewUrl = entry.url;
          profileDraftState.humanAvatarPreviewObject = entry.objectUrl === true;
          profileDraftState.humanAvatarPreviewAssetId = assetId;
          image.src = entry.url;
          publicHumanAvatarPreview.dataset.loading = "false";
          publicHumanAvatarPreview.dataset.empty = "false";
          publicHumanAvatarPreview.setAttribute("aria-label", "关联人类头像预览");
          renderProfileDraftStatus();
        });
        return;
      }
      const homeKey = publishedAvatarKey(avatar);
      if (!profileDraftState.humanAvatarClear && avatar && homeKey && homeHumanAvatarState.key === homeKey && homeHumanAvatarState.url) {
        image.src = homeHumanAvatarState.url;
        publicHumanAvatarPreview.dataset.loading = "false";
        publicHumanAvatarPreview.dataset.empty = "false";
        publicHumanAvatarPreview.setAttribute("aria-label", "关联人类公开头像");
        return;
      }
      if (!profileDraftState.humanAvatarClear && avatar) {
        image.src = "assets/raminga-mark-gradient.svg";
        publicHumanAvatarPreview.dataset.loading = "true";
        publicHumanAvatarPreview.dataset.empty = "false";
        publicHumanAvatarPreview.setAttribute("aria-label", "正在读取已公开的关联人类头像");
        return;
      }
      showPlaceholder(true, "尚未设置关联人类头像");
    }

    function renderHumanPreview() {
      if (!settingsHumanPreview) return;
      const value = publicHumanBio.value.trim();
      if (value.length === 0) {
        settingsHumanPreview.replaceChildren();
        settingsHumanPreview.hidden = true;
        return;
      }
      settingsHumanPreview.hidden = false;
      renderMarkdownInto(settingsHumanPreview, value);
    }

    function currentPublishedProfile() {
      const data = mineState.data;
      if (!data) return null;
      const v2 = data.publicProfile?.state === "available" ? data.publicProfile.profile : null;
      if (v2) {
        return {
          source: "profile.json",
          sourcePath: v2.path || "profile/profile.json",
          agentName: v2.agentName || "",
          agentDescription: v2.agentDescription || "",
          agentInterests: Array.isArray(v2.agentInterests) ? v2.agentInterests : [],
          agentConversationStyle: v2.agentConversationStyle || "",
          humanName: v2.humanName || "",
          humanBioMarkdown: v2.humanBioMarkdown || "",
          avatarPath: v2.avatarPath || "",
          avatarSha256: v2.avatarSha256 || "",
          avatarMime: v2.avatarMime || "",
          humanAvatarPath: v2.humanAvatarPath || "",
          humanAvatarSha256: v2.humanAvatarSha256 || "",
          humanAvatarMime: v2.humanAvatarMime || "",
          updatedAt: v2.updatedAt || ""
        };
      }
      const card = data.agentCard?.state === "available" ? data.agentCard.card : null;
      const human = data.profile?.state === "available" ? data.profile : null;
      if (!card && !human) return null;
      return {
        source: card ? "agent-card.json" : "index.md",
        sourcePath: card?.path || human?.path || "profile/index.md",
        agentName: card?.displayName || "",
        agentDescription: card?.description || "",
        agentInterests: Array.isArray(card?.interests) ? card.interests : [],
        agentConversationStyle: card?.conversationStyle || "",
        humanName: human?.displayName || "",
        humanBioMarkdown: human ? String(human.markdown).replace(/^#.*$/gm, "").trim() : "",
        avatarPath: card?.avatarPath || "",
        avatarSha256: card?.avatarSha256 || "",
        avatarMime: card?.avatarMime || "",
        humanAvatarPath: "",
        humanAvatarSha256: "",
        humanAvatarMime: "",
        updatedAt: card?.updatedAt || ""
      };
    }

    function renderPublicVersionPreview() {
      if (!publicVersionName) return;
      const published = currentPublishedProfile();
      const loading = mineState.data === null && mineState.retrying;
      const readError = mineState.error || (mineState.data?.publicProfile?.state === "error" ? mineState.data.publicProfile.error : "");
      if (publicVersionPreview) publicVersionPreview.classList.toggle("is-empty", !published);
      publicRestorePublished.disabled = !published || profileDraftState.publishing || profileDraftState.saving;
      if (publicVersionRetry) {
        publicVersionRetry.hidden = !(mineCapable && readError.length > 0);
        publicVersionRetry.disabled = mineState.retrying;
        publicVersionRetry.textContent = mineState.retrying ? "正在重试…" : "重试读取公开资料";
        publicVersionRetry.onclick = mineCapable ? () => {
          void loadMine(true);
        } : null;
      }
      if (!published) {
        publicVersionName.textContent = loading ? "正在读取公开版本…" : readError ? "读取公开版本失败" : "尚无公开版本";
        publicVersionDescription.textContent = loading
          ? "读取完成后会在这里显示当前公开内容。"
          : readError ? "当前公开版本读取失败，详细诊断在「版本、路径与诊断」中。" : "发布成功后会在这里保留一份可恢复的公开内容预览。";
        publicVersionInterests.replaceChildren();
        publicVersionInterests.hidden = true;
        publicVersionStyle.textContent = "";
        publicVersionHuman.textContent = "";
        publicVersionNote.textContent = readError ? "读取公开版本没有完成；这不表示本机没有公开内容。" : "还没有公开版本。";
        const image2 = publicVersionAvatar?.querySelector("img");
        const initial2 = publicVersionAvatar?.querySelector("span");
        if (image2) image2.hidden = true;
        if (initial2) { initial2.hidden = false; initial2.textContent = "?"; }
        return;
      }
      publicVersionName.textContent = published.agentName || "未命名 Agent";
      publicVersionDescription.textContent = published.agentDescription || "尚未填写 Agent 简介。";
      publicVersionInterests.replaceChildren();
      for (const interest of published.agentInterests.slice(0, 10)) {
        const item = element("li");
        item.textContent = interest;
        publicVersionInterests.append(item);
      }
      publicVersionInterests.hidden = published.agentInterests.length === 0;
      publicVersionStyle.textContent = published.agentConversationStyle ? `公开交流风格 · ${published.agentConversationStyle}` : "";
      const humanAvatarText = published.humanAvatarPath ? "（已设置公开头像）" : "";
      publicVersionHuman.textContent = published.humanName
        ? `关联人类 · ${published.humanName}${humanAvatarText}${published.humanBioMarkdown ? `：${plainSummary(published.humanBioMarkdown, 160)}` : ""}`
        : published.humanAvatarPath ? "关联人类 · 已设置公开头像，介绍尚未填写。" : "关联人类介绍尚未填写。";
      const stale = readError && Number(mineState.data?.at) > 0
        ? ` 这是 ${refreshedText(mineState.data.at)} 成功读取的公开版本；最近一次刷新失败，可能不是最新。`
        : "";
      publicVersionNote.textContent = `公开版本 · ${published.sourcePath}${published.updatedAt ? ` · 更新于 ${formatDateTime(published.updatedAt)}` : ""}${stale}`;
      const image = publicVersionAvatar?.querySelector("img");
      const initial = publicVersionAvatar?.querySelector("span");
      if (image && initial) {
        const publishedKey = publishedAvatarKey(published.avatarPath
          ? { path: published.avatarPath, sha256: published.avatarSha256 }
          : null);
        if (published.avatarPath && publishedKey && homeAvatarState.key === publishedKey && homeAvatarState.url) {
          image.src = homeAvatarState.url;
          image.hidden = false;
          initial.hidden = true;
        } else {
          image.hidden = true;
          initial.hidden = false;
          initial.textContent = (published.agentName || "A").slice(0, 1);
        }
      }
    }

    function profileFactRow(label, value, { code = false } = {}) {
      const row = element("div");
      const key = element("dt");
      key.textContent = label;
      const detail = element("dd");
      if (code) {
        const codeNode = element("code");
        codeNode.textContent = value || "—";
        detail.append(codeNode);
      } else {
        detail.textContent = value || "—";
      }
      row.append(key, detail);
      return row;
    }

    function renderProfileTechDetails() {
      if (!publicDraftMeta) return;
      const draft = profileDraftState.draft;
      const hasSavedDraft = Boolean(draft && !profileDraftState.fromFallback);
      const published = currentPublishedProfile();
      publicDraftMeta.replaceChildren();
      publicDraftMeta.append(
        profileFactRow("私有草稿", hasSavedDraft ? `profile · revision ${draft.revision}` : "尚未创建"),
        profileFactRow("草稿更新", hasSavedDraft && draft?.updatedAtUnixMs ? formatDateTime(new Date(draft.updatedAtUnixMs).toISOString()) : "—"),
        profileFactRow("公开 revision", draft?.publishedRevision ? String(draft.publishedRevision) : "—"),
        profileFactRow("公开路径", draft?.publishedPath || published?.sourcePath || "—", { code: true }),
        profileFactRow("公开 SHA-256", draft?.publishedSha256 || (published?.source === "profile.json" ? mineState.data?.publicProfile?.profile?.sha256 : "") || "—", { code: true }),
        profileFactRow("公开资料格式", published?.sourcePath === "profile/profile.json" ? "profile.json v2（兼容 index.md；已有 agent-card.json 会同步）" : published ? "旧格式回退" : "—"),
        profileFactRow("草稿存储", "本机 SQLite；只有确认发布后才写入 public/")
      );
      renderProfilePublishReceiptDetails();
    }

    function renderProfilePublishReceiptDetails() {
      if (!publicPublishReceiptDetails) return;
      publicPublishReceiptDetails.replaceChildren();
      const receipt = profileDraftState.receipt;
      if (!receipt) {
        publicPublishReceiptDetails.hidden = true;
        return;
      }
      publicPublishReceiptDetails.hidden = false;
      const block = element("div", "rm-public-publish-details");
      const line = (text) => {
        const paragraph = element("p");
        paragraph.textContent = text;
        block.append(paragraph);
      };
      const label = {
        published: "发布完成", already_published: "内容已是最新公开版本", conflict: "发布冲突，未覆盖公开文件",
        invalid: "发布内容无效，未写入公开文件", partial: "发布部分完成，请核对实际清单", unspecified: "发布状态未知"
      }[receipt.status] || "发布状态未知";
      line(label);
      if (receipt.error) line(`错误：${receipt.error}`);
      if (receipt.profilePath) line(`公开资料：${receipt.profilePath}`);
      if (receipt.manifestVersion) line(`公开清单版本：${receipt.manifestVersion}`);
      if (receipt.manifestSha256) line(`公开清单 SHA-256：${receipt.manifestSha256}`);
      for (const file of receipt.files || []) line(`文件：${file.path} · ${file.sizeBytes} B · ${file.sha256}`);
      for (const warning of receipt.warnings || []) line(`提示：${warning}`);
      if (receipt.status === "published" || receipt.status === "already_published") {
        line("以上为本次真实公开清单回执；发布完成后主页和公开文件会重新读取实际清单。");
      }
      publicPublishReceiptDetails.append(block);
    }

    function profilePublishReceiptText(receipt) {
      if (!receipt) return "";
      switch (receipt.status) {
        case "published": return "发布完成，公开版本已更新。";
        case "already_published": return "内容已是当前公开版本，本次没有重复写入。";
        case "conflict": return `发布冲突，未覆盖公开文件。${receipt.error ? ` ${receipt.error}` : ""}本机输入仍保留。`;
        case "invalid": return `发布内容无效，没有写入公开文件。${receipt.error ? ` ${receipt.error}` : ""}`;
        case "partial": return `发布部分完成，请核对实际公开清单。${receipt.error ? ` ${receipt.error}` : ""}`;
        default: return `发布状态未知，未把它当作成功。${receipt.error ? ` ${receipt.error}` : ""}`;
      }
    }

    function renderProfileDraftStatus() {
      if (!publicDraftStatus) return;
      const state = profileDraftState;
      const lock = state.publishing || state.loading !== null;
      publicDraftSave.disabled = !publicDraftSaveCapable || state.saving || lock || state.loading !== null;
      publicDraftSave.textContent = state.saving ? "保存中…" : "保存草稿";
      publicDraftReload.disabled = !publicDraftLoadCapable || state.saving || lock || state.loading !== null;
      publicDraftReload.textContent = state.reloadArmed ? "确认放弃修改并重新载入" : "重新载入草稿";
      publicPublishButton.disabled = !publishDraftCapable || state.saving || lock || state.loading !== null;
      publicPublishButton.textContent = lock ? "正在发布…" : state.confirm ? "确认发布公开资料" : "检查发布内容";
      publicPublishCancel.hidden = !state.confirm || lock;
      publicPublishCancel.disabled = lock;
      publicAvatarInput.disabled = lock;
      publicHumanAvatarInput.disabled = lock;
      const hasAvatar = !state.avatarClear && (state.avatarFile !== null || Boolean(state.avatarAssetId)
        || Boolean(state.draft?.avatar) || Boolean(homeAvatarState.url));
      const hasHumanAvatar = !state.humanAvatarClear && (state.humanAvatarFile !== null || Boolean(state.humanAvatarAssetId)
        || Boolean(state.draft?.humanAvatar) || Boolean(homeHumanAvatarState.url));
      publicAvatarClear.disabled = lock || !hasAvatar;
      publicHumanAvatarClear.disabled = lock || !hasHumanAvatar;
      for (const input of [publicAgentName, publicAgentDescription, publicAgentInterests, publicAgentStyle, publicHumanName, publicHumanBio]) {
        input.disabled = lock;
      }
      publicRestorePublished.disabled = lock || state.saving || !currentPublishedProfile();
      if (publicAvatarNote) {
        if (state.avatarError) {
          publicAvatarNote.hidden = false;
          publicAvatarNote.dataset.tone = "error";
          publicAvatarNote.textContent = state.avatarError;
        } else if (state.avatarLoadingAssetId) {
          publicAvatarNote.hidden = false;
          publicAvatarNote.dataset.tone = "";
          publicAvatarNote.textContent = "正在读取本机草稿头像…";
        } else {
          publicAvatarNote.hidden = true;
          publicAvatarNote.textContent = "";
          delete publicAvatarNote.dataset.tone;
        }
      }
      if (publicHumanAvatarNote) {
        if (state.humanAvatarError) {
          publicHumanAvatarNote.hidden = false;
          publicHumanAvatarNote.dataset.tone = "error";
          publicHumanAvatarNote.textContent = state.humanAvatarError;
        } else if (state.humanAvatarLoadingAssetId) {
          publicHumanAvatarNote.hidden = false;
          publicHumanAvatarNote.dataset.tone = "";
          publicHumanAvatarNote.textContent = "正在读取本机关联人类草稿头像…";
        } else {
          publicHumanAvatarNote.hidden = true;
          publicHumanAvatarNote.textContent = "";
          delete publicHumanAvatarNote.dataset.tone;
        }
      }
      if (!publicDraftLoadCapable) {
        publicDraftStatus.hidden = false;
        publicDraftStatus.dataset.tone = "error";
        publicDraftStatus.textContent = "当前宿主没有提供公开草稿读取，编辑与发布暂不可用。";
        publicDraftBanner.textContent = "当前宿主不支持公开草稿";
        publicDraftBanner.dataset.tone = "error";
        settingsHumanStatus.textContent = "草稿不可用";
        publicPublishStatus.textContent = "不可用";
        publicPublishReceipt.hidden = true;
        renderPublicVersionPreview();
        renderProfileTechDetails();
        return;
      }
      const hasSavedDraft = Boolean(state.draft && !state.fromFallback);
      const statusText = state.loading !== null
        ? "读取中"
        : state.publishing ? "发布中"
          : state.draft?.publishedSha256 ? "已发布过"
            : hasSavedDraft ? "草稿" : "尚未创建";
      if (publicDraftBanner) {
        publicDraftBanner.dataset.tone = state.error ? "error" : state.confirm ? "ready" : hasSavedDraft ? "ready" : "unavailable";
        publicDraftBanner.dataset.debounce = "draft-save-debounce";
        publicDraftBanner.textContent = state.publishing
          ? "正在发布 · 等待真实公开回执"
          : state.confirm
            ? "已检查当前内容 · 等待确认发布"
            : state.dirty || state.saving
              ? "有未保存修改 · 草稿仅本机可见"
              : state.draft?.publishedSha256
                ? "已发布公开版本 · 新修改不会自动公开"
                : hasSavedDraft
                  ? "草稿仅本机可见 · 不会自动发布"
                  : "尚未创建草稿 · 保存后只写入本机";
      }
      const agentStatus = root.querySelector("#settingsPublicAgentStatus");
      const humanStatus = root.querySelector("#settingsHumanStatus");
      if (agentStatus) agentStatus.textContent = statusText;
      if (humanStatus) humanStatus.textContent = statusText;
      const lines = [];
      if (state.error) lines.push(state.error);
      if (state.conflict) lines.push("草稿已在别处更新；本机输入已保留，请重新载入最新草稿或复制修改后再保存。");
      if (state.confirmNotice && !state.confirm) lines.push(state.confirmNotice);
      if (state.confirm && state.confirmNotice) lines.push(state.confirmNotice);
      if (state.reloadArmed) lines.push("未保存的修改会丢失。再次点击“确认放弃修改并重新载入”继续。");
      if (state.saving) lines.push("正在保存本机草稿…");
      else if (state.dirty) lines.push("有未保存修改；草稿仅本机可见。");
      else if (hasSavedDraft) {
        const savedAt = state.draft.updatedAtUnixMs ? ` · ${formatDateTime(new Date(state.draft.updatedAtUnixMs).toISOString())}` : "";
        const published = Boolean(state.draft.publishedSha256);
        const sameAsPublished = published && Number(state.draft.publishedRevision) === Number(state.draft.revision);
        if (sameAsPublished) {
          lines.push(`当前草稿已发布为公开版本${savedAt}。`);
        } else if (published) {
          lines.push(`草稿已保存${savedAt}。新修改仅本机可见，尚未发布。`);
        } else {
          lines.push(`草稿已保存${savedAt}。仅本机可见，尚未发布。`);
        }
      } else if (!state.loading) {
        lines.push(state.draft
          ? "尚未创建本机草稿；当前内容来自已有公开资料或空白表单，保存后只写入本机。"
          : "还没有公开资料草稿。填写后点击“保存草稿”。");
      }
      const visible = lines.filter(Boolean);
      publicDraftStatus.hidden = visible.length === 0;
      publicDraftStatus.dataset.tone = state.error || state.conflict ? "error" : state.dirty || state.saving ? "unavailable" : "ready";
      publicDraftStatus.textContent = visible.join(" ");
      const hasNewerDraft = Boolean(state.draft?.publishedSha256
        && Number(state.draft.publishedRevision) !== Number(state.draft.revision));
      publicPublishStatus.textContent = state.publishing
        ? "正在发布…"
        : state.confirm ? "等待确认"
          : state.conflict ? "发布冲突"
            : state.receipt && (state.receipt.status === "published" || state.receipt.status === "already_published")
              ? hasNewerDraft ? "已发布 · 有新草稿" : "已发布"
              : state.receipt ? "发布未完成"
                : state.draft?.publishedSha256 ? "已发布版本" : "尚未发布";
      if (state.confirm && !state.receipt) {
        publicPublishReceipt.hidden = false;
        publicPublishReceipt.dataset.tone = "unavailable";
        const imageStateText = (clear, file, assetId, draftImage) => clear
          ? "已移除"
          : file ? "新图片待保存"
            : assetId || draftImage ? "已设置" : "使用默认形象";
        publicPublishReceipt.textContent = `将以关联人类“${publicHumanName.value.trim() || "未填写"}”与 Agent“${publicAgentName.value.trim() || "未命名"}”发布当前内容；Agent 头像：${imageStateText(state.avatarClear, state.avatarFile, state.avatarAssetId, state.draft?.avatar)}，关联人类头像：${imageStateText(state.humanAvatarClear, state.humanAvatarFile, state.humanAvatarAssetId, state.draft?.humanAvatar)}。确认后才会公开。`;
      } else if (state.receipt) {
        publicPublishReceipt.hidden = false;
        publicPublishReceipt.dataset.tone = state.receipt.status === "published" || state.receipt.status === "already_published" ? "ready" : "error";
        publicPublishReceipt.textContent = profilePublishReceiptText(state.receipt)
          + (hasNewerDraft ? " 发布后又保存了新草稿；它尚未公开。" : "");
      } else {
        publicPublishReceipt.hidden = true;
      }
      renderPublicVersionPreview();
      renderProfileTechDetails();
    }

    function profileDraftErrorText(error) {
      const message = errorText(error);
      if (/image_(?:type|decode)|只支持 PNG|PNG 或 JPEG|图片(?:内容|头部)?.*(?:损坏|截断|解码|格式)/i.test(message)) {
        return "头像图片无法识别、已损坏或格式不一致；请选择有效的 PNG 或 JPEG 图片。";
      }
      if (/image_size|超过上限|超过.*MiB/i.test(message)) {
        return "头像图片过大（上限 4 MiB）；请压缩后重试。";
      }
      if (/image_dimensions|超过单边|总像素|像素上限/i.test(message)) {
        return "头像尺寸超出限制（单边不超过 4096 像素）；请缩小后重试。";
      }
      return /conflict|冲突|已在别处|failed_precondition/i.test(message)
        ? "草稿已在别处更新，本地输入已保留；请重新载入最新草稿或复制修改后再保存。"
        : message;
    }

    function ensureProfileDraft(force = false) {
      if (!publicDraftLoadCapable) {
        renderProfileDraftStatus();
        return Promise.resolve(null);
      }
      if (profileDraftState.loading !== null) return profileDraftState.loading;
      if (profileDraftState.loaded && !force) {
        renderProfileDraftStatus();
        return Promise.resolve(profileDraftState.draft);
      }
      const seq = ++profileDraftState.loadingSeq;
      const formVersionAtStart = profileDraftState.formVersion;
      const promise = (async () => {
        try {
          const result = await options.onLoadPublicDraft("profile");
          if (destroyed || seq !== profileDraftState.loadingSeq) return null;
          if (result?.error) throw new Error(result.error);
          const hasSavedDraft = Boolean(result?.found && result.draft);
          let draft = hasSavedDraft ? result.draft : null;
          if (!hasSavedDraft && mineCapable && mineState.data === null) {
            // The synthesized form must start from the owner's real public
            // values, not an empty shell that a fast reader could save over.
            await loadMine(false);
            if (destroyed || seq !== profileDraftState.loadingSeq) return null;
          }
          if (!hasSavedDraft) draft = fallbackProfileDraft();
          profileDraftState.draft = draft;
          profileDraftState.loaded = true;
          profileDraftState.fromFallback = !hasSavedDraft;
          profileDraftState.error = "";
          profileDraftState.conflict = false;
          profileDraftState.reloadArmed = false;
          // A late load must never overwrite input made while it was in flight.
          // Keep the newer local form and mark the discrepancy instead of
          // calling setProfileForm(), which would also reset the avatar picker.
          if (profileDraftState.formVersion !== formVersionAtStart && profileDraftState.dirty) {
            profileDraftState.confirmNotice = "草稿已在后台重新载入；载入期间的新输入仍保留，请再次保存。";
            return profileDraftState.draft;
          }
          setProfileForm(draft);
        } catch (error) {
          if (destroyed || seq !== profileDraftState.loadingSeq) return null;
          profileDraftState.error = profileDraftErrorText(error);
          profileDraftState.loaded = true;
          if (!profileDraftState.draft) {
            const fallback = fallbackProfileDraft();
            profileDraftState.draft = fallback;
            profileDraftState.fromFallback = true;
            setProfileForm(fallback);
          }
        } finally {
          if (!destroyed && seq === profileDraftState.loadingSeq) {
            profileDraftState.loading = null;
            renderProfileDraftStatus();
          }
        }
        return profileDraftState.draft;
      })();
      profileDraftState.loading = promise;
      renderProfileDraftStatus();
      return promise;
    }

    function profileRequestValues() {
      return {
        values: profileFormValues(),
        avatarFile: profileDraftState.avatarFile,
        avatarAssetId: profileDraftState.avatarClear ? "" : profileDraftState.avatarAssetId,
        clearAvatar: profileDraftState.avatarClear === true,
        humanAvatarFile: profileDraftState.humanAvatarFile,
        humanAvatarAssetId: profileDraftState.humanAvatarClear ? "" : profileDraftState.humanAvatarAssetId,
        clearHumanAvatar: profileDraftState.humanAvatarClear === true,
        version: profileDraftState.formVersion
      };
    }

    async function saveProfileDraftOnce(expectedRevision, images, values) {
      const result = await options.onSavePublicDraft({
        draftId: "profile", kind: "profile", expectedRevision,
        ...values,
        avatarAssetId: images.avatarAssetId || "",
        clearAvatar: images.clearAvatar === true,
        humanAvatarAssetId: images.humanAvatarAssetId || "",
        clearHumanAvatar: images.clearHumanAvatar === true,
        imageAssetIds: [],
        tags: []
      });
      if (!result?.draft) throw new Error("保存草稿没有返回结果");
      return result.draft;
    }

    function dataUrlToFile(dataUrl, name, mime) {
      const value = String(dataUrl || "");
      const comma = value.indexOf(",");
      if (comma < 0 || !/;base64/i.test(value.slice(0, comma))) throw new Error("已公开头像不是有效的 base64 图片");
      const bytes = base64ToBytes(value.slice(comma + 1));
      if (bytes.length === 0) throw new Error("已公开头像为空");
      const FileCtor = win.File ?? globalThis.File;
      if (typeof FileCtor !== "function") throw new Error("当前环境无法把已公开头像转为本机草稿图片");
      return new FileCtor([bytes], name || "avatar.png", { type: mime || "image/png" });
    }

    function draftImageIsHuman(kind) {
      return kind === "human";
    }
    function draftImageField(kind) {
      return draftImageIsHuman(kind) ? "humanAvatar" : "avatar";
    }
    function draftImageSelection(kind) {
      const human = draftImageIsHuman(kind);
      return {
        human,
        file: human ? profileDraftState.humanAvatarFile : profileDraftState.avatarFile,
        assetId: human ? profileDraftState.humanAvatarAssetId : profileDraftState.avatarAssetId,
        clear: human ? profileDraftState.humanAvatarClear : profileDraftState.avatarClear,
        loadingAssetId: human ? profileDraftState.humanAvatarLoadingAssetId : profileDraftState.avatarLoadingAssetId
      };
    }
    function bumpDraftImageToken(kind) {
      if (draftImageIsHuman(kind)) {
        profileDraftState.humanAvatarRestoreToken += 1;
        return profileDraftState.humanAvatarRestoreToken;
      }
      profileDraftState.avatarRestoreToken += 1;
      return profileDraftState.avatarRestoreToken;
    }
    function draftImageToken(kind) {
      return draftImageIsHuman(kind) ? profileDraftState.humanAvatarRestoreToken : profileDraftState.avatarRestoreToken;
    }
    function applyDraftImageFile(kind, { file, previewUrl, objectUrl = false, assetId = "" }) {
      if (draftImageIsHuman(kind)) {
        releaseProfileHumanAvatarPreview();
        profileDraftState.humanAvatarFile = file;
        profileDraftState.humanAvatarPreviewUrl = previewUrl;
        profileDraftState.humanAvatarPreviewObject = objectUrl;
        profileDraftState.humanAvatarPreviewAssetId = "";
        profileDraftState.humanAvatarAssetId = assetId;
        profileDraftState.humanAvatarClear = false;
        profileDraftState.humanAvatarError = "";
        profileDraftState.humanAvatarLoadingAssetId = "";
        renderProfileHumanAvatar();
        return;
      }
      releaseProfileAvatarPreview();
      profileDraftState.avatarFile = file;
      profileDraftState.avatarPreviewUrl = previewUrl;
      profileDraftState.avatarPreviewObject = objectUrl;
      profileDraftState.avatarPreviewAssetId = "";
      profileDraftState.avatarAssetId = assetId;
      profileDraftState.avatarClear = false;
      profileDraftState.avatarError = "";
      profileDraftState.avatarLoadingAssetId = "";
      renderProfileAvatar();
    }
    async function readPublishedAvatarFile(avatar) {
      if (!avatar?.path) throw new Error("已公开头像没有路径");
      if (!mineFileContentCapable) throw new Error("当前宿主没有提供本机公开头像读取；请重新选择头像或移除头像后再保存。");
      const avatarSha = String(avatar.sha256 || "").toLowerCase();
      const file = mineState.data?.files?.find((item) => item.path === avatar.path
        && (!avatarSha || String(item.sha256 || "").toLowerCase() === avatarSha)) ?? null;
      if (!file) throw new Error("已公开头像不在本机发布清单中；请重新选择头像或移除头像后再保存。");
      const preview = await options.onLoadMineFileContent(avatar.path, file.sha256 || avatar.sha256, file.sizeBytes);
      return { file, preview };
    }

    /** Import one independent published image into the same private draft.
     * Agent and human images never share selection, preview or token state. */
    async function importPublishedAvatarForDraft(kind = "agent") {
      const human = draftImageIsHuman(kind);
      const field = draftImageField(kind);
      const draft = profileDraftState.draft;
      const avatar = draft?.[field];
      const selection = draftImageSelection(kind);
      if (!avatar?.path || avatar.assetId || selection.file
        || selection.assetId || selection.clear) return false;
      const version = profileDraftState.formVersion;
      const token = bumpDraftImageToken(kind);
      const avatarPath = avatar.path;
      const avatarSha = String(avatar.sha256 || "").toLowerCase();
      const stillCurrent = () => !destroyed
        && token === draftImageToken(kind)
        && profileDraftState.draft === draft
        && version === profileDraftState.formVersion
        && !draftImageSelection(kind).file
        && !draftImageSelection(kind).assetId
        && !draftImageSelection(kind).clear
        && String(profileDraftState.draft?.[field]?.path || "") === avatarPath
        && String(profileDraftState.draft?.[field]?.sha256 || "").toLowerCase() === avatarSha;
      try {
        const { file, preview } = await readPublishedAvatarFile(avatar);
        if (!stillCurrent()) return false;
        if (preview?.status !== "ok" || preview.kind !== "image" || !preview.dataUrl) {
          throw new Error(preview?.error || "已公开头像读取失败；请重新选择头像或移除头像后再保存。");
        }
        applyDraftImageFile(kind, {
          file: dataUrlToFile(preview.dataUrl, file.name || avatarPath.split("/").pop(), preview.mime || avatar.mime),
          previewUrl: preview.dataUrl
        });
        return true;
      } catch (error) {
        if (stillCurrent()) throw error;
        return false;
      }
    }

    async function importPublishedAvatarsForDraft() {
      const results = await Promise.allSettled([
        importPublishedAvatarForDraft("agent"),
        importPublishedAvatarForDraft("human")
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }

    /** Restore one published image after `setProfileForm()`. The restore token
     * is bumped by any newer form load, pick or removal, so a late success or
     * rejection can only write into the exact edit state that requested it. */
    async function restorePublishedAvatarForDraft(kind, avatar, token) {
      if (!avatar?.path) return false;
      const human = draftImageIsHuman(kind);
      const field = draftImageField(kind);
      const avatarPath = avatar.path;
      const avatarSha = String(avatar.sha256 || "").toLowerCase();
      const stillCurrent = () => !destroyed
        && token === draftImageToken(kind)
        && !draftImageSelection(kind).file
        && !draftImageSelection(kind).assetId
        && !draftImageSelection(kind).clear
        && String(profileDraftState.draft?.[field]?.path || "") === avatarPath
        && String(profileDraftState.draft?.[field]?.sha256 || "").toLowerCase() === avatarSha;
      try {
        const { file, preview } = await readPublishedAvatarFile(avatar);
        if (!stillCurrent()) return false;
        if (preview?.status !== "ok" || preview.kind !== "image" || !preview.dataUrl) {
          throw new Error(preview?.error || "已公开头像读取失败");
        }
        applyDraftImageFile(kind, {
          file: dataUrlToFile(preview.dataUrl, file.name || avatarPath.split("/").pop(), preview.mime || avatar.mime),
          previewUrl: preview.dataUrl
        });
        return true;
      } catch (error) {
        if (!stillCurrent()) return false;
        if (human) {
          profileDraftState.humanAvatarError = `${errorText(error)}；请重新选择关联人类头像后再发布。`;
        } else {
          profileDraftState.avatarError = `${errorText(error)}；请重新选择头像后再发布。`;
        }
        return false;
      }
    }

    async function saveProfileDraft({ manual = false } = {}) {
      if (!publicDraftSaveCapable) {
        profileDraftState.error = "当前宿主没有提供公开草稿保存。";
        renderProfileDraftStatus();
        return null;
      }
      if (profileDraftState.publishing) return null;
      if (profileDraftState.saving) {
        profileDraftState.queuedSave = true;
        return profileDraftState.savingPromise;
      }
      if (profileDraftState.conflict && !manual) {
        renderProfileDraftStatus();
        return profileDraftState.draft;
      }
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      if (profileDraftState.confirm) {
        invalidateProfileConfirm("草稿开始保存；旧确认已撤销，请重新检查发布内容。");
      }
      profileDraftState.saving = true;
      profileDraftState.error = "";
      profileDraftState.reloadArmed = false;
      renderProfileDraftStatus();
      const promise = (async () => {
        let request = null;
        let baseline = null;
        let beforeDraftAvatar = null;
        let beforeDraftHumanAvatar = null;
        let imagePhase = "";
        try {
          await importPublishedAvatarsForDraft();
          if (destroyed) return profileDraftState.draft;
          request = profileRequestValues();
          beforeDraftAvatar = profileDraftState.draft?.avatar || null;
          beforeDraftHumanAvatar = profileDraftState.draft?.humanAvatar || null;
          const draft = profileDraftState.draft;
          let agentAssetId = request.avatarAssetId;
          let clearAgentAvatar = request.clearAvatar;
          let humanAssetId = request.humanAvatarAssetId;
          let clearHumanAvatar = request.clearHumanAvatar;
          let saved = await saveProfileDraftOnce(draft?.revision || 0, {
            avatarAssetId: agentAssetId,
            clearAvatar: clearAgentAvatar,
            humanAvatarAssetId: humanAssetId,
            clearHumanAvatar
          }, request.values);
          // The text save already advanced the server revision. Make it the
          // retry baseline before any upload/second save can fail.
          baseline = saved;
          adoptProfileDraftBaseline(saved);
          if (request.avatarFile) {
            imagePhase = "agent";
            if (!publicDraftImageCapable) throw new Error("当前宿主不支持上传草稿头像");
            const base64 = await fileToBase64(request.avatarFile);
            const uploaded = await options.onPutPublicDraftImage(saved.draftId, "avatar", request.avatarFile.name, base64);
            if (!uploaded?.image?.assetId) throw new Error("头像上传没有返回资源");
            agentAssetId = uploaded.image.assetId;
            clearAgentAvatar = false;
            saved = await saveProfileDraftOnce(saved.revision, {
              avatarAssetId: agentAssetId,
              clearAvatar: false,
              humanAvatarAssetId: humanAssetId,
              clearHumanAvatar
            }, request.values);
            baseline = saved;
            adoptProfileDraftBaseline(saved);
            if (request.version === profileDraftState.formVersion && profileDraftState.avatarFile === request.avatarFile) {
              profileDraftState.avatarAssetId = agentAssetId;
              profileDraftState.avatarFile = null;
              profileDraftState.avatarClear = false;
            }
          }
          if (request.humanAvatarFile) {
            imagePhase = "human";
            if (!publicDraftImageCapable) throw new Error("当前宿主不支持上传草稿人类头像");
            const base64 = await fileToBase64(request.humanAvatarFile);
            const uploaded = await options.onPutPublicDraftImage(saved.draftId, "human_avatar", request.humanAvatarFile.name, base64);
            if (!uploaded?.image?.assetId) throw new Error("关联人类头像上传没有返回资源");
            humanAssetId = uploaded.image.assetId;
            clearHumanAvatar = false;
            saved = await saveProfileDraftOnce(saved.revision, {
              avatarAssetId: agentAssetId,
              clearAvatar: clearAgentAvatar,
              humanAvatarAssetId: humanAssetId,
              clearHumanAvatar: false
            }, request.values);
            baseline = saved;
            adoptProfileDraftBaseline(saved);
            if (request.version === profileDraftState.formVersion && profileDraftState.humanAvatarFile === request.humanAvatarFile) {
              profileDraftState.humanAvatarAssetId = humanAssetId;
              profileDraftState.humanAvatarFile = null;
              profileDraftState.humanAvatarClear = false;
            }
          }
          profileDraftState.draft = saved;
          profileDraftState.fromFallback = false;
          profileDraftState.conflict = false;
          profileDraftState.confirmNotice = "";
          profileDraftState.dirty = !profileDraftMatchesCurrent(saved);
          if (!profileDraftState.dirty) {
            profileDraftState.error = "";
            if (!profileDraftState.avatarFile) profileDraftState.avatarAssetId = saved.avatar?.assetId || "";
            if (!profileDraftState.humanAvatarFile) profileDraftState.humanAvatarAssetId = saved.humanAvatar?.assetId || "";
            profileDraftState.avatarClear = false;
            profileDraftState.humanAvatarClear = false;
          }
        } catch (error) {
          const message = profileDraftErrorText(error);
          const raw = String(error?.message ?? error);
          const imageFailure = /image_(?:type|decode|size|dimensions)|只支持 PNG|PNG 或 JPEG|图片.*(?:损坏|截断|解码|格式|尺寸|像素)/i.test(raw);
          profileDraftState.error = message;
          profileDraftState.conflict = /冲突|已在别处|conflict|failed_precondition/i.test(raw);
          // Keep the old image on screen when a failed upload/second save
          // happens under the same selection. A newer pick or removal wins,
          // and the two images recover independently.
          if (baseline && request && profileAvatarSelectionMatches(request)) {
            restoreProfileAvatarFromDraft(baseline, beforeDraftAvatar);
          }
          if (baseline && request && profileHumanAvatarSelectionMatches(request)) {
            restoreProfileHumanAvatarFromDraft(baseline, beforeDraftHumanAvatar);
          }
          if (imageFailure) {
            if (imagePhase === "human") profileDraftState.humanAvatarError = message;
            else if (imagePhase === "agent") profileDraftState.avatarError = message;
            else {
              profileDraftState.avatarError = message;
              profileDraftState.humanAvatarError = message;
            }
          }
          profileDraftState.dirty = !baseline || !profileDraftMatchesCurrent();
        } finally {
          profileDraftState.saving = false;
          const retry = profileDraftState.queuedSave
            || (profileDraftState.dirty && !profileDraftState.error && !profileDraftState.conflict && !profileDraftState.publishing);
          profileDraftState.queuedSave = false;
          if (!destroyed) {
            renderProfileAvatar();
            renderProfileHumanAvatar();
            renderProfileDraftStatus();
            if (retry) queueProfileSave(350);
          }
        }
        return profileDraftState.draft;
      })();
      profileDraftState.savingPromise = promise;
      return promise;
    }

    function queueProfileSave(delay = 600) {
      if (profileSaveTimer !== null) win.clearTimeout(profileSaveTimer);
      profileSaveTimer = win.setTimeout(() => {
        profileSaveTimer = null;
        if (!destroyed) void saveProfileDraft();
      }, delay);
    }

    function scheduleProfileSave() {
      profileDraftState.formVersion += 1;
      profileDraftState.dirty = true;
      profileDraftState.reloadArmed = false;
      if (profileDraftState.conflict) {
        renderProfileDraftStatus();
        return;
      }
      profileDraftState.error = "";
      if (profileDraftState.confirm) {
        invalidateProfileConfirm("内容已修改；旧确认已撤销，请重新检查发布内容。");
      }
      renderProfileDraftStatus();
      if (!publicDraftSaveCapable) return;
      queueProfileSave(600);
    }

    function invalidateProfileConfirm(message = "") {
      if (!profileDraftState.confirm && !message) return;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      if (message) profileDraftState.confirmNotice = message;
      if (publicPublishButton) publicPublishButton.textContent = "检查发布内容";
      if (publicPublishCancel) publicPublishCancel.hidden = true;
      renderProfileDraftStatus();
    }

    function profilePublishSnapshot() {
      return JSON.stringify({
        version: profileDraftState.formVersion,
        revision: Number(profileDraftState.draft?.revision) || 0,
        publishedSha256: String(profileDraftState.draft?.publishedSha256 || "").toLowerCase(),
        draftId: profileDraftState.draft?.draftId || "profile",
        values: profileFormValues(),
        avatarAssetId: profileDraftState.avatarClear ? "" : profileDraftState.avatarAssetId,
        avatarClear: profileDraftState.avatarClear === true,
        avatarFile: profileDraftState.avatarFile
          ? [profileDraftState.avatarFile.name, profileDraftState.avatarFile.size, profileDraftState.avatarFile.lastModified]
          : null,
        humanAvatarAssetId: profileDraftState.humanAvatarClear ? "" : profileDraftState.humanAvatarAssetId,
        humanAvatarClear: profileDraftState.humanAvatarClear === true,
        humanAvatarFile: profileDraftState.humanAvatarFile
          ? [profileDraftState.humanAvatarFile.name, profileDraftState.humanAvatarFile.size, profileDraftState.humanAvatarFile.lastModified]
          : null
      });
    }

    async function flushProfileDraftForPublish() {
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (profileDraftState.saving) {
          await profileDraftState.savingPromise;
          continue;
        }
        if (profileDraftState.conflict) throw new Error("草稿已在别处更新，不能直接发布；请重新载入最新草稿后再检查。");
        try {
          await importPublishedAvatarsForDraft();
        } catch (error) {
          throw new Error(`${errorText(error)} 未保存为草稿，发布也不会丢弃旧头像。`);
        }
        if (profileDraftState.avatarFile || profileDraftState.humanAvatarFile) profileDraftState.dirty = true;
        if (!profileDraftState.dirty && profileDraftState.draft) return profileDraftState.draft;
        await saveProfileDraft({ manual: true });
        if (profileDraftState.conflict) throw new Error("草稿已在别处更新，不能直接发布；本机输入已保留。");
        if (profileDraftState.error) throw new Error(profileDraftState.error);
        if (!profileDraftState.dirty && profileDraftState.draft) return profileDraftState.draft;
      }
      throw new Error("当前修改还没有保存完成；请检查本机草稿状态后再发布。");
    }

    async function publishProfileNow() {
      if (!publishDraftCapable) {
        profileDraftState.error = "当前宿主没有提供公开发布。";
        renderProfileDraftStatus();
        return;
      }
      const draft = profileDraftState.draft;
      if (!draft) {
        profileDraftState.error = "没有可发布的草稿。";
        renderProfileDraftStatus();
        return;
      }
      const seq = ++profileDraftState.publishSeq;
      profileDraftState.publishing = true;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      profileDraftState.confirmNotice = "";
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      renderProfileDraftStatus();
      try {
        const receipt = await options.onPublishPublicDraft(draft.draftId, draft.revision, draft.publishedSha256 || "");
        if (destroyed || seq !== profileDraftState.publishSeq) return;
        profileDraftState.receipt = receipt;
        if (receipt.status === "published" || receipt.status === "already_published") {
          profileDraftState.draft = {
            ...draft,
            publishedSha256: receipt.currentPublishedSha256 || draft.publishedSha256,
            publishedRevision: receipt.currentRevision || draft.revision,
            publishedPath: receipt.profilePath || draft.publishedPath
          };
          profileDraftState.dirty = !profileDraftMatchesCurrent(profileDraftState.draft);
          profileDraftState.conflict = false;
          profileDraftState.error = "";
          profileDraftState.confirmNotice = "";
          void loadMine(true).then(() => {
            if (!destroyed && currentPage === "settings" && view.settings.tab === "public") {
              renderProfileDraftStatus();
            }
          });
        } else if (receipt.status === "conflict") {
          profileDraftState.conflict = true;
          profileDraftState.error = receipt.error || "发布冲突；本地草稿未覆盖公开文件。";
        } else {
          profileDraftState.error = receipt.error || "发布没有完成；本机草稿和输入均保留。";
        }
      } catch (error) {
        if (destroyed || seq !== profileDraftState.publishSeq) return;
        profileDraftState.error = profileDraftErrorText(error);
        profileDraftState.conflict = /冲突|已在别处|conflict|failed_precondition/i.test(String(error?.message ?? error));
      } finally {
        if (!destroyed && seq === profileDraftState.publishSeq) {
          profileDraftState.publishing = false;
          renderProfileDraftStatus();
          publicPublishButton.focus?.({ preventScroll: true });
        }
      }
    }

    async function requestProfilePublish() {
      if (profileDraftState.publishing) return;
      if (profileDraftState.confirm) {
        const snapshot = profilePublishSnapshot();
        if (snapshot !== profileDraftState.confirmSnapshot) {
          invalidateProfileConfirm("内容或草稿版本已变化；旧确认无效，请重新检查发布内容。");
          return;
        }
        await publishProfileNow();
        return;
      }
      try {
        await flushProfileDraftForPublish();
      } catch (error) {
        profileDraftState.error = errorText(error);
        renderProfileDraftStatus();
        return;
      }
      if (!profileDraftState.draft) {
        profileDraftState.error = "没有可检查的草稿。";
        renderProfileDraftStatus();
        return;
      }
      profileDraftState.receipt = null;
      profileDraftState.confirm = true;
      profileDraftState.confirmSnapshot = profilePublishSnapshot();
      profileDraftState.confirmNotice = "";
      renderProfileDraftStatus();
      publicPublishButton.focus?.({ preventScroll: true });
    }

    function handleProfileReload() {
      if (!publicDraftLoadCapable || profileDraftState.saving || profileDraftState.publishing) return;
      const hasLocalChanges = profileDraftState.dirty || profileDraftState.avatarFile !== null
        || profileDraftState.humanAvatarFile !== null
        || profileDraftState.confirm || profileDraftState.reloadArmed;
      if (hasLocalChanges && !profileDraftState.reloadArmed) {
        profileDraftState.reloadArmed = true;
        invalidateProfileConfirm("");
        renderProfileDraftStatus();
        return;
      }
      // Confirmed discard: cancel the queued autosave, not only the visible
      // dirty flag. Otherwise that timer can still write the abandoned text and
      // advance the draft revision after the new copy has loaded.
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      profileDraftState.queuedSave = false;
      profileDraftState.reloadArmed = false;
      profileDraftState.dirty = false;
      profileDraftState.error = "";
      profileDraftState.conflict = false;
      profileDraftState.receipt = null;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      profileDraftState.confirmNotice = "";
      profileDraftState.loaded = false;
      profileDraftState.loadingSeq += 1;
      void ensureProfileDraft(true);
    }

    async function restorePublishedProfile() {
      const published = currentPublishedProfile();
      if (!published || profileDraftState.publishing || profileDraftState.saving) return;
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      const restored = {
        draftId: "profile", kind: "profile", revision: profileDraftState.draft?.revision || 0,
        agentName: published.agentName,
        agentDescription: published.agentDescription,
        agentInterests: [...published.agentInterests],
        agentConversationStyle: published.agentConversationStyle,
        humanName: published.humanName,
        humanBioMarkdown: published.humanBioMarkdown,
        avatar: published.avatarPath
          ? { assetId: "", sha256: published.avatarSha256, mime: published.avatarMime, path: published.avatarPath }
          : null,
        humanAvatar: published.humanAvatarPath
          ? { assetId: "", sha256: published.humanAvatarSha256, mime: published.humanAvatarMime, path: published.humanAvatarPath }
          : null,
        publishedSha256: profileDraftState.draft?.publishedSha256 || "",
        publishedRevision: profileDraftState.draft?.publishedRevision || 0,
        publishedPath: profileDraftState.draft?.publishedPath || ""
      };
      const hadSavedDraft = Boolean(profileDraftState.draft && !profileDraftState.fromFallback);
      setProfileForm(restored);
      profileDraftState.draft = {
        ...(profileDraftState.draft || restored),
        avatar: restored.avatar,
        humanAvatar: restored.humanAvatar
      };
      // setProfileForm bumped both tokens. Capture fresh restore tokens before
      // starting either read; any later load/pick/removal invalidates them.
      const agentToken = bumpDraftImageToken("agent");
      const humanToken = bumpDraftImageToken("human");
      if (!restored.avatar) {
        profileDraftState.avatarClear = true;
        profileDraftState.avatarFile = null;
        profileDraftState.avatarAssetId = "";
      }
      if (!restored.humanAvatar) {
        profileDraftState.humanAvatarClear = true;
        profileDraftState.humanAvatarFile = null;
        profileDraftState.humanAvatarAssetId = "";
      }
      profileDraftState.formVersion += 1;
      profileDraftState.dirty = true;
      profileDraftState.fromFallback = !hadSavedDraft;
      profileDraftState.reloadArmed = false;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      profileDraftState.confirmNotice = "已恢复公开版本；保存后成为本机草稿。";
      renderProfileAvatar();
      renderProfileHumanAvatar();
      renderHumanPreview();
      renderProfileDraftStatus();
      publicDraftStatus.scrollIntoView?.({ block: "nearest" });
      await Promise.all([
        restorePublishedAvatarForDraft("agent", restored.avatar, agentToken),
        restorePublishedAvatarForDraft("human", restored.humanAvatar, humanToken)
      ]);
      if (!destroyed && profileDraftState.draft) {
        renderProfileDraftStatus();
      }
    }

    function postFormValues() {
      return {
        title: postTitleInput.value,
        bodyMarkdown: postBodyInput.value,
        tags: splitList(postTagsInput.value),
        authorKind: postAuthorKind.value === "agent" ? "agent" : "user"
      };
    }
    function samePostFormValues(left, right) {
      if (!left || !right) return false;
      return left.title === right.title && left.bodyMarkdown === right.bodyMarkdown && left.authorKind === right.authorKind && left.tags.join("\0") === right.tags.join("\0");
    }
    function clonePostDraft(draft) {
      if (!draft || typeof draft !== "object") return null;
      try {
        return JSON.parse(JSON.stringify(draft));
      } catch {
        return { ...draft, images: Array.isArray(draft.images) ? [...draft.images] : [] };
      }
    }
    function postEditorViewSnapshot() {
      const values = postFormValues();
      return { draft: clonePostDraft(postEditorState.draft), values: { ...values, tags: [...values.tags] }, dirty: postEditorState.dirty };
    }
    function restorePostEditorView(snapshot) {
      if (!snapshot) return false;
      postEditorState.draft = clonePostDraft(snapshot.draft);
      postEditorState.draftEpoch += 1;
      postEditorState.formVersion += 1;
      setPostForm(postEditorState.draft);
      postTitleInput.value = snapshot.values.title;
      postBodyInput.value = snapshot.values.bodyMarkdown;
      postTagsInput.value = snapshot.values.tags.join("，");
      postAuthorKind.value = snapshot.values.authorKind === "agent" ? "agent" : "user";
      postAuthorKind.disabled = Boolean(postEditorState.draft?.publishedPath);
      postImageInput.disabled = isLegacyV1PostPath(postEditorState.draft?.publishedPath);
      postEditorState.dirty = snapshot.dirty;
      postEditorState.receipt = null;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      renderPostAuthorNote();
      renderPostImages();
      renderPostDraftList();
      renderPostEditorStatus();
      return true;
    }
    function postEditorSnapshot() {
      const values = postFormValues();
      const draft = postEditorState.draft;
      return JSON.stringify({
        draftId: draft?.draftId || "",
        revision: Number(draft?.revision) || 0,
        publishedPath: draft?.publishedPath || "",
        publishedSha256: String(draft?.publishedSha256 || "").toLowerCase(),
        title: values.title,
        bodyMarkdown: values.bodyMarkdown,
        tags: values.tags,
        authorKind: values.authorKind,
        images: (draft?.images || []).map((image) => [
          image.assetId,
          String(image.sha256 || "").toLowerCase(),
          Number(image.sizeBytes) || 0
        ]),
        pending: postEditorState.pending.map((pending) => [
          pending.file.name,
          pending.file.size,
          pending.file.lastModified
        ])
      });
    }
    function postConfirmationTarget(draft = postEditorState.draft) {
      const publishedPath = String(draft?.publishedPath || "").trim();
      if (publishedPath) return publishedPath;
      const draftId = String(draft?.draftId || "").trim();
      if (!draftId) return "";
      return `posts/${draftId.replace(/^draft-/, "post-")}/post.json`;
    }
    function isLegacyV1PostPath(value) {
      return /^posts\/[A-Za-z0-9._-]+\.json$/.test(String(value ?? ""));
    }
    function updatePostEditorHeading(draft = postEditorState.draft) {
      const editing = Boolean(draft?.publishedPath);
      postEditorHeading.textContent = editing ? "编辑公开动态" : "写一条公开动态";
      postEditorPanel.dataset.mode = editing ? "edit" : "new";
    }
    function setPostForm(draft) {
      releaseDraftAssetScope("post");
      postTitleInput.value = draft?.title || "";
      postBodyInput.value = draft?.bodyMarkdown || "";
      postTagsInput.value = (draft?.tags || []).join("，");
      postAuthorKind.value = draft?.authorKind === "agent" ? "agent" : "user";
      postAuthorKind.disabled = Boolean(draft?.publishedPath);
      postImageInput.disabled = isLegacyV1PostPath(draft?.publishedPath);
      postEditorState.imported = Boolean(draft?.publishedPath);
      postEditorState.dirty = false;
      if (postSaveAsNew) postSaveAsNew.hidden = true;
      if (postWriteAnother) postWriteAnother.hidden = true;
      updatePostEditorHeading(draft);
      renderPostAuthorNote();
      renderPostImages();
    }
    function renderPostAuthorNote() {
      const agentName = mineState.data?.agentCard?.state === "available" ? mineState.data.agentCard.card?.displayName : "";
      const humanName = mineState.data?.profile?.displayName || mineState.data?.publicProfile?.profile?.humanName || "";
      const draft = postEditorState.draft;
      if (draft?.publishedPath) {
        const kind = draft.authorKind === "agent" ? `Agent${agentName ? ` · ${agentName}` : ""}` : `本人${humanName ? ` · ${humanName}` : ""}`;
        postAuthorNote.textContent = `正在编辑已公开动态；署名来源保留为${kind}，发布会更新原帖。`;
      } else if (postAuthorKind.value === "agent") {
        postAuthorNote.textContent = `将以 Agent${agentName ? ` · ${agentName}` : ""} 署名发布。`;
      } else {
        postAuthorNote.textContent = `将以本人${humanName ? ` · ${humanName}` : ""} 署名发布。`;
      }
      if (isLegacyV1PostPath(draft?.publishedPath)) {
        postAuthorNote.textContent += " 旧版动态保持原格式，本次只更新文字，不能加入图片。";
      }
    }
    function renderPostImages() {
      if (!postImageList) return;
      postImageList.replaceChildren();
      const draft = postEditorState.draft;
      const draftId = draft?.draftId || "";
      const images = draft?.images || [];
      for (const image of images) {
        const item = element("div", "rm-post-editor-image");
        const thumb = element("img", "rm-post-editor-thumb");
        thumb.alt = image.mime === "image/png" ? "PNG 草稿图片" : "JPEG 草稿图片";
        const copy = element("div", "rm-post-editor-image-copy");
        const label = element("span");
        label.textContent = `${image.mime === "image/png" ? "PNG" : "JPEG"} · ${image.width}×${image.height} · ${image.sizeBytes} B`;
        copy.append(label);
        const remove = element("button", "rm-quiet");
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => {
          if (postEditorState.loading || postEditorState.saving || postEditorState.uploading || postEditorState.publishing) {
            postEditorNote.hidden = false;
            postEditorNote.textContent = "正在读取、保存或发布；完成后再移除图片。";
            return;
          }
          const current = postEditorState.draft;
          if (!current) return;
          releaseDraftAsset("post", current.draftId, image.assetId);
          current.images = (current.images || []).filter((entry) => entry.assetId !== image.assetId);
          markPostEditorChanged("已移除图片；请重新检查发布内容。");
          renderPostImages();
          postImageInput.focus({ preventScroll: true });
          postEditorNote.hidden = false;
          postEditorNote.textContent = "已从草稿中移除图片；保存草稿后生效。";
          schedulePostSave();
        }, { signal: controller.signal });
        if (publicDraftAssetCapable && draftId) {
          const key2 = `post:${draftId}:${image.assetId}`;
          const cached = draftAssetCache.get(key2);
          if (cached?.url) {
            thumb.src = cached.url;
          } else if (cached?.error) {
            item.dataset.thumb = "error";
            const note = element("small", "rm-post-editor-thumb-error");
            note.textContent = cached.error;
            copy.append(note);
          } else {
            item.dataset.thumb = "loading";
            void ensureDraftAssetPreview("post", draftId, image).then((entry) => {
              if (!thumb.isConnected) return;
              if (entry?.url) {
                thumb.src = entry.url;
                item.dataset.thumb = "ready";
              } else {
                const failed = draftAssetCache.get(key2)?.error || "缩略图读取失败";
                item.dataset.thumb = "error";
                const note = element("small", "rm-post-editor-thumb-error");
                note.textContent = failed;
                copy.append(note);
              }
            });
          }
        }
        item.append(thumb, copy, remove);
        postImageList.append(item);
      }
      for (const [index, pending] of postEditorState.pending.entries()) {
        const item = element("div", "rm-post-editor-image");
        const thumb = element("img", "rm-post-editor-thumb");
        thumb.src = pending.url;
        thumb.alt = pending.file.name;
        const copy = element("div", "rm-post-editor-image-copy");
        const label = element("span");
        label.textContent = `${pending.file.name} · 待上传`;
        copy.append(label);
        const remove = element("button", "rm-quiet");
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => {
          if (postEditorState.loading || postEditorState.saving || postEditorState.uploading || postEditorState.publishing) {
            postEditorNote.hidden = false;
            postEditorNote.textContent = "正在读取、保存或发布；完成后再移除图片。";
            return;
          }
          URL.revokeObjectURL(pending.url);
          postEditorState.pending.splice(index, 1);
          markPostEditorChanged("已移除待上传图片；请重新检查发布内容。");
          renderPostImages();
          postImageInput.focus({ preventScroll: true });
        }, { signal: controller.signal });
        item.append(thumb, copy, remove);
        postImageList.append(item);
      }
    }
    function renderPostDraftList() {
      if (!postDraftSelect) return;
      const selected = postEditorState.draft?.draftId || "";
      postDraftSelect.replaceChildren();
      const blank = doc.createElement("option");
      blank.value = "";
      blank.textContent = "新建草稿";
      postDraftSelect.append(blank);
      for (const draft of postEditorState.list) {
        const option = doc.createElement("option");
        option.value = draft.draftId;
        option.textContent = `${draft.title || "未命名动态"} · ${draft.authorKind === "agent" ? "Agent" : "本人"} · r${draft.revision}`;
        postDraftSelect.append(option);
      }
      postDraftSelect.value = selected;
    }
    async function loadPostDrafts() {
      if (!publicDraftListCapable) return;
      const seq = ++postEditorState.listSeq;
      try {
        const result = await options.onLoadPublicDrafts("post");
        if (seq !== postEditorState.listSeq) return;
        postEditorState.list = Array.isArray(result?.drafts) ? result.drafts : [];
        postEditorState.listLoaded = true;
        renderPostDraftList();
      } catch (error) {
        if (seq !== postEditorState.listSeq) return;
        postEditorNote.hidden = false;
        postEditorNote.textContent = `读取动态草稿失败：${errorText(error)}`;
      }
    }
    function postEditorHasUnsavedChanges() {
      if (postEditorState.dirty || postEditorState.pending.length > 0) return true;
      const draft = postEditorState.draft;
      const values = postFormValues();
      if (!draft) {
        return Boolean(values.title || values.bodyMarkdown || values.tags.length > 0 || values.authorKind !== "user");
      }
      const draftTags = (draft.tags || []).map((tag) => String(tag));
      return values.title !== (draft.title || "") || values.bodyMarkdown !== (draft.bodyMarkdown || "") || values.tags.join("\0") !== draftTags.join("\0") || values.authorKind !== (draft.authorKind === "agent" ? "agent" : "user");
    }
    function invalidatePostConfirm(message = "") {
      if (!postEditorState.confirm && !message) return;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      if (message) postEditorState.confirmNotice = message;
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      renderPostEditorStatus();
    }
    function markPostEditorChanged(message = "内容已修改；请重新检查发布内容。") {
      postEditorState.formVersion += 1;
      const values = postFormValues();
      postEditorState.dirty = !(postEditorState.draft === null && postEditorState.pending.length === 0 && values.authorKind === "user" && !values.title && !values.bodyMarkdown && values.tags.length === 0);
      if (postWriteAnother) postWriteAnother.hidden = true;
      if (postEditorState.confirm) invalidatePostConfirm(message);
      renderPostStashControl();
    }
    function stashHasContent(stash) {
      if (!stash) return false;
      return Boolean(stash.values.title || stash.values.bodyMarkdown || stash.values.tags.length > 0 || stash.values.authorKind !== "user" || stash.files.length > 0);
    }
    function postStashLabel(stash) {
      const title = String(stash?.values?.title || "").trim();
      return title ? `“${title.slice(0, 18)}${title.length > 18 ? "…" : ""}”` : "未命名内容";
    }
    function samePostStashContent(left, right) {
      if (!left || !right) return false;
      if (left.kind !== right.kind) return false;
      if ((left.draft?.draftId || "") !== (right.draft?.draftId || "")) return false;
      const a = left.values || {};
      const b = right.values || {};
      if (a.title !== b.title || a.bodyMarkdown !== b.bodyMarkdown || a.authorKind !== b.authorKind) return false;
      if ((a.tags || []).join("\0") !== (b.tags || []).join("\0")) return false;
      const aFiles = left.files || [];
      const bFiles = right.files || [];
      if (aFiles.length !== bFiles.length) return false;
      return aFiles.every((file, index) => {
        const other = bFiles[index];
        return file === other || file.name === other.name && file.size === other.size && file.type === other.type && file.lastModified === other.lastModified;
      });
    }
    function buildPostEditorStash(reason = "") {
      if (!postEditorHasUnsavedChanges()) return null;
      const values = postFormValues();
      const draft = clonePostDraft(postEditorState.draft);
      const stash = {
        kind: draft ? "draft" : "new",
        reason,
        values: { ...values, tags: [...values.tags] },
        files: postEditorState.pending.map((pending) => pending.file),
        draft,
        dirty: postEditorState.dirty,
        at: Date.now()
      };
      return stashHasContent(stash) ? stash : null;
    }
    function postEditorStashWouldBeReplaced() {
      const existing = postEditorState.stash;
      if (!stashHasContent(existing)) return null;
      const incoming = buildPostEditorStash();
      if (!stashHasContent(incoming)) return null;
      return samePostStashContent(existing, incoming) ? null : existing;
    }
    function blockPostEditorStashReplacement(action2 = "切换草稿") {
      const existing = postEditorState.stash;
      if (!stashHasContent(existing)) return false;
      renderPostDraftList();
      postDraftSelect.value = postEditorState.draft?.draftId || "";
      const kind = existing.kind === "draft" ? "未保存的草稿修改" : "未保存的新动态";
      postEditorNote.hidden = false;
      postEditorNote.textContent = `已有一份${kind}（${postStashLabel(existing)}）尚未处理；为避免覆盖，本次没有${action2}。请先保存当前草稿（标题和正文完整时），或点“用旧内容替换当前输入”恢复旧项；如不再需要旧项，可点“丢弃旧恢复项”后再继续。`;
      renderPostStashControl();
      postDraftSelect.focus({ preventScroll: true });
      return true;
    }
    function capturePostEditorStash(reason = "") {
      const stash = buildPostEditorStash(reason);
      if (!stash) return null;
      postEditorState.stash = stash;
      renderPostStashControl();
      return stash;
    }
    function clearPendingPostImages() {
      for (const pending of postEditorState.pending) URL.revokeObjectURL(pending.url);
      postEditorState.pending = [];
    }
    function restorePostEditorStash({ focus = false, replace = false } = {}) {
      const stash = postEditorState.stash;
      if (!stash || postEditorState.loading || postEditorState.saving || postEditorState.publishing || postEditorState.uploading) return false;
      const replacing = postEditorHasUnsavedChanges();
      if (replacing && !replace) return false;
      if (replacing) {
        if (postSaveTimer !== null) {
          win.clearTimeout(postSaveTimer);
          postSaveTimer = null;
        }
        clearPendingPostImages();
      }
      postEditorState.stash = null;
      postEditorState.loading = false;
      postEditorState.draft = clonePostDraft(stash.draft);
      postEditorState.draftEpoch += 1;
      postEditorState.formVersion += 1;
      setPostForm(postEditorState.draft);
      postTitleInput.value = stash.values.title;
      postBodyInput.value = stash.values.bodyMarkdown;
      postTagsInput.value = stash.values.tags.join("，");
      postAuthorKind.value = stash.values.authorKind === "agent" ? "agent" : "user";
      postAuthorKind.disabled = Boolean(postEditorState.draft?.publishedPath);
      postImageInput.disabled = isLegacyV1PostPath(postEditorState.draft?.publishedPath);
      for (const file of stash.files) {
        let url = "";
        try {
          url = URL.createObjectURL(file);
        } catch {
          url = "";
        }
        if (url) postEditorState.pending.push({ file, url });
      }
      postEditorState.dirty = true;
      postEditorState.error = "";
      postEditorState.receipt = null;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      renderPostAuthorNote();
      renderPostImages();
      renderPostDraftList();
      renderPostEditorStatus();
      postEditorNote.hidden = false;
      if (stash.kind === "draft") {
        postEditorNote.textContent = replacing ? "已用旧的未保存草稿修改替换当前输入；当前输入未保存。原公开动态未被覆盖，请保存或检查后发布。" : "已恢复切换前未保存的草稿修改；原公开动态未被覆盖，请保存或检查后发布。";
      } else {
        postEditorNote.textContent = replacing ? "已用旧的未保存新动态替换当前输入；当前输入未保存。它仍只在本机编辑器中，尚未保存或公开。" : "已恢复上次未保存的新动态输入；它仍只在本机编辑器中，尚未保存或公开。";
      }
      if (focus) postTitleInput.focus({ preventScroll: true });
      return true;
    }
    function discardPostEditorStash({ focus = false } = {}) {
      if (!stashHasContent(postEditorState.stash)) return false;
      postEditorState.stash = null;
      renderPostStashControl();
      postEditorNote.hidden = false;
      postEditorNote.textContent = "已丢弃旧的未保存内容；当前编辑器输入未被改动，可重新选择草稿。";
      if (focus) postDraftSelect.focus({ preventScroll: true });
      return true;
    }
    function renderPostStashControl() {
      if (!postRestoreStash) return;
      const stash = postEditorState.stash;
      const available = Boolean(stash) && !postEditorState.loading && !postEditorState.saving && !postEditorState.publishing && !postEditorState.uploading;
      const replacing = available && postEditorHasUnsavedChanges();
      postRestoreStash.hidden = !available;
      if (postDiscardStash) postDiscardStash.hidden = !available;
      if (!available) {
        postRestoreStash.title = "";
        return;
      }
      const label = postStashLabel(stash);
      postRestoreStash.textContent = replacing ? `用旧内容替换当前输入（${label}）` : stash.kind === "new" ? `恢复未保存的新动态（${label}）` : `恢复未保存的草稿修改（${label}）`;
      postRestoreStash.title = replacing ? "当前未保存输入会被替换；标题和正文完整时请先保存当前草稿。" : "";
    }
    function resetPostEditorForm() {
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
      }
      clearPendingPostImages();
      postEditorState.draft = null;
      postEditorState.dirty = false;
      postEditorState.error = "";
      postEditorState.receipt = null;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postEditorState.imported = false;
      postEditorState.loading = false;
      postEditorState.formVersion += 1;
      postEditorState.draftEpoch += 1;
      postEditorState.draftLoadSeq += 1;
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      if (postWriteAnother) postWriteAnother.hidden = true;
      setPostForm(null);
      postEditorNote.hidden = true;
      postEditorNote.textContent = "";
      renderPostDraftList();
      renderPostEditorStatus();
    }
    function stablePostFocusPrefix(key2) {
      const withoutAction = String(key2 ?? "").replace(/:edit$/, "");
      const mine = /^(mine-feed:.+):[0-9a-f]{64}$/i.exec(withoutAction);
      return mine ? `${mine[1]}:` : withoutAction;
    }
    function postEditorReturnContext(trigger, fallbackFocusKey = "") {
      const page = pageElsHas(currentPage) ? currentPage : "explore";
      const focusKey = trigger?.dataset?.focusKey || fallbackFocusKey;
      return {
        page,
        scroll: Math.max(0, Number(pageEls[page]?.scrollTop) || 0),
        trigger: trigger ?? null,
        focusKey,
        focusKeyPrefix: stablePostFocusPrefix(focusKey),
        focusKeySuffix: focusKey.endsWith(":edit") ? ":edit" : ""
      };
    }
    function postEditorControlVisible(node) {
      return Boolean(node?.isConnected && !node.closest?.("[hidden]") && !node.closest?.("dialog:not([open])"));
    }
    function postEditorReturnTarget(context) {
      if (!context || context.page !== currentPage) return null;
      if (postEditorControlVisible(context.trigger)) return context.trigger;
      const nodes = [...pageEls[currentPage]?.querySelectorAll("[data-focus-key]") ?? []];
      let target = context.focusKey ? nodes.find((node) => node.dataset.focusKey === context.focusKey) ?? null : null;
      if (!target && context.focusKeyPrefix) {
        const candidates = nodes.filter((node) => node.dataset.focusKey?.startsWith(context.focusKeyPrefix));
        target = (context.focusKeySuffix ? candidates.find((node) => node.dataset.focusKey?.endsWith(context.focusKeySuffix)) : null) ?? candidates[0] ?? null;
      }
      return target ?? null;
    }
    function applyPostEditorReturnFocus(context) {
      const target = postEditorReturnTarget(context);
      if (!target) return false;
      target.focus({ preventScroll: true });
      restorePageScrollAfterFocus(context.page, context.scroll);
      return true;
    }
    function tryPostEditorReturnFocus() {
      const pending = postEditorReturnFocus;
      if (!pending) return;
      if (pending.page !== currentPage || pending.token !== postEditorReturnFocusToken) {
        postEditorReturnFocus = null;
        return;
      }
      const active = root.activeElement;
      if (active && active !== composePost && active !== doc.body && active !== root) {
        postEditorReturnFocus = null;
        return;
      }
      if (applyPostEditorReturnFocus(pending)) postEditorReturnFocus = null;
    }
    function restorePostEditorReturnFocus(context) {
      if (!context || context.page !== currentPage) return;
      if (applyPostEditorReturnFocus(context)) return;
      if (currentPage === "explore") composePost.focus({ preventScroll: true });
      const token = ++postEditorReturnFocusToken;
      postEditorReturnFocus = { ...context, token };
      if (typeof win.setTimeout === "function") {
        win.setTimeout(() => {
          if (postEditorReturnFocus?.token === token) postEditorReturnFocus = null;
        }, 1500);
      }
    }
    async function openPostEditor({ trigger = null, editItem = null, returnFocusKey = "" } = {}) {
      if (destroyed) return;
      if (postEditorState.saving || postEditorState.uploading || postEditorState.publishing || postEditorState.validatingImages > 0) {
        if (postEditorState.open) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = postEditorState.validatingImages > 0 ? "图片仍在校验；完成后再打开其他动态或切换草稿。" : "当前草稿正在保存或发布；完成后再打开其他动态。";
        }
        return;
      }
      const alreadyOpen = postEditorState.open;
      postEditorReturnFocus = null;
      postEditorReturnFocusToken += 1;
      if (!alreadyOpen) postEditorReturn = postEditorReturnContext(trigger ?? composePost, returnFocusKey);
      postEditorState.open = true;
      postEditorState.error = "";
      postEditorPanel.hidden = false;
      if (!postEditorPanel.open) openDialog(postEditorPanel, trigger ?? composePost);
      postEditorPanel.hidden = false;
      const seq = ++postEditorState.requestSeq;
      if (!postEditorState.listLoaded && publicDraftListCapable) void loadPostDrafts();
      if (editItem) {
        if (postEditorStashWouldBeReplaced()) {
          postEditorState.loading = false;
          renderPostEditorStatus();
          blockPostEditorStashReplacement("打开其他动态");
          return;
        }
        const previousView = postEditorViewSnapshot();
        const stashed = capturePostEditorStash("打开其他动态");
        resetPostEditorForm();
        postEditorState.loading = true;
        postEditorNote.hidden = false;
        postEditorNote.textContent = "正在打开这条公开动态的编辑草稿…";
        renderPostEditorStatus();
        try {
          const result = await options.onImportPublicPost(editItem.path);
          if (destroyed || seq !== postEditorState.requestSeq || !postEditorState.open) return;
          if (!result?.draft) throw new Error("没有返回编辑草稿");
          postEditorState.draft = result.draft;
          postEditorState.receipt = null;
          postEditorState.dirty = false;
          setPostForm(result.draft);
          if (!postEditorState.listLoaded) await loadPostDrafts();
          else renderPostDraftList();
          postEditorNote.hidden = false;
          postEditorNote.textContent = stashed ? "正在编辑已公开动态；打开前未保存的内容已保留，关闭后可点“写动态”或恢复按钮找回。" : "正在编辑已公开动态；保存草稿不会公开，确认发布后更新原帖。";
        } catch (error) {
          if (destroyed || seq !== postEditorState.requestSeq || !postEditorState.open) return;
          postEditorState.loading = false;
          if (stashed) restorePostEditorStash();
          else restorePostEditorView(previousView);
          postEditorNote.hidden = false;
          postEditorNote.textContent = errorText(error) || "这条公开动态暂时不能编辑。";
        } finally {
          if (!destroyed && seq === postEditorState.requestSeq && postEditorState.open) {
            postEditorState.loading = false;
            renderPostEditorStatus();
            renderPostStashControl();
            if (postEditorState.draft) postTitleInput.focus({ preventScroll: true });
          }
        }
        return;
      }
      const draft = postEditorState.draft;
      if (draft?.publishedPath) {
        if (postEditorHasUnsavedChanges()) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "当前已发布动态还有未保存的修改，已保留原草稿；保存或发布后再点“写动态”开始新动态。";
        } else {
          resetPostEditorForm();
          const restored = postEditorState.stash?.kind === "new" && restorePostEditorStash();
          postEditorNote.hidden = false;
          postEditorNote.textContent = restored ? "已恢复打开其他动态前未保存的新动态输入；它仍只在本机编辑器中。" : "已开始一条新动态；要修改已发布动态，请使用动态卡片上的“编辑”。";
        }
      } else if (!draft) {
        if (postEditorHasUnsavedChanges()) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "当前新动态尚未保存，已保留输入；先保存草稿再开始另一条。";
        } else if (postEditorState.stash?.kind === "new" && restorePostEditorStash()) {
        } else {
          resetPostEditorForm();
        }
      } else {
        renderPostStashControl();
      }
      postEditorState.loading = false;
      renderPostEditorStatus();
      renderPostStashControl();
      postTitleInput.focus({ preventScroll: true });
    }
    async function openExistingPostForEdit(item, trigger = null, returnFocusKey = "") {
      if (!publicDraftImportCapable) return;
      if (postEditorState.saving || postEditorState.uploading || postEditorState.publishing || postEditorState.validatingImages > 0) {
        if (postEditorPanel.open) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = postEditorState.validatingImages > 0 ? "图片仍在校验；完成后再打开其他动态。" : "当前草稿正在保存或发布；完成后再打开其他动态。";
        }
        return;
      }
      const fallbackKey = returnFocusKey || `mine-feed:${item.path}:${item.sha256}:edit`;
      await openPostEditor({ trigger, editItem: item, returnFocusKey: fallbackKey });
    }
    function cancelPostConfirm({ focus = false } = {}) {
      if (!postEditorState.confirm) return;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postEditorState.receipt = null;
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      renderPostEditorStatus();
      if (focus) postPublishButton.focus({ preventScroll: true });
    }
    function startAnotherPost() {
      if (postEditorState.saving || postEditorState.publishing || postEditorState.loading || postEditorState.uploading || postEditorState.validatingImages > 0) return;
      if (postEditorHasUnsavedChanges()) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "当前动态还有未保存或未发布的内容，先保存或关闭后再开始新动态。";
        return;
      }
      postEditorState.stash = null;
      resetPostEditorForm();
      postEditorState.open = true;
      postEditorPanel.hidden = false;
      postEditorNote.hidden = false;
      postEditorNote.textContent = "已开始一条全新的空白动态；不会继承刚才发布的内容、ID 或图片。";
      renderPostEditorStatus();
      renderPostStashControl();
      postTitleInput.focus({ preventScroll: true });
    }
    function closePostEditor({ restoreFocus = true } = {}) {
      if (!postEditorState.open && !postEditorPanel.open) return;
      const context = postEditorReturn;
      postEditorState.open = false;
      postEditorState.requestSeq += 1;
      postEditorState.loading = false;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
        if (postEditorState.dirty && postEditorState.draft && publicDraftSaveCapable && !postEditorState.saving) {
          void savePostDraft();
        }
      }
      postEditorPanel.hidden = true;
      closeDialog(postEditorPanel, { restoreFocus: false });
      renderPostEditorStatus();
      postEditorReturn = null;
      saveNow();
      if (restoreFocus) restorePostEditorReturnFocus(context);
    }
    function restorePostEditorControlFocus(preferred) {
      if (!postEditorPanel.open || postEditorState.loading) return;
      const active = root.activeElement;
      if (active && active !== doc.body && active !== root && active !== postEditorPanel) return;
      preferred?.focus?.({ preventScroll: true });
    }
    function renderPostEditorStatus() {
      const validating = postEditorState.validatingImages > 0;
      const busy = postEditorState.loading || postEditorState.saving || postEditorState.publishing || postEditorState.uploading || validating;
      const locked = postEditorState.loading || postEditorState.publishing;
      const draft = postEditorState.draft;
      postDraftSelect.disabled = busy;
      postTitleInput.disabled = locked;
      postBodyInput.disabled = locked;
      postTagsInput.disabled = locked;
      postAuthorKind.disabled = locked || Boolean(draft?.publishedPath);
      postImageInput.disabled = locked || postEditorState.saving || postEditorState.uploading || validating || isLegacyV1PostPath(draft?.publishedPath);
      postDraftSave.disabled = !publicDraftSaveCapable || busy;
      postPublishButton.disabled = !publishDraftCapable || busy;
      postPublishCancel.hidden = !postEditorState.confirm;
      postWriteAnother.hidden = !(postEditorState.receipt && !postEditorState.dirty && (postEditorState.receipt.status === "published" || postEditorState.receipt.status === "already_published"));
      postEditorPanel.setAttribute("aria-busy", String(busy));
      postEditorStatus.textContent = postEditorState.loading ? "打开中…" : postEditorState.publishing ? "发布中…" : postEditorState.saving || postEditorState.uploading ? "保存中…" : validating ? "校验图片中…" : draft ? `草稿 revision ${draft.revision}` : "新草稿";
      updatePostEditorHeading(draft);
      if (postEditorState.receipt) {
        postPublishReceipt.hidden = false;
        postPublishReceipt.dataset.tone = postEditorState.receipt.status === "published" || postEditorState.receipt.status === "already_published" ? "ready" : "error";
        postPublishReceipt.textContent = postPublishReceiptText(postEditorState.receipt);
      } else if (postEditorState.confirmNotice) {
        postPublishReceipt.hidden = false;
        postPublishReceipt.dataset.tone = "unavailable";
        postPublishReceipt.textContent = postEditorState.confirmNotice;
      } else if (postEditorState.confirm) {
        postPublishReceipt.hidden = false;
        postPublishReceipt.dataset.tone = "unavailable";
      } else {
        postPublishReceipt.hidden = true;
        postPublishReceipt.textContent = "";
        postPublishReceipt.dataset.tone = "";
      }
      renderPostStashControl();
    }
    function postPublishReceiptText(receipt) {
      const label = {
        published: "发布完成",
        already_published: "内容已是最新公开版本",
        conflict: "发布冲突，未覆盖",
        invalid: "发布内容无效",
        partial: "发布部分完成，请核对实际清单",
        unspecified: "发布状态未知"
      }[receipt.status] || "发布状态未知";
      const files = (receipt.files || []).map((file) => `${file.path} (${file.sizeBytes} B, ${String(file.sha256).slice(0, 12)}…)`).join("；");
      return [
        label,
        receipt.error,
        receipt.postPath ? `动态：${receipt.postPath}` : "",
        files ? `实际文件：${files}` : "",
        receipt.manifestSha256 ? `清单摘要：${receipt.manifestSha256}` : "",
        (receipt.warnings || []).join("；")
      ].filter(Boolean).join(" ");
    }
    async function validatePostFiles(files) {
      const accepted = [];
      const errors = [];
      for (const file of files) {
        if (!["image/png", "image/jpeg"].includes(file.type)) {
          errors.push(`${file.name} 不是 PNG/JPEG；SVG、GIF、WebP 不接受。`);
          continue;
        }
        if (file.size > 8 * 1024 * 1024) {
          errors.push(`${file.name} 超过 8 MiB。`);
          continue;
        }
        let dimensions;
        try {
          dimensions = await imageSize(file);
        } catch {
          errors.push(`${file.name} 无法解码，可能是损坏图片。`);
          continue;
        }
        if (dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 32e6) {
          errors.push(`${file.name} 尺寸 ${dimensions.width}×${dimensions.height} 超过限制。`);
          continue;
        }
        accepted.push(file);
      }
      const total = (postEditorState.draft?.images?.length || 0) + postEditorState.pending.length + accepted.length;
      if (total > 4) {
        errors.push("一条动态最多 4 张图片；多出的图片未加入。");
        accepted.splice(Math.max(0, 4 - (postEditorState.draft?.images?.length || 0) - postEditorState.pending.length));
      }
      return { accepted, errors };
    }
    async function addPostFiles(files) {
      if (postEditorState.saving || postEditorState.uploading || postEditorState.publishing || postEditorState.loading) return;
      if (postEditorState.confirm) {
        invalidatePostConfirm("图片正在校验，旧确认已撤销；请重新检查发布内容。");
      }
      postEditorState.validatingImages += 1;
      renderPostEditorStatus();
      let result;
      try {
        result = await validatePostFiles([...files]);
      } finally {
        postEditorState.validatingImages = Math.max(0, postEditorState.validatingImages - 1);
        renderPostEditorStatus();
      }
      const accepted = result?.accepted ?? [];
      const errors = result?.errors ?? [];
      if (accepted.length > 0) {
        for (const file of accepted) {
          let url = "";
          try {
            url = URL.createObjectURL(file);
          } catch {
            url = "";
          }
          if (url) postEditorState.pending.push({ file, url });
        }
        markPostEditorChanged("已更新图片；请重新检查发布内容。");
        if (postEditorState.confirmNotice) {
          postEditorState.confirmNotice = "已更新图片；旧确认已撤销，请重新检查发布内容。";
        }
      } else if (postEditorState.confirmNotice.includes("正在校验")) {
        postEditorState.confirmNotice = "图片未加入；旧确认已撤销，请检查标题、正文和图片后重新检查发布内容。";
      }
      postEditorNote.hidden = false;
      postEditorNote.textContent = [
        errors.join(" "),
        accepted.length > 0 ? `已加入 ${accepted.length} 张图片；检查发布内容时会保存并上传。` : "",
        accepted.length === 0 ? "图片未加入；标题、正文、标签和署名等原输入均保留。" : ""
      ].filter(Boolean).join(" ");
      renderPostImages();
      renderPostEditorStatus();
    }
    function stalePostEditorError() {
      const error = new Error("编辑器已切换或草稿回执已过期");
      error.postEditorStale = true;
      return error;
    }
    async function uploadPendingPostImages(draft, { epoch, pendingSnapshot } = {}) {
      const pendingList = Array.isArray(pendingSnapshot) ? pendingSnapshot : [...postEditorState.pending];
      if (pendingList.length === 0) return draft;
      if (!publicDraftImageCapable) throw new Error("当前宿主不支持上传草稿图片");
      const expectedEpoch = epoch ?? postEditorState.draftEpoch;
      postEditorState.uploading = true;
      renderPostEditorStatus();
      try {
        const assetIds = (draft.images || []).map((image) => image.assetId);
        for (const pending of pendingList) {
          if (expectedEpoch !== postEditorState.draftEpoch) throw stalePostEditorError();
          const base64 = await fileToBase64(pending.file);
          if (expectedEpoch !== postEditorState.draftEpoch) throw stalePostEditorError();
          const uploaded = await options.onPutPublicDraftImage(draft.draftId, "image", pending.file.name, base64);
          if (expectedEpoch !== postEditorState.draftEpoch) throw stalePostEditorError();
          if (!uploaded?.image?.assetId) throw new Error(`图片 ${pending.file.name} 上传没有返回资源`);
          assetIds.push(uploaded.image.assetId);
        }
        const saved = (await options.onSavePublicDraft({
          ...postFormValues(),
          draftId: draft.draftId,
          kind: "post",
          expectedRevision: draft.revision,
          imageAssetIds: assetIds
        })).draft;
        if (expectedEpoch !== postEditorState.draftEpoch) throw stalePostEditorError();
        for (const pending of pendingList) URL.revokeObjectURL(pending.url);
        postEditorState.pending = postEditorState.pending.filter((pending) => !pendingList.includes(pending));
        return saved;
      } finally {
        postEditorState.uploading = false;
        renderPostEditorStatus();
      }
    }
    async function copyDraftImagesTo(sourceDraft, targetDraft) {
      const ids = [];
      if (!sourceDraft || (sourceDraft.images || []).length === 0) return ids;
      if (!publicDraftAssetCapable) {
        throw new Error("当前宿主无法读取原草稿图片，暂不能另存为新草稿。");
      }
      for (const image of sourceDraft.images || []) {
        const fetched = await options.onLoadPublicDraftAsset(sourceDraft.draftId, image.assetId);
        if (!fetched?.dataBase64 || fetched.image?.assetId !== image.assetId) {
          throw new Error("原草稿图片没有完整读取，未另存新草稿。");
        }
        const uploaded = await options.onPutPublicDraftImage(
          targetDraft.draftId,
          "image",
          `copy-${image.assetId}${image.mime === "image/jpeg" ? ".jpg" : ".png"}`,
          fetched.dataBase64
        );
        if (!uploaded?.image?.assetId) throw new Error("原草稿图片复制失败，未另存新草稿。");
        ids.push(uploaded.image.assetId);
      }
      return ids;
    }
    async function uploadPendingToDraft(targetDraft) {
      const ids = [];
      for (const pending of postEditorState.pending) {
        const base64 = await fileToBase64(pending.file);
        const uploaded = await options.onPutPublicDraftImage(targetDraft.draftId, "image", pending.file.name, base64);
        if (!uploaded?.image?.assetId) throw new Error(`图片 ${pending.file.name} 上传没有返回资源`);
        ids.push(uploaded.image.assetId);
      }
      return ids;
    }
    async function savePostAsNewDraft() {
      if (!publicDraftSaveCapable || postEditorState.saving || postEditorState.publishing || postEditorState.loading) return;
      const values = postFormValues();
      if (!values.title.trim() || !values.bodyMarkdown.trim()) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "标题和正文不能为空。";
        return;
      }
      const sourceDraft = postEditorState.draft;
      if ((sourceDraft?.images || []).length > 0 && !publicDraftAssetCapable) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "当前宿主无法读取原草稿图片，暂不能另存为新草稿；原草稿未被改动。";
        return;
      }
      postEditorState.saving = true;
      renderPostEditorStatus();
      let createdId = "";
      try {
        const created = (await options.onSavePublicDraft({
          ...values,
          draftId: "",
          kind: "post",
          expectedRevision: 0,
          imageAssetIds: []
        })).draft;
        if (!created?.draftId) throw new Error("另存新草稿没有返回草稿");
        createdId = created.draftId;
        const assetIds = await copyDraftImagesTo(sourceDraft, created);
        assetIds.push(...await uploadPendingToDraft(created));
        let saved = created;
        if (assetIds.length > 0) {
          saved = (await options.onSavePublicDraft({
            ...values,
            draftId: created.draftId,
            kind: "post",
            expectedRevision: created.revision,
            imageAssetIds: assetIds
          })).draft;
        }
        for (const pending of postEditorState.pending) URL.revokeObjectURL(pending.url);
        postEditorState.pending = [];
        postEditorState.draft = saved;
        postEditorState.draftEpoch += 1;
        postEditorState.formVersion += 1;
        postEditorState.error = "";
        postEditorState.receipt = null;
        postEditorState.confirm = false;
        postEditorState.confirmSnapshot = null;
        postEditorState.confirmNotice = "";
        if (postSaveAsNew) postSaveAsNew.hidden = true;
        if (postWriteAnother) postWriteAnother.hidden = true;
        setPostForm(saved);
        postEditorNote.hidden = false;
        postEditorNote.textContent = assetIds.length > 0 ? "已另存为新草稿，原有图片和本次选择的图片都已保留；原草稿未被改动。" : "已另存为新草稿；原草稿未被改动。";
        await loadPostDrafts();
      } catch (error) {
        if (createdId && typeof options.onDeletePublicDraft === "function" && postEditorState.draft?.draftId !== createdId) {
          try {
            await options.onDeletePublicDraft(createdId, 0);
          } catch {
          }
        }
        postEditorNote.hidden = false;
        postEditorNote.textContent = errorText(error);
      } finally {
        postEditorState.saving = false;
        renderPostEditorStatus();
      }
    }
    async function savePostDraft() {
      if (!publicDraftSaveCapable) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "当前宿主没有提供动态草稿保存。";
        return null;
      }
      if (postEditorState.saving || postEditorState.publishing || postEditorState.loading || postEditorState.uploading) return null;
      if (postEditorState.validatingImages > 0) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "图片仍在校验；完成后再保存或检查发布内容。";
        return null;
      }
      const values = postFormValues();
      if (!values.title.trim() || !values.bodyMarkdown.trim()) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "标题和正文不能为空。";
        return null;
      }
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
      }
      if (postEditorState.confirm) invalidatePostConfirm("草稿已保存新版本；请重新检查发布内容。");
      const epoch = postEditorState.draftEpoch;
      const versionAtStart = postEditorState.formVersion;
      const pendingAtStart = [...postEditorState.pending];
      postEditorState.saving = true;
      postEditorState.error = "";
      renderPostEditorStatus();
      let savedDraft = null;
      try {
        let draft = postEditorState.draft;
        if (draft === null) {
          const created = await options.onSavePublicDraft({
            ...values,
            draftId: "",
            kind: "post",
            expectedRevision: 0,
            imageAssetIds: []
          });
          if (epoch !== postEditorState.draftEpoch) throw stalePostEditorError();
          draft = created.draft;
        } else {
          const saved = await options.onSavePublicDraft({
            ...values,
            draftId: draft.draftId,
            kind: "post",
            expectedRevision: draft.revision,
            imageAssetIds: (draft.images || []).map((image) => image.assetId)
          });
          if (epoch !== postEditorState.draftEpoch) throw stalePostEditorError();
          draft = saved.draft;
        }
        savedDraft = draft;
        draft = await uploadPendingPostImages(draft, { epoch, pendingSnapshot: pendingAtStart });
        if (epoch !== postEditorState.draftEpoch) throw stalePostEditorError();
        postEditorState.draft = draft;
        postAuthorKind.disabled = Boolean(draft.publishedPath);
        postImageInput.disabled = isLegacyV1PostPath(draft.publishedPath);
        renderPostAuthorNote();
        const changedWhileSaving = postEditorState.formVersion !== versionAtStart;
        postEditorState.dirty = changedWhileSaving || postEditorState.pending.length > 0;
        if (postSaveAsNew) postSaveAsNew.hidden = true;
        if (postWriteAnother) postWriteAnother.hidden = true;
        if (postEditorState.receipt && postEditorState.receipt.currentRevision !== draft.revision) {
          postEditorState.receipt = null;
        }
        postEditorNote.hidden = false;
        postEditorNote.textContent = changedWhileSaving ? `草稿已保存 · revision ${draft.revision}；保存期间内容又有更新，当前输入尚未保存，请再次保存或检查。` : `草稿已保存 · revision ${draft.revision}。仅本机可见，尚未发布。`;
        await loadPostDrafts();
        renderPostImages();
        return draft;
      } catch (error) {
        if (error?.postEditorStale) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "草稿回执属于已切换的编辑器，未应用到当前内容；原输入保留。";
          return null;
        }
        if (savedDraft && epoch === postEditorState.draftEpoch) {
          postEditorState.draft = savedDraft;
        }
        const message = errorText(error);
        postEditorState.error = /conflict|冲突|已在别处/i.test(message) ? "草稿已在别处更新；本地输入保留，请重新载入草稿后再保存。" : message;
        if (postSaveAsNew) postSaveAsNew.hidden = !/conflict|冲突|已在别处/i.test(message);
        postEditorNote.hidden = false;
        postEditorNote.textContent = postEditorState.error;
        return null;
      } finally {
        postEditorState.saving = false;
        renderPostEditorStatus();
        restorePostEditorControlFocus(postDraftSave);
      }
    }
    function schedulePostSave() {
      if (postEditorState.loading) return;
      markPostEditorChanged("内容已修改；请重新检查发布内容。");
      if (postEditorState.saving || postEditorState.uploading || postEditorState.publishing) return;
      if (!publicDraftSaveCapable || postEditorState.draft === null) return;
      if (postSaveTimer !== null) win.clearTimeout(postSaveTimer);
      postSaveTimer = win.setTimeout(() => {
        postSaveTimer = null;
        if (postEditorState.dirty) void savePostDraft();
      }, 600);
    }
    async function publishPost() {
      if (postEditorState.publishing || postEditorState.saving || postEditorState.loading || postEditorState.uploading) return;
      if (!publishDraftCapable) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "当前宿主没有提供公开发布。";
        return;
      }
      if (postEditorState.validatingImages > 0) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = "图片仍在校验；完成后再检查或发布。";
        return;
      }
      if (!postEditorState.confirm) {
        if (!postFormValues().title.trim() || !postFormValues().bodyMarkdown.trim()) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "标题和正文不能为空；只有标题的输入会留在本机编辑器中，不会发布。";
          return;
        }
        const draft2 = postEditorState.dirty || postEditorState.draft === null ? await savePostDraft() : postEditorState.draft;
        if (!draft2 || !postEditorState.open || !postEditorPanel.open) return;
        if (postEditorState.dirty) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "保存期间内容有更新；当前版本尚未保存，请再次检查发布内容。";
          return;
        }
        if (postEditorState.pending.length > 0) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "还有待上传图片；保存完成后再检查发布内容。";
          return;
        }
        postEditorState.confirm = true;
        postEditorState.confirmSnapshot = postEditorSnapshot();
        postEditorState.confirmNotice = "";
        postEditorState.receipt = null;
        postPublishButton.textContent = "确认发布这条动态";
        postPublishCancel.hidden = false;
        const target = postConfirmationTarget(draft2);
        const identity = draft2.authorKind === "agent" ? `Agent${mineState.data?.agentCard?.state === "available" && mineState.data.agentCard.card?.displayName ? ` · ${mineState.data.agentCard.card.displayName}` : ""}` : `本人${mineState.data?.profile?.displayName ? ` · ${mineState.data.profile.displayName}` : ""}`;
        postPublishReceipt.hidden = false;
        postPublishReceipt.dataset.tone = "unavailable";
        postPublishReceipt.textContent = `将以${identity}署名发布到 ${target}${draft2.images?.length ? ` 与 ${draft2.images.length} 张图片` : ""}。确认后才会公开。`;
        postPublishButton.focus({ preventScroll: true });
        renderPostEditorStatus();
        postPublishReceipt.scrollIntoView?.({ block: "nearest" });
        return;
      }
      const confirmedSnapshot = postEditorState.confirmSnapshot;
      if (!confirmedSnapshot || confirmedSnapshot !== postEditorSnapshot() || postEditorState.pending.length > 0) {
        invalidatePostConfirm("内容或草稿版本已变化；旧确认已撤销，请重新检查发布内容。");
        postEditorNote.hidden = false;
        postEditorNote.textContent = "检查后的内容或图片已变化，请重新检查发布内容。";
        return;
      }
      const draft = postEditorState.draft;
      if (!draft) {
        invalidatePostConfirm("没有可发布的草稿；请重新检查发布内容。");
        return;
      }
      const epoch = postEditorState.draftEpoch;
      const versionAtPublish = postEditorState.formVersion;
      postEditorState.confirm = false;
      postEditorState.confirmSnapshot = null;
      postEditorState.confirmNotice = "";
      postPublishButton.textContent = "检查发布内容";
      postPublishCancel.hidden = true;
      postEditorState.publishing = true;
      renderPostEditorStatus();
      try {
        const receipt = await options.onPublishPublicDraft(draft.draftId, draft.revision, draft.publishedSha256 || "");
        if (epoch !== postEditorState.draftEpoch || postEditorState.draft?.draftId !== draft.draftId) {
          postEditorNote.hidden = false;
          postEditorNote.textContent = "发布回执属于已切换的草稿，未应用到当前编辑器；请核对实际公开清单。";
          return;
        }
        postEditorState.receipt = receipt;
        if (receipt.status === "published" || receipt.status === "already_published") {
          const changedDuringPublish = postEditorState.formVersion !== versionAtPublish;
          postEditorState.draft = {
            ...postEditorState.draft,
            publishedSha256: receipt.currentPublishedSha256 || draft.publishedSha256,
            publishedRevision: receipt.currentRevision || draft.revision,
            publishedPath: receipt.postPath || draft.publishedPath
          };
          postEditorState.dirty = changedDuringPublish;
          postAuthorKind.disabled = Boolean(postEditorState.draft.publishedPath);
          renderPostAuthorNote();
          postEditorNote.hidden = false;
          postEditorNote.textContent = changedDuringPublish ? "发布完成，但发布期间又有输入更新；新输入尚未保存或发布，请先保存草稿。" : "发布完成。真实公开路径与清单摘要见下方回执。";
          postPublishReceipt.scrollIntoView?.({ block: "nearest" });
          void loadMine(true);
        } else {
          postEditorState.error = receipt.error || "";
          postEditorNote.hidden = false;
          postEditorNote.textContent = receipt.error || "发布没有完成；原输入和草稿均保留。";
        }
      } catch (error) {
        postEditorNote.hidden = false;
        postEditorNote.textContent = errorText(error);
      } finally {
        postEditorState.publishing = false;
        postEditorState.saving = false;
        renderPostEditorStatus();
        const success = postEditorState.receipt && (postEditorState.receipt.status === "published" || postEditorState.receipt.status === "already_published");
        if (!postEditorState.open) {
        } else {
          restorePostEditorControlFocus(success && !postWriteAnother.hidden ? postWriteAnother : postPublishButton);
        }
        await loadPostDrafts();
      }
    }
    function renderSettingsView() {
      if (destroyed) return;
      view.settings.tab = showSettingsTab(root, view.settings.tab, { index: view.settings.index });
      updateSettingsFavoriteBackLabel();
      if (!view.settings.index && (view.settings.tab === "public" || view.settings.tab === "files")
        && mineCapable && mineState.data === null) void loadMine(false);
      if (!view.settings.index && (view.settings.tab === "private" || view.settings.tab === "node") && journeyCapable && journeyState.data === null) {
        void loadJourney(false);
      }
      renderPrivateEditors();
      renderSettingsMemory();
      renderSettingsFavorites();
      if (view.pages.explore.filter === "mine") updateMineFeedState();
      if (!view.settings.index && view.settings.tab === "public") void ensureProfileDraft(false);
      renderProfileDraftStatus();
      renderSettingsNode({ label: settingsNodeStatusLabel, summary: settingsNodeSummary }, {
        phase: nodeState.phase,
        status: nodeState.status,
        summary: nodeStatusSummaryText()
      });
    }
    function openSettings(tab = "") {
      if (destroyed) return;
      settingsFocusSeq += 1;
      clearSettingsFavoriteReturn();
      if (currentPage !== "settings") {
        settingsReturnPage = pageElsHas(currentPage) ? currentPage : "home";
        view.settings.returnPage = settingsReturnPage;
        settingsReturnScroll = pageTracksScroll(settingsReturnPage) && pageEls[settingsReturnPage] && !pageEls[settingsReturnPage].hidden
          ? Math.max(0, Number(pageEls[settingsReturnPage].scrollTop) || 0)
          : Math.max(0, Number(pageStateFor(settingsReturnPage)?.scroll) || 0);
        const active = root.activeElement ?? doc.activeElement;
        settingsReturnFocus = active && active !== doc.body && active.isConnected ? active : null;
      }
      settingsDirectEntry = Boolean(tab) && currentPage !== "settings";
      if (tab) {
        view.settings.tab = normalizeSettingsTab(tab);
        view.settings.index = false;
      } else {
        view.settings.index = true;
      }
      showPage("settings");
      renderSettingsView();
      saveNow();
    }
    function closeSettings() {
      clearSettingsFavoriteReturn();
      settingsDirectEntry = false;
      flushPublicDraftEditors();
      const target = pageElsHas(view.settings.returnPage) && view.settings.returnPage !== "settings" ? view.settings.returnPage : "home";
      const targetScroll = target === settingsReturnPage
        ? settingsReturnScroll
        : pageTracksScroll(target) ? Math.max(0, Number(pageStateFor(target)?.scroll) || 0) : 0;
      settingsReturnScroll = 0;
      showPage(target);
      const restoreTarget = target === "messages" ? contactsState.selectedPeerId ? messageInput : conversationQuery : settingsReturnFocus?.isConnected && !settingsReturnFocus.closest?.("[hidden]") ? settingsReturnFocus : null;
      settingsReturnFocus = null;
      const restoreSourceScroll = () => {
        if (destroyed || currentPage !== target || target === "messages" || targetScroll === 0) return;
        const page = pageEls[target];
        if (!page || page.hidden) return;
        if (Math.abs(Number(page.scrollTop) - targetScroll) >= 1) page.scrollTop = targetScroll;
        saveNow();
      };
      if (restoreTarget) {
        const seq = ++settingsFocusSeq;
        const focusReturnedControl = () => {
          if (destroyed || seq !== settingsFocusSeq || currentPage !== target) return;
          if (!restoreTarget.isConnected || restoreTarget.closest?.("[hidden]")) {
            if (target === "messages") conversationQuery.focus({ preventScroll: true });
            restoreSourceScroll();
            return;
          }
          restoreTarget.focus({ preventScroll: true });
          restoreSourceScroll();
        };
        if (typeof win.setTimeout === "function") win.setTimeout(focusReturnedControl, 0);
        else focusReturnedControl();
      } else if (typeof win.setTimeout === "function") {
        win.setTimeout(restoreSourceScroll, 0);
      } else {
        restoreSourceScroll();
      }
      if (target !== "messages" && typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(restoreSourceScroll);
      }
      if (target !== "messages" && typeof win.setTimeout === "function" && targetScroll > 0) {
        win.setTimeout(restoreSourceScroll, 120);
        win.setTimeout(restoreSourceScroll, 260);
      }
    }
    function flushPublicDraftEditors() {
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      if (profileDraftState.dirty && profileDraftState.loaded && publicDraftSaveCapable) {
        void saveProfileDraft();
      }
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
      }
      if (postEditorState.open && postEditorState.dirty && publicDraftSaveCapable) {
        void savePostDraft();
      }
    }
    function selectSettingsTab(tab) {
      if (!SETTINGS_TABS.includes(tab)) return;
      clearSettingsFavoriteReturn();
      settingsDirectEntry = false;
      view.settings.tab = tab;
      view.settings.index = false;
      renderSettingsView();
      pageEls.settings.scrollTop = 0;
      saveNow();
    }
    function renderMine() {
      const data = mineState.data;
      const profile = data?.profile ?? null;
      const posts = data?.posts ?? null;
      let files = Array.isArray(data?.files) ? data.files : [];
      files = files.filter((item) => !isPostImagePath(item.path));
      if (files.length === 0 && Array.isArray(posts?.posts) && posts.posts.length > 0) {
        files = posts.posts.map((post) => ({
          id: `legacy-mine:${post.path}`,
          peerId: data?.peerId ?? "",
          publisherName: profile?.displayName || "我",
          path: post.path,
          name: post.path.split("/").pop() || post.path,
          sha256: post.sha256,
          sizeBytes: post.sizeBytes,
          modifiedAt: 0,
          fetchedAt: 0,
          source: "local-public",
          sources: ["local-public"],
          kind: "markdown",
          mime: "text/markdown",
          previewable: true,
          title: post.title,
          summary: post.summary,
          tags: Array.isArray(post.tags) ? post.tags : [],
          publishedAt: post.publishedAt,
          authorKind: post.authorKind,
          authorName: post.authorName,
          contentState: "available",
          contentError: ""
        }));
      }
      const postsStatus = minePostsStateText(data ? { ...posts, files } : posts);
      mineContentStatus.textContent = postsStatus.text;
      mineContentStatus.dataset.tone = postsStatus.tone;
      disposePreviewMedia(minePostList);
      minePostList.replaceChildren();
      minePostList.hidden = true;
      const notes = [];
      if (data === null) {
        notes.push(mineState.error || "正在读取本机公开内容…");
      } else if (posts?.state === "error") {
        notes.push(`公开文件读取失败：${posts.error || "未知错误"}。这不表示没有公开内容。`);
      } else if (posts?.state === "missing") {
        notes.push("本机公开目录不可用，无法读取公开内容。");
      } else if (files.length === 0) {
        notes.push("本机 public/ 目录中没有公开文件。");
      }
      if (posts?.truncated || data?.filesTruncated) notes.push("公开内容超过本次有界扫描上限，列表可能不完整。");
      if (posts?.invalid > 0) notes.push(`有 ${posts.invalid} 个文件无法完整解析；如属于支持格式，仍会按文件信息显示。`);
      if (posts?.unattributed > 0) notes.push(`其中 ${posts.unattributed} 个文件缺少明确的本人作者声明；仍按发布节点公开名列出，原作者声明只在详情保留。`);
      if (posts?.agentAuthored > 0) notes.push(`另有 ${posts.agentAuthored} 个 Agent 署名文件也按公开内容列出，不再按用户作者身份排除。`);
      mineContentNote.textContent = notes.join(" ");
      mineContentNote.hidden = notes.length === 0;
      mineRetry.hidden = !(mineCapable && (data === null || posts?.state === "error" || profile?.state === "error"));
      mineRetry.textContent = mineState.retrying ? "正在重试…" : "重试读取公开资料";
      mineRetry.onclick = mineCapable ? () => {
        void loadMine(true);
      } : null;
      if (files.length > 0) {
        for (const item of files) {
          const key2 = previewKeyFor("mine", item);
          const expanded = mineExpanded.has(key2);
          const card = renderFileCard(itemWithPostMeta(item), {
            subject: "mine",
            expanded,
            onToggle: (next) => toggleMineFile(item, next),
            preview: minePreviews.get(key2) ?? null,
            showReveal: fileRevealCapable,
            reveal: revealResults.get(revealResultKey("mine", item)) ?? null,
            onReveal: (target) => {
              void revealFileItem("mine", target);
            },
            focusKey: `mine:${item.path}:${item.sha256}`,
            onOpenProfile: null
          });
          if (expanded && item.contentState === "available" && !minePreviews.has(key2)) {
            void ensureMinePreview(item);
          }
          minePostList.append(card);
        }
        minePostList.hidden = false;
        observePostImages(minePostList);
      }
      if (!mineCapable) {
        mineContentNote.textContent = "当前宿主没有提供本机公开内容读取。";
        mineContentNote.hidden = false;
      }
      if (view.pages.explore.filter === "mine") {
        updateMineFeedState();
        tryPostEditorReturnFocus();
      }
      if (profileDraftState.loaded && !profileDraftState.dirty) {
        const refreshed = fallbackProfileDraft();
        const editableFallback = profileDraftState.fromFallback && profileDraftState.draft && profileDraftState.draft.revision === 0;
        if (editableFallback) {
          profileDraftState.draft = { ...refreshed, draftId: "profile", kind: "profile", revision: 0 };
          setProfileForm(profileDraftState.draft);
        } else if (profileDraftState.draft && profileDraftState.draft.revision === 0) {
          profileDraftState.draft = {
            ...profileDraftState.draft,
            avatar: refreshed.avatar,
            humanAvatar: refreshed.humanAvatar,
            publishedSha256: refreshed.publishedSha256
          };
        }
        if (!destroyed && currentPage === "settings" && view.settings.tab === "public") {
          renderProfileAvatar();
          renderProfileHumanAvatar();
          renderProfileDraftStatus();
        }
      }
      renderHome();
    }
    function journeyCheckFor(peerId2, messageId2) {
      return journeyState.messageChecks?.get(`${peerId2}:${messageId2}`) ?? null;
    }
    function journeyCacheNeedsRead() {
      const data = journeyState.data;
      if (data === null || data.state === "error") return true;
      const at = Number(data.at);
      return !(at > 0) || Date.now() - at > JOURNEY_REVALIDATE_MS;
    }
    function journeyPeerLabel(peerId2) {
      const friend = contactFor(peerId2);
      return friend ? contactDisplayName(friend) : shortPeer(peerId2);
    }
    function journeySessions() {
      const data = journeyState.data;
      return Array.isArray(data?.sessions) ? data.sessions : [];
    }
    function journeyReadAt() {
      const at = Number(journeyState.data?.at);
      return at > 0 ? formatDateTime(at) : "";
    }
    function journeyScopeInfo() {
      const data = journeyState.data;
      const sessions = journeySessions();
      const readAt = journeyReadAt();
      const parts = [];
      if (readAt) parts.push(`读取于 ${readAt}`);
      if (data && data.state === "available") parts.push(`本次保留 ${sessions.length} 个 Journey 目录`);
      else if (data?.state === "missing") parts.push("没有可读取的 Journey 目录");
      else if (data?.state === "error") parts.push("Journey 目录读取失败");
      parts.push("事件最多展示 500 条，报告读取上限 512 KiB");
      if (data?.sessionsTruncated) parts.push("更早的目录未在本次读取范围内");
      return { readAt, sessions, truncated: data?.sessionsTruncated === true, text: parts.join("；") + "。" };
    }
    function capturePageRenderContext(pageName) {
      const page = pageEls[pageName];
      if (!page) return null;
      const active = root.activeElement;
      const inside = Boolean(active && page.contains(active));
      return {
        scroll: Math.max(0, page.scrollTop || 0),
        focusKey: inside ? active.dataset?.focusKey || (active.id ? `#${active.id}` : "") : ""
      };
    }
    function restorePageRenderContext(page, context) {
      if (!page || !context) return;
      if (currentPage === page.dataset.page) page.scrollTop = context.scroll;
      if (context.focusKey.length === 0) return;
      const target = context.focusKey.startsWith("#") ? root.querySelector(context.focusKey) : [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === context.focusKey);
      target?.focus({ preventScroll: true });
    }
    function focusJourneyReturnKey(selector) {
      if (!selector) return;
      const target = selector.startsWith("#") ? root.querySelector(selector) : [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === selector);
      target?.focus?.({ preventScroll: true });
    }
    function openJourneysPage({ focusSearch = true } = {}) {
      showPage("journeys");
      pageEls.journeys.scrollTop = view.pages.journeys.scroll;
      if (focusSearch) journeyQuery.focus?.({ preventScroll: true });
      saveNow();
    }
    function openJourneyDetail(sessionId, {
      source = "journeys",
      eventSeq = 0,
      operationId = "",
      returnFocus = ""
    } = {}) {
      const id = typeof sessionId === "string" ? sessionId : "";
      if (id.length === 0) return;
      const focusKey = returnFocus || (source === "home" ? `journey-home:${id}` : source === "journeys" ? `journey-list:${id}` : source === "activity" ? "home-activity-card" : `journey-memory:${id}`);
      journeyReport = { id, original: eventSeq > 0 || Boolean(operationId), preview: null };
      view.journey = {
        id,
        source,
        scroll: 0,
        highlightSeq: Math.max(0, Math.floor(Number(eventSeq) || 0)),
        activityOperationId: operationId || "",
        returnFocus: focusKey
      };
      showPage("journey");
      pageEls.journey.scrollTop = 0;
      if (journeyCapable && journeyState.data === null) void loadJourney(false);
      if (operationId && activityDetailCapable) void ensureActivityDetail(operationId);
      saveNow();
    }
    function openJourneyFromActivity(model) {
      const target = model?.target;
      if (!target || target.kind !== "journey" || !target.journeyId) return;
      const operationId = model.operation?.operationId || "";
      if (operationId) void ensureActivityDetail(operationId);
      openJourneyDetail(target.journeyId, {
        source: "activity",
        operationId,
        returnFocus: "home-activity-card"
      });
    }
    function matchJourneyEvent(session, detail) {
      if (!session || !detail) return 0;
      const operation = detail.operation || {};
      const evidence = detail.evidence || operation.evidence || {};
      const messages = new Set(Array.isArray(evidence.message_ids) ? evidence.message_ids : []);
      const path = String(evidence.path || operation.target?.path || "");
      const peer = String(evidence.peer_id || operation.target?.peer_id || "");
      let byMessage = 0;
      let byPath = 0;
      let byPeer = 0;
      for (const event of Array.isArray(session.events) ? session.events : []) {
        if (messages.size > 0 && journeyMessageRefs(event).some((ref) => messages.has(ref.messageId))) {
          byMessage = Math.max(byMessage, Number(event.sequence) || 0);
        }
        const paths = Array.isArray(event.contentPaths) ? event.contentPaths : [];
        if (path.length > 0 && paths.includes(path)) byPath = Math.max(byPath, Number(event.sequence) || 0);
        if (peer.length > 0 && event.peerId === peer) byPeer = Math.max(byPeer, Number(event.sequence) || 0);
      }
      return byMessage || byPath || byPeer;
    }
    function renderJourneyReadDetails() {
      const data = journeyState.data;
      const readAt = journeyReadAt();
      let statusText = "";
      let tone = "";
      if (journeyState.retrying) {
        statusText = readAt ? `正在刷新记录…下面仍是 ${readAt} 读取的内容。` : "正在读取本机 Journey 记录…";
      } else if (journeyState.error) {
        statusText = `刷新没有完成${readAt ? `，下面仍是 ${readAt} 读取的旧记录` : ""}：${journeyState.error}`;
        tone = "error";
      } else if (data?.freshness === "stale") {
        statusText = `${readAt ? `${readAt} 读取；` : ""}内容可能不是最新，可以刷新。`;
        tone = "unavailable";
      } else if (readAt) {
        statusText = `记录读取于 ${readAt}。`;
      }
      ramingaRecordsStatus.textContent = statusText;
      ramingaRecordsStatus.hidden = statusText.length === 0;
      ramingaRecordsStatus.dataset.tone = tone;
      const notes = [];
      if (data?.sessionsState === "missing") notes.push("还没有 Journey 记录。一次 Journey 不是聊天线程，也不由连接数生成。");
      if (data?.sessionsState === "error") notes.push(`Journey 列表读取失败：${data.sessionsError}`);
      if (data?.sessionsTruncated) notes.push(`只展示最近 ${journeySessions().length} 个 Journey 目录；更早记录不在本次读取范围。`);
      ramingaJourneyMeta.textContent = notes.join(" ");
      ramingaJourneyMeta.hidden = notes.length === 0;
      ramingaJourneyMeta.dataset.tone = data?.sessionsState === "error" ? "error" : "";
      const scope = journeyScopeInfo();
      journeysScopeBody.textContent = scope.text;
      journeysWarning.textContent = [
        data?.sessionsTruncated ? "本次只读取最近保留的 Journey 目录；更早记录未列出，不能据此断言没有更早的漫游。" : "",
        data?.sessionsState === "error" ? `Journey 列表读取失败：${data.sessionsError}` : ""
      ].filter(Boolean).join(" ");
      journeysWarning.hidden = journeysWarning.textContent.length === 0;
      journeysWarning.dataset.tone = data?.sessionsState === "error" ? "error" : "unavailable";
    }
    function renderHomeJourneyRecords() {
      const data = journeyState.data;
      const sessions = data?.state === "available" ? journeySessions() : [];
      const featured = activityFeaturedSessionId();
      const recent = sessions.filter((session) => session.id !== featured).slice(0, 6);
      const focusKey = focusRestoreKey(ramingaSessionList);
      const scroll2 = pageEls.home.scrollTop;
      ramingaSessionList.replaceChildren();
      for (const session of recent) {
        ramingaSessionList.append(renderJourneyTile(doc, session, {
          source: "home",
          peerLabel: journeyPeerLabel,
          focusKey: `journey-home:${session.id}`
        }));
      }
      ramingaSessionList.hidden = recent.length === 0;
      homeJourneysEmpty.hidden = !(data?.state === "available" && recent.length === 0);
      if (homeJourneysEmpty.hidden === false) {
        homeJourneysEmpty.textContent = sessions.length === 0 ? "还没有可读取的漫游记录。这里不会用工具活动记录冒充 Journey。" : "最近一条已显示在活动卡中；打开「全部记录」查看保留的 Journey。";
      }
      if (focusKey) {
        const target = [...ramingaSessionList.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        target?.focus({ preventScroll: true });
      }
      ramingaSessionList.scrollTop = 0;
      if (currentPage === "home" && pageEls.home.scrollTop !== scroll2) pageEls.home.scrollTop = scroll2;
      homeJourneysAll.disabled = !journeyCapable;
    }
    function renderJourneysPage() {
      if (!journeyCapable) {
        journeyList.hidden = true;
        journeysState.hidden = false;
        journeysState.dataset.tone = "unavailable";
        journeysStateTitle.textContent = "漫游记录读取暂不可用";
        journeysStateBody.textContent = "当前宿主没有提供私有 Agent 记录读取。";
        journeysStateAction.hidden = true;
        journeysCount.textContent = "不可用";
        journeysClear.hidden = view.pages.journeys.query.length === 0;
        return;
      }
      if (journeyQuery.value !== view.pages.journeys.query) journeyQuery.value = view.pages.journeys.query;
      const query = view.pages.journeys.query;
      journeysClear.hidden = query.trim().length === 0;
      const data = journeyState.data;
      const sessions = data?.state === "available" ? journeySessions() : [];
      const filtered = sessions.filter((session) => journeyMatches(session, query, journeyPeerLabel));
      const focusKey = focusRestoreKey(journeyList);
      journeyList.replaceChildren();
      for (const session of filtered) {
        journeyList.append(renderJourneyTile(doc, session, {
          source: "journeys",
          peerLabel: journeyPeerLabel,
          focusKey: `journey-list:${session.id}`
        }));
      }
      const ready = data !== null && data.state !== "error" && data.state !== "missing";
      journeyList.hidden = !ready || filtered.length === 0;
      journeysState.hidden = true;
      journeysStateAction.hidden = true;
      journeysStateAction.onclick = null;
      if (data === null) {
        journeysState.hidden = false;
        journeysStateTitle.textContent = journeyState.error ? "这次没有读到漫游记录" : "正在读取漫游记录";
        journeysStateBody.textContent = journeyState.error || "正在从本机 Agent 目录读取 Journey 记录。";
        journeysCount.textContent = "读取中";
        if (journeyState.error) {
          journeysStateAction.hidden = false;
          journeysStateAction.textContent = "重试读取";
          journeysStateAction.onclick = () => {
            void loadJourney(true);
          };
        }
      } else if (data.state === "missing" || data.state === "available" && sessions.length === 0) {
        journeysState.hidden = false;
        journeysStateTitle.textContent = "还没有漫游记录";
        journeysStateBody.textContent = journeyState.error || "本机 agent/sessions 中还没有可读取的 Journey。";
        journeysCount.textContent = "0 条";
      } else if (data.state === "error") {
        journeysState.hidden = false;
        journeysState.dataset.tone = "error";
        journeysStateTitle.textContent = "漫游记录读取失败";
        journeysStateBody.textContent = `${data.sessionsError || journeyState.error || "受控文件读取失败"}。这不代表没有记录。`;
        journeysCount.textContent = "读取失败";
        journeysStateAction.hidden = false;
        journeysStateAction.textContent = "重试读取";
        journeysStateAction.onclick = () => {
          void loadJourney(true);
        };
      } else if (filtered.length === 0) {
        journeysState.hidden = false;
        journeysStateTitle.textContent = "没有找到匹配的漫游记录";
        journeysStateBody.textContent = "换一个旅程名称或访问对象，或清除筛选。";
        journeysCount.textContent = `0 / ${sessions.length} 条`;
      } else {
        journeysCount.textContent = query.trim().length > 0 ? `显示 ${filtered.length} / ${sessions.length} 条` : `共 ${sessions.length} 条`;
      }
      if (focusKey) {
        const target = [...journeyList.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        target?.focus({ preventScroll: true });
      }
      renderJourneyReadDetails();
      journeysScope.hidden = false;
      journeysRefresh.disabled = !journeyCapable;
      journeysRefresh.textContent = journeyState.retrying ? "正在刷新…" : "刷新记录";
    }
    function renderJourneyMissing(sessionId, { fallbackDetail = null } = {}) {
      const wrap = doc.createDocumentFragment();
      const eyebrow = element("p", "rm-eyebrow");
      eyebrow.textContent = "LITTLE JOURNEY · 缺失";
      const heading = element("h1", "rm-journey-missing-title");
      heading.textContent = "漫游记录已不在本机";
      const body = element("p", "rm-journey-missing-body");
      const activityId = view.journey.activityOperationId;
      body.textContent = activityId ? "关联的工具调用仍在 activity.jsonl 中，但对应的 Journey 目录已不存在或无法读取。不会用其他 Journey 代替。" : "这条 Journey 目录已不存在或无法读取。不会用其他 Journey 代替。";
      const id = element("p", "rm-list-note");
      id.textContent = `记录标识：${sessionId}`;
      wrap.append(eyebrow, heading, body, id);
      if (activityId && activityDetailCapable) {
        const detail = activityState.detail.data;
        const same = activityState.detail.id === activityId;
        if (!same || activityState.detail.loading) {
          const loading = element("p", "rm-list-note");
          loading.textContent = "正在核对关联工具调用的可用证据…";
          wrap.append(loading);
        } else if (activityState.detail.error) {
          const failed = element("p", "rm-journey-check");
          failed.dataset.tone = "error";
          failed.textContent = `工具活动证据读取失败：${activityState.detail.error}`;
          wrap.append(failed);
        }
        const evidence = detail?.evidence || detail?.operation?.evidence || {};
        const peer = String(evidence.peer_id || detail?.operation?.target?.peer_id || "");
        const messageIds = Array.isArray(evidence.message_ids) ? evidence.message_ids : [];
        const actions = element("div", "rm-journey-actions");
        if (peer) {
          const profile = element("button", "rm-journey-action");
          profile.type = "button";
          profile.dataset.journeyFallbackPeer = peer;
          profile.textContent = "查看相关对象";
          const chat2 = element("button", "rm-journey-action");
          chat2.type = "button";
          chat2.dataset.journeyFallbackChat = peer;
          chat2.textContent = "打开相关会话";
          actions.append(profile, chat2);
        }
        for (const messageId2 of messageIds.slice(0, 6)) {
          if (!messageId2 || !peer) continue;
          const locate = element("button", "rm-journey-action");
          locate.type = "button";
          locate.dataset.journeyFallbackLocatePeer = peer;
          locate.dataset.journeyFallbackLocateMessage = messageId2;
          locate.textContent = `核对消息 ${String(messageId2).slice(0, 10)}…`;
          actions.append(locate);
        }
        if (actions.childElementCount > 0) wrap.append(actions);
        if (!peer && same && !activityState.detail.loading) {
          const missing = element("p", "rm-journey-check");
          missing.dataset.tone = "unavailable";
          missing.textContent = "这条工具调用没有可用的 Peer 或消息证据，无法回退。";
          wrap.append(missing);
        }
      }
      const note = element("p", "rm-list-note");
      note.textContent = "缺失只说明本次读取没有找到该记录，不会把其他旅程当成同一条。";
      wrap.append(note);
      journeyDetail.replaceChildren(wrap);
      journeyDetail.hidden = false;
      journeyPageState.hidden = true;
      journeyPageStateAction.hidden = true;
    }
    function renderJourneyReport(session, highlightSeq) {
      if (journeyReport.id !== session.id) journeyReport = { id: session.id, original: highlightSeq > 0, preview: null };
      const request = journeyReport;
      const preview = request.preview;
      const box = $("#journeyReport");
      const frameHost = $("#journeyReportFrame");
      const status = $("#journeyReportStatus");
      const toggle = $("#journeyReportToggle");
      if (!preview && typeof options.onLoadJourneyReport === "function") {
        request.preview = { state: "loading" };
        void Promise.resolve().then(() => options.onLoadJourneyReport(session.id)).catch((error) => ({
          state: "error", error: errorText(error)
        })).then((value) => {
          if (destroyed || journeyReport !== request) return;
          request.preview = value || { state: "missing" };
          if (currentPage === "journey" && view.journey.id === session.id) renderJourneyDetailPage();
        });
      }
      const available = preview?.state === "available" && Boolean(preview.html);
      const showReport = available && !request.original;
      box.hidden = !available && preview?.state !== "error" && request.preview?.state !== "loading";
      toggle.hidden = !available;
      toggle.textContent = showReport ? "原始日志" : "查看 HTML 报告";
      toggle.onclick = available ? () => {
        request.original = !request.original;
        renderJourneyDetailPage();
      } : null;
      status.hidden = available || box.hidden;
      status.textContent = preview?.state === "error" ? "HTML 报告读取失败，已显示原始日志。" : "正在读取 HTML 报告…";
      status.title = preview?.error || "";
      if (showReport) {
        let frame = frameHost.querySelector("iframe");
        if (!frame) {
          frame = element("iframe", "rm-html-frame rm-journey-report-frame");
          frame.setAttribute("sandbox", "");
          frame.referrerPolicy = "no-referrer";
          frameHost.append(frame);
        }
        frame.title = preview.title || "漫游 HTML 报告";
        if (frame.srcdoc !== preview.html) frame.srcdoc = preview.html;
      } else {
        frameHost.replaceChildren();
      }
      return showReport;
    }
    function renderJourneyDetailPage() {
      if (!journeyDetail) return;
      journeyBack.textContent = view.journey.source === "journeys" ? "← 返回全部记录" : "← 返回主页";
      $("#journeyReport").hidden = true;
      if (!journeyCapable) {
        journeyDetail.replaceChildren();
        journeyDetail.hidden = true;
        journeyPageState.hidden = false;
        journeyPageStateTitle.textContent = "漫游记录读取暂不可用";
        journeyPageStateBody.textContent = "当前宿主没有提供私有 Agent 记录读取。";
        journeyPageStateAction.hidden = false;
        journeyPageStateAction.textContent = "返回主页";
        journeyPageStateAction.onclick = () => showPage("home");
        return;
      }
      const data = journeyState.data;
      const id = view.journey.id;
      const session = journeySessions().find((item) => item.id === id) ?? null;
      if (data === null) {
        journeyDetail.replaceChildren();
        journeyDetail.hidden = true;
        journeyPageState.hidden = false;
        journeyPageState.dataset.tone = "unavailable";
        journeyPageStateTitle.textContent = journeyState.error ? "这次没有读到漫游记录" : "正在读取漫游记录";
        journeyPageStateBody.textContent = journeyState.error || "正在从本机 Agent 目录读取 Journey。";
        journeyPageStateAction.hidden = !journeyState.error;
        journeyPageStateAction.textContent = "重试读取";
        journeyPageStateAction.onclick = journeyState.error ? () => {
          void loadJourney(true);
        } : null;
        return;
      }
      if (!session) {
        renderJourneyMissing(id);
        return;
      }
      journeyPageState.hidden = true;
      journeyDetail.hidden = false;
      let highlightSeq = view.journey.highlightSeq;
      let activityMissing = false;
      let activityOperation = null;
      if (view.journey.source === "activity" && view.journey.activityOperationId) {
        const detail = activityState.detail.id === view.journey.activityOperationId ? activityState.detail.data : null;
        if (detail) {
          activityOperation = detail.operation || null;
          const matched = matchJourneyEvent(session, detail);
          if (matched > 0) highlightSeq = matched;
          else activityMissing = true;
        } else if (!activityState.detail.loading) {
          activityMissing = true;
        }
      }
      const showReport = renderJourneyReport(session, highlightSeq);
      if (showReport) {
        journeyDetail.hidden = true;
        return;
      }
      const scope = journeyScopeInfo();
      const pageScroll = pageEls.journey.scrollTop;
      renderJourneyDetail(doc, journeyDetail, session, {
        peerLabel: journeyPeerLabel,
        renderMarkdown: renderMarkdownInto,
        checkFor: journeyCheckFor,
        highlightSeq,
        activityMissingEvent: activityMissing,
        activityOperation,
        source: view.journey.source,
        scope,
        highlightFocus: highlightSeq > 0
      });
      journeyDetail.hidden = false;
      if (highlightSeq === 0 && currentPage === "journey" && pageEls.journey.scrollTop !== pageScroll) {
        pageEls.journey.scrollTop = pageScroll;
      }
    }
    function renderJourney() {
      if (destroyed) return;
      const homeContext = capturePageRenderContext("home");
      const journeysContext = capturePageRenderContext("journeys");
      const journeyContext = capturePageRenderContext("journey");
      try {
        const data = journeyState.data;
        const statePanel = $("#ramingaState");
        const stateTitle = $("#ramingaStateTitle");
        const stateBody = $("#ramingaStateBody");
        const stateAction = $("#ramingaStateAction");
        ramingaRefresh.hidden = !journeyCapable;
        ramingaRefresh.textContent = journeyState.retrying ? "正在刷新…" : journeyState.error ? "重试刷新" : "刷新记录";
        ramingaRefresh.setAttribute("aria-busy", journeyState.retrying ? "true" : "false");
        ramingaRefresh.dataset.focusKey = "journey-refresh";
        statePanel.hidden = true;
        if (!journeyCapable) {
          statePanel.hidden = false;
          stateTitle.textContent = "Agent 记录读取暂不可用";
          stateBody.textContent = "当前宿主没有提供私有 Agent 资料读取。";
          stateAction.hidden = false;
          stateAction.textContent = "查看节点状态";
          stateAction.onclick = () => openDialog(statusDialog, stateAction);
          ramingaSessionList.hidden = true;
          homeJourneysEmpty.hidden = true;
        } else if (journeyState.retrying && (data === null || data.state === "error")) {
          statePanel.hidden = false;
          stateTitle.textContent = "正在读取 Agent 记录";
          stateBody.textContent = "正在从本机数据目录读取 Journey 记录。";
          stateAction.hidden = false;
          stateAction.textContent = "查看节点状态";
          stateAction.onclick = () => openDialog(statusDialog, stateAction);
        } else if (data === null) {
          statePanel.hidden = false;
          stateTitle.textContent = journeyState.error ? "这次没有读到 Agent 记录" : "正在读取 Agent 记录";
          stateBody.textContent = journeyState.error || "正在从本机数据目录读取 Journey 记录。";
          stateAction.hidden = false;
          stateAction.textContent = "查看节点状态";
          stateAction.onclick = () => openDialog(statusDialog, stateAction);
        } else if (data.state === "missing") {
          statePanel.hidden = false;
          statePanel.dataset.tone = journeyState.error ? "error" : "unavailable";
          if (journeyState.error && !journeyState.retrying) {
            stateTitle.textContent = "这次没有刷新到 Agent 记录";
            stateBody.textContent = `${journeyState.error}。下面保留上次的空结果；这不代表现在一定没有记录。`;
          } else {
            stateTitle.textContent = "还没有可读取的 Agent 记录";
            stateBody.textContent = "没有找到 agent/sessions/。这不代表没有发生过活动。";
          }
          stateAction.hidden = false;
          stateAction.textContent = "查看节点状态";
          stateAction.onclick = () => openDialog(statusDialog, stateAction);
        } else if (data.state === "error") {
          statePanel.hidden = false;
          statePanel.dataset.tone = "error";
          stateTitle.textContent = "Agent 私有记录读取失败";
          stateBody.textContent = `${data.sessionsError || journeyState.error || "受控文件读取失败"}。这不代表没有记录，也不据此推测 Agent 正在运行。`;
          stateAction.hidden = false;
          stateAction.textContent = "查看节点状态";
          stateAction.onclick = () => openDialog(statusDialog, stateAction);
        }
        renderJourneyReadDetails();
        renderHomeJourneyRecords();
        if (currentPage === "journeys") renderJourneysPage();
        if (currentPage === "journey") renderJourneyDetailPage();
        renderPrivateEditors();
        renderHome();
      } finally {
        if (currentPage === "home") restorePageRenderContext(pageEls.home, homeContext);
        if (currentPage === "journeys") restorePageRenderContext(pageEls.journeys, journeysContext);
        if (currentPage === "journey") restorePageRenderContext(pageEls.journey, journeyContext);
      }
    }
    function loadJourney(force = false) {
      if (destroyed || !journeyCapable) {
        renderJourney();
        return;
      }
      if (!hostReady) {
        renderJourney();
        return;
      }
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
      return Promise.resolve(pending).then((value) => {
        if (destroyed || journeyState.request !== request) return;
        if (value === null || typeof value !== "object") throw new Error("Agent 记录没有返回结果");
        const previous = journeyState.data;
        if (value.state === "error" && previous !== null && previous.state !== "error") {
          throw new Error(value.sessionsError || "Agent 记录读取失败");
        }
        if (value.state === "error" && previous === null) journeyState.error = value.sessionsError || "Agent 记录读取失败";
        else journeyState.error = "";
        journeyState.data = value;
      }).catch((error) => {
        if (destroyed || journeyState.request !== request) return;
        const message = errorText(error) || "Agent 记录读取失败";
        journeyState.error = message;
        if (journeyState.data === null || journeyState.data.state === "error") {
          journeyState.data = {
            state: "error",
            at: Date.now(),
            sessionsError: message,
            sessions: [],
            persona: null,
            growth: null,
            sessionsState: "error",
            sessionsTruncated: false,
            freshness: "unavailable"
          };
        }
      }).finally(() => {
        if (destroyed || journeyState.request !== request) return;
        journeyState.request = null;
        journeyState.retrying = false;
        renderJourney();
        if (request.forceQueued && !destroyed) loadJourney(true);
      });
    }
    async function locateJourneyMessage(peerId2, messageId2, { source = "home", journeyId = "", eventSeq = 0 } = {}) {
      const key2 = `${peerId2}:${messageId2}`;
      journeyState.messageChecks ??= /* @__PURE__ */ new Map();
      if (!locateMessageCapable) {
        journeyState.messageChecks.set(key2, { tone: "unavailable", text: "当前宿主没有提供历史消息定位。" });
        renderJourney();
        return;
      }
      journeyState.messageChecks.set(key2, { tone: "", text: "正在核对当前保留消息…" });
      renderJourney();
      const request = ++locateSeq;
      locateRequests.set(key2, request);
      try {
        const result = await options.onLocateMessage(peerId2, messageId2);
        if (destroyed || locateRequests.get(key2) !== request) return;
        if (result?.found === true) {
          const samePeer = !result.peerId || result.peerId === peerId2;
          const sameMessage = result.message?.messageId === messageId2;
          const sameMessagePeer = !result.message?.peerId || result.message.peerId === peerId2;
          if (!samePeer || !sameMessage || !sameMessagePeer) {
            journeyState.messageChecks.set(key2, {
              tone: "unavailable",
              text: "宿主返回的消息与这条引用不一致，未打开其他消息。"
            });
            return;
          }
          journeyState.messageChecks.set(key2, {
            tone: "ready",
            text: `当前保留记录中存在这条消息（${formatDateTime(result.message.createdAt)}）。已打开会话；不会替换为其他消息。`
          });
          renderJourney();
          openConversation(peerId2, {
            source: source === "journey" && journeyId ? "journey" : source === "messages" ? "messages" : "home",
            focusMessageId: messageId2,
            journeyId,
            journeyEvent: eventSeq,
            journeyMessageId: messageId2
          });
          return;
        }
        const message = result?.complete === false ? result.error || "在本次有界查找中没有找到该消息；它可能更早或已被裁剪。" : result?.error || "该消息引用已不在当前保留消息中，无法定位；这里只保留历史观察。";
        journeyState.messageChecks.set(key2, { tone: "unavailable", text: message });
      } catch (error) {
        if (destroyed || locateRequests.get(key2) !== request) return;
        journeyState.messageChecks.set(key2, {
          tone: "error",
          text: `这次没有核对到消息引用：${errorText(error)}。不会跳到其他消息。`
        });
      } finally {
        if (!destroyed && locateRequests.get(key2) === request) {
          locateRequests.delete(key2);
          renderJourney();
        }
      }
    }
    function profileRefFor(peerId2, source, id) {
      return `${source}:${id ?? peerId2}`;
    }
    function profileEntryScroll(pageName) {
      const live = visiblePageScroll(pageName);
      const fallback = live ?? Math.max(0, Number(view.pages[pageName]?.scroll) || 0);
      const pressed = profilePressScroll;
      profilePressScroll = null;
      if (pressed && pressed.page === pageName && pressed.scroll > 0 && fallback === 0 && Math.abs(Date.now() - pressed.at) <= 1500) {
        return pressed.scroll;
      }
      return fallback;
    }
    function openPeerProfile(peerId2, { source = "contacts", ref = "", trigger = null } = {}) {
      const canonical = typeof peerId2 === "string" ? peerId2 : "";
      if (canonical.length === 0) return;
      if (canonical === selfPeerId()) {
        openOwnPublicSource({ peerId: canonical, id: ref || canonical }, trigger);
        return;
      }
      const current = currentPage;
      if (current === "messages" && contactsState.selectedPeerId) saveChatScroll();
      const tracksScroll = pageTracksScroll(current);
      const sourceScroll = tracksScroll ? profileEntryScroll(current) : Math.max(0, Number(pageStateFor(current)?.scroll) || 0);
      profileReturn.page = current;
      profileReturn.peerId = contactsState.selectedPeerId;
      profileReturn.scroll = sourceScroll;
      profileReturn.open = true;
      profileReturn.focusKey = "";
      profileScrollMemory = { tab: view.contactProfile.tab, scroll: 0, at: 0 };
      profileTriggerRef = ref || profileRefFor(canonical, source, canonical);
      if (view.contactProfile.peerId !== canonical) view.contactProfile.tab = "interactions";
      if (profileState.peerId !== canonical) resetProfileMemoryUi(canonical);
      view.contactProfile = {
        peerId: canonical,
        tab: view.contactProfile.tab,
        returnPage: current,
        returnPeer: current === "messages" ? contactsState.selectedPeerId : "",
        triggerId: profileTriggerRef
      };
      profileState.peerId = canonical;
      profileState.data = null;
      profileState.error = "";
      profileState.friends = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.posts = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.memory = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.node = { data: null, error: "", requestSeq: 0, retrying: false };
      const humanDetails = profileView.querySelector(".rm-profile-human-details");
      if (humanDetails) humanDetails.open = false;
      if (profileOriginDetails) profileOriginDetails.open = false;
      if (tracksScroll) {
        const sourceState = pageStateFor(current);
        if (sourceState) sourceState.scroll = sourceScroll;
      }
      saveNow();
      pageEls[current].hidden = true;
      profileView.hidden = false;
      profileView.scrollTop = 0;
      renderProfile();
      void loadPeerProfile(canonical, true);
    }
    function closePeerProfile({ restoreFocus = true } = {}) {
      if (profileView.hidden) return;
      const sourcePage = pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts";
      const tracksScroll = pageTracksScroll(sourcePage);
      const savedScroll = tracksScroll ? Math.max(0, Number(profileReturn.scroll) || 0) : Math.max(0, Number(view.pages[sourcePage]?.scroll) || 0);
      profileView.hidden = true;
      pageEls[sourcePage].hidden = false;
      if (tracksScroll) {
        const sourceState = pageStateFor(sourcePage);
        if (sourceState) sourceState.scroll = savedScroll;
      }
      pageEls[sourcePage].scrollTop = savedScroll;
      view.contactProfile = { peerId: "", tab: "interactions", returnPage: "", returnPeer: "", triggerId: "" };
      profileState.peerId = "";
      profileState.data = null;
      profileState.error = "";
      profileState.friends = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.posts = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.memory = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.node = { data: null, error: "", requestSeq: 0, retrying: false };
      resetProfileMemoryUi("");
      saveNow();
      profileReturn.open = false;
      profileReturn.scroll = null;
      profileReturn.focusKey = "";
      profileScrollMemory = { tab: "", scroll: 0, at: 0 };
      updatePrimaryNav(root, sourcePage);
      if (!restoreFocus) {
        if (tracksScroll) restorePageScrollAfterFocus(sourcePage, savedScroll);
        return;
      }
      const ref = profileTriggerRef;
      const target = [...root.querySelectorAll("[data-profile-ref]")].find((node) => node.dataset.profileRef === ref) ?? null;
      if (target) target.focus({ preventScroll: true });
      else root.querySelector("#nodeTrigger")?.focus({ preventScroll: true });
      if (tracksScroll) restorePageScrollAfterFocus(sourcePage, savedScroll);
    }
    function profileChatEntryScroll(trigger, fallback) {
      const pressed = profileChatPress;
      profileChatPress = null;
      if (pressed && pressed.trigger === trigger && Date.now() - pressed.at <= 1500 && pressed.scroll > 0) {
        return pressed.scroll;
      }
      const current = Math.max(0, Math.floor(Number(fallback) || 0));
      if (current > 0) return current;
      const tab = view.contactProfile.tab;
      if (profileScrollMemory.tab === tab && Date.now() - profileScrollMemory.at <= 2500) {
        return profileScrollMemory.scroll;
      }
      return 0;
    }
    function profileFocusTarget(key2) {
      if (!key2) return null;
      return [...profileView.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === key2) ?? null;
    }
    function restoreProfileAfterConversation(peerId2, tab, scrollTop, focusKey) {
      const sourcePage = pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts";
      const activeTab = ["interactions", "posts", "address"].includes(tab) ? tab : "interactions";
      for (const page of Object.values(pageEls)) page.hidden = true;
      view.contactProfile.tab = activeTab;
      view.contactProfile.returnPeer = sourcePage === "messages" ? peerId2 : "";
      profileView.hidden = false;
      currentPage = sourcePage;
      view.page = sourcePage;
      updatePrimaryNav(root, sourcePage);
      if (profileState.peerId !== peerId2) {
        resetProfileMemoryUi(peerId2);
        profileState.peerId = peerId2;
        profileState.data = null;
        profileState.error = "";
        profileState.retrying = false;
        profileState.friends = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.posts = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.memory = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.node = { data: null, error: "", requestSeq: 0, retrying: false };
        renderProfile();
        void loadPeerProfile(peerId2, true);
        if (activeTab === "address") void loadPeerFriends(peerId2, true);
      } else {
        renderProfileTabs();
        if (profileState.data === null && !profileState.retrying) {
          void loadPeerProfile(peerId2, true);
        }
        if (activeTab === "address" && profileState.friends.data === null && !profileState.friends.retrying) {
          void loadPeerFriends(peerId2, true);
        }
        if (activeTab === "posts" && profileState.posts.data === null && !profileState.posts.retrying) {
          void loadPeerDiscoveries(peerId2, true);
        }
        if (activeTab === "interactions" && profileState.memory.data === null && !profileState.memory.retrying) {
          void loadContactMemory(peerId2, true);
        }
      }
      const savedSourceScroll = pageTracksScroll(sourcePage) ? Math.max(0, Number(pageStateFor(sourcePage)?.scroll) || 0) : Math.max(0, Number(view.pages.messages?.scroll) || 0);
      profileReturn.page = sourcePage;
      profileReturn.peerId = sourcePage === "messages" ? peerId2 : "";
      profileReturn.open = true;
      profileReturn.scroll = savedSourceScroll;
      const resolvedFocus = focusKey ? memoryFocusLookup(profileState.memory.data?.timeline || [], focusKey)?.key || focusKey : "";
      const exactTarget = profileFocusTarget(resolvedFocus);
      const target = exactTarget ?? (profileMessage.hidden ? null : profileMessage);
      profileReturn.focusKey = exactTarget ? "" : resolvedFocus;
      target?.focus?.({ preventScroll: true });
      profileView.scrollTop = Math.max(0, Math.floor(Number(scrollTop) || 0));
      saveNow();
    }
    async function loadPeerProfile(peerId2, force = false) {
      if (!hostReady) {
        profileState.error = "工作区正在连接本机节点，请稍后重试。";
        renderProfile();
        return;
      }
      if (!peerProfileCapable) {
        profileState.error = "当前宿主没有提供对方公开资料读取。";
        renderProfile();
        return;
      }
      const request = ++profileState.requestSeq;
      profileState.retrying = true;
      profileState.error = "";
      renderProfile();
      try {
        const value = await options.onLoadPeerProfile(peerId2, force === true);
        if (destroyed || request !== profileState.requestSeq) return;
        if (value === null || typeof value !== "object") throw new Error("对方公开资料没有返回结果");
        profileState.data = value;
        profileState.error = value.error || "";
        rememberVerifiedContactProfile(peerId2, value);
        if (currentPage === "contacts" && contactsState.data !== null) updateContactsState();
        if (contactsState.selectedPeerId === peerId2 && !conversationView.hidden) updateConversationIdentity(peerId2);
      } catch (error) {
        if (destroyed || request !== profileState.requestSeq) return;
        profileState.error = errorText(error) || "对方公开资料读取失败";
      } finally {
        if (!destroyed && request === profileState.requestSeq) {
          profileState.retrying = false;
          renderProfile();
        }
      }
    }
    async function loadPeerFriends(peerId2, force = false) {
      const target = typeof peerId2 === "string" ? peerId2 : "";
      if (target.length === 0) return;
      if (!peerFriendsCapable) {
        profileState.friends.error = "当前宿主没有提供公开通讯录读取。";
        renderProfileFriends();
        return;
      }
      if (!hostReady) {
        profileState.friends.error = "工作区正在连接本机节点，请稍后重试。";
        renderProfileFriends();
        return;
      }
      const request = ++profileState.friends.requestSeq;
      profileState.friends.retrying = true;
      profileState.friends.error = "";
      renderProfileFriends();
      try {
        const value = await options.onLoadPeerFriends(target, force === true);
        if (destroyed || request !== profileState.friends.requestSeq || profileState.peerId !== target) return;
        if (value === null || typeof value !== "object") throw new Error("公开通讯录没有返回结果");
        const failure = String(value.error ?? "").trim();
        if (failure.length > 0) {
          profileState.friends.error = failure;
          return;
        }
        profileState.friends.data = value;
        profileState.friends.error = "";
        rememberDirectoryClues(target, value);
        renderContactClues();
      } catch (error) {
        if (destroyed || request !== profileState.friends.requestSeq || profileState.peerId !== target) return;
        profileState.friends.error = errorText(error) || "公开通讯录读取失败";
      } finally {
        if (!destroyed && request === profileState.friends.requestSeq) {
          profileState.friends.retrying = false;
          renderProfileFriends();
        }
      }
    }
    function profileFriendHistory(sourcePeerId) {
      const source = String(sourcePeerId ?? "");
      const rows = [];
      if (source.length === 0) return rows;
      for (const clue of directoryClues.values()) {
        const peerId2 = String(clue?.peerId ?? "").trim();
        if (!peerId2 || clue.sourcePeerId !== source || peerId2 === source || peerId2 === selfPeerId()) continue;
        rows.push({
          peerId: peerId2,
          name: clue.name,
          description: clue.description,
          at: Number(clue.at) > 0 ? Number(clue.at) : 0
        });
      }
      rows.sort((left, right) => right.at - left.at);
      return rows;
    }
    function renderProfileFriends() {
      if (!profileAddressStatus) return;
      const data = profileState.friends.data;
      const error = String(profileState.friends.error || data?.error || "").trim();
      const live = data !== null && typeof data === "object" && String(data.error ?? "").trim().length === 0 && data.source !== "unavailable";
      const liveFriends = live && Array.isArray(data.friends) ? data.friends.filter((friend) => String(friend?.peerId ?? "").trim().length > 0) : [];
      const history = live ? [] : profileFriendHistory(profileState.peerId);
      const friends = live ? liveFriends : history;
      const loading = !live && profileState.friends.retrying && error.length === 0;
      const historyMode = friends.length > 0 && (!live || error.length > 0);
      const historyLabel = live ? "上次读取" : "本机历史";
      const lastReadAt = historyMode ? live ? Number(data?.at) > 0 ? Number(data.at) : 0 : history.reduce((newest, row) => Math.max(newest, Number(row.at) || 0), 0) : 0;
      profileAddressStatus.textContent = !peerFriendsCapable ? "不可用" : loading ? "读取中" : error ? "读取失败" : friends.length > 0 ? `${friends.length} 位` : "无记录";
      profileAddressStatus.dataset.tone = error ? "error" : friends.length > 0 ? "ready" : "unavailable";
      profileFriendList.replaceChildren();
      profileFriendList.hidden = friends.length === 0;
      const failedEmpty = !loading && error.length > 0 && friends.length === 0;
      const successEmpty = !loading && error.length === 0 && live && friends.length === 0;
      profileAddressEmpty.hidden = !(failedEmpty || successEmpty);
      if (failedEmpty) {
        profileAddressEmpty.dataset.tone = "error";
        if (profileAddressEmptyTitle) profileAddressEmptyTitle.textContent = "没有可用的历史通讯录";
        if (profileAddressEmptyText) profileAddressEmptyText.textContent = "本次读取失败，本机也没有保存过对方的通讯录；可以稍后重试。";
      } else {
        delete profileAddressEmpty.dataset.tone;
        if (profileAddressEmptyTitle) profileAddressEmptyTitle.textContent = "没有读取到公开通讯录";
        if (profileAddressEmptyText) profileAddressEmptyText.textContent = "对方没有公开通讯录，或当前清单中没有条目。";
      }
      profileAddressRetry.hidden = !peerFriendsCapable || error.length === 0;
      profileAddressRetry.textContent = profileState.friends.retrying ? "正在重试…" : "重试读取通讯录";
      profileAddressRetry.disabled = profileState.friends.retrying;
      if (!peerFriendsCapable) {
        profileAddressNote.textContent = "当前宿主没有提供公开通讯录读取。";
      } else if (error) {
        const reason = readFailureSummary(error, "对方当前不可达或没有公开通讯录。");
        if (friends.length > 0) {
          const at = lastReadAt > 0 ? `，读取于 ${formatDateTime(lastReadAt)}` : "";
          profileAddressNote.textContent = live ? `本次读取失败：${reason} 下面保留本次面板上次成功读取的 ${friends.length} 条结果${at}；它只代表上次读取，不是本次实时通讯录，也不代表完整同步。` : `本次读取失败：${reason} 下面是从本机历史恢复的上次读取记录，共 ${friends.length} 条${at}。本机持久投影只保留有界的一部分，可能只是部分历史，不是对方当前通讯录的完整内容。`;
        } else {
          profileAddressNote.textContent = `通讯录读取失败：${reason}`;
        }
        profileAddressNote.title = "";
      } else if (loading) {
        profileAddressNote.textContent = friends.length > 0 ? `正在读取对方公开通讯录… 下面先显示本机上次成功读取的 ${friends.length} 条历史，成功后会替换。` : "正在读取对方公开通讯录…";
      } else if (data?.limited) {
        profileAddressNote.textContent = "公开通讯录只读取到本次有界清单的一部分。";
      } else if (data) {
        profileAddressNote.textContent = "条目由对方公开声明，不代表你已认识这些节点。";
      } else {
        profileAddressNote.textContent = "打开这个区域时读取对方的公开通讯录。";
      }
      profileAddressNote.dataset.tone = error ? (friends.length > 0 ? "warning" : "error") : peerFriendsCapable && !loading && data?.limited ? "warning" : "";
      profileAddressNote.hidden = profileAddressNote.textContent.length === 0;
      profileAddressDetails.hidden = !error;
      profileAddressRaw.textContent = error || "";
      for (const friend of friends) {
        const friendPeer = String(friend?.peerId ?? "").trim();
        if (friendPeer.length === 0) continue;
        const displayName = String(friend?.name ?? "").trim() || shortPeer(friendPeer);
        const local = contactFor(friendPeer);
        const row = element("article", "rm-friend-row");
        row.dataset.friendPeer = friendPeer;
        if (historyMode) row.dataset.friendHistory = live ? "last-read" : "local-history";
        const avatar = element("span", "rm-friend-avatar");
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = (displayName || "?").slice(0, 1);
        const copy = element("div", "rm-friend-copy");
        const head = element("div", "rm-friend-head");
        const name = element("b");
        name.textContent = displayName;
        const badge = element("span", local ? "rm-badge rm-friend-badge" : "rm-badge rm-badge-quiet rm-friend-badge");
        badge.textContent = local ? "已有联系" : "公开线索";
        head.append(name, badge);
        if (historyMode) {
          const historyBadge = element("span", "rm-badge rm-badge-quiet rm-friend-badge rm-friend-history");
          historyBadge.textContent = historyLabel;
          historyBadge.title = lastReadAt > 0 ? `上次成功读取于 ${formatDateTime(lastReadAt)}` : "上次成功读取的本机记录";
          head.append(historyBadge);
        }
        const peer = element("code", "rm-peer-id");
        peer.textContent = shortPeer(friendPeer);
        copy.append(head, peer);
        const descriptionText = String(friend?.description ?? "").trim();
        if (descriptionText.length > 0) {
          const description = element("p", "rm-friend-description");
          description.textContent = descriptionText;
          copy.append(description);
        }
        row.append(avatar, copy);
        if (!local) {
          const hint = element("span", "rm-friend-hint");
          hint.textContent = "尚未联系";
          row.append(hint);
        }
        profileFriendList.append(row);
      }
    }
    function rerenderProfileKeepingPosition() {
      const scroll2 = profileView.scrollTop;
      const active = root.activeElement;
      const focusKey = active?.dataset?.focusKey || profileReturn.focusKey || "";
      renderProfile();
      profileView.scrollTop = scroll2;
      if (focusKey) {
        const target = [...profileView.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        target?.focus({ preventScroll: true });
        if (target && profileReturn.focusKey === focusKey) profileReturn.focusKey = "";
      }
    }
    async function ensureProfilePreview(item) {
      const key2 = previewKeyFor("peer", item);
      const existing = profilePreviews.get(key2);
      if (existing?.state === "loading") return;
      if (!peerFileContentCapable) {
        profilePreviews.set(key2, { state: "error", error: "当前宿主没有提供对方公开文件的按需读取。" });
        rerenderProfileKeepingPosition();
        return;
      }
      profilePreviews.set(key2, { state: "loading" });
      rerenderProfileKeepingPosition();
      try {
        const value = await options.onLoadPeerFileContent(item.peerId, item.path, item.sha256, item.sizeBytes);
        if (destroyed) return;
        if (value && typeof value === "object") {
          const expectedSha = String(item.sha256 ?? "").toLowerCase();
          const returnedSha = String(value.sha256 ?? "").toLowerCase();
          if (value.path && value.path !== item.path) throw new Error("对方公开文件返回的路径与请求不一致，已停止显示。");
          if (expectedSha && returnedSha && returnedSha !== expectedSha) {
            throw new Error("对方公开文件返回的版本与请求不一致，已停止显示。");
          }
          profilePreviews.set(key2, { state: "available", data: value });
        } else {
          profilePreviews.set(key2, { state: "error", error: "对方公开文件读取没有返回结果" });
        }
      } catch (error) {
        if (!destroyed) profilePreviews.set(key2, { state: "error", error: errorText(error) || "对方公开文件读取失败" });
      }
      if (!destroyed) rerenderProfileKeepingPosition();
    }
    function toggleProfileFile(item, next) {
      const key2 = previewKeyFor("peer", item);
      if (!next) {
        profileExpanded.delete(key2);
        disposePreviewMedia(profileView);
      } else {
        profileExpanded.add(key2);
      }
      rerenderProfileKeepingPosition();
    }
    function appendAddressRows(container, addresses) {
      container.replaceChildren();
      for (const address of addresses) {
        const item = element("li", "rm-address-item");
        const code = element("code");
        code.textContent = address.multiaddr;
        const meta = element("span", "rm-address-meta");
        const observed = address.observedAt ? ` · ${formatDateTime(address.observedAt)}` : "";
        const detail = address.sourceDetail && address.sourceDetail !== address.source ? ` · ${address.sourceDetail}` : "";
        meta.textContent = `${addressSourceLabel(address.source)}${detail} · ${reachabilityLabel(address.reachability)}${observed}`;
        meta.dataset.reachability = address.reachability;
        item.append(code, meta);
        container.append(item);
      }
    }
    async function copyTextWithNotice(text4, note, success) {
      if (!text4) {
        note.textContent = "没有可复制的内容。";
        note.hidden = false;
        return;
      }
      try {
        if (typeof options.onCopyText !== "function") throw new Error("复制能力不可用");
        const copied = await options.onCopyText(text4);
        if (copied === false) throw new Error("复制能力不可用");
        note.textContent = success;
        note.hidden = false;
        note.dataset.tone = "";
      } catch {
        note.textContent = "复制失败，请手动选择页面上的文本。";
        note.hidden = false;
        note.dataset.tone = "error";
      }
    }
    function currentPeerNodeSnapshot() {
      const independent = profileState.node.data;
      if (independent && typeof independent === "object") return independent;
      const fromProfile = profileState.data?.node;
      return fromProfile && typeof fromProfile === "object" ? fromProfile : null;
    }
    async function loadPeerNodeInfo(peerId2, force = false) {
      const target = typeof peerId2 === "string" ? peerId2 : "";
      if (destroyed || target.length === 0) return;
      if (!peerNodeInfoCapable) {
        profileState.node.error = "当前宿主没有提供对方节点信息读取。";
        renderPeerNodeInfo();
        return;
      }
      if (!hostReady) {
        profileState.node.error = "工作区正在连接本机节点，请稍后重试。";
        renderPeerNodeInfo();
        return;
      }
      if (profileState.node.retrying) return;
      if (!force && profileState.node.data !== null) {
        renderPeerNodeInfo();
        return;
      }
      const state = profileState.node;
      const request = ++state.requestSeq;
      const isCurrent = () => !destroyed && profileState.node === state
        && state.requestSeq === request && profileState.peerId === target;
      state.retrying = true;
      state.error = "";
      renderPeerNodeInfo();
      try {
        const value = await options.onLoadPeerNodeInfo(target, force === true);
        if (!isCurrent()) return;
        if (value === null || typeof value !== "object") throw new Error("对方节点信息没有返回结果");
        state.data = value;
        state.error = String(value.error ?? "").trim();
      } catch (error) {
        if (!isCurrent()) return;
        state.error = errorText(error) || "对方节点信息读取失败";
      } finally {
        if (isCurrent()) {
          state.retrying = false;
          renderPeerNodeInfo();
        }
      }
    }
    async function refreshPeerNodeInfo() {
      const peerId2 = profileState.peerId;
      if (!peerId2) return;
      await loadPeerNodeInfo(peerId2, true);
    }
    function renderPeerNodeInfo(node = currentPeerNodeSnapshot()) {
      const peerId2 = profileState.peerId;
      const value = node && typeof node === "object" ? node : {
        connectionState: "unknown",
        directConnections: 0,
        relayConnections: 0,
        currentAddresses: [],
        knownAddresses: [],
        statusAt: null,
        freshness: "unavailable",
        error: ""
      };
      const currentAddresses = Array.isArray(value.currentAddresses) ? value.currentAddresses : [];
      const knownAddresses = Array.isArray(value.knownAddresses) ? value.knownAddresses : [];
      const error = String(profileState.node.error || value.error || "").trim();
      const retrying = profileState.node.retrying;
      const freshness = error && value.freshness === "live" ? "stale" : value.freshness;
      profileNodeConnection.textContent = `${connectionStateLabel(value.connectionState, freshness)} · 直连 ${Number(value.directConnections) || 0} · 中继 ${Number(value.relayConnections) || 0}`;
      profileNodeRoutes.textContent = freshness === "live" ? "状态来自最近一次本机 Status 读取" : "非实时快照；旧地址未验证可达";
      profileNodeStatusAt.textContent = value.statusAt ? refreshedText(value.statusAt) : "尚未读取";
      appendAddressRows(profileCurrentAddrs, freshness === "live" ? currentAddresses
        : currentAddresses.map((address) => ({ ...address, reachability: "unverified" })));
      appendAddressRows(profileAnnouncedAddrs, knownAddresses);
      profileCurrentNote.textContent = currentAddresses.length === 0 ? "当前没有到对方的活动连接地址。这不等于对方永久离线。" : freshness === "live" ? "这些地址来自本机当前连接，已在本机建立连接时验证。" : "这些是旧快照中的连接地址，当前未验证可达。";
      profileCurrentNote.hidden = false;
      profileAnnouncedNote.textContent = knownAddresses.length === 0 ? "本机没有缓存到对方已知地址。" : "这些是本机 Peerstore、缓存或联系人中的已知地址，不是对方公告证据，也不证明现在可达。";
      profileAnnouncedNote.hidden = false;
      profileCopyCurrent.disabled = currentAddresses.length === 0;
      profileCopyAnnounced.disabled = knownAddresses.length === 0;
      profileNodeRefresh.disabled = !peerNodeInfoCapable || peerId2.length === 0 || retrying;
      profileNodeRefresh.textContent = retrying ? "正在刷新…" : "刷新节点信息";
      if (peerId2.length === 0) {
        profileNodeNote.hidden = true;
        profileNodeNote.textContent = "";
        profileNodeNote.dataset.tone = "";
      } else if (!peerNodeInfoCapable) {
        profileNodeNote.textContent = "当前宿主没有提供对方节点信息读取；这里只显示公开档案附带的本机快照。";
        profileNodeNote.hidden = false;
        profileNodeNote.dataset.tone = "error";
      } else if (retrying) {
        profileNodeNote.textContent = "正在读取本机 Status 快照和地址缓存…";
        profileNodeNote.hidden = false;
        profileNodeNote.dataset.tone = "";
      } else if (error) {
        profileNodeNote.textContent = `节点信息读取失败：${error}。${currentAddresses.length + knownAddresses.length > 0 ? "下面保留已有地址并标明未验证。" : "可以稍后刷新重试。"}`;
        profileNodeNote.hidden = false;
        profileNodeNote.dataset.tone = "error";
      } else if (value.freshness !== "live") {
        profileNodeNote.textContent = "连接状态不是实时快照；只把已列出来源和可达性标签作为线索。";
        profileNodeNote.hidden = false;
        profileNodeNote.dataset.tone = "unavailable";
      } else {
        profileNodeNote.hidden = true;
        profileNodeNote.textContent = "";
        profileNodeNote.dataset.tone = "";
      }
    }
    async function loadPeerDiscoveries(peerId2, force = false) {
      const target = typeof peerId2 === "string" ? peerId2 : "";
      if (!target) return;
      if (!peerDiscoveriesCapable) {
        profileState.posts.error = "当前宿主没有提供联系人动态读取。";
        renderProfilePeerPosts(target);
        return;
      }
      if (!hostReady) {
        profileState.posts.error = "工作区正在连接本机节点，请稍后重试。";
        renderProfilePeerPosts(target);
        return;
      }
      const request = ++profileState.posts.requestSeq;
      profileState.posts.retrying = true;
      profileState.posts.error = "";
      renderProfilePeerPosts(target);
      try {
        const value = await options.onLoadPeerDiscoveries(target, force === true);
        if (destroyed || request !== profileState.posts.requestSeq || profileState.peerId !== target) return;
        if (value === null || typeof value !== "object") throw new Error("联系人动态没有返回结果");
        profileState.posts.data = value;
        profileState.posts.error = value.error || "";
      } catch (error) {
        if (destroyed || request !== profileState.posts.requestSeq || profileState.peerId !== target) return;
        profileState.posts.error = errorText(error) || "联系人动态读取失败";
      } finally {
        if (!destroyed && request === profileState.posts.requestSeq) {
          profileState.posts.retrying = false;
          renderProfilePeerPosts(target);
        }
      }
    }
    async function loadContactMemory(peerId2, force = false) {
      const target = typeof peerId2 === "string" ? peerId2 : "";
      if (!target) return;
      if (!contactMemoryCapable) {
        profileState.memory.error = "当前宿主没有提供私有社交记忆读取。";
        renderProfileMemory();
        return;
      }
      if (!hostReady) {
        profileState.memory.error = "工作区正在连接本机节点，请稍后重试。";
        renderProfileMemory();
        return;
      }
      if (!force && profileState.memory.data !== null) {
        renderProfileMemory();
        return;
      }
      const request = ++profileState.memory.requestSeq;
      profileState.memory.retrying = true;
      profileState.memory.error = "";
      renderProfileMemory();
      try {
        const value = await options.onLoadContactMemory(target);
        if (destroyed || request !== profileState.memory.requestSeq || profileState.peerId !== target) return;
        if (value === null || typeof value !== "object") throw new Error("私有社交记忆没有返回结果");
        profileState.memory.data = value;
        profileState.memory.error = value.sources ? "" : value.error || "";
      } catch (error) {
        if (destroyed || request !== profileState.memory.requestSeq || profileState.peerId !== target) return;
        profileState.memory.error = errorText(error) || "私有社交记忆读取失败";
      } finally {
        if (!destroyed && request === profileState.memory.requestSeq) {
          profileState.memory.retrying = false;
          renderProfileMemory();
        }
      }
    }
    async function refreshProfilePosts(peerId2) {
      if (!peerManifestCapable) return loadPeerProfile(peerId2, true);
      const posts = profileState.posts;
      posts.manifestRetrying = true;
      posts.manifestError = "";
      renderProfilePeerPosts(peerId2);
      try {
        posts.manifest = await options.onLoadPeerManifest(peerId2, true);
      } catch (error) {
        posts.manifestError = errorText(error) || "公开清单读取失败";
      } finally {
        posts.manifestRetrying = false;
        if (!destroyed && profileState.posts === posts && profileState.peerId === peerId2) renderProfilePeerPosts(peerId2);
      }
    }
    function preparePeerPostContext(peerId2) {
      const peer = String(peerId2 ?? "");
      if (!peer) return false;
      if (profileState.peerId !== peer) {
        resetProfileMemoryUi(peer);
        profileState.peerId = peer;
        profileState.data = null;
        profileState.error = "";
        profileState.retrying = false;
        profileState.friends = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.posts = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.memory = { data: null, error: "", requestSeq: 0, retrying: false };
        profileState.node = { data: null, error: "", requestSeq: 0, retrying: false };
      }
      if (view.contactProfile.peerId !== peer) {
        const returnPage = pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts";
        view.contactProfile = {
          peerId: peer,
          tab: "posts",
          returnPage,
          returnPeer: returnPage === "messages" ? view.contactProfile.returnPeer : "",
          triggerId: view.contactProfile.triggerId || ""
        };
      } else {
        view.contactProfile.tab = "posts";
      }
      if (!profileReturn.open) {
        const returnPage = pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts";
        profileReturn.page = returnPage;
        profileReturn.peerId = view.contactProfile.returnPeer;
        profileTriggerRef = view.contactProfile.triggerId || "";
        profileReturn.scroll = pageTracksScroll(returnPage)
          ? Math.max(0, Number(pageStateFor(returnPage)?.scroll) || 0)
          : Math.max(0, Number(view.pages.messages?.scroll) || 0);
        profileReturn.open = true;
      }
      return true;
    }
    function renderProfilePeerPosts(peerId2) {
      if (!profilePostList) return;
      const { data, manifest, currentEntries, items, candidateParents, discoveryKeys } = profileFeedState();
      const error = profileState.posts.error || data?.error || "";
      if (view.contactProfile.tab === "posts" && !profileView.hidden) {
        // These metadata reads decide whether an independent file card should exist.
        // Resolve them even when the parent post is below the viewport.
        for (const item of items) {
          if (candidateParents.has(item.path) && item.kind !== "markdown") ensurePostMeta(item);
        }
      }
      const loading = items.length === 0 && (profileState.retrying || profileState.posts.manifestRetrying || (data === null && profileState.posts.retrying)) && !error;
      profilePostsStatus.textContent = loading ? "读取中" : items.length > 0 ? `${items.length} 条` : manifest?.source === "remote" ? "暂无公开动态" : "无本地副本";
      profilePostsStatus.dataset.tone = error ? "error" : items.length > 0 ? "ready" : "unavailable";
      profilePostsRefresh.disabled = !(peerProfileCapable || peerManifestCapable) || !peerId2 || profileState.retrying || profileState.posts.manifestRetrying;
      profilePostsRefresh.onclick = () => void refreshProfilePosts(peerId2);
      const notes = [];
      if (loading) notes.push("正在读取本机发现记录中属于该联系人的公开动态副本…");
      if (error) notes.push(`本地历史副本读取失败：${error}`);
      const manifestError = profileState.posts.manifestError || manifest?.error;
      if (manifestError) notes.push(readFailureSummary(manifestError));
      if (manifest?.truncated) notes.push("公开清单超过本次读取上限。");
      if (currentEntries.length > 0) notes.push(`对方公开清单当前列出 ${currentEntries.length} 条动态。`);
      if (!loading && manifest?.source === "remote" && items.length === 0) {
        notes.push("对方当前的公开清单中没有动态。");
      } else if (manifest?.source !== "remote" && items.length > 0) {
        notes.push("本机历史副本 · 对方当前的公开动态暂不可用。");
      }
      if (data?.truncated) notes.push("本次有界读取没有覆盖全部本地副本。");
      if (favoritesState.actionError) notes.push(favoritesState.actionError);
      const readFailed = Boolean(error || manifestError);
      profilePostsNote.dataset.tone = favoritesState.actionError || (readFailed && items.length === 0)
        ? "error"
        : readFailed || manifest?.truncated || data?.truncated || (manifest?.source !== "remote" && items.length > 0) ? "warning" : "";
      profilePostsNote.textContent = notes.join(" ");
      profilePostsNote.hidden = notes.length === 0;
      const focusKey = focusRestoreKey(profilePostList);
      const pageScroll = profileView.scrollTop;
      disposePreviewMedia(profilePostList);
      profilePostList.replaceChildren();
      for (const item of items) {
        const key2 = previewKeyFor("peer", item);
        const itemKey = publicVersionKey(item);
        const localEvidence = discoveryKeys.has(itemKey) || item.contentState === "available";
        const card = renderFileCard(itemWithPostMeta(item), {
          subject: "peer",
          expanded: false,
          preview: profilePreviews.get(key2) ?? null,
          showReveal: fileRevealCapable,
          reveal: revealResults.get(revealResultKey("peer", item)) ?? null,
          onReveal: (target) => void revealFileItem("peer", target),
          focusKey: `profile-post:${item.path}:${item.sha256}`,
          onOpenProfile: null,
          onOpenPost: (target, trigger) => openPostDetail(target, "peer", trigger),
          ...favoriteCardOptions(item, `profile-post:${item.path}:${item.sha256}`, localEvidence)
        });
        profilePostList.append(card);
        observePostMetaCard(card, item);
      }
      profilePostList.hidden = items.length === 0;
      observePostImages(profilePostList);
      if (focusKey) {
        const target = [...profilePostList.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        target?.focus({ preventScroll: true });
      }
      if (profileView.scrollTop !== pageScroll) profileView.scrollTop = pageScroll;
      if (currentPage === "post" && view.post.source === "peer") renderPostDetailPage();
    }
    function memoryEvidenceButtons(item) {
      const line = element("div", "rm-memory-evidence");
      const evidence = item.evidence || {};
      const itemId = typeof item.id === "string" ? item.id : "";
      const seenMessages = /* @__PURE__ */ new Set();
      for (const rawMessageId of (evidence.messageIds || []).slice(0, 6)) {
        const messageId2 = typeof rawMessageId === "string" ? rawMessageId : String(rawMessageId ?? "");
        if (!messageId2 || seenMessages.has(messageId2)) continue;
        seenMessages.add(messageId2);
        const button = element("button", "rm-evidence-link");
        button.type = "button";
        button.dataset.memoryMessage = messageId2;
        button.dataset.memoryPeer = profileState.peerId;
        button.dataset.memoryItem = itemId;
        button.dataset.focusKey = memoryEvidenceFocusKey(profileState.peerId, itemId, messageId2);
        button.dataset.profileChatReturn = "";
        button.textContent = `消息 ${String(messageId2).slice(0, 10)}…`;
        button.title = messageId2;
        line.append(button);
      }
      const sessions = /* @__PURE__ */ new Set();
      for (const sessionId of evidence.sessionIds || []) {
        if (sessionId) sessions.add(String(sessionId).split(":")[0]);
      }
      for (const eventId of evidence.eventIds || []) {
        if (eventId) sessions.add(String(eventId).split(":")[0]);
      }
      for (const sessionId of [...sessions].filter(Boolean).slice(0, 4)) {
        const button = element("button", "rm-evidence-link");
        button.type = "button";
        button.dataset.memoryJourney = sessionId;
        button.textContent = `Journey ${sessionId.slice(0, 18)}`;
        line.append(button);
      }
      for (const contentPath of (evidence.contentPaths || []).slice(0, 4)) {
        if (!contentPath) continue;
        const span = element("span", "rm-evidence-path");
        span.textContent = contentPath;
        span.title = "本机发现记录中的公开内容路径";
        line.append(span);
      }
      for (const digest of (evidence.contentSha256 || []).slice(0, 2)) {
        if (!digest) continue;
        const span = element("span", "rm-evidence-path");
        span.textContent = `sha256 ${String(digest).slice(0, 12)}…`;
        span.title = digest;
        line.append(span);
      }
      return line.childElementCount > 0 ? line : null;
    }
    function openMessageFromMemory(peerId2, messageId2, trigger = null) {
      if (!peerId2 || !messageId2) return;
      const itemId = trigger?.closest?.("[data-memory-item-id]")?.dataset?.memoryItemId || trigger?.dataset?.memoryItem || "";
      openConversation(peerId2, {
        source: "profile",
        focus: true,
        focusMessageId: messageId2,
        profileTab: "interactions",
        profileScroll: profileChatEntryScroll(trigger, profileView ? profileView.scrollTop : 0),
        returnFocus: memoryEvidenceFocusKey(peerId2, itemId, messageId2)
      });
    }
    function memoryClockText(item) {
      const date = memoryDateValue(item?.at);
      if (!date) return "时间未知";
      try {
        return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
      } catch {
        return formatDateTime(date.toISOString()) || "时间未知";
      }
    }
    function memoryMessageDirection(item) {
      if (String(item?.direction ?? "") === "in") return "对方消息";
      if (String(item?.origin ?? "") === "human") return "本人消息";
      if (String(item?.origin ?? "") === "agent") return "Agent 消息";
      return "来源未知的发出消息";
    }
    function memorySourceLine(item) {
      const kind = memorySourceKind(item);
      let text4 = memorySourceText(item.source || (kind === "message" ? memoryMessageDirection(item) : "来源未注明"));
      if (kind === "publicClue") {
        const target = String(item.subjectPeerId || item.peerId || "");
        if (target && target !== profileState.peerId) text4 += ` · 线索对象 ${shortPeer(target)}`;
        text4 += " · 仅是记录中的声明，不等于已访问或已联系";
      } else if (item.sourcePeerId && item.sourcePeerId !== profileState.peerId) {
        text4 += ` · 来源 ${shortPeer(item.sourcePeerId)}`;
      }
      if (item.private && (kind === "observation" || kind === "impression" || kind === "curiosity")) {
        text4 = `仅本机可见 · ${text4}`;
      }
      return text4;
    }
    function memoryFocusLookup(timeline, focusKey) {
      if (!focusKey || !profileState.peerId || !Array.isArray(timeline)) return null;
      const prefix = `profile-evidence:${profileState.peerId}:`;
      if (!focusKey.startsWith(prefix)) return null;
      const rest = focusKey.slice(prefix.length);
      const messageIds = (item2) => Array.isArray(item2?.evidence?.messageIds) ? item2.evidence.messageIds.map((id) => String(id ?? "")).filter(Boolean) : [];
      for (const item2 of timeline) {
        const itemId = typeof item2?.id === "string" ? item2.id : "";
        if (!itemId) continue;
        for (const messageId3 of messageIds(item2)) {
          if (rest === `${encodeURIComponent(itemId)}:${encodeURIComponent(messageId3)}`) {
            return {
              item: item2,
              messageId: messageId3,
              key: memoryEvidenceFocusKey(profileState.peerId, itemId, messageId3)
            };
          }
        }
      }
      const matching = timeline.filter((item2) => messageIds(item2).includes(rest));
      const item = matching.find((candidate) => memorySourceKind(candidate) === "message") ?? matching[0] ?? null;
      if (!item) return null;
      const messageId2 = messageIds(item).find((id) => id === rest) ?? "";
      return {
        item,
        messageId: messageId2,
        key: memoryEvidenceFocusKey(profileState.peerId, typeof item.id === "string" ? item.id : "", messageId2)
      };
    }
    function revealMemoryFocus(grouped, timeline, focusKey) {
      const found = memoryFocusLookup(timeline, focusKey);
      if (!found) return null;
      for (const [dayIndex, day] of grouped.days.entries()) {
        for (const group of day.groups) {
          if (!group.items.includes(found.item)) continue;
          profileMemoryUi.daysShown = Math.max(profileMemoryUi.daysShown, dayIndex + 1);
          profileMemoryUi.closedGroups.delete(group.key);
          profileMemoryUi.openGroups.add(group.key);
          const index = group.items.indexOf(found.item);
          const current = profileMemoryUi.groupLimits.get(group.key) || MEMORY_GROUP_PAGE;
          if (index >= current) {
            profileMemoryUi.groupLimits.set(group.key, Math.ceil((index + 1) / MEMORY_GROUP_PAGE) * MEMORY_GROUP_PAGE);
          }
          return found;
        }
      }
      return null;
    }
    function memoryGroupOpen(group) {
      if (profileMemoryUi.openGroups.has(group.key)) return true;
      if (profileMemoryUi.closedGroups.has(group.key)) return false;
      return group.items.length === 1;
    }
    function renderMemoryEvent(item) {
      const kind = memorySourceKind(item);
      const row = element("article", "rm-memory-event");
      row.dataset.memoryKind = item.kind || "unknown";
      row.dataset.memorySource = kind;
      row.dataset.memoryItemId = item.id || "";
      row.tabIndex = -1;
      const head = element("div", "rm-memory-event-head");
      const kindNode = element("span", "rm-memory-kind");
      kindNode.textContent = memoryKindLabel(item);
      kindNode.dataset.source = kind;
      const time = element("time");
      time.textContent = memoryClockText(item);
      const at = memoryDateValue(item.at);
      if (at) {
        time.dateTime = at.toISOString();
        time.title = formatDateTime(at.toISOString());
      }
      head.append(kindNode, time);
      const bodyText = memoryBody(item);
      const summary = element("p", "rm-memory-summary");
      summary.textContent = memoryPreview(bodyText) || "（没有摘要）";
      row.append(head, summary);
      const long = [...bodyText].length > 140 || /\n/.test(bodyText);
      if (long) {
        const full = element("details", "rm-memory-text");
        full.dataset.memoryTextFor = item.id || "";
        if (profileMemoryUi.openItems.has(item.id)) full.open = true;
        const toggle = element("summary");
        toggle.textContent = "展开原文";
        const text4 = element("p", "rm-memory-body");
        text4.textContent = bodyText;
        full.append(toggle, text4);
        full.addEventListener("toggle", () => {
          if (full.open) profileMemoryUi.openItems.add(item.id);
          else profileMemoryUi.openItems.delete(item.id);
        }, { signal: controller.signal });
        row.append(full);
      }
      const source = element("p", "rm-memory-source");
      source.textContent = memorySourceLine(item);
      row.append(source);
      if (kind === "publicClue") row.dataset.clue = "true";
      const evidence = memoryEvidenceButtons(item);
      if (evidence) row.append(evidence);
      return row;
    }
    function renderMemoryGroup(group) {
      const details = element("details", "rm-memory-group");
      details.dataset.memoryGroup = group.key;
      details.open = memoryGroupOpen(group);
      details.addEventListener("toggle", () => {
        if (details.open) {
          profileMemoryUi.openGroups.add(group.key);
          profileMemoryUi.closedGroups.delete(group.key);
        } else {
          profileMemoryUi.closedGroups.add(group.key);
          profileMemoryUi.openGroups.delete(group.key);
        }
      }, { signal: controller.signal });
      const summary = element("summary", "rm-memory-group-summary");
      const title = element("span", "rm-memory-group-title");
      title.textContent = group.title;
      const meta = element("span", "rm-memory-group-meta");
      meta.textContent = `${group.items.length} 条`;
      summary.append(title, meta);
      if (group.note) {
        const note = element("span", "rm-memory-group-note");
        note.textContent = group.note;
        summary.append(note);
      }
      const latest = group.items[0];
      if (latest) {
        const preview = element("span", "rm-memory-group-preview");
        preview.textContent = memoryPreview(memoryBody(latest), 72);
        summary.append(preview);
      }
      const body = element("div", "rm-memory-group-body");
      const limit = profileMemoryUi.groupLimits.get(group.key) || MEMORY_GROUP_PAGE;
      const visible = group.items.slice(0, limit);
      for (const item of visible) body.append(renderMemoryEvent(item));
      if (group.items.length > visible.length) {
        const more = element("button", "rm-quiet rm-memory-group-more");
        more.type = "button";
        more.textContent = `显示更早的 ${Math.min(MEMORY_GROUP_PAGE, group.items.length - visible.length)} 条`;
        more.onclick = () => {
          profileMemoryUi.groupLimits.set(group.key, limit + MEMORY_GROUP_PAGE);
          profileMemoryUi.openGroups.add(group.key);
          const scroll2 = profileView.scrollTop;
          renderProfileMemory();
          profileView.scrollTop = scroll2;
          const target = [...profileTimeline.querySelectorAll("[data-memory-group]")].find((node) => node.dataset.memoryGroup === group.key);
          target?.querySelector?.("summary")?.focus?.({ preventScroll: true });
        };
        body.append(more);
      }
      details.append(summary, body);
      return details;
    }
    function renderMemoryOverview(grouped) {
      const summary = summarizeContactMemory(grouped);
      if (summary.total === 0) {
        profileMemoryOverview.hidden = true;
        return;
      }
      profileMemoryOverview.hidden = false;
      const latestDate = memoryDateValue(summary.latest);
      const earliestDate = memoryDateValue(summary.earliest);
      const latest = latestDate ? formatDateTime(latestDate.toISOString()) : "";
      const earliest = earliestDate ? formatDateTime(earliestDate.toISOString()) : "";
      const pieces = [`历史摘要 · 本轮读取到 ${summary.total} 条本机记录`];
      if (latest) pieces.push(`最近 ${latest}`);
      if (earliest && earliest !== latest) pieces.push(`最早 ${earliest}`);
      profileMemorySummary.textContent = `${pieces.join("；")}。`;
      profileMemoryKinds.replaceChildren();
      for (const chip of summary.chips) {
        const node = element("span", "rm-memory-kind-chip");
        node.dataset.memoryChip = chip.key;
        node.textContent = `${chip.label} ${chip.count}`;
        profileMemoryKinds.append(node);
      }
      if (summary.unknown > 0) {
        const unknown = element("span", "rm-memory-kind-chip");
        unknown.dataset.memoryChip = "unknown-time";
        unknown.textContent = `时间未记录 ${summary.unknown}`;
        profileMemoryKinds.append(unknown);
      }
      profileMemorySource.textContent = "来源：持久消息、Journey 事件/报告与私有记忆；仅在本机合并读取。浏览档案、连接状态和 last_interaction 不计入。";
    }
    function renderProfileMemory() {
      if (!profileTimeline) return;
      const data = profileState.memory.data;
      const requestError = profileState.memory.error || "";
      const memoryError = data?.sources?.memory?.error || (data?.state === "error" ? data?.error : "") || requestError;
      const issues = [
        ["消息", data?.sources?.messages?.error],
        ["漫游记录", data?.sources?.journey?.error],
        ["私有记忆", memoryError]
      ].filter(([, message]) => Boolean(message));
      const error = issues.length > 0;
      const capable = contactMemoryCapable;
      const retrying = profileState.memory.retrying;
      const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
      const grouped = groupContactMemory(timeline);
      const requestedFocus = profileReturn.focusKey || focusRestoreKey(profileTimeline);
      const focused = revealMemoryFocus(grouped, timeline, requestedFocus);
      const pageScroll = Math.max(0, Number(profileView.scrollTop) || 0);
      profileTimelineStatus.textContent = !capable ? "不可用" : retrying && data === null ? "读取中" : error ? (timeline.length ? `${timeline.length} 条 · 部分读取失败` : "读取未完成") : `${timeline.length} 条`;
      profileTimelineStatus.dataset.tone = error ? "error" : timeline.length > 0 ? "ready" : "unavailable";
      profileMemoryError.hidden = !error;
      profileMemoryError.dataset.tone = error ? "error" : "";
      profileMemoryError.textContent = issues.map(([label, message]) => `${label}读取失败，${readFailureSummary(message, "可以稍后重试。")}`).join(" ");
      profileMemoryDetails.hidden = !error;
      profileMemoryRaw.textContent = issues.map(([label, message]) => `${label} · ${message}`).join("\n");
      profileMemoryRetry.hidden = !(capable && error);
      profileMemoryRetry.disabled = retrying;
      profileMemoryRetry.textContent = retrying ? "正在重试…" : memoryError ? "重试读取私有记忆" : "重试读取交互";
      profileMemoryRetry.onclick = capable ? () => {
        void loadContactMemory(profileState.peerId, true);
      } : null;
      renderMemoryOverview(grouped);
      const overview = summarizeContactMemory(grouped);
      profileMemoryQuickbar.hidden = timeline.length === 0;
      if (timeline.length > 0) {
        profileMemoryQuickSummary.textContent = `历史摘要 · ${overview.total} 条本机记录`;
        const c = overview.counts;
        const quickParts = [
          ["消息", c.message],
          ["访问", c.visit + c.contentRead],
          ["漫游", c.journeyEvent + c.journeyReport],
          ["线索", c.publicClue],
          ["私有", c.privateMemory]
        ].filter(([, count]) => count > 0).map(([label, count]) => `${label}${count}`);
        profileMemoryQuickSource.textContent = quickParts.join(" · ");
      }
      profileMemoryTimelineCount.textContent = timeline.length > 0 ? `${grouped.days.length} 天 · ${timeline.length} 条` : "—";
      const remainingDays = Math.max(0, grouped.days.length - profileMemoryUi.daysShown);
      profileMemoryMore.hidden = remainingDays <= 0;
      profileMemoryMore.textContent = `显示更早的 ${Math.min(2, remainingDays)} 天记录`;
      profileMemoryMore.onclick = () => {
        profileMemoryUi.daysShown += 2;
        const scroll2 = profileView.scrollTop;
        renderProfileMemory();
        profileView.scrollTop = scroll2;
        profileMemoryMore.focus?.({ preventScroll: true });
      };
      profileTimeline.replaceChildren();
      for (const day of grouped.days.slice(0, profileMemoryUi.daysShown)) {
        const section = element("section", "rm-memory-day");
        section.dataset.memoryDay = day.key;
        const header = element("header", "rm-memory-day-head");
        const heading = element("h3");
        heading.textContent = day.label;
        const count = element("span");
        count.textContent = `${day.items.length} 条`;
        header.append(heading, count);
        section.append(header);
        for (const group of day.groups) section.append(renderMemoryGroup(group));
        profileTimeline.append(section);
      }
      profileTimeline.hidden = timeline.length === 0;
      profileTimelineEmpty.hidden = !(data !== null && !error && timeline.length === 0);
      if (data !== null && !error && timeline.length === 0) {
        profileTimelineEmpty.querySelector("b").textContent = "还没有可核实的交互";
        profileTimelineEmpty.querySelector("p").textContent = "这里只显示持久消息、Journey 事件或私有印象；浏览档案和连接数不会变成聊天记录。";
      }
      const notes = [];
      if (overview.unknown > 0) notes.push(`${overview.unknown} 条记录没有可用时间，归入「日期未知」；没有推测日期。`);
      if (data?.timelineTruncated) notes.push("本次有界读取只保留最新记录；更早的消息可能已被裁剪，不能据此断言没有交流。");
      profileMemoryTimelineNote.hidden = notes.length === 0;
      profileMemoryTimelineNote.textContent = notes.join(" ");
      profileMemoryTimelineNote.dataset.tone = data?.timelineTruncated ? "warning" : "";
      if (data?.timelineTruncated) {
        profileInteractionNote.textContent = "交互时间线只显示本次有界读取的最新记录；更早的消息可能已被裁剪，不能据此断言没有交流。";
      } else if (!capable) {
        profileInteractionNote.textContent = "私有交互时间线暂未开放：当前宿主没有提供私有社交记忆读取。";
      } else if (retrying && data === null) {
        profileInteractionNote.textContent = "正在合并持久消息、Journey 记录与私有印象…";
      } else if (error) {
        profileInteractionNote.textContent = timeline.length ? `已读取 ${timeline.length} 条记录。` : "交互记录尚未读完。";
      } else if (data !== null) {
        const privateCount = timeline.filter((item) => item.private && item.kind !== "message" && item.kind !== "journey").length;
        profileInteractionNote.textContent = privateCount > 0 ? `共 ${timeline.length} 条可见记录，其中 ${privateCount} 条来自仅本机保存的私有记忆；印象不是聊天记录。` : `共 ${timeline.length} 条可见记录；消息与 Journey 是真实来源，浏览档案不计入。`;
      }
      const contact = data?.contact ?? null;
      const impressions = Array.isArray(contact?.impressions) ? [...contact.impressions] : [];
      impressions.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || "") - Date.parse(left.updatedAt || left.createdAt || ""));
      const latest = impressions[0] || null;
      const impressionLabel = memoryError ? "私有记忆读取失败。" : latest?.summary || (data ? "还没有记录印象。" : capable ? "正在读取私有记忆…" : "私有记忆暂不可用。");
      profileImpressionSummary.textContent = impressionLabel;
      profileImpressionMeta.hidden = !latest;
      if (latest) {
        const uncertainty = latest.uncertainty === "low" ? "低" : latest.uncertainty === "high" ? "高" : latest.uncertainty === "medium" ? "中" : "未标注";
        const when = latest.updatedAt || latest.createdAt;
        const count = ["sessionIds", "eventIds", "messageIds", "contentPaths"].reduce((sum, key2) => sum + (latest.evidenceRefs?.[key2] || []).length, 0);
        profileImpressionMeta.textContent = `确定性：${uncertainty}${when ? ` · 更新于 ${formatDateTime(when)}` : ""} · ${count > 0 ? `${count} 条证据引用` : "尚未关联证据引用；这不是聊天证据"}`;
      }
      const impressionText = latest?.summary || "";
      const impressionLong = [...impressionText].length > 160 || (impressionText.match(/\n/g) || []).length > 2;
      profileImpressionSummary.classList.toggle("is-expanded", profileMemoryUi.impressionExpanded);
      profileImpressionToggle.hidden = !impressionLong;
      profileImpressionToggle.textContent = profileMemoryUi.impressionExpanded ? "收起印象" : "展开完整印象";
      profileImpressionToggle.setAttribute("aria-expanded", String(profileMemoryUi.impressionExpanded));
      profileImpressionToggle.onclick = impressionLong ? () => {
        profileMemoryUi.impressionExpanded = !profileMemoryUi.impressionExpanded;
        profileImpressionSummary.classList.toggle("is-expanded", profileMemoryUi.impressionExpanded);
        profileImpressionToggle.textContent = profileMemoryUi.impressionExpanded ? "收起印象" : "展开完整印象";
        profileImpressionToggle.setAttribute("aria-expanded", String(profileMemoryUi.impressionExpanded));
        profileImpressionToggle.focus?.({ preventScroll: true });
      } : null;
      const canEditImpression = Boolean(saveContactImpressionCapable && data && (data.state === "available" || data.state === "missing") && !memoryError);
      profileImpressionEdit.hidden = !canEditImpression;
      profileImpressionEdit.disabled = profileState.memory.retrying;
      profileImpressionEdit.onclick = canEditImpression ? () => openImpressionEditor(profileImpressionEdit) : null;
      profileImpressionQuickText.textContent = impressionLabel;
      profileImpressionQuickEdit.hidden = !canEditImpression;
      profileImpressionQuickEdit.disabled = profileState.memory.retrying;
      profileImpressionQuickEdit.onclick = canEditImpression ? () => openImpressionEditor(profileImpressionQuickEdit) : null;
      if (requestedFocus) {
        const focusKey = focused?.key || requestedFocus;
        const target = [...profileTimeline.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
        if (target) {
          target.focus({ preventScroll: true });
          if (profileReturn.focusKey === requestedFocus) profileReturn.focusKey = "";
        }
      }
      if (profileView.scrollTop !== pageScroll) profileView.scrollTop = pageScroll;
    }
    function openImpressionEditor(trigger = null) {
      if (!saveContactImpressionCapable) return;
      const data = profileState.memory.data;
      const peerId2 = profileState.peerId;
      if (!data || data.state === "error") return;
      const contact = data.contact;
      const impressions = Array.isArray(contact?.impressions) ? [...contact.impressions] : [];
      impressions.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || "") - Date.parse(left.updatedAt || left.createdAt || ""));
      const latest = impressions[0] || null;
      impressionEditState.open = true;
      impressionEditState.saving = false;
      impressionEditState.peerId = peerId2;
      impressionEditState.impressionId = latest?.id || "";
      impressionEditState.expectedSha = String(data.sha256 || "");
      impressionSummaryInput.value = latest?.summary || "";
      impressionUncertainty.value = latest?.uncertainty || "medium";
      impressionDialogNote.hidden = true;
      impressionDialogNote.textContent = "";
      impressionSave.disabled = false;
      impressionSave.textContent = "保存印象";
      openDialog(impressionDialog, trigger);
      impressionSummaryInput.focus({ preventScroll: true });
    }
    async function submitImpression() {
      if (!impressionEditState.open || impressionEditState.saving || !saveContactImpressionCapable) return;
      const summary = impressionSummaryInput.value.trim();
      if (summary.length === 0) {
        impressionDialogNote.hidden = false;
        impressionDialogNote.dataset.tone = "error";
        impressionDialogNote.textContent = "印象内容不能为空。";
        impressionSummaryInput.focus();
        return;
      }
      impressionEditState.saving = true;
      impressionSave.disabled = true;
      impressionSave.textContent = "保存中…";
      impressionDialogNote.hidden = true;
      let result;
      try {
        result = await options.onSaveContactImpression({
          peerId: impressionEditState.peerId,
          impressionId: impressionEditState.impressionId,
          summary,
          uncertainty: impressionUncertainty.value,
          expectedSha256: impressionEditState.expectedSha
        });
      } catch (error) {
        result = { saved: false, error: errorText(error) || "私有印象保存失败。", conflict: false };
      }
      if (destroyed) return;
      impressionEditState.saving = false;
      impressionSave.disabled = false;
      impressionSave.textContent = "保存印象";
      if (result?.saved === true) {
        impressionEditState.open = false;
        if (result.memory) profileState.memory.data = result.memory;
        closeDialog(impressionDialog);
        profileImpressionStatus.hidden = false;
        profileImpressionStatus.dataset.tone = "ok";
        profileImpressionStatus.textContent = "已保存到本机私有记忆 · 仅本机可见，未写入公开资料、公开清单或 friends.json";
        renderProfileMemory();
        profileImpressionEdit.focus({ preventScroll: true });
        return;
      }
      impressionDialogNote.hidden = false;
      impressionDialogNote.dataset.tone = "error";
      impressionDialogNote.textContent = result?.conflict ? `文件已在别处修改，未覆盖：${result.error || "请重新读取后再保存"}` : result?.error || "私有印象保存失败。";
    }
    function renderProfileTabs() {
      const knownContact = profileIsContact();
      const contactsKnown = profileContactsKnown();
      let active = view.contactProfile.tab === "posts" || view.contactProfile.tab === "address" ? view.contactProfile.tab : "interactions";
      const relationshipSurface = !contactsKnown || knownContact;
      if (!relationshipSurface) active = "posts";
      if (contactsKnown) view.contactProfile.tab = active;
      if (profileTabsNav) profileTabsNav.hidden = false;
      for (const button of profileTabs) {
        const name = button.dataset.profileTab;
        button.hidden = !relationshipSurface && name !== "posts";
        const selected = name === active;
        if (selected) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      for (const [name, panel] of Object.entries({
        interactions: $("#contactProfileInteractions"),
        posts: $("#contactProfilePosts"),
        address: $("#contactProfileAddress")
      })) {
        if (panel) panel.hidden = name !== active;
      }

    }
    const PROFILE_INTEREST_ICONS = [
      "M12 3.2 13.8 8.7 19.3 10.5 13.8 12.3 12 17.8 10.2 12.3 4.7 10.5 10.2 8.7Z",
      "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5ZM5 17.5h14M8.5 7h7",
      "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9ZM7.5 9.5h.01M7.5 14.5h.01M12 17h5"
    ];
    function profileInterestIcon(index) {
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("class", "rm-profile-tag-icon");
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", PROFILE_INTEREST_ICONS[index % PROFILE_INTEREST_ICONS.length]);
      svg.append(path);
      return svg;
    }
    function renderProfileInterests(card) {
      if (!profileInterests) return;
      const items = (Array.isArray(card?.interests) ? card.interests : []).map((value) => String(value ?? "").trim()).filter((value) => value.length > 0).slice(0, 10);
      profileInterests.replaceChildren();
      profileInterests.hidden = items.length === 0;
      items.forEach((label, index) => {
        const item = element("li", "rm-profile-tag");
        const text4 = element("span", "rm-profile-tag-label");
        text4.textContent = label;
        item.append(profileInterestIcon(index), text4);
        profileInterests.append(item);
      });
    }
    function profileMissingFields(card) {
      const missing = [];
      if (!String(card?.description ?? "").trim()) missing.push("简介");
      if (profileInterestCount(card) === 0) missing.push("兴趣");
      if (!String(card?.conversationStyle ?? "").trim()) missing.push("公开交流风格");
      return missing;
    }
    function profileInterestCount(card) {
      return (Array.isArray(card?.interests) ? card.interests : []).filter((value) => String(value ?? "").trim().length > 0).length;
    }
    function snapshotCardFor(peerId2) {
      const snapshot = verifiedContactProfileFor(peerId2);
      if (!snapshot) return null;
      return {
        schemaVersion: 1,
        displayName: snapshot.displayName,
        description: snapshot.description || "",
        interests: Array.isArray(snapshot.interests) ? snapshot.interests : [],
        conversationStyle: snapshot.conversationStyle || "",
        updatedAt: "",
        path: "",
        sha256: "",
        avatarPath: "",
        avatarSha256: "",
        avatarMime: "",
        legacyFallback: false,
        sourceWarning: ""
      };
    }
    function renderPeerAvatar(peerId2, card, manifest, { displayName = "", snapshotUrl = "" } = {}) {
      if (!profileAvatar) return;
      const avatarPath = String(card?.avatarPath ?? "");
      const avatarSha = String(card?.avatarSha256 ?? "").toLowerCase();
      const avatarMime = String(card?.avatarMime ?? "");
      const entry = avatarPath && Array.isArray(manifest?.entries) ? manifest.entries.find((item) => item.path === avatarPath) : null;
      const key2 = avatarKeyForPeer(peerId2, card, manifest);
      const cached = peerAvatarState.get(peerId2);
      const cachedMatches = cached && cached.key === key2 && cached.state === "ready" && cached.url;
      const snapshotMatches = !cachedMatches && snapshotUrl && /^data:image\/(?:png|jpeg);base64,/i.test(snapshotUrl);
      profileAvatar.replaceChildren();
      profileAvatar.dataset.kind = cachedMatches || snapshotMatches ? "image" : "initial";
      if (cachedMatches || snapshotMatches) {
        const image = element("img", "rm-profile-avatar-img");
        image.src = cachedMatches ? cached.url : snapshotUrl;
        image.alt = "";
        image.decoding = "async";
        profileAvatar.append(image);
        return;
      }
      profileAvatar.textContent = contactInitial({ name: displayName, peerId: peerId2 });
      if (!key2 || !avatarMime || !entry || typeof options.onLoadPeerFileContent !== "function") return;
      if (cached && cached.key === key2 && (cached.state === "loading" || cached.state === "error")) return;
      peerAvatarState.set(peerId2, { key: key2, state: "loading", url: "" });
      void options.onLoadPeerFileContent(peerId2, avatarPath, avatarSha, entry.sizeBytes).then((preview) => {
        if (destroyed) return;
        const valid = preview?.status === "ok" && preview.kind === "image" && preview.mime === avatarMime && String(preview.sha256 ?? "").toLowerCase() === avatarSha && Number(preview.sizeBytes) === Number(entry.sizeBytes) && typeof preview.dataUrl === "string" && preview.dataUrl.length > 0;
        peerAvatarState.set(peerId2, valid ? { key: key2, state: "ready", url: preview.dataUrl } : { key: key2, state: "error", url: "" });
        if (!profileView.hidden && profileState.peerId === peerId2) rerenderProfileKeepingPosition();
        refreshContactAvatar(peerId2);
      }).catch(() => {
        if (destroyed) return;
        peerAvatarState.set(peerId2, { key: key2, state: "error", url: "" });
        if (!profileView.hidden && profileState.peerId === peerId2) rerenderProfileKeepingPosition();
        refreshContactAvatar(peerId2);
      });
    }
    function peerHumanAvatarKey(peerId2, data) {
      const path = String(data?.humanAvatarPath ?? "");
      const sha = String(data?.humanAvatarSha256 ?? "").toLowerCase();
      const mime = String(data?.humanAvatarMime ?? "");
      if (!path || !sha || !mime || !Array.isArray(data?.manifest?.entries)) return "";
      const entry = data.manifest.entries.find((item) => item.path === path
        && String(item.sha256 ?? "").toLowerCase() === sha);
      if (!entry) return "";
      return `${peerId2}\u0000${path}\u0000${sha}\u0000${Number(entry.sizeBytes) || 0}\u0000${mime}`;
    }
    function renderPeerHumanAvatar(peerId2, data, { displayName = "" } = {}) {
      if (!profileHumanAvatar) return;
      const initial = Array.from(displayName || "")[0] || "人";
      if (profileHumanInitial) {
        profileHumanInitial.textContent = initial;
        profileHumanInitial.hidden = false;
      }
      const key = peerHumanAvatarKey(peerId2, data);
      const cached = peerHumanAvatarState.get(peerId2);
      const cachedMatches = Boolean(key && cached && cached.key === key && cached.state === "ready" && cached.url);
      profileHumanAvatar.hidden = !cachedMatches;
      if (cachedMatches) {
        profileHumanAvatar.src = cached.url;
        if (profileHumanInitial) profileHumanInitial.hidden = true;
      } else {
        profileHumanAvatar.src = "assets/raminga-mark-gradient.svg";
      }
      profileHumanStrip?.setAttribute("data-has-avatar", key ? "true" : "false");
      if (!key || cachedMatches) return;
      if (cached && cached.key === key && (cached.state === "loading" || cached.state === "error")) return;
      const avatarPath = String(data.humanAvatarPath);
      const avatarSha = String(data.humanAvatarSha256).toLowerCase();
      const avatarMime = String(data.humanAvatarMime);
      const entry = data.manifest.entries.find((item) => item.path === avatarPath
        && String(item.sha256 ?? "").toLowerCase() === avatarSha);
      if (!entry || typeof options.onLoadPeerFileContent !== "function") return;
      peerHumanAvatarState.set(peerId2, { key, state: "loading", url: "" });
      void options.onLoadPeerFileContent(peerId2, avatarPath, avatarSha, entry.sizeBytes).then((preview) => {
        if (destroyed) return;
        const valid = preview?.status === "ok"
          && preview.kind === "image"
          && preview.mime === avatarMime
          && String(preview.sha256 ?? "").toLowerCase() === avatarSha
          && Number(preview.sizeBytes) === Number(entry.sizeBytes)
          && typeof preview.dataUrl === "string"
          && preview.dataUrl.length > 0;
        peerHumanAvatarState.set(peerId2, valid ? { key, state: "ready", url: preview.dataUrl } : { key, state: "error", url: "" });
        if (!profileView.hidden && profileState.peerId === peerId2) rerenderProfileKeepingPosition();
      }).catch(() => {
        if (destroyed) return;
        peerHumanAvatarState.set(peerId2, { key, state: "error", url: "" });
        if (!profileView.hidden && profileState.peerId === peerId2) rerenderProfileKeepingPosition();
      });
    }
    function renderProfile() {
      const peerId2 = profileState.peerId;
      const data = profileState.data;
      const remoteCard = data?.agentCard?.state === "available" ? data.agentCard.card : null;
      const snapshot = peerId2 ? verifiedContactProfileFor(peerId2) : null;
      const snapshotCard = snapshotCardFor(peerId2);
      const preferSnapshot = Boolean(remoteCard && snapshotCard && (data.source === "local-copy" || data.source === "unavailable"));
      const currentCard = preferSnapshot ? null : remoteCard;
      const card = currentCard ?? snapshotCard;
      const fromSnapshot = Boolean(currentCard === null && snapshotCard);
      const localFriend = peerId2 ? contactFor(peerId2) : null;
      const publicName = data ? profileLabel(data, peerId2) : "";
      const fallbackName = localFriend ? contactRowName(localFriend) : "";
      const agentName = String(card?.displayName ?? "").trim() || publicName || fallbackName || profileLabel(data, peerId2);
      const isSelf = peerId2.length > 0 && peerId2 === selfPeerId();
      const snapshotAt = Number(snapshot?.at) > 0 ? Number(snapshot.at) : 0;
      profilePeerId.textContent = peerId2 || "—";
      profileName.textContent = agentName || "联系人主页";
      profileMessage.dataset.focusKey = `profile-message:${peerId2}`;
      renderPeerAvatar(peerId2, currentCard, data?.manifest, {
        displayName: agentName,
        // A local, previously verified snapshot is used only when this read has
        // no current public card. A current card with no/mismatched avatar must
        // never borrow older bytes.
        snapshotUrl: currentCard === null && snapshot ? contactAvatarUrl(peerId2) : ""
      });
      const readFailed = Boolean(profileState.error || data?.error);
      profileAgentBadge.textContent = currentCard ? readFailed || data?.freshness && data.freshness !== "live" ? "上次公开档案" : "Agent" : fromSnapshot ? "上次公开档案" : readFailed ? "公开档案暂不可用" : "Agent 档案未公开";
      profileAgentBadge.dataset.tone = currentCard && !readFailed ? "" : "unavailable";
      const bio = String(card?.description ?? "").trim();
      profileAgentDescriptionShort.textContent = bio;
      profileAgentDescriptionShort.hidden = bio.length === 0;
      renderProfileInterests(card);
      const style = String(card?.conversationStyle ?? "").trim();
      profileConversationStyle.textContent = style ? `公开交流风格 · ${style}` : "";
      profileConversationStyle.hidden = style.length === 0;
      let missingNote = "";
      if (card) {
        const missing = profileMissingFields(card);
        if (missing.length > 0) missingNote = `公开档案未提供${missing.join("、")}。`;
        else if (fromSnapshot && data === null) missingNote = "当前显示上次成功读取的公开档案；对方最新资料暂未确认。";
      } else if (data === null && profileState.retrying) {
        missingNote = "正在读取对方公开档案…";
      } else if (data === null && profileState.error) {
        missingNote = "对方公开档案暂时不可用。";
      } else if (data?.error) {
        missingNote = "公开档案暂时不可用。";
      } else if (data?.agentCard?.state === "error") {
        missingNote = "对方公开 Agent 档案这次没有读取到。";
      } else if (data) {
        missingNote = data.found ? "对方没有公开 Agent 卡片。" : "对方没有公开用户档案。";
      } else {
        missingNote = "还没有读取到公开档案。";
      }
      profileMissingNote.textContent = missingNote;
      profileMissingNote.hidden = missingNote.length === 0;
      let freshnessText = "";
      if (data?.source === "local-copy") {
        freshnessText = `本机历史副本${snapshotAt > 0 ? ` · 上次成功读取 ${formatDateTime(snapshotAt)}` : ""}`;
      } else if (fromSnapshot) {
        freshnessText = `上次成功读取 ${formatDateTime(snapshotAt) || "时间未知"} · 当前未能刷新`;
      } else if (data?.error) {
        freshnessText = `本次读取没有完成${data.at ? ` · ${formatDateTime(data.at)}` : ""}`;
      } else if (data?.freshness && data.freshness !== "live") {
        freshnessText = `上次读取 ${formatDateTime(data.at) || "时间未知"} · 最新状态未确认`;
      } else if (data === null && profileState.retrying) {
        freshnessText = "正在读取公开档案…";
      }
      profileFreshness.textContent = freshnessText;
      profileFreshness.hidden = freshnessText.length === 0;
      renderProfileTabs();
      profileBody.replaceChildren();
      profileBodyNote.hidden = true;
      profileError.hidden = true;
      profileRetry.hidden = true;
      profileRetry.disabled = false;
      profileStale.hidden = true;
      profileStale.textContent = "";
      profileError.textContent = "";
      profileReadDetails.hidden = true;
      profileReadRaw.textContent = "";
      profileOriginNote.hidden = true;
      profileOriginNote.textContent = "";
      profileHumanStrip.hidden = true;
      profileHumanSummary.hidden = true;
      profileHumanSummary.textContent = "";
      profileHumanHeadingLabel.textContent = "公开资料";
      profileHumanName.textContent = "";
      profileHumanName.hidden = true;
      if (profileHumanAvatar) {
        profileHumanAvatar.src = "assets/raminga-mark-gradient.svg";
        profileHumanAvatar.hidden = true;
      }
      if (profileHumanInitial) {
        profileHumanInitial.textContent = "人";
        profileHumanInitial.hidden = false;
      }
      profileHumanStrip?.setAttribute("data-has-avatar", "false");
      const technicalErrors = [];
      const addTechnicalError = (label, raw) => {
        const value = String(raw ?? "").trim();
        if (value.length === 0) return;
        technicalErrors.push(label ? `${label}
${value}` : value);
      };
      profileOriginReadAt.textContent = data ? formatDateTime(data.at) || "—" : profileState.retrying ? "读取中" : "—";
      profileOriginSnapshotAt.textContent = snapshotAt > 0 ? formatDateTime(snapshotAt) || "—" : "—";
      profileOriginCardPath.textContent = String(card?.path ?? "").trim() || "—";
      let sourceText = "";
      if (data?.source === "local-copy") {
        sourceText = "本机历史副本 · 对方当前资料没有读取成功。这不是当前的远端声明，也不证明对方在线。";
      } else if (fromSnapshot) {
        sourceText = "本机已核对的上次公开档案 · 当前未能刷新，不能当作实时资料。";
      } else if (data?.source === "remote") {
        sourceText = !data.found ? "对方没有公开用户档案。" : data.error ? "上次读取的公开资料 · 本次刷新没有完成，不能当作实时资料。" : "对方公开资料 · 远端声明，未在本机验证身份。";
      } else if (data) {
        sourceText = "本次没有读取到公开资料。";
      } else if (profileState.retrying) {
        sourceText = "正在读取对方公开资料…";
      } else {
        sourceText = "本次没有读取到公开资料。";
      }
      profileSource.textContent = sourceText;
      const localName = String(localFriend?.name ?? "").trim();
      const localDescription = String(localFriend?.description ?? "").trim();
      profileLocalNote.hidden = localName.length === 0 && localDescription.length === 0;
      const localSummary = [localName, localDescription].filter((value) => value.length > 0).join(" · ").replace(/[。.\s]+$/, "");
      profileLocalNote.textContent = localSummary.length > 0 ? `本机备注：${localSummary}。仅在本机显示，不修改对方档案。` : "";
      profileAgentOpen.hidden = !card;
      profileAgentOpen.onclick = card ? () => openAgentCardDialog(card, peerId2, { snapshotAt: fromSnapshot ? snapshotAt : 0 }) : null;
      profileMessage.hidden = peerId2.length === 0 || isSelf;
      profileMessage.onclick = peerId2.length === 0 || isSelf ? null : () => {
        const target = peerId2;
        const tab = view.contactProfile.tab;
        const scroll2 = profileChatEntryScroll(profileMessage, profileView.scrollTop);
        openConversation(target, {
          source: "profile",
          profileTab: tab,
          profileScroll: scroll2,
          returnFocus: profileMessage.dataset.focusKey || `profile-message:${target}`
        });
      };
      profileEditContact.hidden = !(friendEditCapable && localFriend);
      profileEditContact.onclick = friendEditCapable && localFriend ? () => openEditContact(profileState.peerId, profileEditContact) : null;
      profileAddContact.hidden = !(peerProfileCapable && peerId2 && !isSelf && profileContactsKnown() && !localFriend);
      profileAddContact.onclick = peerProfileCapable && peerId2 && !isSelf && profileContactsKnown() && !localFriend ? () => {
        openAddDialog(profileAddContact);
        addContactInput.value = peerId2;
      } : null;
      if (profileAddressRetry) {
        profileAddressRetry.onclick = peerId2.length === 0 ? null : () => {
          void loadPeerFriends(peerId2, true);
        };
      }
      renderProfilePeerPosts(peerId2);
      renderProfileFriends();
      renderPeerNodeInfo();
      if (data === null) {
        profileHumanStrip.hidden = true;
        profileBodyNote.textContent = profileState.error ? readFailureSummary(profileState.error, "没有读取到对方公开资料。") : fromSnapshot ? "正在重新读取对方公开资料；下面保留上次读取的公开卡片。" : "正在读取对方公开资料…";
        profileBodyNote.hidden = true;
        if (profileState.error) {
          addTechnicalError("公开资料读取", profileState.error);
          profileError.textContent = readFailureSummary(profileState.error, "没有读取到对方公开资料。");
          profileError.hidden = false;
          profileReadRaw.textContent = technicalErrors.join("\n\n");
          profileReadDetails.hidden = false;
          profileRetry.hidden = !peerProfileCapable;
          profileRetry.disabled = profileState.retrying;
          profileRetry.textContent = profileState.retrying ? "正在重试…" : "重试读取公开档案";
          profileRetry.onclick = () => {
            void loadPeerProfile(peerId2, true);
          };
        }
        return;
      }
      if (profileState.error) {
        addTechnicalError("本次读取", profileState.error);
        profileStale.textContent = `这次读取没有完成：${readFailureSummary(profileState.error)} ${card ? "下面是上次成功结果或仅有的公开信息。" : "这不代表对方没有公开档案；下面是本机仅有的记录。"}`;
        profileStale.hidden = false;
        profileRetry.hidden = false;
        profileRetry.disabled = profileState.retrying;
        profileRetry.textContent = profileState.retrying ? "正在重试…" : "重试读取公开档案";
        profileRetry.onclick = () => {
          void loadPeerProfile(peerId2, true);
        };
      } else if (data.error) {
        addTechnicalError("本次读取", data.error);
        profileStale.textContent = `这次读取没有完成：${readFailureSummary(data.error)} ${card ? "下面是上次成功结果或仅有的公开信息。" : "这不代表对方没有公开档案；下面是本机仅有的记录。"}`;
        profileStale.hidden = false;
        profileRetry.hidden = false;
        profileRetry.disabled = profileState.retrying;
        profileRetry.textContent = profileState.retrying ? "正在重试…" : "重试读取公开档案";
        profileRetry.onclick = () => {
          void loadPeerProfile(peerId2, true);
        };
      } else if (data.manifest?.error) {
        addTechnicalError("公开清单读取", data.manifest.error);
        profileStale.textContent = `对方当前公开清单没有读取成功：${readFailureSummary(data.manifest.error)} 下面显示本机已保留的信息。`;
        profileStale.hidden = false;
        profileRetry.hidden = false;
        profileRetry.disabled = profileState.retrying;
        profileRetry.textContent = profileState.retrying ? "正在刷新…" : "重试读取当前公开清单";
        profileRetry.onclick = () => {
          void loadPeerProfile(peerId2, true);
        };
      }
      if (data.agentCard?.state === "error") addTechnicalError("公开 Agent 资料", data.agentCard.error);
      if (technicalErrors.length > 0) {
        profileReadRaw.textContent = technicalErrors.join("\n\n");
        profileReadDetails.hidden = false;
      }
      const humanName = String(data.remoteName ?? "").trim();
      const humanSummary = plainSummary(data.text);
      const humanDistinct = humanName.length > 0 && humanName !== agentName;
      const hasHumanAvatar = Boolean(String(data.humanAvatarPath ?? "").trim());
      const sameIntro = humanSummary.length > 0 && bio.length > 0 && (humanSummary === bio || bio.startsWith(humanSummary) || humanSummary.startsWith(bio));
      const showHumanSummary = humanSummary.length > 0 && !sameIntro;
      renderPeerHumanAvatar(peerId2, data, { displayName: humanName });
      profileHumanHeadingLabel.textContent = humanDistinct ? "关联人类 · " : hasHumanAvatar ? "关联人类" : "公开资料";
      profileHumanName.textContent = humanDistinct ? humanName : "";
      profileHumanName.hidden = !humanDistinct;
      profileHumanSummary.textContent = showHumanSummary ? humanSummary : "";
      profileHumanSummary.hidden = !showHumanSummary;
      profileHumanStrip.hidden = !humanDistinct && !showHumanSummary && !data.text && !hasHumanAvatar;
      if (!data.found) {
        profileBodyNote.textContent = "对方没有公开用户档案。";
        profileBodyNote.hidden = false;
      } else if (data.text) {
        const bodyText = data.text.replace(/^\s*#\s+[^\n]*(?:\r?\n)+/, "");
        renderMarkdownInto(profileBody, bodyText.trim() || data.text);
      } else {
        profileBodyNote.textContent = "对方公开档案没有正文。";
        profileBodyNote.hidden = false;
      }
      const activeTab = view.contactProfile.tab === "posts" || view.contactProfile.tab === "address" ? view.contactProfile.tab : "interactions";
      if (activeTab === "interactions" && profileIsContact(peerId2) && profileState.memory.data === null && !profileState.memory.retrying && peerId2) {
        void loadContactMemory(peerId2, false);
      }
      if (activeTab === "posts" && profileState.posts.data === null && !profileState.posts.retrying && peerId2) {
        void loadPeerDiscoveries(peerId2, false);
      }
    }
    function openAgentCardDialog(card, peerId2, { snapshotAt = 0 } = {}) {
      const snapshot = Number(snapshotAt) > 0;
      agentCardSource.textContent = snapshot ? `来源：本机上次成功读取的公开 Agent 档案${formatDateTime(snapshotAt) ? ` · ${formatDateTime(snapshotAt)}` : ""} · 当前未能刷新` : "来源：对方公开的 Agent 档案 · 远端声明，未验证身份";
      agentCardBody.replaceChildren();
      const facts = element("dl", "rm-facts");
      const add = (label, value) => {
        if (!value) return;
        const row = element("div");
        const key2 = element("dt");
        key2.textContent = label;
        const val = element("dd");
        val.textContent = value;
        row.append(key2, val);
        facts.append(row);
      };
      const interests = (Array.isArray(card?.interests) ? card.interests : []).map((value) => String(value ?? "").trim()).filter((value) => value.length > 0);
      add("名称", String(card?.displayName ?? "").trim());
      add("介绍", String(card?.description ?? "").trim());
      add("兴趣", interests.join("、"));
      add("交流偏好", String(card?.conversationStyle ?? "").trim());
      add("更新时间", snapshot ? "" : formatDateTime(card?.updatedAt));
      if (snapshot) add("上次成功读取", formatDateTime(snapshotAt));
      agentCardBody.append(facts);
      agentCardBody.append(sourceDetails({
        rows: [
          ["公开文件", snapshot ? "" : card?.path],
          ["内容版本", snapshot ? "" : card?.sha256],
          ["更新时间", snapshot ? "" : formatDateTime(card?.updatedAt)],
          ["来源节点", peerId2]
        ],
        note: snapshot ? "这是本机上次成功读取的公开自我介绍，当前没有刷新成功；不证明 Agent 在线。" : "这是对方公开的 Agent 自我介绍，不证明 Agent 在线，也不证明某条消息由 Agent 发出。"
      }, { sourceOpen: view.pages.explore.sourceOpen, save: scheduleSave }));
      openDialog(agentCardDialog, profileAgentOpen);
    }
    function ensurePageData(page) {
      if (!hostReady || !profileView.hidden) return;
      if (page === "post") {
        if (view.post.source === "mine") {
          if (mineCapable && mineState.data === null) void loadMine(false);
        } else if (view.post.source === "peer") {
          const peer = view.post.peerId || view.contactProfile.peerId;
          if (peer && preparePeerPostContext(peer)) {
            if (peerProfileCapable && profileState.data === null) void loadPeerProfile(peer, false);
            if (peerDiscoveriesCapable && profileState.posts.data === null) void loadPeerDiscoveries(peer, false);
          }
        } else if (discoveriesCapable) {
          ensureDiscoveriesFresh(false);
        }
        renderPostDetailPage();
      }
      if (page === "explore") {
        if (view.pages.explore.filter === "mine") {
          if (mineCapable && mineState.data === null) void loadMine(false);
          updateMineFeedState();
        } else {
          ensureDiscoveriesFresh(false);
        }
      }
      if ((page === "home" || page === "settings") && mineCapable && mineState.data === null) {
        void loadMine(false);
      }
      if ((page === "home" || page === "settings" || page === "journeys" || page === "journey") && journeyCapable && journeyCacheNeedsRead()) {
        void loadJourney(false);
      }
      if (page === "settings") renderSettingsView();
      if (page === "journeys") renderJourneysPage();
      if (page === "journey") renderJourneyDetailPage();
    }
    async function loadMine(force = false) {
      if (destroyed || !mineCapable) {
        renderMine();
        return;
      }
      if (!hostReady) return;
      const request = ++mineState.requestSeq;
      mineState.retrying = true;
      mineState.error = "";
      renderMine();
      try {
        const value = await options.onLoadMine(force === true);
        if (destroyed || request !== mineState.requestSeq) return;
        if (value === null || typeof value !== "object") throw new Error("本机公开资料没有返回结果");
        mineState.data = value;
        mineState.error = value.error || "";
      } catch (error) {
        if (destroyed || request !== mineState.requestSeq) return;
        mineState.error = errorText(error) || "本机公开资料读取失败";
      } finally {
        if (!destroyed && request === mineState.requestSeq) {
          mineState.retrying = false;
          refreshHomeAvatar();
          refreshHomeHumanAvatar();
          renderMine();
          if (currentPage === "settings") renderSettingsFavorites();
          if (currentPage === "post") renderPostDetailPage();
        }
      }
    }
    function renderMineIdentity() {
      const phase = nodeState.phase;
      mineIdentity.dataset.phase = phase;
      mineDetails.replaceChildren();
      mineDetails.hidden = true;
      mineIdentityAction.hidden = true;
      mineIdentityAction.onclick = null;
    }
    function setNodeStatus(next = {}) {
      if (destroyed) return;
      nodeState.phase = NODE_PHASES.has(next.phase) ? next.phase : "loading";
      if ("status" in next) nodeState.status = next.status ?? null;
      if ("statusAt" in next) nodeState.statusAt = Number(next.statusAt) > 0 ? Number(next.statusAt) : 0;
      if ("error" in next) nodeState.error = next.error ?? null;
      if ("errorAt" in next) nodeState.errorAt = Number(next.errorAt) > 0 ? Number(next.errorAt) : 0;
      if ("freshness" in next) nodeState.freshness = next.freshness ?? "loading";
      if ("stream" in next) nodeState.stream = next.stream ?? null;
      if ("stats" in next) nodeState.stats = next.stats ?? null;
      if (nodeState.phase === "ready" && nodeState.status && nodeState.statusAt === 0) {
        nodeState.statusAt = Date.now();
      }
      pendingRefresh = false;
      renderNodeMeta();
      renderStatusDialog();
      renderMineIdentity();
      if (contactsState.selectedPeerId) renderComposer();
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
      const peerId2 = contactsState.selectedPeerId;
      if (!peerId2) return;
      if (event.kind === "chat") {
        const message = eventMessage(event);
        if (message && message.peerId === peerId2) {
          chat.items = mergeMessages(chat.items, [message], { peerId: peerId2 });
          renderMessageList();
        }
      } else if (event.kind === "ack" && event.peerId === peerId2 && event.ackAccepted === true) {
        let changed = false;
        chat.items = chat.items.map((message) => {
          if (message.messageId !== event.messageId || message.direction !== "out") return message;
          changed = true;
          return { ...message, acked: true, deliveryStatus: "acked", deliveryError: "", deliveryUpdatedAt: event.atUnixMs };
        });
        if (changed) renderMessageList();
      }
    }
    function setStats(stats) {
      if (destroyed || !stats) return;
      nodeState.stats = stats;
      renderStatusDialog();
    }
    function setActivity(value) {
      if (destroyed) return;
      if (value === null || typeof value !== "object") {
        setActivityError("工具活动读取没有返回结果");
        return;
      }
      const featuredBefore = activityFeaturedSessionId();
      const nextInstance = typeof value.instanceId === "string" ? value.instanceId : "";
      if (activityState.instanceId && nextInstance && activityState.instanceId !== nextInstance) {
        activityState.previousInstanceId = activityState.instanceId;
        activityState.detail = { id: "", data: null, loading: false, error: "", request: activityState.detail.request + 1 };
        view.home.activityExpanded = false;
      }
      activityState.data = {
        operations: Array.isArray(value.operations) ? value.operations : [],
        instanceId: nextInstance,
        readAt: Number(value.readAt) > 0 ? Number(value.readAt) : 0,
        truncated: value.truncated === true,
        badLines: Number.isFinite(Number(value.badLines)) ? Number(value.badLines) : 0,
        error: typeof value.error === "string" ? value.error : ""
      };
      activityState.instanceId = nextInstance;
      activityState.error = typeof value.error === "string" ? value.error : "";
      if (activityFeaturedSessionId() !== featuredBefore) renderJourney();
      else renderHome();
    }
    function setActivityError(error) {
      if (destroyed) return;
      const featuredBefore = activityFeaturedSessionId();
      activityState.error = errorText(error) || "Raminga 工具活动读取失败";
      activityState.detail = { id: "", data: null, loading: false, error: "", request: activityState.detail.request + 1 };
      view.home.activityExpanded = false;
      if (activityFeaturedSessionId() !== featuredBefore) renderJourney();
      else renderHome();
    }
    function getDraft2(key2) {
      return readDraft(view, key2);
    }
    function setDraft2(key2, value) {
      if (destroyed) return;
      storeDraft(view, key2, value);
      saveNow();
    }
    function rememberProfilePress(event) {
      const target = event.target.closest?.("[data-profile-peer]");
      if (!target || !pageTracksScroll(currentPage)) return;
      const page = pageEls[currentPage];
      if (!page || page.hidden) return;
      profilePressScroll = {
        page: currentPage,
        scroll: Math.max(0, page.scrollTop || 0),
        at: Date.now()
      };
    }
    function rememberProfileChatPress(event) {
      if (profileView.hidden) return;
      const trigger = event.target.closest?.("[data-profile-chat-return]");
      if (!trigger) return;
      if (profileChatPress && profileChatPress.trigger === trigger && Date.now() - profileChatPress.at <= 1e3) return;
      profileChatPress = {
        trigger,
        scroll: Math.max(0, profileView.scrollTop || 0),
        at: Date.now()
      };
    }
    root.addEventListener("pointerdown", rememberProfilePress, { capture: true, signal: controller.signal });
    root.addEventListener("mousedown", rememberProfilePress, { capture: true, signal: controller.signal });
    root.addEventListener("pointerdown", rememberProfileChatPress, { capture: true, signal: controller.signal });
    root.addEventListener("mousedown", rememberProfileChatPress, { capture: true, signal: controller.signal });
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-profile-peer]");
      if (!target) return;
      const peerId2 = target.dataset.profilePeer;
      if (!peerId2) return;
      event.preventDefault();
      openPeerProfile(peerId2, {
        source: currentPage,
        ref: target.dataset.profileRef || profileRefFor(peerId2, currentPage, peerId2),
        trigger: target
      });
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const trigger = event.target.closest?.("[data-quick-peer]");
      if (!trigger) return;
      event.preventDefault();
      openContactQuickMenu(trigger, trigger.dataset.quickPeer);
    }, { signal: controller.signal });
    doc.addEventListener("pointerdown", (event) => {
      if (contactQuickMenu.hidden) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(contactQuickMenu) || path.includes(quickMenuTrigger)) return;
      closeContactQuickMenu({ restoreFocus: false, quiet: true });
    }, { capture: true, signal: controller.signal });
    root.addEventListener("click", (event) => {
      const trigger = event.target.closest?.("[data-settings-open]");
      if (trigger) {
        event.preventDefault();
        openSettings(trigger.dataset.settingsTab || "");
        return;
      }
      const tab = event.target.closest?.("[data-settings-tab]");
      if (tab && !tab.disabled) {
        event.preventDefault();
        selectSettingsTab(tab.dataset.settingsTab);
        return;
      }
      if (event.target.closest?.("[data-settings-back]")) {
        event.preventDefault();
        if (returnToFavoritesFromSource()) return;
        if (settingsDirectEntry) {
          closeSettings();
          return;
        }
        clearSettingsFavoriteReturn();
        view.settings.index = true;
        renderSettingsView();
        pageEls.settings.scrollTop = 0;
        saveNow();
        return;
      }
      if (event.target.closest?.("[data-messages-open]")) {
        event.preventDefault();
        openMessagesIndex(currentPage);
        return;
      }
      const profileTab = event.target.closest?.("[data-profile-tab]");
      if (profileTab) {
        event.preventDefault();
        const next = profileTab.dataset.profileTab;
        if (!["interactions", "posts", "address"].includes(next)) return;
        if ((next === "interactions" || next === "address") && profileContactsKnown() && !profileIsContact()) return;
        view.contactProfile.tab = next;
        profileScrollMemory = { tab: next, scroll: 0, at: 0 };
        renderProfileTabs();
        if (next === "address" && profileState.friends.data === null && !profileState.friends.retrying) {
          void loadPeerFriends(profileState.peerId, false);
        }
        if (next === "posts") {
          if (profileState.posts.data === null && !profileState.posts.retrying) {
            void loadPeerDiscoveries(profileState.peerId, false);
          } else {
            renderProfilePeerPosts(profileState.peerId);
          }
        }
        if (next === "interactions" && profileState.memory.data === null && !profileState.memory.retrying) {
          void loadContactMemory(profileState.peerId, false);
        }
        saveNow();
      }
    }, { signal: controller.signal });
    settingsTrigger.addEventListener("click", () => {
      if (currentPage === "settings") closeSettings();
      else openSettings("");
    }, { signal: controller.signal });
    settingsClose.addEventListener("click", closeSettings, { signal: controller.signal });
    settingsFavoritesMore.addEventListener("click", () => {
      if (!favoritesState.hasMore || favoritesState.loading || !favoritesState.nextBefore) return;
      void loadFavorites({ before: favoritesState.nextBefore, append: true });
    }, { signal: controller.signal });
    settingsNodeStatus.addEventListener("click", (event) => openDialog(statusDialog, event.currentTarget), { signal: controller.signal });
    settingsNodeShare.addEventListener("click", (event) => openShareDialog(event.currentTarget), { signal: controller.signal });
    for (const [field, input] of [["persona", settingsStableInput], ["growth", settingsGrowthInput]]) {
      input.addEventListener("input", () => {
        privateEditors[field].dirty = true;
        privateEditors[field].error = "";
        renderPrivateEditors();
        saveNow();
      }, { signal: controller.signal });
    }
    settingsStableSave.addEventListener("click", () => {
      void savePrivateEditor("persona");
    }, { signal: controller.signal });
    settingsGrowthSave.addEventListener("click", () => {
      void savePrivateEditor("growth");
    }, { signal: controller.signal });
    settingsStableReload.addEventListener("click", () => {
      privateEditors.persona.dirty = false;
      privateEditors.persona.error = "";
      void loadJourney(true);
    }, { signal: controller.signal });
    settingsGrowthReload.addEventListener("click", () => {
      privateEditors.growth.dirty = false;
      privateEditors.growth.error = "";
      void loadJourney(true);
    }, { signal: controller.signal });
    for (const input of [publicAgentName, publicAgentDescription, publicAgentInterests, publicAgentStyle, publicHumanName, publicHumanBio]) {
      input.addEventListener("input", () => {
        scheduleProfileSave();
        if (input === publicHumanBio) renderHumanPreview();
      }, { signal: controller.signal });
    }
    publicDraftSave.addEventListener("click", () => {
      if (profileSaveTimer !== null) {
        win.clearTimeout(profileSaveTimer);
        profileSaveTimer = null;
      }
      void saveProfileDraft({ manual: true }).then(() => {
        if (!destroyed) publicDraftSave.focus?.({ preventScroll: true });
      });
    }, { signal: controller.signal });
    publicDraftReload.addEventListener("click", handleProfileReload, { signal: controller.signal });
    publicPublishButton.addEventListener("click", () => {
      void requestProfilePublish();
    }, { signal: controller.signal });
    publicPublishCancel.addEventListener("click", () => {
      if (profileDraftState.publishing) return;
      profileDraftState.confirm = false;
      profileDraftState.confirmSnapshot = "";
      profileDraftState.confirmNotice = "";
      profileDraftState.reloadArmed = false;
      publicPublishButton.textContent = "检查发布内容";
      publicPublishCancel.hidden = true;
      publicPublishButton.focus?.({ preventScroll: true });
      renderProfileDraftStatus();
    }, { signal: controller.signal });
    function releaseDraftImageAsset(kind) {
      const assetId = draftImageIsHuman(kind)
        ? profileDraftState.humanAvatarAssetId
        : profileDraftState.avatarAssetId;
      if (assetId) releaseDraftAsset("profile", "profile", assetId);
    }
    function applyPickedDraftImage(kind, file) {
      if (draftImageIsHuman(kind)) {
        profileDraftState.humanAvatarFile = file;
        profileDraftState.humanAvatarClear = false;
        profileDraftState.humanAvatarAssetId = "";
        profileDraftState.humanAvatarError = "";
        profileDraftState.humanAvatarLoadingAssetId = "";
        bumpDraftImageToken("human");
        releaseDraftImageAsset("human");
        releaseProfileHumanAvatarPreview();
        renderProfileHumanAvatar();
        return;
      }
      profileDraftState.avatarFile = file;
      profileDraftState.avatarClear = false;
      profileDraftState.avatarAssetId = "";
      profileDraftState.avatarError = "";
      profileDraftState.avatarLoadingAssetId = "";
      bumpDraftImageToken("agent");
      releaseDraftImageAsset("agent");
      releaseProfileAvatarPreview();
      renderProfileAvatar();
    }
    function clearDraftImage(kind) {
      if (draftImageIsHuman(kind)) {
        profileDraftState.humanAvatarFile = null;
        profileDraftState.humanAvatarAssetId = "";
        profileDraftState.humanAvatarClear = true;
        profileDraftState.humanAvatarError = "";
        profileDraftState.humanAvatarLoadingAssetId = "";
        bumpDraftImageToken("human");
        releaseDraftImageAsset("human");
        releaseProfileHumanAvatarPreview();
        renderProfileHumanAvatar();
        return;
      }
      profileDraftState.avatarFile = null;
      profileDraftState.avatarAssetId = "";
      profileDraftState.avatarClear = true;
      profileDraftState.avatarError = "";
      profileDraftState.avatarLoadingAssetId = "";
      bumpDraftImageToken("agent");
      releaseDraftImageAsset("agent");
      releaseProfileAvatarPreview();
      renderProfileAvatar();
    }
    function handleDraftImagePick(kind, input) {
      const file = input.files?.[0] ?? null;
      input.value = "";
      const human = draftImageIsHuman(kind);
      const label = human ? "关联人类头像" : "头像";
      if (!file || profileDraftState.publishing) return;
      if (!["image/png", "image/jpeg"].includes(file.type)) {
        profileDraftState.error = `${label}只支持 PNG 或 JPEG。`;
        if (human) profileDraftState.humanAvatarError = `${label}只支持 PNG 或 JPEG。`;
        else profileDraftState.avatarError = `${label}只支持 PNG 或 JPEG。`;
        renderProfileDraftStatus();
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        profileDraftState.error = `${label}超过 4 MiB。`;
        if (human) profileDraftState.humanAvatarError = `${label}超过 4 MiB。`;
        else profileDraftState.avatarError = `${label}超过 4 MiB。`;
        renderProfileDraftStatus();
        return;
      }
      applyPickedDraftImage(kind, file);
      const Reader = win.FileReader ?? globalThis.FileReader;
      if (typeof Reader !== "function") {
        if (human) profileDraftState.humanAvatarError = "当前环境没有文件读取能力；保存时仍会重试上传。";
        else profileDraftState.avatarError = "当前环境没有文件读取能力；保存时仍会重试上传。";
        scheduleProfileSave();
        return;
      }
      const reader = new Reader();
      reader.onload = () => {
        if (destroyed) return;
        if (human ? profileDraftState.humanAvatarFile !== file : profileDraftState.avatarFile !== file) return;
        if (human) {
          profileDraftState.humanAvatarPreviewUrl = String(reader.result ?? "");
          profileDraftState.humanAvatarPreviewObject = false;
          renderProfileHumanAvatar();
        } else {
          profileDraftState.avatarPreviewUrl = String(reader.result ?? "");
          profileDraftState.avatarPreviewObject = false;
          renderProfileAvatar();
        }
      };
      reader.onerror = () => {
        if (destroyed) return;
        if (human ? profileDraftState.humanAvatarFile !== file : profileDraftState.avatarFile !== file) return;
        if (human) profileDraftState.humanAvatarError = "读取本地人类头像预览失败；保存时仍会重试上传。";
        else profileDraftState.avatarError = "读取本地头像预览失败；保存时仍会重试上传。";
        renderProfileDraftStatus();
      };
      reader.readAsDataURL(file);
      profileDraftState.error = "";
      scheduleProfileSave();
    }
    publicAvatarInput.addEventListener("change", () => {
      handleDraftImagePick("agent", publicAvatarInput);
    }, { signal: controller.signal });
    publicAvatarClear.addEventListener("click", () => {
      if (profileDraftState.publishing) return;
      clearDraftImage("agent");
      scheduleProfileSave();
    }, { signal: controller.signal });
    publicHumanAvatarInput.addEventListener("change", () => {
      handleDraftImagePick("human", publicHumanAvatarInput);
    }, { signal: controller.signal });
    publicHumanAvatarClear.addEventListener("click", () => {
      if (profileDraftState.publishing) return;
      clearDraftImage("human");
      scheduleProfileSave();
    }, { signal: controller.signal });
    publicRestorePublished.addEventListener("click", () => {
      void restorePublishedProfile();
    }, { signal: controller.signal });
    composePost.addEventListener("click", () => {
      void openPostEditor({ trigger: composePost });
    }, { signal: controller.signal });
    postEditorClose.addEventListener("click", () => closePostEditor(), { signal: controller.signal });
    postEditorDismiss.addEventListener("click", () => closePostEditor(), { signal: controller.signal });
    postWriteAnother.addEventListener("click", startAnotherPost, { signal: controller.signal });
    postRestoreStash.addEventListener("click", () => {
      restorePostEditorStash({ focus: true, replace: postEditorHasUnsavedChanges() });
    }, { signal: controller.signal });
    postDiscardStash?.addEventListener("click", () => {
      discardPostEditorStash({ focus: true });
    }, { signal: controller.signal });
    postSaveAsNew.addEventListener("click", () => {
      void savePostAsNewDraft();
    }, { signal: controller.signal });
    postDraftSave.addEventListener("click", () => {
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
      }
      void savePostDraft();
    }, { signal: controller.signal });
    postPublishButton.addEventListener("click", () => {
      void publishPost();
    }, { signal: controller.signal });
    postPublishCancel.addEventListener("click", () => cancelPostConfirm({ focus: true }), { signal: controller.signal });
    postEditorPanel.addEventListener("click", (event) => {
      if (event.target === postEditorPanel || event.target.closest?.("#postEditorDismiss")) {
        closePostEditor();
      }
    }, { signal: controller.signal });
    postEditorPanel.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePostEditor();
    }, { signal: controller.signal });
    postDraftSelect.addEventListener("change", async () => {
      if (postEditorState.saving || postEditorState.uploading || postEditorState.publishing || postEditorState.loading || postEditorState.validatingImages > 0) return;
      if (postEditorStashWouldBeReplaced()) {
        blockPostEditorStashReplacement("切换草稿");
        return;
      }
      const wasConfirming = postEditorState.confirm;
      const id = postDraftSelect.value;
      const previousView = postEditorViewSnapshot();
      const stashed = capturePostEditorStash("切换草稿");
      if (postSaveTimer !== null) {
        win.clearTimeout(postSaveTimer);
        postSaveTimer = null;
      }
      invalidatePostConfirm(wasConfirming ? "已切换草稿；旧确认已撤销，请重新检查发布内容。" : "");
      postEditorState.receipt = null;
      postEditorState.confirmNotice = wasConfirming ? "已切换草稿；旧确认已撤销，请重新检查发布内容。" : "";
      clearPendingPostImages();
      postEditorState.draft = null;
      setPostForm(null);
      postEditorState.dirty = false;
      const seq = ++postEditorState.draftLoadSeq;
      postEditorState.loading = true;
      renderPostEditorStatus();
      if (!id) {
        postEditorState.loading = false;
        postEditorState.draftEpoch += 1;
        postEditorState.formVersion += 1;
        resetPostEditorForm();
        postEditorState.confirmNotice = wasConfirming ? "已切换到新建草稿；旧确认已撤销，请重新检查发布内容。" : "";
        postEditorNote.hidden = false;
        postEditorNote.textContent = stashed ? "已切换到新建草稿；刚才的未保存内容已保留，可点“恢复未保存内容”找回。" : "已切换到新建草稿。";
        renderPostEditorStatus();
        postTitleInput.focus({ preventScroll: true });
        return;
      }
      try {
        const result = await options.onLoadPublicDraft(id);
        if (seq !== postEditorState.draftLoadSeq || !postEditorState.open) return;
        if (!result?.found || !result.draft) throw new Error("草稿不存在");
        postEditorState.draft = result.draft;
        postEditorState.draftEpoch += 1;
        postEditorState.formVersion += 1;
        setPostForm(result.draft);
        postEditorState.dirty = false;
        postEditorNote.hidden = false;
        postEditorNote.textContent = stashed ? "已载入所选草稿；切换前的未保存输入已保留，可点“恢复未保存内容”找回。" : "已载入所选草稿。";
      } catch (error) {
        if (seq !== postEditorState.draftLoadSeq || !postEditorState.open) return;
        postEditorState.loading = false;
        if (stashed) restorePostEditorStash();
        else restorePostEditorView(previousView);
        postEditorNote.hidden = false;
        postEditorNote.textContent = `${errorText(error)}；原输入已保留。`;
      } finally {
        if (seq === postEditorState.draftLoadSeq) {
          postEditorState.loading = false;
          renderPostEditorStatus();
          renderPostStashControl();
        }
      }
    }, { signal: controller.signal });
    for (const input of [postTitleInput, postBodyInput, postTagsInput]) {
      input.addEventListener("input", schedulePostSave, { signal: controller.signal });
    }
    postAuthorKind.addEventListener("change", () => {
      schedulePostSave();
      renderPostAuthorNote();
    }, { signal: controller.signal });
    postImageInput.addEventListener("change", () => {
      const files = [...postImageInput.files ?? []];
      postImageInput.value = "";
      if (files.length > 0) void addPostFiles(files);
    }, { signal: controller.signal });
    conversationIndexBack.addEventListener("click", () => {
      const target = pageElsHas(view.pages.messages.indexReturnPage) && view.pages.messages.indexReturnPage !== "messages" ? view.pages.messages.indexReturnPage : "home";
      showPage(target);
    }, { signal: controller.signal });
    root.querySelectorAll("nav.rm-nav").forEach((nav) => {
      nav.innerHTML = renderPrimaryNav(currentPage);
    });
    root.addEventListener("click", (event) => {
      const nav = event.target.closest?.("button[data-nav]");
      if (!nav) return;
      event.preventDefault();
      const page = pageForNav(nav.dataset.nav);
      if (currentPage === "messages") saveChatScroll();
      if (page === currentPage) {
        if (!profileView.hidden) {
          closePeerProfile();
          return;
        }
        if (page === "messages" && contactsState.selectedPeerId) return;
        const active = pageEls[page];
        if (typeof active.scrollTo === "function") active.scrollTo({ top: 0, behavior: "smooth" });
        else active.scrollTop = 0;
        return;
      }
      showPage(page);
    }, { signal: controller.signal });
    exploreRefresh.addEventListener("click", () => {
      if (view.pages.explore.filter === "mine") {
        void loadMine(true);
        return;
      }
      void refreshDiscoveries(true);
    }, { signal: controller.signal });
    exploreQuery.addEventListener("input", () => {
      updateExploreSearchState();
      updateExploreState();
      scheduleSave();
    }, { signal: controller.signal });
    exploreQuery.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && exploreQuery.value.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        clearExploreSearch({ focus: true });
      }
    }, { signal: controller.signal });
    exploreClear?.addEventListener("click", () => {
      clearExploreSearch({ focus: true });
    }, { signal: controller.signal });
    contactQuery.addEventListener("input", () => {
      updateContactsState();
      scheduleSave();
    }, { signal: controller.signal });
    conversationQuery.addEventListener("input", () => {
      updateConversationIndexState();
      saveNow();
    }, { signal: controller.signal });
    $$("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => setFilter(button.dataset.filter), { signal: controller.signal });
    });
    for (const button of contactFilters) {
      button.addEventListener("click", () => setContactFilter(button.dataset.contactFilter), { signal: controller.signal });
    }
    contactsMessages.addEventListener("click", () => {
      openMessagesIndex("contacts");
    }, { signal: controller.signal });
    contactsShare.addEventListener("click", (event) => {
      openShareDialog(event.currentTarget);
    }, { signal: controller.signal });
    $("#addContact").addEventListener("click", (event) => {
      openAddDialog(event.currentTarget);
    }, { signal: controller.signal });
    contactsShareAction.addEventListener("click", (event) => {
      openShareDialog(event.currentTarget);
    }, { signal: controller.signal });
    contactList.addEventListener("click", (event) => {
      const connectTrigger = event.target.closest?.("button[data-connect-peer]");
      if (connectTrigger) {
        if (connectTrigger.getAttribute("aria-disabled") === "true") return;
        startContactConnect(connectTrigger.dataset.connectPeer);
        return;
      }
      const toggle = event.target.closest?.("button[data-toggle-peer]");
      if (toggle) {
        const row2 = toggle.closest?.("[data-contact-row]");
        const peerId2 = row2?.dataset.contactRow ?? "";
        if (row2 && peerId2) {
          if (expandedContactIds.has(peerId2)) expandedContactIds.delete(peerId2);
          else expandedContactIds.add(peerId2);
          applyContactPeerIdVisibility(row2, peerId2);
        }
        return;
      }
      const copy = event.target.closest?.("button[data-copy-peer]");
      if (copy) {
        copyContactPeerId(copy.dataset.copyPeer, copy);
        return;
      }
      const chatTrigger = event.target.closest?.("button[data-chat-peer]");
      if (chatTrigger) {
        openConversation(chatTrigger.dataset.chatPeer, {
          source: "contacts",
          returnFocus: chatTrigger.dataset.focusKey || `contact-chat:${chatTrigger.dataset.chatPeer}`
        });
        return;
      }
      const row = event.target.closest?.("button[data-contact-peer]");
      if (!row) return;
      if (!peerProfileCapable) {
        openConversation(row.dataset.contactPeer, { source: "contacts" });
        return;
      }
      openPeerProfile(row.dataset.contactPeer, {
        source: "contacts",
        ref: row.dataset.profileRef || `contacts:${row.dataset.contactPeer}`,
        trigger: row
      });
    }, { signal: controller.signal });
    if (contactClueList) {
      contactClueList.addEventListener("click", (event) => {
        const copy = event.target.closest?.("button[data-copy-peer]");
        if (copy) {
          copyContactPeerId(copy.dataset.copyPeer, copy);
          return;
        }
        const view2 = event.target.closest?.("button[data-view-clue]");
        if (!view2) return;
        const clue = [...directoryClues.values()].find((item) => item.peerId === view2.dataset.viewClue) ?? null;
        if (clue) openContactClue(clue, view2);
      }, { signal: controller.signal });
    }
    conversationList.addEventListener("click", (event) => {
      const row = event.target.closest?.("button[data-conversation-peer]");
      if (!row) return;
      openConversation(row.dataset.conversationPeer, { source: "messages" });
    }, { signal: controller.signal });
    discoveryList.addEventListener("click", (event) => {
      const retry = event.target.closest?.("[data-retry-post]");
      if (!retry) return;
      const id = retry.dataset.retryPost;
      const items = discoveryDataFor(view.pages.explore.filter === "familiar")?.items ?? [];
      const item = items.find((entry) => entry.id === id);
      if (item) void ensurePostContent(item, true);
    }, { signal: controller.signal });
    ramingaSessionList.addEventListener("click", (event) => {
      const tile = event.target.closest?.("[data-journey-open]");
      if (tile) {
        openJourneyDetail(tile.dataset.journeyOpen, {
          source: tile.dataset.journeySource || "home",
          returnFocus: tile.dataset.focusKey || `journey-home:${tile.dataset.journeyOpen}`
        });
      }
    }, { signal: controller.signal });
    homeJourneysAll.addEventListener("click", () => {
      openJourneysPage();
    }, { signal: controller.signal });
    journeysBack.addEventListener("click", () => {
      showPage("home");
      pageEls.home.scrollTop = view.home.scroll;
      saveNow();
    }, { signal: controller.signal });
    journeysRefresh.addEventListener("click", () => {
      void loadJourney(true);
    }, { signal: controller.signal });
    journeyQuery.addEventListener("input", () => {
      view.pages.journeys.query = journeyQuery.value;
      view.pages.journeys.focusKey = "";
      renderJourneysPage();
      pageEls.journeys.scrollTop = 0;
      scheduleSave();
    }, { signal: controller.signal });
    journeysClear.addEventListener("click", () => {
      view.pages.journeys.query = "";
      journeyQuery.value = "";
      renderJourneysPage();
      pageEls.journeys.scrollTop = 0;
      journeyQuery.focus({ preventScroll: true });
      saveNow();
    }, { signal: controller.signal });
    journeyList.addEventListener("click", (event) => {
      const tile = event.target.closest?.("[data-journey-open]");
      if (!tile) return;
      openJourneyDetail(tile.dataset.journeyOpen, {
        source: "journeys",
        returnFocus: tile.dataset.focusKey || `journey-list:${tile.dataset.journeyOpen}`
      });
    }, { signal: controller.signal });
    journeyBack.addEventListener("click", () => {
      const source = view.journey.source;
      if (source === "journeys") {
        showPage("journeys");
        pageEls.journeys.scrollTop = view.pages.journeys.scroll;
        saveNow();
        focusJourneyReturnKey(view.journey.returnFocus);
        return;
      }
      showPage("home");
      pageEls.home.scrollTop = view.home.scroll;
      saveNow();
      focusJourneyReturnKey(view.journey.returnFocus);
    }, { signal: controller.signal });
    journeyDetail.addEventListener("click", (event) => {
      const locate = event.target.closest?.("[data-journey-locate-peer]");
      if (locate) {
        event.preventDefault();
        void locateJourneyMessage(locate.dataset.journeyLocatePeer, locate.dataset.journeyLocateMessage, {
          source: "journey",
          journeyId: view.journey.id,
          eventSeq: Number(locate.dataset.journeyLocateEvent) || 0
        });
        return;
      }
      const fallbackPeer = event.target.closest?.("[data-journey-fallback-peer]");
      if (fallbackPeer && peerProfileCapable) {
        openPeerProfile(fallbackPeer.dataset.journeyFallbackPeer, { source: "journey", ref: `journey-missing:${view.journey.id}` });
        return;
      }
      const fallbackChat = event.target.closest?.("[data-journey-fallback-chat]");
      if (fallbackChat) {
        openConversation(fallbackChat.dataset.journeyFallbackChat, { source: "messages" });
        return;
      }
      const fallbackLocate = event.target.closest?.("[data-journey-fallback-locate-peer]");
      if (fallbackLocate) {
        void locateJourneyMessage(fallbackLocate.dataset.journeyFallbackLocatePeer, fallbackLocate.dataset.journeyFallbackLocateMessage, {
          source: "messages"
        });
      }
    }, { signal: controller.signal });
    homeActivityDetail.addEventListener("click", (event) => {
      const locate = event.target.closest?.("[data-locate-message]");
      if (locate) {
        if (!locate.dataset.locatePeer || !locate.dataset.locateMessage) return;
        void locateJourneyMessage(locate.dataset.locatePeer, locate.dataset.locateMessage);
        return;
      }
      const activityLocate = event.target.closest?.("[data-activity-locate-peer]");
      if (activityLocate) {
        if (!activityLocate.dataset.activityLocatePeer || !activityLocate.dataset.activityLocateMessage) return;
        void locateJourneyMessage(activityLocate.dataset.activityLocatePeer, activityLocate.dataset.activityLocateMessage);
        return;
      }
      const chat2 = event.target.closest?.("[data-open-journey-chat]");
      if (chat2) {
        openConversation(chat2.dataset.openJourneyChat, { source: "home" });
        return;
      }
      const activityChat = event.target.closest?.("[data-activity-chat]");
      if (activityChat?.dataset.activityChat) {
        openConversation(activityChat.dataset.activityChat, { source: "home" });
        return;
      }
      const journey = event.target.closest?.("[data-activity-journey]");
      if (journey?.dataset.activityJourney) {
        openJourneyDetail(journey.dataset.activityJourney, {
          source: "activity",
          operationId: activityState.detail.id || "",
          returnFocus: "home-activity-card"
        });
        return;
      }
      const peer = event.target.closest?.("[data-activity-peer]");
      if (peer?.dataset.activityPeer && peerProfileCapable) {
        openPeerProfile(peer.dataset.activityPeer, { source: "home", ref: "activity" });
        return;
      }
      const history = event.target.closest?.("[data-activity-history]");
      if (history?.dataset.activityHistory) {
        view.home.activityExpanded = true;
        ensureActivityDetail(history.dataset.activityHistory);
        renderHome();
      }
    }, { signal: controller.signal });
    profileBack.addEventListener("click", () => closePeerProfile());
    postBack?.addEventListener("click", () => closePostDetail(), { signal: controller.signal });
    postDetail?.addEventListener("click", (event) => {
      const retry = event.target.closest?.("[data-detail-retry]");
      if (retry) {
        const item = postDetailItem();
        if (item && view.post.source === "explore") void ensurePostContent(item, true);
      }
    }, { signal: controller.signal });
    profileView.addEventListener("scroll", () => {
      const top = Math.max(0, Number(profileView.scrollTop) || 0);
      if (top > 0) {
        profileScrollMemory = { tab: view.contactProfile.tab, scroll: top, at: Date.now() };
      }
      scheduleSave();
    }, { passive: true, signal: controller.signal });
    profileTimeline.addEventListener("click", (event) => {
      const message = event.target.closest?.("[data-memory-message]");
      if (message) {
        event.preventDefault();
        openMessageFromMemory(message.dataset.memoryPeer, message.dataset.memoryMessage, message);
        return;
      }
      const journey = event.target.closest?.("[data-memory-journey]");
      if (journey) {
        event.preventDefault();
        openJourneyDetail(journey.dataset.memoryJourney, { source: "memory" });
      }
    }, { signal: controller.signal });
    profileMemoryRetry.addEventListener("click", () => {
      if (profileState.peerId) void loadContactMemory(profileState.peerId, true);
    }, { signal: controller.signal });
    impressionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitImpression();
    }, { signal: controller.signal });
    $("#conversationBack").addEventListener("click", closeConversation, { signal: controller.signal });
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitMessage();
    }, { signal: controller.signal });
    messageInput.addEventListener("input", () => {
      const peerId2 = contactsState.selectedPeerId;
      if (peerId2) persistDraft(peerId2, messageInput.value);
      updateComposerMeta();
    }, { signal: controller.signal });
    messageInput.addEventListener("compositionstart", () => {
      composerComposing = true;
    }, { signal: controller.signal });
    messageInput.addEventListener("compositionend", () => {
      composerComposing = false;
    }, { signal: controller.signal });
    messageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (event.isComposing || composerComposing || event.keyCode === 229) return;
      if (event.shiftKey) return;
      event.preventDefault();
      void submitMessage();
    }, { signal: controller.signal });
    messageJumpLatest.addEventListener("click", jumpToLatestMessages, { signal: controller.signal });
    sendReconcile.addEventListener("click", () => {
      void submitMessage({ reconcile: true });
    }, { signal: controller.signal });
    sendRestore.addEventListener("click", retryFailedSend, { signal: controller.signal });
    composerTech.addEventListener("click", openComposerDetail, { signal: controller.signal });
    messageList.addEventListener("scroll", saveChatScroll, { passive: true, signal: controller.signal });
    messageList.addEventListener("scroll", () => {
      updateJumpToLatest();
      if (isMessageListAtBottom()) scheduleMarkRead();
      else cancelMarkRead();
    }, { passive: true, signal: controller.signal });
    win.addEventListener("resize", updateJumpToLatest, { passive: true, signal: controller.signal });
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "visible") scheduleMarkRead();
      else cancelMarkRead();
    }, { signal: controller.signal });
    win.addEventListener("blur", cancelMarkRead, { signal: controller.signal });
    win.addEventListener("focus", () => {
      scheduleMarkRead();
    }, { signal: controller.signal });
    root.addEventListener("focusin", () => {
      scheduleMarkRead();
    }, { signal: controller.signal });
    addContactForm.addEventListener("submit", submitAddContact, { signal: controller.signal });
    addContactCheck.addEventListener("click", () => {
      void checkContactAgain();
    }, { signal: controller.signal });
    addContactView.addEventListener("click", viewNewContact, { signal: controller.signal });
    editContactForm.addEventListener("submit", submitEditContact, { signal: controller.signal });
    editContactNameClear.addEventListener("click", () => {
      if (editPending || !friendNameEditCapable) return;
      editContactName.value = "";
      editContactName.focus({ preventScroll: true });
    }, { signal: controller.signal });
    editContactDescriptionClear.addEventListener("click", () => {
      if (editPending || !friendDescriptionEditCapable) return;
      editContactDescription.value = "";
      editContactDescription.focus({ preventScroll: true });
    }, { signal: controller.signal });
    shareCopy.addEventListener("click", () => {
      void copyShareInfo();
    }, { signal: controller.signal });
    shareRetry.addEventListener("click", () => {
      void loadShare();
    }, { signal: controller.signal });
    statusShareNode.addEventListener("click", (event) => {
      openShareDialog(event.currentTarget);
    }, { signal: controller.signal });
    statusBootstrap.addEventListener("toggle", () => {
      if (statusBootstrap.open && bootstrapState.data === null && bootstrapState.request === null) void loadBootstrap(false);
    }, { signal: controller.signal });
    statusBootstrapRefresh.addEventListener("click", () => {
      bootstrapFeedback("");
      void loadBootstrap(true);
    }, { signal: controller.signal });
    statusBootstrapEdit.addEventListener("submit", (event) => {
      event.preventDefault();
      void addBootstrapPeer();
    }, { signal: controller.signal });
    statusBootstrapList.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-bootstrap-remove]");
      if (!button) return;
      void removeBootstrapPeer(button.dataset.bootstrapRemove ?? "");
    }, { signal: controller.signal });
    statusBootstrapCopy.addEventListener("click", () => {
      const addresses = bootstrapEntries().flatMap((entry) => entry.addrs);
      void copyTextWithNotice(addresses.join("\n"), statusBootstrapFeedback, "已复制全部引导节点地址。");
    }, { signal: controller.signal });
    profileCopyPeerInline.addEventListener("click", () => {
      void copyTextWithNotice(profileState.peerId, profileOriginNote, "完整 Peer ID 已复制。");
    }, { signal: controller.signal });
    profileCopyCurrent.addEventListener("click", () => {
      const text4 = addressesText(currentPeerNodeSnapshot()?.currentAddresses ?? []);
      void copyTextWithNotice(text4, profileNodeNote, "当前连接地址已复制。");
    }, { signal: controller.signal });
    profileCopyAnnounced.addEventListener("click", () => {
      const text4 = addressesText(currentPeerNodeSnapshot()?.knownAddresses ?? []);
      void copyTextWithNotice(text4, profileNodeNote, "本机已知地址已复制；它们不是对方公告证据，也不证明当前可达。");
    }, { signal: controller.signal });
    profileNodeRefresh.addEventListener("click", () => {
      void refreshPeerNodeInfo();
    }, { signal: controller.signal });
    profileOriginDetails.addEventListener("toggle", () => {
      if (destroyed || !profileOriginDetails.open) return;
      const peerId2 = profileState.peerId;
      if (!peerId2) return;
      if (!peerNodeInfoCapable) {
        renderPeerNodeInfo();
        return;
      }
      if (profileState.node.data === null && !profileState.node.retrying) {
        void loadPeerNodeInfo(peerId2, false);
      }
    }, { signal: controller.signal });
    nodeTrigger.addEventListener("click", () => openDialog(statusDialog, nodeTrigger), { signal: controller.signal });
    $("#ramingaStateAction").addEventListener("click", () => openDialog(statusDialog, $("#ramingaStateAction")), { signal: controller.signal });
    ramingaRefresh.addEventListener("click", () => {
      void loadJourney(true);
    }, { signal: controller.signal });
    statusRefresh.addEventListener("click", () => requestRefresh({ visible: true }), { signal: controller.signal });
    mineRefresh.addEventListener("click", () => {
      if (mineCapable) void loadMine(true);
    }, { signal: controller.signal });
    for (const dialog of [statusDialog, noticeDialog, addContactDialog, editContactDialog, impressionDialog, shareDialog, technicalDialog, agentCardDialog, favoriteDialog]) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog || event.target.closest?.("[data-close-dialog]")) {
          closeDialog(dialog);
        }
      }, { signal: controller.signal });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDialog(dialog);
      }, { signal: controller.signal });
    }
    favoriteDialog?.addEventListener("close", () => {
      favoriteReader.requestSeq += 1;
      favoriteReader.item = null;
      favoriteReader.preview = null;
      favoriteReader.loading = false;
      favoriteReader.error = "";
      disposePreviewMedia(favoriteDialogBody);
      favoriteDialogBody?.replaceChildren();
    }, { signal: controller.signal });
    imagePreviewDialog?.addEventListener("click", (event) => {
      if (event.target === imagePreviewDialog || event.target.closest?.("[data-close-dialog]")) {
        event.preventDefault();
        closeImagePreview();
      }
    }, { signal: controller.signal });
    imagePreviewDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeImagePreview();
    }, { signal: controller.signal });
    imagePreviewDialog?.addEventListener("close", () => {
      cleanupImagePreview();
    }, { signal: controller.signal });
    impressionDialog.addEventListener("close", () => {
      impressionEditState.open = false;
      impressionEditState.saving = false;
      impressionEditState.peerId = "";
      impressionEditState.impressionId = "";
      impressionEditState.expectedSha = "";
      impressionDialogNote.hidden = true;
      impressionSave.disabled = false;
      impressionSave.textContent = "保存印象";
    }, { signal: controller.signal });
    addContactDialog.addEventListener("close", () => {
      addAttempt += 1;
      checkAttempt += 1;
      addContactPeerId = "";
    }, { signal: controller.signal });
    editContactDialog.addEventListener("close", () => {
      editAttempt += 1;
      editPending = false;
      editTargetPeerId = "";
      setEditFeedback();
      setEditBusy(false);
    }, { signal: controller.signal });
    shareDialog.addEventListener("close", () => {
      shareAttempt += 1;
      currentShare = null;
    }, { signal: controller.signal });
    for (const page of Object.values(pageEls)) {
      page.addEventListener("scroll", () => {
        if (page.hidden) return;
        if (!contactQuickMenu.hidden) closeContactQuickMenu({ restoreFocus: false, quiet: true });
        scheduleSave();
      }, { passive: true, signal: controller.signal });
    }
    if (favoritesEntry) favoritesEntry.hidden = !favoritesCapable;
    for (const item of $$('[data-settings-tab="favorites"]')) item.hidden = !favoritesCapable;
    restoreControls();
    showPage(currentPage, { save: false });
    renderNodeMeta();
    renderStatusDialog();
    renderBootstrap();
    renderMineIdentity();
    renderMine();
    renderJourney();
    const postFromProfile = currentPage === "post" && view.post.source === "peer" && view.post.peerId.length > 0;
    if (postFromProfile) {
      // Restore the detail route without reopening the profile overlay. The
      // profile state and exact posts-tab return target stay ready for Back.
      profileView.hidden = true;
      updatePrimaryNav(root, pageElsHas(view.contactProfile.returnPage) ? view.contactProfile.returnPage : "contacts");
      if (preparePeerPostContext(view.post.peerId)) {
        renderProfile();
        if (peerProfileCapable) void loadPeerProfile(view.post.peerId, true);
        if (peerDiscoveriesCapable && profileState.posts.data === null) {
          void loadPeerDiscoveries(view.post.peerId, true);
        }
        renderPostDetailPage();
      }
    } else if (view.contactProfile.peerId) {
      const chatFromProfile = currentPage === "messages" && contactsState.selectedPeerId === view.contactProfile.peerId && view.pages.messages.returnPage === "profile";
      profileReturn.page = view.contactProfile.returnPage;
      profileReturn.peerId = view.contactProfile.returnPeer;
      profileTriggerRef = view.contactProfile.triggerId;
      profileReturn.scroll = pageTracksScroll(view.contactProfile.returnPage) ? Math.max(0, Number(pageStateFor(view.contactProfile.returnPage)?.scroll) || 0) : Math.max(0, Number(view.pages.messages?.scroll) || 0);
      profileReturn.open = !chatFromProfile;
      profileState.peerId = view.contactProfile.peerId;
      resetProfileMemoryUi(view.contactProfile.peerId);
      profileState.data = null;
      profileState.error = "";
      profileState.friends = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.posts = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.memory = { data: null, error: "", requestSeq: 0, retrying: false };
      profileState.node = { data: null, error: "", requestSeq: 0, retrying: false };
      if (!chatFromProfile) {
        pageEls[currentPage].hidden = true;
        profileView.hidden = false;
        renderProfile();
        void loadPeerProfile(view.contactProfile.peerId, true);
        if (view.contactProfile.tab === "address") void loadPeerFriends(view.contactProfile.peerId, true);
      } else {
        profileView.hidden = true;
        renderProfile();
        void loadPeerProfile(view.contactProfile.peerId, true);
        if (view.contactProfile.tab === "address") void loadPeerFriends(view.contactProfile.peerId, true);
      }
    } else {
      ensurePageData(currentPage);
    }
    saveNow();
    return {
      setNodeStatus,
      pushNodeEvent,
      setStats,
      setActivity,
      setActivityError,
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
        void loadContactProjection();
        ensurePageData(currentPage);
        if (favoritesCapable) void loadFavorites({});
        if (!profileView.hidden && profileState.peerId) void loadPeerProfile(profileState.peerId, true);
      },
      getDraft: getDraft2,
      setDraft: setDraft2,
      reloadMine() {
        if (!destroyed && mineCapable) void loadMine(true);
      },
      flushDrafts() {
        if (!destroyed) flushPublicDraftEditors();
      },
      destroy() {
        if (destroyed) return;
        flushPublicDraftEditors();
        cancelMarkRead();
        if (profileSaveTimer !== null) win.clearTimeout(profileSaveTimer);
        if (postSaveTimer !== null) win.clearTimeout(postSaveTimer);
        for (const pending of postEditorState.pending) URL.revokeObjectURL(pending.url);
        releaseAllDraftAssets();
        if (chat.peerId) saveChatScroll();
        destroyed = true;
        controller.abort();
        saveNow();
        addAttempt += 1;
        checkAttempt += 1;
        shareAttempt += 1;
        editAttempt += 1;
        closeContactQuickMenu({ restoreFocus: false, quiet: true });
        if (postEditorState.open) closePostEditor({ restoreFocus: false });
        for (const dialog of [statusDialog, noticeDialog, addContactDialog, editContactDialog, impressionDialog, shareDialog, technicalDialog, agentCardDialog, favoriteDialog, imagePreviewDialog, postEditorPanel]) {
          if (dialog?.open) dialog.close();
        }
        cleanupImagePreview();
        dialogTriggers.clear();
        technicalReturn = null;
        statusTech.open = false;
        statusBootstrap.open = false;
        disposePreviewMedia(discoveryList);
        disposePreviewMedia(profileView);
        disposePreviewMedia(minePostList);
        disposePreviewMedia(mineFeedList);
        resetPostContentCache();
        postMetaCache.clear();
        postMetaInflight.clear();
        postMetaQueue.length = 0;
        releaseAllPostImages();
        profilePreviews.clear();
        minePreviews.clear();
        revealResults.clear();
        root.replaceChildren();
      }
    };
  }
