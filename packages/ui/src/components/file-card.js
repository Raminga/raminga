// Public-file card rendering shared by discovery, peer profile and own files.
// Pure DOM construction; the caller owns preview state, focus and host actions.
import { acquisitionSourcesLabel, acquisitionTone, contentStateText, fileKindLabel, formatBytes, previewStatusText } from '../public-files.js';
import { formatDateTime, shortPeerText } from '../content.js';
import { postImageKey, renderPostMedia } from './post-images.js';

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
export function previewKeyFor(subject, item) {
  return `${subject}:${item.peerId}:${item.path}:${item.sha256}`;
}

export function revealResultKey(subject, item) {
  return subject === 'explore'
    ? `explore:${item.id}`
    : `${subject}:${item.path}:${item.sha256}`;
}


export function sourceDetails({ rows, note, focusKey = '', actions = [] }, { sourceOpen = {}, save = () => {} } = {}) {
  const details = element('details', 'rm-source-details');
  const summary = element('summary', 'rm-source-summary');
  summary.textContent = '来源详情';
  if (focusKey) summary.dataset.focusKey = focusKey;
  const body = element('div', 'rm-source-body');
  const facts = element('dl', 'rm-source-facts');
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = element('div', 'rm-source-fact');
    const term = element('dt');
    term.textContent = label;
    const detail = element('dd');
    detail.textContent = value;
    row.append(term, detail);
    facts.append(row);
  }
  if (facts.childElementCount > 0) body.append(facts);
  if (note) {
    const noteEl = element('p', 'rm-source-note');
    noteEl.textContent = note;
    body.append(noteEl);
  }
  if (actions.length > 0) {
    const actionBar = element('div', 'rm-source-actions');
    for (const action of actions) actionBar.append(action);
    body.append(actionBar);
  }
  details.append(summary, body);
  return details;
}

/** Local-copy locating belongs with source evidence, not in the main reading
 * actions. The control stays disabled whenever the copy cannot be located. */
function revealControl(item, { onReveal = null, focusKey = '' } = {}) {
  const button = element('button', 'rm-quiet rm-file-reveal');
  button.type = 'button';
  button.textContent = '在文件夹中显示';
  button.disabled = ['not-downloaded', 'copy-missing', 'hash-mismatch', 'unreadable'].includes(item.contentState);
  const blocked = button.disabled ? contentStateText(item.contentState, item.contentError) : '';
  button.title = blocked;
  button.onclick = () => { if (!button.disabled) void onReveal?.(item); };
  if (focusKey) button.dataset.focusKey = `${focusKey}:reveal`;
  return button;
}

export function previewFeedback(preview, item, { renderMarkdown = () => {} } = {}) {
  const box = element('div', 'rm-file-preview');
  if (preview?.state === 'loading') {
    const note = element('p', 'rm-list-note');
    note.textContent = '正在读取并核对本地副本…';
    box.append(note);
    return box;
  }
  if (preview?.state === 'error') {
    const note = element('p', 'rm-list-note');
    note.textContent = `这次没有读到公开内容：${preview.error}`;
    box.append(note);
    return box;
  }
  const data = preview?.data;
  if (!data) {
    const note = element('p', 'rm-list-note');
    note.textContent = '尚未读取内容。';
    box.append(note);
    return box;
  }
  // Older host shapes returned a parsed post without the generic preview
  // fields. Keep them readable while the bridge upgrades.
  const kind = data.kind || (data.post ? 'markdown' : '');
  const status = data.status || (data.ok === false ? 'error' : 'ok');
  const text = data.text ?? data.post?.bodyMarkdown ?? '';
  if (status !== 'ok' && status !== 'resource-error') {
    const note = element('p', 'rm-list-note');
    note.textContent = `${previewStatusText(status)}：${data.error || '无法显示预览。'}`;
    box.append(note);
    if (data.localCopy === 'available') {
      const local = element('p', 'rm-list-note');
      local.textContent = '原件已保存在本机；可用卡片上的“在文件夹中显示”定位，不会打开或导出文件。';
      box.append(local);
    }
    return box;
  }
  if (kind === 'markdown') {
    const content = element('div', 'rm-rich-text');
    renderMarkdown(content, text);
    box.append(content);
  } else if (kind === 'text' || kind === 'code' || kind === 'json') {
    const pre = element('pre', 'rm-file-text');
    const code = element('code');
    code.textContent = text;
    pre.append(code);
    box.append(pre);
  } else if (kind === 'image') {
    const image = element('img', 'rm-file-image');
    image.src = data.dataUrl;
    image.alt = data.title || item.title || item.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    box.append(image);
  } else if (kind === 'audio') {
    const audio = element('audio', 'rm-file-media');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = data.dataUrl;
    box.append(audio);
  } else if (kind === 'video') {
    const video = element('video', 'rm-file-media rm-file-video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = data.dataUrl;
    box.append(video);
  } else if (kind === 'html' && data.html) {
    const frame = element('iframe', 'rm-html-frame');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', `沙箱预览：${data.title || item.title || item.name}`);
    frame.loading = 'lazy';
    frame.srcdoc = data.html;
    box.append(frame);
    const note = element('p', 'rm-list-note');
    note.textContent = 'HTML 在无脚本、无同源权限、无外部网络访问的沙箱中显示；包内相对资源已尝试离线内联。';
    box.append(note);
  } else {
    const note = element('p', 'rm-list-note');
    note.textContent = '该格式当前没有可用的内联预览。';
    box.append(note);
  }
  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    const warnings = element('ul', 'rm-file-warnings');
    for (const warning of data.warnings.slice(0, 10)) {
      const li = element('li');
      li.textContent = warning;
      warnings.append(li);
    }
    box.append(warnings);
  }
  if (Array.isArray(data.missingResources) && data.missingResources.length > 0) {
    const note = element('p', 'rm-list-note');
    note.textContent = `缺少包内关联文件：${data.missingResources.slice(0, 12).join('、')}。单文件 HTML 不会自动下载这些文件。`;
    box.append(note);
  }
  if (data.discoveryError) {
    const note = element('p', 'rm-list-note');
    note.textContent = `已读取文件，但本机发现索引没有记录成功：${data.discoveryError}。这不影响阅读，来源可能不完整。`;
    box.append(note);
  }
  if (data.error) {
    const note = element('p', 'rm-list-note');
    note.textContent = data.error;
    box.append(note);
  }
  if (data.acquisition === 'local-copy') {
    const note = element('p', 'rm-list-note');
    note.textContent = '本次读取使用本机已核对副本；没有发起新的网络下载。';
    box.append(note);
  } else if (data.acquisition === 'downloaded') {
    const note = element('p', 'rm-list-note');
    note.textContent = '本次已从对方节点手动获取并核对原件。';
    box.append(note);
  }
  return box;
}

function publicSourceRows(item) {
  const author = String(item.authorName ?? '').trim();
  return [
    ['发布节点', item.peerId],
    ['发布节点公开名', item.publisherName],
    ['原作者声明', author
      ? `${item.authorKind === 'agent' ? 'Agent' : item.authorKind === 'user' ? '用户' : '未注明类型'}署名 · ${author}`
      : '未声明（按发布节点公开名显示）'],
    ['发表时间', item.publishedAt ? formatDateTime(item.publishedAt) : ''],
    ['获取方式', acquisitionSourcesLabel(item.sources, item.source)],
    ['来源标识', (item.sources ?? [item.source]).filter(Boolean).join('、')],
    ['获取时间', item.fetchedAt > 0 ? formatDateTime(item.fetchedAt) : ''],
    ['文件更新时间', item.modifiedAt > 0 ? formatDateTime(item.modifiedAt) : ''],
    ['公共路径', item.path],
    ['内容版本', item.sha256],
    ['大小', formatBytes(item.sizeBytes)],
    ['文件类型', fileKindLabel(item.kind, item.mime)],
    ['本地副本', contentStateText(item.contentState, item.contentError) || '可用'],
  ];
}


export function renderPublicFileCard(rawItem, {
  subject,
  expanded,
  onToggle,
  preview,
  showReveal = false,
  reveal = null,
  onReveal = null,
  focusKey = '',
  onOpenProfile = null,
  onOpenPost = null,
  onRetry = null,
  edit = null,
  favorite = null,
  onFavorite = null,
  sourceOpen = {},
  save = () => {},
  renderMarkdown = () => {},
  imageStateFor = () => ({ state: 'idle' }),
  onImageAction = null,
  retainImage = null,
}) {
  const previewData = preview?.state === 'available' ? preview.data : null;
  const previewLocal = previewData?.localCopy === 'available';
  const item = previewData ? {
    ...rawItem,
    title: previewData.title || rawItem.title,
    summary: previewData.post?.summary || rawItem.summary,
    authorKind: previewData.post?.authorKind || rawItem.authorKind,
    authorName: previewData.post?.authorName || rawItem.authorName,
    contentState: previewLocal ? 'available' : rawItem.contentState,
    contentError: previewLocal ? '' : rawItem.contentError,
  } : rawItem;
  const previewImages = Array.isArray(previewData?.post?.images)
    ? previewData.post.images.map((image) => ({
      ...image,
      publicPath: rawItem.path.replace(/\/post\.json$/, '') + '/' + image.path,
    }))
    : [];
  const images = Array.isArray(item.images) && item.images.length > 0 ? item.images : previewImages;
  const article = element('article', `rm-post rm-file-card${subject === 'mine' ? ' rm-own-post' : ''}`);
  article.dataset.fileCard = previewKeyFor(subject, item);
  const opensDetail = typeof onOpenPost === 'function';
  const header = element('header', 'rm-post-head');
  const avatar = element(onOpenProfile ? 'button' : 'span', 'rm-contact-avatar rm-post-avatar');
  if (onOpenProfile) {
    avatar.type = 'button';
    avatar.dataset.profilePeer = item.peerId;
    avatar.dataset.profileRef = `${subject}:${item.id || item.path}`;
    avatar.setAttribute('aria-label', `查看 ${item.publisherName || shortPeerText(item.peerId)} 的个人首页`);
  } else {
    avatar.setAttribute('aria-hidden', 'true');
  }
  avatar.textContent = (item.publisherName || shortPeerText(item.peerId) || '?').slice(0, 1);
  const copy = element('div', 'rm-post-author');
  const name = element(onOpenProfile ? 'button' : 'b', 'rm-post-name');
  if (onOpenProfile) {
    name.type = 'button';
    name.dataset.profilePeer = item.peerId;
    name.dataset.profileRef = `${subject}:${item.id || item.path}`;
    name.setAttribute('aria-label', `查看 ${item.publisherName || shortPeerText(item.peerId)} 的个人首页`);
  }
  name.textContent = item.publisherName || shortPeerText(item.peerId) || '未知发布节点';
  if (subject === 'mine') {
    // Local public content may be signed by the human owner or by the Agent.
    // Only the persisted declaration is shown; unknown stays unknown.
    const kind = item.authorKind === 'agent' ? 'agent' : item.authorKind === 'user' ? 'user' : '';
    const badge = element('span', 'rm-post-author-badge');
    badge.dataset.kind = kind || 'unknown';
    badge.textContent = kind === 'agent' ? 'Agent' : kind === 'user' ? '本人' : '来源未注明';
    copy.append(name, badge);
  } else {
    copy.append(name);
  }
  const meta = element('span', 'rm-post-meta');
  const acquisition = acquisitionSourcesLabel(item.sources, item.source);
  const published = item.publishedAt ? formatDateTime(item.publishedAt) : '';
  // Publication time belongs to the card body; acquisition time, version,
  // file type, size and local copy state stay inside 来源详情.
  meta.textContent = [published ? `发布于 ${published}` : '发表时间未记录', acquisition].join(' · ');
  meta.dataset.tone = acquisitionTone(item.sources);
  copy.append(meta);
  header.append(avatar, copy);
  const localProblem = contentStateText(item.contentState, item.contentError);
  const titleText = item.title || item.name || item.path || localProblem;
  const summaryText = item.summary || (item.contentState === 'available' ? `${item.path}${item.sizeBytes >= 0 ? ` · ${formatBytes(item.sizeBytes)}` : ''}` : '');
  const copyBlock = element('div', 'rm-post-copy');
  if (onOpenPost) {
    // The title and excerpt form one real reading entry. The card body still
    // expands inline where no independent detail is available (peer files).
    const open = element('button', 'rm-post-open');
    open.type = 'button';
    open.dataset.openPost = String(item.id || item.path || '');
    open.setAttribute('aria-label', `查看动态：${titleText}`);
    if (focusKey) open.dataset.focusKey = `${focusKey}:open`;
    const title = element('span', 'rm-post-title');
    title.textContent = titleText;
    open.append(title);
    if (summaryText) {
      const summary = element('span', 'rm-post-summary');
      summary.textContent = summaryText;
      open.append(summary);
    }
    // One reading entry per card. The title, excerpt and visible CTA share the
    // same button, so keyboard users do not get two identical tab stops.
    const cta = element('span', 'rm-post-cta');
    cta.textContent = '查看动态';
    cta.setAttribute('aria-hidden', 'true');
    open.append(cta);
    open.onclick = () => onOpenPost(item, open);
    copyBlock.append(open);
  } else {
    const title = element('h2', 'rm-post-title');
    title.textContent = titleText;
    const summary = element('p', 'rm-post-summary');
    summary.textContent = summaryText;
    copyBlock.append(title, summary);
  }
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    const tags = element('div', 'rm-post-tags');
    for (const tag of item.tags.slice(0, 10)) {
      const chip = element('span', 'rm-post-tag');
      chip.textContent = tag;
      tags.append(chip);
    }
    copyBlock.append(tags);
  }
  const main = element('div', 'rm-post-main');
  main.dataset.hasMedia = images.length > 0 ? 'true' : 'false';
  const media = renderPostMedia(images, {
    variant: 'card',
    subject,
    peerId: item.peerId,
    title: item.title,
    stateFor: imageStateFor,
    retainImage,
  });
  if (media) {
    media.addEventListener('click', (event) => {
      const tile = event.target.closest?.('[data-post-image-key]');
      if (!tile) return;
      event.preventDefault();
      event.stopPropagation();
      onImageAction?.(tile, item, images, 'card');
    });
    main.append(media);
  }
  main.append(copyBlock);
  article.append(header, main);
  if (localProblem) {
    const problem = element('p', 'rm-list-note rm-post-content-state');
    problem.textContent = localProblem;
    article.append(problem);
  }
  const sourceActions = [];
  if (showReveal && opensDetail) {
    sourceActions.push(revealControl(item, { onReveal, focusKey }));
  }
  const details = sourceDetails({
    rows: publicSourceRows(item),
    note: '发布节点公开名与原作者声明分开保留：原作者声明只在本详情中显示；来源记录来自本机，不代表远端签名。',
    focusKey: focusKey ? `${focusKey}:source` : '',
    actions: sourceActions,
  }, { sourceOpen, save });
  const expandedKey = subject === 'explore'
    ? String(item.id || '')
    : `${subject}:${item.id || item.path}:source`;
  details.open = sourceOpen[expandedKey] === true;
  details.ontoggle = () => {
    if (details.open) sourceOpen[expandedKey] = true;
    else delete sourceOpen[expandedKey];
    save();
  };
  const actions = element('div', 'rm-post-actions');
  if (edit) {
    const editButton = element('button', 'rm-quiet rm-post-edit');
    editButton.type = 'button';
    editButton.textContent = '编辑';
    editButton.setAttribute('aria-label', `编辑 ${item.title || item.path}`);
    editButton.onclick = () => edit(item, editButton);
    if (focusKey) editButton.dataset.focusKey = `${focusKey}:edit`;
    actions.append(editButton);
  }
  if (favorite !== null) {
    const star = element('button', 'rm-quiet rm-post-favorite');
    star.type = 'button';
    star.dataset.favoriteKey = favorite.key || '';
    star.setAttribute('aria-pressed', favorite.active ? 'true' : 'false');
    star.setAttribute('aria-label', favorite.active ? `取消收藏 ${item.title || item.path}` : `收藏 ${item.title || item.path}`);
    star.title = favorite.active ? '取消收藏' : '收藏';
    star.disabled = favorite.disabled === true;
    star.dataset.pending = favorite.disabled === true ? 'true' : 'false';
    star.textContent = favorite.active ? '★ 已收藏' : '☆ 收藏';
    star.onclick = () => { if (!star.disabled) void onFavorite?.(item, star); };
    if (focusKey) star.dataset.focusKey = `${focusKey}:favorite`;
    actions.append(star);
  }
  // Cards whose title opens the independent detail do not repeat a second
  // “阅读内容” entry or a main-area “在文件夹中显示” button. Peer/public-file
  // cards that have no detail page keep both controls in the file action row.
  if (!opensDetail) {
    const toggle = element('button', 'rm-quiet rm-post-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const peerNeedsFetch = subject === 'peer' && item.contentState === 'not-downloaded';
    toggle.textContent = expanded
      ? '收起内容'
      : (peerNeedsFetch
        ? '获取原件'
        : (item.previewable === false ? '查看文件信息' : '阅读内容'));
    if (subject === 'explore') toggle.dataset.expandPost = item.id;
    if (focusKey) toggle.dataset.focusKey = `${focusKey}:toggle`;
    toggle.onclick = () => onToggle(!expanded);
    actions.append(toggle);
    if (showReveal) actions.append(revealControl(item, { onReveal, focusKey }));
  }
  article.append(details, actions);
  if (reveal?.state === 'missing' || reveal?.state === 'not-downloaded'
    || reveal?.state === 'hash-mismatch' || reveal?.state === 'unavailable' || reveal?.state === 'error') {
    const note = element('p', 'rm-list-note');
    note.textContent = reveal.message || '无法在文件夹中显示。';
    article.append(note);
  } else if (reveal?.state === 'revealed') {
    const note = element('p', 'rm-list-note');
    note.textContent = '已请求宿主在文件夹中显示本地原件；不会打开、复制或导出文件。';
    article.append(note);
  }
  if (expanded && !opensDetail) {
    const body = element('div', 'rm-post-body');
    if (item.contentState !== 'available' && subject !== 'peer') {
      const failed = element('p', 'rm-list-note');
      failed.textContent = localProblem || '本地副本不可读取。';
      body.append(failed);
    } else {
      const detailMedia = renderPostMedia(images, {
        variant: 'detail',
        subject,
        peerId: item.peerId,
        title: item.title,
        stateFor: imageStateFor,
        retainImage,
      });
      if (detailMedia) {
        detailMedia.addEventListener('click', (event) => {
          const tile = event.target.closest?.('[data-post-image-key]');
          if (!tile) return;
          event.preventDefault();
          event.stopPropagation();
          onImageAction?.(tile, item, images, 'detail');
        });
        body.append(detailMedia);
      }
      body.append(previewFeedback(preview, item, { renderMarkdown }));
      const retryable = preview?.state === 'error'
        || ['error', 'resource-error', 'copy-missing'].includes(previewData?.status) && previewData?.localCopy !== 'available';
      if (retryable && (subject === 'explore' || onRetry)) {
        const retry = element('button', 'rm-list-retry');
        retry.type = 'button';
        if (onRetry) retry.onclick = onRetry;
        else retry.dataset.retryPost = item.id;
        retry.textContent = '重试读取内容';
        body.append(retry);
      }
    }
    article.append(body);
  }
  return article;
}



/** One independent post detail: publisher/author, actual publish time, tags,
 * an image/text split on wide screens (image first on narrow), the verified
 * body, favorite/edit/reveal actions and the same closeable source evidence as
 * a Feed card. The caller owns loading, retries, focus and return state. */
export function renderPostDetail(rawItem, {
  subject = 'explore',
  preview = null,
  favorite = null,
  onFavorite = null,
  edit = null,
  onOpenProfile = null,
  showReveal = false,
  reveal = null,
  onReveal = null,
  sourceOpen = {},
  save = () => {},
  renderMarkdown = () => {},
  imageStateFor = () => ({ state: 'idle' }),
  onImageAction = null,
  retainImage = null,
  fetch = null,
  onFetch = null,
  focusKey = '',
} = {}) {
  const previewData = preview?.state === 'available' ? preview.data : null;
  const previewLocal = previewData?.localCopy === 'available';
  const item = previewData ? {
    ...rawItem,
    title: previewData.title || rawItem.title,
    summary: previewData.post?.summary || rawItem.summary,
    authorKind: previewData.post?.authorKind || rawItem.authorKind,
    authorName: previewData.post?.authorName || rawItem.authorName,
    contentState: previewLocal ? 'available' : rawItem.contentState,
    contentError: previewLocal ? '' : rawItem.contentError,
  } : rawItem;
  const previewImages = Array.isArray(previewData?.post?.images)
    ? previewData.post.images.map((image) => ({
      ...image,
      publicPath: rawItem.path.replace(/\/post\.json$/, '') + '/' + image.path,
    }))
    : [];
  const images = Array.isArray(item.images) && item.images.length > 0 ? item.images : previewImages;

  const article = element('article', 'rm-post-detail rm-post');
  article.dataset.postDetail = String(item.id || item.path || '');
  // A stable focus anchor when an async preview/fetch replaces its own button.
  article.tabIndex = -1;
  article.dataset.detailFocus = 'post-detail';
  const header = element('header', 'rm-post-head');
  const avatar = element(onOpenProfile ? 'button' : 'span', 'rm-contact-avatar rm-post-avatar');
  if (onOpenProfile) {
    avatar.type = 'button';
    avatar.dataset.profilePeer = item.peerId;
    avatar.dataset.profileRef = `${subject}:${item.id || item.path}`;
    avatar.setAttribute('aria-label', `查看 ${item.publisherName || shortPeerText(item.peerId)} 的个人首页`);
  } else {
    avatar.setAttribute('aria-hidden', 'true');
  }
  avatar.textContent = (item.publisherName || shortPeerText(item.peerId) || '?').slice(0, 1);
  const copy = element('div', 'rm-post-author');
  const name = element(onOpenProfile ? 'button' : 'b', 'rm-post-name');
  if (onOpenProfile) {
    name.type = 'button';
    name.dataset.profilePeer = item.peerId;
    name.dataset.profileRef = `${subject}:${item.id || item.path}`;
    name.setAttribute('aria-label', `查看 ${item.publisherName || shortPeerText(item.peerId)} 的个人首页`);
  }
  name.textContent = item.publisherName || shortPeerText(item.peerId) || '未知发布节点';
  if (subject === 'mine') {
    const kind = item.authorKind === 'agent' ? 'agent' : item.authorKind === 'user' ? 'user' : '';
    const badge = element('span', 'rm-post-author-badge');
    badge.dataset.kind = kind || 'unknown';
    badge.textContent = kind === 'agent' ? 'Agent' : kind === 'user' ? '本人' : '来源未注明';
    copy.append(name, badge);
  } else {
    copy.append(name);
  }
  const meta = element('span', 'rm-post-meta');
  const at = item.publishedAt ? formatDateTime(item.publishedAt) : '';
  meta.textContent = at ? `发布于 ${at}` : '发表时间未记录';
  copy.append(meta);
  header.append(avatar, copy);

  const title = element('h1', 'rm-post-detail-title');
  title.textContent = item.title || item.name || item.path || '公开动态';
  const summary = element('p', 'rm-post-detail-summary');
  summary.textContent = item.summary || '';
  summary.hidden = summary.textContent.length === 0;
  const tags = element('div', 'rm-post-tags');
  for (const tag of (Array.isArray(item.tags) ? item.tags : []).slice(0, 10)) {
    const chip = element('span', 'rm-post-tag');
    chip.textContent = tag;
    tags.append(chip);
  }
  tags.hidden = tags.childElementCount === 0;

  const main = element('div', 'rm-post-detail-main');
  main.dataset.hasMedia = images.length > 0 ? 'true' : 'false';
  const media = renderPostMedia(images, {
    variant: 'detail',
    subject,
    peerId: item.peerId,
    title: item.title,
    stateFor: imageStateFor,
    retainImage,
  });
  if (media) {
    media.addEventListener('click', (event) => {
      const tile = event.target.closest?.('[data-post-image-key]');
      if (!tile) return;
      event.preventDefault();
      event.stopPropagation();
      onImageAction?.(tile, item, images, 'detail');
    });
    main.append(media);
  }
  const body = element('div', 'rm-post-detail-body');
  const localProblem = contentStateText(item.contentState, item.contentError);
  if (localProblem && item.contentState !== 'available') {
    const problem = element('p', 'rm-list-note rm-post-content-state');
    problem.textContent = localProblem;
    body.append(problem);
    if (fetch) {
      const box = element('div', 'rm-post-fetch');
      const note = element('p');
      note.append('远端原件尚未获取。读取时将按 ');
      const pathCode = element('code');
      pathCode.textContent = item.path || fetch.path || '（路径未记录）';
      note.append(pathCode, ' · SHA-256 ');
      const shaCode = element('code');
      shaCode.textContent = item.sha256 || fetch.sha256 || '（版本未记录）';
      note.append(shaCode, ' · ');
      const size = formatBytes(item.sizeBytes > 0 ? item.sizeBytes : fetch.sizeBytes);
      note.append(size || '大小未记录', ' 核对；不会自动打开其他文件或目录。');
      box.append(note);
      if (fetch.error) {
        const error = element('p', 'rm-list-note');
        error.dataset.tone = 'error';
        error.textContent = fetch.error;
        box.append(error);
      }
      const action = element('button', 'rm-primary rm-post-fetch-action');
      action.type = 'button';
      action.dataset.detailFetch = '';
      action.dataset.busy = fetch.busy === true ? 'true' : 'false';
      if (fetch.busy === true) action.setAttribute('aria-busy', 'true');
      action.textContent = fetch.busy === true
        ? '正在获取原件…'
        : fetch.error ? '重试获取原件' : '获取原件';
      if (focusKey) action.dataset.focusKey = `${focusKey}:fetch`;
      action.onclick = () => {
        if (fetch.busy === true) return;
        void onFetch?.(item, action);
      };
      box.append(action);
      body.append(box);
    } else if (subject === 'explore') {
      const retry = element('button', 'rm-list-retry');
      retry.type = 'button';
      retry.dataset.detailRetry = item.id || '';
      retry.dataset.detailFocus = 'retry';
      retry.textContent = '重试读取内容';
      body.append(retry);
    }
  } else if (preview?.state === 'loading') {
    const note = element('p', 'rm-list-note');
    note.textContent = '正在读取并核对帖子正文…';
    body.append(note);
  } else if (preview?.state === 'error') {
    const note = element('p', 'rm-list-note');
    note.textContent = `这次没有读到帖子正文：${preview.error}`;
    body.append(note);
    if (subject === 'explore') {
      const retry = element('button', 'rm-list-retry');
      retry.type = 'button';
      retry.dataset.detailRetry = item.id || '';
      retry.dataset.detailFocus = 'retry';
      retry.textContent = '重试读取内容';
      body.append(retry);
    }
  } else if (previewData) {
    body.append(previewFeedback(preview, item, { renderMarkdown }));
  } else {
    const note = element('p', 'rm-list-note');
    note.textContent = '正在读取帖子正文…';
    body.append(note);
  }
  main.append(body);
  article.append(header, title, summary, tags, main);

  const actions = element('div', 'rm-post-actions rm-post-detail-actions');
  if (edit) {
    const editButton = element('button', 'rm-quiet rm-post-edit');
    editButton.type = 'button';
    editButton.textContent = '编辑';
    editButton.setAttribute('aria-label', `编辑 ${item.title || item.path}`);
    editButton.onclick = () => edit(item, editButton);
    if (focusKey) editButton.dataset.focusKey = `${focusKey}:edit`;
    actions.append(editButton);
  }
  if (favorite !== null) {
    const star = element('button', 'rm-quiet rm-post-favorite');
    star.type = 'button';
    star.dataset.favoriteKey = favorite.key || '';
    star.setAttribute('aria-pressed', favorite.active ? 'true' : 'false');
    star.setAttribute('aria-label', favorite.active ? `取消收藏 ${item.title || item.path}` : `收藏 ${item.title || item.path}`);
    star.title = favorite.active ? '取消收藏' : '收藏';
    star.disabled = favorite.disabled === true;
    star.dataset.pending = favorite.disabled === true ? 'true' : 'false';
    star.textContent = favorite.active ? '★ 已收藏' : '☆ 收藏';
    star.onclick = () => { if (!star.disabled) void onFavorite?.(item, star); };
    if (focusKey) star.dataset.focusKey = `${focusKey}:favorite`;
    actions.append(star);
  }
  if (actions.childElementCount > 0) article.append(actions);

  const sourceActions = showReveal ? [revealControl(item, { onReveal, focusKey })] : [];
  const details = sourceDetails({
    rows: publicSourceRows(item),
    note: '发布节点公开名与原作者声明分开保留；获取时间、版本、文件类型、大小和本地副本状态只在这里展开。',
    actions: sourceActions,
  }, { sourceOpen, save });
  const expandedKey = subject === 'explore'
    ? String(item.id || '')
    : `${subject}:${item.id || item.path}:source`;
  details.open = sourceOpen[expandedKey] === true;
  details.ontoggle = () => {
    if (details.open) sourceOpen[expandedKey] = true;
    else delete sourceOpen[expandedKey];
    save();
  };
  article.append(details);
  if (reveal?.state === 'missing' || reveal?.state === 'not-downloaded'
    || reveal?.state === 'hash-mismatch' || reveal?.state === 'unavailable' || reveal?.state === 'error') {
    const note = element('p', 'rm-list-note');
    note.textContent = reveal.message || '无法在文件夹中显示。';
    article.append(note);
  } else if (reveal?.state === 'revealed') {
    const note = element('p', 'rm-list-note');
    note.textContent = '已请求宿主在文件夹中显示本地原件；不会打开、复制或导出文件。';
    article.append(note);
  }
  return article;
}
