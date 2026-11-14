// Host bridge for the DSH Raminga panel.
//
// It reuses the existing RamingaApi (the same Connect-RPC-over-UDS client the
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
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { ConnectRequest, DownloadPeerFileRequest, GetPeerProfileRequest, ListConversationsRequest, ListDiscoveriesRequest, ListFriendsRequest, ListHumanOutboundPeersRequest, ListMessagesRequest, OutboxCancelRequest, SendChatRequest, StatusRequest, } from './gen/raminga/api/v1/api_pb.js';
import { readDiscoveryPost, readDownloadedAgentCard, readJourney, readOwnPublic, } from './local-data.js';
import { subscribeEvents, } from './events.js';
import { UI_INVOCATIONS, UI_SERVICE_KEY } from './ui-typert.js';
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
const JOURNEY_TTL_MS = 15_000;
const MINE_TTL_MS = 15_000;
const MAX_MESSAGE_LOCATE_PAGES = 20;
const MESSAGE_LOCATE_LIMIT = 200;
function shortPeer(value) {
    return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function atOf(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : Date.now();
}
function numberOf(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
function canonicalPeerId(value) {
    try {
        return peerIdFromString(value).toString();
    }
    catch {
        return null;
    }
}
/**
 * Validate either a bare Peer ID or a complete multiaddr using the maintained
 * multiformats/libp2p parsers. We do not hand-roll base58 or multiaddr framing.
 */
export function parseConnectInput(raw) {
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
        }
        catch (error) {
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
function isUnusableIp(value) {
    const version = isIP(value);
    if (version === 4) {
        const parts = value.split('.').map((part) => Number(part));
        if (parts[0] === 0)
            return true;
        if (parts[0] === 127)
            return true;
        if (parts[0] >= 224)
            return true;
        if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255)
            return true;
        return false;
    }
    if (version === 6) {
        const lower = value.toLowerCase();
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped)
            return isUnusableIp(mapped[1]);
        if (lower === '::' || lower === '::1')
            return true;
        if (/^ff/.test(lower))
            return true;
        return false;
    }
    return false;
}
function isPrivateIp(value) {
    const version = isIP(value);
    if (version === 4) {
        const parts = value.split('.').map((part) => Number(part));
        if (parts[0] === 10)
            return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            return true;
        if (parts[0] === 192 && parts[1] === 168)
            return true;
        if (parts[0] === 169 && parts[1] === 254)
            return true;
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
            return true;
        return false;
    }
    if (version === 6) {
        const lower = value.toLowerCase();
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped)
            return isPrivateIp(mapped[1]);
        if (/^f[cd]/.test(lower))
            return true;
        if (/^fe[89ab]/.test(lower))
            return true;
        return false;
    }
    return false;
}
function addressPeerId(parsed) {
    const peers = parsed.getComponents().filter((component) => component.name === 'p2p');
    if (peers.length === 0)
        return null;
    const value = peers[peers.length - 1].value;
    return typeof value === 'string' ? canonicalPeerId(value) : null;
}
/**
 * Build share addresses from advertised direct addresses and active relay
 * reservations only. listen_addrs are intentionally never used as public
 * addresses. Loopback, unspecified and multicast addresses are dropped.
 */
export function buildShareAddresses(status, now = Date.now()) {
    const peerId = canonicalPeerId(status.peerId);
    if (peerId === null)
        return [];
    const result = [];
    const seen = new Set();
    const add = (raw, kind) => {
        if (typeof raw !== 'string' || raw.trim().length === 0)
            return;
        let parsed;
        try {
            parsed = multiaddr(raw.trim());
        }
        catch {
            return;
        }
        const components = parsed.getComponents();
        const circuit = components.some((component) => component.name === 'p2p-circuit');
        const peers = components.filter((component) => component.name === 'p2p');
        if (peers.length > 0) {
            if (addressPeerId(parsed) !== peerId)
                return;
        }
        else {
            if (circuit)
                return;
            try {
                parsed = parsed.encapsulate(`/p2p/${peerId}`);
            }
            catch {
                return;
            }
        }
        const ip = parsed.getComponents().find((component) => component.name === 'ip4' || component.name === 'ip6');
        if (ip && typeof ip.value === 'string' && isUnusableIp(ip.value))
            return;
        const dns = parsed.getComponents().find((component) => component.name === 'dns' || component.name === 'dns4' || component.name === 'dns6' || component.name === 'dnsaddr');
        if (dns && typeof dns.value === 'string' && /(^|\.)localhost$/i.test(dns.value))
            return;
        const normalized = parsed.toString();
        if (seen.has(normalized))
            return;
        seen.add(normalized);
        result.push({
            multiaddr: normalized,
            kind: circuit ? 'relay' : kind,
            scope: ip && typeof ip.value === 'string' && isPrivateIp(ip.value) ? 'private' : 'public',
        });
    };
    for (const address of status.advertisedAddrs)
        add(address, 'direct');
    for (const relay of status.relays) {
        if (relay.reservationStatus !== 'active')
            continue;
        const expires = Number(relay.expiresAtUnixMs);
        if (expires > 0 && expires <= now)
            continue;
        const relayed = relay.relayedAddr || relay.advertisedAddr;
        if (relayed.length > 0)
            add(relayed, 'relay');
    }
    return result;
}
function toUiFriend(friend, status, connectionFresh) {
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
    };
}
function toUiStatus(status) {
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
function toUiMessage(row) {
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
function toUiRetention(row) {
    if (!row)
        return null;
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
export function mapDaemonEvent(raw) {
    const atUnixMs = atOf(raw.atUnixMs);
    const id = `${atUnixMs}-${randomUUID().slice(0, 8)}`;
    const chat = raw.chatReceived;
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
    const ack = raw.ack;
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
    const connection = raw.connection;
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
export class RamingaUiBridge {
    api;
    service;
    sessions = new Map();
    closedSessions = new Map();
    reaper;
    now;
    statusTtlMs;
    statusFreshMs;
    contactsTtlMs;
    contactsFreshMs;
    conversationsTtlMs;
    conversationsFreshMs;
    messagesTtlMs;
    messagesFreshMs;
    dataDir;
    postCache = new Map();
    connectTimeoutMs;
    reconcileDelayMs;
    streamReadyTimeoutMs;
    subscribe;
    subscribeOptions;
    stopEvents = null;
    ready = null;
    streamReady = null;
    resolveStreamReady = null;
    eventPhase = 'closed';
    streamSince;
    streamError = null;
    lastStreamOpenAt = null;
    // Incremented on every stream open. A Status read that began under an older
    // stream epoch cannot make the snapshot live after a reconnect.
    streamEpoch = 0;
    statusRefresh = null;
    statusRefreshDirty = false;
    friendsRefresh = null;
    // Bumped whenever the last panel lease goes away. A read started for an
    // older lease generation must not populate a lease opened afterwards.
    generation = 0;
    reconcileTimer = null;
    disposed = false;
    stats = {
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
    constructor(api, options = {}) {
        this.api = api;
        this.now = options.now ?? (() => Date.now());
        this.statusTtlMs = options.statusTtlMs ?? STATUS_TTL_MS;
        this.statusFreshMs = options.statusFreshMs ?? STATUS_FRESH_MS;
        this.contactsTtlMs = options.contactsTtlMs ?? CONTACTS_TTL_MS;
        this.contactsFreshMs = options.contactsFreshMs ?? CONTACTS_FRESH_MS;
        this.conversationsTtlMs = options.conversationsTtlMs ?? CONVERSATIONS_TTL_MS;
        this.conversationsFreshMs = options.conversationsFreshMs ?? CONVERSATIONS_FRESH_MS;
        this.messagesTtlMs = options.messagesTtlMs ?? MESSAGES_TTL_MS;
        this.messagesFreshMs = options.messagesFreshMs ?? MESSAGES_FRESH_MS;
        this.dataDir = options.dataDir ?? this.api.config?.dataDir ?? '';
        this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        this.reconcileDelayMs = options.reconcileDelayMs ?? CONNECTION_RECONCILE_DELAY_MS;
        this.streamReadyTimeoutMs = options.streamReadyTimeoutMs ?? STREAM_READY_TIMEOUT_MS;
        this.subscribe = options.subscribe ?? subscribeEvents;
        this.subscribeOptions = options.subscribeOptions ?? {};
        this.streamSince = this.now();
        this.stats.streamSince = this.streamSince;
        const service = {
            open: (sessionId) => this.open(sessionId),
            poll: (sessionId) => this.poll(sessionId, false),
            refresh: (sessionId) => this.poll(sessionId, true),
            close: (sessionId) => this.close(sessionId),
            contacts: (sessionId, force) => this.contacts(sessionId, force === true),
            connect: (sessionId, input) => this.connect(sessionId, input),
            checkContact: (sessionId, peerId) => this.checkContact(sessionId, peerId),
            share: (sessionId) => this.share(sessionId),
            conversations: (sessionId, force) => this.conversations(sessionId, force === true),
            messages: (sessionId, peerId, before, force) => this.messages(sessionId, peerId, before ?? '', force === true),
            send: (sessionId, peerId, text, requestId) => this.send(sessionId, peerId, text, requestId),
            cancelOutbox: (sessionId, messageId) => this.cancelOutbox(sessionId, messageId),
            discoveries: (sessionId, familiar, force) => this.discoveries(sessionId, familiar === true, force === true),
            discoveryContent: (sessionId, id) => this.discoveryContent(sessionId, id),
            humanOutbound: (sessionId, force) => this.humanOutbound(sessionId, force === true),
            mine: (sessionId, force) => this.mine(sessionId, force === true),
            peerProfile: (sessionId, peerId, force) => this.peerProfile(sessionId, peerId, force === true),
            journey: (sessionId, force) => this.journey(sessionId, force === true),
            locateMessage: (sessionId, peerId, messageId) => this.locateMessage(sessionId, peerId, messageId),
            getStats: () => this.getStats(),
        };
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
    getStats() {
        return this.snapshotStats();
    }
    async open(sessionId) {
        this.assertOpen();
        const id = this.normalizeSessionId(sessionId);
        this.pruneClosedSessions();
        if (this.closedSessions.has(id))
            throw new Error('Raminga panel lease was closed');
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
                conversations: { items: [], at: 0, error: null, errorAt: 0, streamEpoch: -1, retention: null },
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
                journey: { data: null, at: 0, errorAt: 0 },
                journeyBusy: null,
            };
            this.sessions.set(id, session);
            this.stats.sessionsOpened += 1;
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
        }
        catch (error) {
            // Initialization failure, stream setup failure, or a close that raced
            // with this open must release the session immediately; the idle reaper
            // is only a backstop for abrupt browser drops.
            this.releaseSession(session);
            throw error;
        }
    }
    async poll(sessionId, force) {
        this.assertOpen();
        const id = this.normalizeSessionId(sessionId);
        const session = this.sessions.get(id);
        if (!session)
            throw new Error('Raminga panel lease is not open; reopen the panel');
        session.lastPollAt = this.now();
        if (force || session.statusAt === 0 || this.now() - session.statusAt > this.statusTtlMs) {
            await this.reconcileStatus(force ? 'manual-refresh' : 'poll');
            this.assertSessionActive(session);
        }
        return this.snapshot(session, true);
    }
    async close(sessionId) {
        const id = this.acceptedSessionId(sessionId);
        if (id !== null) {
            const session = this.sessions.get(id);
            if (session)
                this.releaseSession(session);
            if (this.sessions.size === 0)
                this.stopEventStream();
            if (!this.disposed)
                this.rememberClosedSession(id);
        }
        return this.snapshotStats();
    }
    /**
     * Read ListFriends and, when needed, a fresh Status for connection-state
     * normalization. The read states stay independent: a failed friend read
     * never becomes an empty list, and a stale Status never proves "not connected".
     */
    async contacts(sessionId, force = false) {
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
     * Dial a user-provided Peer ID or complete multiaddr. Parsing is done with
     * maintained libp2p parsers. A successful dial is reported even when the
     * friend list refresh fails or the friend write has not happened yet.
     */
    async connect(sessionId, input) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const at = this.now();
        const raw = typeof input === 'string' ? input : '';
        const parsed = parseConnectInput(raw);
        const emptyContact = { ok: false, found: false, error: null, at: null };
        const emptyStatus = { ok: false, at: null, error: null };
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
            response = await this.api.call((client) => client.connect(request, { timeoutMs: this.connectTimeoutMs }), '连接节点');
        }
        catch (error) {
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
        let contact = {
            ok: false,
            found: false,
            error: '页面已关闭，未核对联系人。',
            at: null,
        };
        const status = { ok: false, at: null, error: '页面已关闭，未核对节点状态。' };
        let contacts = null;
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
    async checkContact(sessionId, peerId) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
        if (canonical === null) {
            return { ok: false, found: false, error: 'Peer ID 格式不正确。', at: null, contacts: null };
        }
        await this.awaitStatusIdle();
        await this.awaitFriendsIdle();
        if (!this.isSessionActive(session))
            throw new Error('Raminga panel lease was closed');
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
    async share(sessionId) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        await this.awaitStatusIdle();
        if (!this.isSessionActive(session))
            throw new Error('Raminga panel lease was closed');
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
    async conversations(sessionId, force = false) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const state = session.conversations;
        const need = force || state.at === 0 || this.now() - state.at > this.conversationsTtlMs;
        if (need)
            await this.refreshConversations(session);
        this.assertSessionActive(session);
        return this.conversationsSnapshot(session);
    }
    refreshConversations(session) {
        if (session.conversationsBusy !== null)
            return session.conversationsBusy;
        const at = this.now();
        const streamEpoch = this.streamEpoch;
        let promise;
        promise = (async () => {
            try {
                await this.ensureReady();
                const response = await this.api.call((client) => client.listConversations(new ListConversationsRequest({ limit: CONVERSATION_PAGE_LIMIT }), { timeoutMs: 3500 }), '读取会话列表');
                if (!this.isSessionActive(session))
                    return;
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
                }));
                state.at = at;
                state.error = null;
                state.errorAt = 0;
                state.streamEpoch = streamEpoch;
                state.retention = toUiRetention(response.retention);
                this.stats.conversationsReads += 1;
            }
            catch (error) {
                if (!this.isSessionActive(session))
                    return;
                const state = session.conversations;
                state.error = errorMessage(error);
                state.errorAt = this.now();
                this.stats.conversationsFailures += 1;
            }
            finally {
                if (session.conversationsBusy === promise)
                    session.conversationsBusy = null;
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
    async messages(sessionId, peerId, before = '', force = false) {
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
        if (need)
            await this.refreshMessages(session, canonical);
        this.assertSessionActive(session);
        return this.messagePageSnapshot(session, canonical);
    }
    refreshMessages(session, peerId) {
        const existing = session.messagesBusy.get(peerId);
        if (existing !== undefined)
            return existing;
        const at = this.now();
        const streamEpoch = this.streamEpoch;
        let promise;
        promise = (async () => {
            try {
                await this.ensureReady();
                const response = await this.api.call((client) => client.listMessages(new ListMessagesRequest({ peerId, limit: MESSAGE_PAGE_LIMIT }), { timeoutMs: 3500 }), '读取会话消息');
                if (!this.isSessionActive(session))
                    return;
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
            }
            catch (error) {
                if (!this.isSessionActive(session))
                    return;
                let state = session.messages.get(peerId);
                if (!state) {
                    state = this.emptyMessageState();
                    session.messages.set(peerId, state);
                }
                state.error = errorMessage(error);
                state.errorAt = this.now();
                this.stats.messagesFailures += 1;
            }
            finally {
                if (session.messagesBusy.get(peerId) === promise)
                    session.messagesBusy.delete(peerId);
            }
        })();
        session.messagesBusy.set(peerId, promise);
        return promise;
    }
    async fetchMessagePage(peerId, before) {
        const at = this.now();
        const streamEpoch = this.streamEpoch;
        try {
            await this.ensureReady();
            const response = await this.api.call((client) => client.listMessages(new ListMessagesRequest({ peerId, before, limit: MESSAGE_PAGE_LIMIT }), { timeoutMs: 3500 }), '读取更早消息');
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
        }
        catch (error) {
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
     * Send one human-origin message through the explicit local operator path.
     * agent_origin stays false and origin is "human"; the existing Agent tools
     * never call this method and continue to set agent_origin.
     */
    async send(sessionId, peerId, text, requestId) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const at = this.now();
        const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
        const body = typeof text === 'string' ? text : '';
        const request = typeof requestId === 'string' ? requestId : '';
        const base = {
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
            const response = await this.api.call((client) => client.sendChat(new SendChatRequest({
                peerId: canonical,
                text: body,
                origin: 'human',
                agentOrigin: false,
                requestId: request,
            }), { timeoutMs: SEND_TIMEOUT_MS }), '发送消息');
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
        }
        catch (error) {
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
    async cancelOutbox(sessionId, messageId) {
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
            const response = await this.api.call((client) => client.outboxCancel(new OutboxCancelRequest({ messageId: id }), { timeoutMs: CANCEL_TIMEOUT_MS }), '取消待发消息');
            this.stats.cancels += 1;
            session.messages.clear();
            return {
                ok: response.cancelled === true,
                messageId: id,
                status: String(response.status || 'cancelled'),
                error: response.cancelled === true ? null : '这条消息已经不能取消。',
                at: this.now(),
            };
        }
        catch (error) {
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
    async discoveries(sessionId, familiar = false, force = false) {
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
        if (need)
            await this.loadDiscoveries(session, familiar, force);
        this.assertSessionActive(session);
        return this.discoveriesSnapshot(session, familiar);
    }
    emptyDiscoveriesState(familiar) {
        return {
            items: [], at: 0, error: null, errorAt: 0, streamEpoch: -1,
            familiar, scanned: 0, truncated: false, relationComplete: !familiar, ignored: 0,
        };
    }
    async loadDiscoveries(session, familiar, force = false) {
        const key = familiar ? 'familiar' : 'all';
        const existing = session.discoveryBusy.get(key);
        if (existing !== undefined) {
            if (!force)
                return existing;
            // A send may invalidate the familiar cache while an older read is still
            // in flight. A forced re-read waits for that read, then takes one fresh
            // relation snapshot instead of returning the pre-send result.
            return existing.then(() => this.loadDiscoveries(session, familiar, true));
        }
        let promise;
        promise = (async () => {
            const at = this.now();
            const streamEpoch = this.streamEpoch;
            try {
                if (this.dataDir.length === 0)
                    throw new Error('宿主没有提供受控数据目录，无法核对公开内容来源');
                await this.ensureReady();
                let relation = {
                    peers: new Set(), complete: true, scanned: 0,
                };
                if (familiar) {
                    relation = await this.completeHumanRelations(session);
                }
                const rows = [];
                let before = '';
                let truncated = false;
                let pages = 0;
                while (rows.length < MAX_DISCOVERY_SCAN && pages < 50) {
                    pages += 1;
                    const response = await this.api.call((client) => client.listDiscoveries(new ListDiscoveriesRequest({ limit: DISCOVERY_PAGE_LIMIT, before }), { timeoutMs: 4000 }), '读取公开内容索引');
                    const page = response.discoveries ?? [];
                    for (const row of page) {
                        if (rows.length >= MAX_DISCOVERY_SCAN) {
                            truncated = true;
                            break;
                        }
                        rows.push({
                            id: String(row.id ?? ''),
                            peerId: String(row.peerId ?? ''),
                            path: String(row.path ?? ''),
                            sha256: String(row.sha256 ?? ''),
                            sizeBytes: numberOf(row.sizeBytes),
                            fetchedAt: numberOf(row.fetchedAtUnixMs),
                            source: String(row.source ?? ''),
                        });
                    }
                    if (response.hasMore !== true)
                        break;
                    const next = String(response.nextBefore ?? '');
                    if (next.length === 0 || next === before)
                        throw new Error('公开内容索引分页游标没有前进，无法确认已完整读取');
                    if (rows.length >= MAX_DISCOVERY_SCAN) {
                        truncated = true;
                        break;
                    }
                    before = next;
                }
                if (rows.length < MAX_DISCOVERY_SCAN && before !== '') {
                    // The daemon still had more pages when the bounded page loop ended.
                    truncated = true;
                }
                const matched = familiar ? rows.filter((row) => relation.peers.has(row.peerId)) : rows;
                const items = [];
                let ignored = 0;
                const toParse = matched.slice(0, MAX_DISCOVERY_PARSE);
                if (matched.length > toParse.length)
                    truncated = true;
                for (const row of toParse) {
                    const content = await this.parseDiscoveryRow(row);
                    if (content.post === null) {
                        if (content.unreadable) {
                            items.push({
                                id: row.id, peerId: row.peerId, path: row.path, sha256: row.sha256,
                                sizeBytes: row.sizeBytes, fetchedAt: row.fetchedAt, source: row.source,
                                authorKind: '', authorName: '', title: row.path, summary: '',
                                tags: [], publishedAt: '',
                                contentState: 'unreadable', contentError: content.error,
                            });
                        }
                        else {
                            ignored += 1;
                        }
                        continue;
                    }
                    items.push({
                        id: row.id, peerId: row.peerId, path: row.path, sha256: row.sha256,
                        sizeBytes: row.sizeBytes, fetchedAt: row.fetchedAt, source: row.source,
                        authorKind: content.post.authorKind,
                        authorName: content.post.authorName,
                        title: content.post.title,
                        summary: content.post.summary,
                        tags: content.post.tags,
                        publishedAt: content.post.publishedAt,
                        contentState: 'available',
                        contentError: '',
                    });
                }
                if (!this.isSessionActive(session))
                    return;
                const state = session.discoveries.get(key);
                state.items = items;
                state.at = at;
                state.error = null;
                state.errorAt = 0;
                state.streamEpoch = streamEpoch;
                state.scanned = rows.length;
                state.truncated = truncated;
                state.relationComplete = familiar ? relation.complete : true;
                state.ignored = ignored;
            }
            catch (error) {
                if (!this.isSessionActive(session))
                    return;
                const state = session.discoveries.get(key);
                state.error = errorMessage(error);
                state.errorAt = this.now();
            }
            finally {
                if (session.discoveryBusy.get(key) === promise)
                    session.discoveryBusy.delete(key);
            }
        })();
        session.discoveryBusy.set(key, promise);
        return promise;
    }
    async parseDiscoveryRow(row) {
        const cacheKey = `${row.sha256.toLowerCase()}\u0000${row.path}`;
        const cached = this.postCache.get(cacheKey);
        if (cached !== undefined && this.now() - cached.at < 5 * 60_000) {
            return { post: cached.post, error: cached.error, unreadable: cached.post === null && cached.error.length > 0 };
        }
        let result;
        try {
            const post = await readDiscoveryPost(this.dataDir, row);
            result = { post, error: '', unreadable: false };
        }
        catch (error) {
            const message = errorMessage(error);
            // Missing/corrupt downloaded bytes are a display state for a traceable
            // row. A well-formed file that is not a versioned post is not shown as a
            // post at all, but its count is disclosed.
            const unreadable = !/不是公开帖子|author|作者|schema_version|format|标题|正文|JSON|author\.kind|published_at/i.test(message);
            result = { post: null, error: message, unreadable };
        }
        if (this.postCache.size > 256) {
            const first = this.postCache.keys().next().value;
            if (first !== undefined)
                this.postCache.delete(first);
        }
        this.postCache.set(cacheKey, { at: this.now(), ...result });
        return result;
    }
    discoveriesSnapshot(session, familiar) {
        const state = session.discoveries.get(familiar ? 'familiar' : 'all') ?? this.emptyDiscoveriesState(familiar);
        return {
            items: state.items.map((item) => ({ ...item, tags: [...item.tags] })),
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
    async discoveryContent(sessionId, id) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const wanted = typeof id === 'string' ? id : String(id ?? '');
        let row = null;
        for (const state of session.discoveries.values()) {
            const found = state.items.find((item) => item.id === wanted);
            if (found) {
                row = found;
                break;
            }
        }
        if (row === null)
            throw new Error('没有找到这条公开内容，请先刷新动态');
        if (row.contentState === 'unreadable') {
            return {
                ok: false, id: row.id, peerId: row.peerId, path: row.path, sha256: row.sha256,
                sizeBytes: row.sizeBytes, source: row.source, fetchedAt: row.fetchedAt, post: null,
                error: row.contentError || '本地副本不可读取',
            };
        }
        try {
            const post = await readDiscoveryPost(this.dataDir, row);
            return {
                ok: true, id: row.id, peerId: row.peerId, path: row.path, sha256: row.sha256,
                sizeBytes: row.sizeBytes, source: row.source, fetchedAt: row.fetchedAt,
                post: { ...post, contentState: 'available' }, error: null,
            };
        }
        catch (error) {
            return {
                ok: false, id: row.id, peerId: row.peerId, path: row.path, sha256: row.sha256,
                sizeBytes: row.sizeBytes, source: row.source, fetchedAt: row.fetchedAt, post: null, error: errorMessage(error),
            };
        }
    }
    /** Complete stable relation snapshot used by the familiar filter. */
    async humanOutbound(sessionId, force = false) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const state = session.humanOutbound;
        const need = force || state.at === 0 || this.now() - state.at > DISCOVERY_TTL_MS;
        if (need) {
            try {
                await this.loadHumanOutbound(session, force);
            }
            catch (error) {
                if (this.isSessionActive(session)) {
                    state.error = errorMessage(error);
                    state.errorAt = this.now();
                }
            }
        }
        this.assertSessionActive(session);
        return this.humanOutboundSnapshot(session);
    }
    async loadHumanOutbound(session, force) {
        if (session.humanOutboundBusy !== null) {
            if (!force)
                return session.humanOutboundBusy;
            return session.humanOutboundBusy.then(() => this.loadHumanOutbound(session, true));
        }
        const at = this.now();
        const streamEpoch = this.streamEpoch;
        let promise;
        promise = (async () => {
            try {
                const result = await this.completeHumanRelations(session);
                if (!this.isSessionActive(session))
                    return;
                const state = session.humanOutbound;
                state.peers = [...result.peers];
                state.complete = result.complete;
                state.scanned = result.scanned;
                state.at = at;
                state.error = result.complete ? null : '人工交流关系超过本次有界读取范围，不能据此断言筛选完整';
                state.errorAt = result.complete ? 0 : this.now();
                state.streamEpoch = streamEpoch;
            }
            finally {
                if (session.humanOutboundBusy === promise)
                    session.humanOutboundBusy = null;
            }
        })();
        session.humanOutboundBusy = promise;
        return promise;
    }
    async completeHumanRelations(session) {
        await this.ensureReady();
        const peers = new Set();
        let before = '';
        let complete = false;
        let scanned = 0;
        let pages = 0;
        while (scanned < MAX_HUMAN_RELATION_SCAN && pages < 50) {
            pages += 1;
            const response = await this.api.call((client) => client.listHumanOutboundPeers(new ListHumanOutboundPeersRequest({ limit: HUMAN_RELATION_PAGE_LIMIT, before }), { timeoutMs: 4000 }), '读取人工交流关系');
            const page = response.peers ?? [];
            for (const peer of page) {
                const id = canonicalPeerId(String(peer.peerId ?? ''));
                if (id !== null)
                    peers.add(id);
            }
            scanned += page.length;
            if (response.hasMore !== true) {
                complete = true;
                break;
            }
            const next = String(response.nextBefore ?? '');
            if (next.length === 0 || next === before) {
                throw new Error('人工交流关系分页游标没有前进，无法确认已完整读取');
            }
            before = next;
            if (!this.isSessionActive(session))
                break;
        }
        return { peers, complete, scanned };
    }
    humanOutboundSnapshot(session) {
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
    /** Local user profile and explicitly user-authored public posts. */
    async mine(sessionId, force = false) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const state = session.mine;
        const need = force || state.at === 0 || this.now() - state.at > MINE_TTL_MS;
        if (need)
            await this.loadMine(session);
        this.assertSessionActive(session);
        if (state.data !== null)
            return state.data;
        return this.emptyMine(session, state.errorAt > 0 ? '公开资料读取失败，请重试' : '正在读取本机公开资料');
    }
    emptyMine(session, error) {
        return {
            peerId: session.status?.peerId ?? '',
            at: null,
            error,
            errorAt: session.mine.errorAt > 0 ? session.mine.errorAt : null,
            freshness: 'unavailable',
            profile: { state: 'missing', markdown: '', displayName: '', error: '', path: 'profile/index.md', at: null },
            posts: { state: 'missing', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false },
        };
    }
    async loadMine(session) {
        if (session.mineBusy !== null)
            return session.mineBusy;
        const at = this.now();
        let promise;
        promise = (async () => {
            try {
                if (this.dataDir.length === 0)
                    throw new Error('宿主没有提供受控数据目录，无法读取本机公开资料');
                await this.ensureReady();
                if (session.statusAt === 0 || this.now() - session.statusAt > this.statusTtlMs) {
                    await this.reconcileStatus('mine');
                }
                if (!this.isSessionActive(session))
                    return;
                const peerId = session.status?.peerId ?? '';
                if (peerId.length === 0)
                    throw new Error('没有读到本机 Peer ID，无法核对本人作者声明');
                const local = await readOwnPublic(this.dataDir, peerId);
                if (!this.isSessionActive(session))
                    return;
                session.mine.data = {
                    peerId,
                    at,
                    error: null,
                    errorAt: null,
                    freshness: this.listFreshness(at, null, true, this.streamEpoch, DISCOVERY_FRESH_MS),
                    profile: local.profile,
                    posts: local.posts,
                };
                session.mine.at = at;
                session.mine.errorAt = 0;
            }
            catch (error) {
                if (!this.isSessionActive(session))
                    return;
                session.mine.errorAt = this.now();
                session.mine.data = this.emptyMine(session, errorMessage(error));
            }
            finally {
                if (session.mineBusy === promise)
                    session.mineBusy = null;
            }
        })();
        session.mineBusy = promise;
        return promise;
    }
    /** Peer public profile plus a separately sourced public Agent card. */
    async peerProfile(sessionId, peerId, force = false) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const canonical = canonicalPeerId(typeof peerId === 'string' ? peerId : '');
        if (canonical === null) {
            return this.emptyPeerProfile(String(peerId ?? ''), 'Peer ID 格式不正确。', '');
        }
        const cached = session.peerProfiles.get(canonical);
        if (!force && cached !== undefined && this.now() - cached.at < PROFILE_TTL_MS)
            return cached.data;
        if (!session.peerProfileBusy.has(canonical)) {
            session.peerProfileBusy.set(canonical, this.loadPeerProfile(session, canonical));
        }
        await session.peerProfileBusy.get(canonical);
        this.assertSessionActive(session);
        return session.peerProfiles.get(canonical)?.data ?? this.emptyPeerProfile(canonical, '对方公开资料读取失败。', '');
    }
    emptyPeerProfile(peerId, error, localName) {
        return {
            peerId,
            localName,
            remoteName: '',
            found: false,
            text: '',
            files: [],
            at: null,
            error,
            freshness: 'unavailable',
            agentCard: { state: 'missing', card: null, error: '没有读取到公开 Agent 资料' },
        };
    }
    async loadPeerProfile(session, peerId) {
        const at = this.now();
        const localName = this.friendName(peerId);
        try {
            await this.ensureReady();
            const response = await this.api.call((client) => client.getPeerProfile(new GetPeerProfileRequest({ peerId }), { timeoutMs: 15_000 }), '读取对方公开资料');
            const found = response.found === true;
            const files = (response.files ?? []).slice(0, 200).map((file) => String(file)).filter((file) => file.length > 0 && file.length <= 256);
            let agentCard = { state: 'missing', card: null, error: '对方没有公开 Agent 卡片' };
            if (found && files.includes('profile/agent-card.json')) {
                try {
                    const final = await this.downloadForProfile(peerId, 'profile/agent-card.json');
                    agentCard = await readDownloadedAgentCard(this.dataDir, peerId, final.path, final.sha256, final.size);
                }
                catch (error) {
                    agentCard = { state: 'error', card: null, error: errorMessage(error) };
                }
            }
            if (!this.isSessionActive(session))
                return;
            if (session.peerProfiles.size > 128) {
                const first = session.peerProfiles.keys().next().value;
                if (first !== undefined)
                    session.peerProfiles.delete(first);
            }
            session.peerProfiles.set(peerId, {
                at,
                data: {
                    peerId,
                    localName,
                    remoteName: String(response.name ?? ''),
                    found,
                    text: String(response.text ?? '').slice(0, 256 * 1024),
                    files,
                    at,
                    error: null,
                    freshness: this.listFreshness(at, null, found, this.streamEpoch, DISCOVERY_FRESH_MS),
                    agentCard,
                },
            });
        }
        catch (error) {
            if (!this.isSessionActive(session))
                return;
            if (session.peerProfiles.size > 128) {
                const first = session.peerProfiles.keys().next().value;
                if (first !== undefined)
                    session.peerProfiles.delete(first);
            }
            session.peerProfiles.set(peerId, {
                at,
                data: { ...this.emptyPeerProfile(peerId, errorMessage(error), localName), at },
            });
        }
        finally {
            session.peerProfileBusy.delete(peerId);
        }
    }
    friendName(peerId) {
        // Friend names are local snapshots already cached for the panel; do not
        // fetch the friend list just to label a profile.
        for (const session of this.sessions.values()) {
            const row = session.friends.find((item) => canonicalPeerId(item.peerId) === peerId);
            if (row?.name)
                return row.name;
        }
        return '';
    }
    async downloadForProfile(peerId, relative) {
        const frames = await this.api.call(async (client) => {
            const stream = await client.downloadPeerFile(new DownloadPeerFileRequest({ peerId, path: relative, recordDiscovery: false }), { timeoutMs: 30_000 });
            const collected = [];
            for await (const frame of stream) {
                collected.push({
                    phase: String(frame.phase ?? ''),
                    path: String(frame.path ?? ''),
                    localPath: String(frame.localPath ?? ''),
                    sha256: String(frame.sha256 ?? ''),
                    totalBytes: numberOf(frame.totalBytes),
                    error: String(frame.error ?? ''),
                });
            }
            return collected;
        }, '读取对方公开 Agent 卡片');
        const last = frames.length > 0 ? frames[frames.length - 1] : null;
        if (last === null || last.phase !== 'complete' || last.error.length > 0) {
            throw new Error(last?.error || '公开 Agent 卡片下载没有完成');
        }
        if (last.path !== relative)
            throw new Error('下载结果的公开路径与请求不一致');
        return { path: last.path, localPath: last.localPath, sha256: last.sha256, size: last.totalBytes };
    }
    /** Read private Agent persona/growth and existing Journey schemas. */
    async journey(sessionId, force = false) {
        this.assertOpen();
        const session = this.sessionFor(sessionId);
        session.lastPollAt = this.now();
        const state = session.journey;
        const need = force || state.at === 0 || this.now() - state.at > JOURNEY_TTL_MS;
        if (need)
            await this.loadJourney(session);
        this.assertSessionActive(session);
        if (state.data !== null)
            return state.data;
        const unavailable = await readJourneyPlaceholder(this.dataDir, this.now());
        return { ...unavailable, freshness: 'unavailable' };
    }
    async loadJourney(session) {
        if (session.journeyBusy !== null)
            return session.journeyBusy;
        const at = this.now();
        let promise;
        promise = (async () => {
            try {
                if (this.dataDir.length === 0)
                    throw new Error('宿主没有提供受控数据目录，不能读取 Agent 记录');
                const data = await readJourney(this.dataDir);
                if (!this.isSessionActive(session))
                    return;
                session.journey.data = {
                    ...data,
                    freshness: data.state === 'missing' ? 'unavailable' : this.listFreshness(at, null, data.state === 'available', this.streamEpoch, DISCOVERY_FRESH_MS),
                };
                session.journey.at = at;
                session.journey.errorAt = 0;
            }
            catch (error) {
                if (!this.isSessionActive(session))
                    return;
                session.journey.errorAt = this.now();
                const placeholder = await readJourneyPlaceholder(this.dataDir, at);
                session.journey.data = { ...placeholder, state: 'error', sessionsError: errorMessage(error), freshness: 'unavailable' };
            }
            finally {
                if (session.journeyBusy === promise)
                    session.journeyBusy = null;
            }
        })();
        session.journeyBusy = promise;
        return promise;
    }
    /**
     * Locate a message referenced by a Journey event inside the currently
     * retained Node history. This only reports presence; it never substitutes a
     * different message. The scan is bounded and says so when it cannot finish.
     */
    async locateMessage(sessionId, peerId, messageId) {
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
            const response = await this.api.call((client) => client.listMessages(new ListMessagesRequest({ peerId: canonical, before, limit: MESSAGE_LOCATE_LIMIT }), { timeoutMs: 4000 }), '核对历史消息引用');
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
    emptyMessageState() {
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
    emptyMessagePage(peerId, error) {
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
    conversationsSnapshot(session) {
        const state = session.conversations;
        return {
            conversations: state.items.map((row) => ({ ...row })),
            at: state.at > 0 ? state.at : null,
            error: state.error,
            errorAt: state.errorAt > 0 ? state.errorAt : null,
            freshness: this.listFreshness(state.at, state.error, state.items.length > 0, state.streamEpoch, this.conversationsFreshMs),
            retention: state.retention ? { ...state.retention } : null,
        };
    }
    messagePageSnapshot(session, peerId) {
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
    listFreshness(at, error, hasData, streamEpoch, freshMs) {
        if (error)
            return hasData ? 'stale' : 'unavailable';
        if (at === 0)
            return 'loading';
        if (this.eventPhase !== 'open' || streamEpoch !== this.streamEpoch)
            return 'stale';
        if (this.now() - at > freshMs)
            return 'stale';
        return 'live';
    }
    pageFreshness(at, error, hasData, streamEpoch) {
        if (error)
            return hasData ? 'stale' : 'unavailable';
        if (at === 0)
            return 'loading';
        if (this.eventPhase !== 'open' || streamEpoch !== this.streamEpoch)
            return 'stale';
        if (this.now() - at > this.messagesFreshMs)
            return 'stale';
        return 'live';
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.generation += 1;
        this.statusRefreshDirty = false;
        this.friendsRefresh = null;
        clearInterval(this.reaper);
        this.cancelReconcileTimer();
        this.stats.sessionsClosed += this.sessions.size;
        this.sessions.clear();
        this.closedSessions.clear();
        this.stopEventStream();
        // The same cleanup path runs when the plugin fiber unloads; keep one
        // observable line so a real host shutdown leaves evidence in its log.
        console.info('[raminga-ui] bridge disposed', JSON.stringify(this.snapshotStats()));
    }
    assertOpen() {
        if (this.disposed)
            throw new Error('Raminga UI bridge is disposed');
    }
    isSessionActive(session) {
        return !this.disposed && this.sessions.get(session.id) === session;
    }
    assertSessionActive(session) {
        if (!this.isSessionActive(session))
            throw new Error('Raminga panel lease was closed');
    }
    normalizeSessionId(value) {
        if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
            throw new Error('invalid Raminga panel session id');
        }
        return value;
    }
    sessionFor(sessionId) {
        const session = this.sessions.get(this.normalizeSessionId(sessionId));
        if (!session)
            throw new Error('Raminga panel lease is not open; reopen the panel');
        return session;
    }
    async awaitStatusIdle() {
        const active = this.statusRefresh;
        if (active === null)
            return;
        try {
            await active.promise;
        }
        catch {
            // The read records its own error; the caller only needs the barrier.
        }
    }
    async awaitFriendsIdle() {
        const active = this.friendsRefresh;
        if (active === null)
            return;
        try {
            await active.promise;
        }
        catch {
            // The read records its own error; the caller only needs the barrier.
        }
    }
    /** close() stays idempotent for malformed ids instead of throwing. */
    acceptedSessionId(value) {
        if (typeof value !== 'string')
            return null;
        try {
            return this.normalizeSessionId(value);
        }
        catch {
            return null;
        }
    }
    releaseSession(session) {
        if (this.sessions.get(session.id) !== session)
            return;
        this.sessions.delete(session.id);
        this.stats.sessionsClosed += 1;
        if (this.sessions.size === 0) {
            this.generation += 1;
            this.statusRefreshDirty = false;
            this.cancelReconcileTimer();
            this.stopEventStream();
        }
    }
    rememberClosedSession(id) {
        // Refresh insertion order so the oldest entry is evicted first.
        this.closedSessions.delete(id);
        this.closedSessions.set(id, this.now());
        while (this.closedSessions.size > MAX_CLOSED_SESSIONS) {
            const oldest = this.closedSessions.keys().next().value;
            if (oldest === undefined)
                break;
            this.closedSessions.delete(oldest);
        }
    }
    pruneClosedSessions() {
        const cutoff = this.now() - CLOSED_SESSION_TTL_MS;
        for (const [id, closedAt] of this.closedSessions) {
            if (closedAt >= cutoff)
                break;
            this.closedSessions.delete(id);
        }
    }
    ensureReady() {
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
    reconcileStatus(reason, { trailing = false } = {}) {
        if (this.disposed || this.sessions.size === 0)
            return Promise.resolve();
        this.cancelReconcileTimer();
        const generation = this.generation;
        if (this.statusRefresh !== null && this.statusRefresh.generation === generation) {
            // A concurrent poll/refresh can share the read already in flight. An
            // event or stream reopen that lands during the read needs one trailing
            // pass so the snapshot is at least as new as that notification.
            if (trailing)
                this.statusRefreshDirty = true;
            this.stats.reconcileCoalesced += 1;
            return this.statusRefresh.promise;
        }
        this.stats.reconcileRuns += 1;
        const entry = { generation, promise: this.runReconcile(generation) };
        this.statusRefresh = entry;
        return entry.promise;
    }
    async runReconcile(generation) {
        let passes = 0;
        try {
            do {
                if (generation !== this.generation || this.disposed || this.sessions.size === 0)
                    return;
                this.statusRefreshDirty = false;
                const result = await this.fetchStatus();
                // The last lease may have closed (and a new one opened) while this
                // read was in flight; discard the older generation rather than
                // overwriting the new session with it.
                if (generation !== this.generation || this.disposed || this.sessions.size === 0)
                    return;
                this.applyStatusResult(result);
                passes += 1;
            } while (this.statusRefreshDirty
                && passes < MAX_RECONCILE_PASSES
                && generation === this.generation
                && !this.disposed
                && this.sessions.size > 0);
        }
        finally {
            if (this.statusRefresh !== null && this.statusRefresh.generation === generation) {
                this.statusRefresh = null;
            }
            // A burst larger than the pass budget still gets a trailing read rather
            // than leaving the final event unverified.
            if (this.statusRefreshDirty
                && generation === this.generation
                && !this.disposed
                && this.sessions.size > 0) {
                this.statusRefreshDirty = false;
                this.scheduleReconcile(0, 'event-backlog');
            }
        }
    }
    async fetchStatus() {
        try {
            const streamEpoch = this.streamEpoch;
            await this.ensureReady();
            const status = await this.api.call((client) => client.status(new StatusRequest(), { timeoutMs: 2500 }), '读取节点状态');
            return { ok: true, status: toUiStatus(status), at: this.now(), streamEpoch };
        }
        catch (error) {
            return { ok: false, error: errorMessage(error), at: this.now() };
        }
    }
    /** Coalesce ListFriends reads across panels; failures retain the last rows. */
    reconcileFriends(reason) {
        if (this.disposed || this.sessions.size === 0)
            return Promise.resolve();
        const generation = this.generation;
        if (this.friendsRefresh !== null && this.friendsRefresh.generation === generation) {
            return this.friendsRefresh.promise;
        }
        const entry = { generation, promise: this.runFriendsRead(generation, reason) };
        this.friendsRefresh = entry;
        return entry.promise;
    }
    async runFriendsRead(generation, _reason) {
        try {
            const result = await this.fetchFriends();
            if (generation !== this.generation || this.disposed || this.sessions.size === 0)
                return;
            this.applyFriendsResult(result);
        }
        finally {
            if (this.friendsRefresh !== null && this.friendsRefresh.generation === generation) {
                this.friendsRefresh = null;
            }
        }
    }
    async fetchFriends() {
        try {
            const streamEpoch = this.streamEpoch;
            await this.ensureReady();
            const response = await this.api.call((client) => client.listFriends(new ListFriendsRequest(), { timeoutMs: 2500 }), '读取联系人列表');
            return { ok: true, friends: response.friends, at: this.now(), streamEpoch };
        }
        catch (error) {
            return { ok: false, error: errorMessage(error), at: this.now() };
        }
    }
    applyFriendsResult(result) {
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
    applyStatusResult(result) {
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
    async ensureEventStream() {
        if (this.disposed)
            return;
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
        this.stopEvents = this.subscribe(this.api, (raw) => this.onDaemonEvent(raw), (error) => this.onEventError(error), (phase) => this.onEventPhase(phase), this.subscribeOptions);
        await this.waitForStreamReady();
    }
    waitForStreamReady() {
        const ready = this.streamReady;
        if (!ready)
            return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            let timer;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            timer = setTimeout(finish, this.streamReadyTimeoutMs);
            ready.then(finish, finish);
        });
    }
    onEventPhase(phase) {
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
    onEventError(error) {
        this.streamError = errorMessage(error);
        this.stats.streamErrors += 1;
        this.stats.lastError = this.streamError;
    }
    onDaemonEvent(raw) {
        const event = mapDaemonEvent(raw);
        this.stats.eventsSeen += 1;
        this.stats.lastEventAt = event.atUnixMs;
        for (const session of this.sessions.values()) {
            session.events.push(event);
            if (session.events.length > MAX_QUEUED_EVENTS)
                session.events.splice(0, session.events.length - MAX_QUEUED_EVENTS);
        }
        if (event.kind === 'connection') {
            // Reconcile with a short debounce so a burst of one Peer's link changes
            // results in one full Status read. The event itself never flips a Peer.
            this.scheduleReconcile(this.reconcileDelayMs, 'connection-event');
        }
        this.resolveStreamReady?.();
    }
    scheduleReconcile(delayMs, reason) {
        if (this.disposed || this.sessions.size === 0)
            return;
        if (this.reconcileTimer !== null) {
            if (delayMs > 0)
                return;
            clearTimeout(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = null;
            void this.reconcileStatus(reason, { trailing: true });
        }, delayMs);
    }
    cancelReconcileTimer() {
        if (this.reconcileTimer === null)
            return;
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
    }
    stopEventStream() {
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
    reapIdleSessions() {
        if (this.disposed)
            return;
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
    freshnessOf(session) {
        const now = this.now();
        const statusAt = session.statusAt > 0 ? session.statusAt : null;
        const statusIsRecent = statusAt !== null && now - statusAt <= this.statusFreshMs;
        if (session.error && !session.status)
            return 'unavailable';
        if (session.error)
            return 'stale';
        if (!session.status)
            return 'loading';
        if (this.eventPhase === 'open'
            && statusIsRecent
            && session.statusStreamEpoch === this.streamEpoch)
            return 'live';
        return 'stale';
    }
    contactsFreshness(session) {
        if (session.friendsError)
            return session.friends.length > 0 ? 'stale' : 'unavailable';
        if (session.friendsAt === 0)
            return 'loading';
        const now = this.now();
        if (this.eventPhase !== 'open' || session.friendsStreamEpoch !== this.streamEpoch)
            return 'stale';
        if (now - session.friendsAt > this.contactsFreshMs)
            return 'stale';
        return 'live';
    }
    contactsSnapshot(session) {
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
    snapshot(session, drainEvents) {
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
    snapshotStats() {
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
export function uiInvocationMethods() {
    return UI_INVOCATIONS.map((item) => item.method);
}
async function readJourneyPlaceholder(dataDir, at) {
    const reason = dataDir.length === 0
        ? '宿主没有提供受控数据目录，Agent 记录尚未接入'
        : 'Agent 私有记录暂时不可读取';
    return {
        state: 'error',
        at,
        persona: { state: 'missing', markdown: '', error: reason },
        growth: { state: 'missing', markdown: '', error: reason },
        sessions: [],
        sessionsState: 'missing',
        sessionsError: reason,
        sessionsTruncated: false,
    };
}
