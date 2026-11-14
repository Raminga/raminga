// Shared conversation/message presentation and merge rules.
//
// Everything here is host-agnostic and only consumes plain values already
// normalized by the adapter. Message identity is (peerId, direction,
// messageId); ACK means the protocol accepted a message, never that a human
// read it. Remote text is always treated as plain text by the renderer.
import { formatClock, formatRelative, shortPeer } from './node-status.js';
import { contactDisplayName } from './contacts.js';

const DELIVERY_TEXT = {
  acked: '协议已接收',
  pending: '待发送 · 等待确认',
  failed: '发送失败',
  cancelled: '已取消',
  unknown: '投递状态未知',
  received: '已收到',
};

const DELIVERY_SHORT = {
  acked: '已接收',
  pending: '待确认',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
  received: '已收到',
  none: '还没有消息',
};

export function deliveryStatusText(message) {
  if (message?.direction === 'in') return DELIVERY_TEXT.received;
  const status = String(message?.deliveryStatus ?? 'unknown');
  return DELIVERY_TEXT[status] ?? DELIVERY_TEXT.unknown;
}

export function deliveryStatusShort(status) {
  return DELIVERY_SHORT[String(status ?? 'unknown')] ?? DELIVERY_SHORT.unknown;
}

export function deliveryStatusTone(status) {
  switch (String(status ?? 'unknown')) {
    case 'acked':
    case 'received':
      return 'ok';
    case 'pending':
      return 'pending';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'muted';
    default:
      return 'unknown';
  }
}

export function isCancelable(message) {
  return message?.direction === 'out' && String(message?.deliveryStatus ?? '') === 'pending';
}

export function countTextBytes(text) {
  const value = typeof text === 'string' ? text : '';
  return new TextEncoder().encode(value).length;
}

/** Trim only for the summary; the persisted body is never truncated. */
export function previewText(text, limit = 100) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const chars = [...value];
  if (chars.length <= limit) return value;
  return `${chars.slice(0, limit).join('')}…`;
}

/** Stable newest-first order; messageId breaks equal timestamp ties. */
export function sortMessagesNewestFirst(messages) {
  return [...(Array.isArray(messages) ? messages : [])].sort((a, b) => {
    const at = Number(a?.createdAt ?? 0);
    const bt = Number(b?.createdAt ?? 0);
    if (at !== bt) return bt - at;
    return String(b?.messageId ?? '').localeCompare(String(a?.messageId ?? ''));
  });
}

/**
 * Merge a persisted page or event-derived row by stable message ID. Incoming
 * rows win for the same ID (newer delivery state); unrelated peers are never
 * merged into the current conversation.
 */
export function mergeMessages(current, incoming, { peerId = '' } = {}) {
  const map = new Map();
  const keyOf = (message) => `${message?.peerId ?? ''}\u0000${message?.direction ?? ''}\u0000${message?.messageId ?? ''}`;
  for (const message of Array.isArray(current) ? current : []) {
    if (peerId && message?.peerId !== peerId) continue;
    if (message?.messageId) map.set(keyOf(message), message);
  }
  for (const message of Array.isArray(incoming) ? incoming : []) {
    if (peerId && message?.peerId !== peerId) continue;
    if (message?.messageId) map.set(keyOf(message), message);
  }
  return sortMessagesNewestFirst([...map.values()]);
}

/** Convert one inbound event into a provisional message row, if complete. */
export function eventMessage(event) {
  if (!event || event.kind !== 'chat') return null;
  const peerId = String(event.peerId ?? '');
  const messageId = String(event.messageId ?? '');
  if (!peerId || !messageId) return null;
  return {
    messageId,
    peerId,
    direction: 'in',
    text: typeof event.text === 'string' ? event.text : '',
    acked: true,
    createdAt: Number(event.atUnixMs) || Date.now(),
    ackedAt: null,
    deliveryStatus: 'received',
    deliveryError: '',
    origin: 'unknown',
    deliveryUpdatedAt: null,
    clientRequestId: '',
  };
}

export function messageTimeText(value, now = Date.now()) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return '—';
  return formatRelative(at, now);
}

/**
 * Merge the daemon conversation summaries with the local contact list. A
 * contact with no retained message stays reachable from the conversation page
 * and is labelled as having no messages, without inventing a last message.
 */
export function conversationItems(conversations, friends) {
  const rows = Array.isArray(conversations?.conversations) ? conversations.conversations : [];
  const contacts = Array.isArray(friends) ? friends : [];
  const byPeer = new Map(contacts.map((friend) => [String(friend?.peerId ?? ''), friend]));
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const peerId = String(row?.peerId ?? '');
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    const friend = byPeer.get(peerId) ?? null;
    items.push({
      peerId,
      friend,
      hasMessages: true,
      lastMessageId: String(row.lastMessageId ?? ''),
      direction: String(row.direction ?? ''),
      preview: previewText(row.preview, 90),
      lastAt: Number(row.lastAt ?? 0),
      deliveryStatus: String(row.deliveryStatus ?? 'unknown'),
      origin: String(row.origin ?? 'unknown'),
      messageCount: Number(row.messageCount ?? 0),
    });
  }
  for (const friend of contacts) {
    const peerId = String(friend?.peerId ?? '');
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    items.push({
      peerId,
      friend,
      hasMessages: false,
      lastMessageId: '',
      direction: '',
      preview: '',
      lastAt: 0,
      deliveryStatus: 'none',
      origin: 'unknown',
      messageCount: 0,
    });
  }
  items.sort((a, b) => {
    if (a.hasMessages !== b.hasMessages) return a.hasMessages ? -1 : 1;
    if (a.hasMessages && a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    if (!a.hasMessages) {
      const an = contactDisplayName(a.friend ?? { peerId: a.peerId }).toLowerCase();
      const bn = contactDisplayName(b.friend ?? { peerId: b.peerId }).toLowerCase();
      if (an !== bn) return an.localeCompare(bn);
    }
    return a.peerId.localeCompare(b.peerId);
  });
  return items;
}

export function filterConversationItems(items, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const name = contactDisplayName(item.friend ?? { peerId: item.peerId }).toLowerCase();
    return item.peerId.toLowerCase().includes(needle)
      || name.includes(needle)
      || String(item.friend?.description ?? '').toLowerCase().includes(needle)
      || String(item.preview ?? '').toLowerCase().includes(needle);
  });
}

/**
 * Resolve the conversation-index state. Reading failure is distinct from an
 * empty list, and contacts with no messages are still an available entry.
 */
export function conversationListState({
  conversations = null,
  contacts = null,
  query = '',
  error = '',
  contactsError = '',
  now = Date.now(),
} = {}) {
  const conv = conversations && typeof conversations === 'object' ? conversations : {};
  const contactData = contacts && typeof contacts === 'object' ? contacts : {};
  const convError = String(error || conv.error || '');
  const contactReadError = String(contactsError || contactData.error || '');
  const items = conversationItems(conv, contactData.friends);
  const matches = filterConversationItems(items, query);
  const convAt = Number(conv.at) > 0 ? Number(conv.at) : 0;
  const contactsAt = Number(contactData.at) > 0 ? Number(contactData.at) : 0;
  const loading = !convError && !contactReadError && convAt === 0 && contactsAt === 0;
  const stale = conv.freshness !== 'live'
    || contactData.freshness !== 'live'
    || Boolean(convError)
    || Boolean(contactReadError);
  const readAt = Math.max(convAt, contactsAt);
  if (!loading && matches.length === 0 && String(query).trim().length > 0 && items.length > 0) {
    return {
      kind: 'search-empty',
      items: [],
      all: items,
      stale,
      error: convError || contactReadError,
      at: readAt,
      now,
    };
  }
  if (items.length === 0) {
    if (loading) return { kind: 'loading', items: [], all: [], stale: true, error: '', at: 0, now };
    if (convError || contactReadError) {
      return { kind: 'error', items: [], all: [], stale: true, error: convError || contactReadError, at: readAt, now };
    }
    return { kind: 'empty', items: [], all: [], stale, error: '', at: readAt, now };
  }
  return {
    kind: 'ready',
    items: matches,
    all: items,
    stale,
    error: convError || contactReadError,
    at: readAt,
    now,
  };
}

/** A row's secondary line: the last message, direction and delivery state. */
export function conversationSummaryText(item) {
  if (!item?.hasMessages) return '还没有消息 · 打开后可以发送';
  const prefix = item.direction === 'out' ? '你：' : '';
  return `${prefix}${item.preview || '（空消息）'}`;
}

export function conversationStatusLabel(item) {
  if (!item?.hasMessages) return DELIVERY_SHORT.none;
  if (item.direction === 'in') return DELIVERY_SHORT.received;
  return deliveryStatusShort(item.deliveryStatus);
}

export function conversationStatusTone(item) {
  if (!item?.hasMessages) return 'muted';
  if (item.direction === 'in') return 'ok';
  return deliveryStatusTone(item.deliveryStatus);
}

/** Message panel state, separate from the index's loading/error state. */
export function messageListState({ messages = [], error = '', freshness = 'loading', peerId = '' } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((message) => !peerId || message.peerId === peerId);
  if (rows.length === 0) {
    if (error) return { kind: 'error', messages: [], error, stale: false };
    if (freshness === 'loading' || freshness === 'unavailable') {
      return { kind: freshness === 'loading' ? 'loading' : 'unavailable', messages: [], error: '', stale: false };
    }
    return { kind: 'empty', messages: [], error: '', stale: freshness !== 'live' };
  }
  return { kind: 'ready', messages: rows, error, stale: Boolean(error) || freshness !== 'live' };
}

function outcomeDetail(result) {
  const resultDetail = typeof result?.detail === 'string' ? result.detail.trim() : '';
  const resultError = typeof result?.error === 'string' ? result.error.trim() : '';
  if (!resultDetail) return resultError;
  if (!resultError || resultError === resultDetail) return resultDetail;
  return `${resultError}\n\n${resultDetail}`;
}

/**
 * Honest wording for one SendChat outcome. The short body is suitable for the
 * composer status line; raw transport/dial text is returned separately as
 * `detail` so the host can keep it behind a collapsed disclosure instead of
 * expanding the composer by hundreds of characters.
 */
export function sendOutcome(result) {
  if (!result || typeof result !== 'object') {
    return {
      tone: 'error',
      title: '发送没有完成',
      body: '没有收到节点的发送结果，请先核对再决定是否重试。',
      detail: '',
      canReconcile: true,
    };
  }
  if (result.invalid) {
    return {
      tone: 'error',
      title: '消息没有发送',
      body: String(result.error || '请检查输入。'),
      detail: '',
      canReconcile: false,
    };
  }
  if (result.unknown) {
    return {
      tone: 'pending',
      title: '发送结果未知',
      body: '节点没有返回可核实的发送结果。消息可能已经保存，请先核对。',
      detail: outcomeDetail(result),
      canReconcile: true,
    };
  }
  const replayed = result.replayed === true ? '这次请求之前已经提交，没有重复创建消息。' : '';
  switch (String(result.deliveryStatus ?? 'unknown')) {
    case 'acked':
      return {
        tone: 'ok',
        title: '协议已接收',
        body: `${replayed}对端节点已经接受这条消息；阅读状态未知。`,
        detail: outcomeDetail(result),
        canReconcile: false,
      };
    case 'pending':
      return {
        tone: 'pending',
        title: '已交给节点，等待确认',
        body: `${replayed}消息已经保存，节点会继续尝试投递；没有确认前不会显示为已送达。`,
        detail: outcomeDetail(result),
        canReconcile: false,
      };
    case 'failed':
      return {
        tone: 'error',
        title: '发送失败',
        body: `${replayed}这条消息没有获得送达确认。重试会复用同一次请求，不会创建重复消息。`,
        detail: outcomeDetail(result),
        canReconcile: false,
      };
    case 'cancelled':
      return {
        tone: 'muted',
        title: '发送已取消',
        body: '这条消息已停止自动重试；已经发生的投递无法撤回。',
        detail: '',
        canReconcile: false,
      };
    default:
      return {
        tone: 'unknown',
        title: '投递状态未知',
        body: `${replayed}节点没有给出可核实的投递状态，请稍后重新读取。`,
        detail: outcomeDetail(result),
        canReconcile: false,
      };
  }
}

/** One message's status detail line; plain text only. */
export function messageStatusDetail(message) {
  if (!message) return '';
  const base = deliveryStatusText(message);
  const error = typeof message.deliveryError === 'string' ? message.deliveryError.trim() : '';
  if (error && message.direction === 'out' && ['failed', 'pending', 'unknown'].includes(String(message.deliveryStatus))) {
    return `${base} · ${error}`;
  }
  return base;
}

export function messageClock(value) {
  return formatClock(value);
}

export function conversationPeerLabel(peerId) {
  return shortPeer(peerId);
}
