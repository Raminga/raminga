// Journey record DOM rendering. Pure presentation over an already-read
// Journey snapshot; it never reads files or infers Agent/tool state.
import {
  formatDateTime,
  journeyDirectionText,
  journeyEventLabel,
  journeyMessageRefs,
  journeyModeText,
  journeySessionTitle,
  journeyStatusText,
  journeyTimeText,
  shortPeerText,
} from '../content.js';

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function renderJourneyRawDetails(rows, label = '记录详情') {
  const details = element('details', 'rm-journey-record');
  const summary = element('summary');
  summary.textContent = label;
  const facts = element('dl', 'rm-journey-facts');
  for (const [keyText, value] of rows) {
    if (!value) continue;
    const row = element('div');
    const key = element('dt');
    key.textContent = keyText;
    const val = element('dd');
    val.textContent = value;
    row.append(key, val);
    facts.append(row);
  }
  if (facts.childElementCount === 0) return null;
  details.append(summary, facts);
  return details;
}

export function renderJourneySession(session, { expanded = false, renderMarkdown = () => {}, checkFor = () => null, expandable = true, showHeader = true } = {}) {
  const article = element('article', 'rm-journey-card');
  const header = element(expandable ? 'button' : 'div', 'rm-journey-head');
  if (expandable) {
    header.type = 'button';
    header.dataset.sessionToggle = session.id;
    header.dataset.focusKey = `journey:${session.id}`;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  } else {
    header.classList.add('rm-journey-head-static');
  }
  const copy = element('span', 'rm-journey-copy');
  const title = element('b');
  title.textContent = journeySessionTitle(session);
  const meta = element('span', 'rm-journey-meta');
  const time = journeyTimeText(session);
  meta.textContent = `${session.id}${time ? ` · ${time}` : ''}`;
  copy.append(title, meta);
  const status = journeyStatusText(session.state);
  const chip = element('span', 'rm-journey-status');
  chip.dataset.tone = status.tone;
  chip.textContent = status.label;
  if (showHeader) {
    header.append(copy, chip);
    article.append(header);
  }
  if (status.note.length > 0) {
    const note = element('p', 'rm-list-note');
    note.textContent = status.note;
    article.append(note);
  }
  if (session.stateError) {
    const failed = element('p', 'rm-list-note');
    failed.textContent = `state.json 无法解析：${session.stateError}。只展示仍可读取的事件与报告。`;
    article.append(failed);
  }
  if (!expanded) return article;

  const detail = element('div', 'rm-journey-detail');
  if (session.state) {
    const facts = element('dl', 'rm-journey-facts');
    const addFact = (labelText, value) => {
      if (!value) return;
      const row = element('div');
      const key = element('dt');
      key.textContent = labelText;
      const val = element('dd');
      val.textContent = value;
      row.append(key, val);
      facts.append(row);
    };
    addFact('记录状态', status.recordLabel || status.label);
    addFact('模式', journeyModeText(session.state.mode));
    addFact('开始', formatDateTime(session.state.startedAt));
    addFact('最后保存', formatDateTime(session.state.updatedAt));
    addFact('完成时间', formatDateTime(session.state.completedAt));
    addFact('结束原因', session.state.completionReason);
    addFact('当前对象', session.state.currentPeerId ? shortPeerText(session.state.currentPeerId) : '');
    addFact('访问过', session.state.visitedPeerIds.map(shortPeerText).join('、'));
    addFact('发现来源', session.state.discoverySources.join('、'));
    if (facts.childElementCount > 0) detail.append(facts);
    const sessionRaw = renderJourneyRawDetails([
      ['状态原文', session.state.status],
      ['模式原文', session.state.mode],
      ['会话标识', session.id],
      ['当前对象完整 ID', session.state.currentPeerId],
      ['访问对象完整 ID', session.state.visitedPeerIds.join('\n')],
      ['发现来源', session.state.discoverySources.join('、')],
    ]);
    if (sessionRaw) detail.append(sessionRaw);
  }
  if (session.eventsRead === 'error') {
    const failed = element('p', 'rm-list-note');
    failed.textContent = `events.jsonl 读取失败：${session.eventsError}`;
    detail.append(failed);
  } else if (session.events.length === 0) {
    const empty = element('p', 'rm-list-note');
    empty.textContent = session.eventsRead === 'missing' ? '这次 Journey 没有 events.jsonl。' : 'events.jsonl 中没有可解析的活动。';
    detail.append(empty);
  } else {
    const list = element('ol', 'rm-journey-events');
    for (const event of session.events) {
      const item = element('li');
      item.dataset.sequence = String(event.sequence);
      const line = element('div', 'rm-journey-event-head');
      const seq = element('span', 'rm-journey-sequence');
      seq.textContent = `#${event.sequence}`;
      const label = element('b');
      label.textContent = journeyEventLabel(event);
      const at = element('span', 'rm-journey-event-time');
      at.textContent = event.timestamp ? formatDateTime(event.timestamp) : '';
      line.append(seq, label, at);
      item.append(line);
      if (event.summary) {
        const summary = element('p', 'rm-journey-event-text');
        summary.textContent = event.summary;
        item.append(summary);
      }
      const refs = journeyMessageRefs(event);
      const contentPaths = Array.isArray(event.contentPaths) ? event.contentPaths : [];
      if (event.peerId) {
        const peerRef = element('p', 'rm-journey-peer-ref');
        peerRef.textContent = `相关对象 ${shortPeerText(event.peerId)}`;
        peerRef.title = event.peerId;
        item.append(peerRef);
      }
      const actions = element('div', 'rm-journey-actions');
      if (event.peerId) {
        const related = element('button', 'rm-journey-action');
        related.type = 'button';
        related.dataset.profilePeer = event.peerId;
        related.dataset.profileRef = `raminga:${session.id}:${event.sequence}`;
        related.dataset.focusKey = `journey-peer:${session.id}:${event.sequence}`;
        related.textContent = '查看相关对象';
        related.setAttribute('aria-label', `查看相关对象 ${shortPeerText(event.peerId)}`);
        actions.append(related);
      }
      if (event.peerId && refs.length > 0) {
        const chat = element('button', 'rm-journey-action');
        chat.type = 'button';
        chat.dataset.openJourneyChat = event.peerId;
        chat.dataset.focusKey = `journey-chat:${session.id}:${event.sequence}`;
        chat.textContent = '打开相关会话';
        actions.append(chat);
      }
      for (const ref of refs) {
        if (ref.peerConflict || ref.peerId.length === 0) continue;
        const locate = element('button', 'rm-journey-action');
        locate.type = 'button';
        locate.dataset.locatePeer = ref.peerId;
        locate.dataset.locateMessage = ref.messageId;
        locate.dataset.focusKey = `journey-locate:${session.id}:${event.sequence}:${ref.messageId}`;
        locate.textContent = '核对当前保留消息';
        actions.append(locate);
      }
      if (actions.childElementCount > 0) item.append(actions);
      const results = element('div', 'rm-journey-results');
      for (const ref of refs) {
        if (ref.peerConflict) {
          results.append(journeyCheckNode('unavailable', '引用中的 Peer 不一致，这里不猜测会话，也未跳转。'));
          continue;
        }
        if (ref.peerId.length === 0) {
          results.append(journeyCheckNode('unavailable', '这条引用没有可用的 Peer，无法核对当前消息。'));
          continue;
        }
        const check = checkFor(ref.peerId, ref.messageId);
        if (!check) continue;
        const node = journeyCheckNode(check.tone, check.text);
        node.dataset.locateResult = ref.messageId;
        results.append(node);
      }
      if (results.childElementCount > 0) item.append(results);
      if (contentPaths.length > 0) {
        const paths = element('p', 'rm-journey-content-paths');
        paths.textContent = `公开内容引用：${contentPaths.join('、')}（不会自动重新抓取）`;
        item.append(paths);
      }
      if (event.messageEvidence) {
        const evidence = event.messageEvidence;
        const box = element('div', 'rm-journey-evidence');
        const evidenceTitle = element('b');
        evidenceTitle.textContent = 'Journey 当时的历史观察';
        const text = element('p');
        text.textContent = `${evidence.summary || '没有摘要'} · ${journeyDirectionText(evidence.direction)}${evidence.observedAt ? ` · 观察于 ${formatDateTime(evidence.observedAt)}` : ''}`;
        const note = element('p', 'rm-list-note');
        note.textContent = '这是当时保存的观察，不是 Node 当前投递或 ACK 状态；核对当前保留消息只以当前记录为准。';
        box.append(evidenceTitle, text, note);
        item.append(box);
      }
      const raw = renderJourneyRawDetails([
        ['事件序号', event.sequence > 0 ? `#${event.sequence}` : ''],
        ['事件类型原文', event.type],
        ['消息 ID', refs.map((ref) => ref.messageId).join('、')],
        ['方向原文', event.messageEvidence?.direction || ''],
        ['当时确认', typeof event.messageEvidence?.acked === 'boolean'
          ? (event.messageEvidence.acked ? '已确认（仅当时）' : '尚未确认（仅当时）')
          : ''],
        ['观察时间', event.messageEvidence?.observedAt ? formatDateTime(event.messageEvidence.observedAt) : ''],
        ['内容版本', event.messageEvidence?.contentSha256 || ''],
        ['内容引用', contentPaths.join('、')],
      ]);
      if (raw) item.append(raw);
      list.append(item);
    }
    detail.append(list);
    if (session.eventsTruncated) {
      const truncated = element('p', 'rm-list-note');
      truncated.textContent = `只展示前 ${session.events.length} 条事件；events.jsonl 还有更多内容。`;
      detail.append(truncated);
    }
    if (session.badEventLines > 0) {
      const bad = element('p', 'rm-list-note');
      bad.textContent = `events.jsonl 有 ${session.badEventLines} 行无法解析，已跳过；其他活动仍按原文展示。`;
      detail.append(bad);
    }
  }
  if (session.reportRead === 'available') {
    const panel = element('section', 'rm-journey-report');
    const heading = element('h3');
    heading.textContent = 'Journey 报告 · Agent 生成的摘要，不是传输证据';
    const content = element('div', 'rm-rich-text');
    renderMarkdown(content, session.reportMarkdown);
    panel.append(heading, content);
    detail.append(panel);
  } else if (session.reportRead === 'error') {
    const failed = element('p', 'rm-list-note');
    failed.textContent = `report.md 读取失败：${session.reportError}`;
    detail.append(failed);
  }
  article.append(detail);
  return article;
}

function journeyCheckNode(tone, text) {
  const node = element('p', 'rm-journey-check');
  node.dataset.tone = tone;
  node.textContent = text;
  return node;
}

