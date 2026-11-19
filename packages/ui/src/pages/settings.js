// Settings sub-page helpers for the task-based index. Public profile editing,
// public files, private persona/growth, memory, favorites and node views are
// separate panels; the host owns persistence and publication.
export const SETTINGS_TABS = ['public', 'files', 'private', 'memory', 'favorites', 'node'];

export function normalizeSettingsTab(value) {
  return SETTINGS_TABS.includes(value) ? value : 'public';
}

/** Toggle the settings index and the selected sub-page without a URL route. */
export function showSettingsTab(root, tab, { index = false } = {}) {
  const active = normalizeSettingsTab(tab);
  const indexNode = root.querySelector('#settingsIndex');
  if (indexNode) indexNode.hidden = !index;
  for (const name of SETTINGS_TABS) {
    const panel = root.querySelector(`#settings-${name}`);
    if (panel) panel.hidden = index || name !== active;
  }
  return active;
}

export function hideSettingsPanels(root) {
  const index = root.querySelector('#settingsIndex');
  if (index) index.hidden = true;
  for (const name of SETTINGS_TABS) {
    const panel = root.querySelector(`#settings-${name}`);
    if (panel) panel.hidden = true;
  }
}

/** Show a real node summary without duplicating the status dialog state. */
export function renderSettingsNode(nodes, { phase = 'loading', status = null, summary = '' } = {}) {
  if (!nodes) return;
  const labels = {
    loading: '读取中', ready: '在线快照', stale: '旧快照', error: '读取失败', closed: '实时更新已中断',
  };
  if (nodes.label) {
    nodes.label.textContent = labels[phase] || '未知';
    nodes.label.dataset.tone = phase === 'ready' ? 'ready' : phase === 'error' ? 'error' : 'unavailable';
  }
  if (nodes.summary) {
    nodes.summary.textContent = status
      ? `${summary || '本机节点已响应'} · Peer ${status.peerId ? `${String(status.peerId).slice(0, 10)}…${String(status.peerId).slice(-8)}` : '未知'}`
      : summary || (phase === 'loading' ? '正在读取本机节点状态…' : '暂时读不到本机节点状态；这里不会推测在线或离线。');
  }
  if (nodes.statusButton) nodes.statusButton.disabled = false;
  if (nodes.shareButton) nodes.shareButton.disabled = false;
}

