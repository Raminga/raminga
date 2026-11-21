// Host bridge for the DSH Raminga panel.
//
// It reuses the existing RamingaApi (the same local Connect-RPC client the
// tools use) and the existing Events subscriber. The browser never sees the
// API token, the socket path, or the daemon's database. A panel lease is
// ref-counted so closing the tab (or unloading the plugin) stops the Events
// stream instead of leaving a long-lived subscription behind.
//
// Status is the only fact source for connection counts. Connection events are
// hints to re-read Status; a single "disconnected" event never changes a Peer
// from online to offline by itself. Reads are coalesced per bridge so two open
// panels (or an event racing a manual refresh) share one daemon call, and the
// trailing event is reconciled instead of being lost.
import { createHash, randomUUID } from 'node:crypto';
import { protoInt64 } from '@bufbuild/protobuf';
import { isIP } from 'node:net';
import path from 'node:path';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Friend, PublicDraft as ProtoPublicDraft, PublicDraftImage as ProtoPublicDraftImage, StatusResponse } from './gen/raminga/api/v1/api_pb.js';
import {
  AddBootstrapPeerRequest,
  ConnectRequest,
  DhtStatusRequest,
  ListBootstrapPeersRequest,
  RemoveBootstrapPeerRequest,
  DeletePublicDraftRequest,
  DownloadPeerFileRequest,
  GetPublicDraftAssetRequest,
  GetPublicDraftRequest,
  GetPeerManifestRequest,
  GetPeerFriendsRequest,
  ListPublicDraftsRequest,
  PublishedRequest,
  GetPeerProfileRequest,
  ImportPublicPostRequest,
  PublishPublicDraftRequest,
  PutPublicDraftImageRequest,
  SavePublicDraftRequest,
  ListConversationsRequest,
  ListDiscoveriesRequest,
  ListFavoritesRequest,
  ListFriendsRequest,
  ListHumanOutboundPeersRequest,
  ListMessagesRequest,
  MarkConversationReadRequest,
  OutboxCancelRequest,
  PublicPublishStatus,
  SendChatRequest,
  SetFavoriteRequest,
  SetFriendDescriptionRequest,
  SetFriendNameRequest,
  StatusRequest,
} from './gen/raminga/api/v1/api_pb.js';
import {
  MAX_CONTACT_PROJECTION_AVATAR_BYTES,
  MAX_CONTACT_PROJECTION_CLUES,
  MAX_CONTACT_PROJECTION_PROFILES,
  MAX_MINE_FILES,
  MAX_MINE_HASH_BYTES,
  MAX_POST_BYTES,
  downloadedFileInfo,
  hashDownloadedFile,
  hashPublicFile,
  isVersionedPostPath,
  isV2PostPath,
  isPostImagePublicPath,
  parsePublicPost,
  postImagePublicPath,
  readDiscoveryFile,
  readDiscoveryPost,
  readDownloadedAgentCard,
  readDownloadedFile,
  readDownloadedProfile,
  readContactProjection,
  readContactNotes,
  readDownloadedProfileName,
  readJourney,
  readOwnAgentCard,
  readOwnPublic,
  saveContactImpression,
  savePrivateAgentFile,
  writeContactProjection,
  readPublicFile,
  type ContactNote,
  type ContactImpressionSaveInput,
  type ContactProjectionClue,
  type ContactProjectionData,
  type ContactProjectionProfile,
  type LocalAgentCard,
  LocalDataError,
  type LocalContactNotes,
  type LocalPost,
  type JourneyData,
  type JourneyEvent,
  type OwnPublicData,
  type PrivateAgentSave,
  type LocalOwnProfile,
  type LocalPublicProfile,
  type LocalPublicProfileRead,
} from './local-data.js';
import {
  MAX_HTML_SOURCE,
  MAX_MEDIA_PREVIEW,
  MAX_ZIP_ARCHIVE,
  PublicFileError,
  buildFilePreview,
  buildHtmlFilePreview,
  buildZipFilePreview,
  fileTypeOf,
  firstMarkdownHeading,
  titleFallback,
  type FilePreview,
  type PublicFileKind,
} from './public-files.js';
import type { RamingaApi } from './client.js';
import {
  subscribeEvents,
  type EventStreamPhase,
  type SubscribeEventsOptions,
} from './events.js';
import { UI_INVOCATIONS, UI_SERVICE_KEY } from './ui-typert.js';
import {
  AgentActivityStore,
  readJourneySummary,
  type ActivityEvidence,
  type ActivityOperation,
  type ActivityRead,
  type JourneySummary,
} from './activity.js';

const STATUS_TTL_MS = 1500;
const STATUS_FRESH_MS = 10_000;
const CONTACTS_TTL_MS = 4000;
const CONTACTS_FRESH_MS = 15_000;
const CONVERSATIONS_TTL_MS = 4000;
const CONVERSATIONS_FRESH_MS = 15_000;
const MESSAGES_TTL_MS = 2500;
const MESSAGES_FRESH_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 100;
const CONVERSATION_PAGE_LIMIT = 100;
const SEND_TIMEOUT_MS = 25_000;
const CANCEL_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 30_000;
const STREAM_READY_TIMEOUT_MS = 2500;
const CONNECTION_RECONCILE_DELAY_MS = 200;
// Bound a burst of connection events so a noisy network cannot keep one
// reconcile loop running forever while still preserving the last event.
const MAX_RECONCILE_PASSES = 3;
// Normal panel unmount/switch/plugin unload calls close() immediately; the
// idle reaper below is only a last-resort backstop for abrupt browser drops.
const SESSION_IDLE_MS = 300_000;
const REAPER_INTERVAL_MS = 5_000;
const MAX_QUEUED_EVENTS = 100;
// A close can reach the host before an open that was issued earlier (separate
// Remote calls have no shared ordering). Remember recently closed session ids
// so such a late open cannot resurrect a lease after cleanup.
const CLOSED_SESSION_TTL_MS = 15 * 60_000;
const MAX_CLOSED_SESSIONS = 512;
const DISCOVERY_TTL_MS = 15_000;
const DISCOVERY_FRESH_MS = 30_000;
const DISCOVERY_PAGE_LIMIT = 100;
const MAX_DISCOVERY_SCAN = 500;
const MAX_DISCOVERY_PARSE = 200;
const MAX_HUMAN_RELATION_SCAN = 10_000;
const HUMAN_RELATION_PAGE_LIMIT = 500;
const PROFILE_TTL_MS = 30_000;
// Local manifest decoration hashes only a bounded set of small copies; larger
// copies stay honestly labelled unverified until an explicit read/reveal.
const MAX_MANIFEST_HASH_FILE = 8 * 1024 * 1024;
const MAX_MANIFEST_HASH_TOTAL = 48 * 1024 * 1024;
// Explicit preview/reveal must verify the complete requested version. The
// daemon publishes at most 100 MiB per file, so this covers a local original.
const MAX_LOCAL_COPY_HASH = 128 * 1024 * 1024;
const JOURNEY_TTL_MS = 15_000;
const MINE_TTL_MS = 15_000;
const MAX_MESSAGE_LOCATE_PAGES = 20;
const MESSAGE_LOCATE_LIMIT = 200;
// Contact memory reads one bounded latest page. Older facts stay in daemon
// history, but the interaction timeline never pretends to be complete.
const CONTACT_MEMORY_MESSAGE_LIMIT = 100;
const CONTACT_MEMORY_MAX_ITEMS = 200;

export interface UiConnection {
  peerId: string;
  direction: string;
  transport: string;
  route: string;
  direct: boolean;
  limited: boolean;
  remoteMultiaddr: string;
}

export interface UiPeer {
  peerId: string;
  online: boolean;
  direction: string;
  transport: string;
  route: string;
  addrs: string[];
}

export interface UiNodeStatus {
  peerId: string;
  nodeId: string;
  version: string;
  protocolVersion: string;
  apiVersion: string;
  startedAtUnixMs: string;
  currentTime: string;
  listenAddrs: string[];
  advertisedAddrs: string[];
  connections: UiConnection[];
  peers: UiPeer[];
  peerCache: UiCachedPeer[];
  relays: UiRelay[];
  maxChatTextBytes: number;
  maxStoredMessages: number;
}

export interface UiCachedPeer {
  peerId: string;
  addrs: string[];
  source: string;
  updatedAt: number;
  expiresAt: number;
}

export interface UiRelay {
  relayPeerId: string;
  relayAddr: string;
  status: string;
  reservationStatus: string;
  expiresAtUnixMs: number;
  relayedAddr: string;
  advertisedAddr: string;
}

export interface UiFriend {
  peerId: string;
  name: string;
  description: string;
  addrs: string[];
  manuallyConnected: boolean;
  firstSeenUnixMs: number;
  lastInteractionUnixMs: number;
  paused: boolean;
  relayCapable: boolean;
  dhtCapable: boolean;
  connection: 'connected' | 'disconnected' | 'unknown';
  connections: number;
  directConnections: number;
  relayConnections: number;
  /** Read-only unread count from the shared human cursor. */
  unreadCount: number;
}

export interface UiContacts {
  friends: UiFriend[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  /** Whether the accompanying Status can prove connected or not connected. */
  connectionFreshness: 'live' | 'unknown';
  statusAt: number | null;
  statusError: string | null;
  statusFreshness: UiFreshness;
  total: number;
}

export interface UiFriendEdit {
  friend: UiFriend;
  contacts: UiContacts;
}

export interface UiRetention {
  retainedMessages: number;
  oldestRetainedAt: number | null;
  maxStoredMessages: number;
}

export interface UiConversation {
  peerId: string;
  lastMessageId: string;
  direction: string;
  preview: string;
  lastAt: number;
  deliveryStatus: string;
  origin: string;
  messageCount: number;
  unreadCount: number;
  lastReadMessageId: string;
  lastReadAt: number;
}

export interface UiConversations {
  conversations: UiConversation[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  retention: UiRetention | null;
  totalUnread: number;
}

export interface UiFavorite {
  id: string;
  peerId: string;
  path: string;
  sha256: string;
  title: string;
  createdAt: number;
  available: boolean;
  /** The favorite points at this node's own public directory. */
  local: boolean;
}

export interface UiFavorites {
  favorites: UiFavorite[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  hasMore: boolean;
  nextBefore: string;
  total: number;
}

export interface UiPeerDiscoveries extends UiDiscoveries {
  peerId: string;
}

export interface UiMarkRead {
  peerId: string;
  lastReadMessageId: string;
  lastReadAt: number;
  unreadCount: number;
}

export interface UiContactEvidenceRefs {
  sessionIds: string[];
  eventIds: string[];
  messageIds: string[];
  contentPaths: string[];
  contentSha256: string[];
}

export interface UiContactMemoryItem {
  id: string;
  kind: 'message' | 'journey' | 'observation' | 'impression' | 'curiosity';
  at: number;
  summary: string;
  /** Full persisted text for messages, observations and Journey events. The
   * renderer decides how much to reveal; the summary is only a preview. */
  body?: string;
  source: string;
  /** Independently renderable provenance class; never inferred by the UI. */
  sourceKind?: 'message' | 'visit' | 'journeyEvent' | 'journeyReport' | 'publicClue';
  eventType?: string;
  /** Peer whose public list supplied a clue, if the Journey recorded one. */
  sourcePeerId?: string;
  /** Peer the clue is about; this never establishes a contact or a visit. */
  subjectPeerId?: string;
  /** Private contact-notes entries are local-only and must be labelled. */
  private: boolean;
  evidence: UiContactEvidenceRefs;
  direction: string;
  origin: string;
}

export interface UiContactMemory {
  peerId: string;
  state: 'available' | 'missing' | 'error';
  sha256: string;
  schemaVersion: number;
  contact: import('./local-data.js').ContactNote | null;
  timeline: UiContactMemoryItem[];
  timelineTruncated: boolean;
  error: string;
  at: number;
}

export interface UiContactImpressionSave {
  saved: boolean;
  conflict: boolean;
  sha256: string;
  savedAt: number;
  contact: import('./local-data.js').ContactNote | null;
  memory: UiContactMemory | null;
  error: string;
}

export interface UiMessage {
  messageId: string;
  peerId: string;
  direction: string;
  text: string;
  acked: boolean;
  createdAt: number;
  ackedAt: number | null;
  deliveryStatus: string;
  deliveryError: string;
  origin: string;
  deliveryUpdatedAt: number | null;
  clientRequestId: string;
}

export interface UiMessagePage {
  peerId: string;
  /** Newest first for a fresh page; the UI merges by stable message ID. */
  messages: UiMessage[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  hasMore: boolean;
  nextBefore: string;
  retention: UiRetention | null;
}

export interface UiSendResult {
  ok: boolean;
  /** True when no RPC result was received; the send may or may not be persisted. */
  unknown: boolean;
  invalid: boolean;
  peerId: string;
  requestId: string;
  messageId: string;
  replayed: boolean;
  acked: boolean;
  deliveryStatus: string;
  outboxStatus: string;
  error: string | null;
  detail: string | null;
  at: number;
}

export interface UiCancelResult {
  ok: boolean;
  messageId: string;
  status: string;
  error: string | null;
  at: number;
}

export interface UiConnectContactCheck {
  ok: boolean;
  found: boolean;
  error: string | null;
  at: number | null;
}

export interface UiConnectResult {
  ok: boolean;
  invalid: boolean;
  input: string;
  at: number;
  peerId: string | null;
  route: string;
  transport: string;
  direct: boolean;
  limited: boolean;
  reused: boolean;
  remoteMultiaddr: string;
  note: string;
  error: string | null;
  detail: string | null;
  contact: UiConnectContactCheck;
  status: { ok: boolean; at: number | null; error: string | null };
  contacts: UiContacts | null;
}

export interface UiShareAddress {
  multiaddr: string;
  kind: 'direct' | 'relay';
  scope: 'public' | 'private';
}

export interface UiShareInfo {
  ok: boolean;
  peerId: string | null;
  at: number | null;
  stale: boolean;
  error: string | null;
  addresses: UiShareAddress[];
}

export type UiContentState = 'available' | 'not-downloaded' | 'downloaded-unverified' | 'copy-missing' | 'hash-mismatch' | 'unreadable';

/** One post image after parsing post.json. `publicPath` is the exact manifest
 * path; the browser passes it back to the controlled file reader and never
 * receives a filesystem path. */
export interface UiPostImage {
  path: string;
  publicPath: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** Present when a manifest entry was checked while parsing post metadata. */
  manifestState: 'available' | 'missing' | 'mismatch' | 'unknown';
}

/** Parsed v2 post metadata used to paint card images without opening the post. */
export interface UiPostMeta {
  found: boolean;
  path: string;
  sha256: string;
  title: string;
  summary: string;
  tags: string[];
  publishedAt: string;
  authorKind: 'user' | 'agent' | 'unknown';
  authorName: string;
  images: UiPostImage[];
  error: string;
}

function postImagesFromPost(
  post: LocalPost,
  postPath: string,
  entries?: Array<{ path: string; sha256: string; sizeBytes: number }>,
): UiPostImage[] {
  const byPath = new Map((entries ?? []).map((entry) => [entry.path, entry]));
  return post.images.map((image) => {
    const publicPath = postImagePublicPath(postPath, image.path);
    const entry = entries === undefined ? undefined : byPath.get(publicPath);
    let manifestState: UiPostImage['manifestState'] = entries === undefined ? 'unknown' : 'missing';
    if (entry) {
      manifestState = entry.sha256.toLowerCase() === image.sha256 && entry.sizeBytes === image.sizeBytes
        ? 'available'
        : 'mismatch';
    }
    return {
      path: image.path,
      publicPath,
      sha256: image.sha256,
      mime: image.mime,
      width: image.width,
      height: image.height,
      sizeBytes: image.sizeBytes,
      manifestState,
    };
  });
}

export interface UiPublicFile {
  id: string;
  peerId: string;
  publisherName: string;
  path: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: number;
  fetchedAt: number;
  source: string;
  sources: string[];
  kind: PublicFileKind;
  mime: string;
  previewable: boolean;
  title: string;
  summary: string;
  tags: string[];
  publishedAt: string;
  authorKind: 'user' | 'agent' | 'unknown' | '';
  authorName: string;
  /** Validated v2 post images; empty for v1, non-post files and unparsed posts. */
  images: UiPostImage[];
  contentState: UiContentState;
  contentError: string;
}

export interface UiDiscoveryItem extends UiPublicFile {}

export interface UiDiscoveries {
  items: UiDiscoveryItem[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  familiar: boolean;
  /** Raw discovery rows inspected for this result. */
  scanned: number;
  /** True when the bounded scan did not cover the whole private index. */
  truncated: boolean;
  /** Only meaningful for familiar=true. */
  relationComplete: boolean;
  /** Fetched files that are not valid versioned public posts. */
  ignored: number;
}

export interface UiFilePreview extends FilePreview {
  ok: boolean;
  subject: 'discovery' | 'peer' | 'mine';
  peerId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  source: string;
  sources: string[];
  fetchedAt: number;
  /** Whether the exact requested version exists locally and was verified. */
  localCopy: UiContentState;
  /** local-copy: verified bytes already on disk; downloaded: this call fetched
   * the bytes from the peer; none: no local copy was read or written. */
  acquisition: 'local-copy' | 'downloaded' | 'none';
  discoveryRecorded: boolean;
  discoveryError: string;
}

export interface UiDiscoveryContent extends UiFilePreview {
  id: string;
  post: (LocalPost & { contentState: 'available' }) | null;
}

export interface UiHumanOutbound {
  peers: string[];
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  complete: boolean;
  scanned: number;
}

export interface UiMineProfile {
  state: 'available' | 'missing' | 'error';
  markdown: string;
  displayName: string;
  error: string;
  path: string;
  at: number | null;
}

export interface UiMinePosts {
  state: 'available' | 'missing' | 'error';
  posts: LocalPost[];
  error: string;
  unattributed: number;
  agentAuthored: number;
  invalid: number;
  errors: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

export interface UiMine {
  peerId: string;
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  profile: UiMineProfile;
  posts: UiMinePosts;
  /** Optional public Agent card; absent/missing never becomes a fake profile. */
  agentCard: UiPeerAgentCard;
  /** Canonical profile.json v2, or a missing/error state with legacy fields. */
  publicProfile: LocalPublicProfileRead;
  files: UiPublicFile[];
  filesTruncated: boolean;
}

export interface UiPublicDraftImage {
  assetId: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface UiPublicDraft {
  draftId: string;
  kind: 'profile' | 'post' | string;
  revision: number;
  agentName: string;
  agentDescription: string;
  agentInterests: string[];
  agentConversationStyle: string;
  humanName: string;
  humanBioMarkdown: string;
  avatar: UiPublicDraftImage | null;
  /** Linked human avatar; independent from the Agent avatar. */
  humanAvatar: UiPublicDraftImage | null;
  title: string;
  bodyMarkdown: string;
  tags: string[];
  images: UiPublicDraftImage[];
  publishedPath: string;
  publishedSha256: string;
  publishedRevision: number;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  authorKind: 'user' | 'agent' | string;
}

export interface UiPublicDraftAssetRead {
  image: UiPublicDraftImage;
  dataBase64: string;
}

export interface UiPublicDraftSave {
  draftId?: string;
  kind?: 'profile' | 'post';
  expectedRevision?: number;
  agentName?: string;
  agentDescription?: string;
  agentInterests?: string[];
  agentConversationStyle?: string;
  humanName?: string;
  humanBioMarkdown?: string;
  avatarAssetId?: string;
  clearAvatar?: boolean;
  /** Only sent when provided; omitting it preserves the saved human avatar. */
  humanAvatarAssetId?: string;
  /** Only sent when true; removes only the human avatar. */
  clearHumanAvatar?: boolean;
  title?: string;
  bodyMarkdown?: string;
  tags?: string[];
  imageAssetIds?: string[];
  authorKind?: 'user' | 'agent';
}

export interface UiPublishFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface UiPublishResult {
  status: 'published' | 'already_published' | 'conflict' | 'invalid' | 'partial' | 'unspecified';
  error: string;
  currentRevision: number;
  currentPublishedSha256: string;
  files: UiPublishFile[];
  manifestVersion: number;
  manifestGeneratedAtUnixMs: number;
  postPath: string;
  profilePath: string;
  warnings: string[];
  manifestSha256: string;
}

export type UiPrivateAgentSave =
  | PrivateAgentSave
  | { saved: false; conflict: true; error: string; sha256: string };

export interface UiPeerAgentCard {
  state: 'available' | 'missing' | 'error';
  card: LocalAgentCard | null;
  error: string;
}

export interface UiPeerFile extends UiPublicFile {}

export interface UiPeerManifest {
  peerId: string;
  publisherName: string;
  entries: UiPeerFile[];
  /** remote: a current manifest was read from the peer; local-history: the
   * peer was unreachable and this is a partial list rebuilt from verified
   * local acquisition evidence, never a claimed current full manifest. */
  source: 'remote' | 'local-history' | 'unavailable';
  at: number | null;
  error: string | null;
  errorAt: number | null;
  freshness: UiFreshness;
  truncated: boolean;
  total: number;
}

export interface UiPeerAddress {
  multiaddr: string;
  /**
   * connection: an address of the active connection in the retained Status.
   * peerstore: a libp2p peerstore/known address, not proof of a peer
   * announcement. cache/contact: local persisted hints. Only connection
   * addresses observed in a live Status read can be verified reachable.
   */
  source: 'connection' | 'peerstore' | 'cache' | 'contact' | 'dht';
  sourceDetail: string;
  reachability: 'verified' | 'reported' | 'unverified';
  observedAt: number | null;
}

export interface UiPeerNodeInfo {
  peerId: string;
  connectionState: 'connected' | 'disconnected' | 'unknown';
  directConnections: number;
  relayConnections: number;
  currentAddresses: UiPeerAddress[];
  knownAddresses: UiPeerAddress[];
  statusAt: number | null;
  freshness: UiFreshness;
  error: string | null;
}

export interface UiBootstrapPeer {
  peerId: string;
  addrs: string[];
  /** True only for a live connection; saved state never implies online. */
  online: boolean;
  /** Persistent explicit-disconnect state; adding/removing the role never changes it. */
  paused: boolean;
  savedAt: number | null;
}

export interface UiBootstrapInfo {
  at: number | null;
  /** Flat address list retained for copy/legacy hosts. */
  peers: string[];
  /** Saved roles with separate address, online and paused state. */
  entries: UiBootstrapPeer[];
  /** True when the daemon supports the write RPCs. */
  editable: boolean;
  /** True when an older daemon only supports the read-only DhtStatus view. */
  requiresUpgrade: boolean;
  error: string | null;
  freshness: UiFreshness;
  source: 'bootstrap-api' | 'dht-status' | 'unavailable';
}

export interface UiBootstrapEdit {
  ok: boolean;
  changed: boolean;
  error: string | null;
  requiresUpgrade: boolean;
}

export interface UiRevealResult {
  ok: boolean;
  status: 'revealed' | 'missing' | 'not-downloaded' | 'hash-mismatch' | 'unavailable' | 'error';
  error: string | null;
  at: number;
}

export interface UiPeerProfile {
  peerId: string;
  localName: string;
  remoteName: string;
  found: boolean;
  text: string;
  files: string[];
  /** remote: read from the peer in this call; local-copy: built only from
   * verified local downloads after the remote read failed. */
  source: 'remote' | 'local-copy' | 'unavailable';
  at: number | null;
  error: string | null;
  freshness: UiFreshness;
  agentCard: UiPeerAgentCard;
  manifest: UiPeerManifest;
  node: UiPeerNodeInfo;
  /** Linked human avatar reported by profile.json v2; empty when absent. */
  humanAvatarPath: string;
  humanAvatarSha256: string;
  humanAvatarMime: string;
}

export interface UiPeerFriendClaim {
  name: string;
  peerId: string;
  addrs: string[];
  description: string;
}

export interface UiPeerFriends {
  peerId: string;
  friends: UiPeerFriendClaim[];
  limited: boolean;
  /** remote: friends.json was read from the peer in this call. */
  source: 'remote' | 'unavailable';
  at: number | null;
  error: string | null;
}

export interface UiContactProjectionProfile {
  peerId: string;
  displayName: string;
  description: string;
  interests: string[];
  conversationStyle: string;
  source: string;
  verifiedAt: number;
  avatarKey: string;
  avatarUrl: string;
  avatarMime: string;
  avatarSha256: string;
  avatarSizeBytes: number;
  avatarState: 'none' | 'ready' | 'missing' | 'unreadable' | 'hash-mismatch' | 'skipped';
  avatarError: string;
}

export interface UiContactProjectionClue {
  peerId: string;
  name: string;
  description: string;
  sourcePeerId: string;
  sourceName: string;
  readAt: number;
}

/**
 * Local-only snapshot of public facts that previous explicit reads verified.
 * Reading it must not touch the daemon, dial, download, or read public/. The
 * browser receives no filesystem path and no persisted data/blob URL.
 */
export interface UiContactProjection {
  state: 'available' | 'missing' | 'error';
  profiles: UiContactProjectionProfile[];
  clues: UiContactProjectionClue[];
  at: number;
  error: string;
}

export interface UiJourney extends JourneyData {
  freshness: UiFreshness;
}

/** Safe, already-sanitized activity read for one panel. */
export interface UiActivity extends ActivityRead {}

/**
 * Journey information attached to one activity detail. This is a state-file
 * summary only: no report, events, persona or growth body crosses the bridge.
 */
export interface UiActivityJourney extends JourneySummary {
  exists: boolean;
}

export interface UiActivityDetail {
  operation: ActivityOperation | null;
  evidence: ActivityEvidence;
  journey: UiActivityJourney | null;
  missingReason: string;
}

export interface UiLocatedMessage {
  found: boolean;
  peerId: string;
  messageId: string;
  message: UiMessage | null;
  error: string | null;
  scanned: number;
  complete: boolean;
}

export interface UiEvent {
  id: string;
  kind: 'chat' | 'ack' | 'connection' | 'unknown';
  atUnixMs: number;
  summary: string;
  peerId?: string;
  messageId?: string;
  /** Inbound body for event-driven conversation reconciliation. */
  text?: string;
  accepted?: boolean;
  duplicate?: boolean;
  ackAccepted?: boolean;
  ackError?: string;
}

export interface UiStreamState {
  phase: EventStreamPhase;
  since: number;
  lastOpenAt: number | null;
  error: string | null;
}

export type UiFreshness = 'loading' | 'live' | 'stale' | 'unavailable';

export interface UiStats {
  openSessions: number;
  subscriptions: number;
  streamActive: boolean;
  streamPhase: EventStreamPhase;
  streamSince: number;
  streamStarts: number;
  streamStops: number;
  streamOpens: number;
  streamErrors: number;
  eventsSeen: number;
  eventsForwarded: number;
  sessionsOpened: number;
  sessionsClosed: number;
  lastEventAt: number | null;
  lastStatusAt: number | null;
  lastFriendsAt: number | null;
  statusReads: number;
  statusFailures: number;
  friendsReads: number;
  friendsFailures: number;
  conversationsReads: number;
  conversationsFailures: number;
  messagesReads: number;
  messagesFailures: number;
  sends: number;
  sendFailures: number;
  sendUnknowns: number;
  cancels: number;
  reconcileRuns: number;
  reconcileCoalesced: number;
  lastError: string | null;
}

export interface UiSnapshot {
  sessionId: string;
  status: UiNodeStatus | null;
  /** Wall-clock time of the last successful Status read, or null. */
  statusAt: number | null;
  /** Latest Status read error. A retained status keeps its own time. */
  error: string | null;
  errorAt: number | null;
  /** Host-computed freshness; the shared UI does not infer daemon semantics. */
  freshness: UiFreshness;
  stream: UiStreamState;
  events: UiEvent[];
  stats: UiStats;
}

interface PanelSession {
  id: string;
  openedAt: number;
  lastPollAt: number;
  statusAt: number;
  statusStreamEpoch: number;
  status: UiNodeStatus | null;
  errorAt: number;
  error: string | null;
  events: UiEvent[];
  friends: Friend[];
  friendsAt: number;
  friendsStreamEpoch: number;
  friendsError: string | null;
  friendsErrorAt: number;
  conversations: ConversationsState;
  messages: Map<string, MessagesState>;
  conversationsBusy: Promise<void> | null;
  messagesBusy: Map<string, Promise<void>>;
  discoveries: Map<string, DiscoveriesState>;
  discoveryBusy: Map<string, Promise<void>>;
  humanOutbound: HumanOutboundState;
  humanOutboundBusy: Promise<void> | null;
  mine: MineState;
  mineBusy: Promise<void> | null;
  peerProfiles: Map<string, PeerProfileState>;
  peerProfileBusy: Map<string, Promise<void>>;
  peerManifests: Map<string, PeerManifestState>;
  peerManifestBusy: Map<string, Promise<void>>;
  journey: JourneyState;
  journeyBusy: Promise<void> | null;
}

interface DiscoveriesState {
  items: UiDiscoveryItem[];
  at: number;
  error: string | null;
  errorAt: number;
  streamEpoch: number;
  familiar: boolean;
  scanned: number;
  truncated: boolean;
  relationComplete: boolean;
  ignored: number;
}

interface HumanOutboundState {
  peers: string[];
  at: number;
  error: string | null;
  errorAt: number;
  streamEpoch: number;
  complete: boolean;
  scanned: number;
}

interface MineState {
  data: UiMine | null;
  at: number;
  errorAt: number;
}

interface PeerProfileState {
  data: UiPeerProfile;
  at: number;
}

interface PeerManifestState {
  data: UiPeerManifest;
  at: number;
}

interface DiscoveryEvidenceRow {
  id: string;
  peerId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  fetchedAt: number;
  source: string;
  sources: string[];
}

interface JourneyState {
  data: UiJourney | null;
  at: number;
  errorAt: number;
}

interface ConversationsState {
  items: UiConversation[];
  at: number;
  error: string | null;
  errorAt: number;
  streamEpoch: number;
  retention: UiRetention | null;
  totalUnread: number;
}

interface MessagesState {
  items: UiMessage[];
  at: number;
  error: string | null;
  errorAt: number;
  streamEpoch: number;
  hasMore: boolean;
  nextBefore: string;
  retention: UiRetention | null;
}

type StatusResult =
  | { ok: true; status: UiNodeStatus; at: number; streamEpoch: number }
  | { ok: false; error: string; at: number };

type FriendsResult =
  | { ok: true; friends: Friend[]; at: number; streamEpoch: number }
  | { ok: false; error: string; at: number };

type UiService = {
  open(sessionId: string): Promise<UiSnapshot>;
  poll(sessionId: string): Promise<UiSnapshot>;
  refresh(sessionId: string): Promise<UiSnapshot>;
  close(sessionId: string): Promise<UiStats>;
  contacts(sessionId: string, force?: boolean): Promise<UiContacts>;
  setFriendName(sessionId: string, peerId: string, name: string): Promise<UiFriendEdit>;
  setFriendDescription(sessionId: string, peerId: string, description: string): Promise<UiFriendEdit>;
  connect(sessionId: string, input: string): Promise<UiConnectResult>;
  checkContact(sessionId: string, peerId: string): Promise<UiConnectResult['contact'] & { contacts: UiContacts | null }>;
  share(sessionId: string): Promise<UiShareInfo>;
  conversations(sessionId: string, force?: boolean): Promise<UiConversations>;
  messages(sessionId: string, peerId: string, before?: string, force?: boolean): Promise<UiMessagePage>;
  markRead(sessionId: string, peerId: string, throughMessageId: string): Promise<UiMarkRead>;
  favorites(sessionId: string, before?: string, force?: boolean): Promise<UiFavorites>;
  setFavorite(sessionId: string, peerId: string, publicPath: string, sha256: string, title: string, favorite: boolean): Promise<{ favorite: boolean; item: UiFavorite | null }>;
  peerDiscoveries(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerDiscoveries>;
  contactMemory(sessionId: string, peerId: string): Promise<UiContactMemory>;
  saveContactImpression(sessionId: string, input: ContactImpressionSaveInput): Promise<UiContactImpressionSave>;
  send(sessionId: string, peerId: string, text: string, requestId: string): Promise<UiSendResult>;
  cancelOutbox(sessionId: string, messageId: string): Promise<UiCancelResult>;
  discoveries(sessionId: string, familiar?: boolean, force?: boolean): Promise<UiDiscoveries>;
  discoveryContent(sessionId: string, id: string): Promise<UiDiscoveryContent>;
  humanOutbound(sessionId: string, force?: boolean): Promise<UiHumanOutbound>;
  mine(sessionId: string, force?: boolean): Promise<UiMine>;
  mineFilePreview(sessionId: string, filePath: string, expectedSha: string, expectedSize: number): Promise<UiFilePreview>;
  peerProfile(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerProfile>;
  peerFriends(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerFriends>;
  contactProjection(sessionId: string): Promise<UiContactProjection>;
  peerManifest(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerManifest>;
  peerFilePreview(sessionId: string, peerId: string, filePath: string, expectedSha: string, expectedSize: number): Promise<UiFilePreview>;
  peerPostMeta(sessionId: string, peerId: string, filePath: string, expectedSha: string, expectedSize: number): Promise<UiPostMeta>;
  peerNodeInfo(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerNodeInfo>;
  revealDiscovery(sessionId: string, id: string): Promise<UiRevealResult>;
  revealFile(sessionId: string, subject: 'discovery' | 'peer' | 'mine', peerId: string, filePath: string, expectedSha: string, expectedSize: number): Promise<UiRevealResult>;
  bootstrap(sessionId: string): Promise<UiBootstrapInfo>;
  addBootstrap(sessionId: string, multiaddr: string): Promise<UiBootstrapEdit>;
  removeBootstrap(sessionId: string, peerId: string): Promise<UiBootstrapEdit>;
  journey(sessionId: string, force?: boolean): Promise<UiJourney>;
  activity(sessionId: string, limit?: number): Promise<UiActivity>;
  activityDetail(operationId: string): Promise<UiActivityDetail>;
  savePrivateAgent(sessionId: string, field: 'persona' | 'growth', content: string, expectedSha256: string): Promise<UiPrivateAgentSave>;
  publicDraft(sessionId: string, draftId: string): Promise<{ found: boolean; draft: UiPublicDraft | null; error?: string }>;
  publicDrafts(sessionId: string, kind: string): Promise<{ drafts: UiPublicDraft[]; hasMore: boolean; nextBefore: string }>;
  savePublicDraft(sessionId: string, input: UiPublicDraftSave): Promise<{ draft: UiPublicDraft }>;
  putPublicDraftImage(sessionId: string, draftId: string, role: string, filename: string, dataBase64: string): Promise<{ image: UiPublicDraftImage }>;
  publicDraftAsset(sessionId: string, draftId: string, assetId: string): Promise<UiPublicDraftAssetRead>;
  importPublicPost(sessionId: string, publicPath: string): Promise<{ draft: UiPublicDraft }>;
  deletePublicDraft(sessionId: string, draftId: string, expectedRevision: number): Promise<{ deleted: boolean }>;
  publishPublicDraft(sessionId: string, draftId: string, expectedRevision: number, expectedPublishedSha256: string): Promise<UiPublishResult>;
  locateMessage(sessionId: string, peerId: string, messageId: string): Promise<UiLocatedMessage>;
  /** Local-only counters; not part of the Remote manifest. */
  getStats(): UiStats;
  readonly typertRemote: { service: UiService; serviceKey: string; namespace: string };
};

export interface UiBridgeOptions {
  /** Actual control root; only the host adapter reads files from it. */
  dataDir?: string;
  /** Test seams; production uses wall clock and the real Events subscriber. */
  now?: () => number;
  statusTtlMs?: number;
  statusFreshMs?: number;
  contactsTtlMs?: number;
  contactsFreshMs?: number;
  conversationsTtlMs?: number;
  conversationsFreshMs?: number;
  messagesTtlMs?: number;
  messagesFreshMs?: number;
  connectTimeoutMs?: number;
  reconcileDelayMs?: number;
  streamReadyTimeoutMs?: number;
  subscribe?: typeof subscribeEvents;
  subscribeOptions?: SubscribeEventsOptions;
  /** Narrow Host capability used only for a discovery's downloaded original.
   * The browser never supplies a path and never receives the resolved one. */
  revealPath?: (absolutePath: string) => Promise<void> | void;
  /** Same private store the tool execute wrapper writes to. Reads are passive. */
  activity?: AgentActivityStore | null;
}


/**
 * Return a usable address for the target peer, or '' when the address cannot
 * be proven to belong to it. Multiaddr components matter: a relay address
 * ends with /p2p/<relay>/p2p-circuit and still needs the target peer appended,
 * while a conflicting trailing /p2p/<other> must never be presented as the
 * requested target's address.
 */
function withPeerSuffix(raw: string, peerId: string): string {
  const value = String(raw ?? '').trim();
  if (value.length === 0 || peerId.length === 0) return '';
  let parsed;
  try {
    parsed = multiaddr(value);
  } catch {
    return '';
  }
  const components = parsed.getComponents();
  const circuitIndex = components.findIndex((component) => component.name === 'p2p-circuit');
  const peerIndexes = components
    .map((component, index) => ({ component, index }))
    .filter((entry) => entry.component.name === 'p2p');
  const targetPeer = (component: { value?: unknown }): string => {
    const rawValue = component.value;
    return typeof rawValue === 'string' ? (canonicalPeerId(rawValue) ?? '') : '';
  };
  if (circuitIndex >= 0) {
    const after = peerIndexes.filter((entry) => entry.index > circuitIndex);
    if (after.length > 1) return '';
    if (after.length === 1) {
      const entry = after[0];
      if (entry.index !== components.length - 1) return '';
      return targetPeer(entry.component) === peerId ? parsed.toString() : '';
    }
    // The relay's own /p2p component precedes p2p-circuit. Any other
    // component after the circuit is not a target peer, so refuse to append.
    if (circuitIndex !== components.length - 1) return '';
    try {
      return parsed.encapsulate(multiaddr(`/p2p/${peerId}`)).toString();
    } catch {
      return '';
    }
  }
  const after = peerIndexes;
  if (after.length > 1) return '';
  if (after.length === 1) {
    const entry = after[0];
    if (entry.index !== components.length - 1) return '';
    return targetPeer(entry.component) === peerId ? parsed.toString() : '';
  }
  try {
    return parsed.encapsulate(multiaddr(`/p2p/${peerId}`)).toString();
  } catch {
    return '';
  }
}

function shortPeer(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function validSha256(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

/** Accept only the daemon's content-addressed human-avatar shape. Invalid or
 * partial triples are reported as absent so the browser never gets a path
 * that cannot be explained by the published profile. */
function peerHumanAvatar(profile: {
  humanAvatarPath?: string;
  humanAvatarSha256?: string;
  humanAvatarMime?: string;
} | null | undefined): { path: string; sha256: string; mime: string } {
  const empty = { path: '', sha256: '', mime: '' };
  if (!profile) return empty;
  const avatarPath = String(profile.humanAvatarPath ?? '');
  const sha256 = validSha256(profile.humanAvatarSha256);
  const avatarMime = profile.humanAvatarMime === 'image/png' || profile.humanAvatarMime === 'image/jpeg' ? profile.humanAvatarMime : '';
  if (avatarPath === '' && sha256 === '' && avatarMime === '') return empty;
  if (!/^profile\/human-avatar-[a-f0-9]{8}\.(?:png|jpg)$/.test(avatarPath)) return empty;
  if (sha256 === '' || avatarMime === '') return empty;
  if ((avatarMime === 'image/png') !== avatarPath.endsWith('.png')) return empty;
  if (avatarPath !== `profile/human-avatar-${sha256.slice(0, 8)}${avatarPath.endsWith('.png') ? '.png' : '.jpg'}`) return empty;
  return { path: avatarPath, sha256, mime: avatarMime };
}

function plainTextSummary(value: string): string {
  const text = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*_`[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function draftImageFromProto(raw: ProtoPublicDraftImage | undefined): UiPublicDraftImage | null {
  if (raw === undefined) return null;
  return {
    assetId: String(raw.assetId ?? ''),
    sha256: String(raw.sha256 ?? '').toLowerCase(),
    mime: String(raw.mime ?? ''),
    width: numberOf(raw.width),
    height: numberOf(raw.height),
    sizeBytes: numberOf(raw.sizeBytes),
  };
}

function draftFromProto(raw: ProtoPublicDraft): UiPublicDraft {
  return {
    draftId: String(raw.draftId ?? ''),
    kind: String(raw.kind ?? ''),
    revision: numberOf(raw.revision),
    agentName: String(raw.agentName ?? ''),
    agentDescription: String(raw.agentDescription ?? ''),
    agentInterests: (raw.agentInterests ?? []).map((value) => String(value)),
    agentConversationStyle: String(raw.agentConversationStyle ?? ''),
    humanName: String(raw.humanName ?? ''),
    humanBioMarkdown: String(raw.humanBioMarkdown ?? ''),
    avatar: draftImageFromProto(raw.avatar),
    humanAvatar: draftImageFromProto(raw.humanAvatar),
    title: String(raw.title ?? ''),
    bodyMarkdown: String(raw.bodyMarkdown ?? ''),
    tags: (raw.tags ?? []).map((value) => String(value)),
    images: (raw.images ?? []).map((value) => draftImageFromProto(value)).filter((value): value is UiPublicDraftImage => value !== null),
    publishedPath: String(raw.publishedPath ?? ''),
    publishedSha256: String(raw.publishedSha256 ?? '').toLowerCase(),
    publishedRevision: numberOf(raw.publishedRevision),
    createdAtUnixMs: numberOf(raw.createdAtUnixMs),
    updatedAtUnixMs: numberOf(raw.updatedAtUnixMs),
    authorKind: String(raw.authorKind ?? ''),
  };
}

function publishStatusFromProto(value: PublicPublishStatus): UiPublishResult['status'] {
  switch (value) {
    case PublicPublishStatus.PUBLISHED: return 'published';
    case PublicPublishStatus.ALREADY_PUBLISHED: return 'already_published';
    case PublicPublishStatus.CONFLICT: return 'conflict';
    case PublicPublishStatus.INVALID: return 'invalid';
    case PublicPublishStatus.PARTIAL: return 'partial';
    default: return 'unspecified';
  }
}

function parsePostBytes(data: Buffer, postPath: string, peerId: string): LocalPost {
  return parsePublicPost(data, postPath, peerId);
}

function previewStatusForError(message: string): 'copy-missing' | 'hash-mismatch' | 'unsupported' | 'error' {
  if (/大小|哈希/.test(message)) return 'hash-mismatch';
  if (/不存在/.test(message)) return 'copy-missing';
  if (/超过.*上限|too large/i.test(message)) return 'unsupported';
  return 'error';
}

function maxPreviewRead(kind: PublicFileKind): number {
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'code':
    case 'json':
      return 2 * 1024 * 1024;
    case 'html':
      return MAX_HTML_SOURCE;
    case 'zip':
      return MAX_ZIP_ARCHIVE;
    case 'image':
    case 'audio':
    case 'video':
      return MAX_MEDIA_PREVIEW;
    default:
      return 1;
  }
}

/** P2 only publishes PNG/JPEG post images. Verify the bytes actually match the
 * content-addressed extension before the browser receives a data URL. */
function postImageBytesError(filePath: string, data: Buffer): string {
  if (!isPostImagePublicPath(filePath)) return '';
  const png = data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const expected = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  if ((expected === 'image/png' && !png) || (expected === 'image/jpeg' && !jpeg)) {
    return `图片字节与 ${filePath} 的 ${expected} 类型不一致，已拒绝展示`;
  }
  return '';
}

function emptyEvidenceRefs(): UiContactEvidenceRefs {
  return { sessionIds: [], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] };
}

function redactActivityReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/(?:Users|home|root|private|var|tmp|etc|opt|Volumes)\/[^\s"')]+/g, '[本地路径已隐去]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径已隐去]')
    .slice(0, 240);
}

/** Remove transport/internal code decorations from a local validation error. */
function bootstrapErrorMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/^Raminga RPC failed \([^)]*\):\s*/i, '')
    .replace(/^Invalid argument:\s*/i, '')
    .replace(/^\[[a-z_]+\]\s*/i, '')
    .trim();
}

function isUnimplementedError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('unimplemented') || message.includes('unknown method') || message.includes('not implemented');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether profile/index.md contains real human-authored public content.
 * The daemon always writes an index.md; when both v2 human fields are empty it
 * contains only the default "# 关联人类" heading. That file is public, but it
 * must not be presented as a completed human profile. Legacy profiles with a
 * different heading, a body, or a saved human name keep working. An explicit
 * v2 human name (even the literal default label) or human avatar is real data;
 * only a profile without any v2 human field relies on the heading heuristic.
 */
function hasExplicitPublicHumanProfile(publicProfile: LocalPublicProfile): boolean {
  return publicProfile.humanName.trim().length > 0
    || publicProfile.humanBioMarkdown.trim().length > 0
    || publicProfile.humanAvatarPath.trim().length > 0;
}

function hasPublicHumanContent(profile: LocalOwnProfile, publicProfile: LocalPublicProfile): boolean {
  if (hasExplicitPublicHumanProfile(publicProfile)) return true;
  if (profile.state !== 'available') return false;
  const lines = profile.markdown.split(/\r?\n/).map((line) => line.trim());
  const headingLine = lines.find((line) => line.length > 0) ?? '';
  const heading = headingLine.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  const body = lines
    .filter((line) => line.length > 0 && line !== headingLine)
    .join('\n')
    .trim();
  if (body.length > 0) return true;
  return heading.length > 0 && heading !== '关联人类';
}

function uncertaintyLabel(value: string): string {
  return value === 'low' ? '低' : value === 'medium' ? '中' : value === 'high' ? '高' : '';
}

function atOf(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function numberOf(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function canonicalPeerId(value: string): string | null {
  try {
    return peerIdFromString(value).toString();
  } catch {
    return null;
  }
}

export interface ParsedConnectInput {
  peerId: string;
  multiaddr: string;
  kind: 'peer' | 'address';
}

export type ConnectInputParse =
  | ({ ok: true } & ParsedConnectInput)
  | { ok: false; message: string; detail: string | null };

/**
 * Validate either a bare Peer ID or a complete multiaddr using the maintained
 * multiformats/libp2p parsers. We do not hand-roll base58 or multiaddr framing.
 */
export function parseConnectInput(raw: unknown): ConnectInputParse {
  if (typeof raw !== 'string') {
    return { ok: false, message: '请输入 Peer ID 或完整节点地址。', detail: null };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: '请输入 Peer ID 或完整节点地址。', detail: null };
  }
  if (value.length > 1024) {
    return { ok: false, message: '输入太长了，请只填写 Peer ID 或一个节点地址。', detail: null };
  }
  if (value.includes('/')) {
    if (!value.startsWith('/')) {
      return { ok: false, message: '完整节点地址需要以 / 开头。', detail: null };
    }
    let parsed;
    try {
      parsed = multiaddr(value);
    } catch (error) {
      return { ok: false, message: '完整节点地址格式不正确。', detail: errorMessage(error) };
    }
    const components = parsed.getComponents();
    const transports = new Set(['tcp', 'udp', 'quic', 'quic-v1', 'ws', 'wss', 'webrtc', 'webtransport', 'webtransport-cert']);
    const hasTransport = components.some((component) => transports.has(component.name));
    const hasCircuit = components.some((component) => component.name === 'p2p-circuit');
    if (!hasTransport && !hasCircuit) {
      return { ok: false, message: '地址还缺少传输方式，请检查后重试。', detail: null };
    }
    if (hasCircuit && components[components.length - 1].name !== 'p2p') {
      return { ok: false, message: '中继地址缺少目标节点的 /p2p/ 标识。', detail: null };
    }
    const peers = components.filter((component) => component.name === 'p2p');
    if (peers.length === 0) {
      return { ok: false, message: '完整地址需要包含目标节点的 /p2p/ 标识。', detail: null };
    }
    const target = peers[peers.length - 1].value;
    const canonical = typeof target === 'string' ? canonicalPeerId(target) : null;
    if (canonical === null) {
      return { ok: false, message: '地址中的 Peer ID 无效。', detail: null };
    }
    return { ok: true, peerId: canonical, multiaddr: parsed.toString(), kind: 'address' };
  }
  const canonical = canonicalPeerId(value);
  if (canonical === null) {
    return { ok: false, message: 'Peer ID 格式不正确，请检查后重试。', detail: null };
  }
  return { ok: true, peerId: canonical, multiaddr: '', kind: 'peer' };
}

function isUnusableIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split('.').map((part) => Number(part));
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] >= 224) return true;
    if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
    return false;
  }
  if (version === 6) {
    const lower = value.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isUnusableIp(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (/^ff/.test(lower)) return true;
    return false;
  }
  return false;
}

function isPrivateIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split('.').map((part) => Number(part));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (version === 6) {
    const lower = value.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return false;
  }
  return false;
}

function addressPeerId(parsed: ReturnType<typeof multiaddr>): string | null {
  const peers = parsed.getComponents().filter((component) => component.name === 'p2p');
  if (peers.length === 0) return null;
  const value = peers[peers.length - 1].value;
  return typeof value === 'string' ? canonicalPeerId(value) : null;
}

/**
 * Build share addresses from advertised direct addresses and active relay
 * reservations only. listen_addrs are intentionally never used as public
 * addresses. Loopback, unspecified and multicast addresses are dropped.
 */
export function buildShareAddresses(status: UiNodeStatus, now = Date.now()): UiShareAddress[] {
  const peerId = canonicalPeerId(status.peerId);
  if (peerId === null) return [];
  const result: UiShareAddress[] = [];
  const seen = new Set<string>();

  const add = (raw: string, kind: 'direct' | 'relay') => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return;
    let parsed;
    try {
      parsed = multiaddr(raw.trim());
    } catch {
      return;
    }
    const components = parsed.getComponents();
    const circuit = components.some((component) => component.name === 'p2p-circuit');
    const peers = components.filter((component) => component.name === 'p2p');
    if (peers.length > 0) {
      if (addressPeerId(parsed) !== peerId) return;
    } else {
      if (circuit) return;
      try {
        parsed = parsed.encapsulate(`/p2p/${peerId}`);
      } catch {
        return;
      }
    }
    const ip = parsed.getComponents().find((component) => component.name === 'ip4' || component.name === 'ip6');
    if (ip && typeof ip.value === 'string' && isUnusableIp(ip.value)) return;
    const dns = parsed.getComponents().find((component) => component.name === 'dns' || component.name === 'dns4' || component.name === 'dns6' || component.name === 'dnsaddr');
    if (dns && typeof dns.value === 'string' && /(^|\.)localhost$/i.test(dns.value)) return;
    const normalized = parsed.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push({
      multiaddr: normalized,
      kind: circuit ? 'relay' : kind,
      scope: ip && typeof ip.value === 'string' && isPrivateIp(ip.value) ? 'private' : 'public',
    });
  };

  for (const address of status.advertisedAddrs) add(address, 'direct');
  for (const relay of status.relays) {
    if (relay.reservationStatus !== 'active') continue;
    const expires = Number(relay.expiresAtUnixMs);
    if (expires > 0 && expires <= now) continue;
    const relayed = relay.relayedAddr || relay.advertisedAddr;
    if (relayed.length > 0) add(relayed, 'relay');
  }
  return result;
}

function toUiFriend(friend: Friend, status: UiNodeStatus | null, connectionFresh: boolean): UiFriend {
  const peerId = friend.peerId;
  const links = status && connectionFresh
    ? status.connections.filter((connection) => connection.peerId === peerId)
    : [];
  const onlinePeer = status && connectionFresh
    ? status.peers.some((peer) => peer.peerId === peerId && peer.online)
    : false;
  const connected = links.length > 0 || onlinePeer;
  return {
    peerId,
    name: friend.name,
    description: friend.description,
    addrs: [...friend.addrs],
    manuallyConnected: friend.manuallyConnected,
    firstSeenUnixMs: numberOf(friend.firstSeenUnixMs),
    lastInteractionUnixMs: numberOf(friend.lastInteractionUnixMs),
    paused: friend.paused,
    relayCapable: friend.relayCapable,
    dhtCapable: friend.dhtCapable,
    connection: connectionFresh ? (connected ? 'connected' : 'disconnected') : 'unknown',
    connections: links.length,
    directConnections: links.filter((connection) => connection.route === 'direct').length,
    relayConnections: links.filter((connection) => connection.route === 'relay').length,
    unreadCount: numberOf(friend.unreadCount),
  };
}

function toUiStatus(status: StatusResponse): UiNodeStatus {
  return {
    peerId: status.peerId,
    nodeId: status.nodeId,
    version: status.version,
    protocolVersion: status.protocolVersion,
    apiVersion: status.apiVersion,
    startedAtUnixMs: String(status.startedAtUnixMs),
    currentTime: status.currentTime,
    listenAddrs: [...status.listenAddrs],
    advertisedAddrs: [...(status.advertisedAddrs ?? [])],
    connections: status.connections.map((connection) => ({
      peerId: connection.peerId,
      direction: connection.direction,
      transport: connection.transport,
      route: connection.route,
      direct: connection.direct,
      limited: connection.limited,
      remoteMultiaddr: connection.remoteMultiaddr,
    })),
    peers: status.peers.map((peer) => ({
      peerId: peer.peerId,
      online: peer.online,
      direction: peer.direction,
      transport: peer.transport,
      route: peer.route,
      addrs: [...peer.addrs],
    })),
    peerCache: (status.network?.peerCache ?? []).map((peer) => ({
      peerId: peer.peerId,
      addrs: [...peer.addrs],
      source: peer.source,
      updatedAt: numberOf(peer.updatedAtUnixMs),
      expiresAt: numberOf(peer.expiresAtUnixMs),
    })),
    relays: (status.network?.relays ?? []).map((relay) => ({
      relayPeerId: relay.relayPeerId,
      relayAddr: relay.relayAddr,
      status: relay.status,
      reservationStatus: relay.reservationStatus,
      expiresAtUnixMs: numberOf(relay.expiresAtUnixMs),
      relayedAddr: relay.relayedAddr,
      advertisedAddr: relay.advertisedAddr,
    })),
    maxChatTextBytes: numberOf(status.maxChatTextBytes) || 4096,
    maxStoredMessages: numberOf(status.maxStoredMessages),
  };
}

function toUiMessage(row: {
  messageId?: string;
  peerId?: string;
  direction?: string;
  text?: string;
  acked?: boolean;
  createdAtUnixMs?: bigint | number;
  ackedAtUnixMs?: bigint | number;
  deliveryStatus?: string;
  deliveryError?: string;
  origin?: string;
  deliveryUpdatedAtUnixMs?: bigint | number;
  clientRequestId?: string;
}): UiMessage {
  const ackedAt = numberOf(row.ackedAtUnixMs);
  const deliveryUpdated = numberOf(row.deliveryUpdatedAtUnixMs);
  return {
    messageId: String(row.messageId ?? ''),
    peerId: String(row.peerId ?? ''),
    direction: String(row.direction ?? ''),
    text: String(row.text ?? ''),
    acked: row.acked === true,
    createdAt: numberOf(row.createdAtUnixMs),
    ackedAt: ackedAt > 0 ? ackedAt : null,
    deliveryStatus: String(row.deliveryStatus ?? (row.acked ? 'acked' : 'unknown')),
    deliveryError: String(row.deliveryError ?? ''),
    origin: String(row.origin ?? 'unknown'),
    deliveryUpdatedAt: deliveryUpdated > 0 ? deliveryUpdated : null,
    clientRequestId: String(row.clientRequestId ?? ''),
  };
}

function toUiRetention(row: {
  retainedMessages?: number;
  oldestRetainedAtUnixMs?: bigint | number;
  maxStoredMessages?: number;
} | undefined | null): UiRetention | null {
  if (!row) return null;
  const oldest = numberOf(row.oldestRetainedAtUnixMs);
  return {
    retainedMessages: numberOf(row.retainedMessages),
    oldestRetainedAt: oldest > 0 ? oldest : null,
    maxStoredMessages: numberOf(row.maxStoredMessages),
  };
}

/**
 * Map one daemon EventsResponse (already JSON-shaped by toJson) without
 * exposing chat bodies. The panel is a status/feedback surface, not a second
 * chat inbox.
 */
export function mapDaemonEvent(raw: Record<string, unknown>): UiEvent {
  const atUnixMs = atOf(raw.atUnixMs);
  const id = `${atUnixMs}-${randomUUID().slice(0, 8)}`;
  const chat = raw.chatReceived as Record<string, unknown> | undefined;
  if (chat && typeof chat === 'object') {
    const peerId = String(chat.fromPeerId ?? '');
    const flags = [chat.duplicate === true ? '重复' : '', chat.accepted === false ? '未接受' : ''].filter(Boolean).join(' · ');
    return {
      id,
      kind: 'chat',
      atUnixMs,
      peerId,
      messageId: String(chat.messageId ?? ''),
      text: String(chat.text ?? ''),
      accepted: chat.accepted !== false,
      duplicate: chat.duplicate === true,
      summary: `收到消息 · ${shortPeer(peerId)}${flags ? ` · ${flags}` : ''}`,
    };
  }
  const ack = raw.ack as Record<string, unknown> | undefined;
  if (ack && typeof ack === 'object') {
    const peerId = String(ack.peerId ?? '');
    return {
      id,
      kind: 'ack',
      atUnixMs,
      peerId,
      messageId: String(ack.messageId ?? ''),
      ackAccepted: ack.accepted !== false,
      ackError: String(ack.error ?? ''),
      summary: `投递确认 · ${shortPeer(peerId)}${ack.accepted === false ? ' · 未接受' : ''}`,
    };
  }
  const connection = raw.connection as Record<string, unknown> | undefined;
  if (connection && typeof connection === 'object') {
    const peerId = String(connection.peerId ?? '');
    const parts = [connection.direction, connection.transport, connection.route].filter((part) => typeof part === 'string' && part.length > 0);
    // Deliberately say "changed", not "Peer offline": one link closing does not
    // prove a Peer with another direct or relayed connection is gone.
    return {
      id,
      kind: 'connection',
      atUnixMs,
      peerId,
      summary: `连接变更 · ${shortPeer(peerId)}${parts.length > 0 ? ` · ${parts.join(' / ')}` : ''}`,
    };
  }
  return { id, kind: 'unknown', atUnixMs, summary: '未识别的 daemon 事件' };
}

function contactJourneySource(event: JourneyEvent): {
  sourceKind: 'visit' | 'journeyEvent' | 'publicClue';
  source: string;
} {
  const type = String(event.type ?? '').toLowerCase();
  if (type === 'visit_completed') return { sourceKind: 'visit', source: '实际访问 · Journey 记录' };
  if (type === 'visit_started') return { sourceKind: 'visit', source: '访问开始 · Journey 记录' };
  if (type === 'content_read') return { sourceKind: 'visit', source: '读取公开内容 · Journey 记录' };
  if (type === 'message_sent' || type === 'message_received') {
    return { sourceKind: 'journeyEvent', source: 'Journey 记录 · 消息动作（不是聊天正文）' };
  }
  if (type === 'reply_timeout') return { sourceKind: 'journeyEvent', source: 'Journey 记录 · 回复等待记录' };
  if (type === 'candidate_selected' || type === 'candidates_presented' || type === 'peer_skipped') {
    return event.sourcePeerId
      ? { sourceKind: 'publicClue', source: '公开线索 · 来源节点公开通讯录中的声明（未自动访问或联系）' }
      : { sourceKind: 'journeyEvent', source: 'Journey 记录 · 线索选择（未自动建立联系）' };
  }
  return { sourceKind: 'journeyEvent', source: 'Journey 记录' };
}

/** Pull one human-readable line from a Journey report without copying it. */
function journeyReportLine(markdown: string): string {
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const plain = trimmed
      .replace(/^[-*]\s*/, '')
      .replace(/[*_`>#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length < 4) continue;
    if (/^(session id|started at|completed at|status|user intent)\b/i.test(plain)) continue;
    return plain.slice(0, 240);
  }
  return '';
}

export class RamingaUiBridge {
  readonly service: UiService;
  private readonly sessions = new Map<string, PanelSession>();
  private readonly closedSessions = new Map<string, number>();
  private readonly reaper: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly statusTtlMs: number;
  private readonly statusFreshMs: number;
  private readonly contactsTtlMs: number;
  private readonly contactsFreshMs: number;
  private readonly conversationsTtlMs: number;
  private readonly conversationsFreshMs: number;
  private readonly messagesTtlMs: number;
  private readonly messagesFreshMs: number;
  private readonly dataDir: string;
  private readonly publisherNameCache = new Map<string, { at: number; name: string }>();
  // Serialize host-owned projection updates so two profile/directory reads
  // cannot lose each other's entries. The file itself is written atomically.
  private contactProjectionQueue: Promise<void> = Promise.resolve();
  private readonly revealPath?: (absolutePath: string) => Promise<void> | void;
  private readonly activityStore: AgentActivityStore | null;
  private readonly connectTimeoutMs: number;
  private readonly reconcileDelayMs: number;
  private readonly streamReadyTimeoutMs: number;
  private readonly subscribe: typeof subscribeEvents;
  private readonly subscribeOptions: SubscribeEventsOptions;
  private stopEvents: (() => void) | null = null;
  private ready: Promise<unknown> | null = null;
  private streamReady: Promise<void> | null = null;
  private resolveStreamReady: (() => void) | null = null;
  private eventPhase: EventStreamPhase = 'closed';
  private streamSince: number;
  private streamError: string | null = null;
  private lastStreamOpenAt: number | null = null;
  // Incremented on every stream open. A Status read that began under an older
  // stream epoch cannot make the snapshot live after a reconnect.
  private streamEpoch = 0;
  private statusRefresh: { generation: number; promise: Promise<void> } | null = null;
  private statusRefreshDirty = false;
  private friendsRefresh: { generation: number; promise: Promise<void> } | null = null;
  // Bumped whenever the last panel lease goes away. A read started for an
  // older lease generation must not populate a lease opened afterwards.
  private generation = 0;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly stats: UiStats = {
    openSessions: 0,
    subscriptions: 0,
    streamActive: false,
    streamPhase: 'closed',
    streamSince: 0,
    streamStarts: 0,
    streamStops: 0,
    streamOpens: 0,
    streamErrors: 0,
    eventsSeen: 0,
    eventsForwarded: 0,
    sessionsOpened: 0,
    sessionsClosed: 0,
    lastEventAt: null,
    lastStatusAt: null,
    lastFriendsAt: null,
    statusReads: 0,
    statusFailures: 0,
    friendsReads: 0,
    friendsFailures: 0,
    conversationsReads: 0,
    conversationsFailures: 0,
    messagesReads: 0,
    messagesFailures: 0,
    sends: 0,
    sendFailures: 0,
    sendUnknowns: 0,
    cancels: 0,
    reconcileRuns: 0,
    reconcileCoalesced: 0,
    lastError: null,
  };

  constructor(
    private readonly api: RamingaApi,
    options: UiBridgeOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.statusTtlMs = options.statusTtlMs ?? STATUS_TTL_MS;
    this.statusFreshMs = options.statusFreshMs ?? STATUS_FRESH_MS;
    this.contactsTtlMs = options.contactsTtlMs ?? CONTACTS_TTL_MS;
    this.contactsFreshMs = options.contactsFreshMs ?? CONTACTS_FRESH_MS;
    this.conversationsTtlMs = options.conversationsTtlMs ?? CONVERSATIONS_TTL_MS;
    this.conversationsFreshMs = options.conversationsFreshMs ?? CONVERSATIONS_FRESH_MS;
    this.messagesTtlMs = options.messagesTtlMs ?? MESSAGES_TTL_MS;
    this.messagesFreshMs = options.messagesFreshMs ?? MESSAGES_FRESH_MS;
    this.dataDir = options.dataDir ?? (this.api as { config?: { dataDir?: string } }).config?.dataDir ?? '';
    this.revealPath = options.revealPath;
    this.activityStore = options.activity ?? null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.reconcileDelayMs = options.reconcileDelayMs ?? CONNECTION_RECONCILE_DELAY_MS;
    this.streamReadyTimeoutMs = options.streamReadyTimeoutMs ?? STREAM_READY_TIMEOUT_MS;
    this.subscribe = options.subscribe ?? subscribeEvents;
    this.subscribeOptions = options.subscribeOptions ?? {};
    this.streamSince = this.now();
    this.stats.streamSince = this.streamSince;

    const service = {
      open: (sessionId: string) => this.open(sessionId),
      poll: (sessionId: string) => this.poll(sessionId, false),
      refresh: (sessionId: string) => this.poll(sessionId, true),
      close: (sessionId: string) => this.close(sessionId),
      contacts: (sessionId: string, force?: boolean) => this.contacts(sessionId, force === true),
      setFriendName: (sessionId: string, peerId: string, name: string) => this.setFriendName(sessionId, peerId, name),
      setFriendDescription: (sessionId: string, peerId: string, description: string) => this.setFriendDescription(sessionId, peerId, description),
      connect: (sessionId: string, input: string) => this.connect(sessionId, input),
      checkContact: (sessionId: string, peerId: string) => this.checkContact(sessionId, peerId),
      share: (sessionId: string) => this.share(sessionId),
      conversations: (sessionId: string, force?: boolean) => this.conversations(sessionId, force === true),
      messages: (sessionId: string, peerId: string, before?: string, force?: boolean) => this.messages(sessionId, peerId, before ?? '', force === true),
      markRead: (sessionId: string, peerId: string, throughMessageId: string) => this.markRead(sessionId, peerId, throughMessageId),
      favorites: (sessionId: string, before?: string, force?: boolean) => this.favorites(sessionId, before ?? '', force === true),
      setFavorite: (sessionId: string, peerId: string, publicPath: string, sha256: string, title: string, favorite: boolean) => this.setFavorite(sessionId, peerId, publicPath, sha256, title, favorite),
      peerDiscoveries: (sessionId: string, peerId: string, force?: boolean) => this.peerDiscoveries(sessionId, peerId, force === true),
      contactMemory: (sessionId: string, peerId: string) => this.contactMemory(sessionId, peerId),
      saveContactImpression: (sessionId: string, input: ContactImpressionSaveInput) => this.saveContactImpression(sessionId, input),
      send: (sessionId: string, peerId: string, text: string, requestId: string) => this.send(sessionId, peerId, text, requestId),
      cancelOutbox: (sessionId: string, messageId: string) => this.cancelOutbox(sessionId, messageId),
      discoveries: (sessionId: string, familiar?: boolean, force?: boolean) => this.discoveries(sessionId, familiar === true, force === true),
      discoveryContent: (sessionId: string, id: string) => this.discoveryContent(sessionId, id),
      humanOutbound: (sessionId: string, force?: boolean) => this.humanOutbound(sessionId, force === true),
      mine: (sessionId: string, force?: boolean) => this.mine(sessionId, force === true),
      mineFilePreview: (sessionId: string, filePath: string, expectedSha: string, expectedSize: number) => this.mineFilePreview(sessionId, filePath, expectedSha, expectedSize),
      peerProfile: (sessionId: string, peerId: string, force?: boolean) => this.peerProfile(sessionId, peerId, force === true),
      peerFriends: (sessionId: string, peerId: string, force?: boolean) => this.peerFriends(sessionId, peerId, force === true),
      contactProjection: (sessionId: string) => this.contactProjection(sessionId),
      peerManifest: (sessionId: string, peerId: string, force?: boolean) => this.peerManifest(sessionId, peerId, force === true),
      peerFilePreview: (sessionId: string, peerId: string, filePath: string, expectedSha: string, expectedSize: number) => this.peerFilePreview(sessionId, peerId, filePath, expectedSha, expectedSize),
      peerPostMeta: (sessionId: string, peerId: string, filePath: string, expectedSha: string, expectedSize: number) => this.peerPostMeta(sessionId, peerId, filePath, expectedSha, expectedSize),
      peerNodeInfo: (sessionId: string, peerId: string, force?: boolean) => this.peerNodeInfo(sessionId, peerId, force === true),
      revealDiscovery: (sessionId: string, id: string) => this.revealDiscovery(sessionId, id),
      revealFile: (sessionId: string, subject: 'discovery' | 'peer' | 'mine', peerId: string, filePath: string, expectedSha: string, expectedSize: number) => this.revealFile(sessionId, subject, peerId, filePath, expectedSha, expectedSize),
      bootstrap: (sessionId: string) => this.bootstrap(sessionId),
      addBootstrap: (sessionId: string, multiaddr: string) => this.addBootstrap(sessionId, multiaddr),
      removeBootstrap: (sessionId: string, peerId: string) => this.removeBootstrap(sessionId, peerId),
      journey: (sessionId: string, force?: boolean) => this.journey(sessionId, force === true),
      activity: (sessionId: string, limit?: number) => this.activity(sessionId, limit),
      activityDetail: (operationId: string) => this.activityDetail(operationId),
      savePrivateAgent: (sessionId: string, field: 'persona' | 'growth', content: string, expectedSha256: string) => this.savePrivateAgent(sessionId, field, content, expectedSha256),
      publicDraft: (sessionId: string, draftId: string) => this.publicDraft(sessionId, draftId),
      publicDrafts: (sessionId: string, kind: string) => this.publicDrafts(sessionId, kind),
      savePublicDraft: (sessionId: string, input: UiPublicDraftSave) => this.savePublicDraft(sessionId, input),
      putPublicDraftImage: (sessionId: string, draftId: string, role: string, filename: string, dataBase64: string) => this.putPublicDraftImage(sessionId, draftId, role, filename, dataBase64),
      publicDraftAsset: (sessionId: string, draftId: string, assetId: string) => this.publicDraftAsset(sessionId, draftId, assetId),
      importPublicPost: (sessionId: string, publicPath: string) => this.importPublicPost(sessionId, publicPath),
      deletePublicDraft: (sessionId: string, draftId: string, expectedRevision: number) => this.deletePublicDraft(sessionId, draftId, expectedRevision),
      publishPublicDraft: (sessionId: string, draftId: string, expectedRevision: number, expectedPublishedSha256: string) => this.publishPublicDraft(sessionId, draftId, expectedRevision, expectedPublishedSha256),
      locateMessage: (sessionId: string, peerId: string, messageId: string) => this.locateMessage(sessionId, peerId, messageId),
      getStats: () => this.getStats(),
    } as UiService;
    Object.defineProperty(service, 'typertRemote', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { service, serviceKey: UI_SERVICE_KEY, namespace: UI_SERVICE_KEY },
    });
    this.service = service;
    this.reaper = setInterval(() => this.reapIdleSessions(), REAPER_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** Read-only counters for tests and logs; never exposed to the browser except via snapshots. */
  getStats(): UiStats {
    return this.snapshotStats();
  }

  async open(sessionId: string): Promise<UiSnapshot> {
    this.assertOpen();
    const id = this.normalizeSessionId(sessionId);
    this.pruneClosedSessions();
    if (this.closedSessions.has(id)) throw new Error('Raminga panel lease was closed');
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        openedAt: this.now(),
        lastPollAt: this.now(),
        statusAt: 0,
        statusStreamEpoch: -1,
        status: null,
        errorAt: 0,
        error: null,
        events: [],
        friends: [],
        friendsAt: 0,
        friendsStreamEpoch: -1,
        friendsError: null,
        friendsErrorAt: 0,
        conversations: { items: [], at: 0, error: null, errorAt: 0, streamEpoch: -1, retention: null, totalUnread: 0 },
        messages: new Map(),
        conversationsBusy: null,
        messagesBusy: new Map(),
        discoveries: new Map(),
        discoveryBusy: new Map(),
        humanOutbound: { peers: [], at: 0, error: null, errorAt: 0, streamEpoch: -1, complete: false, scanned: 0 },
        humanOutboundBusy: null,
        mine: { data: null, at: 0, errorAt: 0 },
        mineBusy: null,
        peerProfiles: new Map(),
        peerProfileBusy: new Map(),
        peerManifests: new Map(),
        peerManifestBusy: new Map(),
        journey: { data: null, at: 0, errorAt: 0 },
        journeyBusy: null,
      };
      this.sessions.set(id, session);
      this.stats.sessionsOpened += 1;
      // Lease only labels tool calls with the panel that was present. It never
      // controls an operation's terminal state.
      this.activityStore?.attachPanelSession(id);
    }
    session.lastPollAt = this.now();
    try {
      await this.ensureReady();
      this.assertSessionActive(session);
      // Subscribe before the first snapshot so a change that lands while the
      // read is in flight still schedules a trailing reconcile.
      await this.ensureEventStream();
      this.assertSessionActive(session);
      await this.reconcileStatus('open');
      this.assertSessionActive(session);
      return this.snapshot(session, true);
    } catch (error) {
      // Initialization failure, stream setup failure, or a close that raced
      // with this open must release the session immediately; the idle reaper
      // is only a backstop for abrupt browser drops.
      this.releaseSession(session);
      throw error;
    }
  }

  async poll(sessionId: string, force: boolean): Promise<UiSnapshot> {
    this.assertOpen();
    const id = this.normalizeSessionId(sessionId);
    const session = this.sessions.get(id);
    if (!session) throw new Error('Raminga panel lease is not open; reopen the panel');
    session.lastPollAt = this.now();
    if (force || session.statusAt === 0 || this.now() - session.statusAt > this.statusTtlMs) {
      await this.reconcileStatus(force ? 'manual-refresh' : 'poll');
      this.assertSessionActive(session);
    }
    return this.snapshot(session, true);
  }

  async close(sessionId: string): Promise<UiStats> {
    const id = this.acceptedSessionId(sessionId);
    if (id !== null) {
      const session = this.sessions.get(id);
      if (session) this.releaseSession(session);
      if (this.sessions.size === 0) this.stopEventStream();
      if (!this.disposed) this.rememberClosedSession(id);
    }
    return this.snapshotStats();
  }

  /**
   * Read ListFriends and, when needed, a fresh Status for connection-state
   * normalization. The read states stay independent: a failed friend read
   * never becomes an empty list, and a stale Status never proves "not connected".
   */
  async contacts(sessionId: string, force = false): Promise<UiContacts> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const now = this.now();
    const needStatus = force || session.statusAt === 0 || now - session.statusAt > this.statusTtlMs;
    const needFriends = force || session.friendsAt === 0 || now - session.friendsAt > this.contactsTtlMs;
    await Promise.all([
      needStatus ? this.reconcileStatus(force ? 'contacts-refresh' : 'contacts') : Promise.resolve(),
      needFriends ? this.reconcileFriends(force ? 'contacts-refresh' : 'contacts') : Promise.resolve(),
    ]);
    this.assertSessionActive(session);
    return this.contactsSnapshot(session);
  }

  /**
   * Save one local contact label. These values are published in friends.json
   * but never edit a remote profile. Blank is an explicit clear; the UI only
   * calls the method for a field the user changed.
   */
  async setFriendName(sessionId: string, peerId: string, name: string): Promise<UiFriendEdit> {
    return this.editFriend(sessionId, peerId, 'name', name);
  }

  async setFriendDescription(sessionId: string, peerId: string, description: string): Promise<UiFriendEdit> {
    return this.editFriend(sessionId, peerId, 'description', description);
  }

  private async editFriend(
    sessionId: string,
    peerId: string,
    field: 'name' | 'description',
    value: string,
  ): Promise<UiFriendEdit> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    // Presence-aware requests: only a real string can be sent. Never coerce a
    // missing/non-string value to "", because that would mean an explicit clear.
    if (typeof value !== 'string') {
      throw new Error(field === 'name' ? '联系人名称必须是字符串。' : '联系人备注必须是字符串。');
    }
    const text = value;
    await this.ensureReady();
    const response = field === 'name'
      ? await this.api.call(
        (client) => client.setFriendName(new SetFriendNameRequest({ peerId: canonical, name: text }), { timeoutMs: 5000 }),
        '保存联系人名称',
      )
      : await this.api.call(
        (client) => client.setFriendDescription(new SetFriendDescriptionRequest({ peerId: canonical, description: text }), { timeoutMs: 5000 }),
        '保存联系人备注',
      );
    this.assertSessionActive(session);
    // Reread ListFriends so the returned contact and the visible list include
    // the same daemon state, including any name-uniqueness or empty-clear rule.
    await this.awaitFriendsIdle();
    if (this.isSessionActive(session)) await this.reconcileFriends('friend-edit');
    this.assertSessionActive(session);
    const friend = session.friends.find((item) => canonicalPeerId(item.peerId) === canonical) ?? response.friend;
    if (!friend) throw new Error('联系人保存后没有在列表中找到。');
    return {
      friend: toUiFriend(friend, session.status, this.freshnessOf(session) === 'live'),
      contacts: this.contactsSnapshot(session),
    };
  }

  /**
   * Dial a user-provided Peer ID or complete multiaddr. Parsing is done with
   * maintained libp2p parsers. A successful dial is reported even when the
   * friend list refresh fails or the friend write has not happened yet.
   */
  async connect(sessionId: string, input: string): Promise<UiConnectResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const at = this.now();
    const raw = typeof input === 'string' ? input : '';
    const parsed = parseConnectInput(raw);
    const emptyContact: UiConnectContactCheck = { ok: false, found: false, error: null, at: null };
    const emptyStatus = { ok: false, at: null as number | null, error: null as string | null };
    if (!parsed.ok) {
      return {
        ok: false,
        invalid: true,
        input: raw,
        at,
        peerId: null,
        route: '',
        transport: '',
        direct: false,
        limited: false,
        reused: false,
        remoteMultiaddr: '',
        note: '',
        error: parsed.message,
        detail: parsed.detail,
        contact: emptyContact,
        status: emptyStatus,
        contacts: this.isSessionActive(session) ? this.contactsSnapshot(session) : null,
      };
    }

    let response;
    try {
      await this.ensureReady();
      const request = parsed.kind === 'peer'
        ? new ConnectRequest({ peerId: parsed.peerId })
        : new ConnectRequest({ multiaddr: parsed.multiaddr });
      response = await this.api.call(
        (client) => client.connect(request, { timeoutMs: this.connectTimeoutMs }),
        '连接节点',
      );
    } catch (error) {
      return {
        ok: false,
        invalid: false,
        input: raw,
        at: this.now(),
        peerId: parsed.peerId,
        route: '',
        transport: '',
        direct: false,
        limited: false,
        reused: false,
        remoteMultiaddr: '',
        note: '',
        error: errorMessage(error),
        detail: null,
        contact: emptyContact,
        status: emptyStatus,
        contacts: this.isSessionActive(session) ? this.contactsSnapshot(session) : null,
      };
    }

    let contact: UiConnectContactCheck = {
      ok: false,
      found: false,
      error: '页面已关闭，未核对联系人。',
      at: null,
    };
    const status: UiConnectResult['status'] = { ok: false, at: null, error: '页面已关闭，未核对节点状态。' };
    let contacts: UiContacts | null = null;
    if (this.isSessionActive(session)) {
      // Do not let a read that started before this successful dial stand in
      // for the post-connect verification.
      await this.awaitStatusIdle();
      await this.awaitFriendsIdle();
      if (this.isSessionActive(session)) {
        await Promise.all([
          this.reconcileStatus('connect', { trailing: true }),
          this.reconcileFriends('connect'),
        ]);
      }
      if (this.isSessionActive(session)) {
        const friendsOk = session.friendsError === null && session.friendsAt > 0;
        const found = friendsOk && session.friends.some((friend) => canonicalPeerId(friend.peerId) === parsed.peerId);
        contact = {
          ok: friendsOk,
          found,
          error: friendsOk ? null : session.friendsError,
          at: session.friendsAt > 0 ? session.friendsAt : null,
        };
        status.ok = session.error === null && session.statusAt > 0;
        status.at = session.statusAt > 0 ? session.statusAt : null;
        status.error = session.error;
        contacts = this.contactsSnapshot(session);
      }
    }

    return {
      ok: true,
      invalid: false,
      input: raw,
      at: this.now(),
      peerId: canonicalPeerId(response.peerId) ?? parsed.peerId,
      route: response.route,
      transport: response.transport,
      direct: response.direct,
      limited: response.limited,
      reused: response.reused,
      remoteMultiaddr: response.remoteMultiaddr,
      note: response.note,
      error: null,
      detail: null,
      contact,
      status,
      contacts,
    };
  }

  /** Re-read both facts after an earlier refresh failure; never inserts locally. */
  async checkContact(sessionId: string, peerId: string): Promise<UiConnectContactCheck & { contacts: UiContacts | null }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) {
      return { ok: false, found: false, error: 'Peer ID 格式不正确。', at: null, contacts: null };
    }
    await this.awaitStatusIdle();
    await this.awaitFriendsIdle();
    if (!this.isSessionActive(session)) throw new Error('Raminga panel lease was closed');
    await Promise.all([
      this.reconcileStatus('contact-check', { trailing: true }),
      this.reconcileFriends('contact-check'),
    ]);
    this.assertSessionActive(session);
    const friendsOk = session.friendsError === null && session.friendsAt > 0;
    return {
      ok: friendsOk,
      found: friendsOk && session.friends.some((friend) => canonicalPeerId(friend.peerId) === canonical),
      error: friendsOk ? null : session.friendsError,
      at: session.friendsAt > 0 ? session.friendsAt : null,
      contacts: this.contactsSnapshot(session),
    };
  }

  /** Read share facts from Status: full Peer ID, advertised addrs and relays. */
  async share(sessionId: string): Promise<UiShareInfo> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.awaitStatusIdle();
    if (!this.isSessionActive(session)) throw new Error('Raminga panel lease was closed');
    await this.reconcileStatus('share', { trailing: true });
    this.assertSessionActive(session);
    if (!session.status) {
      return {
        ok: false,
        peerId: null,
        at: null,
        stale: false,
        error: session.error ?? '本机节点没有返回状态。',
        addresses: [],
      };
    }
    const freshness = this.freshnessOf(session);
    const streamNote = this.eventPhase === 'open' ? null : (this.streamError ?? '实时更新尚未恢复。');
    return {
      ok: true,
      peerId: session.status.peerId,
      at: session.statusAt > 0 ? session.statusAt : null,
      stale: freshness !== 'live',
      error: session.error ?? streamNote,
      addresses: buildShareAddresses(session.status, this.now()),
    };
  }

  /**
   * Read the Peer-grouped conversation summaries from the daemon. A failure
   * keeps the last summary list but marks it stale; it never becomes an empty
   * list. The bridge has no durable event cursor, so a re-entry or stream
   * reopen re-reads this snapshot instead of replaying events.
   */
  async conversations(sessionId: string, force = false): Promise<UiConversations> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const state = session.conversations;
    const need = force || state.at === 0 || this.now() - state.at > this.conversationsTtlMs;
    if (need) await this.refreshConversations(session);
    this.assertSessionActive(session);
    return this.conversationsSnapshot(session);
  }

  private refreshConversations(session: PanelSession): Promise<void> {
    if (session.conversationsBusy !== null) return session.conversationsBusy;
    const at = this.now();
    const streamEpoch = this.streamEpoch;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await this.ensureReady();
        const response = await this.api.call(
          (client) => client.listConversations(
            new ListConversationsRequest({ limit: CONVERSATION_PAGE_LIMIT }),
            { timeoutMs: 3500 },
          ),
          '读取会话列表',
        );
        if (!this.isSessionActive(session)) return;
        const state = session.conversations;
        state.items = (response.conversations ?? []).map((row) => ({
          peerId: String(row.peerId ?? ''),
          lastMessageId: String(row.lastMessageId ?? ''),
          direction: String(row.direction ?? ''),
          preview: String(row.preview ?? ''),
          lastAt: numberOf(row.lastAtUnixMs),
          deliveryStatus: String(row.deliveryStatus ?? 'unknown'),
          origin: String(row.origin ?? 'unknown'),
          messageCount: numberOf(row.messageCount),
          unreadCount: numberOf(row.unreadCount),
          lastReadMessageId: String(row.lastReadMessageId ?? ''),
          lastReadAt: numberOf(row.lastReadAtUnixMs),
        }));
        state.at = at;
        state.error = null;
        state.errorAt = 0;
        state.streamEpoch = streamEpoch;
        state.retention = toUiRetention(response.retention);
        state.totalUnread = numberOf(response.totalUnread);
        this.stats.conversationsReads += 1;
      } catch (error) {
        if (!this.isSessionActive(session)) return;
        const state = session.conversations;
        state.error = errorMessage(error);
        state.errorAt = this.now();
        this.stats.conversationsFailures += 1;
      } finally {
        if (session.conversationsBusy === promise) session.conversationsBusy = null;
      }
    })();
    session.conversationsBusy = promise;
    return promise;
  }

  /**
   * Read one Peer's retained messages. `before` is an opaque older-page cursor
   * and never replaces the cached latest page; a normal call returns the
   * latest page (newest first). The UI merges stable message IDs locally.
   */
  async messages(sessionId: string, peerId: string, before = '', force = false): Promise<UiMessagePage> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) {
      return this.emptyMessagePage(peerId, 'Peer ID 格式不正确。');
    }
    if (typeof before === 'string' && before.length > 0) {
      return this.fetchMessagePage(canonical, before);
    }
    let state = session.messages.get(canonical);
    if (!state) {
      state = this.emptyMessageState();
      session.messages.set(canonical, state);
    }
    const need = force || state.at === 0 || this.now() - state.at > this.messagesTtlMs;
    if (need) await this.refreshMessages(session, canonical);
    this.assertSessionActive(session);
    return this.messagePageSnapshot(session, canonical);
  }

  private refreshMessages(session: PanelSession, peerId: string): Promise<void> {
    const existing = session.messagesBusy.get(peerId);
    if (existing !== undefined) return existing;
    const at = this.now();
    const streamEpoch = this.streamEpoch;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await this.ensureReady();
        const response = await this.api.call(
          (client) => client.listMessages(
            new ListMessagesRequest({ peerId, limit: MESSAGE_PAGE_LIMIT }),
            { timeoutMs: 3500 },
          ),
          '读取会话消息',
        );
        if (!this.isSessionActive(session)) return;
        let state = session.messages.get(peerId);
        if (!state) {
          state = this.emptyMessageState();
          session.messages.set(peerId, state);
        }
        state.items = (response.messages ?? []).map(toUiMessage);
        state.at = at;
        state.error = null;
        state.errorAt = 0;
        state.streamEpoch = streamEpoch;
        state.hasMore = response.hasMore === true;
        state.nextBefore = String(response.nextBefore ?? '');
        state.retention = toUiRetention(response.retention);
        this.stats.messagesReads += 1;
      } catch (error) {
        if (!this.isSessionActive(session)) return;
        let state = session.messages.get(peerId);
        if (!state) {
          state = this.emptyMessageState();
          session.messages.set(peerId, state);
        }
        state.error = errorMessage(error);
        state.errorAt = this.now();
        this.stats.messagesFailures += 1;
      } finally {
        if (session.messagesBusy.get(peerId) === promise) session.messagesBusy.delete(peerId);
      }
    })();
    session.messagesBusy.set(peerId, promise);
    return promise;
  }

  private async fetchMessagePage(peerId: string, before: string): Promise<UiMessagePage> {
    const at = this.now();
    const streamEpoch = this.streamEpoch;
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.listMessages(
          new ListMessagesRequest({ peerId, before, limit: MESSAGE_PAGE_LIMIT }),
          { timeoutMs: 3500 },
        ),
        '读取更早消息',
      );
      this.stats.messagesReads += 1;
      return {
        peerId,
        messages: (response.messages ?? []).map(toUiMessage),
        at,
        error: null,
        errorAt: null,
        freshness: this.pageFreshness(at, null, true, streamEpoch),
        hasMore: response.hasMore === true,
        nextBefore: String(response.nextBefore ?? ''),
        retention: toUiRetention(response.retention),
      };
    } catch (error) {
      this.stats.messagesFailures += 1;
      return {
        peerId,
        messages: [],
        at,
        error: errorMessage(error),
        errorAt: this.now(),
        freshness: 'unavailable',
        hasMore: false,
        nextBefore: '',
        retention: null,
      };
    }
  }

  /**
   * Advance the human read cursor after the UI proves the conversation is
   * visible, focused and at the latest page. This is the only browser method
   * that writes read state; message/list reads never do.
   */
  async markRead(sessionId: string, peerId: string, throughMessageId: string): Promise<UiMarkRead> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    const messageId = typeof throughMessageId === 'string' ? throughMessageId.trim() : '';
    if (messageId.length === 0) throw new Error('没有可标记为已读的消息。');
    await this.ensureReady();
    const response = await this.api.call(
      (client) => client.markConversationRead(
        new MarkConversationReadRequest({ peerId: canonical, throughMessageId: messageId }),
        { timeoutMs: 5000 },
      ),
      '标记会话已读',
    );
    this.assertSessionActive(session);
    const state = session.conversations;
    const row = state.items.find((item) => item.peerId === canonical);
    if (row) {
      const previous = row.unreadCount;
      row.unreadCount = numberOf(response.unreadCount);
      row.lastReadMessageId = String(response.lastReadMessageId ?? messageId);
      row.lastReadAt = numberOf(response.lastReadAtUnixMs);
      state.totalUnread = Math.max(0, state.totalUnread - previous + row.unreadCount);
    }
    const friend = session.friends.find((item) => canonicalPeerId(item.peerId) === canonical);
    if (friend) friend.unreadCount = numberOf(response.unreadCount);
    return {
      peerId: canonical,
      lastReadMessageId: String(response.lastReadMessageId ?? messageId),
      lastReadAt: numberOf(response.lastReadAtUnixMs),
      unreadCount: numberOf(response.unreadCount),
    };
  }

  /** Read private public-post bookmarks newest first; no message/contact kind. */
  async favorites(sessionId: string, before = '', _force = false): Promise<UiFavorites> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const at = this.now();
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.listFavorites(
          new ListFavoritesRequest({ before: typeof before === 'string' ? before : '', limit: 50 }),
          { timeoutMs: 4000 },
        ),
        '读取收藏的动态',
      );
      this.assertSessionActive(session);
      return {
        favorites: (response.favorites ?? []).map((row) => ({
          id: String(row.id ?? ''),
          peerId: String(row.peerId ?? ''),
          path: String(row.path ?? ''),
          sha256: String(row.sha256 ?? '').toLowerCase(),
          title: String(row.title ?? ''),
          createdAt: numberOf(row.createdAtUnixMs),
          available: row.available === true,
          local: String(row.peerId ?? '') === String(session.status?.peerId ?? ''),
        })),
        at,
        error: null,
        errorAt: null,
        freshness: this.listFreshness(at, null, true, this.streamEpoch, DISCOVERY_FRESH_MS),
        hasMore: response.hasMore === true,
        nextBefore: String(response.nextBefore ?? ''),
        total: 0,
      };
    } catch (error) {
      return {
        favorites: [], at: null, error: errorMessage(error), errorAt: this.now(),
        freshness: 'unavailable', hasMore: false, nextBefore: '', total: 0,
      };
    }
  }

  /** Idempotently save or clear one public-post bookmark. */
  async setFavorite(
    sessionId: string,
    peerId: string,
    publicPath: string,
    sha256: string,
    title: string,
    favorite: boolean,
  ): Promise<{ favorite: boolean; item: UiFavorite | null }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    const digest = validSha256(sha256);
    if (digest === '') throw new Error('内容 SHA-256 格式无效。');
    await this.ensureReady();
    const response = await this.api.call(
      (client) => client.setFavorite(
        new SetFavoriteRequest({
          peerId: canonical,
          path: typeof publicPath === 'string' ? publicPath : '',
          sha256: digest,
          title: typeof title === 'string' ? title.slice(0, 200) : '',
          favorite: favorite === true,
        }),
        { timeoutMs: 5000 },
      ),
      favorite ? '收藏动态' : '取消收藏动态',
    );
    this.assertSessionActive(session);
    const item = response.item
      ? {
        id: String(response.item.id ?? ''),
        peerId: String(response.item.peerId ?? ''),
        path: String(response.item.path ?? ''),
        sha256: String(response.item.sha256 ?? '').toLowerCase(),
        title: String(response.item.title ?? ''),
        createdAt: numberOf(response.item.createdAtUnixMs),
        available: response.item.available === true,
        local: String(response.item.peerId ?? '') === String(session.status?.peerId ?? ''),
      }
      : null;
    return { favorite: response.favorite === true, item };
  }

  /** Local discovery copies authored by one Peer, never a current manifest. */
  async peerDiscoveries(sessionId: string, peerId: string, _force = false): Promise<UiPeerDiscoveries> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    const at = this.now();
    try {
      if (this.dataDir.length === 0) throw new Error('宿主没有提供受控数据目录，无法核对公开内容来源');
      await this.ensureReady();
      const rows: DiscoveryEvidenceRow[] = [];
      let before = '';
      let truncated = false;
      for (let pageIndex = 0; pageIndex < 10 && rows.length < MAX_DISCOVERY_SCAN; pageIndex += 1) {
        const response = await this.api.call(
          (client) => client.listDiscoveries(
            new ListDiscoveriesRequest({ peerId: canonical, limit: DISCOVERY_PAGE_LIMIT, before }),
            { timeoutMs: 4000 },
          ),
          '读取联系人的本地公开动态',
        );
        for (const row of response.discoveries ?? []) {
          const source = String(row.source ?? '');
          const sources = (row.sources ?? []).map((value) => String(value ?? '')).filter((value) => value.length > 0);
          rows.push({
            id: String(row.id ?? ''),
            peerId: String(row.peerId ?? ''),
            path: String(row.path ?? ''),
            sha256: String(row.sha256 ?? ''),
            sizeBytes: numberOf(row.sizeBytes),
            fetchedAt: numberOf(row.fetchedAtUnixMs),
            source,
            sources: sources.length > 0 ? sources : (source.length > 0 ? [source] : []),
          });
        }
        if (response.hasMore !== true) break;
        const next = String(response.nextBefore ?? '');
        if (next.length === 0 || next === before) throw new Error('公开内容索引分页游标没有前进，无法确认已完整读取');
        before = next;
        if (pageIndex === 9) truncated = true;
      }
      const postRows = rows.filter((row) => isVersionedPostPath(row.path));
      const toParse = postRows.slice(0, MAX_DISCOVERY_PARSE);
      if (postRows.length > toParse.length) truncated = true;
      const names = await this.resolvePublisherNames([canonical]);
      const budget = { reads: 0, bytes: 0 };
      const items: UiDiscoveryItem[] = [];
      let ignored = rows.length - postRows.length;
      for (const row of toParse) {
        const item = await this.discoveryItem(row, names.get(canonical) ?? '', budget);
        if (item === null) ignored += 1;
        else items.push(item);
      }
      this.assertSessionActive(session);
      return {
        peerId: canonical,
        items,
        at,
        error: null,
        errorAt: null,
        freshness: this.listFreshness(at, null, items.length > 0, this.streamEpoch, DISCOVERY_FRESH_MS),
        familiar: false,
        scanned: rows.length,
        truncated,
        relationComplete: true,
        ignored,
      };
    } catch (error) {
      return {
        peerId: canonical, items: [], at: null, error: errorMessage(error), errorAt: this.now(),
        freshness: 'unavailable', familiar: false, scanned: 0, truncated: false, relationComplete: false, ignored: 0,
      };
    }
  }

  /**
   * Merge private contact memory with real evidence. Messages and Journey
   * events are facts; contact-notes entries stay private local claims. Nothing
   * here writes the read cursor or sends data to a peer.
   */
  async contactMemory(sessionId: string, peerId: string): Promise<UiContactMemory> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    return this.buildContactMemory(session, canonical);
  }

  private async buildContactMemory(session: PanelSession, peerId: string): Promise<UiContactMemory> {
    const at = this.now();
    const items: UiContactMemoryItem[] = [];
    let truncated = false;
    let notes: LocalContactNotes | null = null;
    let notesError = '';
    try {
      notes = await readContactNotes(this.dataDir);
      if (notes.state === 'error') notesError = notes.error;
    } catch (error) {
      notesError = errorMessage(error);
    }
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.listMessages(
          new ListMessagesRequest({ peerId, limit: CONTACT_MEMORY_MESSAGE_LIMIT }),
          { timeoutMs: 4000 },
        ),
        '读取交互消息',
      );
      if (response.hasMore === true) truncated = true;
      for (const raw of response.messages ?? []) {
        const message = toUiMessage(raw);
        const direction = message.direction === 'in' ? 'in' : 'out';
        const origin = direction === 'in' ? 'unknown' : message.origin;
        const source = direction === 'in'
          ? '对方消息'
          : origin === 'human' ? '本人消息' : origin === 'agent' ? 'Agent 消息' : '来源未知的发出消息';
        items.push({
          id: `message:${message.messageId}`,
          kind: 'message',
          at: message.createdAt,
          summary: message.text.slice(0, 240),
          body: message.text,
          source,
          sourceKind: 'message',
          eventType: 'message',
          private: true,
          evidence: { ...emptyEvidenceRefs(), messageIds: [message.messageId] },
          direction,
          origin,
        });
      }
    } catch (error) {
      notesError = notesError || errorMessage(error);
    }
    try {
      const journey = await readJourney(this.dataDir);
      if (journey.sessionsTruncated) truncated = true;
      for (const sessionData of journey.sessions) {
        let sessionRelated = false;
        for (const event of sessionData.events) {
          const related = event.peerId === peerId
            || event.sourcePeerId === peerId
            || event.messageEvidence?.peerId === peerId;
          if (!related) continue;
          sessionRelated = true;
          const eventAt = Date.parse(event.timestamp);
          if (!Number.isFinite(eventAt) || eventAt <= 0) continue;
          const eventId = `${sessionData.id}:${event.sequence}`;
          const meta = contactJourneySource(event);
          items.push({
            id: `journey:${eventId}`,
            kind: 'journey',
            at: eventAt,
            summary: event.summary || event.type,
            body: event.summary || event.type,
            source: meta.source,
            sourceKind: meta.sourceKind,
            eventType: event.type,
            sourcePeerId: event.sourcePeerId,
            subjectPeerId: event.peerId,
            private: true,
            evidence: {
              sessionIds: [sessionData.id],
              eventIds: [eventId],
              messageIds: [...event.messageIds],
              contentPaths: [...event.contentPaths],
              contentSha256: [],
            },
            direction: '',
            origin: '',
          });
        }
        const visited = Array.isArray(sessionData.state?.visitedPeerIds)
          && sessionData.state.visitedPeerIds.includes(peerId);
        const current = sessionData.state?.currentPeerId === peerId;
        if (!sessionRelated && !visited && !current) continue;
        if (sessionData.reportRead !== 'available' || sessionData.reportMarkdown.trim().length === 0) continue;
        const reportAt = Date.parse(
          sessionData.state?.completedAt || sessionData.state?.updatedAt || sessionData.state?.startedAt || '',
        );
        const at = Number.isFinite(reportAt) && reportAt > 0 ? reportAt : 0;
        const line = journeyReportLine(sessionData.reportMarkdown);
        items.push({
          id: `journey-report:${sessionData.id}`,
          kind: 'journey',
          at,
          summary: line || '本次漫游报告（摘要）',
          body: '',
          source: 'Journey 报告 · 摘要（原文在漫游详情）',
          sourceKind: 'journeyReport',
          eventType: 'report',
          private: true,
          evidence: {
            ...emptyEvidenceRefs(),
            sessionIds: [sessionData.id],
          },
          direction: '',
          origin: '',
        });
      }
    } catch (error) {
      notesError = notesError || errorMessage(error);
    }
    const contact = notes?.contacts.find((item) => item.peerId === peerId) ?? null;
    if (contact) {
      for (const observation of contact.observations) {
        const observed = Date.parse(observation.observedAt);
        if (!Number.isFinite(observed) || observed <= 0) continue;
        items.push({
          id: `observation:${observation.id}`,
          kind: 'observation',
          at: observed,
          summary: observation.summary,
          body: observation.summary,
          source: '私有观察 · contact-notes',
          eventType: 'observation',
          private: true,
          evidence: { ...observation.evidenceRefs },
          direction: '',
          origin: '',
        });
      }
      for (const impression of contact.impressions) {
        const stamped = Date.parse(impression.updatedAt || impression.createdAt);
        if (!Number.isFinite(stamped) || stamped <= 0) continue;
        items.push({
          id: `impression:${impression.id}`,
          kind: 'impression',
          at: stamped,
          summary: impression.summary,
          body: impression.summary,
          source: `私有印象${impression.uncertainty ? ` · 确定性 ${uncertaintyLabel(impression.uncertainty) || impression.uncertainty}` : ''}`,
          eventType: 'impression',
          private: true,
          evidence: { ...impression.evidenceRefs },
          direction: '',
          origin: '',
        });
      }
      for (const curiosity of contact.curiosities) {
        const stamped = Date.parse(curiosity.createdAt);
        if (!Number.isFinite(stamped) || stamped <= 0) continue;
        items.push({
          id: `curiosity:${curiosity.id}`,
          kind: 'curiosity',
          at: stamped,
          summary: curiosity.question,
          body: curiosity.question,
          source: '私有好奇 · contact-notes',
          eventType: 'curiosity',
          private: true,
          evidence: { ...curiosity.evidenceRefs },
          direction: '',
          origin: '',
        });
      }
    }
    items.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
    if (items.length > CONTACT_MEMORY_MAX_ITEMS) {
      truncated = true;
      items.length = CONTACT_MEMORY_MAX_ITEMS;
    }
    const state: UiContactMemory['state'] = notesError ? 'error' : notes === null || notes.state === 'missing' ? 'missing' : 'available';
    return {
      peerId,
      state,
      sha256: notes?.sha256 ?? '',
      schemaVersion: notes?.schemaVersion ?? 0,
      contact,
      timeline: items,
      timelineTruncated: truncated,
      error: notesError,
      at,
    };
  }

  /** Save one private impression atomically; never writes public data. */
  async saveContactImpression(sessionId: string, input: ContactImpressionSaveInput): Promise<UiContactImpressionSave> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    try {
      const saved = await saveContactImpression(this.dataDir, input);
      const memory = await this.buildContactMemory(session, saved.contact.peerId);
      return {
        saved: true,
        conflict: false,
        sha256: saved.sha256,
        savedAt: saved.savedAt,
        contact: saved.contact,
        memory,
        error: '',
      };
    } catch (error) {
      const conflict = error instanceof LocalDataError && error.code === 'conflict';
      return {
        saved: false,
        conflict,
        sha256: '',
        savedAt: 0,
        contact: null,
        memory: null,
        error: errorMessage(error),
      };
    }
  }

  /**
   * Send one human-origin message through the explicit local operator path.
   * agent_origin stays false and origin is "human"; the existing Agent tools
   * never call this method and continue to set agent_origin.
   */
  async send(sessionId: string, peerId: string, text: string, requestId: string): Promise<UiSendResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const at = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    const body = typeof text === 'string' ? text : '';
    const request = typeof requestId === 'string' ? requestId : '';
    const base: UiSendResult = {
      ok: false,
      unknown: false,
      invalid: false,
      peerId: canonical ?? '',
      requestId: request,
      messageId: '',
      replayed: false,
      acked: false,
      deliveryStatus: 'unknown',
      outboxStatus: 'unknown',
      error: null,
      detail: null,
      at,
    };
    if (canonical === null) {
      return { ...base, invalid: true, error: 'Peer ID 格式不正确。' };
    }
    if (body.trim().length === 0) {
      return { ...base, invalid: true, error: '消息不能为空。' };
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request)) {
      return { ...base, invalid: true, error: '发送请求标识无效，请重试。' };
    }
    const limit = Number(session.status?.maxChatTextBytes) > 0 ? Number(session.status?.maxChatTextBytes) : 4096;
    if (Buffer.byteLength(body, 'utf8') > limit) {
      return { ...base, invalid: true, error: `消息太长了。当前节点最多允许 ${limit} 字节（约 ${limit} 个英文字符）。` };
    }
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.sendChat(new SendChatRequest({
          peerId: canonical,
          text: body,
          origin: 'human',
          agentOrigin: false,
          requestId: request,
        }), { timeoutMs: SEND_TIMEOUT_MS }),
        '发送消息',
      );
      this.stats.sends += 1;
      // A persisted human send changes the summary order, the message page and
      // the durable "has human outbound" relation in the same daemon
      // transaction. Invalidate those reads instead of waiting for an ACK or
      // requiring the panel to be remounted.
      session.conversations.at = 0;
      session.messages.delete(canonical);
      session.humanOutbound.at = 0;
      session.humanOutbound.complete = false;
      session.humanOutbound.error = null;
      session.humanOutbound.errorAt = 0;
      session.discoveries.delete('familiar');
      const delivery = String(response.deliveryStatus || response.outboxStatus || (response.acked ? 'acked' : 'unknown'));
      return {
        ...base,
        ok: true,
        messageId: String(response.messageId ?? ''),
        replayed: response.replayed === true,
        acked: response.acked === true,
        deliveryStatus: delivery,
        outboxStatus: String(response.outboxStatus || delivery),
        error: response.error ? String(response.error) : null,
        at: this.now(),
      };
    } catch (error) {
      this.stats.sendFailures += 1;
      this.stats.sendUnknowns += 1;
      // No RPC result: the daemon may or may not have persisted the message.
      // Keep the request_id so the UI can reconcile by re-reading and can
      // safely retry that idempotency key, never a fresh message.
      return {
        ...base,
        ok: false,
        unknown: true,
        error: '这次发送没有收到节点结果，消息可能已经保存。请先核对，不要直接重发。',
        detail: errorMessage(error),
        at: this.now(),
      };
    }
  }

  /** Cancel one pending outbox entry; terminal states are rejected honestly. */
  async cancelOutbox(sessionId: string, messageId: string): Promise<UiCancelResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const id = typeof messageId === 'string' ? messageId : '';
    const at = this.now();
    if (id.length === 0) {
      return { ok: false, messageId: '', status: 'unknown', error: '缺少消息标识。', at };
    }
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.outboxCancel(new OutboxCancelRequest({ messageId: id }), { timeoutMs: CANCEL_TIMEOUT_MS }),
        '取消待发消息',
      );
      this.stats.cancels += 1;
      session.messages.clear();
      return {
        ok: response.cancelled === true,
        messageId: id,
        status: String(response.status || 'cancelled'),
        error: response.cancelled === true ? null : '这条消息已经不能取消。',
        at: this.now(),
      };
    } catch (error) {
      return {
        ok: false,
        messageId: id,
        status: 'unknown',
        error: errorMessage(error),
        at: this.now(),
      };
    }
  }

  /**
   * Read the private discovery index. Every row is evidence from a successful
   * Agent tool fetch; the host then verifies the downloaded copy's hash and
   * parses only versioned public posts. A familiar filter is applied against a
   * complete stable snapshot of ListHumanOutboundPeers, not against the rows we
   * happen to have seen.
   */
  async discoveries(sessionId: string, familiar = false, force = false): Promise<UiDiscoveries> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const key = familiar ? 'familiar' : 'all';
    let state = session.discoveries.get(key);
    if (!state) {
      state = this.emptyDiscoveriesState(familiar);
      session.discoveries.set(key, state);
    }
    const need = force || state.at === 0 || this.now() - state.at > DISCOVERY_TTL_MS;
    if (need) await this.loadDiscoveries(session, familiar, force);
    this.assertSessionActive(session);
    return this.discoveriesSnapshot(session, familiar);
  }

  private emptyDiscoveriesState(familiar: boolean): DiscoveriesState {
    return {
      items: [], at: 0, error: null, errorAt: 0, streamEpoch: -1,
      familiar, scanned: 0, truncated: false, relationComplete: !familiar, ignored: 0,
    };
  }

  private async loadDiscoveries(session: PanelSession, familiar: boolean, force = false): Promise<void> {
    const key = familiar ? 'familiar' : 'all';
    const existing = session.discoveryBusy.get(key);
    if (existing !== undefined) {
      if (!force) return existing;
      // A send may invalidate the familiar cache while an older read is still
      // in flight. A forced re-read waits for that read, then takes one fresh
      // relation snapshot instead of returning the pre-send result.
      return existing.then(() => this.loadDiscoveries(session, familiar, true));
    }
    let promise!: Promise<void>;
    promise = (async () => {
      const at = this.now();
      const streamEpoch = this.streamEpoch;
      try {
        if (this.dataDir.length === 0) throw new Error('宿主没有提供受控数据目录，无法核对公开内容来源');
        await this.ensureReady();
        let relation: { peers: Set<string>; complete: boolean; scanned: number } = {
          peers: new Set(), complete: true, scanned: 0,
        };
        if (familiar) {
          relation = await this.completeHumanRelations(session);
        }
        const rows: Array<{
          id: string; peerId: string; path: string; sha256: string; sizeBytes: number;
          fetchedAt: number; source: string; sources: string[];
        }> = [];
        let before = '';
        let truncated = false;
        let pages = 0;
        while (rows.length < MAX_DISCOVERY_SCAN && pages < 50) {
          pages += 1;
          const response = await this.api.call(
            (client) => client.listDiscoveries(
              new ListDiscoveriesRequest({
                limit: DISCOVERY_PAGE_LIMIT,
                before,
                familiarOnly: familiar,
                postCandidatesOnly: true,
              }),
              { timeoutMs: 4000 },
            ),
            '读取公开内容索引',
          );
          const page = response.discoveries ?? [];
          for (const row of page) {
            if (rows.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
            const source = String(row.source ?? '');
            const sources = (row.sources ?? []).map((value) => String(value ?? '')).filter((value) => value.length > 0);
            rows.push({
              id: String(row.id ?? ''),
              peerId: String(row.peerId ?? ''),
              path: String(row.path ?? ''),
              sha256: String(row.sha256 ?? ''),
              sizeBytes: numberOf(row.sizeBytes),
              fetchedAt: numberOf(row.fetchedAtUnixMs),
              source,
              sources: sources.length > 0 ? sources : (source.length > 0 ? [source] : []),
            });
          }
          if (response.hasMore !== true) {
            before = '';
            break;
          }
          const next = String(response.nextBefore ?? '');
          if (next.length === 0 || next === before) throw new Error('公开内容索引分页游标没有前进，无法确认已完整读取');
          if (rows.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
          before = next;
        }
        if (rows.length < MAX_DISCOVERY_SCAN && before !== '') {
          // The daemon still had more pages when the bounded page loop ended.
          truncated = true;
        }
        // The daemon owns the “有过交流” definition: it includes a durable
        // human relation or a retained real Agent outbound row. Do not re-filter
        // by the human-only relation client-side, or Agent conversations would
        // silently disappear from the familiar feed.
        //
        // Only recognized versioned posts enter the Feed. The private index
        // also stores contacts, profiles, attachments and old downloads, but
        // those belong to the separate public-file surfaces. The daemon applies
        // the post-shaped path prefilter before its cursor LIMIT, so ordinary
        // files never consume this page budget. The local filter below remains
        // a compatibility guard for older daemons that ignore the new field.
        const postRows = rows.filter((row) => isVersionedPostPath(row.path));
        const toParse = postRows.slice(0, MAX_DISCOVERY_PARSE);
        if (postRows.length > toParse.length) truncated = true;
        const names = await this.resolvePublisherNames(toParse.map((row) => row.peerId));
        const metaBudget = { reads: 0, bytes: 0 };
        const items: UiDiscoveryItem[] = [];
        let ignored = rows.length - postRows.length;
        for (const row of toParse) {
          const item = await this.discoveryItem(row, names.get(row.peerId) ?? '', metaBudget);
          if (item === null) ignored += 1;
          else items.push(item);
        }
        if (!this.isSessionActive(session)) return;
        const state = session.discoveries.get(key)!;
        state.items = items;
        state.at = at;
        state.error = null;
        state.errorAt = 0;
        state.streamEpoch = streamEpoch;
        state.scanned = rows.length;
        state.truncated = truncated;
        state.relationComplete = familiar ? relation.complete : true;
        state.ignored = ignored;
      } catch (error) {
        if (!this.isSessionActive(session)) return;
        const state = session.discoveries.get(key)!;
        state.error = errorMessage(error);
        state.errorAt = this.now();
      } finally {
        if (session.discoveryBusy.get(key) === promise) session.discoveryBusy.delete(key);
      }
    })();
    session.discoveryBusy.set(key, promise);
    return promise;
  }

  /**
   * Verify one discovery row as a recognizable versioned post (v1 or v2).
   * Non-post public files are not Feed items at all. A post row whose local
   * copy is missing or no longer matches its recorded version stays visible
   * with an explicit error so the reader is not silently told it vanished.
   */
  private async discoveryItem(
    row: { id: string; peerId: string; path: string; sha256: string; sizeBytes: number; fetchedAt: number; source: string; sources: string[] },
    publisherName: string,
    budget: { reads: number; bytes: number },
  ): Promise<UiDiscoveryItem | null> {
    if (!isVersionedPostPath(row.path)) return null;
    const item: UiDiscoveryItem = {
      id: row.id,
      peerId: row.peerId,
      publisherName: publisherName || shortPeer(row.peerId),
      path: row.path,
      name: path.posix.basename(row.path),
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      modifiedAt: 0,
      fetchedAt: row.fetchedAt,
      source: row.source,
      sources: [...row.sources],
      kind: 'markdown',
      mime: 'text/markdown',
      previewable: true,
      title: titleFallback(row.path),
      summary: '',
      tags: [],
      publishedAt: '',
      authorKind: '',
      authorName: '',
      contentState: 'available',
      contentError: '',
      images: [],
    };
    try {
      const info = await downloadedFileInfo(this.dataDir, row.peerId, row.path);
      item.modifiedAt = info.modifiedAt;
      if (info.size !== row.sizeBytes) {
        item.contentState = 'hash-mismatch';
        item.contentError = `本地副本大小 ${info.size} 字节与发现记录 ${row.sizeBytes} 字节不一致，不能当作同一版本`;
        return item;
      }
    } catch (error) {
      item.contentState = error instanceof Error && /不存在/.test(error.message) ? 'copy-missing' : 'unreadable';
      item.contentError = error instanceof Error ? error.message : String(error);
      return item;
    }
    // Reading every post body on a feed refresh is bounded: beyond the budget
    // the row still stays recognizable by its versioned path and can be read
    // from the detail page, but no title/summary is invented from the path.
    if (budget.reads >= 40 || budget.bytes >= 8 * 1024 * 1024 || row.sizeBytes > 512 * 1024) {
      item.contentState = 'downloaded-unverified';
      item.contentError = '本次只读取了有界数量的帖子正文；打开详情时会再核对。';
      return item;
    }
    budget.reads += 1;
    budget.bytes += row.sizeBytes;
    try {
      const post = await readDiscoveryPost(this.dataDir, row);
      item.title = post.title;
      item.summary = post.summary;
      item.tags = [...post.tags];
      item.publishedAt = post.publishedAt;
      item.authorKind = post.authorKind;
      item.authorName = post.authorName;
      item.images = postImagesFromPost(post, row.path);
      return item;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A well-formed file that is not a versioned post (wrong schema,
      // reserved-looking path, invalid author) is not a Feed item; count it as
      // ignored instead of disguising it as a text post.
      if (!/不存在|大小|哈希/.test(message)) return null;
      item.contentState = /大小|哈希/.test(message) ? 'hash-mismatch' : 'copy-missing';
      item.contentError = message;
      return item;
    }
  }

  private discoveriesSnapshot(session: PanelSession, familiar: boolean): UiDiscoveries {
    const state = session.discoveries.get(familiar ? 'familiar' : 'all') ?? this.emptyDiscoveriesState(familiar);
    return {
      items: state.items.map((item) => ({ ...item, sources: [...item.sources], tags: [...item.tags] })),
      at: state.at > 0 ? state.at : null,
      error: state.error,
      errorAt: state.errorAt > 0 ? state.errorAt : null,
      freshness: this.listFreshness(state.at, state.error, state.items.length > 0, state.streamEpoch, DISCOVERY_FRESH_MS),
      familiar,
      scanned: state.scanned,
      truncated: state.truncated,
      relationComplete: state.relationComplete,
      ignored: state.ignored,
    };
  }

  async discoveryContent(sessionId: string, id: string): Promise<UiDiscoveryContent> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const wanted = typeof id === 'string' ? id : String(id ?? '');
    let row: UiDiscoveryItem | null = null;
    for (const state of session.discoveries.values()) {
      const found = state.items.find((item) => item.id === wanted);
      if (found) { row = found; break; }
    }
    if (row === null) throw new Error('没有找到这条公开内容，请先刷新动态');
    const base: UiDiscoveryContent = {
      ok: false,
      status: 'error',
      kind: row.kind,
      mime: row.mime,
      title: row.title,
      text: '',
      html: '',
      dataUrl: '',
      warnings: [],
      missingResources: [],
      error: '',
      post: null,
      subject: 'discovery',
      id: row.id,
      peerId: row.peerId,
      path: row.path,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      source: row.source,
      sources: [...row.sources],
      fetchedAt: row.fetchedAt,
      localCopy: row.contentState === 'available' ? 'downloaded-unverified' : row.contentState,
      acquisition: 'none',
      discoveryRecorded: false,
      discoveryError: '',
    };
    if (row.contentState !== 'available' && row.contentState !== 'downloaded-unverified') {
      return {
        ...base,
        localCopy: row.contentState,
        status: row.contentState === 'copy-missing' ? 'copy-missing'
          : row.contentState === 'hash-mismatch' ? 'hash-mismatch' : 'error',
        error: row.contentError || '本地副本不可读取',
      };
    }
    const type = fileTypeOf(row.path);
    if (!type.previewable) {
      try {
        const actual = await hashDownloadedFile(this.dataDir, row.peerId, row.path, MAX_LOCAL_COPY_HASH);
        if (actual.sha256 !== row.sha256.toLowerCase() || actual.size !== row.sizeBytes) {
          return {
            ...base,
            status: 'hash-mismatch',
            localCopy: 'hash-mismatch',
            error: '本地副本的 SHA-256/大小与发现记录不一致；不会当作同一版本。',
          };
        }
      } catch (error) {
        const message = errorMessage(error);
        const status = /不存在/.test(message) ? 'copy-missing' : 'error';
        return { ...base, status, localCopy: status === 'copy-missing' ? 'copy-missing' : 'unreadable', error: message };
      }
      return {
        ...base,
        status: 'unsupported',
        localCopy: 'available',
        acquisition: 'local-copy',
        error: `${row.path} 是 ${type.mime} 文件；原件已保存在本机，可使用“在文件夹中显示”定位，不加载该格式预览。`,
      };
    }
    const limit = maxPreviewRead(type.kind);
    let data: Buffer;
    try {
      data = await readDiscoveryFile(this.dataDir, row, limit);
    } catch (error) {
      const message = errorMessage(error);
      return { ...base, status: previewStatusForError(message), error: message };
    }
    const preview = await this.previewBytes('discovery', row.peerId, row.path, row.sha256, row.sizeBytes, data, {
      discoveryRecorded: false,
      discoveryError: '',
      source: row.source,
      sources: row.sources,
      fetchedAt: row.fetchedAt,
      localCopy: 'available',
      acquisition: 'local-copy',
    });
    return {
      ...base,
      ...preview,
      id: row.id,
      post: preview.post ? { ...preview.post, contentState: 'available' } : null,
    };
  }

  private async resolvePublisherNames(peerIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(peerIds.filter((value) => value.length > 0))].slice(0, 200);
    for (const peerId of unique) {
      const cached = this.publisherNameCache.get(peerId);
      if (cached && this.now() - cached.at < 5 * 60_000) {
        if (cached.name.length > 0) names.set(peerId, cached.name);
        continue;
      }
      // Discovery cards must not turn one feed read into up to hundreds of
      // remote profile downloads. Use a name already learned from a profile
      // visit or the locally downloaded profile/index.md; otherwise the card
      // keeps the short Peer ID fallback.
      const name = (await readDownloadedProfileName(this.dataDir, peerId)).trim().slice(0, 120);
      this.publisherNameCache.set(peerId, { at: this.now(), name });
      if (name.length > 0) names.set(peerId, name);
    }
    return names;
  }

  private previewFailure(
    subject: UiFilePreview['subject'],
    peerId: string,
    filePath: string,
    sha256: string,
    sizeBytes: number,
    status: UiFilePreview['status'],
    error: string,
    source = '',
    sources: string[] = [],
    fetchedAt = 0,
    localCopy: UiContentState = 'unreadable',
    acquisition: UiFilePreview['acquisition'] = 'none',
  ): UiFilePreview {
    const type = fileTypeOf(filePath);
    return {
      ok: false, status, kind: type.kind, mime: type.mime, title: titleFallback(filePath),
      text: '', html: '', dataUrl: '', warnings: [], missingResources: [], error, post: null,
      subject, peerId, path: filePath, sha256, sizeBytes, source, sources: [...sources], fetchedAt,
      localCopy, acquisition, discoveryRecorded: false, discoveryError: '',
    };
  }

  private async previewBytes(
    subject: UiFilePreview['subject'],
    peerId: string,
    filePath: string,
    sha256: string,
    sizeBytes: number,
    data: Buffer,
    options: {
      source: string;
      sources: string[];
      fetchedAt: number;
      localCopy: UiContentState;
      acquisition: UiFilePreview['acquisition'];
      discoveryRecorded: boolean;
      discoveryError: string;
    },
  ): Promise<UiFilePreview> {
    const type = fileTypeOf(filePath);
    try {
      const imageProblem = postImageBytesError(filePath, data);
      if (imageProblem.length > 0) {
        return {
          ...this.previewFailure(subject, peerId, filePath, sha256, sizeBytes, 'unsupported', imageProblem,
            options.source, options.sources, options.fetchedAt, options.localCopy, options.acquisition),
          discoveryRecorded: options.discoveryRecorded,
          discoveryError: options.discoveryError,
        };
      }
      let preview: FilePreview;
      if (type.kind === 'html') {
        preview = await buildHtmlFilePreview({ data, path: filePath, servingPeerId: peerId });
      } else if (type.kind === 'zip') {
        preview = await buildZipFilePreview({ data, path: filePath, servingPeerId: peerId });
      } else {
        preview = await buildFilePreview({ data, path: filePath, servingPeerId: peerId });
      }
      return {
        ...preview,
        ok: preview.status === 'ok' || preview.status === 'resource-error',
        subject, peerId, path: filePath, sha256, sizeBytes,
        source: options.source, sources: [...options.sources], fetchedAt: options.fetchedAt,
        localCopy: options.localCopy, acquisition: options.acquisition,
        discoveryRecorded: options.discoveryRecorded, discoveryError: options.discoveryError,
      };
    } catch (error) {
      if (error instanceof PublicFileError) {
        return {
          ...this.previewFailure(subject, peerId, filePath, sha256, sizeBytes, error.status, error.message,
            options.source, options.sources, options.fetchedAt, options.localCopy, options.acquisition),
          discoveryRecorded: options.discoveryRecorded,
          discoveryError: options.discoveryError,
        };
      }
      return {
        ...this.previewFailure(subject, peerId, filePath, sha256, sizeBytes, 'error',
          errorMessage(error), options.source, options.sources, options.fetchedAt, options.localCopy, options.acquisition),
        discoveryRecorded: options.discoveryRecorded,
        discoveryError: options.discoveryError,
      };
    }
  }

  // --- Peer public manifest, node information and manual content reads -----

  private emptyPeerManifest(peerId: string, publisherName: string, error: string): UiPeerManifest {
    return {
      peerId, publisherName: publisherName || shortPeer(peerId), entries: [], source: 'unavailable',
      at: null, error, errorAt: error.length > 0 ? this.now() : null,
      freshness: error.length > 0 ? 'unavailable' : 'loading', truncated: false, total: 0,
    };
  }

  private peerManifestSnapshot(session: PanelSession, peerId: string): UiPeerManifest {
    const state = session.peerManifests.get(peerId);
    if (!state) return this.emptyPeerManifest(peerId, '', '正在读取对方公开清单');
    const data = state.data;
    const freshness = this.listFreshness(state.at, data.error, data.entries.length > 0, this.streamEpoch, DISCOVERY_FRESH_MS);
    return {
      ...data,
      entries: data.entries.map((entry) => ({ ...entry, sources: [...entry.sources], tags: [...entry.tags] })),
      at: data.at,
      freshness,
    };
  }

  async peerManifest(sessionId: string, peerId: string, force = false): Promise<UiPeerManifest> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) return this.emptyPeerManifest(String(peerId ?? ''), '', 'Peer ID 格式不正确。');
    const cached = session.peerManifests.get(canonical);
    if (!force && cached !== undefined && this.now() - cached.at < PROFILE_TTL_MS) {
      return this.peerManifestSnapshot(session, canonical);
    }
    await this.ensurePeerManifest(session, canonical, force);
    this.assertSessionActive(session);
    return this.peerManifestSnapshot(session, canonical);
  }

  private ensurePeerManifest(session: PanelSession, peerId: string, force: boolean): Promise<void> {
    const existing = session.peerManifestBusy.get(peerId);
    if (existing !== undefined) return existing;
    const cached = session.peerManifests.get(peerId);
    if (!force && cached !== undefined && this.now() - cached.at < PROFILE_TTL_MS) return Promise.resolve();
    const promise = this.loadPeerManifest(session, peerId).finally(() => {
      if (session.peerManifestBusy.get(peerId) === promise) session.peerManifestBusy.delete(peerId);
    });
    session.peerManifestBusy.set(peerId, promise);
    return promise;
  }

  /** Page through the daemon's persistent discovery evidence and keep rows
   * for one peer. This is the restart-safe fallback for an offline peer. */
  private async loadDiscoveryEvidence(peerId: string): Promise<{ rows: DiscoveryEvidenceRow[]; truncated: boolean }> {
    const target = canonicalPeerId(peerId) ?? peerId;
    const rows: DiscoveryEvidenceRow[] = [];
    let before = '';
    let truncated = false;
    let more = false;
    for (let pages = 0; pages < 50 && rows.length < MAX_DISCOVERY_SCAN; pages += 1) {
      const response = await this.api.call(
        (client) => client.listDiscoveries(
          new ListDiscoveriesRequest({ limit: DISCOVERY_PAGE_LIMIT, before, peerId: target }),
          { timeoutMs: 4000 },
        ),
        '读取本机公开内容获取记录',
      );
      const page = response.discoveries ?? [];
      for (const raw of page) {
        if (rows.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
        const rowPeer = String(raw.peerId ?? '');
        if ((canonicalPeerId(rowPeer) ?? rowPeer) !== target) continue;
        const source = String(raw.source ?? '');
        const sources = (raw.sources ?? []).map((value) => String(value ?? '')).filter((value) => value.length > 0);
        rows.push({
          id: String(raw.id ?? ''),
          peerId: target,
          path: String(raw.path ?? ''),
          sha256: String(raw.sha256 ?? '').toLowerCase(),
          sizeBytes: numberOf(raw.sizeBytes),
          fetchedAt: numberOf(raw.fetchedAtUnixMs),
          source,
          sources: sources.length > 0 ? sources : (source.length > 0 ? [source] : []),
        });
      }
      more = response.hasMore === true;
      if (!more) break;
      const next = String(response.nextBefore ?? '');
      if (next.length === 0 || next === before) {
        throw new Error('公开内容获取记录分页游标没有前进，无法确认已完整读取');
      }
      before = next;
      if (rows.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
    }
    if (more) truncated = true;
    return { rows, truncated };
  }

  private peerFileEntry(
    peerId: string,
    publisherName: string,
    row: {
      path: string;
      sha256: string;
      sizeBytes: number;
      modifiedAt: number;
      fetchedAt: number;
      source: string;
      sources: string[];
      contentState: UiContentState;
      contentError: string;
      images?: UiPostImage[];
    },
  ): UiPeerFile {
    const type = fileTypeOf(row.path);
    return {
      id: `${peerId}\u0000${row.sha256}\u0000${row.path}`,
      peerId,
      publisherName,
      path: row.path,
      name: path.posix.basename(row.path),
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      fetchedAt: row.fetchedAt,
      source: row.source,
      sources: [...row.sources],
      kind: type.kind,
      mime: type.mime,
      previewable: type.previewable,
      title: titleFallback(row.path),
      summary: '',
      tags: [],
      publishedAt: '',
      authorKind: '',
      authorName: '',
      images: row.images?.map((image) => ({ ...image })) ?? [],
      contentState: row.contentState,
      contentError: row.contentError,
    };
  }

  /** Rebuild a partial manifest only from local copies whose bytes match a
   * recorded discovery hash. It is explicitly history, not a current list. */
  private async localHistoryEntries(
    peerId: string,
    publisherName: string,
    rows: DiscoveryEvidenceRow[],
  ): Promise<{ entries: UiPeerFile[]; truncated: boolean }> {
    const byPath = new Map<string, DiscoveryEvidenceRow[]>();
    for (const row of rows) {
      if (row.path.length === 0) continue;
      const list = byPath.get(row.path) ?? [];
      list.push(row);
      byPath.set(row.path, list);
    }
    const entries: UiPeerFile[] = [];
    let truncated = false;
    for (const [filePath, candidates] of [...byPath.entries()].sort((left, right) => {
      const leftAt = Math.max(...left[1].map((row) => row.fetchedAt));
      const rightAt = Math.max(...right[1].map((row) => row.fetchedAt));
      return rightAt - leftAt || left[0].localeCompare(right[0]);
    })) {
      if (entries.length >= MAX_DISCOVERY_PARSE) { truncated = true; break; }
      let version;
      try {
        version = await hashDownloadedFile(this.dataDir, peerId, filePath, MAX_LOCAL_COPY_HASH);
      } catch (error) {
        // Missing copies are not list entries. An oversized or unreadable copy
        // makes the reconstructed history explicitly incomplete.
        if (!/不存在/.test(errorMessage(error))) truncated = true;
        continue;
      }
      const matched = candidates
        .sort((left, right) => right.fetchedAt - left.fetchedAt)
        .find((row) => row.sizeBytes === version.size && row.sha256 === version.sha256);
      if (!matched) continue;
      entries.push(this.peerFileEntry(peerId, publisherName, {
        path: filePath,
        sha256: matched.sha256,
        sizeBytes: matched.sizeBytes,
        modifiedAt: version.modifiedAt,
        fetchedAt: matched.fetchedAt,
        source: matched.source || 'local-copy',
        sources: matched.sources.length > 0 ? matched.sources : ['local-copy'],
        contentState: 'available',
        contentError: '',
      }));
    }
    return { entries, truncated };
  }

  /** Add honest local-copy state to a current remote manifest. Small copies
   * are hash-verified; larger or over-budget copies stay marked unverified. */
  private async decorateRemoteEntries(
    peerId: string,
    entries: UiPeerFile[],
    rows: DiscoveryEvidenceRow[],
  ): Promise<void> {
    const byPath = new Map<string, DiscoveryEvidenceRow[]>();
    for (const row of rows) {
      const list = byPath.get(row.path) ?? [];
      list.push(row);
      byPath.set(row.path, list);
    }
    let hashedBytes = 0;
    for (const entry of entries) {
      const candidates = (byPath.get(entry.path) ?? [])
        .sort((left, right) => right.fetchedAt - left.fetchedAt);
      let info;
      try {
        info = await downloadedFileInfo(this.dataDir, peerId, entry.path);
      } catch (error) {
        const missing = error instanceof Error && /不存在/.test(error.message);
        if (missing) {
          entry.contentState = candidates.length > 0 ? 'copy-missing' : 'not-downloaded';
          entry.contentError = candidates.length > 0
            ? '本机获取记录存在，但下载副本已缺失；不会当作可读。'
            : '本机尚未下载这个文件；展开后可手动获取。';
        } else {
          entry.contentState = 'unreadable';
          entry.contentError = error instanceof Error ? error.message : String(error);
        }
        entry.source = 'peer-manifest';
        entry.sources = ['peer-manifest'];
        entry.fetchedAt = 0;
        continue;
      }
      if (info.size !== entry.sizeBytes) {
        entry.contentState = 'hash-mismatch';
        entry.contentError = `本地副本大小 ${info.size} 字节与对方当前清单 ${entry.sizeBytes} 字节不一致，不能当作同一版本。`;
        continue;
      }
      const proven = candidates.find((row) => row.sizeBytes === info.size && row.sha256 === entry.sha256.toLowerCase());
      const attach = (state: UiContentState, error: string) => {
        entry.contentState = state;
        entry.contentError = error;
        entry.source = proven?.source || 'local-copy';
        entry.sources = proven?.sources.length ? [...proven.sources] : ['local-copy'];
        entry.fetchedAt = proven?.fetchedAt ?? 0;
      };
      if (info.size > MAX_MANIFEST_HASH_FILE || hashedBytes + info.size > MAX_MANIFEST_HASH_TOTAL) {
        attach('downloaded-unverified', '本地有副本；版本较大，阅读或定位时会完整核对，当前不当作已验证。');
        continue;
      }
      hashedBytes += info.size;
      try {
        const actual = await hashDownloadedFile(this.dataDir, peerId, entry.path, MAX_LOCAL_COPY_HASH);
        if (actual.size !== entry.sizeBytes || actual.sha256 !== entry.sha256.toLowerCase()) {
          entry.contentState = 'hash-mismatch';
          entry.contentError = '本地副本的 SHA-256 与对方当前清单不一致；不会展示或定位为新版本。';
          continue;
        }
        attach('available', '');
      } catch (error) {
        entry.contentState = 'unreadable';
        entry.contentError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private async loadPeerManifest(session: PanelSession, peerId: string): Promise<void> {
    const at = this.now();
    const previous = session.peerManifests.get(peerId);
    const publisherName = session.peerProfiles.get(peerId)?.data.remoteName
      || this.publisherNameCache.get(peerId)?.name
      || (await readDownloadedProfileName(this.dataDir, peerId))
      || shortPeer(peerId);
    let remoteError: string | null = null;
    try {
      await this.ensureReady();
      const entries: UiPeerFile[] = [];
      let offset = 0;
      let total = 0;
      let truncated = false;
      for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
        const response = await this.api.call(
          (client) => client.getPeerManifest(
            new GetPeerManifestRequest({ peerId, offset, limit: 100 }),
            { timeoutMs: 8000 },
          ),
          '读取对方公开清单',
        );
        total = numberOf(response.total);
        const page = response.entries ?? [];
        for (const entry of page) {
          if (entries.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
          const filePath = String(entry.path ?? '');
          if (filePath.length === 0) continue;
          entries.push(this.peerFileEntry(peerId, publisherName, {
            path: filePath,
            sha256: String(entry.sha256 ?? ''),
            sizeBytes: numberOf(entry.size),
            modifiedAt: numberOf(entry.modifiedUnixMs),
            fetchedAt: 0,
            source: 'peer-manifest',
            sources: ['peer-manifest'],
            contentState: 'not-downloaded',
            contentError: '',
          }));
        }
        if (response.limited === true) truncated = true;
        offset += page.length;
        if (page.length === 0 || offset >= total) break;
        if (entries.length >= MAX_DISCOVERY_SCAN) { truncated = true; break; }
      }
      let evidence: { rows: DiscoveryEvidenceRow[]; truncated: boolean } = { rows: [], truncated: false };
      try {
        evidence = await this.loadDiscoveryEvidence(peerId);
      } catch {
        // The remote manifest is still usable. Without evidence, local copies
        // can still be stat/hash-checked below but keep unknown provenance.
      }
      await this.decorateRemoteEntries(peerId, entries, evidence.rows);
      if (!this.isSessionActive(session)) return;
      session.peerManifests.set(peerId, {
        at,
        data: {
          peerId, publisherName, entries, source: 'remote', at, error: null, errorAt: null,
          freshness: 'live', truncated: truncated || evidence.truncated || entries.length < total, total,
        },
      });
      return;
    } catch (error) {
      remoteError = errorMessage(error);
    }
    if (!this.isSessionActive(session)) return;
    let evidence: { rows: DiscoveryEvidenceRow[]; truncated: boolean } = { rows: [], truncated: false };
    let evidenceError = '';
    try {
      evidence = await this.loadDiscoveryEvidence(peerId);
    } catch (error) {
      evidenceError = errorMessage(error);
    }
    const local = await this.localHistoryEntries(peerId, publisherName, evidence.rows);
    if (!this.isSessionActive(session)) return;
    if (local.entries.length > 0) {
      const message = `对方当前公开清单读取失败：${remoteError}。以下仅为本机已核对的历史下载副本，不是当前远端完整清单。`;
      session.peerManifests.set(peerId, {
        at,
        data: {
          peerId, publisherName, entries: local.entries, source: 'local-history', at,
          error: evidenceError.length > 0 ? `${message} 获取记录读取也失败：${evidenceError}` : message,
          errorAt: this.now(), freshness: 'stale',
          truncated: local.truncated || evidence.truncated, total: local.entries.length,
        },
      });
      return;
    }
    if (previous !== undefined) {
      previous.data = {
        ...previous.data,
        error: `对方当前公开清单读取失败：${remoteError}；本机也没有可核对的同版本副本。`,
        errorAt: this.now(),
      };
      return;
    }
    const message = evidenceError.length > 0
      ? `对方当前公开清单读取失败：${remoteError}。读取本机获取记录也失败：${evidenceError}`
      : `对方当前公开清单读取失败：${remoteError}；本机没有该节点已核对的历史下载副本。`;
    session.peerManifests.set(peerId, {
      at,
      data: { ...this.emptyPeerManifest(peerId, publisherName, message), at, source: 'unavailable' },
    });
  }

  private peerNodeSnapshot(session: PanelSession, peerId: string): UiPeerNodeInfo {
    const status = session.status;
    const freshness = this.freshnessOf(session);
    const links = status?.connections.filter((connection) => connection.peerId === peerId) ?? [];
    const peerRecord = status?.peers.find((peer) => peer.peerId === peerId) ?? null;
    const friend = session.friends.find((row) => row.peerId === peerId);
    const cached = status?.peerCache.filter((peer) => peer.peerId === peerId) ?? [];
    const current: UiPeerAddress[] = [];
    const known: UiPeerAddress[] = [];
    const currentValues = new Set<string>();
    const add = (
      list: UiPeerAddress[],
      raw: string,
      source: UiPeerAddress['source'],
      sourceDetail: string,
      reachability: UiPeerAddress['reachability'],
      observedAt: number | null,
    ) => {
      const value = withPeerSuffix(String(raw ?? ''), peerId);
      if (value.length === 0) return;
      if (list === known && currentValues.has(value)) return;
      if (list.some((item) => item.multiaddr === value && item.source === source)) return;
      list.push({ multiaddr: value, source, sourceDetail, reachability, observedAt });
    };
    for (const link of links) {
      const value = withPeerSuffix(String(link.remoteMultiaddr ?? ''), peerId);
      if (value.length === 0) continue;
      currentValues.add(value);
      add(current, value, 'connection', link.route || link.transport || 'status', freshness === 'live' ? 'verified' : 'unverified', session.statusAt);
    }
    // PeerStatus.Addrs merges active connection addresses, libp2p peerstore
    // addresses and persisted cache hints. It is not proof that the peer
    // announced these addresses, so never label them "announced".
    if (peerRecord) {
      for (const address of peerRecord.addrs) {
        add(known, address, 'peerstore', 'peerstore', 'unverified', session.statusAt);
      }
    }
    for (const cacheRow of cached) {
      for (const address of cacheRow.addrs) {
        add(known, address, 'cache', String(cacheRow.source ?? ''), 'unverified', numberOf(cacheRow.updatedAt));
      }
    }
    for (const address of friend?.addrs ?? []) {
      add(known, address, 'contact', 'contact', 'unverified', friend ? numberOf(friend.lastInteractionUnixMs) : null);
    }
    const connectionState = freshness === 'live'
      ? (links.length > 0 ? 'connected' : 'disconnected')
      : 'unknown';
    return {
      peerId,
      connectionState,
      directConnections: freshness === 'live' ? links.filter((connection) => connection.route === 'direct').length : 0,
      relayConnections: freshness === 'live' ? links.filter((connection) => connection.route === 'relay').length : 0,
      currentAddresses: current,
      knownAddresses: known,
      statusAt: session.statusAt > 0 ? session.statusAt : null,
      freshness,
      error: session.error,
    };
  }

  async peerNodeInfo(sessionId: string, peerId: string, force = false): Promise<UiPeerNodeInfo> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) {
      return {
        peerId: String(peerId ?? ''), connectionState: 'unknown', directConnections: 0, relayConnections: 0,
        currentAddresses: [], knownAddresses: [], statusAt: null, freshness: 'unavailable', error: 'Peer ID 格式不正确。',
      };
    }
    if (force || session.statusAt === 0 || this.now() - session.statusAt > this.statusTtlMs) {
      await this.reconcileStatus('peer-node-info', { trailing: true });
    }
    this.assertSessionActive(session);
    return this.peerNodeSnapshot(session, canonical);
  }

  async peerFilePreview(
    sessionId: string,
    peerId: string,
    filePath: string,
    expectedSha: string,
    expectedSize: number,
  ): Promise<UiFilePreview> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) return this.previewFailure('peer', String(peerId ?? ''), filePath, expectedSha, expectedSize, 'error', 'Peer ID 格式不正确。');
    const wanted = typeof filePath === 'string' ? filePath : '';
    if (wanted.length === 0) return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'error', '缺少公开文件路径。');
    // Favorites identify one historical version. If that exact version is
    // retained locally, read it before any manifest/dial attempt: a local
    // post must never dial itself, and an offline peer with the exact copy must
    // stay readable. A missing or different copy falls through to the normal
    // current-manifest path and is never shown under the requested hash.
    const requestedSha = validSha256(expectedSha);
    if (requestedSha !== '' && expectedSize <= 0) {
      try {
        const exact = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_LOCAL_COPY_HASH);
        if (exact.sha256 === requestedSha && (expectedSize <= 0 || exact.size === expectedSize)) {
          const exactType = fileTypeOf(wanted);
          if (!exactType.previewable) {
            return this.previewFailure('peer', canonical, wanted, requestedSha, exact.size, 'unsupported',
              `${wanted} 是 ${exactType.mime} 文件；原件已保存在本机，可使用“在文件夹中显示”定位，不加载 PDF/Office 预览库。`,
              'local-copy', ['local-copy'], 0, 'available', 'local-copy');
          }
          const exactLimit = maxPreviewRead(exactType.kind);
          if (exact.size > exactLimit) {
            return this.previewFailure('peer', canonical, wanted, requestedSha, exact.size, 'unsupported',
              `${wanted} 超过 ${exactLimit} 字节的预览上限；原件已保存在本机，可使用“在文件夹中显示”定位。`,
              'local-copy', ['local-copy'], 0, 'available', 'local-copy');
          }
          const exactData = await readDownloadedFile(this.dataDir, canonical, wanted, exactLimit);
          if (exactData.length !== exact.size || createHash('sha256').update(exactData).digest('hex') !== requestedSha) {
            return this.previewFailure('peer', canonical, wanted, requestedSha, exactData.length, 'hash-mismatch',
              '读取本地副本时文件已变化；没有展示新的字节。', 'local-copy', ['local-copy'], 0, 'hash-mismatch', 'local-copy');
          }
          return await this.previewBytes('peer', canonical, wanted, requestedSha, exact.size, exactData, {
            source: 'local-copy', sources: ['local-copy'], fetchedAt: 0,
            localCopy: 'available', acquisition: 'local-copy',
            discoveryRecorded: false, discoveryError: '',
          });
        }
      } catch {
        // Missing or unreadable local copies fall through to the explicit
        // manifest/local-history error paths below.
      }
    }
    await this.ensurePeerManifest(session, canonical, false);
    const manifest = session.peerManifests.get(canonical)?.data;
    let entry = manifest?.entries.find((item) => item.path === wanted);
    if (!entry && manifest?.source !== 'remote') {
      // Local-history only lists paths with discovery rows. A post metadata or
      // image may have been downloaded by a card read without creating one;
      // allow it only when the exact requested SHA-256/size is on disk.
      const localSha = validSha256(expectedSha);
      if (localSha !== '') {
        try {
          const local = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_LOCAL_COPY_HASH);
          if (local.sha256 === localSha && (expectedSize <= 0 || local.size === expectedSize)) {
            entry = this.peerFileEntry(canonical, manifest?.publisherName ?? shortPeer(canonical), {
              path: wanted,
              sha256: localSha,
              sizeBytes: local.size,
              modifiedAt: local.modifiedAt,
              fetchedAt: 0,
              source: 'local-copy',
              sources: ['local-copy'],
              contentState: 'available',
              contentError: '',
            });
          }
        } catch {
          // Missing or unreadable local copies still return the explicit
          // local-history reason below.
        }
      }
    }
    if (!entry) {
      const reason = manifest?.source === 'remote'
        ? '该文件不在对方当前公开清单中，未发起下载。'
        : '本机没有与请求版本一致的历史下载副本；对方离线时不发起新的下载。';
      return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'error', reason);
    }
    if (expectedSha.length > 0 && expectedSha.toLowerCase() !== entry.sha256.toLowerCase()) {
      return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'hash-mismatch', '对方清单中的版本已变化；没有展示新的内容。');
    }
    if (expectedSize > 0 && expectedSize !== entry.sizeBytes) {
      return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'hash-mismatch', '对方清单中的大小已变化；没有展示新的内容。');
    }
    const type = fileTypeOf(wanted);
    const versionSha = entry.sha256.toLowerCase();
    // Embedded post images are part of an already authorized post read. They
    // are still hash/size checked, but loading a thumbnail must not create a
    // separate discovery row for an internal image file.
    const embeddedPostImage = isPostImagePublicPath(wanted);
    const source = entry.source;
    const sources = [...entry.sources];
    const fetchedAt = entry.fetchedAt;
    let localState: UiContentState = 'unreadable';
    let localError = '';
    let localVersion: Awaited<ReturnType<typeof hashDownloadedFile>> | null = null;
    try {
      localVersion = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_LOCAL_COPY_HASH);
    } catch (error) {
      const message = errorMessage(error);
      if (/不存在/.test(message)) {
        localState = entry.contentState === 'copy-missing' ? 'copy-missing' : 'not-downloaded';
        localError = entry.contentState === 'copy-missing'
          ? '本机获取记录存在，但下载副本已缺失；不会伪装成本地阅读。'
          : '本机尚未下载这个文件；没有把它当作已有副本。';
      } else {
        localState = 'unreadable';
        localError = message;
      }
    }
    if (localVersion !== null) {
      if (localVersion.size !== entry.sizeBytes || localVersion.sha256 !== versionSha) {
        localState = 'hash-mismatch';
        localError = '本地副本的 SHA-256/大小与请求版本不一致；不会展示或定位为旧版本。';
      } else {
        localState = 'available';
      }
    }
    // An explicit version request that still matches the current manifest but
    // whose local copy has changed must be reported, not silently replaced by
    // a fresh download. This is what makes a checksum-failed public file
    // visible instead of hiding the problem behind new bytes.
    if (requestedSha !== '' && localState === 'hash-mismatch'
      && localVersion !== null && localVersion.size === entry.sizeBytes) {
      return this.previewFailure(
        'peer', canonical, wanted, versionSha, entry.sizeBytes, 'hash-mismatch',
        '本地副本的 SHA-256/大小与所请求版本不一致；不会通过重新获取覆盖本地副本。',
        source, sources, fetchedAt, 'hash-mismatch', 'none',
      );
    }
    if (localState === 'available') {
      if (!type.previewable) {
        return this.previewFailure(
          'peer', canonical, wanted, versionSha, entry.sizeBytes, 'unsupported',
          `${wanted} 是 ${type.mime} 文件；原件已保存在本机，可使用“在文件夹中显示”定位，不加载 PDF/Office 预览库。`,
          source, sources, fetchedAt, 'available', 'local-copy',
        );
      }
      const limit = maxPreviewRead(type.kind);
      if (entry.sizeBytes > limit) {
        return this.previewFailure(
          'peer', canonical, wanted, versionSha, entry.sizeBytes, 'unsupported',
          `${wanted} 超过 ${limit} 字节的预览上限；原件已保存在本机，可使用“在文件夹中显示”定位。`,
          source, sources, fetchedAt, 'available', 'local-copy',
        );
      }
      try {
        const data = await readDownloadedFile(this.dataDir, canonical, wanted, limit);
        if (localVersion === null || data.length !== localVersion.size || createHash('sha256').update(data).digest('hex') !== versionSha) {
          return this.previewFailure('peer', canonical, wanted, versionSha, data.length, 'hash-mismatch',
            '读取本地副本时文件已变化；没有展示新的字节。', source, sources, fetchedAt, 'hash-mismatch', 'local-copy');
        }
        return await this.previewBytes('peer', canonical, wanted, versionSha, entry.sizeBytes, data, {
          source, sources, fetchedAt,
          localCopy: 'available', acquisition: 'local-copy',
          discoveryRecorded: false, discoveryError: '',
        });
      } catch (error) {
        const message = errorMessage(error);
        return this.previewFailure('peer', canonical, wanted, versionSha, entry.sizeBytes,
          previewStatusForError(message), message, source, sources, fetchedAt, 'available', 'local-copy');
      }
    }
    if (manifest?.source !== 'remote') {
      const status = localState === 'hash-mismatch' ? 'hash-mismatch'
        : localState === 'copy-missing' ? 'copy-missing'
          : localState === 'unreadable' ? 'error' : 'copy-missing';
      return this.previewFailure(
        'peer', canonical, wanted, versionSha, entry.sizeBytes, status,
        localError || '对方离线，且本机没有可核对的同一版本副本；没有发起新的下载。',
        source, sources, fetchedAt, localState, 'none',
      );
    }
    // Only a current remote manifest authorizes a new network acquisition.
    // A local-history list never pretends the peer is reachable.
    try {
      const last = await this.downloadPeerFile(
        canonical,
        wanted,
        { recordDiscovery: !embeddedPostImage, discoverySource: 'raminga_ui_manual', timeoutMs: 60_000 },
        '手动获取公开文件',
      );
      if (last === null || last.phase !== 'complete' || last.error.length > 0) {
        return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'resource-error',
          last?.error || '公开文件下载没有完成。', 'raminga_ui_manual', ['raminga_ui_manual'], this.now(), localState, 'none');
      }
      if (last.path !== wanted) {
        return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize, 'hash-mismatch',
          '下载结果的公开路径与请求不一致；没有展示其他文件。', 'raminga_ui_manual', ['raminga_ui_manual'], this.now(), localState, 'none');
      }
      if (last.sha256.toLowerCase() !== versionSha) {
        return this.previewFailure('peer', canonical, wanted, versionSha, last.totalBytes, 'hash-mismatch',
          '对方在清单读取后替换了该文件；没有展示新版本。', 'raminga_ui_manual', ['raminga_ui_manual'], this.now(), localState, 'none');
      }
      const actual = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_LOCAL_COPY_HASH);
      if (actual.sha256 !== versionSha || actual.size !== last.totalBytes) {
        return this.previewFailure('peer', canonical, wanted, versionSha, last.totalBytes, 'hash-mismatch',
          '下载后的本地字节与清单版本不一致；没有展示。', 'raminga_ui_manual', ['raminga_ui_manual'], this.now(), 'hash-mismatch', 'downloaded');
      }
      const fetchedNow = this.now();
      entry.contentState = 'available';
      entry.contentError = '';
      entry.source = 'raminga_ui_manual';
      entry.sources = ['raminga_ui_manual'];
      entry.fetchedAt = fetchedNow;
      if (!embeddedPostImage) for (const state of session.discoveries.values()) state.at = 0;
      if (!type.previewable) {
        return {
          ...this.previewFailure(
            'peer', canonical, wanted, versionSha, actual.size, 'unsupported',
            `${wanted} 是 ${type.mime} 文件；本次已手动获取并核对原件，可使用“在文件夹中显示”定位，不加载 PDF/Office 预览库。`,
            'raminga_ui_manual', ['raminga_ui_manual'], fetchedNow, 'available', 'downloaded',
          ),
          discoveryRecorded: last.discoveryRecorded,
          discoveryError: last.discoveryError,
        };
      }
      const limit = maxPreviewRead(type.kind);
      if (actual.size > limit) {
        return {
          ...this.previewFailure(
            'peer', canonical, wanted, versionSha, actual.size, 'unsupported',
            `${wanted} 超过 ${limit} 字节的预览上限；本次已手动获取并核对原件，可使用“在文件夹中显示”定位。`,
            'raminga_ui_manual', ['raminga_ui_manual'], fetchedNow, 'available', 'downloaded',
          ),
          discoveryRecorded: last.discoveryRecorded,
          discoveryError: last.discoveryError,
        };
      }
      const data = await readDownloadedFile(this.dataDir, canonical, wanted, limit);
      if (data.length !== actual.size || createHash('sha256').update(data).digest('hex') !== versionSha) {
        return this.previewFailure('peer', canonical, wanted, versionSha, data.length, 'hash-mismatch',
          '读取刚下载的副本时文件已变化；没有展示新的字节。', 'raminga_ui_manual', ['raminga_ui_manual'], fetchedNow, 'hash-mismatch', 'downloaded');
      }
      return await this.previewBytes('peer', canonical, wanted, versionSha, actual.size, data, {
        source: 'raminga_ui_manual', sources: ['raminga_ui_manual'], fetchedAt: fetchedNow,
        localCopy: 'available', acquisition: 'downloaded',
        discoveryRecorded: last.discoveryRecorded, discoveryError: last.discoveryError,
      });
    } catch (error) {
      const message = errorMessage(error);
      const status = previewStatusForError(message);
      return this.previewFailure('peer', canonical, wanted, expectedSha, expectedSize,
        status === 'error' ? 'resource-error' : status, message,
        'raminga_ui_manual', ['raminga_ui_manual'], this.now(), localState, 'none');
    }
  }

  /**
   * Read the bounded v2 post metadata needed to paint card images before the
   * reader expands the post. It reuses the exact controlled copy/preview path:
   * a verified local download is preferred, and a current remote manifest may
   * authorize one metadata download. It never records a discovery row for the
   * metadata or the embedded images.
   */
  async peerPostMeta(
    sessionId: string,
    peerId: string,
    filePath: string,
    expectedSha: string,
    expectedSize: number,
  ): Promise<UiPostMeta> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const wanted = typeof filePath === 'string' ? filePath : '';
    const empty = (error: string): UiPostMeta => ({
      found: false, path: wanted, sha256: '', title: '', summary: '', tags: [],
      publishedAt: '', authorKind: 'unknown', authorName: '', images: [], error,
    });
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) return empty('Peer ID 格式不正确。');
    if (!isV2PostPath(wanted)) return empty('只有 posts/<id>/post.json 的 v2 图文动态包含配图。');
    await this.ensureReady();
    const manifest = session.peerManifests.get(canonical)?.data;
    const entry = manifest?.entries.find((item) => item.path === wanted);
    let expected = validSha256(expectedSha) || validSha256(entry?.sha256);
    let size = Number.isSafeInteger(expectedSize) && expectedSize > 0 ? expectedSize : (entry?.sizeBytes ?? 0);
    if (expected === '' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_POST_BYTES) {
      return empty('这条动态的版本信息不完整或超过读取上限，无法核对配图。');
    }
    if (entry) {
      const entrySha = validSha256(entry.sha256);
      if (entrySha !== '' && entrySha !== expected) return empty('对方动态版本已变化；没有读取新的配图信息。');
      if (entry.sizeBytes > 0 && entry.sizeBytes !== size) return empty('对方动态大小已变化；没有读取新的配图信息。');
    }
    let data: Buffer | null = null;
    let localError = '';
    try {
      const local = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_POST_BYTES);
      if (local.size !== size || local.sha256 !== expected) {
        localError = '本机动态副本的 SHA-256/大小与请求版本不一致，不会当作同一版本。';
      } else {
        data = await readDownloadedFile(this.dataDir, canonical, wanted, MAX_POST_BYTES);
        if (data.length !== size || createHash('sha256').update(data).digest('hex') !== expected) {
          data = null;
          localError = '读取本机动态副本时文件已变化；没有展示新的内容。';
        }
      }
    } catch (error) {
      localError = errorMessage(error);
    }
    if (data === null) {
      if (manifest?.source !== 'remote' || entry === undefined) {
        return empty(localError || '本机没有这条动态的已核对副本，且对方当前清单不可用。');
      }
      try {
        const last = await this.downloadPeerFile(
          canonical,
          wanted,
          { recordDiscovery: false, timeoutMs: 8000 },
          '读取动态配图信息',
        );
        if (last === null || last.phase !== 'complete' || last.error.length > 0) {
          return empty(last?.error || '动态配图信息下载没有完成。');
        }
        if (last.path !== wanted || last.sha256.toLowerCase() !== expected) {
          return empty('对方在清单读取后替换了这条动态；没有读取新的配图。');
        }
        data = await readDownloadedFile(this.dataDir, canonical, wanted, MAX_POST_BYTES);
        if (data.length !== size || createHash('sha256').update(data).digest('hex') !== expected) {
          return empty('下载后的动态字节与清单版本不一致；没有展示配图。');
        }
      } catch (error) {
        return empty(errorMessage(error));
      }
    }
    let post: LocalPost;
    try {
      post = parsePostBytes(data, wanted, canonical);
    } catch (error) {
      return empty(error instanceof Error ? error.message : String(error));
    }
    const manifestEntries = manifest?.source === 'remote' ? manifest.entries : undefined;
    const images = postImagesFromPost(post, wanted, manifestEntries);
    if (entry) {
      entry.contentState = 'available';
      entry.contentError = '';
      entry.kind = 'markdown';
      entry.mime = 'text/markdown';
      entry.previewable = true;
      entry.fetchedAt = entry.fetchedAt > 0 ? entry.fetchedAt : this.now();
    }
    return {
      found: true,
      path: wanted,
      sha256: expected,
      title: post.title,
      summary: post.summary,
      tags: [...post.tags],
      publishedAt: post.publishedAt,
      authorKind: post.authorKind,
      authorName: post.authorName,
      images,
      error: '',
    };
  }

  async mineFilePreview(sessionId: string, filePath: string, expectedSha: string, expectedSize: number): Promise<UiFilePreview> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const wanted = typeof filePath === 'string' ? filePath : '';
    let entry = session.mine.data?.files.find((item) => item.path === wanted);
    const requestedSha = validSha256(expectedSha);
    const peerId = entry?.peerId ?? session.status?.peerId ?? '';
    if (!entry && requestedSha === '') {
      return this.previewFailure('mine', peerId, wanted, expectedSha, expectedSize, 'error',
        '该文件不在本机当前已发布清单中。', 'local-public', ['local-public'], 0, 'not-downloaded', 'none');
    }
    const type = fileTypeOf(wanted);
    let actual: Awaited<ReturnType<typeof hashPublicFile>>;
    try {
      // Read the controlled local public path directly. Favorites store an
      // exact version and must not depend on the list still being loaded, nor
      // dial the local peer to read a file this node already owns.
      actual = await hashPublicFile(this.dataDir, wanted, MAX_LOCAL_COPY_HASH);
    } catch (error) {
      const message = errorMessage(error);
      const status = /不存在/.test(message) ? 'copy-missing' : 'error';
      return this.previewFailure('mine', peerId, wanted, requestedSha || entry?.sha256 || '',
        expectedSize || entry?.sizeBytes || 0, status, message,
        'local-public', ['local-public'], 0, status === 'copy-missing' ? 'copy-missing' : 'unreadable', 'none');
    }
    // Compare the bytes that were actually read, not just the cached list
    // hash. A same-size replacement must never display new content under an
    // old version identifier.
    if (expectedSize > 0 && actual.size !== expectedSize) {
      return this.previewFailure('mine', peerId, wanted, requestedSha || entry?.sha256 || '', actual.size, 'hash-mismatch',
        '本机公开文件实际字节大小与所请求版本不一致；没有展示。', 'local-public', ['local-public'], 0, 'hash-mismatch', 'none');
    }
    const expected = requestedSha || entry?.sha256?.toLowerCase() || '';
    if (expected === '') {
      return this.previewFailure('mine', peerId, wanted, '', actual.size, 'error',
        '缺少要核对的公开文件版本。', 'local-public', ['local-public'], 0, 'unreadable', 'none');
    }
    if (actual.sha256 !== expected) {
      return this.previewFailure('mine', peerId, wanted, expected, actual.size, 'hash-mismatch',
        '本机公开文件实际字节 SHA-256 与所请求版本不一致；没有展示新正文。', 'local-public', ['local-public'], 0, 'hash-mismatch', 'none');
    }
    if (entry) {
      entry.sha256 = actual.sha256;
      entry.sizeBytes = actual.size;
      entry.modifiedAt = actual.modifiedAt;
      entry.contentState = 'available';
      entry.contentError = '';
    }
    const source = 'local-public';
    const sources = ['local-public'];
    if (!type.previewable) {
      return this.previewFailure('mine', peerId, wanted, actual.sha256, actual.size, 'unsupported',
        `${wanted} 是 ${type.mime} 文件；本机已发布原件可使用“在文件夹中显示”定位，不加载 PDF/Office 预览库。`,
        source, sources, 0, 'available', 'local-copy');
    }
    const limit = maxPreviewRead(type.kind);
    if (actual.size > limit) {
      return this.previewFailure('mine', peerId, wanted, actual.sha256, actual.size, 'unsupported',
        `${wanted} 超过 ${limit} 字节的预览上限；本机已发布原件可使用“在文件夹中显示”定位。`,
        source, sources, 0, 'available', 'local-copy');
    }
    try {
      const data = await readPublicFile(this.dataDir, wanted, limit);
      if (data.length !== actual.size || createHash('sha256').update(data).digest('hex') !== actual.sha256) {
        return this.previewFailure('mine', peerId, wanted, actual.sha256, data.length, 'hash-mismatch',
          '读取本机公开文件时文件已变化；没有展示新的字节。', source, sources, 0, 'hash-mismatch', 'none');
      }
      return await this.previewBytes('mine', peerId, wanted, actual.sha256, actual.size, data, {
        source, sources, fetchedAt: 0,
        localCopy: 'available', acquisition: 'local-copy',
        discoveryRecorded: false, discoveryError: '',
      });
    } catch (error) {
      const message = errorMessage(error);
      return this.previewFailure('mine', peerId, wanted, actual.sha256, actual.size,
        previewStatusForError(message), message, source, sources, 0, 'available', 'local-copy');
    }
  }

  private async revealControlledPath(absolutePath: string, at: number): Promise<UiRevealResult> {
    if (!this.revealPath) {
      return { ok: false, status: 'unavailable', error: '当前宿主没有提供“在文件夹中显示”的能力。', at };
    }
    try {
      await this.revealPath(absolutePath);
      return { ok: true, status: 'revealed', error: null, at };
    } catch (error) {
      return { ok: false, status: 'error', error: errorMessage(error), at };
    }
  }

  /** Reveal one already-downloaded discovery original. The browser supplies a
   * discovery id, never a path; the resolved absolute path stays host-side. */
  async revealDiscovery(sessionId: string, id: string): Promise<UiRevealResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const at = this.now();
    let row: UiDiscoveryItem | null = null;
    for (const state of session.discoveries.values()) {
      const found = state.items.find((item) => item.id === String(id ?? ''));
      if (found) { row = found; break; }
    }
    if (row === null) return { ok: false, status: 'error', error: '没有找到这条公开内容，请先刷新动态。', at };
    if (row.contentState === 'copy-missing' || row.contentState === 'unreadable') {
      return { ok: false, status: 'missing', error: row.contentError || '本地已下载副本缺失，无法定位。', at };
    }
    let actual: Awaited<ReturnType<typeof hashDownloadedFile>>;
    try {
      actual = await hashDownloadedFile(this.dataDir, row.peerId, row.path, MAX_LOCAL_COPY_HASH);
    } catch (error) {
      return { ok: false, status: /不存在/.test(errorMessage(error)) ? 'missing' : 'error', error: errorMessage(error), at };
    }
    if (actual.sha256 !== row.sha256.toLowerCase() || actual.size !== row.sizeBytes) {
      return {
        ok: false,
        status: 'hash-mismatch',
        error: '本地副本的 SHA-256/大小与发现记录不一致；不会无提示定位为旧版本。',
        at,
      };
    }
    return this.revealControlledPath(actual.absolutePath, at);
  }

  /** Reveal one verified local original for a peer homepage file or one of the
   * user's own published files. The browser supplies peer/path/version; the
   * host re-resolves it against the current manifest or Published list and
   * verifies the actual bytes before asking the host to reveal it. */
  async revealFile(
    sessionId: string,
    subject: 'discovery' | 'peer' | 'mine',
    peerId: string,
    filePath: string,
    expectedSha: string,
    expectedSize: number,
  ): Promise<UiRevealResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const at = this.now();
    if (subject !== 'peer' && subject !== 'mine') {
      return { ok: false, status: 'error', error: '发现动态请使用内容标识定位。', at };
    }
    if (!this.revealPath) {
      return { ok: false, status: 'unavailable', error: '当前宿主没有提供“在文件夹中显示”的能力。', at };
    }
    const wanted = typeof filePath === 'string' ? filePath : '';
    if (wanted.length === 0) return { ok: false, status: 'error', error: '缺少公开文件路径。', at };
    if (subject === 'peer') {
      const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
      if (canonical === null) return { ok: false, status: 'error', error: 'Peer ID 格式不正确。', at };
      await this.ensurePeerManifest(session, canonical, false);
      const entry = session.peerManifests.get(canonical)?.data.entries.find((item) => item.path === wanted);
      if (!entry) {
        return { ok: false, status: 'not-downloaded', error: '该文件不在对方当前清单或本机历史副本中，无法定位。', at };
      }
      if (expectedSha.length > 0 && entry.sha256.length > 0 && expectedSha.toLowerCase() !== entry.sha256.toLowerCase()) {
        return { ok: false, status: 'hash-mismatch', error: '列表中的版本已变化；没有定位其他版本。', at };
      }
      if (expectedSize > 0 && entry.sizeBytes !== expectedSize) {
        return { ok: false, status: 'hash-mismatch', error: '列表中的大小已变化；没有定位其他版本。', at };
      }
      const expected = entry.sha256.toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expected)) {
        return { ok: false, status: 'error', error: '清单缺少可核对的内容哈希，无法安全定位。', at };
      }
      let actual: Awaited<ReturnType<typeof hashDownloadedFile>>;
      try {
        actual = await hashDownloadedFile(this.dataDir, canonical, wanted, MAX_LOCAL_COPY_HASH);
      } catch (error) {
        const message = errorMessage(error);
        return {
          ok: false,
          status: /不存在/.test(message) ? 'not-downloaded' : 'error',
          error: /不存在/.test(message) ? '本机尚未下载这个文件，无法定位。' : message,
          at,
        };
      }
      if (actual.sha256 !== expected || (expectedSize > 0 && actual.size !== expectedSize)) {
        return { ok: false, status: 'hash-mismatch', error: '本地副本与所请求版本不一致；没有无提示定位旧版本。', at };
      }
      return this.revealControlledPath(actual.absolutePath, at);
    }
    if (session.mine.data === null) await this.loadMine(session);
    if (!this.isSessionActive(session)) return { ok: false, status: 'error', error: '面板已关闭。', at };
    const entry = session.mine.data?.files.find((item) => item.path === wanted);
    if (!entry) return { ok: false, status: 'not-downloaded', error: '该文件不在本机当前已发布清单中，无法定位。', at };
    if (expectedSha.length > 0 && entry.sha256.length > 0 && expectedSha.toLowerCase() !== entry.sha256.toLowerCase()) {
      return { ok: false, status: 'hash-mismatch', error: '本机公开清单中的版本已变化；没有定位其他版本。', at };
    }
    if (expectedSize > 0 && entry.sizeBytes !== expectedSize) {
      return { ok: false, status: 'hash-mismatch', error: '本机公开清单中的大小已变化；没有定位其他版本。', at };
    }
    let actual: Awaited<ReturnType<typeof hashPublicFile>>;
    try {
      actual = await hashPublicFile(this.dataDir, wanted, MAX_LOCAL_COPY_HASH);
    } catch (error) {
      return { ok: false, status: /不存在/.test(errorMessage(error)) ? 'missing' : 'error', error: errorMessage(error), at };
    }
    const expected = entry.sha256.toLowerCase() || expectedSha.toLowerCase();
    if (expected.length > 0) {
      if (actual.sha256 !== expected || (expectedSize > 0 && actual.size !== expectedSize)) {
        return { ok: false, status: 'hash-mismatch', error: '本机公开文件实际字节与所请求版本不一致；没有定位。', at };
      }
    } else if (expectedSize > 0 && actual.size !== expectedSize) {
      // The Published RPC exposes path/size only. When our bounded list hash
      // budget omitted a large file's hash, the Published path and size are
      // the available current-version evidence; do not claim an old hash.
      return { ok: false, status: 'hash-mismatch', error: '本机公开文件实际大小与已发布清单不一致；没有定位。', at };
    }
    return this.revealControlledPath(actual.absolutePath, at);
  }

  /**
   * Bootstrap settings: the new daemon returns saved roles with separate online
   * and paused state. An older daemon has only the read-only DhtStatus list, so
   * it stays readable but is explicitly marked as requiring an upgrade; writes
   * never report false success.
   */
  async bootstrap(sessionId: string): Promise<UiBootstrapInfo> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.listBootstrapPeers(new ListBootstrapPeersRequest(), { timeoutMs: 4000 }),
        '读取引导节点设置',
      );
      const entries = (response.peers ?? []).map((peer) => ({
        peerId: String(peer.peerId ?? ''),
        addrs: (peer.addrs ?? []).map((value) => String(value ?? '')).filter((value) => value.length > 0),
        online: peer.online === true,
        paused: peer.paused === true,
        savedAt: Number(peer.savedAtUnixMs ?? 0) > 0 ? Number(peer.savedAtUnixMs) : null,
      })).filter((peer) => peer.peerId.length > 0);
      const peers = entries.flatMap((peer) => peer.addrs);
      return {
        at: this.now(), peers, entries, editable: true, requiresUpgrade: false, error: null,
        freshness: this.listFreshness(this.now(), null, peers.length > 0, this.streamEpoch, DISCOVERY_FRESH_MS),
        source: 'bootstrap-api',
      };
    } catch (error) {
      if (!isUnimplementedError(error)) {
        return {
          at: null, peers: [], entries: [], editable: false, requiresUpgrade: false,
          error: errorMessage(error), freshness: 'unavailable', source: 'unavailable',
        };
      }
      // Older daemon: keep the existing read-only DhtStatus view. This is an
      // upgrade notice, not a load failure and not a writable surface.
      try {
        const response = await this.api.call(
          (client) => client.dhtStatus(new DhtStatusRequest(), { timeoutMs: 4000 }),
          '读取引导节点配置',
        );
        const peers = (response.dht?.bootstrapPeers ?? []).map((value) => String(value ?? '')).filter((value) => value.length > 0);
        return {
          at: this.now(), peers, entries: [], editable: false, requiresUpgrade: true, error: null,
          freshness: this.listFreshness(this.now(), null, peers.length > 0, this.streamEpoch, DISCOVERY_FRESH_MS),
          source: 'dht-status',
        };
      } catch (fallbackError) {
        return {
          at: null, peers: [], entries: [], editable: false, requiresUpgrade: true,
          error: errorMessage(fallbackError), freshness: 'unavailable', source: 'unavailable',
        };
      }
    }
  }

  /** Add one saved bootstrap role. Persistence is the receipt; no dial wait. */
  async addBootstrap(sessionId: string, multiaddr: string): Promise<UiBootstrapEdit> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const raw = typeof multiaddr === 'string' ? multiaddr : '';
    if (raw.trim().length === 0) throw new Error('请填写包含 /p2p/<peer-id> 的节点地址。');
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.addBootstrapPeer(new AddBootstrapPeerRequest({ multiaddr: raw }), { timeoutMs: 5000 }),
        '保存引导节点',
      );
      this.assertSessionActive(session);
      return { ok: true, changed: response.added === true, error: null, requiresUpgrade: false };
    } catch (error) {
      if (isUnimplementedError(error)) {
        throw new Error('当前 daemon 版本不支持引导节点写入；请升级并重启 Raminga 节点，设置尚未保存。');
      }
      throw new Error(bootstrapErrorMessage(error) || '保存引导节点失败');
    }
  }

  /** Remove only the bootstrap role; history, addresses and pause remain. */
  async removeBootstrap(sessionId: string, peerId: string): Promise<UiBootstrapEdit> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) throw new Error('Peer ID 格式不正确。');
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.removeBootstrapPeer(new RemoveBootstrapPeerRequest({ peerId: canonical }), { timeoutMs: 5000 }),
        '移除引导节点',
      );
      this.assertSessionActive(session);
      return { ok: true, changed: response.removed === true, error: null, requiresUpgrade: false };
    } catch (error) {
      if (isUnimplementedError(error)) {
        throw new Error('当前 daemon 版本不支持引导节点写入；请升级并重启 Raminga 节点，设置尚未修改。');
      }
      throw new Error(bootstrapErrorMessage(error) || '移除引导节点失败');
    }
  }

  /** Complete stable relation snapshot used by the familiar filter. */
  async humanOutbound(sessionId: string, force = false): Promise<UiHumanOutbound> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const state = session.humanOutbound;
    const need = force || state.at === 0 || this.now() - state.at > DISCOVERY_TTL_MS;
    if (need) {
      try {
        await this.loadHumanOutbound(session, force);
      } catch (error) {
        if (this.isSessionActive(session)) {
          state.error = errorMessage(error);
          state.errorAt = this.now();
        }
      }
    }
    this.assertSessionActive(session);
    return this.humanOutboundSnapshot(session);
  }

  private async loadHumanOutbound(session: PanelSession, force: boolean): Promise<void> {
    if (session.humanOutboundBusy !== null) {
      if (!force) return session.humanOutboundBusy;
      return session.humanOutboundBusy.then(() => this.loadHumanOutbound(session, true));
    }
    const at = this.now();
    const streamEpoch = this.streamEpoch;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const result = await this.completeHumanRelations(session);
        if (!this.isSessionActive(session)) return;
        const state = session.humanOutbound;
        state.peers = [...result.peers];
        state.complete = result.complete;
        state.scanned = result.scanned;
        state.at = at;
        state.error = result.complete ? null : '人工交流关系超过本次有界读取范围，不能据此断言筛选完整';
        state.errorAt = result.complete ? 0 : this.now();
        state.streamEpoch = streamEpoch;
      } finally {
        if (session.humanOutboundBusy === promise) session.humanOutboundBusy = null;
      }
    })();
    session.humanOutboundBusy = promise;
    return promise;
  }

  private async completeHumanRelations(session: PanelSession): Promise<{ peers: Set<string>; complete: boolean; scanned: number }> {
    await this.ensureReady();
    const peers = new Set<string>();
    let before = '';
    let complete = false;
    let scanned = 0;
    let pages = 0;
    while (scanned < MAX_HUMAN_RELATION_SCAN && pages < 50) {
      pages += 1;
      const response = await this.api.call(
        (client) => client.listHumanOutboundPeers(
          new ListHumanOutboundPeersRequest({ limit: HUMAN_RELATION_PAGE_LIMIT, before }),
          { timeoutMs: 4000 },
        ),
        '读取人工交流关系',
      );
      const page = response.peers ?? [];
      for (const peer of page) {
        const id = canonicalPeerId(String(peer.peerId ?? ''));
        if (id !== null) peers.add(id);
      }
      scanned += page.length;
      if (response.hasMore !== true) { complete = true; break; }
      const next = String(response.nextBefore ?? '');
      if (next.length === 0 || next === before) {
        throw new Error('人工交流关系分页游标没有前进，无法确认已完整读取');
      }
      before = next;
      if (!this.isSessionActive(session)) break;
    }
    return { peers, complete, scanned };
  }

  private humanOutboundSnapshot(session: PanelSession): UiHumanOutbound {
    const state = session.humanOutbound;
    return {
      peers: [...state.peers],
      at: state.at > 0 ? state.at : null,
      error: state.error,
      errorAt: state.errorAt > 0 ? state.errorAt : null,
      freshness: this.listFreshness(state.at, state.error, state.peers.length > 0, state.streamEpoch, DISCOVERY_FRESH_MS),
      complete: state.complete,
      scanned: state.scanned,
    };
  }

  /** Local user profile plus every file under the live public directory. */
  async mine(sessionId: string, force = false): Promise<UiMine> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const state = session.mine;
    // A previous failure must not be hidden behind the TTL: the next panel poll
    // or explicit retry should attempt the read again.
    const need = force || state.at === 0 || state.errorAt > 0 || this.now() - state.at > MINE_TTL_MS;
    if (need) await this.loadMine(session);
    this.assertSessionActive(session);
    if (state.data !== null) return state.data;
    return this.emptyMine(session, state.errorAt > 0 ? '公开资料读取失败，请重试' : '正在读取本机公开资料');
  }

  private emptyMine(session: PanelSession, error: string): UiMine {
    return {
      peerId: session.status?.peerId ?? '',
      at: null,
      error,
      errorAt: session.mine.errorAt > 0 ? session.mine.errorAt : null,
      freshness: 'unavailable',
      profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
      posts: { state: 'missing', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
      agentCard: { state: 'missing', card: null, error: '本机还没有公开 Agent 卡片' },
      publicProfile: { state: 'missing', profile: null, error: '本机还没有公开资料 profile.json' },
      files: [],
      filesTruncated: false,
    };
  }

  private async mineFiles(
    listed: Array<{ path: string; size: number }>,
    peerId: string,
    publisherName: string,
  ): Promise<UiPublicFile[]> {
    const files: UiPublicFile[] = [];
    let metaReads = 0;
    let metaBytes = 0;
    let hashedBytes = 0;
    for (const info of listed) {
      const type = fileTypeOf(info.path);
      let version: Awaited<ReturnType<typeof hashPublicFile>> | null = null;
      let contentState: UiContentState = 'available';
      let contentError = '';
      if (info.size <= MAX_LOCAL_COPY_HASH && hashedBytes + info.size <= MAX_MINE_HASH_BYTES) {
        try {
          version = await hashPublicFile(this.dataDir, info.path, MAX_LOCAL_COPY_HASH);
          hashedBytes += version.size;
          if (version.size !== info.size) {
            contentState = 'hash-mismatch';
            contentError = `本机文件大小 ${version.size} 字节与本次发布清单 ${info.size} 字节不一致；请刷新后重试。`;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          contentState = /不存在/.test(message) ? 'copy-missing' : 'unreadable';
          contentError = message;
        }
      }
      const file: UiPublicFile = {
        id: `mine\u0000${version?.sha256 ?? ''}\u0000${info.path}`,
        peerId,
        publisherName,
        path: info.path,
        name: path.posix.basename(info.path),
        sha256: version?.sha256 ?? '',
        sizeBytes: version?.size ?? info.size,
        modifiedAt: version?.modifiedAt ?? 0,
        fetchedAt: 0,
        source: 'local-public',
        sources: ['local-public'],
        kind: type.kind,
        mime: type.mime,
        previewable: type.previewable,
        title: titleFallback(info.path),
        summary: '',
        tags: [],
        publishedAt: '',
        authorKind: '',
        authorName: '',
        images: [],
        contentState,
        contentError,
      };
      if (metaReads < 40 && metaBytes < 4 * 1024 * 1024 && info.size <= 256 * 1024
        && ['markdown', 'json', 'html'].includes(type.kind)) {
        metaReads += 1;
        metaBytes += info.size;
        try {
          const data = await readPublicFile(this.dataDir, info.path, Math.max(1024, info.size));
          if (type.kind === 'markdown') {
            const text = data.toString('utf8');
            file.title = firstMarkdownHeading(text) || file.title;
            file.summary = plainTextSummary(text);
          } else if (type.kind === 'json' && isVersionedPostPath(info.path)) {
            try {
              const post = parsePostBytes(data, info.path, peerId);
              file.kind = 'markdown';
              file.mime = 'text/markdown';
              file.title = post.title;
              file.summary = post.summary;
              file.tags = [...post.tags];
              file.publishedAt = post.publishedAt;
              file.authorKind = post.authorKind;
              file.authorName = post.authorName;
              file.images = postImagesFromPost(post, info.path);
            } catch {
              file.summary = 'JSON 文本文件';
            }
          } else if (type.kind === 'html') {
            const text = data.toString('utf8');
            const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            if (title) file.title = title.slice(0, 200);
          }
        } catch {
          // Metadata from the directory listing remains honest; preview later
          // reports any concrete read failure.
        }
      }
      files.push(file);
    }
    return files;
  }

  private async loadMine(session: PanelSession): Promise<void> {
    if (session.mineBusy !== null) return session.mineBusy;
    const at = this.now();
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        if (this.dataDir.length === 0) throw new Error('宿主没有提供受控数据目录，无法读取本机公开资料');
        await this.ensureReady();
        if (session.statusAt === 0 || this.now() - session.statusAt > this.statusTtlMs) {
          await this.reconcileStatus('mine');
        }
        if (!this.isSessionActive(session)) return;
        const peerId = session.status?.peerId ?? '';
        if (peerId.length === 0) throw new Error('没有读到本机 Peer ID，无法核对本人作者声明');
        const local: OwnPublicData = await readOwnPublic(this.dataDir, peerId);
        // The daemon's Published manifest applies the real per-file/aggregate
        // limits and exclusions. Never substitute an independent disk walk:
        // a file that is not published must not appear as public.
        const published = await this.api.call(
          (client) => client.published(new PublishedRequest(), { timeoutMs: 8000 }),
          '读取本机已发布清单',
        );
        if (!this.isSessionActive(session)) return;
        const publishedFiles = (published.files ?? [])
          .map((file) => ({ path: String(file.path ?? ''), size: numberOf(file.size) }))
          .filter((file) => file.path.length > 0);
        const publishedPaths = new Set(publishedFiles.map((file) => file.path));
        const listed = publishedFiles.slice(0, MAX_MINE_FILES);
        // The Published manifest is authoritative for every displayed part of
        // Mine, not only the generic file list. An over-limit profile or post
        // omitted by the daemon must not appear as public through a local scan.
        const profile = publishedPaths.has(local.profile.path)
          ? local.profile
          : {
            ...local.profile,
            state: 'missing' as const,
            markdown: '',
            displayName: '',
            error: '本机公开档案不在节点当前发布清单中，未作为已公开内容展示。',
            at: null,
          };
        const posts = {
          ...local.posts,
          posts: local.posts.posts.filter((post) => publishedPaths.has(post.path)),
        };
        const publicProfile = publishedPaths.has('profile/profile.json')
          ? local.publicProfile
          : {
            ...local.publicProfile,
            state: 'missing' as const,
            profile: null,
            error: '本机公开资料 profile.json 不在节点当前发布清单中',
          };
        let agentCard: UiPeerAgentCard = publishedPaths.has('profile/agent-card.json')
          ? local.agentCard
          : { state: 'missing', card: null, error: '本机公开 Agent 卡片不在节点当前发布清单中' };
        // profile.json v2 is authoritative even when the Agent name is empty:
        // an avatar-only public profile is still a real published Agent card.
        // The UI supplies the default display name and lists the missing fields;
        // the bridge must not re-label it as "no public profile".
        if (publicProfile.state === 'available' && publicProfile.profile !== null) {
          const v2 = publicProfile.profile;
          agentCard = {
            state: 'available',
            card: {
              schemaVersion: 1,
              displayName: v2.agentName,
              description: v2.agentDescription,
              interests: [...v2.agentInterests],
              conversationStyle: v2.agentConversationStyle,
              updatedAt: v2.updatedAt,
              path: 'profile/profile.json',
              sha256: v2.sha256,
              avatarPath: v2.avatarPath,
              avatarSha256: v2.avatarSha256,
              avatarMime: v2.avatarMime,
              legacyFallback: false,
              sourceWarning: '',
            },
            error: '',
          };
        } else if (local.agentCard.state === 'available' && local.agentCard.card !== null) {
          agentCard = {
            ...local.agentCard,
            card: { ...local.agentCard.card, legacyFallback: true },
          };
        }
        // profile/index.md is generated for every profile publish, including a
        // profile with no human text (the default heading is "关联人类"). Do
        // not project that placeholder as a completed human publication. A
        // real legacy index.md with a different heading or body still counts.
        const publicHuman = publicProfile.state === 'available' ? publicProfile.profile : null;
        const projectedProfile = publicHuman !== null && profile.state !== 'error' && !hasPublicHumanContent(profile, publicHuman)
          ? { ...profile, state: 'missing' as const, markdown: '', displayName: '', at: null }
          : profile;
        const publisherName = projectedProfile.displayName || publicProfile.profile?.humanName || shortPeer(peerId);
        const files = await this.mineFiles(listed, peerId, publisherName);
        session.mine.data = {
          peerId,
          at,
          error: null,
          errorAt: null,
          freshness: this.listFreshness(at, null, true, this.streamEpoch, DISCOVERY_FRESH_MS),
          profile: projectedProfile,
          posts,
          agentCard,
          publicProfile,
          files,
          filesTruncated: publishedFiles.length > MAX_MINE_FILES,
        };
        session.mine.at = at;
        session.mine.errorAt = 0;
      } catch (error) {
        if (!this.isSessionActive(session)) return;
        const message = errorMessage(error);
        const previous = session.mine.data;
        session.mine.errorAt = this.now();
        if (previous !== null && previous.at !== null) {
          // Keep the last verified snapshot. The error and stale freshness are
          // explicit, so the UI can show its read time and retry instead of
          // claiming the published profile does not exist.
          session.mine.data = {
            ...previous,
            error: message,
            errorAt: session.mine.errorAt,
            freshness: 'stale',
          };
        } else {
          session.mine.data = this.emptyMine(session, message);
        }
      } finally {
        if (session.mineBusy === promise) session.mineBusy = null;
      }
    })();
    session.mineBusy = promise;
    return promise;
  }

  /** Peer public profile plus a separately sourced public Agent card. */
  async peerProfile(sessionId: string, peerId: string, force = false): Promise<UiPeerProfile> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) {
      return this.emptyPeerProfile(String(peerId ?? ''), 'Peer ID 格式不正确。', '');
    }
    const cached = session.peerProfiles.get(canonical);
    if (!force && cached !== undefined && this.now() - cached.at < PROFILE_TTL_MS) return cached.data;
    if (!session.peerProfileBusy.has(canonical)) {
      session.peerProfileBusy.set(canonical, this.loadPeerProfile(session, canonical, force));
    }
    await session.peerProfileBusy.get(canonical);
    this.assertSessionActive(session);
    return session.peerProfiles.get(canonical)?.data ?? this.emptyPeerProfile(canonical, '对方公开资料读取失败。', '');
  }

  private emptyPeerFriends(peerId: string, error: string): UiPeerFriends {
    return { peerId, friends: [], limited: false, source: 'unavailable', at: null, error };
  }

  /** Read a peer's public friends.json through the existing daemon RPC. The
   * rows are untrusted claims: this method never compares them to local
   * contacts or treats a name as a visited/known friend. */
  async peerFriends(sessionId: string, peerId: string, _force = false): Promise<UiPeerFriends> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    if (canonical === null) return this.emptyPeerFriends(String(peerId ?? ''), 'Peer ID 格式不正确。');
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.getPeerFriends(
          new GetPeerFriendsRequest({ peerId: canonical }),
          { timeoutMs: 15_000 },
        ),
        '读取对方公开通讯录',
      );
      this.assertSessionActive(session);
      const friends: UiPeerFriendClaim[] = [];
      for (const raw of response.friends ?? []) {
        if (friends.length >= 200) break;
        const claimPeer = canonicalPeerId(String(raw.peerId ?? ''));
        if (claimPeer === null) continue;
        friends.push({
          name: String(raw.name ?? '').slice(0, 256),
          peerId: claimPeer,
          addrs: (raw.addrs ?? []).slice(0, 16).map((addr) => String(addr ?? '')).filter((addr) => addr.length > 0),
          description: String(raw.description ?? '').slice(0, 4096),
        });
      }
      const data: UiPeerFriends = {
        peerId: canonical,
        friends,
        limited: response.limited === true,
        source: 'remote',
        at: this.now(),
        error: null,
      };
      // This is evidence of a real remote read, not a new network action. A
      // persistence failure must not turn a successful read into an error.
      await this.rememberDirectoryClaims(session, canonical, data).catch(() => {});
      if (!this.isSessionActive(session)) return this.emptyPeerFriends(canonical, '面板已关闭');
      return data;
    } catch (error) {
      this.assertSessionActive(session);
      return this.emptyPeerFriends(canonical, errorMessage(error));
    }
  }

  /**
   * Read the host-owned, private contact projection. This method deliberately
   * never calls ensureReady() or this.api: entering the contact list and
   * loading a saved public name/avatar/clue must not dial, download, read a
   * profile, or read a remote address book.
   */
  async contactProjection(sessionId: string): Promise<UiContactProjection> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const projection = await readContactProjection(this.dataDir);
    return {
      state: projection.state,
      profiles: projection.profiles.map((profile) => ({
        peerId: profile.peerId,
        displayName: profile.displayName,
        description: profile.description,
        interests: [...profile.interests],
        conversationStyle: profile.conversationStyle,
        source: profile.source,
        verifiedAt: profile.verifiedAt,
        avatarKey: profile.avatarKey ?? '',
        avatarUrl: profile.avatarUrl ?? '',
        avatarMime: profile.avatarMime ?? '',
        avatarSha256: profile.avatarSha256 ?? '',
        avatarSizeBytes: profile.avatarSizeBytes ?? 0,
        avatarState: profile.avatarState ?? (profile.avatar === null ? 'none' : 'missing'),
        avatarError: profile.avatarError ?? '',
      })),
      clues: projection.clues.map((clue) => ({
        peerId: clue.peerId,
        name: clue.name,
        description: clue.description,
        sourcePeerId: clue.sourcePeerId,
        sourceName: clue.sourceName,
        readAt: clue.readAt,
      })),
      at: projection.updatedAt,
      error: projection.error,
    };
  }

  /** Merge one successful profile read into the private projection. */
  private async rememberContactProfile(peerId: string, data: UiPeerProfile): Promise<void> {
    if (this.dataDir.length === 0 || data.source !== 'remote' || data.error !== null) return;
    const card = data.agentCard.state === 'available' ? data.agentCard.card : null;
    if (card === null) {
      // A completed read that explicitly reports no public card clears the
      // prior public snapshot. A failed or local-copy read never does.
      if (data.agentCard.state === 'missing') {
        await this.updateContactProjection((projection) => {
          projection.profiles = projection.profiles.filter((profile) => profile.peerId !== peerId);
        });
      }
      return;
    }
    const displayName = String(card.displayName ?? '').trim().slice(0, 80);
    if (displayName.length === 0) return;
    let avatar: ContactProjectionProfile['avatar'] = null;
    const avatarPath = String(card.avatarPath ?? '').trim();
    const avatarSha = /^[a-f0-9]{64}$/i.test(String(card.avatarSha256 ?? ''))
      ? String(card.avatarSha256).toLowerCase()
      : '';
    const avatarMime = card.avatarMime === 'image/png' || card.avatarMime === 'image/jpeg' ? card.avatarMime : '';
    const manifestEntry = avatarPath.length > 0 && Array.isArray(data.manifest.entries)
      ? data.manifest.entries.find((entry) => entry.path === avatarPath) ?? null
      : null;
    const sizeBytes = manifestEntry === null ? 0 : Number(manifestEntry.sizeBytes);
    if (avatarPath.length > 0 && avatarSha !== '' && avatarMime !== ''
      && manifestEntry !== null
      && String(manifestEntry.sha256 ?? '').toLowerCase() === avatarSha
      && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
      && sizeBytes <= MAX_CONTACT_PROJECTION_AVATAR_BYTES) {
      avatar = { path: avatarPath, sha256: avatarSha, mime: avatarMime, sizeBytes };
    }
    const entry: ContactProjectionProfile = {
      peerId,
      displayName,
      description: String(card.description ?? '').trim().slice(0, 400),
      interests: (card.interests ?? []).slice(0, 10).map((value) => String(value).slice(0, 80)).filter((value) => value.length > 0),
      conversationStyle: String(card.conversationStyle ?? '').trim().slice(0, 300),
      avatar,
      source: 'remote-profile',
      verifiedAt: Number(data.at) > 0 ? Number(data.at) : this.now(),
    };
    await this.updateContactProjection((projection) => {
      projection.profiles = [entry, ...projection.profiles.filter((profile) => profile.peerId !== peerId)]
        .slice(0, MAX_CONTACT_PROJECTION_PROFILES);
    });
  }

  /** Merge one successful remote directory read into the private projection. */
  private async rememberDirectoryClaims(
    session: PanelSession,
    sourcePeerId: string,
    data: UiPeerFriends,
  ): Promise<void> {
    if (this.dataDir.length === 0 || data.source !== 'remote' || data.error !== null) return;
    const at = Number(data.at) > 0 ? Number(data.at) : this.now();
    const sourceProfile = session.peerProfiles.get(sourcePeerId)?.data;
    const sourceCard = sourceProfile?.agentCard.state === 'available' ? sourceProfile.agentCard.card : null;
    const sourceName = String(sourceCard?.displayName ?? '').trim()
      || this.publisherNameCache.get(sourcePeerId)?.name
      || this.friendName(sourcePeerId)
      || shortPeer(sourcePeerId);
    const self = String(session.status?.peerId ?? '');
    const claims: ContactProjectionClue[] = [];
    const seen = new Set<string>();
    for (const friend of data.friends) {
      const peerId = canonicalPeerId(String(friend.peerId ?? ''));
      if (peerId === null || peerId === sourcePeerId || (self.length > 0 && peerId === self)) continue;
      if (seen.has(peerId)) continue;
      seen.add(peerId);
      claims.push({
        peerId,
        name: String(friend.name ?? '').trim().slice(0, 120) || shortPeer(peerId),
        description: String(friend.description ?? '').trim().slice(0, 280),
        sourcePeerId,
        sourceName: sourceName.slice(0, 80),
        readAt: at,
      });
      if (claims.length >= MAX_CONTACT_PROJECTION_CLUES) break;
    }
    await this.updateContactProjection((projection) => {
      const merged = new Map(projection.clues.map((clue) => [`${clue.sourcePeerId}\u0000${clue.peerId}`, clue]));
      for (const [key, clue] of merged) {
        if (clue.sourcePeerId === sourcePeerId) merged.delete(key);
      }
      for (const claim of claims) merged.set(`${claim.sourcePeerId}\u0000${claim.peerId}`, claim);
      projection.clues = [...merged.values()]
        .sort((left, right) => right.readAt - left.readAt)
        .slice(0, MAX_CONTACT_PROJECTION_CLUES);
    });
  }

  /** Serialize read-modify-write updates and strip runtime-only avatar data. */
  private updateContactProjection(mutator: (projection: ContactProjectionData) => void): Promise<void> {
    const run = this.contactProjectionQueue.catch(() => {}).then(async () => {
      const current = await readContactProjection(this.dataDir, { avatars: false });
      const projection: ContactProjectionData = current.state === 'available'
        ? {
          schemaVersion: 1,
          updatedAt: current.updatedAt,
          profiles: current.profiles.map((profile) => ({
            peerId: profile.peerId,
            displayName: profile.displayName,
            description: profile.description,
            interests: [...profile.interests],
            conversationStyle: profile.conversationStyle,
            avatar: profile.avatar,
            source: profile.source,
            verifiedAt: profile.verifiedAt,
          })),
          clues: current.clues.map((clue) => ({ ...clue })),
        }
        : { schemaVersion: 1, updatedAt: this.now(), profiles: [], clues: [] };
      mutator(projection);
      projection.updatedAt = this.now();
      await writeContactProjection(this.dataDir, projection);
    });
    this.contactProjectionQueue = run.catch(() => {});
    return run;
  }

  private emptyPeerProfile(peerId: string, error: string, localName: string): UiPeerProfile {
    return {
      peerId,
      localName,
      remoteName: '',
      found: false,
      text: '',
      files: [],
      source: 'unavailable',
      at: null,
      error,
      freshness: 'unavailable',
      agentCard: { state: 'missing', card: null, error: '没有读取到公开 Agent 资料' },
      manifest: this.emptyPeerManifest(peerId, '', error),
      node: {
        peerId, connectionState: 'unknown', directConnections: 0, relayConnections: 0,
        currentAddresses: [], knownAddresses: [], statusAt: null, freshness: 'unavailable', error,
      },
      humanAvatarPath: '',
      humanAvatarSha256: '',
      humanAvatarMime: '',
    };
  }

  private async loadPeerProfile(session: PanelSession, peerId: string, forcePeerProfileStatus = false): Promise<void> {
    const at = this.now();
    const localName = this.friendName(peerId);
    try {
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.getPeerProfile(
          new GetPeerProfileRequest({ peerId }),
          { timeoutMs: 15_000 },
        ),
        '读取对方公开资料',
      );
      const found = response.found === true;
      const files = (response.files ?? []).slice(0, 200).map((file) => String(file)).filter((file) => file.length > 0 && file.length <= 256);
      let agentCard: UiPeerAgentCard = { state: 'missing', card: null, error: '对方没有公开 Agent 卡片' };
      const structured = response.profile;
      // The human avatar is independent of the Agent card: a v2 profile may
      // carry only a linked human avatar and no agent fields at all.
      const humanAvatar = peerHumanAvatar(structured);
      if (structured && structured.agentName) {
        agentCard = {
          state: 'available',
          card: {
            schemaVersion: 1,
            displayName: String(structured.agentName ?? '').slice(0, 64),
            description: String(structured.agentDescription ?? '').slice(0, 2000),
            interests: (structured.agentInterests ?? []).slice(0, 10).map((value) => String(value).slice(0, 80)),
            conversationStyle: String(structured.agentConversationStyle ?? '').slice(0, 1000),
            updatedAt: '',
            path: String(structured.sourcePath ?? 'profile/profile.json'),
            sha256: '',
            avatarPath: String(structured.avatarPath ?? ''),
            avatarSha256: String(structured.avatarSha256 ?? '').toLowerCase(),
            avatarMime: String(structured.avatarMime ?? ''),
            legacyFallback: structured.legacyFallback === true,
            sourceWarning: String(structured.warning ?? ''),
          },
          error: '',
        };
      } else if (found && files.includes('profile/agent-card.json')) {
        try {
          const final = await this.downloadForProfile(peerId, 'profile/agent-card.json');
          agentCard = await readDownloadedAgentCard(this.dataDir, peerId, final.path, final.sha256, final.size);
        } catch (error) {
          agentCard = { state: 'error', card: null, error: errorMessage(error) };
        }
      }
      const remoteName = (structured?.humanName ? String(structured.humanName).trim() : '') || String(response.name ?? '').trim();
      const remoteText = (structured?.humanBioMarkdown ? String(structured.humanBioMarkdown) : '') || String(response.text ?? '');
      if (remoteName.length > 0) this.publisherNameCache.set(peerId, { at: this.now(), name: remoteName });
      await this.ensurePeerManifest(session, peerId, forcePeerProfileStatus);
      // The manifest read may have established a connection. Re-read Status so
      // the peer homepage does not label a just-connected peer as disconnected.
      await this.reconcileStatus('peer-profile-node', { trailing: true });
      if (!this.isSessionActive(session)) return;
      if (session.peerProfiles.size > 128) {
        const first = session.peerProfiles.keys().next().value;
        if (first !== undefined) session.peerProfiles.delete(first);
      }
      const data: UiPeerProfile = {
        peerId,
        localName,
        remoteName,
        found,
        text: remoteText.slice(0, 256 * 1024),
        files,
        source: 'remote',
        at,
        error: null,
        freshness: this.listFreshness(at, null, found, this.streamEpoch, DISCOVERY_FRESH_MS),
        agentCard,
        manifest: this.peerManifestSnapshot(session, peerId),
        node: this.peerNodeSnapshot(session, peerId),
        humanAvatarPath: humanAvatar.path,
        humanAvatarSha256: humanAvatar.sha256,
        humanAvatarMime: humanAvatar.mime,
      };
      // Persist only facts this call really returned. This is a local,
      // private projection; it is never a trigger for another remote read.
      await this.rememberContactProfile(peerId, data).catch(() => {});
      if (!this.isSessionActive(session)) return;
      session.peerProfiles.set(peerId, { at, data });
    } catch (error) {
      if (!this.isSessionActive(session)) return;
      if (session.peerProfiles.size > 128) {
        const first = session.peerProfiles.keys().next().value;
        if (first !== undefined) session.peerProfiles.delete(first);
      }
      const message = errorMessage(error);
      let recovered: UiPeerProfile | null = null;
      try {
        recovered = await this.recoverPeerProfileLocally(session, peerId, localName, message, forcePeerProfileStatus);
      } catch {
        recovered = null;
      }
      if (!this.isSessionActive(session)) return;
      const previous = session.peerProfiles.get(peerId)?.data;
      const data = recovered !== null && recovered.source === 'local-copy'
        ? recovered
        : previous
          ? {
            ...previous,
            error: message,
            freshness: 'stale' as const,
            manifest: this.peerManifestSnapshot(session, peerId),
            node: this.peerNodeSnapshot(session, peerId),
            at,
          }
          : recovered ?? {
            ...this.emptyPeerProfile(peerId, message, localName),
            manifest: this.peerManifestSnapshot(session, peerId),
            node: this.peerNodeSnapshot(session, peerId),
            at,
          };
      session.peerProfiles.set(peerId, { at, data });
    } finally {
      session.peerProfileBusy.delete(peerId);
    }
  }

  /** Rebuild a peer homepage from verified local downloads after the remote
   * read failed. This is the restart-safe, explicitly local fallback; it never
   * claims the peer is online or that the list is the current full manifest. */
  private async recoverPeerProfileLocally(
    session: PanelSession,
    peerId: string,
    localName: string,
    remoteError: string,
    force: boolean,
  ): Promise<UiPeerProfile> {
    await this.ensurePeerManifest(session, peerId, force);
    const manifest = this.peerManifestSnapshot(session, peerId);
    const profile = await readDownloadedProfile(this.dataDir, peerId);
    const files = new Set(manifest.entries.map((entry) => entry.path));
    if (profile.state === 'available') files.add('profile/index.md');
    let agentCard: UiPeerAgentCard = { state: 'missing', card: null, error: '本机没有对方公开 Agent 卡片的历史副本' };
    if (files.has('profile/agent-card.json')) {
      const card = await readDownloadedAgentCard(this.dataDir, peerId, 'profile/agent-card.json', '', 0);
      if (card.state === 'available' && card.card !== null) {
        agentCard = { state: 'available', card: card.card, error: '' };
      } else if (card.state === 'error') {
        agentCard = { state: 'error', card: null, error: card.error };
      }
    }
    const hasLocal = profile.state === 'available' || manifest.entries.length > 0;
    return {
      peerId,
      localName,
      remoteName: profile.displayName,
      found: profile.state === 'available',
      text: profile.markdown.slice(0, 256 * 1024),
      files: [...files].slice(0, 200),
      source: hasLocal ? 'local-copy' : 'unavailable',
      at: this.now(),
      error: hasLocal
        ? `读取对方当前公开资料失败：${remoteError.replace(/[。.\s]+$/, '')}。以下来自本机已核对的下载副本，不是当前远端资料。`
        : remoteError,
      freshness: hasLocal ? 'stale' : 'unavailable',
      agentCard,
      manifest,
      node: this.peerNodeSnapshot(session, peerId),
      humanAvatarPath: '',
      humanAvatarSha256: '',
      humanAvatarMime: '',
    };
  }

  private friendName(peerId: string): string {
    // Friend names are local snapshots already cached for the panel; do not
    // fetch the friend list just to label a profile.
    for (const session of this.sessions.values()) {
      const row = session.friends.find((item) => canonicalPeerId(item.peerId) === peerId);
      if (row?.name) return row.name;
    }
    return '';
  }

  private async downloadPeerFile(
    peerId: string,
    relative: string,
    options: { recordDiscovery: boolean; discoverySource?: string; timeoutMs?: number },
    operation: string,
  ): Promise<{
    phase: string; path: string; localPath: string; sha256: string;
    totalBytes: number; error: string; discoveryRecorded: boolean; discoveryError: string;
  } | null> {
    const frames = await this.api.call(async (client) => {
      const stream = await client.downloadPeerFile(
        new DownloadPeerFileRequest({
          peerId,
          path: relative,
          recordDiscovery: options.recordDiscovery,
          discoverySource: options.discoverySource ?? '',
        }),
        { timeoutMs: options.timeoutMs ?? 30_000 },
      );
      const collected: Array<{
        phase: string; path: string; localPath: string; sha256: string;
        totalBytes: number; error: string; discoveryRecorded: boolean; discoveryError: string;
      }> = [];
      for await (const frame of stream) {
        collected.push({
          phase: String(frame.phase ?? ''),
          path: String(frame.path ?? ''),
          localPath: String(frame.localPath ?? ''),
          sha256: String(frame.sha256 ?? ''),
          totalBytes: numberOf(frame.totalBytes),
          error: String(frame.error ?? ''),
          discoveryRecorded: frame.discoveryRecorded === true,
          discoveryError: String(frame.discoveryError ?? ''),
        });
      }
      return collected;
    }, operation);
    return frames.length > 0 ? frames[frames.length - 1] : null;
  }

  private async downloadForProfile(peerId: string, relative: string): Promise<{ path: string; localPath: string; sha256: string; size: number }> {
    const last = await this.downloadPeerFile(
      peerId,
      relative,
      { recordDiscovery: false, timeoutMs: 30_000 },
      '读取对方公开 Agent 卡片',
    );
    if (last === null || last.phase !== 'complete' || last.error.length > 0) {
      throw new Error(last?.error || '公开 Agent 卡片下载没有完成');
    }
    if (last.path !== relative) throw new Error('下载结果的公开路径与请求不一致');
    return { path: last.path, localPath: last.localPath, sha256: last.sha256, size: last.totalBytes };
  }

  /**
   * Save one fixed private Markdown file with optimistic conflict detection.
   * The browser supplies a field name, text and expected SHA-256 only; it
   * never supplies a path and private text is never written to public/.
   */
  async publicDraft(sessionId: string, draftId: string): Promise<{ found: boolean; draft: UiPublicDraft | null; error?: string }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    try {
      const response = await this.api.call(
        (client) => client.getPublicDraft(new GetPublicDraftRequest({ draftId: String(draftId ?? '') }), { timeoutMs: 8000 }),
        '读取公开草稿',
      );
      return { found: response.found === true, draft: response.draft ? draftFromProto(response.draft) : null };
    } catch (error) {
      return { found: false, draft: null, error: errorMessage(error) };
    }
  }

  async publicDrafts(sessionId: string, kind: string): Promise<{ drafts: UiPublicDraft[]; hasMore: boolean; nextBefore: string }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const response = await this.api.call(
      (client) => client.listPublicDrafts(new ListPublicDraftsRequest({ kind: String(kind ?? ''), limit: 100 }), { timeoutMs: 8000 }),
      '读取公开草稿列表',
    );
    return {
      drafts: (response.drafts ?? []).map((draft) => draftFromProto(draft)),
      hasMore: response.hasMore === true,
      nextBefore: String(response.nextBefore ?? ''),
    };
  }

  async savePublicDraft(sessionId: string, input: UiPublicDraftSave): Promise<{ draft: UiPublicDraft }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const revision = Number.isSafeInteger(Number(input?.expectedRevision)) && Number(input.expectedRevision) > 0
      ? BigInt(Math.trunc(Number(input.expectedRevision)))
      : protoInt64.zero;
    const request = new SavePublicDraftRequest({
      draftId: String(input?.draftId ?? ''),
      kind: String(input?.kind ?? ''),
      expectedRevision: revision,
      agentInterests: (input?.agentInterests ?? []).map((value) => String(value)),
      tags: (input?.tags ?? []).map((value) => String(value)),
      imageAssetIds: (input?.imageAssetIds ?? []).map((value) => String(value)),
      avatarAssetId: String(input?.avatarAssetId ?? ''),
      clearAvatar: input?.clearAvatar === true,
    });
    if (typeof input?.agentName === 'string') request.agentName = input.agentName;
    if (typeof input?.agentDescription === 'string') request.agentDescription = input.agentDescription;
    if (typeof input?.agentConversationStyle === 'string') request.agentConversationStyle = input.agentConversationStyle;
    if (typeof input?.humanName === 'string') request.humanName = input.humanName;
    if (typeof input?.humanBioMarkdown === 'string') request.humanBioMarkdown = input.humanBioMarkdown;
    // Presence matters: leaving this optional proto field unset preserves the
    // saved human avatar, while clearHumanAvatar explicitly removes it. Never
    // fall back to the Agent avatar.
    if (typeof input?.humanAvatarAssetId === 'string') request.humanAvatarAssetId = input.humanAvatarAssetId;
    if (input?.clearHumanAvatar === true) request.clearHumanAvatar = true;
    if (typeof input?.title === 'string') request.title = input.title;
    if (typeof input?.bodyMarkdown === 'string') request.bodyMarkdown = input.bodyMarkdown;
    if (input?.authorKind === 'user' || input?.authorKind === 'agent') request.authorKind = input.authorKind;
    const response = await this.api.call(
      (client) => client.savePublicDraft(request, { timeoutMs: 8000 }),
      '保存公开草稿',
    );
    if (!response.draft) throw new Error('保存草稿没有返回草稿内容');
    return { draft: draftFromProto(response.draft) };
  }

  async putPublicDraftImage(sessionId: string, draftId: string, role: string, filename: string, dataBase64: string): Promise<{ image: UiPublicDraftImage }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const raw = String(dataBase64 ?? '');
    if (raw.length === 0 || raw.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
      throw new Error('图片数据为空、过大或不是有效 base64');
    }
    const data = Buffer.from(raw, 'base64');
    if (data.length === 0 || data.length > 8 * 1024 * 1024) throw new Error('图片超过 8 MiB 上限');
    const response = await this.api.call(
      (client) => client.putPublicDraftImage(new PutPublicDraftImageRequest({
        draftId: String(draftId ?? ''), role: String(role ?? ''), filename: String(filename ?? ''), data,
      }), { timeoutMs: 30_000 }),
      '保存公开草稿图片',
    );
    const image = draftImageFromProto(response.image);
    if (!image) throw new Error('保存图片没有返回资源信息');
    return { image };
  }

  async publicDraftAsset(sessionId: string, draftId: string, assetId: string): Promise<UiPublicDraftAssetRead> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const id = String(draftId ?? '');
    const asset = String(assetId ?? '');
    if (id.length === 0 || asset.length === 0) throw new Error('draftId 和 assetId 不能为空');
    const response = await this.api.call(
      (client) => client.getPublicDraftAsset(new GetPublicDraftAssetRequest({ draftId: id, assetId: asset }), { timeoutMs: 8000 }),
      '读取私有草稿图片',
    );
    const image = draftImageFromProto(response.image);
    if (!image || image.assetId !== asset) throw new Error('草稿图片响应与请求的资源不一致');
    const data = response.data ?? new Uint8Array();
    if (data.length === 0 || data.length > 8 * 1024 * 1024) throw new Error('草稿图片为空或超过 8 MiB');
    if (image.sizeBytes !== data.length) throw new Error('草稿图片大小与元数据不一致');
    return { image, dataBase64: Buffer.from(data).toString('base64') };
  }

  async importPublicPost(sessionId: string, publicPath: string): Promise<{ draft: UiPublicDraft }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const rel = String(publicPath ?? '');
    if (!/^(?:posts\/[A-Za-z0-9._-]+\.json|posts\/[A-Za-z0-9._-]+\/post\.json)$/.test(rel)) {
      throw new Error('只能编辑本机 posts 目录中的公开动态');
    }
    const response = await this.api.call(
      (client) => client.importPublicPost(new ImportPublicPostRequest({ path: rel }), { timeoutMs: 30_000 }),
      '导入公开动态草稿',
    );
    if (!response.draft) throw new Error('导入动态没有返回草稿');
    return { draft: draftFromProto(response.draft) };
  }

  async deletePublicDraft(sessionId: string, draftId: string, expectedRevision: number): Promise<{ deleted: boolean }> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const response = await this.api.call(
      (client) => client.deletePublicDraft(new DeletePublicDraftRequest({
        draftId: String(draftId ?? ''), expectedRevision: BigInt(Math.max(0, Math.trunc(Number(expectedRevision) || 0))),
      }), { timeoutMs: 8000 }),
      '删除公开草稿',
    );
    return { deleted: response.deleted === true };
  }

  async publishPublicDraft(sessionId: string, draftId: string, expectedRevision: number, expectedPublishedSha256: string): Promise<UiPublishResult> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    await this.ensureReady();
    const response = await this.api.call(
      (client) => client.publishPublicDraft(new PublishPublicDraftRequest({
        draftId: String(draftId ?? ''),
        expectedRevision: BigInt(Math.max(0, Math.trunc(Number(expectedRevision) || 0))),
        expectedPublishedSha256: String(expectedPublishedSha256 ?? ''),
      }), { timeoutMs: 60_000 }),
      '发布公开草稿',
    );
    const result: UiPublishResult = {
      status: publishStatusFromProto(response.status),
      error: String(response.error ?? ''),
      currentRevision: numberOf(response.currentRevision),
      currentPublishedSha256: String(response.currentPublishedSha256 ?? '').toLowerCase(),
      files: (response.files ?? []).map((file) => ({
        path: String(file.path ?? ''), sizeBytes: numberOf(file.sizeBytes), sha256: String(file.sha256 ?? '').toLowerCase(),
      })),
      manifestVersion: numberOf(response.manifestVersion),
      manifestGeneratedAtUnixMs: numberOf(response.manifestGeneratedAtUnixMs),
      postPath: String(response.postPath ?? ''),
      profilePath: String(response.profilePath ?? ''),
      warnings: (response.warnings ?? []).map((value) => String(value)),
      manifestSha256: String(response.manifestSha256 ?? '').toLowerCase(),
    };
    // A commit changes the public manifest; refresh only after the daemon has
    // returned the same-snapshot files/digest.
    if (result.status === 'published' || result.status === 'already_published' || result.status === 'partial') {
      session.mine.at = 0;
      session.mine.errorAt = 0;
      for (const state of session.discoveries.values()) state.at = 0;
    }
    return result;
  }

  async savePrivateAgent(
    sessionId: string,
    field: 'persona' | 'growth',
    content: string,
    expectedSha256: string,
  ): Promise<UiPrivateAgentSave> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    if (field !== 'persona' && field !== 'growth') throw new Error('只允许保存 persona 或 growth');
    if (typeof content !== 'string') throw new Error('保存内容必须是文本');
    try {
      const result = await savePrivateAgentFile(this.dataDir, field, content, expectedSha256);
      // Force the next Journey read to observe this exact write rather than a
      // pre-save cached Markdown snapshot.
      session.journey.at = 0;
      session.journey.data = null;
      return result;
    } catch (error) {
      if (error instanceof LocalDataError && error.code === 'conflict') {
        return { saved: false, conflict: true, error: error.message, sha256: '' };
      }
      throw error;
    }
  }

  /** Read private Agent persona/growth and existing Journey schemas. */
  async journey(sessionId: string, force = false): Promise<UiJourney> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const state = session.journey;
    const need = force || state.at === 0 || this.now() - state.at > JOURNEY_TTL_MS;
    if (need) await this.loadJourney(session);
    this.assertSessionActive(session);
    if (state.data !== null) return state.data;
    const unavailable = await readJourneyPlaceholder(this.dataDir, this.now());
    return { ...unavailable, freshness: 'unavailable' };
  }

  private async loadJourney(session: PanelSession): Promise<void> {
    if (session.journeyBusy !== null) return session.journeyBusy;
    const at = this.now();
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        if (this.dataDir.length === 0) throw new Error('宿主没有提供受控数据目录，不能读取 Agent 记录');
        const data = await readJourney(this.dataDir);
        if (!this.isSessionActive(session)) return;
        session.journey.data = {
          ...data,
          freshness: data.state === 'missing' ? 'unavailable' : this.listFreshness(at, null, data.state === 'available', this.streamEpoch, DISCOVERY_FRESH_MS),
        };
        session.journey.at = at;
        session.journey.errorAt = 0;
      } catch (error) {
        if (!this.isSessionActive(session)) return;
        session.journey.errorAt = this.now();
        const placeholder = await readJourneyPlaceholder(this.dataDir, at);
        session.journey.data = { ...placeholder, state: 'error', sessionsError: errorMessage(error), freshness: 'unavailable' };
      } finally {
        if (session.journeyBusy === promise) session.journeyBusy = null;
      }
    })();
    session.journeyBusy = promise;
    return promise;
  }

  /**
   * Read the private tool-call log. This method never opens the daemon, never
   * writes a file and never changes an operation's terminal state. A read
   * failure is returned as an error, not as an empty activity list.
   */
  async activity(sessionId: string, limit = 100): Promise<UiActivity> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const instanceId = this.activityStore?.pluginInstanceId ?? '';
    if (this.activityStore === null) {
      return {
        operations: [], instanceId, readAt: this.now(), truncated: false, badLines: 0,
        error: '当前宿主没有提供 Agent 工具活动读取。',
      };
    }
    try {
      return await this.activityStore.read(limit);
    } catch (error) {
      return {
        operations: [], instanceId, readAt: this.now(), truncated: false, badLines: 0,
        error: `Agent 工具活动读取失败：${redactActivityReadError(error)}`,
      };
    }
  }

  /**
   * Detail for one real tool operation. Only a bounded Journey state summary
   * is attached; reports/events/persona/growth never leave the host.
   */
  async activityDetail(operationId: string): Promise<UiActivityDetail> {
    if (this.disposed) throw new Error('Raminga UI bridge is disposed');
    const wanted = typeof operationId === 'string' ? operationId.trim() : '';
    const empty: UiActivityDetail = {
      operation: null,
      evidence: {},
      journey: null,
      missingReason: wanted.length === 0
        ? '没有提供要查看的工具操作。'
        : '本机没有找到这条工具调用记录。',
    };
    if (this.activityStore === null || wanted.length === 0 || wanted.length > 160) return empty;
    let operation: ActivityOperation | null = null;
    try {
      const read = await this.activityStore.read(500);
      operation = read.operations.find((item) => item.operationId === wanted) ?? null;
    } catch {
      return { ...empty, missingReason: '本机工具调用记录读取失败，不能确认这条操作。' };
    }
    if (operation === null) return empty;
    const evidence = { ...operation.evidence };
    // Older records may predate evidence projection; the sanitized target is
    // still safe and lets the UI offer an honest fallback jump.
    if (!evidence.peer_id && operation.target.peer_id) evidence.peer_id = operation.target.peer_id;
    if (!evidence.path && operation.target.path) evidence.path = operation.target.path;
    let journey: UiActivityJourney | null = null;
    let journeyMissing = false;
    if (operation.journeyId.length > 0) {
      const summary = await readJourneySummary(this.dataDir, operation.journeyId);
      if (summary === null) {
        journeyMissing = true;
        journey = {
          sessionId: operation.journeyId,
          exists: false,
          status: '',
          mode: '',
          startedAt: '',
          updatedAt: '',
          completedAt: '',
          currentPeerId: '',
          visitedPeerIds: [],
        };
      } else {
        journey = { ...summary, exists: true };
      }
    }
    const peer = evidence.peer_id || operation.target.peer_id || '';
    let missingReason = '';
    if (journeyMissing) missingReason = '关联的 Journey 记录已不在本机。';
    else if (peer.length > 0) missingReason = '';
    else if ((evidence.message_ids?.length ?? 0) > 0) missingReason = '记录里有消息 ID，但没有可定位的 Peer。';
    else if (evidence.path || operation.target.path) missingReason = '记录里有公开内容路径，但没有可定位的 Peer。';
    else missingReason = '本机没有可跳转证据。';
    return { operation, evidence, journey, missingReason };
  }

  /**
   * Locate a message referenced by a Journey event inside the currently
   * retained Node history. This only reports presence; it never substitutes a
   * different message. The scan is bounded and says so when it cannot finish.
   */
  async locateMessage(sessionId: string, peerId: string, messageId: string): Promise<UiLocatedMessage> {
    this.assertOpen();
    const session = this.sessionFor(sessionId);
    session.lastPollAt = this.now();
    const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
    const wanted = typeof messageId === 'string' ? messageId.trim() : '';
    if (canonical === null || wanted.length === 0 || wanted.length > 160) {
      return { found: false, peerId: canonical ?? '', messageId: wanted, message: null, error: '消息引用的 Peer 或消息 ID 无效。', scanned: 0, complete: true };
    }
    await this.ensureReady();
    let before = '';
    let scanned = 0;
    for (let pageIndex = 0; pageIndex < MAX_MESSAGE_LOCATE_PAGES; pageIndex += 1) {
      const response = await this.api.call(
        (client) => client.listMessages(
          new ListMessagesRequest({ peerId: canonical, before, limit: MESSAGE_LOCATE_LIMIT }),
          { timeoutMs: 4000 },
        ),
        '核对历史消息引用',
      );
      const rows = response.messages ?? [];
      scanned += rows.length;
      for (const row of rows) {
        if (String(row.messageId ?? '') === wanted) {
          return { found: true, peerId: canonical, messageId: wanted, message: toUiMessage(row), error: null, scanned, complete: true };
        }
      }
      if (response.hasMore !== true) {
        return { found: false, peerId: canonical, messageId: wanted, message: null, error: null, scanned, complete: true };
      }
      const next = String(response.nextBefore ?? '');
      if (next.length === 0 || next === before) {
        return { found: false, peerId: canonical, messageId: wanted, message: null, error: '历史消息游标没有前进，无法继续核对引用。', scanned, complete: false };
      }
      before = next;
    }
    return {
      found: false,
      peerId: canonical,
      messageId: wanted,
      message: null,
      error: '在本次有界读取的历史消息中没有找到该引用；它可能更早或已被裁剪。',
      scanned,
      complete: false,
    };
  }

  private emptyMessageState(): MessagesState {
    return {
      items: [],
      at: 0,
      error: null,
      errorAt: 0,
      streamEpoch: -1,
      hasMore: false,
      nextBefore: '',
      retention: null,
    };
  }

  private emptyMessagePage(peerId: string, error: string): UiMessagePage {
    return {
      peerId: typeof peerId === 'string' ? peerId : '',
      messages: [],
      at: null,
      error,
      errorAt: this.now(),
      freshness: 'unavailable',
      hasMore: false,
      nextBefore: '',
      retention: null,
    };
  }

  private conversationsSnapshot(session: PanelSession): UiConversations {
    const state = session.conversations;
    return {
      conversations: state.items.map((row) => ({ ...row })),
      at: state.at > 0 ? state.at : null,
      error: state.error,
      errorAt: state.errorAt > 0 ? state.errorAt : null,
      freshness: this.listFreshness(state.at, state.error, state.items.length > 0, state.streamEpoch, this.conversationsFreshMs),
      retention: state.retention ? { ...state.retention } : null,
      totalUnread: state.totalUnread,
    };
  }

  private messagePageSnapshot(session: PanelSession, peerId: string): UiMessagePage {
    const state = session.messages.get(peerId) ?? this.emptyMessageState();
    return {
      peerId,
      messages: state.items.map((row) => ({ ...row })),
      at: state.at > 0 ? state.at : null,
      error: state.error,
      errorAt: state.errorAt > 0 ? state.errorAt : null,
      freshness: this.listFreshness(state.at, state.error, state.items.length > 0, state.streamEpoch, this.messagesFreshMs),
      hasMore: state.hasMore,
      nextBefore: state.nextBefore,
      retention: state.retention ? { ...state.retention } : null,
    };
  }

  private listFreshness(at: number, error: string | null, hasData: boolean, streamEpoch: number, freshMs: number): UiFreshness {
    if (error) return hasData ? 'stale' : 'unavailable';
    if (at === 0) return 'loading';
    if (this.eventPhase !== 'open' || streamEpoch !== this.streamEpoch) return 'stale';
    if (this.now() - at > freshMs) return 'stale';
    return 'live';
  }

  private pageFreshness(at: number, error: string | null, hasData: boolean, streamEpoch: number): UiFreshness {
    if (error) return hasData ? 'stale' : 'unavailable';
    if (at === 0) return 'loading';
    if (this.eventPhase !== 'open' || streamEpoch !== this.streamEpoch) return 'stale';
    if (this.now() - at > this.messagesFreshMs) return 'stale';
    return 'live';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.statusRefreshDirty = false;
    this.friendsRefresh = null;
    clearInterval(this.reaper);
    this.cancelReconcileTimer();
    this.stats.sessionsClosed += this.sessions.size;
    this.sessions.clear();
    this.activityStore?.detachAllPanelSessions();
    this.closedSessions.clear();
    this.stopEventStream();
    // The same cleanup path runs when the plugin fiber unloads; keep one
    // observable line so a real host shutdown leaves evidence in its log.
    console.info('[raminga-ui] bridge disposed', JSON.stringify(this.snapshotStats()));
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Raminga UI bridge is disposed');
  }

  private isSessionActive(session: PanelSession): boolean {
    return !this.disposed && this.sessions.get(session.id) === session;
  }

  private assertSessionActive(session: PanelSession): void {
    if (!this.isSessionActive(session)) throw new Error('Raminga panel lease was closed');
  }

  private normalizeSessionId(value: string): string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new Error('invalid Raminga panel session id');
    }
    return value;
  }

  private sessionFor(sessionId: string): PanelSession {
    const session = this.sessions.get(this.normalizeSessionId(sessionId));
    if (!session) throw new Error('Raminga panel lease is not open; reopen the panel');
    return session;
  }

  private async awaitStatusIdle(): Promise<void> {
    const active = this.statusRefresh;
    if (active === null) return;
    try {
      await active.promise;
    } catch {
      // The read records its own error; the caller only needs the barrier.
    }
  }

  private async awaitFriendsIdle(): Promise<void> {
    const active = this.friendsRefresh;
    if (active === null) return;
    try {
      await active.promise;
    } catch {
      // The read records its own error; the caller only needs the barrier.
    }
  }

  /** close() stays idempotent for malformed ids instead of throwing. */
  private acceptedSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      return this.normalizeSessionId(value);
    } catch {
      return null;
    }
  }

  private releaseSession(session: PanelSession): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    // Closing a panel unbinds its lease only. It must never write a terminal
    // activity result for a tool that may still be executing.
    this.activityStore?.detachPanelSession(session.id);
    this.stats.sessionsClosed += 1;
    if (this.sessions.size === 0) {
      this.generation += 1;
      this.statusRefreshDirty = false;
      this.cancelReconcileTimer();
      this.stopEventStream();
    }
  }

  private rememberClosedSession(id: string): void {
    // Refresh insertion order so the oldest entry is evicted first.
    this.closedSessions.delete(id);
    this.closedSessions.set(id, this.now());
    while (this.closedSessions.size > MAX_CLOSED_SESSIONS) {
      const oldest = this.closedSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.closedSessions.delete(oldest);
    }
  }

  private pruneClosedSessions(): void {
    const cutoff = this.now() - CLOSED_SESSION_TTL_MS;
    for (const [id, closedAt] of this.closedSessions) {
      if (closedAt >= cutoff) break;
      this.closedSessions.delete(id);
    }
  }

  private ensureReady(): Promise<unknown> {
    if (this.ready === null) {
      this.ready = this.api.ensure().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  /**
   * Coalesce all Status reads. If an event arrives while a read is in flight,
   * the loop performs one more read before resolving, so every caller sees a
   * result that is at least as new as the event that triggered it.
   */
  private reconcileStatus(reason: string, { trailing = false }: { trailing?: boolean } = {}): Promise<void> {
    if (this.disposed || this.sessions.size === 0) return Promise.resolve();
    this.cancelReconcileTimer();
    const generation = this.generation;
    if (this.statusRefresh !== null && this.statusRefresh.generation === generation) {
      // A concurrent poll/refresh can share the read already in flight. An
      // event or stream reopen that lands during the read needs one trailing
      // pass so the snapshot is at least as new as that notification.
      if (trailing) this.statusRefreshDirty = true;
      this.stats.reconcileCoalesced += 1;
      return this.statusRefresh.promise;
    }
    this.stats.reconcileRuns += 1;
    const entry = { generation, promise: this.runReconcile(generation) };
    this.statusRefresh = entry;
    return entry.promise;
  }

  private async runReconcile(generation: number): Promise<void> {
    let passes = 0;
    try {
      do {
        if (generation !== this.generation || this.disposed || this.sessions.size === 0) return;
        this.statusRefreshDirty = false;
        const result = await this.fetchStatus();
        // The last lease may have closed (and a new one opened) while this
        // read was in flight; discard the older generation rather than
        // overwriting the new session with it.
        if (generation !== this.generation || this.disposed || this.sessions.size === 0) return;
        this.applyStatusResult(result);
        passes += 1;
      } while (
        this.statusRefreshDirty
        && passes < MAX_RECONCILE_PASSES
        && generation === this.generation
        && !this.disposed
        && this.sessions.size > 0
      );
    } finally {
      if (this.statusRefresh !== null && this.statusRefresh.generation === generation) {
        this.statusRefresh = null;
      }
      // A burst larger than the pass budget still gets a trailing read rather
      // than leaving the final event unverified.
      if (
        this.statusRefreshDirty
        && generation === this.generation
        && !this.disposed
        && this.sessions.size > 0
      ) {
        this.statusRefreshDirty = false;
        this.scheduleReconcile(0, 'event-backlog');
      }
    }
  }

  private async fetchStatus(): Promise<StatusResult> {
    try {
      const streamEpoch = this.streamEpoch;
      await this.ensureReady();
      const status = await this.api.call(
        (client) => client.status(new StatusRequest(), { timeoutMs: 2500 }),
        '读取节点状态',
      );
      return { ok: true, status: toUiStatus(status), at: this.now(), streamEpoch };
    } catch (error) {
      return { ok: false, error: errorMessage(error), at: this.now() };
    }
  }

  /** Coalesce ListFriends reads across panels; failures retain the last rows. */
  private reconcileFriends(reason: string): Promise<void> {
    if (this.disposed || this.sessions.size === 0) return Promise.resolve();
    const generation = this.generation;
    if (this.friendsRefresh !== null && this.friendsRefresh.generation === generation) {
      return this.friendsRefresh.promise;
    }
    const entry = { generation, promise: this.runFriendsRead(generation, reason) };
    this.friendsRefresh = entry;
    return entry.promise;
  }

  private async runFriendsRead(generation: number, _reason: string): Promise<void> {
    try {
      const result = await this.fetchFriends();
      if (generation !== this.generation || this.disposed || this.sessions.size === 0) return;
      this.applyFriendsResult(result);
    } finally {
      if (this.friendsRefresh !== null && this.friendsRefresh.generation === generation) {
        this.friendsRefresh = null;
      }
    }
  }

  private async fetchFriends(): Promise<FriendsResult> {
    try {
      const streamEpoch = this.streamEpoch;
      await this.ensureReady();
      const response = await this.api.call(
        (client) => client.listFriends(new ListFriendsRequest(), { timeoutMs: 2500 }),
        '读取联系人列表',
      );
      return { ok: true, friends: response.friends, at: this.now(), streamEpoch };
    } catch (error) {
      return { ok: false, error: errorMessage(error), at: this.now() };
    }
  }

  private applyFriendsResult(result: FriendsResult): void {
    this.stats.friendsReads += 1;
    if (!result.ok) {
      this.stats.friendsFailures += 1;
      for (const session of this.sessions.values()) {
        session.friendsError = result.error;
        session.friendsErrorAt = result.at;
      }
      return;
    }
    this.stats.lastFriendsAt = result.at;
    for (const session of this.sessions.values()) {
      session.friends = result.friends;
      session.friendsAt = result.at;
      session.friendsStreamEpoch = result.streamEpoch;
      session.friendsError = null;
      session.friendsErrorAt = 0;
    }
  }

  private applyStatusResult(result: StatusResult): void {
    this.stats.statusReads += 1;
    if (!result.ok) {
      this.stats.statusFailures += 1;
      this.stats.lastError = result.error;
      for (const session of this.sessions.values()) {
        session.error = result.error;
        session.errorAt = result.at;
      }
      return;
    }
    this.stats.lastStatusAt = result.at;
    // A healthy Status read does not clear a stream error; only a stream
    // reopen does. The UI keeps "realtime is down" separate from "read failed".
    this.stats.lastError = this.streamError;
    for (const session of this.sessions.values()) {
      session.status = result.status;
      session.statusAt = result.at;
      session.statusStreamEpoch = result.streamEpoch;
      session.error = null;
      session.errorAt = 0;
    }
  }

  private async ensureEventStream(): Promise<void> {
    if (this.disposed) return;
    // A non-null stopEvents handle always means one subscriber is live or
    // connecting. Never tear it down just because the phase callback has not
    // run yet; concurrent opens must share the same stream.
    if (this.stopEvents !== null) {
      await this.waitForStreamReady();
      return;
    }
    this.stats.streamStarts += 1;
    this.streamReady = new Promise((resolve) => {
      this.resolveStreamReady = resolve;
    });
    this.stopEvents = this.subscribe(
      this.api,
      (raw) => this.onDaemonEvent(raw),
      (error) => this.onEventError(error),
      (phase) => this.onEventPhase(phase),
      this.subscribeOptions,
    );
    await this.waitForStreamReady();
  }

  private waitForStreamReady(): Promise<void> {
    const ready = this.streamReady;
    if (!ready) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, this.streamReadyTimeoutMs);
      ready.then(finish, finish);
    });
  }

  private onEventPhase(phase: EventStreamPhase): void {
    const at = this.now();
    this.eventPhase = phase;
    this.streamSince = at;
    if (phase === 'open') {
      this.streamEpoch += 1;
      this.stats.streamOpens += 1;
      this.lastStreamOpenAt = at;
      this.streamError = null;
      // First subscribe and every reconnect need a fresh full snapshot. The
      // initial open() cancels this timer and performs the read itself.
      this.scheduleReconcile(0, 'stream-open');
    }
    if (phase === 'open' || phase === 'reconnecting' || phase === 'closed') {
      this.resolveStreamReady?.();
    }
  }

  private onEventError(error: unknown): void {
    this.streamError = errorMessage(error);
    this.stats.streamErrors += 1;
    this.stats.lastError = this.streamError;
  }

  private onDaemonEvent(raw: Record<string, unknown>): void {
    const event = mapDaemonEvent(raw);
    this.stats.eventsSeen += 1;
    this.stats.lastEventAt = event.atUnixMs;
    for (const session of this.sessions.values()) {
      session.events.push(event);
      if (session.events.length > MAX_QUEUED_EVENTS) session.events.splice(0, session.events.length - MAX_QUEUED_EVENTS);
    }
    if (event.kind === 'connection') {
      // Reconcile with a short debounce so a burst of one Peer's link changes
      // results in one full Status read. The event itself never flips a Peer.
      this.scheduleReconcile(this.reconcileDelayMs, 'connection-event');
    }
    this.resolveStreamReady?.();
  }

  private scheduleReconcile(delayMs: number, reason: string): void {
    if (this.disposed || this.sessions.size === 0) return;
    if (this.reconcileTimer !== null) {
      if (delayMs > 0) return;
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcileStatus(reason, { trailing: true });
    }, delayMs);
  }

  private cancelReconcileTimer(): void {
    if (this.reconcileTimer === null) return;
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private stopEventStream(): void {
    this.cancelReconcileTimer();
    if (this.stopEvents === null) {
      this.eventPhase = 'closed';
      this.streamSince = this.now();
      this.streamError = null;
      return;
    }
    this.stats.streamStops += 1;
    const stop = this.stopEvents;
    this.stopEvents = null;
    // stop() emits 'closed', which releases any open() waiting for stream
    // readiness before the now-obsolete promise fields are cleared.
    stop();
    this.streamReady = null;
    this.resolveStreamReady = null;
    this.eventPhase = 'closed';
    this.streamSince = this.now();
    this.streamError = null;
  }

  private reapIdleSessions(): void {
    if (this.disposed) return;
    const now = this.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastPollAt > SESSION_IDLE_MS) {
        this.sessions.delete(id);
        this.stats.sessionsClosed += 1;
        removed += 1;
      }
    }
    if (this.sessions.size === 0) {
      if (removed > 0) {
        this.generation += 1;
        this.statusRefreshDirty = false;
      }
      this.cancelReconcileTimer();
      this.stopEventStream();
    }
  }

  private freshnessOf(session: PanelSession): UiFreshness {
    const now = this.now();
    const statusAt = session.statusAt > 0 ? session.statusAt : null;
    const statusIsRecent = statusAt !== null && now - statusAt <= this.statusFreshMs;
    if (session.error && !session.status) return 'unavailable';
    if (session.error) return 'stale';
    if (!session.status) return 'loading';
    if (
      this.eventPhase === 'open'
      && statusIsRecent
      && session.statusStreamEpoch === this.streamEpoch
    ) return 'live';
    return 'stale';
  }

  private contactsFreshness(session: PanelSession): UiFreshness {
    if (session.friendsError) return session.friends.length > 0 ? 'stale' : 'unavailable';
    if (session.friendsAt === 0) return 'loading';
    const now = this.now();
    if (this.eventPhase !== 'open' || session.friendsStreamEpoch !== this.streamEpoch) return 'stale';
    if (now - session.friendsAt > this.contactsFreshMs) return 'stale';
    return 'live';
  }

  private contactsSnapshot(session: PanelSession): UiContacts {
    const statusFreshness = this.freshnessOf(session);
    const connectionFresh = statusFreshness === 'live';
    return {
      friends: session.friends.map((friend) => toUiFriend(friend, session.status, connectionFresh)),
      at: session.friendsAt > 0 ? session.friendsAt : null,
      error: session.friendsError,
      errorAt: session.friendsErrorAt > 0 ? session.friendsErrorAt : null,
      freshness: this.contactsFreshness(session),
      connectionFreshness: connectionFresh ? 'live' : 'unknown',
      statusAt: session.statusAt > 0 ? session.statusAt : null,
      statusError: session.error,
      statusFreshness,
      total: session.friends.length,
    };
  }

  private snapshot(session: PanelSession, drainEvents: boolean): UiSnapshot {
    const events = drainEvents ? session.events.splice(0) : [...session.events];
    this.stats.eventsForwarded += events.length;
    const statusAt = session.statusAt > 0 ? session.statusAt : null;
    return {
      sessionId: session.id,
      status: session.status,
      statusAt,
      error: session.error,
      errorAt: session.errorAt > 0 ? session.errorAt : null,
      freshness: this.freshnessOf(session),
      stream: {
        phase: this.eventPhase,
        since: this.streamSince,
        lastOpenAt: this.lastStreamOpenAt,
        error: this.streamError,
      },
      events,
      stats: this.snapshotStats(),
    };
  }

  private snapshotStats(): UiStats {
    // Every panel lease shares one Events stream. Report the real stream count
    // (0 or 1) rather than the number of open panel sessions. A stream that
    // dropped and is waiting to reconnect is not active for the client.
    const streamActive = this.stopEvents !== null && this.eventPhase === 'open';
    return {
      ...this.stats,
      openSessions: this.sessions.size,
      subscriptions: streamActive ? 1 : 0,
      streamActive,
      streamPhase: this.eventPhase,
      streamSince: this.streamSince,
    };
  }
}

export function uiInvocationMethods(): string[] {
  return UI_INVOCATIONS.map((item) => item.method);
}

async function readJourneyPlaceholder(dataDir: string, at: number): Promise<JourneyData> {
  const reason = dataDir.length === 0
    ? '宿主没有提供受控数据目录，Agent 记录尚未接入'
    : 'Agent 私有记录暂时不可读取';
  return {
    state: 'error',
    at,
    persona: { state: 'missing', markdown: '', error: reason, sha256: '' },
    growth: { state: 'missing', markdown: '', error: reason, sha256: '' },
    sessions: [],
    sessionsState: 'missing',
    sessionsError: reason,
    sessionsTruncated: false,
  };
}
