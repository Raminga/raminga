// Shared contact presentation and connect/share result interpretation.
//
// These helpers are deliberately host-agnostic. They only describe values the
// host already fetched from the daemon (ListFriends + Status) and never turn a
// failed or stale read into an empty list.
import { formatRelative, shortPeer } from './node-status.js';

const CONNECTION_TEXT = {
  connected: '已连接',
  disconnected: '未连接',
  unknown: '未知',
};

/** Text for one normalized contact connection state. */
export function connectionStateText(value) {
  return CONNECTION_TEXT[value] ?? CONNECTION_TEXT.unknown;
}

/** Local name first; never claim a remote identity when only an ID exists. */
export function contactDisplayName(friend) {
  const name = typeof friend?.name === 'string' ? friend.name.trim() : '';
  if (name.length > 0) return name;
  return shortPeer(friend?.peerId);
}

export function contactInitial(friend) {
  const name = typeof friend?.name === 'string' ? friend.name.trim() : '';
  const source = name.length > 0 ? name : String(friend?.peerId ?? '');
  const first = [...source][0];
  return first ? first.toUpperCase() : '?';
}

/** Search only fields that actually exist locally: name, note and Peer ID. */
export function filterContacts(friends, query) {
  const list = Array.isArray(friends) ? friends : [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length === 0) return list;
  return list.filter((friend) => {
    const peerId = String(friend?.peerId ?? '').toLowerCase();
    const name = String(friend?.name ?? '').toLowerCase();
    const description = String(friend?.description ?? '').toLowerCase();
    return peerId.includes(needle) || name.includes(needle) || description.includes(needle);
  });
}

/**
 * Resolve the contacts page state. A read error with retained rows is shown
 * as stale data plus a retry, not as an empty list; an empty array is only
 * "empty" after a successful read.
 */
export function contactListState(contacts, query, transportError = null) {
  const source = contacts && typeof contacts === 'object' ? contacts : {};
  const friends = Array.isArray(source.friends) ? source.friends : [];
  const error = typeof transportError === 'string' && transportError.length > 0
    ? transportError
    : (typeof source.error === 'string' ? source.error : '');
  const clearing = String(query ?? '').trim().length > 0;
  if (friends.length === 0) {
    if (source.freshness === 'loading' || (!source.at && !error)) return { kind: 'loading', friends: [] };
    if (error.length > 0 || source.freshness === 'unavailable') {
      return {
        kind: 'error',
        friends: [],
        error: error || '这次没有读到联系人列表。',
        stale: true,
        at: Number(source.at) > 0 ? Number(source.at) : 0,
      };
    }
    return {
      kind: 'empty',
      friends: [],
      stale: source.freshness !== 'live',
      error,
      at: Number(source.at) > 0 ? Number(source.at) : 0,
    };
  }
  const matches = filterContacts(friends, query);
  return {
    kind: matches.length === 0 && clearing ? 'search-empty' : 'ready',
    friends: matches,
    all: friends,
    stale: source.freshness !== 'live',
    error,
    at: Number(source.at) > 0 ? Number(source.at) : 0,
  };
}

/** Stale/error banner for a list that still has usable rows. */
export function contactsStaleText(contacts, transportError = null, now = Date.now()) {
  const source = contacts && typeof contacts === 'object' ? contacts : {};
  const error = typeof transportError === 'string' && transportError.length > 0
    ? transportError
    : (typeof source.error === 'string' ? source.error : '');
  const at = Number(source.at) > 0 ? Number(source.at) : 0;
  const time = at > 0 ? formatRelative(at, now) : '较早';
  if (error.length > 0) return `列表可能不是最新（${time}读取）。最近一次刷新失败，可以重试。`;
  if (source.freshness !== 'live') return `列表可能不是最新（${time}读取）。实时更新恢复后会自动刷新。`;
  return '';
}

/**
 * Failed-read text for an empty list. When there was an earlier successful
 * empty snapshot, keep its read time and make clear that it does not prove the
 * current list is empty; with no snapshot at all, never equate failure to an
 * empty list.
 */
export function contactsReadErrorText(contacts, now = Date.now()) {
  const source = contacts && typeof contacts === 'object' ? contacts : {};
  const at = Number(source.at) > 0 ? Number(source.at) : 0;
  if (at > 0) {
    return `上次成功读取：${formatRelative(at, now)}，当时没有联系人；这不代表现在也没有。最近一次读取失败，请稍后重试。`;
  }
  return '联系人列表暂时读取失败。这不代表联系人列表为空，请稍后重试。';
}

/**
 * Stale/error text for an old empty read. "No contacts at that time" must not
 * be rendered as "there are no contacts now": the read time, the interrupted
 * refresh and the retry affordance all stay visible.
 */
export function contactsEmptyStaleText(contacts, transportError = null, now = Date.now()) {
  const source = contacts && typeof contacts === 'object' ? contacts : {};
  const error = typeof transportError === 'string' && transportError.length > 0
    ? transportError
    : (typeof source.error === 'string' ? source.error : '');
  const at = Number(source.at) > 0 ? Number(source.at) : 0;
  const time = at > 0 ? formatRelative(at, now) : '时间未知';
  const reason = error.length > 0 ? '最近一次刷新失败。' : '实时更新已中断。';
  return `上次成功读取：${time}，当时没有联系人；这不代表现在也没有。${reason}重试读取后才能确认最新列表。`;
}

export function routeLabel(route) {
  const value = String(route ?? '').toLowerCase();
  if (value === 'direct') return '直连';
  if (value === 'relay') return '中继';
  return '已连接';
}

/**
 * Interpretation of one host connect result. The contact-list outcome is
 * kept separate from the successful dial: recordFriend can fail while the
 * connection remains established.
 */
export function connectOutcome(result) {
  if (!result || typeof result !== 'object') {
    return {
      tone: 'error',
      title: '连接没有完成',
      body: '没有收到节点的连接结果，请稍后重试。',
      detail: '',
      showRetry: true,
      showViewContacts: false,
      showCheck: false,
    };
  }
  if (!result.ok) {
    if (result.invalid) {
      return {
        tone: 'invalid',
        title: '输入需要调整',
        body: String(result.error || '请输入 Peer ID 或包含目标节点的完整地址。'),
        detail: '',
        showRetry: false,
        showViewContacts: false,
        showCheck: false,
      };
    }
    return {
      tone: 'error',
      title: '连接没有完成',
      body: '这次没有建立连接。输入已经保留，你可以检查后重试。',
      detail: String(result.error || '节点没有返回可读的错误。'),
      showRetry: true,
      showViewContacts: false,
      showCheck: false,
    };
  }

  const route = routeLabel(result.route);
  const reused = result.reused === true;
  const pieces = [reused ? `已复用现有${route}连接，没有重复建立。` : `已建立${route}连接。`];
  if (result.transport) pieces.push(`传输 ${String(result.transport).toUpperCase()}。`);
  if (result.note) pieces.push(String(result.note));

  const contact = result.contact && typeof result.contact === 'object' ? result.contact : {};
  let contactNote = '';
  let showCheck = false;
  let showViewContacts = false;
  const details = [];
  if (contact.ok !== true) {
    contactNote = '连接已建立，但联系人列表刷新失败。可以重试核对。';
    if (contact.error) details.push(`联系人列表：${contact.error}`);
    showCheck = true;
  } else if (contact.found !== true) {
    contactNote = '连接已建立，但联系人尚未保存。节点可能稍后才写入，请重试核对。';
    showCheck = true;
  } else {
    contactNote = '联系人已更新。';
    showViewContacts = true;
  }
  const statusFailed = result.status && result.status.ok === false;
  if (statusFailed) {
    details.push(`节点状态：${result.status.error || '暂时无法读取'}`);
  }
  return {
    tone: contact.ok === true && contact.found === true ? 'success' : 'partial',
    title: reused ? '连接成功（已复用）' : '连接成功',
    body: pieces.join(' '),
    contactNote,
    statusNote: statusFailed ? '连接已建立，但节点状态刷新也失败了。' : '',
    detail: details.join('\n'),
    showRetry: false,
    showViewContacts,
    showCheck,
  };
}

/** Re-check result after a successful connection whose friend write lagged. */
export function contactCheckOutcome(result) {
  if (!result || result.ok !== true) {
    return {
      tone: 'error',
      title: '暂时无法核对联系人',
      body: '这次没有读到联系人列表，请稍后再试。',
      detail: String(result?.error || ''),
      showViewContacts: false,
    };
  }
  if (result.found === true) {
    return {
      tone: 'success',
      title: '联系人已保存',
      body: '目标节点已经在联系人列表中。',
      detail: '',
      showViewContacts: true,
    };
  }
  return {
    tone: 'partial',
    title: '联系人仍未保存',
    body: '连接仍然有效，但联系人列表里还没有这个节点。你可以稍后再核对。',
    detail: String(result.error || ''),
    showViewContacts: false,
  };
}

export function addressScopeText(address) {
  if (address?.kind === 'relay') {
    return address?.scope === 'private' ? '中继 · 局域网' : '中继';
  }
  return address?.scope === 'private' ? '局域网直连' : '公网直连';
}

/**
 * Complete text for the copy action. It contains only the full local Peer ID
 * and shareable addresses, never a token, path or other host credential.
 */
export function shareText(share) {
  const peerId = typeof share?.peerId === 'string' ? share.peerId : '';
  if (peerId.length === 0) return '';
  const lines = ['Raminga 节点', `Peer ID：${peerId}`];
  const addresses = Array.isArray(share?.addresses) ? share.addresses : [];
  if (addresses.length > 0) {
    lines.push('可尝试连接的地址：');
    for (const address of addresses) {
      lines.push(`- ${address.multiaddr}（${addressScopeText(address)}）`);
    }
  } else {
    lines.push('当前没有可直接分享的地址；可以只分享 Peer ID。');
  }
  return lines.join('\n');
}
