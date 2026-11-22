// Pure view-model helpers for public discovery, profiles and Journey records.
// They do not fetch, read files or infer connection/Agent state.

export const CONTENT_FILTERS = new Set(['all', 'familiar']);

export function formatDateTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(time) || time <= 0) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function shortPeerText(value) {
  const peer = typeof value === 'string' ? value : '';
  return peer.length > 22 ? `${peer.slice(0, 10)}…${peer.slice(-8)}` : peer;
}

export function postMatchesQuery(post, rawQuery) {
  const query = String(rawQuery ?? '').trim().toLowerCase();
  if (query.length === 0) return true;
  const fields = [
    post?.title, post?.summary, post?.publisherAgentName, post?.publisherName, post?.authorName, post?.authorPeerId, post?.path,
    ...(Array.isArray(post?.tags) ? post.tags : []),
  ];
  return fields.some((field) => String(field ?? '').toLowerCase().includes(query));
}

export function discoveryListState(data, query) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const filtered = items.filter((item) => postMatchesQuery(item, query));
  if (!data) return { kind: 'loading', items: [], total: 0 };
  if (data.at === null && data.error) return { kind: 'error', items: [], total: 0 };
  if (data.at === null) return { kind: 'loading', items: [], total: 0 };
  if (filtered.length === 0 && String(query ?? '').trim().length > 0 && items.length > 0) {
    return { kind: 'search-empty', items: [], total: 0 };
  }
  if (items.length === 0) return { kind: 'empty', items: [], total: 0 };
  // total is the real filtered match count, so search never labels a subset
  // with the unfiltered index size.
  return { kind: 'ready', items: filtered, total: filtered.length };
}

export function discoverySourceText(source) {
  const value = String(source ?? '').trim();
  if (value === 'raminga_content_get') return 'Agent 获取 · raminga_content_get';
  if (value.length === 0) return '来源未记录';
  return `Agent 获取 · ${value}`;
}

export function profileLabel(profile, fallbackPeerId) {
  // The peer's current public name leads; the local contact alias remains a
  // separate local label rather than overriding the public declaration. A
  // Peer ID is an identifier, never a public display name, so a name field
  // that merely echoes the key falls through to the local alias.
  const remote = String(profile?.remoteName ?? '').trim();
  const fallback = String(fallbackPeerId ?? '').trim();
  const peerLike = remote === fallback || /^(?:12D3KooW|16Uiu2HAm|Qm)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(remote);
  if (remote.length > 0 && !peerLike) return remote;
  const local = String(profile?.localName ?? '').trim();
  if (local.length > 0) return local;
  return shortPeerText(fallback);
}

export function mineProfileStateText(profile) {
  if (!profile) return { tone: 'unavailable', text: '读取中' };
  if (profile.state === 'available') return { tone: 'ready', text: '本机公开档案' };
  if (profile.state === 'missing') return { tone: 'unavailable', text: '尚未创建公开档案' };
  return { tone: 'error', text: '公开档案读取失败' };
}

export function minePostsStateText(posts) {
  if (!posts) return { tone: 'unavailable', text: '读取中' };
  if (posts.state === 'error') return { tone: 'error', text: '读取失败' };
  if (posts.state === 'missing') return { tone: 'unavailable', text: '公开目录不可用' };
  const files = Array.isArray(posts.files) ? posts.files : [];
  if (files.length === 0) return { tone: 'unavailable', text: '没有公开文件' };
  return { tone: 'ready', text: `${files.length} 个公开文件` };
}

export function journeyStatusText(state) {
  const status = String(state?.status ?? '');
  switch (status) {
    case 'running':
      // P1 has no tool-activity evidence. A saved "running" record, however
      // fresh, is still an unfinished record that needs confirmation.
      return { tone: 'running', label: '待确认', recordLabel: '运行中', note: '状态记录为运行中；Journey 文件字段不是工具调用证据，也不能单独证明当前仍在运行。' };
    case 'paused':
      return { tone: 'paused', label: '待确认', recordLabel: '已暂停', note: '最后保存的记录为已暂停；这只是一条记录，不代表当前状态。' };
    case 'completed':
      return { tone: 'done', label: '已完成', recordLabel: '已完成', note: '' };
    case 'failed':
      return { tone: 'error', label: '失败', recordLabel: '失败', note: '失败原因来自宿主的 Journey 记录。' };
    default:
      return { tone: 'unknown', label: '待确认', recordLabel: '状态未记录', note: '没有可用的状态记录，不能推断当前运行状态。' };
  }
}

export function journeyModeText(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  const labels = {
    explore: '探索',
    exploration: '探索',
    visit: '访问',
    visiting: '访问',
    read: '阅读',
    reading: '阅读',
    chat: '对话',
    messaging: '对话',
    idle: '空闲',
  };
  if (value.length === 0) return '未记录';
  return labels[value] ?? '其他模式';
}

export function journeyDirectionText(direction) {
  const value = String(direction ?? '').trim().toLowerCase();
  if (value === 'out' || value === 'outbound' || value === 'sent') return '发出';
  if (value === 'in' || value === 'inbound' || value === 'received') return '收到';
  return '方向未记录';
}

export function journeySessionTitle(session) {
  const intent = String(session?.state?.intent ?? '').trim();
  if (intent.length > 0) return intent;
  const mode = String(session?.state?.mode ?? '').trim();
  return mode.length > 0 ? `Journey · ${journeyModeText(mode)}` : 'Journey 记录';
}

export function journeyTimeText(session) {
  return formatDateTime(session?.state?.updatedAt || session?.state?.startedAt || session?.dirModifiedAt || 0);
}

export function journeyEventLabel(event) {
  const type = String(event?.type ?? '');
  const labels = {
    session_started: '开始',
    session_paused: '暂停',
    session_resumed: '继续',
    candidates_presented: '候选',
    candidate_selected: '选择对象',
    peer_skipped: '跳过',
    visit_started: '开始访问',
    visit_completed: '完成访问',
    content_read: '阅读公开内容',
    message_sent: '发出消息',
    message_received: '收到消息',
    reply_timeout: '等待回复超时',
    impression_updated: '更新印象',
    curiosity_added: '新的好奇',
    observation: '观察记录',
    session_completed: '完成',
    session_failed: '失败',
  };
  return labels[type] ?? (type.length > 0 ? '其他活动' : '未命名活动');
}

export function evidenceLocations(event) {
  const messageIds = Array.isArray(event?.messageIds) ? event.messageIds.filter((value) => typeof value === 'string' && value.length > 0) : [];
  const contentPaths = Array.isArray(event?.contentPaths) ? event.contentPaths.filter((value) => typeof value === 'string' && value.length > 0) : [];
  return { messageIds, contentPaths };
}

/**
 * Collapse a Journey event's two possible message pointers (evidence_refs and
 * message_evidence) into one operation per message ID. If the two sources name
 * different peers for the same ID, keep that fact visible instead of guessing
 * which conversation to open.
 */
export function journeyMessageRefs(event) {
  const evidence = event?.messageEvidence ?? null;
  const refs = new Map();
  const add = (rawId, rawPeer) => {
    const messageId = typeof rawId === 'string' ? rawId.trim() : '';
    if (messageId.length === 0) return;
    const peerId = typeof rawPeer === 'string' ? rawPeer.trim() : '';
    const existing = refs.get(messageId);
    if (!existing) {
      refs.set(messageId, { messageId, peerId, peerConflict: false });
      return;
    }
    if (existing.peerId.length === 0 && peerId.length > 0) {
      existing.peerId = peerId;
      return;
    }
    if (peerId.length > 0 && existing.peerId !== peerId) existing.peerConflict = true;
  };
  for (const messageId of evidenceLocations(event).messageIds) {
    add(messageId, event?.peerId || evidence?.peerId || '');
  }
  if (evidence?.messageId) add(evidence.messageId, evidence.peerId || event?.peerId || '');
  return [...refs.values()];
}

export function contentStateSummary(mine) {
  if (!mine) return '';
  const parts = [];
  if (mine.profile?.state === 'missing') parts.push('尚未创建公开用户档案');
  if (mine.profile?.state === 'error') parts.push('公开用户档案读取失败');
  if (mine.posts?.state === 'error') parts.push('公开内容读取失败');
  if (mine.posts?.state === 'missing') parts.push('公开目录不可用');
  if (mine.posts?.truncated) parts.push('公开内容超过本次扫描上限，列表可能不完整');
  return parts.join('；');
}
