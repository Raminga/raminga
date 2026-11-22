// Agent-led home hero and secondary human strip.
// Pure DOM/model code over already-read public data; no fake Agent identity.
import { formatDateTime } from '../content.js';

const DEFAULT_AGENT_NAME = '我的 Agent';
const SVG_NS = 'http://www.w3.org/2000/svg';
const INTEREST_ICONS = [
  'M12 3.2 13.8 8.7 19.3 10.5 13.8 12.3 12 17.8 10.2 12.3 4.7 10.5 10.2 8.7Z',
  'M7.5 8h9A4.5 4.5 0 0 1 21 12.5v.8a3.2 3.2 0 0 1-5.6 2.1L14 14h-4l-1.4 1.4A3.2 3.2 0 0 1 3 13.3v-.8A4.5 4.5 0 0 1 7.5 8ZM8 11v2M7 12h2M16 12h.01',
  'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5ZM5 17.5h14M8.5 7h7',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNameLine(markdown) {
  const line = String(markdown ?? '').split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? '';
  return line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
}

function excerpt(markdown, limit = 180) {
  return String(markdown ?? '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function initialGlyph(value) {
  return Array.from(text(value) || '?')[0] ?? '?';
}

function incompleteProfileSummary(card, bio, interests) {
  const missing = [];
  if (!text(card.displayName)) missing.push('名称');
  if (!bio) missing.push('简介');
  if (interests.length === 0) missing.push('兴趣');
  if (!text(card.conversationStyle)) missing.push('公开交流风格');
  return missing.length > 0 ? `公开档案还缺${missing.join('、')}。` : '';
}

function hasHumanIntroduction(profile, publicProfile) {
  // profile.json v2 human fields are explicit human data. Even the literal
  // name "关联人类" or an avatar-only human is real published content; only the
  // generated legacy/index.md default heading without any v2 human field is a
  // placeholder.
  const v2Human = Boolean(publicProfile)
    && Boolean(
      text(publicProfile?.humanName)
      || text(publicProfile?.humanAvatarPath)
      || text(publicProfile?.humanBioMarkdown),
    );
  if (v2Human) return true;
  const legacyMarkdown = profile?.state === 'available' ? profile.markdown : '';
  const legacyHeading = text(profile?.displayName) || firstNameLine(legacyMarkdown);
  const legacyBio = excerpt(legacyMarkdown, 400);
  // The daemon writes a default "# 关联人类" index.md even when no human data
  // was published. That placeholder is public file content, not a human
  // introduction, so it must not be presented as one. A real old profile with
  // a different heading or a body remains visible.
  return Boolean(legacyHeading && legacyHeading !== '关联人类') || legacyBio.length > 0;
}

function interestIcon(doc, index) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'rm-home-tag-icon');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', INTEREST_ICONS[index % INTEREST_ICONS.length]);
  svg.append(path);
  return svg;
}

/** Build the Agent hero exclusively from the public Agent card. The human
 * profile is kept in its own strip and is never substituted for Agent data. */
export function buildHomeAgentModel({ mine = null, error = '', capable = true } = {}) {
  const cardRead = mine?.agentCard ?? null;
  const card = cardRead?.state === 'available' ? cardRead.card : null;
  const profile = mine?.profile ?? null;
  const publicProfile = mine?.publicProfile?.state === 'available' ? mine.publicProfile.profile : null;
  const readError = text(error) || text(mine?.error);
  const snapshotAt = Number(mine?.at);
  const hasSnapshot = Number.isFinite(snapshotAt) && snapshotAt > 0;
  // A failed first read is not "no profile"; a failed refresh keeps the last
  // verified snapshot and says so explicitly.
  const firstReadFailed = Boolean(readError && !hasSnapshot);
  const refreshFailed = Boolean(mine !== null && readError && hasSnapshot);
  const staleText = refreshFailed
    ? `这是 ${formatDateTime(snapshotAt)} 的上次成功读取；最近一次刷新失败，公开资料可能不是最新。`
    : '';
  const humanAvailable = hasHumanIntroduction(profile, publicProfile);
  let bio = '';
  let source = '';
  if (card) {
    bio = text(card.description);
    source = `本机公开资料${card.updatedAt ? ` · 更新于 ${formatDateTime(card.updatedAt)}` : ''}`;
  } else if (firstReadFailed) {
    bio = '公开 Agent 档案这次没有读到。';
    source = '本机公开资料读取失败';
  } else if (refreshFailed) {
    bio = '上次成功读取时还没有公开 Agent 档案。';
    source = '本机公开资料刷新失败';
  } else if (cardRead?.state === 'error') {
    bio = '公开资料这次没有读到。';
    source = '本机公开资料读取失败';
  } else if (mine === null) {
    bio = capable ? '正在读取公开 Agent 档案…' : '当前宿主没有提供公开 Agent 档案读取。';
  }
  const interests = Array.isArray(card?.interests) ? card.interests.filter((item) => text(item)).slice(0, 5) : [];
  const incomplete = card ? incompleteProfileSummary(card, bio, interests) : '';
  const profileNotice = card
    ? [staleText, incomplete].filter(Boolean).join(' ')
    : firstReadFailed
      ? '读取公开 Agent 档案失败；这不表示没有公开档案，可以重试读取。'
      : refreshFailed
        ? '上次成功读取时还没有公开 Agent 档案；最近一次刷新失败，不能据此确认当前状态。'
        : cardRead?.state === 'missing'
          ? '还没有公开档案。补充名称、简介、兴趣和交流风格后，来访者才能认识你的 Agent。'
          : cardRead?.state === 'error'
            ? '公开资料这次没有读到；这不表示没有公开档案，可以重试读取。'
            : '';
  const humanName = humanAvailable
    ? (text(publicProfile?.humanName) || text(profile?.displayName) || firstNameLine(profile?.markdown) || '关联人类')
    : '关联人类';
  let humanNote = '';
  if (!humanAvailable) {
    if (mine === null) humanNote = capable ? '正在读取本机公开人类资料…' : '当前宿主没有提供本机公开资料读取。';
    else if (firstReadFailed) humanNote = '人类公开介绍这次没有读到；这不表示没有公开人类介绍。';
    else if (refreshFailed) humanNote = '上次成功读取时还没有公开人类介绍；最近一次刷新失败。';
    else if (profile?.state === 'error') humanNote = '人类公开介绍这次没有读到。';
    else if (profile?.state === 'available' || publicProfile) humanNote = '还没有公开人类介绍。';
    else humanNote = '还没有公开人类介绍。';
  }
  return {
    name: card ? text(card.displayName) || DEFAULT_AGENT_NAME : DEFAULT_AGENT_NAME,
    bio,
    interests,
    style: text(card?.conversationStyle),
    profileNotice,
    source,
    empty: !card && !firstReadFailed && !refreshFailed,
    needsRetry: Boolean(capable && (firstReadFailed || refreshFailed || (!hasSnapshot && cardRead?.state === 'error'))),
    stale: refreshFailed,
    staleText,
    avatarInitial: initialGlyph(card ? text(card.displayName) || DEFAULT_AGENT_NAME : DEFAULT_AGENT_NAME),
    avatarUrl: '',
    avatarPath: text(card?.avatarPath),
    avatarSha256: text(card?.avatarSha256),
    avatarMime: text(card?.avatarMime),
    legacyFallback: card?.legacyFallback === true,
    human: {
      name: humanName,
      markdown: humanAvailable ? (profile?.state === 'available' ? profile.markdown : publicProfile?.humanBioMarkdown || '') : '',
      available: humanAvailable,
      note: humanNote,
      excerpt: humanAvailable ? (excerpt(profile?.state === 'available' ? profile.markdown : publicProfile?.humanBioMarkdown) || '公开档案没有正文。') : '',
      avatarUrl: '',
      avatarPath: humanAvailable ? text(publicProfile?.humanAvatarPath) : '',
      avatarSha256: humanAvailable ? text(publicProfile?.humanAvatarSha256) : '',
      avatarMime: humanAvailable ? text(publicProfile?.humanAvatarMime) : '',
      avatarInitial: initialGlyph(humanName),
    },
  };
}

/** Update the Agent hero in place. */
export function renderHomeAgent(doc, nodes, model) {
  if (!nodes) return;
  const {
    avatar, initial, name, badge, bio, interests, style, source, notice, noticeText, statusText, statusDot,
  } = nodes;
  if (name) name.textContent = model.name;
  if (badge) badge.textContent = '我的 Agent';
  if (bio) {
    bio.textContent = model.bio;
    bio.hidden = model.bio.length === 0;
  }
  if (interests) {
    interests.replaceChildren();
    model.interests.forEach((item, index) => {
      const span = doc.createElement('span');
      span.className = 'rm-home-tag';
      span.append(interestIcon(doc, index));
      const label = doc.createElement('span');
      label.className = 'rm-home-tag-label';
      label.textContent = item;
      span.append(label);
      interests.append(span);
    });
    interests.hidden = model.interests.length === 0;
  }
  if (style) {
    style.textContent = model.style ? `公开交流风格 · ${model.style}` : '';
    style.hidden = model.style.length === 0;
  }
  if (notice) notice.hidden = model.profileNotice.length === 0;
  if (noticeText) noticeText.textContent = model.profileNotice;
  if (source) {
    // Source paths and timestamps stay out of the first screen; the settings
    // surface owns the technical detail. Keep the node inert if a host still
    // provides it.
    source.textContent = '';
    source.hidden = true;
  }
  if (statusText) statusText.textContent = model.statusText;
  if (statusDot) statusDot.dataset.tone = model.statusTone;
  if (avatar) {
    const image = avatar.querySelector('img');
    const hasAvatar = model.avatarUrl.length > 0;
    if (image) {
      if (hasAvatar) {
        image.src = model.avatarUrl;
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }
    if (initial) {
      initial.textContent = model.avatarInitial;
      initial.hidden = hasAvatar;
    }
    avatar.dataset.empty = hasAvatar ? 'false' : 'true';
    avatar.setAttribute('aria-label', hasAvatar ? `${model.name} 的 Agent 形象` : `尚未设置 ${model.name} 的 Agent 形象`);
  }
}

/** Update the secondary human strip. */
export function renderHomeHuman(doc, nodes, model) {
  if (!nodes) return;
  const human = model.human;
  if (nodes.title) {
    nodes.title.textContent = human.available && human.name && human.name !== '关联人类'
      ? `关联人类 · ${human.name}`
      : '关联人类';
  }
  if (nodes.summary) {
    nodes.summary.textContent = human.available
      ? (human.excerpt || '公开档案没有正文。')
      : human.note;
  }
  if (nodes.profile) {
    nodes.profile.replaceChildren();
    nodes.profile.hidden = true;
  }
  if (nodes.avatar) {
    const hasAvatar = human.avatarUrl.length > 0;
    if (hasAvatar) {
      nodes.avatar.src = human.avatarUrl;
      nodes.avatar.hidden = false;
    } else {
      nodes.avatar.src = 'assets/raminga-mark-gradient.svg';
      nodes.avatar.hidden = true;
    }
    const mark = nodes.avatar.parentElement ?? null;
    const fallback = mark?.querySelector('svg') ?? null;
    if (fallback) fallback.hidden = hasAvatar;
    if (mark) mark.dataset.empty = hasAvatar ? 'false' : 'true';
  }
}
