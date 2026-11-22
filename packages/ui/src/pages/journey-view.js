// Journey list tiles and the independent Journey detail page.
//
// Everything here is presentation over a bounded Journey snapshot supplied by
// the host. A saved `running` state is a record, never proof that a tool is
// executing right now. Reports are Agent-generated summaries, not transport
// evidence. No image is invented: a cover is rendered only when the host
// supplies a safe inline image data URL.
import {
  formatDateTime,
  journeyDirectionText,
  journeyEventLabel,
  journeyMessageRefs,
  journeyModeText,
  journeyStatusText,
  journeyTimeText,
  shortPeerText,
} from '../content.js';

const INSTRUCTION_HINTS = /(请|帮我|帮忙|任务[:：]|执行|先读取|然后|并且|需要先|完成以下)/;
const MAX_TITLE = 42;

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function plain(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function sessionTime(session) {
  return session?.state?.updatedAt || session?.state?.startedAt || session?.dirModifiedAt || 0;
}

function safeCover(session) {
  const value = typeof session?.coverImage === 'string' ? session.coverImage.trim() : '';
  if (!value.startsWith('data:image/')) return '';
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) return '';
  if (value.length > 512 * 1024) return '';
  return value;
}

/** A neutral title when the saved intent is a long task instruction. */
export function journeyDisplayTitle(session) {
  const intent = String(session?.state?.intent ?? '').trim();
  const usable = intent.length > 0
    && intent.length <= MAX_TITLE
    && !/[\r\n]/.test(intent)
    && !INSTRUCTION_HINTS.test(intent)
    && !/[。；;]$/.test(intent);
  if (usable) return intent;
  const at = Date.parse(String(session?.state?.startedAt || session?.state?.updatedAt || ''));
  if (Number.isFinite(at) && at > 0) {
    const date = new Date(at);
    return `${date.getMonth() + 1}月${date.getDate()}日 · 漫游`;
  }
  return '漫游记录';
}

export function journeyHasLongIntent(session) {
  const intent = String(session?.state?.intent ?? '').trim();
  return intent.length > 0 && journeyDisplayTitle(session) !== intent;
}

/** Prefer an existing report excerpt, then real event summaries. */
export function journeySummary(session, limit = 132) {
  const report = plain(session?.state?.summary || session?.reportMarkdown).slice(0, limit);
  if (report.length > 0) return report;
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const summary = plain(events[index]?.summary);
    if (summary.length > 0) {
      return summary.length > limit ? `${summary.slice(0, limit)}…` : summary;
    }
  }
  const reason = plain(session?.state?.completionReason);
  if (reason.length > 0) return reason.length > limit ? `${reason.slice(0, limit)}…` : reason;
  const visited = journeyVisitedPeers(session).length;
  if (visited > 0) return `记录了 ${visited} 个访问对象。`;
  return '这次旅程没有留下可读的摘要。';
}

/**
 * Peers actually recorded as visited, in record order. `visitedPeerIds` is the
 * primary record; a completed visit event is additional proof that the peer
 * was visited. A current candidate or clue alone is never a visit.
 */
export function journeyVisitedPeers(session) {
  const rows = [];
  const seen = new Set();
  const add = (peerId, source) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || seen.has(peerId)) return;
    seen.add(peerId);
    rows.push({ peerId, source });
  };
  for (const peerId of (Array.isArray(session?.state?.visitedPeerIds) ? session.state.visitedPeerIds : [])) add(peerId, 'state');
  for (const event of (Array.isArray(session?.events) ? session.events : [])) {
    if (event?.type !== 'visit_completed') continue;
    add(String(event.peerId ?? ''), 'event');
  }
  return rows;
}

/**
 * Candidates and clues that were never recorded as visited. They are rendered
 * as independent text, never as route nodes.
 */
export function journeyUnvisitedPeers(session) {
  const visited = new Set(journeyVisitedPeers(session).map((item) => item.peerId));
  const rows = [];
  const seen = new Set();
  const add = (peerId, kind) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || visited.has(peerId) || seen.has(peerId)) return;
    seen.add(peerId);
    rows.push({ peerId, kind });
  };
  add(String(session?.state?.currentPeerId ?? ''), 'current');
  for (const event of (Array.isArray(session?.events) ? session.events : [])) {
    if (journeyEventCategory(event).id !== 'clue') continue;
    add(String(event.peerId ?? ''), 'clue');
  }
  return rows;
}

/** Search stays able to find the current candidate without calling it visited. */
export function journeySearchPeers(session) {
  const rows = journeyVisitedPeers(session).map((item) => item.peerId);
  const current = String(session?.state?.currentPeerId ?? '');
  if (current.length > 0 && !rows.includes(current)) rows.push(current);
  return rows;
}

export function journeyMatches(session, rawQuery, peerLabel = shortPeerText) {
  const query = String(rawQuery ?? '').trim().toLowerCase();
  if (query.length === 0) return true;
  const fields = [
    journeyDisplayTitle(session),
    session?.state?.intent,
    session?.id,
    session?.state?.mode,
    journeyModeText(session?.state?.mode),
    session?.state?.completionReason,
    session?.state?.summary || plain(session?.reportMarkdown).slice(0, 1000),
    ...(Array.isArray(session?.state?.discoverySources) ? session.state.discoverySources : []),
    ...journeySearchPeers(session).flatMap((peerId) => [peerId, peerLabel(peerId)]),
    ...(Array.isArray(session?.events) ? session.events.flatMap((event) => [event?.summary, event?.peerId]) : []),
  ];
  return fields.some((field) => String(field ?? '').toLowerCase().includes(query));
}

export function journeyEventCategory(event) {
  const type = String(event?.type ?? '');
  if (type === 'message_sent' || type === 'message_received' || type === 'reply_timeout') {
    return { id: 'chat', label: '对话', tone: 'chat' };
  }
  if (type === 'candidates_presented' || type === 'candidate_selected' || type === 'peer_skipped'
    || type === 'curiosity_added' || type === 'impression_updated') {
    return { id: 'clue', label: '线索', tone: 'clue' };
  }
  if (type === 'visit_started' || type === 'visit_completed' || type === 'content_read') {
    return { id: 'visit', label: '访问', tone: 'visit' };
  }
  return { id: 'record', label: '记录', tone: 'record' };
}

export function journeyEvidenceRefs(session) {
  const rows = [];
  const seen = new Set();
  for (const event of (Array.isArray(session?.events) ? session.events : [])) {
    for (const ref of journeyMessageRefs(event)) {
      if (ref.peerConflict || ref.peerId.length === 0 || ref.messageId.length === 0) continue;
      const key = `${ref.peerId}\u0000${ref.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...ref,
        sequence: event.sequence,
        eventLabel: journeyEventLabel(event),
        eventTime: event.timestamp,
        summary: event.summary,
        direction: event.messageEvidence?.direction || '',
        observedAt: event.messageEvidence?.observedAt || event.timestamp,
      });
    }
    if (event?.messageEvidence?.peerId && event.messageEvidence.messageId) {
      const key = `${event.messageEvidence.peerId}\u0000${event.messageEvidence.messageId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({
          peerId: event.messageEvidence.peerId,
          messageId: event.messageEvidence.messageId,
          peerConflict: false,
          sequence: event.sequence,
          eventLabel: journeyEventLabel(event),
          eventTime: event.timestamp,
          summary: event.summary || event.messageEvidence.summary,
          direction: event.messageEvidence.direction || '',
          observedAt: event.messageEvidence.observedAt || event.timestamp,
        });
      }
    }
  }
  return rows;
}

/** One compact home/list tile. The whole tile is a single button. */
export function renderJourneyTile(doc, session, {
  source = 'home',
  peerLabel = shortPeerText,
  focusKey = '',
} = {}) {
  const button = element('button', 'rm-journey-tile');
  button.type = 'button';
  button.dataset.journeyOpen = session.id;
  button.dataset.journeySource = source;
  if (focusKey) button.dataset.focusKey = focusKey;
  const status = journeyStatusText(session.state);
  const top = element('span', 'rm-journey-tile-top');
  const time = element('time', 'rm-journey-tile-time');
  time.textContent = journeyTimeText(session) || '时间未记录';
  const chip = element('span', 'rm-journey-status');
  chip.dataset.tone = status.tone;
  chip.textContent = status.label;
  top.append(time, chip);
  const title = element('b', 'rm-journey-tile-title');
  title.textContent = journeyDisplayTitle(session);
  const summary = element('span', 'rm-journey-tile-summary');
  summary.textContent = journeySummary(session, 92);
  const meta = element('span', 'rm-journey-tile-meta');
  const visited = journeyVisitedPeers(session);
  const parts = [];
  if (visited.length > 0) parts.push(`访问 ${visited.length} 个对象`);
  parts.push(`${Array.isArray(session.events) ? session.events.length : 0} 条事件`);
  meta.textContent = parts.join(' · ');
  button.append(top, title, summary, meta);
  const cover = safeCover(session);
  if (cover.length > 0) {
    const image = element('img', 'rm-journey-tile-image');
    image.src = cover;
    image.alt = '';
    image.loading = 'lazy';
    button.prepend(image);
  }
  button.setAttribute('aria-label', `${journeyDisplayTitle(session)}，${status.label}，打开漫游详情`);
  return button;
}

function factRows(doc, rows) {
  const dl = element('dl', 'rm-journey-facts');
  for (const [keyText, value] of rows) {
    if (!value) continue;
    const row = element('div');
    const key = element('dt');
    key.textContent = keyText;
    const val = element('dd');
    val.textContent = String(value);
    row.append(key, val);
    dl.append(row);
  }
  return dl;
}

function sectionHeading(doc, textValue, note = '') {
  const head = element('div', 'rm-journey-section-head');
  const heading = element('h2');
  heading.textContent = textValue;
  head.append(heading);
  if (note) {
    const meta = element('span', 'rm-journey-section-note');
    meta.textContent = note;
    head.append(meta);
  }
  return head;
}

/**
 * Render the independent detail. `checkFor(peerId, messageId)` returns the
 * current retained-message check for one reference or null.
 */
export function renderJourneyDetail(doc, node, session, {
  peerLabel = shortPeerText,
  renderMarkdown = () => {},
  checkFor = () => null,
  highlightSeq = 0,
  activityMissingEvent = false,
  activityOperation = null,
  source = 'journeys',
  scope = null,
  highlightFocus = true,
} = {}) {
  node.replaceChildren();
  const status = journeyStatusText(session.state);
  const head = element('header', 'rm-journey-detail-head');
  const eyebrow = element('p', 'rm-eyebrow');
  eyebrow.textContent = 'LITTLE JOURNEY · 本机记录';
  const titleRow = element('div', 'rm-journey-detail-title');
  const title = element('h1');
  title.textContent = journeyDisplayTitle(session);
  const chip = element('span', 'rm-journey-status');
  chip.dataset.tone = status.tone;
  chip.textContent = status.label;
  if (status.note) chip.title = status.note;
  titleRow.append(title, chip);
  const meta = element('p', 'rm-journey-detail-meta');
  const metaParts = [journeyTimeText(session)];
  if (session.state?.mode) metaParts.push(`模式 ${journeyModeText(session.state.mode)}`);
  meta.textContent = metaParts.filter(Boolean).join(' · ');
  head.append(eyebrow, titleRow, meta);
  node.append(head);

  // Summary first: an existing report excerpt is preferred and explicitly
  // labelled as an Agent summary rather than transport evidence.
  const summaryCard = element('section', 'rm-journey-summary');
  const summaryLabel = element('p', 'rm-journey-summary-label');
  summaryLabel.textContent = session.state?.summary || session.reportRead === 'available'
    ? '摘要 · Agent 生成的报告内容，不是传输证据'
    : '摘要 · 来自状态与事件记录';
  const summaryText = element('p', 'rm-journey-summary-text');
  summaryText.textContent = journeySummary(session, 260);
  summaryCard.append(summaryLabel, summaryText);
  if (journeyHasLongIntent(session)) {
    const intentNote = element('p', 'rm-list-note');
    intentNote.textContent = '保存的任务说明较长，已使用中性标题；原文收在“来源与读取范围”。';
    summaryCard.append(intentNote);
  }
  node.append(summaryCard);

  // Actual route from recorded visits only. A current candidate or a clue is
  // labelled beside the route, never placed on the arrow chain.
  const route = element('section', 'rm-journey-route');
  const routeLabel = element('p', 'rm-journey-route-label');
  routeLabel.textContent = '实际路线';
  route.append(routeLabel);
  const routeLine = element('div', 'rm-journey-route-line');
  const start = element('span', 'rm-journey-route-node');
  start.textContent = '本机 Agent';
  routeLine.append(start);
  const visited = journeyVisitedPeers(session);
  if (visited.length > 0) {
    for (const item of visited) {
      const arrow = element('span', 'rm-journey-route-arrow');
      arrow.textContent = '→';
      const nodeText = element('span', 'rm-journey-route-node');
      nodeText.textContent = peerLabel(item.peerId);
      nodeText.title = item.peerId;
      nodeText.dataset.journeyRoutePeer = item.peerId;
      nodeText.dataset.journeyRouteSource = item.source;
      routeLine.append(arrow, nodeText);
    }
  } else {
    const empty = element('span', 'rm-journey-route-node');
    empty.textContent = '记录中没有访问对象';
    routeLine.append(empty);
  }
  route.append(routeLine);
  const unvisited = journeyUnvisitedPeers(session);
  for (const item of unvisited) {
    const aside = element('p', 'rm-journey-route-aside');
    aside.dataset.journeyRouteAside = item.kind;
    aside.dataset.journeyRoutePeer = item.peerId;
    const label = peerLabel(item.peerId);
    aside.textContent = item.kind === 'current'
      ? `记录中的当前对象：${label}（未记录为已访问，不计入路线）`
      : `线索中提到的对象：${label}（尚无访问记录，不计入路线）`;
    aside.title = item.peerId;
    route.append(aside);
  }
  const routeNote = element('p', 'rm-journey-route-note');
  if (visited.length > 0) {
    routeNote.textContent = '按本机 Journey 记录整理；只表示记录中的访问顺序，不代表对端在线或已读。';
  } else if (unvisited.length > 0) {
    routeNote.textContent = '这次记录没有已访问对象；候选或线索不计入路线。';
  } else {
    routeNote.textContent = '这次记录没有已访问对象。';
  }
  route.append(routeNote);
  node.append(route);

  if (activityOperation) {
    const banner = element('p', 'rm-journey-activity-banner');
    banner.dataset.tone = activityMissingEvent ? 'unavailable' : 'ready';
    banner.textContent = activityMissingEvent
      ? `关联的工具调用 ${activityOperation.tool || 'raminga 工具'} 仍在本机，但这次调用没有找到对应的 Journey 事件。`
      : `已从本机工具活动定位到这段 Journey${highlightSeq > 0 ? ` 的事件 #${highlightSeq}` : ''}。`;
    node.append(banner);
  }

  // Events: actual recorded lines, classified so visits, clues and chat
  // evidence stay distinguishable.
  const events = Array.isArray(session.events) ? session.events : [];
  const eventSection = element('section', 'rm-journey-events-section');
  eventSection.append(sectionHeading(doc, '关键事件', `${events.length} 条`));
  if (session.eventsRead === 'error') {
    const failed = element('p', 'rm-journey-check');
    failed.dataset.tone = 'error';
    failed.textContent = `events.jsonl 读取失败：${session.eventsError}`;
    eventSection.append(failed);
  } else if (events.length === 0) {
    const empty = element('p', 'rm-list-note');
    empty.textContent = session.eventsRead === 'missing' ? '这次 Journey 没有 events.jsonl。' : 'events.jsonl 中没有可解析的事件。';
    eventSection.append(empty);
  } else {
    const list = element('ol', 'rm-journey-event-list');
    let firstHighlight = null;
    for (const event of events) {
      const category = journeyEventCategory(event);
      const item = element('li', 'rm-journey-event');
      item.dataset.journeyEvent = String(event.sequence);
      item.dataset.category = category.id;
      if (highlightSeq > 0 && event.sequence === highlightSeq) {
        item.dataset.highlight = 'true';
        item.tabIndex = -1;
        firstHighlight ??= item;
      }
      const top = element('div', 'rm-journey-event-top');
      const kind = element('span', 'rm-journey-event-kind');
      kind.dataset.tone = category.tone;
      kind.textContent = category.label;
      const label = element('b');
      label.textContent = journeyEventLabel(event);
      const at = element('time');
      at.textContent = event.timestamp ? formatDateTime(event.timestamp) : '';
      top.append(kind, label, at);
      item.append(top);
      if (event.summary) {
        const text = element('p', 'rm-journey-event-summary');
        text.textContent = event.summary;
        item.append(text);
      }
      if (event.peerId) {
        const peer = element('p', 'rm-journey-event-peer');
        peer.textContent = `对象 ${peerLabel(event.peerId)}`;
        peer.title = event.peerId;
        item.append(peer);
      }
      const raw = element('details', 'rm-journey-event-raw');
      const rawSummary = element('summary');
      rawSummary.textContent = '事件原文';
      raw.append(rawSummary);
      raw.append(factRows(doc, [
        ['序号', event.sequence > 0 ? `#${event.sequence}` : ''],
        ['类型原文', event.type],
        ['时间', event.timestamp ? formatDateTime(event.timestamp) : ''],
        ['Peer 完整 ID', event.peerId || ''],
        ['消息 ID', (event.messageIds || []).join('、')],
        ['内容引用', (event.contentPaths || []).join('、')],
        ['当时方向', event.messageEvidence?.direction || ''],
        ['当时确认', typeof event.messageEvidence?.acked === 'boolean' ? (event.messageEvidence.acked ? '已确认（仅当时）' : '尚未确认（仅当时）') : ''],
      ]));
      item.append(raw);
      list.append(item);
    }
    eventSection.append(list);
    if (session.eventsTruncated) {
      const note = element('p', 'rm-list-note');
      note.textContent = `只展示前 ${events.length} 条事件；events.jsonl 还有更多内容。`;
      eventSection.append(note);
    }
    if (session.badEventLines > 0) {
      const note = element('p', 'rm-list-note');
      note.textContent = `events.jsonl 有 ${session.badEventLines} 行无法解析，已跳过；其他事件仍按原文展示。`;
      eventSection.append(note);
    }
    node.append(eventSection);
    node.__journeyHighlight = firstHighlight;
  }
  if (events.length === 0) node.append(eventSection);

  // Message evidence: only real message IDs referenced by events.
  const evidence = journeyEvidenceRefs(session);
  const messageSection = element('section', 'rm-journey-evidence-section');
  messageSection.append(sectionHeading(doc, '消息证据', `${evidence.length} 条`));
  const messageNote = element('p', 'rm-list-note');
  messageNote.textContent = evidence.length > 0
    ? '消息 ID 来自 Journey 事件引用；核对按钮只查当前保留的消息，不证明对方已读或已回复。'
    : '这次 Journey 的事件里没有消息 ID 证据；不能据此声称发生过对话。';
  messageSection.append(messageNote);
  if (evidence.length > 0) {
    const list = element('div', 'rm-journey-evidence-list');
    for (const ref of evidence) {
      const row = element('article', 'rm-journey-evidence-row');
      row.dataset.journeyEvidence = ref.messageId;
      const copy = element('div', 'rm-journey-evidence-copy');
      const headLine = element('div', 'rm-journey-evidence-head');
      const who = element('b');
      who.textContent = peerLabel(ref.peerId);
      const when = element('span', 'rm-journey-meta');
      when.textContent = ref.observedAt ? formatDateTime(ref.observedAt) : '';
      headLine.append(who, when);
      const id = element('code', 'rm-journey-message-id');
      id.textContent = ref.messageId;
      const text = element('p');
      const bits = [];
      if (ref.summary) bits.push(ref.summary);
      if (ref.direction) bits.push(journeyDirectionText(ref.direction));
      text.textContent = bits.join(' · ') || '事件没有保存消息摘要。';
      copy.append(headLine, id, text);
      const action = element('button', 'rm-journey-action');
      action.type = 'button';
      action.dataset.journeyLocatePeer = ref.peerId;
      action.dataset.journeyLocateMessage = ref.messageId;
      action.dataset.journeyLocateEvent = String(ref.sequence);
      action.dataset.focusKey = `journey-evidence:${session.id}:${ref.sequence}:${ref.messageId}`;
      action.textContent = '核对当前保留消息';
      const check = checkFor(ref.peerId, ref.messageId);
      const result = element('p', 'rm-journey-check');
      if (check) {
        result.dataset.tone = check.tone || '';
        result.textContent = check.text;
      } else {
        result.textContent = '尚未核对；只会在当前保留消息中找到同一条 ID 时打开会话。';
      }
      const rowActions = element('div', 'rm-journey-evidence-actions');
      rowActions.append(action);
      row.append(copy, rowActions, result);
      list.append(row);
    }
    messageSection.append(list);
  }
  node.append(messageSection);

  // Source and read scope stay collapsed for a successful read. Technical
  // diagnostics live here rather than in the title or the route line.
  const sourceDetails = element('details', 'rm-journey-source');
  const sourceSummary = element('summary');
  sourceSummary.textContent = '来源与读取范围';
  sourceDetails.append(sourceSummary);
  const eventVisited = visited.filter((item) => item.source === 'event').map((item) => item.peerId);
  const sourceRows = [
    ['记录标识', session.id],
    ['记录状态', `${status.recordLabel || status.label}${session.state?.status ? `（${session.state.status}）` : ''}`],
    ['模式原文', session.state?.mode || ''],
    ['开始', formatDateTime(session.state?.startedAt)],
    ['最后保存', formatDateTime(session.state?.updatedAt)],
    ['完成时间', formatDateTime(session.state?.completedAt)],
    ['结束原因', session.state?.completionReason || ''],
    ['当前对象完整 ID', session.state?.currentPeerId || ''],
    ['访问对象完整 ID', (session.state?.visitedPeerIds || []).join('\n')],
    ['完成访问事件补充', eventVisited.join('\n')],
    ['发现来源', (session.state?.discoverySources || []).join('、')],
    ['任务说明原文', session.state?.intent || ''],
    ['state.json', session.stateRead === 'available' ? '已读取' : (session.stateRead === 'missing' ? '不存在' : '读取失败')],
    ['events.jsonl', session.eventsRead === 'available' ? `已读取 ${events.length} 条${session.eventsTruncated ? '（达到展示上限，仍有更多）' : ''}` : (session.eventsRead === 'missing' ? '不存在' : `读取失败：${session.eventsError}`)],
    ['report.md', session.reportRead === 'available' ? '已读取（Agent 生成摘要）' : (session.reportRead === 'missing' ? '不存在' : `读取失败：${session.reportError}`)],
  ];
  if (scope) {
    sourceRows.push(['本次读取范围', scope.text]);
    if (scope.truncated) sourceRows.push(['保留范围提示', '本机还有更早的 Journey 目录未在本次读取中列出。']);
  }
  sourceDetails.append(factRows(doc, sourceRows));
  if (status.note.length > 0) {
    const note = element('p', 'rm-list-note');
    note.textContent = `状态说明：${status.note}`;
    sourceDetails.append(note);
  }
  if (session.stateError) {
    const failed = element('p', 'rm-journey-check');
    failed.dataset.tone = 'error';
    failed.textContent = `state.json 无法解析：${session.stateError}。下面只展示仍可读取的事件与报告。`;
    sourceDetails.append(failed);
  }
  const sourceCaveat = element('p', 'rm-list-note');
  sourceCaveat.textContent = '路线只来自本机 state.json 的访问字段与已完成访问事件；不是对端在线、成功访问或阅读回执的证明。';
  sourceDetails.append(sourceCaveat);
  const sourceNote = element('p', 'rm-list-note');
  sourceNote.textContent = '来源是本机 agent/sessions 下的私有记录；不会从远端补造事件，也不会把报告当成传输证据。';
  sourceDetails.append(sourceNote);
  node.append(sourceDetails);

  if (session.reportRead === 'available' && session.reportMarkdown.trim().length > 0) {
    const report = element('details', 'rm-journey-report');
    const reportSummary = element('summary');
    reportSummary.textContent = '完整 Agent 报告（摘要，不是传输证据）';
    const body = element('div', 'rm-rich-text');
    renderMarkdown(body, session.reportMarkdown);
    report.append(reportSummary, body);
    node.append(report);
  } else if (session.reportRead === 'error') {
    const failed = element('p', 'rm-list-note');
    failed.textContent = `report.md 读取失败：${session.reportError}`;
    node.append(failed);
  }

  node.hidden = false;
  if (firstHighlightElement(node) && highlightFocus) {
    const target = firstHighlightElement(node);
    target.scrollIntoView?.({ block: 'center' });
    target.focus?.({ preventScroll: true });
  }
  void source;
}

function firstHighlightElement(node) {
  return node.__journeyHighlight ?? null;
}
