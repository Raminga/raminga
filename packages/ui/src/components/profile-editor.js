// Read-only public profile presentation for settings/public.
// P1 has no save/publish path and never turns missing data into an empty fake.

function factRow(doc, label, value) {
  const row = doc.createElement('div');
  const key = doc.createElement('dt');
  key.textContent = label;
  const detail = doc.createElement('dd');
  detail.textContent = value;
  row.append(key, detail);
  return row;
}

/** Read-only public Agent card + human profile summary. */
export function renderSettingsPublic(doc, nodes, { mine = null, agent = null, error = '', capable = true } = {}) {
  if (nodes.agent) {
    nodes.agent.replaceChildren();
    const cardRead = mine?.agentCard ?? null;
    const card = cardRead?.state === 'available' ? cardRead.card : null;
    if (card) {
      const dl = doc.createElement('dl');
      dl.className = 'rm-facts';
      dl.append(
        factRow(doc, '名称', agent?.name || card.displayName || '—'),
        factRow(doc, '公开介绍', card.description || '尚未填写'),
        factRow(doc, '兴趣', (card.interests || []).join('、') || '尚未填写'),
        factRow(doc, '公开交流风格', card.conversationStyle || '尚未填写'),
        factRow(doc, '更新时间', card.updatedAt || '未记录'),
      );
      nodes.agent.append(dl);
    } else {
      const p = doc.createElement('p');
      p.className = 'rm-list-note';
      p.textContent = cardRead?.state === 'error'
        ? `公开 Agent 卡片读取失败：${cardRead.error || '未知错误'}。`
        : '还没有公开 Agent 卡片。';
      nodes.agent.append(p);
    }
  }
  if (nodes.agentStatus) {
    nodes.agentStatus.textContent = mine === null
      ? '读取中'
      : mine.agentCard?.state === 'available' ? '公开卡片' : mine.agentCard?.state === 'error' ? '读取失败' : '尚未创建';
    nodes.agentStatus.dataset.tone = mine?.agentCard?.state === 'available' ? 'ready' : mine?.agentCard?.state === 'error' ? 'error' : 'unavailable';
  }
  if (nodes.humanStatus) {
    nodes.humanStatus.textContent = mine === null
      ? '读取中'
      : mine.profile?.state === 'available' ? '本机公开档案' : mine.profile?.state === 'error' ? '读取失败' : '尚未创建';
    nodes.humanStatus.dataset.tone = mine?.profile?.state === 'available' ? 'ready' : mine?.profile?.state === 'error' ? 'error' : 'unavailable';
  }
  if (nodes.humanPreview) {
    nodes.humanPreview.replaceChildren();
    if (mine?.profile?.state === 'available' && typeof nodes.renderMarkdown === 'function') {
      nodes.renderMarkdown(nodes.humanPreview, mine.profile.markdown);
    } else {
      const p = doc.createElement('p');
      p.className = 'rm-list-note';
      p.textContent = !capable
        ? '当前宿主没有提供本机公开资料读取。'
        : mine === null
          ? (error || '正在读取本机公开资料…')
          : mine.profile?.state === 'error'
            ? `公开人类档案读取失败：${mine.profile.error || '未知错误'}。`
            : '还没有公开人类档案（public/profile/index.md）。';
      nodes.humanPreview.append(p);
    }
  }
}

