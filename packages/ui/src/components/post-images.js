// V2 post image strip/gallery. Pure DOM construction: the app owns the
// controlled host read, bounded queue, object-URL lifetime and lightbox.
//
// The card layout follows the prototype: one image sits beside the title and
// excerpt on a wide panel and becomes a full-width cover on a narrow panel;
// two to four images use a compact grid in the same slot.

export function postImageKey(subject, peerId, image) {
  return [
    subject,
    peerId,
    image?.publicPath ?? image?.path ?? '',
    image?.sha256 ?? '',
    image?.sizeBytes ?? '',
  ].join('\u0000');
}

export function imagePathLabel(image) {
  const mime = image?.mime === 'image/jpeg' ? 'JPEG' : image?.mime === 'image/png' ? 'PNG' : '图片';
  const size = Number(image?.width) > 0 && Number(image?.height) > 0
    ? `${image.width}×${image.height}`
    : '';
  return [mime, size].filter(Boolean).join(' · ');
}

export function imageStateLabel(state) {
  if (state?.state === 'loading') return '正在读取图片…';
  if (state?.state !== 'error') return '';
  switch (state.reason) {
    case 'not-downloaded': return '离线：本机还没有这张图片';
    case 'copy-missing': return '本机图片副本缺失';
    case 'not-published': return '公开清单中没有这张图片';
    case 'offline': return '离线：暂时无法取得这张图片';
    case 'hash-mismatch': return '图片版本校验失败';
    case 'unsupported': return '图片类型不受支持';
    default: return '图片读取失败';
  }
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function buildTile(image, index, total, title, key, stateFor, variant, subject, peerId, retainImage) {
  const keyForImage = key;
  const button = element('button', 'rm-post-media-item');
  button.type = 'button';
  button.dataset.postImageKey = keyForImage;
  button.dataset.subject = subject;
  button.dataset.peerId = peerId;
  button.__ramingaImage = image;
  button.__ramingaTitle = title;
  if (typeof retainImage === 'function') retainImage(keyForImage);
  button.dataset.index = String(index);
  button.dataset.total = String(total);
  button.dataset.variant = variant;
  button.setAttribute('aria-label', `预览第 ${index + 1} 张图片，共 ${total} 张`);
  const img = element('img', 'rm-post-media-img');
  img.alt = total === 1 ? `${title || '动态'}配图` : `${title || '动态'}配图 ${index + 1}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.hidden = true;
  const status = element('span', 'rm-post-media-status');
  status.hidden = true;
  button.append(img, status);
  updatePostImageNode(button, stateFor(keyForImage), { image, index, total, title });
  return button;
}

export function renderPostMedia(images, {
  variant = 'card',
  subject = '',
  peerId = '',
  title = '',
  keyFor = (image) => postImageKey(subject, peerId, image),
  stateFor = () => ({ state: 'idle' }),
  retainImage = null,
} = {}) {
  const list = Array.isArray(images) ? images.filter((image) => image && (image.publicPath || image.path)) : [];
  if (list.length === 0) return null;
  const grid = element('div', 'rm-post-media');
  grid.dataset.variant = variant;
  grid.dataset.count = String(Math.min(list.length, 4));
  for (const [index, image] of list.slice(0, 4).entries()) {
    grid.append(buildTile(image, index, Math.min(list.length, 4), title, keyFor(image), stateFor, variant, subject, peerId, retainImage));
  }
  return grid;
}

/** Apply a cache state to one rendered tile without re-rendering the feed. */
export function updatePostImageNode(button, state, { image = null, index = 0, total = 1, title = '' } = {}) {
  if (!button) return;
  const value = state && typeof state === 'object' ? state : { state: 'idle' };
  button.dataset.state = value.state;
  const img = button.querySelector('.rm-post-media-img');
  const status = button.querySelector('.rm-post-media-status');
  if (!img || !status) return;
  if (value.state === 'ready' && typeof value.url === 'string' && value.url.length > 0) {
    if (img.getAttribute('src') !== value.url) img.src = value.url;
    img.hidden = false;
    status.hidden = true;
    status.textContent = '';
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.removeAttribute('data-tone');
    button.dataset.action = 'preview';
    button.setAttribute('aria-label', `预览第 ${index + 1} 张图片，共 ${total} 张`);
    return;
  }
  img.hidden = true;
  img.removeAttribute('src');
  status.hidden = false;
  if (value.state === 'loading') {
    status.textContent = '正在读取图片…';
    button.disabled = false;
    button.dataset.action = 'loading';
    button.setAttribute('aria-busy', 'true');
    return;
  }
  button.removeAttribute('aria-busy');
  if (value.state === 'error') {
    const label = imageStateLabel(value);
    status.textContent = value.detail ? `${label}；${value.detail}` : label;
    button.disabled = false;
    button.dataset.action = 'retry';
    button.dataset.tone = 'error';
    button.setAttribute('aria-label', `重试读取${title ? `《${title}》的` : ''}第 ${index + 1} 张图片`);
    return;
  }
  status.textContent = '图片待读取';
  button.disabled = false;
  button.removeAttribute('data-tone');
  button.dataset.action = 'load';
  button.removeAttribute('data-tone');
  button.setAttribute('aria-label', `读取${title ? `《${title}》的` : ''}第 ${index + 1} 张图片`);
}
