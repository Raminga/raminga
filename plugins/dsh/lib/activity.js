import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
export const ACTIVITY_SCHEMA_VERSION = 1;
export const ACTIVITY_TOOL_TIMEOUT_MS = 120_000;
export const ACTIVITY_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const ACTIVITY_MAX_LINE_BYTES = 8 * 1024;
export const ACTIVITY_MAX_READ_BYTES = 2 * 1024 * 1024;
export const ACTIVITY_MAX_BAD_LINES = 20;
export const ACTIVITY_MAX_OPERATIONS = 500;
export const ACTIVITY_MAX_EVIDENCE_MESSAGES = 10;
export const ACTIVITY_MAX_ORPHANS = 100;
export const ACTIVITY_DISPOSE_WAIT_MS = 60;
const MAX_PEER = 128;
const MAX_PATH = 512;
const MAX_TOOL = 64;
const MAX_ERROR_CODE = 64;
const MAX_ERROR_SUMMARY = 240;
const MAX_CONTENT_STATE = 64;
const MAX_SESSION = 64;
const MAX_JOURNEY = 128;
const MAX_SESSION_STATE_BYTES = 128 * 1024;
const CONTROL_TEST = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PEER_RE = /^[A-Za-z0-9]{1,128}$/;
const TOOL_RE = /^raminga_[a-z0-9_]{1,56}$/;
const OP_RE = /^op-[0-9]{10,16}-[0-9]{1,12}-[a-f0-9]{6,32}$/;
const INSTANCE_RE = /^inst-[A-Za-z0-9-]{8,80}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const PANEL_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const JOURNEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL_TARGET_TYPES = {
    raminga_status: 'status',
    raminga_friends: 'friends',
    raminga_published: 'published',
    raminga_peer_profile: 'peer_profile',
    raminga_peer_manifest: 'peer_manifest',
    raminga_peer_friends: 'peer_friends',
    raminga_content_get: 'content',
    raminga_connect: 'connect',
    raminga_connect_listed: 'connect',
    raminga_chat_send: 'chat',
    raminga_chat_history: 'chat_history',
    raminga_agent_init: 'agent',
};
// A Journey is only associated with an operation when the call is part of the
// social journey. Local setup and plain status/manifest/contact reads are not
// retroactively attributed to a running Journey.
const JOURNEY_RELEVANT_TOOLS = new Set([
    'raminga_peer_profile',
    'raminga_peer_manifest',
    'raminga_peer_friends',
    'raminga_content_get',
    'raminga_connect',
    'raminga_connect_listed',
    'raminga_chat_send',
    'raminga_chat_history',
]);
const TARGET_TYPES = new Set([
    'status', 'friends', 'published', 'peer_profile', 'peer_manifest', 'peer_friends',
    'content', 'connect', 'chat', 'chat_history', 'agent',
]);
const RESULTS = new Set(['ok', 'error', 'timeout', 'interrupted', 'unknown']);
const JOURNEY_MATCHES = new Set([
    'current_peer', 'visited_peer', 'active_journey', 'none', 'ambiguous',
]);
function text(value, limit) {
    if (typeof value !== 'string')
        return '';
    const cleaned = value.replace(/\r?\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, limit);
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function peerId(value) {
    const raw = text(value, MAX_PEER + 1);
    return PEER_RE.test(raw) ? raw.slice(0, MAX_PEER) : '';
}
/** Public manifest paths only. Absolute paths, traversal and backslashes are dropped. */
export function safeActivityPath(value) {
    const raw = text(value, MAX_PATH + 1);
    if (raw.length === 0 || raw.length > MAX_PATH)
        return '';
    if (raw.startsWith('/') || raw.startsWith('\\') || raw.includes('\\'))
        return '';
    if (/^[A-Za-z]:/.test(raw) || raw.includes('://'))
        return '';
    const parts = raw.split('/');
    if (parts.some((part) => part.length === 0 || part === '.' || part === '..'))
        return '';
    if (CONTROL_TEST.test(raw))
        return '';
    return raw;
}
/** Remove likely secrets and local-only paths from a bounded error sentence. */
export function redactActivityText(value, limit = MAX_ERROR_SUMMARY) {
    let result = text(value, 2000);
    if (result.length === 0)
        return '';
    result = result
        .replace(/file:\/\/[^\s"']+/gi, '[本地路径已隐去]')
        .replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径已隐去]')
        .replace(/\/(?:Users|home|root|private|var|tmp|etc|opt|Volumes)\/[^\s"')]+/g, '[本地路径已隐去]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐去]')
        .replace(/\b(api[_-]?token|token|password|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[已隐去]');
    return result.slice(0, limit);
}
function canonicalPeer(value) {
    return peerId(value);
}
function safeSessions(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const peer = canonicalPeer(item);
        if (peer.length > 0 && !out.includes(peer) && out.length < 200)
            out.push(peer);
    }
    return out;
}
function safeMessageIds(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const id = text(item, 160);
        if (id.length > 0 && !CONTROL_TEST.test(id) && !out.includes(id) && out.length < ACTIVITY_MAX_EVIDENCE_MESSAGES) {
            out.push(id);
        }
    }
    return out;
}
function safePositiveInt(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function safeSha(value) {
    const raw = text(value, 64).toLowerCase();
    return SHA_RE.test(raw) ? raw : '';
}
/** Project only the evidence fields allowed in the private activity log. */
export function sanitizeActivityEvidence(value) {
    const raw = record(value);
    if (!raw)
        return {};
    const evidence = {};
    const peer = canonicalPeer(raw.peer_id ?? raw.peerId);
    if (peer)
        evidence.peer_id = peer;
    const publicPath = safeActivityPath(raw.path);
    if (publicPath)
        evidence.path = publicPath;
    const sha = safeSha(raw.sha256);
    if (sha)
        evidence.sha256 = sha;
    const messages = safeMessageIds(raw.message_ids ?? raw.messageIds);
    if (messages.length > 0)
        evidence.message_ids = messages;
    const generated = safePositiveInt(raw.manifest_generated_at_unix_ms ?? raw.manifestGeneratedAtUnixMs);
    if (generated > 0)
        evidence.manifest_generated_at_unix_ms = generated;
    const discovery = safePositiveInt(raw.discovery_id ?? raw.discoveryId);
    if (discovery > 0)
        evidence.discovery_id = discovery;
    const contentState = text(raw.content_state ?? raw.contentState, MAX_CONTENT_STATE);
    if (contentState)
        evidence.content_state = contentState;
    return evidence;
}
/** Map a generated tool name and its real arguments to the safe target shape. */
export function describeActivityCall(tool, args = {}) {
    const safeTool = TOOL_RE.test(tool) ? tool : '';
    const targetType = TOOL_TARGET_TYPES[safeTool] ?? 'agent';
    const target = {};
    const peer = canonicalPeer(args.peer_id ?? args.peerId);
    if (peer)
        target.peer_id = peer;
    if (safeTool === 'raminga_content_get') {
        const publicPath = safeActivityPath(args.path);
        if (publicPath)
            target.path = publicPath;
    }
    // A connect call may carry only a multiaddr. Extract the Peer ID component
    // and deliberately never persist the address (it can contain a local IP).
    if (!target.peer_id && (safeTool === 'raminga_connect' || safeTool === 'raminga_chat_send')) {
        const multiaddr = text(args.multiaddr, 1024);
        const match = /\/p2p\/([A-Za-z0-9]{1,128})/.exec(multiaddr);
        if (match)
            target.peer_id = match[1];
    }
    return { tool: safeTool, targetType, target };
}
function evidenceFromFrame(result) {
    const root = record(result);
    const final = record(root?.final);
    if (!final)
        return {};
    const evidence = {};
    const peer = canonicalPeer(final.peerId ?? final.peer_id);
    if (peer)
        evidence.peer_id = peer;
    const publicPath = safeActivityPath(final.path);
    if (publicPath)
        evidence.path = publicPath;
    const sha = safeSha(final.sha256);
    if (sha)
        evidence.sha256 = sha;
    const discovery = safePositiveInt(final.discoveryId ?? final.discovery_id);
    if (discovery > 0)
        evidence.discovery_id = discovery;
    const phase = text(final.phase, MAX_CONTENT_STATE);
    if (phase)
        evidence.content_state = phase;
    return evidence;
}
/** Derive only safe, already-returned evidence; never copy a tool response. */
export function evidenceFromResult(tool, args, result) {
    const root = record(result);
    if (!root)
        return {};
    const target = describeActivityCall(tool, args).target;
    const evidence = {};
    if (target.peer_id)
        evidence.peer_id = target.peer_id;
    switch (tool) {
        case 'raminga_content_get': {
            const frame = evidenceFromFrame(result);
            return { ...evidence, ...frame };
        }
        case 'raminga_chat_send': {
            const messageId = text(root.messageId ?? root.message_id, 160);
            if (messageId && !CONTROL_TEST.test(messageId))
                evidence.message_ids = [messageId];
            const state = text(root.deliveryStatus ?? root.delivery_status ?? root.outboxStatus, MAX_CONTENT_STATE);
            if (state)
                evidence.content_state = state;
            return evidence;
        }
        case 'raminga_chat_history': {
            const messages = Array.isArray(root.messages) ? root.messages : [];
            const ids = [];
            for (const item of messages) {
                const row = record(item);
                const id = text(row?.messageId ?? row?.message_id, 160);
                if (id && !CONTROL_TEST.test(id) && !ids.includes(id) && ids.length < ACTIVITY_MAX_EVIDENCE_MESSAGES)
                    ids.push(id);
            }
            if (ids.length > 0)
                evidence.message_ids = ids;
            return evidence;
        }
        case 'raminga_peer_manifest': {
            const generated = safePositiveInt(root.generatedAtUnixMs ?? root.generated_at_unix_ms);
            if (generated > 0)
                evidence.manifest_generated_at_unix_ms = generated;
            const source = canonicalPeer(root.peerId ?? root.peer_id);
            if (source)
                evidence.peer_id = source;
            evidence.content_state = 'manifest';
            return evidence;
        }
        case 'raminga_peer_profile': {
            const profile = record(root.profile);
            const profilePath = safeActivityPath(profile?.sourcePath ?? profile?.source_path);
            if (profilePath)
                evidence.path = profilePath;
            evidence.content_state = 'profile';
            return evidence;
        }
        case 'raminga_peer_friends':
            evidence.content_state = 'friends';
            return evidence;
        case 'raminga_published': {
            const generated = safePositiveInt(root.generatedAtUnixMs ?? root.generated_at_unix_ms);
            if (generated > 0)
                evidence.manifest_generated_at_unix_ms = generated;
            evidence.content_state = 'published';
            return evidence;
        }
        case 'raminga_connect':
        case 'raminga_connect_listed':
            evidence.content_state = 'connected';
            return evidence;
        default:
            return evidence;
    }
}
/**
 * Persist a category summary, never a raw tool error. Raw messages may echo a
 * chat body, a private file excerpt or a path even after generic redaction.
 */
export function summarizeToolError(value) {
    const raw = text(value, 1000);
    if (/timeout|timed out|deadline|超时/i.test(raw))
        return '工具调用超时；结果可能未知。';
    if (/permission denied|access denied|not permitted|operation not permitted|权限/i.test(raw))
        return '本机权限不足，工具调用失败。';
    if (/rate limit|too many|限流|频率/i.test(raw))
        return '操作被本地限流，工具调用失败。';
    if (/dial|connect|network|unreachable|offline|connection refused|no route|连接|不可达/i.test(raw))
        return '连接或网络读取失败。';
    if (/manifest|not found|no such file|不存在|清单/i.test(raw))
        return '目标公开内容或清单不可用。';
    if (/invalid|parse|malformed|格式|参数/i.test(raw))
        return '工具参数或返回格式无效。';
    return '工具执行失败；错误详情未写入活动日志。';
}
function errorCode(value) {
    const raw = text(value, MAX_ERROR_CODE).toLowerCase();
    if (!CODE_RE.test(raw))
        return 'tool_error';
    return raw;
}
function iso(now) {
    return new Date(now).toISOString();
}
function instanceId() {
    return `inst-${randomUUID()}`;
}
function operationId(now, counter) {
    return `op-${now}-${counter}-${randomBytes(4).toString('hex')}`;
}
function parseTarget(value) {
    const raw = record(value);
    if (!raw)
        return {};
    const target = {};
    const peer = canonicalPeer(raw.peer_id);
    if (peer)
        target.peer_id = peer;
    const publicPath = safeActivityPath(raw.path);
    if (publicPath)
        target.path = publicPath;
    return target;
}
function parseEvent(raw) {
    const value = record(raw);
    if (!value || value.schema_version !== ACTIVITY_SCHEMA_VERSION)
        return null;
    if (value.event !== 'started' && value.event !== 'finished')
        return null;
    const op = text(value.operation_id, 64);
    const inst = text(value.plugin_instance_id, 100);
    const tool = text(value.tool, MAX_TOOL);
    const targetType = text(value.target_type, 32);
    const match = text(value.journey_match, 32);
    if (!OP_RE.test(op) || !INSTANCE_RE.test(inst) || !TOOL_RE.test(tool))
        return null;
    if (!TARGET_TYPES.has(targetType) || !JOURNEY_MATCHES.has(match))
        return null;
    const startedAt = text(value.started_at, 64);
    if (startedAt.length === 0 || !Number.isFinite(Date.parse(startedAt)))
        return null;
    const event = {
        schema_version: 1,
        event: value.event,
        operation_id: op,
        plugin_instance_id: inst,
        panel_session_id: PANEL_RE.test(text(value.panel_session_id, 128)) ? text(value.panel_session_id, 128) : '',
        journey_id: JOURNEY_RE.test(text(value.journey_id, MAX_JOURNEY)) ? text(value.journey_id, MAX_JOURNEY) : '',
        journey_match: match,
        session_id: SESSION_RE.test(text(value.session_id, MAX_SESSION)) ? text(value.session_id, MAX_SESSION) : '',
        tool,
        target_type: targetType,
        target: parseTarget(value.target),
        started_at: new Date(startedAt).toISOString(),
    };
    if (event.event === 'finished') {
        const result = text(value.result, 16);
        if (!RESULTS.has(result))
            return null;
        const endedAt = text(value.ended_at, 64);
        if (endedAt.length === 0 || !Number.isFinite(Date.parse(endedAt)))
            return null;
        event.ended_at = new Date(endedAt).toISOString();
        event.result = result;
        const code = text(value.error_code, MAX_ERROR_CODE);
        if (code.length > 0)
            event.error_code = code;
        const summary = redactActivityText(value.error_summary);
        if (summary.length > 0)
            event.error_summary = summary;
        const evidence = sanitizeActivityEvidence(value.evidence);
        if (Object.keys(evidence).length > 0)
            event.evidence = evidence;
    }
    return event;
}
function fitLine(event, maxLineBytes) {
    const candidates = [event];
    if (event.evidence)
        candidates.push({ ...event, evidence: undefined });
    if (event.error_summary)
        candidates.push({ ...event, evidence: undefined, error_summary: text(event.error_summary, 120) });
    candidates.push({
        ...event,
        evidence: undefined,
        error_summary: '',
        target: {
            ...(event.target.peer_id ? { peer_id: event.target.peer_id } : {}),
            ...(event.target.path ? { path: event.target.path.slice(0, 200) } : {}),
        },
    });
    for (const candidate of candidates) {
        const line = JSON.stringify(candidate);
        if (Buffer.byteLength(line, 'utf8') <= maxLineBytes)
            return line;
    }
    // The last candidate contains bounded IDs only; this fallback is defensive
    // but must still be valid JSON, never a sliced JSON string.
    const minimal = {
        schema_version: 1,
        event: event.event,
        operation_id: event.operation_id,
        plugin_instance_id: event.plugin_instance_id,
        panel_session_id: '',
        journey_id: '',
        journey_match: 'none',
        session_id: event.session_id,
        tool: event.tool,
        target_type: event.target_type,
        target: {},
        started_at: event.started_at,
        ...(event.event === 'finished'
            ? {
                ended_at: event.ended_at,
                result: event.result,
                error_code: event.error_code ?? 'log_line_too_large',
                error_summary: '记录行超出上限，已省略详情。',
            }
            : {}),
    };
    return JSON.stringify(minimal);
}
function mergeEvents(events) {
    const merged = new Map();
    for (const event of events) {
        const existing = merged.get(event.operation_id);
        if (event.event === 'started') {
            merged.set(event.operation_id, {
                operationId: event.operation_id,
                pluginInstanceId: event.plugin_instance_id,
                panelSessionId: event.panel_session_id,
                journeyId: event.journey_id,
                journeyMatch: event.journey_match,
                sessionId: event.session_id,
                tool: event.tool,
                targetType: event.target_type,
                target: event.target,
                startedAt: event.started_at,
                endedAt: '',
                result: null,
                state: 'running',
                errorCode: '',
                errorSummary: '',
                evidence: {},
            });
            continue;
        }
        const base = existing ?? {
            operationId: event.operation_id,
            pluginInstanceId: event.plugin_instance_id,
            panelSessionId: event.panel_session_id,
            journeyId: event.journey_id,
            journeyMatch: event.journey_match,
            sessionId: event.session_id,
            tool: event.tool,
            targetType: event.target_type,
            target: event.target,
            startedAt: event.started_at,
            endedAt: '',
            result: null,
            state: 'running',
            errorCode: '',
            errorSummary: '',
            evidence: {},
        };
        merged.set(event.operation_id, {
            ...base,
            endedAt: event.ended_at ?? '',
            result: event.result ?? 'unknown',
            state: 'finished',
            errorCode: event.error_code ?? '',
            errorSummary: event.error_summary ?? '',
            evidence: event.evidence ?? {},
        });
    }
    return [...merged.values()].sort((left, right) => {
        const time = Date.parse(left.startedAt) - Date.parse(right.startedAt);
        if (time !== 0)
            return time;
        return left.operationId.localeCompare(right.operationId);
    });
}
async function lstatOrNull(file) {
    try {
        return await fsp.lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
/**
 * Read only the `status=running` Journey state files needed for association.
 * This deliberately does not read reports, events, persona or growth.
 */
export async function readRunningJourneys(dataDir) {
    if (!dataDir)
        return [];
    const sessionsRoot = path.join(dataDir, 'agent', 'sessions');
    let root;
    try {
        root = await lstatOrNull(sessionsRoot);
    }
    catch {
        return [];
    }
    if (root === null || !root.isDirectory() || root.isSymbolicLink())
        return [];
    let entries;
    try {
        entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const running = [];
    for (const entry of entries.slice(0, 100)) {
        if (!entry.isDirectory() || entry.name === '__proto__' || !JOURNEY_RE.test(entry.name))
            continue;
        const directory = path.join(sessionsRoot, entry.name);
        let dirStat;
        let stateStat;
        try {
            dirStat = await lstatOrNull(directory);
            if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink())
                continue;
            stateStat = await lstatOrNull(path.join(directory, 'state.json'));
        }
        catch {
            continue;
        }
        if (stateStat === null || !stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > MAX_SESSION_STATE_BYTES)
            continue;
        try {
            const raw = JSON.parse(await fsp.readFile(path.join(directory, 'state.json'), 'utf8'));
            if (raw.schema_version !== 1 || raw.status !== 'running')
                continue;
            running.push({
                id: entry.name,
                currentPeerId: canonicalPeer(raw.current_peer_id),
                visitedPeerIds: safeSessions(raw.visited_peer_ids),
            });
        }
        catch {
            // A malformed/read-restricted state file cannot prove a running Journey.
            continue;
        }
    }
    return running;
}
/** Read one Journey state for UI association; never returns report/events/persona. */
export async function readJourneySummary(dataDir, sessionId) {
    if (!dataDir || !JOURNEY_RE.test(sessionId) || sessionId === '__proto__')
        return null;
    const sessionsRoot = path.join(dataDir, 'agent', 'sessions');
    const directory = path.join(sessionsRoot, sessionId);
    try {
        const root = await lstatOrNull(sessionsRoot);
        if (root === null || !root.isDirectory() || root.isSymbolicLink())
            return null;
        const dirStat = await lstatOrNull(directory);
        if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink())
            return null;
        const statePath = path.join(directory, 'state.json');
        const stateStat = await lstatOrNull(statePath);
        if (stateStat === null || !stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > MAX_SESSION_STATE_BYTES)
            return null;
        const raw = JSON.parse(await fsp.readFile(statePath, 'utf8'));
        if (raw.schema_version !== 1)
            return null;
        const status = text(raw.status, 32);
        if (!['running', 'paused', 'completed', 'failed'].includes(status))
            return null;
        return {
            sessionId,
            status,
            mode: text(raw.mode, 64),
            startedAt: text(raw.started_at, 64),
            updatedAt: text(raw.updated_at, 64),
            completedAt: text(raw.completed_at, 64),
            currentPeerId: canonicalPeer(raw.current_peer_id),
            visitedPeerIds: safeSessions(raw.visited_peer_ids),
        };
    }
    catch {
        return null;
    }
}
/** Resolve the five documented association outcomes without guessing. */
export function associateJourney(tool, target, running) {
    if (!JOURNEY_RELEVANT_TOOLS.has(tool))
        return { journeyId: '', match: 'none' };
    if (running.length === 0)
        return { journeyId: '', match: 'none' };
    if (running.length > 1)
        return { journeyId: '', match: 'ambiguous' };
    const journey = running[0];
    let match = 'active_journey';
    if (target.peer_id && journey.currentPeerId === target.peer_id)
        match = 'current_peer';
    else if (target.peer_id && journey.visitedPeerIds.includes(target.peer_id))
        match = 'visited_peer';
    return { journeyId: journey.id, match };
}
export class ActivityTimeoutError extends Error {
    timeoutMs;
    code = 'activity_timeout';
    constructor(timeoutMs) {
        super(`工具调用超过 ${Math.round(timeoutMs / 1000)} 秒，包装层已超时；底层操作可能仍在执行，结果未知。`);
        this.timeoutMs = timeoutMs;
        this.name = 'ActivityTimeoutError';
    }
}
/**
 * Serial, permission-restricted activity log. Writes never make a tool fail;
 * begin() rejects only when the plugin has already been disposed.
 */
export class AgentActivityStore {
    dataDir;
    pluginInstanceId;
    sessionId;
    now;
    maxFileBytes;
    maxLineBytes;
    maxReadBytes;
    maxBadLines;
    maxOperations;
    disposeWaitMs;
    queue = Promise.resolve();
    inflight = new Map();
    panels = [];
    counter = 0;
    disposed = false;
    disposePromise = null;
    initPromise = null;
    initialized = false;
    lastWriteError = '';
    constructor(options) {
        this.dataDir = options.dataDir;
        this.pluginInstanceId = options.pluginInstanceId && INSTANCE_RE.test(options.pluginInstanceId)
            ? options.pluginInstanceId
            : instanceId();
        this.sessionId = options.sessionId && SESSION_RE.test(options.sessionId)
            ? options.sessionId
            : `sess-plugin-${this.pluginInstanceId.slice(5, 17)}`;
        this.now = options.now ?? (() => Date.now());
        this.maxFileBytes = options.maxFileBytes ?? ACTIVITY_MAX_FILE_BYTES;
        this.maxLineBytes = options.maxLineBytes ?? ACTIVITY_MAX_LINE_BYTES;
        this.maxReadBytes = options.maxReadBytes ?? ACTIVITY_MAX_READ_BYTES;
        this.maxBadLines = options.maxBadLines ?? ACTIVITY_MAX_BAD_LINES;
        this.maxOperations = options.maxOperations ?? ACTIVITY_MAX_OPERATIONS;
        this.disposeWaitMs = options.disposeWaitMs ?? ACTIVITY_DISPOSE_WAIT_MS;
    }
    /** Mark orphaned starts from an older plugin instance as unknown once. */
    initialize() {
        if (this.initPromise !== null)
            return this.initPromise;
        this.initPromise = this.markOldOrphans();
        return this.initPromise;
    }
    get panelSessionId() {
        return this.panels[this.panels.length - 1] ?? '';
    }
    attachPanelSession(sessionId) {
        if (!PANEL_RE.test(sessionId))
            return;
        this.panels = this.panels.filter((value) => value !== sessionId);
        this.panels.push(sessionId);
    }
    detachPanelSession(sessionId) {
        this.panels = this.panels.filter((value) => value !== sessionId);
    }
    detachAllPanelSessions() {
        this.panels = [];
    }
    async begin(input) {
        if (this.disposed)
            throw new Error('Agent activity store is disposed');
        await this.initialize();
        const tool = TOOL_RE.test(input.tool) ? input.tool : '';
        if (tool.length === 0)
            throw new Error('invalid Raminga tool name for activity');
        const now = this.now();
        const opId = operationId(now, ++this.counter);
        const described = describeActivityCall(tool, input.args);
        const targetType = input.targetType && TARGET_TYPES.has(input.targetType)
            ? input.targetType
            : described.targetType;
        const running = JOURNEY_RELEVANT_TOOLS.has(tool) ? await readRunningJourneys(this.dataDir) : [];
        const association = associateJourney(tool, described.target, running);
        const event = {
            schema_version: 1,
            event: 'started',
            operation_id: opId,
            plugin_instance_id: this.pluginInstanceId,
            panel_session_id: this.panelSessionId,
            journey_id: association.journeyId,
            journey_match: association.match,
            session_id: this.sessionId,
            tool,
            target_type: targetType,
            target: described.target,
            started_at: iso(now),
        };
        let resolveCompletion = () => { };
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        const record = { event, finished: false, interrupted: false, completion: { promise: completion, resolve: resolveCompletion } };
        this.inflight.set(opId, record);
        await this.append(event);
        return {
            operationId: opId,
            finish: (result, details = {}) => this.finish(record, result, details),
        };
    }
    /** Last terminal wins: a real finish after an interrupted write is allowed. */
    async finish(record, result, details = {}) {
        if (record.finished)
            return;
        const ended = this.now();
        const evidence = sanitizeActivityEvidence(details.evidence);
        const terminal = {
            ...record.event,
            event: 'finished',
            ended_at: iso(ended),
            result: RESULTS.has(result) ? result : 'unknown',
            ...(details.errorCode ? { error_code: errorCode(details.errorCode) } : {}),
            ...(details.errorSummary ? { error_summary: redactActivityText(details.errorSummary) } : {}),
            ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
        };
        if (terminal.result === 'interrupted' || terminal.result === 'timeout' || terminal.result === 'unknown') {
            delete terminal.error_code;
            if (details.errorCode)
                terminal.error_code = errorCode(details.errorCode);
        }
        record.finished = true;
        this.inflight.delete(record.event.operation_id);
        record.completion.resolve();
        await this.append(terminal);
    }
    /** Flush, wait briefly for an explicit completion signal, then mark rest interrupted. */
    async dispose() {
        if (this.disposePromise !== null)
            return this.disposePromise;
        this.disposed = true;
        this.panels = [];
        this.disposePromise = (async () => {
            const pending = [...this.inflight.values()].filter((record) => !record.finished);
            if (pending.length > 0 && this.disposeWaitMs > 0) {
                await Promise.race([
                    Promise.allSettled(pending.map((record) => record.completion.promise)),
                    new Promise((resolve) => {
                        const timer = setTimeout(resolve, this.disposeWaitMs);
                        timer.unref?.();
                    }),
                ]);
            }
            const still = [...this.inflight.values()].filter((record) => !record.finished && !record.interrupted);
            for (const record of still) {
                record.interrupted = true;
                const terminal = {
                    ...record.event,
                    event: 'finished',
                    ended_at: iso(this.now()),
                    result: 'interrupted',
                    error_code: 'plugin_unloaded',
                    error_summary: '插件已卸载，结果未知。',
                };
                await this.append(terminal);
            }
            await this.queue;
        })();
        return this.disposePromise;
    }
    async read(limit = 100) {
        await this.initialize();
        const boundedLimit = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100), this.maxOperations);
        const raw = await this.readRaw();
        const operations = mergeEvents(raw.events);
        for (const operation of operations) {
            if (operation.state === 'finished')
                continue;
            if (operation.pluginInstanceId === this.pluginInstanceId)
                continue;
            operation.state = 'finished';
            operation.result = 'unknown';
            operation.errorCode = 'host_restart';
            operation.errorSummary = '上次插件实例已退出，结果未知。';
        }
        let truncated = raw.truncated;
        let selected = operations;
        if (operations.length > boundedLimit) {
            selected = operations.slice(operations.length - boundedLimit);
            truncated = true;
        }
        return {
            operations: selected,
            instanceId: this.pluginInstanceId,
            readAt: this.now(),
            truncated,
            error: raw.error,
            badLines: raw.badLines,
        };
    }
    getLastWriteError() {
        return this.lastWriteError;
    }
    async markOldOrphans() {
        if (this.initialized)
            return;
        this.initialized = true;
        let raw;
        try {
            raw = await this.readRaw();
        }
        catch {
            return;
        }
        const merged = mergeEvents(raw.events);
        let count = 0;
        for (const operation of merged) {
            if (count >= ACTIVITY_MAX_ORPHANS)
                break;
            if (operation.state === 'finished')
                continue;
            if (operation.pluginInstanceId === this.pluginInstanceId)
                continue;
            const event = {
                schema_version: 1,
                event: 'finished',
                operation_id: operation.operationId,
                plugin_instance_id: operation.pluginInstanceId,
                panel_session_id: operation.panelSessionId,
                journey_id: operation.journeyId,
                journey_match: operation.journeyMatch,
                session_id: operation.sessionId,
                tool: operation.tool,
                target_type: operation.targetType,
                target: operation.target,
                started_at: operation.startedAt,
                ended_at: iso(this.now()),
                result: 'unknown',
                error_code: 'host_restart',
                error_summary: '上次插件实例已退出，结果未知。',
            };
            await this.append(event).catch(() => { });
            count += 1;
        }
    }
    filePath() {
        return path.join(this.dataDir, 'agent', 'activity.jsonl');
    }
    previousPath() {
        return path.join(this.dataDir, 'agent', 'activity.1.jsonl');
    }
    async ensureAgentDir() {
        const root = path.join(this.dataDir, 'agent');
        await fsp.mkdir(root, { recursive: true, mode: 0o700 });
        await fsp.chmod(root, 0o700).catch(() => { });
        try {
            const stat = await fsp.lstat(root);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error('agent path is not a private directory');
        }
        catch (error) {
            throw error;
        }
    }
    enqueue(task) {
        const next = this.queue.then(task);
        this.queue = next.catch(() => { });
        return next;
    }
    async append(event) {
        const line = fitLine(event, this.maxLineBytes);
        try {
            await this.enqueue(async () => {
                await this.ensureAgentDir();
                const file = this.filePath();
                const existing = await lstatOrNull(file);
                if (existing !== null && !existing.isFile())
                    throw new Error('activity path is not a regular file');
                if (existing !== null && existing.size + Buffer.byteLength(line, 'utf8') + 1 > this.maxFileBytes) {
                    const previous = this.previousPath();
                    await fsp.rm(previous, { force: true }).catch(() => { });
                    await fsp.rename(file, previous);
                }
                const handle = await fsp.open(file, 'a', 0o600);
                try {
                    await handle.chmod(0o600).catch(() => { });
                    await handle.write(`${line}\n`, null, 'utf8');
                }
                finally {
                    await handle.close();
                }
                this.lastWriteError = '';
            });
        }
        catch (error) {
            this.lastWriteError = redactActivityText(error instanceof Error ? error.message : String(error));
            // Logging must never change the tool's real outcome.
        }
    }
    async readFileTail(file, maxBytes) {
        let handle = null;
        try {
            const stat = await fsp.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink())
                return { lines: [], skipped: false, error: '活动日志不是常规文件，不能读取。' };
            if (stat.size === 0)
                return { lines: [], skipped: false, error: '' };
            const length = Math.min(stat.size, maxBytes);
            const start = stat.size - length;
            const buffer = Buffer.alloc(length);
            handle = await fsp.open(file, 'r');
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            let content = buffer.subarray(0, bytesRead).toString('utf8');
            if (start > 0) {
                const newline = content.indexOf('\n');
                content = newline >= 0 ? content.slice(newline + 1) : '';
            }
            if (content.includes('\uFFFD')) {
                return { lines: [], skipped: start > 0, error: '活动日志不是有效的 UTF-8，不能安全读取。' };
            }
            const lines = content.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '')
                lines.pop();
            return { lines, skipped: start > 0, error: '' };
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT')
                return { lines: [], skipped: false, error: '' };
            return { lines: [], skipped: false, error: `活动日志读取失败：${redactActivityText(error instanceof Error ? error.message : String(error))}` };
        }
        finally {
            await handle?.close().catch(() => { });
        }
    }
    async readRaw() {
        const previous = this.previousPath();
        const current = this.filePath();
        const previousStat = await lstatOrNull(previous).catch(() => null);
        const currentStat = await lstatOrNull(current).catch(() => null);
        if (previousStat === null && currentStat === null)
            return { events: [], truncated: false, badLines: 0, error: '' };
        const parts = [];
        if (previousStat !== null)
            parts.push(await this.readFileTail(previous, this.maxReadBytes));
        if (currentStat !== null)
            parts.push(await this.readFileTail(current, this.maxReadBytes));
        const firstError = parts.find((part) => part.error.length > 0)?.error ?? '';
        let truncated = parts.some((part) => part.skipped);
        if (previousStat !== null && currentStat !== null)
            truncated = true;
        const events = [];
        let badLines = 0;
        for (const part of parts) {
            for (const line of part.lines) {
                if (line.trim().length === 0)
                    continue;
                try {
                    const event = parseEvent(JSON.parse(line));
                    if (event === null)
                        badLines += 1;
                    else
                        events.push(event);
                }
                catch {
                    badLines += 1;
                }
            }
        }
        let error = firstError;
        if (badLines > this.maxBadLines) {
            error = `活动日志包含 ${badLines} 行无法解析的记录（上限 ${this.maxBadLines}），已按读取错误显示。`;
        }
        return { events, truncated, badLines, error };
    }
}
/** Execute one tool under the 120s wrapper while recording real started/finished facts. */
export async function runWithActivity(activity, call, execute, options = {}) {
    const executePromise = Promise.resolve().then(execute);
    // Observe a fast rejection while begin() is still writing the started line;
    // the race below still receives the same rejection once it is attached.
    executePromise.catch(() => { });
    if (!activity)
        return executePromise;
    let handle = null;
    try {
        handle = await activity.begin(call);
    }
    catch {
        // A log failure is not a tool failure.
        return executePromise;
    }
    const timeoutMs = options.timeoutMs ?? ACTIVITY_TOOL_TIMEOUT_MS;
    let timedOut = false;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new ActivityTimeoutError(timeoutMs));
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        const result = await Promise.race([executePromise, timeout]);
        if (timer !== null)
            clearTimeout(timer);
        await handle.finish('ok', { evidence: evidenceFromResult(call.tool, call.args, result) }).catch(() => { });
        return result;
    }
    catch (error) {
        if (timer !== null)
            clearTimeout(timer);
        if (timedOut) {
            await handle.finish('timeout', {
                errorCode: 'wrapper_timeout',
                errorSummary: '包装层 120 秒超时；底层操作可能仍在执行，结果未知。',
            }).catch(() => { });
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        await handle.finish('error', {
            errorCode: 'tool_error',
            errorSummary: summarizeToolError(message),
        }).catch(() => { });
        throw error;
    }
}
