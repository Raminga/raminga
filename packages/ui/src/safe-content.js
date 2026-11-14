// Safe Markdown subset renderer.
//
// Public profiles, posts, Persona/Growth and Journey reports are untrusted
// data. This module never assigns innerHTML and never creates a remote media
// element: Markdown is parsed into DOM nodes, raw HTML stays text, links are
// limited to http(s), and images become an explicit "not auto-loaded" note.
// The subset is deliberately small (headings, paragraphs, lists, quotes, code,
// emphasis, links) so the security boundary is easy to test.

const MAX_MARKDOWN = 256 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function escapeControl(text) {
  return String(text ?? '').replace(CONTROL, '');
}

function safeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value.length === 0 || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function appendInline(parent, text, depth = 0) {
  if (depth > 6) {
    parent.append(text);
    return;
  }
  const doc = parent.ownerDocument ?? document;
  let index = 0;
  let plain = '';
  const flush = () => {
    if (plain.length > 0) {
      parent.append(plain);
      plain = '';
    }
  };
  while (index < text.length) {
    const rest = text.slice(index);
    if (rest.startsWith('`')) {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        const code = doc.createElement('code');
        code.textContent = text.slice(index + 1, end);
        parent.append(code);
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2);
      const end = text.indexOf(marker, index + 2);
      if (end > index + 2) {
        flush();
        const strong = doc.createElement('strong');
        appendInline(strong, text.slice(index + 2, end), depth + 1);
        parent.append(strong);
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith('*') || rest.startsWith('_')) {
      const marker = rest[0];
      const end = text.indexOf(marker, index + 1);
      if (end > index + 1) {
        flush();
        const em = doc.createElement('em');
        appendInline(em, text.slice(index + 1, end), depth + 1);
        parent.append(em);
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith('![')) {
      const close = text.indexOf(']', index + 2);
      const open = close >= 0 ? text.indexOf('(', close + 1) : -1;
      const end = open >= 0 ? text.indexOf(')', open + 1) : -1;
      if (close >= 0 && open === close + 1 && end > open) {
        flush();
        const note = doc.createElement('span');
        note.className = 'rm-md-media-note';
        note.textContent = `[图片：${text.slice(index + 2, close)}]（未自动加载远端媒体）`;
        parent.append(note);
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith('[')) {
      const close = text.indexOf(']', index + 1);
      const open = close >= 0 ? text.indexOf('(', close + 1) : -1;
      const end = open >= 0 ? text.indexOf(')', open + 1) : -1;
      if (close > index + 1 && open === close + 1 && end > open) {
        const url = safeUrl(text.slice(open + 1, end));
        flush();
        if (url.length > 0) {
          const link = doc.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer nofollow';
          appendInline(link, text.slice(index + 1, close), depth + 1);
          parent.append(link);
        } else {
          const blocked = doc.createElement('span');
          blocked.className = 'rm-md-link-blocked';
          appendInline(blocked, text.slice(index + 1, close), depth + 1);
          parent.append(blocked);
        }
        index = end + 1;
        continue;
      }
    }
    plain += text[index];
    index += 1;
  }
  flush();
}

function flushParagraph(container, lines) {
  if (lines.length === 0) return;
  const paragraph = document.createElement('p');
  appendInline(paragraph, lines.join('\n'));
  container.append(paragraph);
  lines.length = 0;
}

/**
 * Render a bounded Markdown subset into a DocumentFragment.
 * @param {Document} doc
 * @param {string} markdown
 * @returns {DocumentFragment}
 */
export function renderSafeMarkdown(doc, markdown) {
  const fragment = doc.createDocumentFragment();
  const source = escapeControl(markdown).slice(0, MAX_MARKDOWN);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list = null;
  let listType = '';
  let index = 0;
  const closeList = () => {
    if (list !== null) {
      fragment.append(list);
      list = null;
      listType = '';
    }
  };
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flushParagraph(fragment, paragraph);
      closeList();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph(fragment, paragraph);
      closeList();
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(fragment, paragraph);
      closeList();
      const level = Math.min(3, heading[1].length);
      const node = doc.createElement(`h${level + 1}`);
      appendInline(node, heading[2]);
      fragment.append(node);
      index += 1;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph(fragment, paragraph);
      closeList();
      fragment.append(doc.createElement('hr'));
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(fragment, paragraph);
      closeList();
      const block = doc.createElement('blockquote');
      const quoteLines = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const next = /^>\s?(.*)$/.exec(lines[index]);
        if (!next) break;
        quoteLines.push(next[1]);
        index += 1;
      }
      appendInline(block, quoteLines.join('\n'));
      fragment.append(block);
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph(fragment, paragraph);
      const nextType = unordered ? 'ul' : 'ol';
      if (list === null || listType !== nextType) {
        closeList();
        list = doc.createElement(nextType);
        listType = nextType;
      }
      const item = doc.createElement('li');
      appendInline(item, (unordered ?? ordered)[1]);
      list.append(item);
      index += 1;
      continue;
    }
    closeList();
    paragraph.push(line);
    index += 1;
  }
  flushParagraph(fragment, paragraph);
  closeList();
  return fragment;
}

/** Plain, bounded excerpt for list rows; never interprets Markdown. */
export function plainExcerpt(value, limit = 160) {
  const text = escapeControl(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
