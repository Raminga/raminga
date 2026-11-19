// Pure presentation helpers for the private contact-memory timeline.
//
// Everything here is derived from values the host actually returned. It never
// fetches, invents a date or turns a public clue into a visit. Grouping uses
// the local calendar day of persisted timestamps only; records without a valid
// timestamp go into an explicit "日期未知" bucket.

export const MEMORY_PREVIEW_CHARS = 140;
export const MEMORY_GROUP_PAGE = 12;
const MEMORY_EVIDENCE_PREFIX = 'profile-evidence:';

export function memoryBody(item) {
  const body = typeof item?.body === 'string' ? item.body : '';
  if (body.length > 0) return body;
  return typeof item?.summary === 'string' ? item.summary : '';
}

export function memoryPreview(value, limit = MEMORY_PREVIEW_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('')}…`;
}

/** One local validity check for every persisted timestamp in this view. */
export function memoryDateValue(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function memoryDayKey(at) {
  const date = memoryDateValue(at);
  if (!date) return 'unknown';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A stable return key for one source button. The timeline item id and message
 * id are encoded separately so a message cited by a real chat row and by two
 * Journey events still returns to the exact event, not merely the first row
 * that happens to mention the same message.
 */
export function memoryEvidenceFocusKey(peerId, itemId, messageId) {
  const peer = typeof peerId === 'string' ? peerId : '';
  const message = typeof messageId === 'string' ? messageId : '';
  if (!peer || !message) return '';
  const item = typeof itemId === 'string' ? itemId : '';
  if (!item) return `${MEMORY_EVIDENCE_PREFIX}${peer}:${message}`;
  return `${MEMORY_EVIDENCE_PREFIX}${peer}:${encodeURIComponent(item)}:${encodeURIComponent(message)}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function previousLocalDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime();
}

function localDateText(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function shortDate(date) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long', day: 'numeric', weekday: 'short',
    }).format(date);
  } catch {
    return localDateText(date);
  }
}

function longDate(target, current) {
  const includeYear = target.getFullYear() !== current.getFullYear();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      ...(includeYear ? { year: 'numeric' } : {}),
      month: 'long', day: 'numeric', weekday: 'short',
    }).format(target);
  } catch {
    return localDateText(target);
  }
}

/** A day heading with an honest unknown-date fallback. */
export function memoryDayLabel(at, now = Date.now()) {
  const target = memoryDateValue(at);
  if (!target) return '日期未知';
  const current = memoryDateValue(now) ?? new Date();
  const targetDay = startOfLocalDay(target);
  const today = startOfLocalDay(current);
  if (targetDay === today) return `今天 · ${shortDate(target)}`;
  // Compare local calendar days instead of subtracting a fixed 24 hours:
  // daylight-saving transitions make the previous local day 23 or 25 hours.
  if (targetDay === previousLocalDayStart(current)) return `昨天 · ${shortDate(target)}`;
  return longDate(target, current);
}

/** Classify one timeline item without upgrading observations into facts. */
export function memorySourceKind(item) {
  const explicit = typeof item?.sourceKind === 'string' ? item.sourceKind : '';
  if (explicit === 'message' || explicit === 'visit' || explicit === 'journeyEvent'
    || explicit === 'journeyReport' || explicit === 'publicClue') {
    return explicit;
  }
  switch (String(item?.kind ?? '')) {
    case 'message': return 'message';
    case 'journey': return 'journeyEvent';
    case 'observation': return 'observation';
    case 'impression': return 'impression';
    case 'curiosity': return 'curiosity';
    default: return 'journeyEvent';
  }
}

export function memoryKindLabel(item) {
  const source = memorySourceKind(item);
  if (source === 'message') return '消息';
  if (source === 'visit') {
    const type = String(item?.eventType ?? '').toLowerCase();
    if (type === 'visit_started') return '访问开始';
    if (type === 'content_read') return '读取公开内容';
    return '实际访问';
  }
  if (source === 'journeyReport') return '漫游报告';
  if (source === 'publicClue') return '公开线索';
  if (source === 'journeyEvent') return '漫游事件';
  if (source === 'observation') return '私有观察';
  if (source === 'impression') return '私有印象';
  if (source === 'curiosity') return '私有好奇';
  return '记录';
}

/** The reason a clue stays a claim; it is never rendered as a contact. */
export function isPublicClue(item) {
  return memorySourceKind(item) === 'publicClue';
}

function groupKeyFor(item) {
  const source = memorySourceKind(item);
  const day = memoryDayKey(item?.at);
  if (source === 'message') return `messages:${day}`;
  if (source === 'publicClue') return `clues:${day}`;
  if (source === 'observation' || source === 'impression' || source === 'curiosity') {
    return `private:${day}`;
  }
  const sessionId = Array.isArray(item?.evidence?.sessionIds) ? String(item.evidence.sessionIds[0] ?? '') : '';
  return `journey:${sessionId || 'unknown'}:${day}`;
}

function groupTitle(items) {
  const kinds = new Set(items.map((item) => memorySourceKind(item)));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === 'message') return '对话片段';
    if (only === 'publicClue') return '公开线索';
    if (only === 'observation' || only === 'impression' || only === 'curiosity') return '私有记忆';
  }
  if ([...kinds].every((kind) => kind === 'journeyEvent' || kind === 'journeyReport' || kind === 'visit')) {
    return '漫游记录';
  }
  return '交互记录';
}

function groupNote(items) {
  const kinds = new Set(items.map((item) => memorySourceKind(item)));
  if (kinds.has('publicClue')) return '线索只是来源声明，不等于已访问或已联系';
  if ([...kinds].every((kind) => kind === 'observation' || kind === 'impression' || kind === 'curiosity')) {
    return '仅本机可见，不是聊天证据';
  }
  if (kinds.has('journeyReport')) return '报告是摘要，原文在漫游详情';
  if ([...kinds].every((kind) => kind === 'journeyEvent' || kind === 'journeyReport' || kind === 'visit')) {
    return '来自本机 Journey 记录';
  }
  return '';
}

/**
 * Group newest-first timeline items into local calendar days and then into
 * conversation/private-memory/Journey groups. No item is copied, invented or
 * dropped by this function.
 */
export function groupContactMemory(items, { now = Date.now() } = {}) {
  const list = Array.isArray(items) ? [...items] : [];
  list.sort((left, right) => {
    const at = Number(left?.at) > 0 ? Number(left.at) : 0;
    const bt = Number(right?.at) > 0 ? Number(right.at) : 0;
    if (at !== bt) return bt - at;
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
  const dayMap = new Map();
  for (const item of list) {
    const key = memoryDayKey(item?.at);
    if (!dayMap.has(key)) {
      dayMap.set(key, {
        key,
        at: key === 'unknown' ? 0 : Math.max(0, Number(item?.at) || 0),
        label: memoryDayLabel(item?.at, now),
        items: [],
        groups: [],
      });
    }
    const day = dayMap.get(key);
    day.items.push(item);
    if (key !== 'unknown') day.at = Math.max(day.at, Number(item?.at) || 0);
  }
  const days = [...dayMap.values()].sort((left, right) => {
    if (left.key === 'unknown') return 1;
    if (right.key === 'unknown') return -1;
    return right.at - left.at;
  });
  for (const day of days) {
    const map = new Map();
    for (const item of day.items) {
      const key = groupKeyFor(item);
      if (!map.has(key)) {
        map.set(key, {
          key,
          day: day.key,
          at: Number(item?.at) > 0 ? Number(item.at) : 0,
          items: [],
          title: '',
          note: '',
        });
      }
      const group = map.get(key);
      group.items.push(item);
      group.at = Math.max(group.at, Number(item?.at) || 0);
    }
    day.groups = [...map.values()].sort((left, right) => {
      if (right.at !== left.at) return right.at - left.at;
      return left.key.localeCompare(right.key);
    });
    for (const group of day.groups) {
      group.items.sort((left, right) => {
        const at = Number(left?.at) > 0 ? Number(left.at) : 0;
        const bt = Number(right?.at) > 0 ? Number(right.at) : 0;
        if (at !== bt) return bt - at;
        return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
      });
      group.title = groupTitle(group.items);
      group.note = groupNote(group.items);
    }
  }
  return { days, total: list.length };
}

/** Counts and a readable range for the first-screen summary. */
export function summarizeContactMemory(grouped, { now = Date.now() } = {}) {
  const counts = {
    message: 0, visit: 0, visitStarted: 0, contentRead: 0, journeyEvent: 0, journeyReport: 0,
    publicClue: 0, observation: 0, impression: 0, curiosity: 0, privateMemory: 0,
  };
  let earliest = 0;
  let latest = 0;
  let unknown = 0;
  const days = Array.isArray(grouped?.days) ? grouped.days : [];
  for (const day of days) {
    for (const item of day.items) {
      const date = memoryDateValue(item?.at);
      if (date) {
        const at = date.getTime();
        if (earliest === 0 || at < earliest) earliest = at;
        if (at > latest) latest = at;
      } else {
        unknown += 1;
      }
      const source = memorySourceKind(item);
      if (source === 'message') counts.message += 1;
      else if (source === 'publicClue') counts.publicClue += 1;
      else if (source === 'journeyReport') counts.journeyReport += 1;
      else if (source === 'visit') {
        const type = String(item?.eventType ?? '').toLowerCase();
        if (type === 'content_read') counts.contentRead += 1;
        else if (type === 'visit_started') counts.visitStarted += 1;
        else counts.visit += 1;
      } else if (source === 'journeyEvent') counts.journeyEvent += 1;
      else if (source === 'observation') counts.observation += 1;
      else if (source === 'impression') counts.impression += 1;
      else if (source === 'curiosity') counts.curiosity += 1;
    }
  }
  counts.privateMemory = counts.observation + counts.impression + counts.curiosity;
  const order = [
    ['message', '消息'], ['visit', '实际访问'], ['contentRead', '读取内容'],
    ['journeyEvent', '漫游事件'], ['journeyReport', '报告'], ['publicClue', '公开线索'],
    ['privateMemory', '私有记忆'],
  ];
  const chips = order
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => ({ key, label, count: counts[key] }));
  const dated = days.filter((day) => day.key !== 'unknown');
  return {
    total: days.reduce((sum, day) => sum + day.items.length, 0),
    counts,
    chips,
    earliest,
    latest,
    unknown,
    firstLabel: dated.length > 0 ? memoryDayLabel(earliest, now) : '',
    lastLabel: dated.length > 0 ? memoryDayLabel(latest, now) : '',
  };
}
