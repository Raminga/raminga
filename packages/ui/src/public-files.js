// Pure presentation helpers for public files. No fetch, filesystem or HTML
// interpretation happens here; the host supplies already-bounded previews.

export const PREVIEW_STATUS_TEXT = {
  ok: '可预览',
  unsupported: '不支持预览',
  'copy-missing': '本地副本缺失',
  'hash-mismatch': '大小或哈希不符',
  'zip-error': 'ZIP 错误',
  'resource-error': '资源不完整',
  error: '读取失败',
};

export function previewStatusText(status) {
  return PREVIEW_STATUS_TEXT[status] ?? '读取失败';
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

export function fileKindLabel(kind, mime = '') {
  switch (kind) {
    case 'markdown': return 'Markdown';
    case 'json': return 'JSON 文本';
    case 'text': return '文本';
    case 'code': return '代码/文本';
    case 'image': return '图片';
    case 'audio': return '音频';
    case 'video': return '视频';
    case 'html': return 'HTML 沙箱预览';
    case 'zip': return 'ZIP 包';
    default: return mime || '未支持的文件';
  }
}

export function acquisitionSourceLabel(source) {
  const value = String(source ?? '').trim();
  if (value === 'raminga_content_get') return 'Agent 获取';
  if (value === 'raminga_ui_manual') return '手动获取';
  if (value === 'raminga_ui_refresh') return '手动刷新';
  if (value === 'local-public') return '本机公开目录';
  if (value === 'peer-manifest') return '对方公开清单';
  if (value === 'local-copy') return '本机历史副本';
  if (value.length === 0) return '来源未记录';
  return `来源：${value}`;
}

export function acquisitionSourcesLabel(sources, fallback = '') {
  const list = Array.isArray(sources) && sources.length > 0 ? sources : (fallback ? [fallback] : []);
  const labels = [];
  for (const source of list) {
    const label = acquisitionSourceLabel(source);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join(' + ') : '来源未记录';
}

export function acquisitionTone(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const agent = list.includes('raminga_content_get');
  const manual = list.includes('raminga_ui_manual') || list.includes('raminga_ui_refresh');
  if (agent && manual) return 'mixed';
  if (manual) return 'manual';
  if (agent) return 'agent';
  return 'unknown';
}

export function contentStateText(state, error = '') {
  switch (state) {
    case 'not-downloaded': return error || '尚未下载到本机；展开可手动获取';
    case 'downloaded-unverified': return error || '本地有副本，版本尚未核对；阅读或定位时会重新核对';
    case 'copy-missing': return error || '本地副本缺失；来源记录仍保留';
    case 'hash-mismatch': return error || '本地副本大小或 SHA-256 与记录不一致，不会展示或定位为新版本';
    case 'unreadable': return error || '本地副本不可读取';
    default: return '';
  }
}

export function isPostPath(filePath) {
  const value = String(filePath ?? '');
  return /^posts\/[A-Za-z0-9._-]+\.json$/.test(value) || /^posts\/[A-Za-z0-9._-]+\/post\.json$/.test(value);
}

/** Images that belong to a post body are read through that post, never as a
 * standalone public file. */
export function isPostImagePath(filePath) {
  return /^posts\/[A-Za-z0-9._-]+\/images\/[^/]+$/.test(String(filePath ?? ''));
}

export function postCount(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => isPostPath(entry?.path)).length;
}

export function addressSourceLabel(source) {
  switch (source) {
    case 'connection': return '当前连接';
    case 'peerstore': return '本机 Peerstore/已知地址（非公告证据）';
    case 'peer': return '本机 Peerstore/已知地址（非公告证据）';
    case 'cache': return '本机缓存';
    case 'contact': return '联系人记录';
    case 'dht': return 'DHT';
    default: return '来源未记录';
  }
}

export function reachabilityLabel(reachability) {
  switch (reachability) {
    case 'verified': return '当前连接已验证';
    case 'reported': return '对端报告，未独立验证';
    case 'unverified': return '旧地址，未验证可达';
    default: return '可达性未知';
  }
}

export function connectionStateLabel(state, freshness = '') {
  const base = state === 'connected' ? '已连接' : state === 'disconnected' ? '未连接' : '未知';
  return freshness === 'live' ? base : `${base}（非实时快照）`;
}

export function addressesText(addresses) {
  return (Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address?.multiaddr ?? '').trim())
    .filter((value) => value.length > 0)
    .join('\n');
}

export function fileInfoLine(entry) {
  const size = formatBytes(entry?.sizeBytes);
  const kind = fileKindLabel(entry?.kind, entry?.mime);
  return [size, kind].filter(Boolean).join(' · ');
}
