// Shared status presentation helpers. They only describe values the host has
// already fetched; no daemon access and no fallback identity are invented here.
export const NODE_PHASES = new Set(['loading', 'ready', 'stale', 'error', 'closed']);

export function shortPeer(value, limit = 22) {
  const text = String(value ?? '');
  if (text.length <= limit) return text || '—';
  return `${text.slice(0, 10)}…${text.slice(-8)}`;
}

export function formatClock(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

export function formatRelative(value, now = Date.now()) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const delta = Math.max(0, now - ms);
  if (delta < 10_000) return '刚刚';
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  return formatClock(ms);
}

/** Count connections and unique Peers; one Peer may have direct and relay links. */
export function connectionSummary(status) {
  const connections = Array.isArray(status?.connections) ? status.connections : [];
  const routes = { direct: 0, relay: 0, other: 0 };
  for (const connection of connections) {
    const route = String(connection?.route ?? '').toLowerCase();
    if (route === 'direct') routes.direct += 1;
    else if (route === 'relay') routes.relay += 1;
    else routes.other += 1;
  }
  return {
    connections: connections.length,
    peers: new Set(connections.map((connection) => String(connection?.peerId ?? '')).filter(Boolean)).size,
    routes,
  };
}

export function routeText(status) {
  const summary = connectionSummary(status);
  if (summary.connections === 0) return '暂无连接';
  const parts = [`直连 ${summary.routes.direct}`, `中继 ${summary.routes.relay}`];
  if (summary.routes.other > 0) parts.push(`其他 ${summary.routes.other}`);
  return parts.join(' · ');
}

function staleResultText(statusAt, now) {
  const at = Number(statusAt);
  if (!Number.isFinite(at) || at <= 0) return '上次结果，非实时';
  return `${formatRelative(at, now)}的结果，非实时`;
}

/**
 * Connection text from one Status snapshot. When the snapshot is not live it
 * says so and keeps its read time; no status at all renders a dash rather than
 * inventing "0 connections".
 */
export function connectionFactText(status, { freshness = 'live', statusAt = 0, now = Date.now() } = {}) {
  if (!status) return '—';
  const summary = connectionSummary(status);
  const base = `${summary.connections} 条连接 · ${summary.peers} 个已连接节点`;
  return freshness === 'live' ? base : `${base} · ${staleResultText(statusAt, now)}`;
}

/** Route text with the same stale-result marker as the connection facts. */
export function routeFactText(status, { freshness = 'live', statusAt = 0, now = Date.now() } = {}) {
  if (!status) return '—';
  const base = routeText(status);
  return freshness === 'live' ? base : `${base} · ${staleResultText(statusAt, now)}`;
}

export function refreshedText(statusAt, now = Date.now()) {
  const at = Number(statusAt);
  if (!Number.isFinite(at) || at <= 0) return '尚无成功读取';
  return `${formatRelative(at, now)} · ${formatClock(at)}`;
}

export function nodePillText(phase, status) {
  if (phase === 'ready') {
    const summary = connectionSummary(status);
    return `节点状态 · ${summary.connections} 条连接`;
  }
  if (phase === 'stale') return '节点状态 · 更新中断';
  if (phase === 'error') return '节点状态 · 暂不可用';
  if (phase === 'closed') return '节点状态 · 已断开';
  return '节点状态 · 读取中';
}

export function nodePhaseText(phase) {
  return {
    loading: '正在读取本机节点',
    ready: '本机节点可用',
    stale: '实时更新已中断',
    error: '本机节点暂不可用',
    closed: '实时更新已断开',
  }[phase] ?? '正在读取本机节点';
}

export function subscriptionText(stats) {
  if (!stats) return '—';
  if (stats.subscriptions > 0 || stats.streamPhase === 'open') return '已开启';
  if (stats.streamPhase === 'reconnecting') return '已中断，正在重试';
  if (stats.streamPhase === 'connecting') return '正在连接';
  if (stats.streamActive) return '正在连接';
  if ((stats.openSessions ?? 0) > 0) return '已暂停';
  return '未开启';
}
