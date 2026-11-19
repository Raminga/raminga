// Home activity strip: real Agent tool calls first, Journey records only as a
// clearly labelled fallback. A saved Journey `running`/`current_peer_id` is
// never treated as proof that a tool is visiting a Peer right now.
import {
  formatDateTime, journeySessionTitle, journeyStatusText, journeyTimeText,
} from '../content.js';

const TOOL_LABELS = {
  raminga_status: '读取节点状态',
  raminga_friends: '读取联系人',
  raminga_published: '读取本机公开文件',
  raminga_peer_profile: '查看对方公开资料',
  raminga_peer_manifest: '读取对方公开清单',
  raminga_peer_friends: '读取对方通讯录',
  raminga_content_get: '下载公开内容',
  raminga_connect: '连接 Peer',
  raminga_connect_listed: '连接通讯录中的 Peer',
  raminga_chat_send: '发送消息',
  raminga_chat_history: '读取最近消息',
  raminga_agent_init: '初始化私有 Agent 数据',
};

const RESULT_LABELS = {
  ok: { label: '完成', tone: 'done' },
  error: { label: '失败', tone: 'error' },
  timeout: { label: '超时', tone: 'unavailable' },
  interrupted: { label: '已中断', tone: 'unavailable' },
  unknown: { label: '结果未知', tone: 'unavailable' },
};

const MATCH_LABELS = {
  current_peer: '目标与本机 running Journey 的当前对象一致',
  visited_peer: '目标在该 Journey 的访问列表中',
  active_journey: '本机有一个 running Journey；仅表示关联，不代表已访问',
  none: '没有可关联的 Journey',
  ambiguous: '有多个 running Journey，未猜测关联',
};

const PEER_TOOLS = new Set(['raminga_peer_profile', 'raminga_peer_manifest', 'raminga_peer_friends', 'raminga_content_get', 'raminga_connect', 'raminga_connect_listed']);
const CHAT_TOOLS = new Set(['raminga_chat_send']);
const MSG_TOOLS = new Set(['raminga_chat_history']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function element(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function toolLabel(tool) {
  return TOOL_LABELS[tool] || 'raminga 工具';
}

function shortPeer(peerId) {
  const value = text(peerId);
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

function parseTime(value) {
  const at = Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? at : 0;
}

function relativeTime(value, now) {
  const at = parseTime(value);
  if (at === 0) return '时间未记录';
  const diff = Math.max(0, now - at);
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
  return formatDateTime(value);
}

function resultMeta(result) {
  return RESULT_LABELS[result] || { label: '结果未知', tone: 'unavailable' };
}

function latestSession(sessions) {
  const list = Array.isArray(sessions) ? sessions.filter((session) => session && session.state) : [];
  if (list.length === 0) return null;
  return [...list].sort((left, right) => {
    const leftTime = Date.parse(left.state.updatedAt || left.state.startedAt || '') || Number(left.dirModifiedAt) || 0;
    const rightTime = Date.parse(right.state.updatedAt || right.state.startedAt || '') || Number(right.dirModifiedAt) || 0;
    return rightTime - leftTime;
  })[0];
}

function runningSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((session) => session?.state?.status === 'running');
}

function sessionExists(journey, sessionId) {
  if (!sessionId) return false;
  const list = Array.isArray(journey?.sessions) ? journey.sessions : [];
  return list.some((session) => session?.id === sessionId);
}

function operationState(operation) {
  if (!operation) return 'unknown';
  if (operation.state === 'running' || operation.result === null || operation.result === undefined) return 'running';
  return text(operation.result) || 'unknown';
}

function sortOperations(operations) {
  return [...operations].sort((left, right) => {
    const time = parseTime(left.startedAt) - parseTime(right.startedAt);
    if (time !== 0) return time;
    return String(left.operationId).localeCompare(String(right.operationId));
  });
}

function targetPeer(operation) {
  return text(operation?.target?.peer_id) || text(operation?.evidence?.peer_id);
}

function targetPath(operation) {
  return text(operation?.target?.path) || text(operation?.evidence?.path);
}

function operationTarget(operation, { journey, peerLabel }) {
  if (!operation) return { kind: 'none' };
  const peer = targetPeer(operation);
  const journeyId = text(operation.journeyId);
  const journeyMissing = journeyId.length > 0 && journey !== null && !sessionExists(journey, journeyId);
  if (journeyId) {
    // A deleted Journey is still the explicit association. Returning only the
    // peer would hide the missing record and silently change the click target.
    return {
      kind: 'journey',
      journeyId,
      peerId: peer,
      path: targetPath(operation),
      journeyMissing,
      label: journeyMissing ? `Journey ${journeyId}（记录已不在本机）` : `Journey ${journeyId}`,
    };
  }
  if (peer) {
    return {
      kind: CHAT_TOOLS.has(operation.tool) || MSG_TOOLS.has(operation.tool) ? 'messages' : 'peer',
      peerId: peer,
      path: targetPath(operation),
      label: peerLabel(peer),
    };
  }
  return { kind: 'none' };
}

function operationSummary(operation, { peerLabel, now }) {
  const peer = targetPeer(operation);
  const path = targetPath(operation);
  const result = operationState(operation);
  const parts = [];
  if (result === 'running') {
    parts.push(`开始于 ${relativeTime(operation.startedAt, now)}`);
  } else {
    parts.push(`${resultMeta(result).label}${operation.endedAt ? ` · ${relativeTime(operation.endedAt, now)}` : ''}`);
  }
  if (peer) parts.push(peerLabel(peer));
  if (path) parts.push(path);
  if (operation.errorSummary) parts.push(operation.errorSummary);
  return parts.filter(Boolean).join(' · ');
}

/** Backward-compatible P1/P2 Journey-only strip for hosts without activity. */
function buildJourneyFallback({ journey, error, capable }) {
  const sessions = Array.isArray(journey?.sessions) ? journey.sessions : [];
  const latest = latestSession(sessions);
  if (latest) {
    const status = journeyStatusText(latest.state);
    const pending = status.label === '待确认';
    const recorded = journeyTimeText(latest);
    const facts = [recorded ? `最后保存 ${recorded}` : '最后保存时间未记录'];
    facts.push(pending ? '状态待确认' : `记录状态 ${status.label}`);
    return {
      kind: 'recent',
      title: `最近记录：${journeySessionTitle(latest)}`,
      body: facts.join(' · '),
      meta: recorded,
      statusText: `最近记录 · ${pending ? '待确认' : status.label}`,
      statusTone: 'recent',
      statusLabel: pending ? '待确认' : status.label,
      pending,
      session: latest,
      operation: null,
      empty: false,
      target: { kind: 'journey', journeyId: latest.id },
      showDetail: true,
      history: [],
      journeyMissing: false,
      instanceId: '',
      operations: [],
      fallback: true,
    };
  }
  if (journey?.state === 'error' || error) {
    return {
      kind: 'unavailable',
      title: '这次没有读到活动记录',
      body: error || journey?.sessionsError || 'Agent 活动记录读取失败。',
      meta: '',
      statusText: '活动记录读取失败',
      statusTone: 'unavailable',
      statusLabel: '读取失败',
      pending: false,
      session: null,
      operation: null,
      empty: false,
      target: { kind: 'none' },
      showDetail: false,
      history: [],
      journeyMissing: false,
      instanceId: '',
      operations: [],
      fallback: true,
    };
  }
  return {
    kind: 'empty',
    title: '暂无活动记录',
    body: journey === null
      ? (capable ? '正在读取本机 Agent 活动记录…' : '当前宿主没有提供 Agent 活动记录读取。')
      : '本机记录中还没有 Agent 活动。',
    meta: '',
    statusText: '暂无活动记录',
    statusTone: 'unknown',
    statusLabel: '暂无记录',
    pending: false,
    session: null,
    operation: null,
    empty: true,
    target: { kind: 'none' },
    showDetail: false,
    history: [],
    journeyMissing: false,
    instanceId: '',
    operations: [],
    fallback: true,
  };
}

/**
 * Build the home strip from real tool activity first. The caller can pass
 * `activityCapable=false` to preserve the P1 Journey-only fallback for older
 * hosts. `activityError` means the newest read failed: the previous snapshot
 * must not remain displayed as live.
 */
export function buildHomeActivity({
  activity = null,
  activityCapable = false,
  activityError = '',
  journey = null,
  journeyError = '',
  capable = true,
  now = Date.now(),
  peerLabel = (peerId) => shortPeer(peerId),
  previousInstanceId = '',
} = {}) {
  if (!activityCapable) {
    return buildJourneyFallback({ journey, error: journeyError, capable });
  }

  const sessions = Array.isArray(journey?.sessions) ? journey.sessions : [];
  const running = runningSessions(sessions);
  const latest = latestSession(sessions);
  const readError = text(activityError) || text(activity?.error);
  if (readError) {
    return {
      kind: 'unavailable',
      title: 'Raminga 工具活动读取失败',
      body: `${readError}。不会把上次读取的运行中状态当作现在；下方 Journey 记录只来自 agent/sessions，不是工具调用日志。`,
      meta: '',
      statusText: '工具活动读取失败',
      statusTone: 'unavailable',
      statusLabel: '读取失败',
      pending: false,
      session: null,
      operation: null,
      empty: false,
      target: { kind: 'none' },
      showDetail: false,
      history: [],
      journeyMissing: false,
      instanceId: text(activity?.instanceId),
      operations: [],
      activityError: readError,
    };
  }

  if (activity === null || typeof activity !== 'object') {
    return {
      kind: 'loading',
      title: '正在读取 Agent 工具活动…',
      body: '只读取本机 agent/activity.jsonl；不会把 Journey 摘要当成工具调用。',
      meta: '',
      statusText: '正在读取工具活动',
      statusTone: 'unknown',
      statusLabel: '读取中',
      pending: false,
      session: null,
      operation: null,
      empty: false,
      target: { kind: 'none' },
      showDetail: false,
      history: [],
      journeyMissing: false,
      instanceId: '',
      operations: [],
      activityError: '',
    };
  }

  const instanceId = text(activity.instanceId);
  const all = Array.isArray(activity.operations) ? activity.operations.filter((operation) => operation && operation.operationId) : [];
  const current = sortOperations(all.filter((operation) => instanceId.length === 0 || text(operation.pluginInstanceId) === instanceId));
  const history = [...all].sort((left, right) => parseTime(right.startedAt) - parseTime(left.startedAt)).map((operation) => ({
    ...operation,
    historical: instanceId.length > 0 && text(operation.pluginInstanceId) !== instanceId,
  }));
  const runningOps = current.filter((operation) => operationState(operation) === 'running');
  const finished = current.filter((operation) => operationState(operation) !== 'running');
  const instanceChanged = Boolean(previousInstanceId && instanceId && previousInstanceId !== instanceId);
  const extraNote = [
    activity.truncated ? '只读取了最近的一部分工具调用记录。' : '',
    instanceChanged ? '插件实例已更换；旧实例的运行中状态已失效，旧记录只在详情历史中标注“上次实例”。' : '',
    (activity.badLines || 0) > 0 ? `日志中有 ${activity.badLines} 行无法解析，已跳过。` : '',
  ].filter(Boolean).join(' ');

  const base = {
    instanceId,
    operations: current,
    history,
    activityError: '',
    pending: false,
    journeyMissing: false,
  };

  if (runningOps.length > 0) {
    const operation = runningOps[runningOps.length - 1];
    const peer = targetPeer(operation);
    const path = targetPath(operation);
    const target = operationTarget(operation, { journey, peerLabel });
    const title = peer && PEER_TOOLS.has(operation.tool)
      ? `正在访问：${peerLabel(peer)}`
      : CHAT_TOOLS.has(operation.tool) && peer
        ? `正在与 ${peerLabel(peer)} 沟通`
        : `正在执行：${toolLabel(operation.tool)}`;
    const body = [
      `${toolLabel(operation.tool)} · 开始于 ${relativeTime(operation.startedAt, now)}`,
      path,
      runningOps.length > 1 ? `另有 ${runningOps.length - 1} 个工具调用正在执行` : '',
      extraNote,
    ].filter(Boolean).join(' · ');
    return {
      ...base,
      kind: 'running',
      title,
      body,
      meta: relativeTime(operation.startedAt, now),
      statusText: '正在执行工具调用',
      statusTone: 'live',
      statusLabel: '进行中',
      operation,
      session: null,
      empty: false,
      target,
      showDetail: true,
      journeyMatchText: MATCH_LABELS[operation.journeyMatch] || '',
    };
  }

  if (finished.length > 0) {
    const operation = finished[finished.length - 1];
    const result = operationState(operation);
    const meta = resultMeta(result);
    const target = operationTarget(operation, { journey, peerLabel });
    const title = `最近活动 · ${relativeTime(operation.endedAt || operation.startedAt, now)}`;
    const body = [
      toolLabel(operation.tool),
      operationSummary(operation, { peerLabel, now }),
      extraNote,
    ].filter(Boolean).join(' · ');
    return {
      ...base,
      kind: 'recent',
      title,
      body,
      meta: `${meta.label} · ${relativeTime(operation.endedAt || operation.startedAt, now)}`,
      statusText: `最近工具活动 · ${meta.label}`,
      statusTone: result === 'ok' ? 'recent' : 'unavailable',
      statusLabel: meta.label,
      operation,
      session: null,
      empty: false,
      target,
      showDetail: true,
      journeyMatchText: MATCH_LABELS[operation.journeyMatch] || '',
    };
  }

  // No tool activity for this plugin instance. A Journey state is displayed
  // only as a record, never as a live visit or a running tool.
  if (running.length > 0) {
    const session = latest && running.includes(latest) ? latest : running[0];
    const currentPeer = text(session.state?.currentPeerId);
    const body = [
      `Journey 文件仍标记为 running，但没有正在执行的 Raminga 工具调用。`,
      currentPeer ? `记录中的当前对象：${peerLabel(currentPeer)}；这只是 Journey 字段，不是工具访问证据。` : '',
      running.length > 1 ? `共有 ${running.length} 个 running Journey，未自动选择其中一个作为访问事实。` : '',
      extraNote,
    ].filter(Boolean).join(' ');
    return {
      ...base,
      kind: 'journey-live',
      title: 'Journey 进行中',
      body,
      meta: relativeTime(session.state?.updatedAt || session.state?.startedAt, now),
      statusText: 'Journey 进行中',
      statusTone: 'live',
      statusLabel: '进行中',
      operation: null,
      session,
      empty: false,
      target: { kind: 'journey', journeyId: session.id },
      showDetail: true,
      journeyMatchText: '',
    };
  }

  if (latest && latest.state?.status === 'paused') {
    return {
      ...base,
      kind: 'journey-paused',
      title: '最近一次 Journey 已暂停',
      body: `Journey 文件本身标记为 paused；没有正在执行的 Raminga 工具调用。${extraNote ? ` ${extraNote}` : ''}`,
      meta: relativeTime(latest.state.updatedAt || latest.state.startedAt, now),
      statusText: '最近 Journey 已暂停',
      statusTone: 'unavailable',
      statusLabel: '已暂停',
      operation: null,
      session: latest,
      empty: false,
      target: { kind: 'journey', journeyId: latest.id },
      showDetail: true,
      journeyMatchText: '',
    };
  }

  const activityNote = instanceChanged
    ? '当前插件实例还没有工具调用；旧实例记录只在详情历史中。'
    : instanceId && history.length > 0
      ? '当前插件实例还没有工具调用；旧实例记录只在详情历史中。'
      : '没有记录到正在执行或最近完成的 Raminga 工具调用；这不等于 Agent 未运行。';
  return {
    ...base,
    kind: 'empty',
    title: '暂无工具活动',
    body: [activityNote, activity.truncated ? '只读取了最近的一部分工具调用记录。' : '', journey?.state === 'error' ? `Journey 记录本次未读到：${journey.sessionsError || journeyError || '读取失败'}` : ''].filter(Boolean).join(' '),
    meta: '',
    statusText: '暂无工具活动记录',
    statusTone: 'unknown',
    statusLabel: '暂无记录',
    operation: null,
    session: null,
    empty: true,
    target: { kind: 'none' },
    showDetail: history.length > 0,
    journeyMatchText: '',
  };
}

function renderCard(doc, node, activity, { live = false } = {}) {
  if (!node) return;
  node.replaceChildren();
  node.className = live ? 'rm-home-live-journey live-journey' : 'rm-home-live-journey';
  node.dataset.activityKind = activity.kind;
  if (activity.operation?.operationId) node.dataset.activityOperation = activity.operation.operationId;
  else delete node.dataset.activityOperation;
  const orb = element(doc, 'span', 'rm-home-live-orb');
  orb.setAttribute('aria-hidden', 'true');
  const copy = element(doc, 'span', 'rm-home-live-copy');
  const title = element(doc, 'b');
  title.textContent = activity.title;
  const body = element(doc, 'p');
  body.textContent = activity.body;
  copy.append(title, body);
  const status = element(doc, 'span', 'rm-journey-status');
  status.dataset.tone = activity.statusTone || 'unknown';
  status.textContent = activity.statusLabel;
  const arrow = element(doc, 'span', 'rm-home-live-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';
  node.append(orb, copy, status, arrow);
  node.hidden = false;
  node.disabled = false;
  node.setAttribute('aria-expanded', 'false');
  node.setAttribute('aria-controls', 'homeActivityDetail');
  node.setAttribute('aria-label', `${activity.title}。${activity.target?.kind && activity.target.kind !== 'none' ? '打开对应证据' : '打开详情'}`);
}

function renderEmpty(doc, node, activity) {
  if (!node) return;
  node.replaceChildren();
  const mark = element(doc, 'span', 'rm-home-empty-mark');
  mark.setAttribute('aria-hidden', 'true');
  const copy = element(doc, 'div');
  const title = element(doc, 'b');
  title.textContent = activity.title;
  const body = element(doc, 'p');
  body.textContent = activity.body;
  copy.append(title, body);
  node.append(mark, copy);
  node.hidden = false;
  node.dataset.tone = activity.kind === 'unavailable' ? 'error' : '';
}

/** Render the single merged activity card (never a second "visiting" card). */
export function renderHomeActivity(doc, nodes, activity) {
  if (!nodes) return;
  const { live, recent, empty, detail, toggle } = nodes;
  if (live) {
    live.replaceChildren();
    live.hidden = true;
    live.disabled = false;
  }
  if (recent) {
    recent.replaceChildren();
    recent.hidden = true;
    recent.disabled = false;
  }
  if (activity.kind === 'running' || activity.kind === 'journey-live' || activity.kind === 'journey-paused') {
    renderCard(doc, live ?? recent, activity, { live: true });
  } else if (activity.kind === 'recent') {
    renderCard(doc, recent ?? live, activity, { live: false });
  } else if (activity.kind === 'unavailable' && activity.fallback) {
    renderCard(doc, recent ?? live, activity, { live: false });
  } else if (activity.kind === 'unavailable' || activity.kind === 'loading' || activity.kind === 'empty') {
    if (empty) renderEmpty(doc, empty, activity);
    else if (recent) renderCard(doc, recent, activity, { live: false });
  }
  const emptyKinds = activity.kind === 'unavailable' || activity.kind === 'loading' || activity.kind === 'empty';
  if (empty) empty.hidden = !emptyKinds || (activity.fallback === true && activity.kind === 'unavailable');
  if (detail) {
    detail.replaceChildren();
    detail.hidden = true;
  }
  if (toggle) {
    toggle.hidden = !activity.showDetail;
    toggle.disabled = !activity.showDetail;
    toggle.textContent = activity.showDetail ? '查看详情' : '暂无详情';
  }
}

function factList(doc, rows) {
  const dl = element(doc, 'dl', 'rm-journey-facts');
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = element(doc, 'div');
    const key = element(doc, 'dt');
    key.textContent = label;
    const val = element(doc, 'dd');
    val.textContent = value;
    row.append(key, val);
    dl.append(row);
  }
  return dl;
}

function action(doc, labelText, dataset) {
  const button = element(doc, 'button', 'rm-journey-action');
  button.type = 'button';
  button.textContent = labelText;
  for (const [key, value] of Object.entries(dataset)) button.dataset[key] = value;
  return button;
}

function resultTone(result) {
  return resultMeta(result).tone;
}

/**
 * Render one operation's sanitized evidence, route, source and the explicit
 * history of tool calls. Agent-generated Journey summaries stay separate.
 */
export function renderActivityDetail(doc, node, activity, detail = null, options = {}) {
  if (!node) return;
  node.replaceChildren();
  const { loading = false, error = '', now = Date.now(), peerLabel = (peerId) => shortPeer(peerId), currentInstanceId = '' } = options;
  const operation = detail?.operation || activity.operation || null;
  const label = element(doc, 'p', 'rm-eyebrow');
  label.textContent = 'FACT · LOCAL TOOL RECORD';
  const heading = element(doc, 'h3');
  heading.textContent = '本机工具调用记录';
  const note = element(doc, 'p', 'rm-list-note');
  note.textContent = '来自私有 agent/activity.jsonl；这是本机工具调用记录，不是传输证据，也不是远端投递、阅读或访问成功的证明。';
  node.append(label, heading, note);
  if (error) {
    const failure = element(doc, 'p', 'rm-journey-check');
    failure.dataset.tone = 'error';
    failure.textContent = error;
    node.append(failure);
  }
  if (loading) {
    const loadingNode = element(doc, 'p', 'rm-list-note');
    loadingNode.textContent = '正在读取操作证据…';
    node.append(loadingNode);
  }
  if (operation) {
    const result = operationState(operation);
    const meta = resultMeta(result);
    const facts = factList(doc, [
      ['工具', toolLabel(operation.tool)],
      ['工具名', operation.tool],
      ['目标类型', operation.targetType],
      ['结果', result === 'running' ? '进行中' : `${meta.label}${operation.result ? `（${operation.result}）` : ''}`],
      ['开始', formatDateTime(operation.startedAt)],
      ['结束', operation.endedAt ? formatDateTime(operation.endedAt) : '仍未记录终态'],
      ['操作 ID', operation.operationId],
      ['插件实例', operation.pluginInstanceId],
      ['面板会话', operation.panelSessionId || '无面板'],
      ['Journey 关联', operation.journeyId ? `${operation.journeyId}（${operation.journeyMatch}）` : (operation.journeyMatch || 'none')],
    ]);
    if (operation.pluginInstanceId && currentInstanceId && operation.pluginInstanceId !== currentInstanceId) {
      const row = element(doc, 'div');
      const key = element(doc, 'dt');
      key.textContent = '实例状态';
      const val = element(doc, 'dd');
      val.textContent = '上次实例（不是当前运行态）';
      row.append(key, val);
      facts.append(row);
    }
    node.append(facts);
    if (operation.journeyMatch) {
      const match = element(doc, 'p', 'rm-list-note');
      match.textContent = `关联依据：${MATCH_LABELS[operation.journeyMatch] || operation.journeyMatch}。关联不等于访问或成功。`;
      node.append(match);
    }
    if (operation.errorCode || operation.errorSummary) {
      const failure = element(doc, 'div', 'rm-journey-evidence');
      const failureTitle = element(doc, 'b');
      failureTitle.textContent = '记录的错误信息';
      const failureBody = element(doc, 'p');
      failureBody.textContent = [operation.errorCode, operation.errorSummary].filter(Boolean).join(' · ');
      failure.append(failureTitle, failureBody);
      node.append(failure);
    }

    const evidence = detail?.evidence || operation.evidence || {};
    const peer = text(evidence.peer_id) || targetPeer(operation);
    const publicPath = text(evidence.path) || targetPath(operation);
    const routeRows = [
      ['Peer', peer],
      ['公开内容', publicPath],
      ['内容版本 SHA-256', evidence.sha256 || ''],
      ['发现记录 ID', evidence.discovery_id ? String(evidence.discovery_id) : ''],
      ['内容状态', evidence.content_state || ''],
      ['清单生成时间', evidence.manifest_generated_at_unix_ms ? formatDateTime(evidence.manifest_generated_at_unix_ms) : ''],
      ['消息 ID', (evidence.message_ids || []).join('、')],
    ];
    const routeHeading = element(doc, 'h3');
    routeHeading.textContent = '路由与证据摘要';
    node.append(routeHeading, factList(doc, routeRows));

    const journey = detail?.journey || null;
    if (operation.journeyId) {
      const journeyHeading = element(doc, 'h3');
      journeyHeading.textContent = 'Journey 关联';
      const journeyNote = element(doc, 'p', 'rm-list-note');
      if (journey?.exists === true) {
        journeyNote.textContent = `Journey ${operation.journeyId} 仍在本机：状态 ${journey.status || '未记录'}，更新于 ${formatDateTime(journey.updatedAt) || '未记录'}。`;
      } else if (journey?.exists === false) {
        journeyNote.textContent = '关联的 Journey 记录已不在本机。仍可按下面的 Peer 证据回退，不静默改成“无关联”。';
      } else {
        journeyNote.textContent = '正在核对关联的 Journey 记录。';
      }
      node.append(journeyHeading, journeyNote);
    }
    // The Peer fallback must exist independently of a Journey association:
    // "no associated Journey" is not "no evidence target".
    if (peer) {
      const actions = element(doc, 'div', 'rm-journey-actions');
      if (operation.journeyId && journey?.exists === true) {
        actions.append(action(doc, '打开 Journey 并高亮', { activityJourney: operation.journeyId }));
      }
      actions.append(action(doc, '查看相关对象', { activityPeer: peer }));
      node.append(actions);
    } else if (!operation.journeyId && detail?.missingReason) {
      const missing = element(doc, 'p', 'rm-journey-check');
      missing.dataset.tone = 'unavailable';
      missing.textContent = detail.missingReason;
      node.append(missing);
    }

    if ((evidence.message_ids || []).length > 0) {
      const messageHeading = element(doc, 'h3');
      messageHeading.textContent = '消息证据';
      const messageNote = element(doc, 'p', 'rm-list-note');
      messageNote.textContent = '消息 ID 是工具返回的引用，不是阅读回执，也不证明对方已回复。';
      node.append(messageHeading, messageNote);
      const actions = element(doc, 'div', 'rm-journey-actions');
      for (const messageId of evidence.message_ids.slice(0, 10)) {
        const code = element(doc, 'code', '');
        code.textContent = messageId;
        actions.append(code);
        if (peer) {
          actions.append(action(doc, '核对当前保留消息', { activityLocatePeer: peer, activityLocateMessage: messageId }));
        }
      }
      if (peer) actions.append(action(doc, '打开相关会话', { activityChat: peer }));
      node.append(actions);
    } else if (operation.tool === 'raminga_chat_history' || operation.tool === 'raminga_chat_send') {
      const messageNote = element(doc, 'p', 'rm-list-note');
      messageNote.textContent = '这次记录没有消息 ID 证据，不能据此声称消息已送达或已回复。';
      node.append(messageNote);
    }

    const sourceHeading = element(doc, 'h3');
    sourceHeading.textContent = '来源';
    const source = element(doc, 'p', 'rm-list-note');
    source.textContent = '本机私有活动日志；只记录 raminga_* 工具执行，不记录聊天正文、资料正文、草稿正文、token 或绝对路径。';
    node.append(sourceHeading, source);
  } else if (detail && !loading) {
    const missing = element(doc, 'p', 'rm-journey-check');
    missing.dataset.tone = 'unavailable';
    missing.textContent = detail.missingReason || '本机没有找到这条工具调用记录。';
    node.append(missing);
  }

  if (Array.isArray(activity.history) && activity.history.length > 0) {
    const historyHeading = element(doc, 'h3');
    historyHeading.textContent = '工具调用历史';
    const historyNote = element(doc, 'p', 'rm-list-note');
    historyNote.textContent = '按开始时间排列；旧插件实例只在这里标“上次实例”，不进入当前活动卡。';
    const list = element(doc, 'ul', 'rm-activity-history');
    for (const item of activity.history.slice(0, 30)) {
      const row = element(doc, 'li');
      const button = element(doc, 'button', 'rm-activity-history-row');
      button.type = 'button';
      button.dataset.activityHistory = item.operationId;
      if (operation?.operationId === item.operationId) button.setAttribute('aria-current', 'true');
      const time = element(doc, 'span', 'rm-journey-meta');
      time.textContent = `${formatDateTime(item.startedAt) || '时间未记录'} · ${relativeTime(item.startedAt, now)}`;
      const title = element(doc, 'b');
      title.textContent = `${toolLabel(item.tool)} · ${resultMeta(operationState(item)).label}${item.historical ? ' · 上次实例' : ''}`;
      button.append(time, title);
      row.append(button);
      list.append(row);
    }
    node.append(historyHeading, historyNote, list);
  }
  node.hidden = false;
}

export { toolLabel, operationTarget, relativeTime, resultMeta };
