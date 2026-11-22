// Public-file classification and sandboxed preview building for the Raminga
// workspace. Public bytes are untrusted: text is returned as text, media as
// data URLs, and HTML is parsed, stripped of active content, rewritten to
// inline local resources, and rendered only inside a sandboxed iframe.
import path from 'node:path';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import * as yauzl from 'yauzl';
import { LocalDataError, parsePublicPost, type LocalPost } from './local-data.js';

export const MAX_TEXT_PREVIEW = 256 * 1024;
export const MAX_MEDIA_PREVIEW = 24 * 1024 * 1024;
export const MAX_HTML_SOURCE = 4 * 1024 * 1024;
export const MAX_ZIP_ARCHIVE = 16 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 1024;
export const MAX_ZIP_ENTRY = 32 * 1024 * 1024;
export const MAX_ZIP_TOTAL = 64 * 1024 * 1024;
export const MAX_EMBED_FILE = 12 * 1024 * 1024;
export const MAX_EMBED_TOTAL = 20 * 1024 * 1024;
export const MAX_HTML_DOCUMENT = 24 * 1024 * 1024;

export type PublicFileKind =
  | 'markdown'
  | 'json'
  | 'text'
  | 'code'
  | 'image'
  | 'audio'
  | 'video'
  | 'html'
  | 'zip'
  | 'unsupported';

export type PreviewStatus =
  | 'ok'
  | 'unsupported'
  | 'copy-missing'
  | 'hash-mismatch'
  | 'zip-error'
  | 'resource-error'
  | 'error';

export interface FileTypeInfo {
  kind: PublicFileKind;
  mime: string;
  previewable: boolean;
}

export interface FilePreview {
  status: PreviewStatus;
  kind: PublicFileKind;
  mime: string;
  title: string;
  text: string;
  html: string;
  dataUrl: string;
  warnings: string[];
  missingResources: string[];
  error: string;
  post: LocalPost | null;
}

export class PublicFileError extends Error {
  constructor(
    readonly status: PreviewStatus,
    message: string,
  ) {
    super(message);
    this.name = 'PublicFileError';
  }
}

const TYPES: Record<string, FileTypeInfo> = {
  md: { kind: 'markdown', mime: 'text/markdown', previewable: true },
  markdown: { kind: 'markdown', mime: 'text/markdown', previewable: true },
  txt: { kind: 'text', mime: 'text/plain', previewable: true },
  log: { kind: 'text', mime: 'text/plain', previewable: true },
  csv: { kind: 'text', mime: 'text/csv', previewable: true },
  tsv: { kind: 'text', mime: 'text/tab-separated-values', previewable: true },
  json: { kind: 'json', mime: 'application/json', previewable: true },
  jsonl: { kind: 'json', mime: 'application/x-ndjson', previewable: true },
  yaml: { kind: 'text', mime: 'text/yaml', previewable: true },
  yml: { kind: 'text', mime: 'text/yaml', previewable: true },
  toml: { kind: 'text', mime: 'text/plain', previewable: true },
  xml: { kind: 'text', mime: 'application/xml', previewable: true },
  html: { kind: 'html', mime: 'text/html', previewable: true },
  htm: { kind: 'html', mime: 'text/html', previewable: true },
  css: { kind: 'code', mime: 'text/css', previewable: true },
  js: { kind: 'code', mime: 'text/javascript', previewable: true },
  mjs: { kind: 'code', mime: 'text/javascript', previewable: true },
  cjs: { kind: 'code', mime: 'text/javascript', previewable: true },
  ts: { kind: 'code', mime: 'text/typescript', previewable: true },
  tsx: { kind: 'code', mime: 'text/typescript', previewable: true },
  jsx: { kind: 'code', mime: 'text/javascript', previewable: true },
  go: { kind: 'code', mime: 'text/plain', previewable: true },
  py: { kind: 'code', mime: 'text/plain', previewable: true },
  rb: { kind: 'code', mime: 'text/plain', previewable: true },
  rs: { kind: 'code', mime: 'text/plain', previewable: true },
  java: { kind: 'code', mime: 'text/plain', previewable: true },
  c: { kind: 'code', mime: 'text/plain', previewable: true },
  h: { kind: 'code', mime: 'text/plain', previewable: true },
  cpp: { kind: 'code', mime: 'text/plain', previewable: true },
  sh: { kind: 'code', mime: 'text/plain', previewable: true },
  sql: { kind: 'code', mime: 'text/plain', previewable: true },
  png: { kind: 'image', mime: 'image/png', previewable: true },
  jpg: { kind: 'image', mime: 'image/jpeg', previewable: true },
  jpeg: { kind: 'image', mime: 'image/jpeg', previewable: true },
  gif: { kind: 'image', mime: 'image/gif', previewable: true },
  webp: { kind: 'image', mime: 'image/webp', previewable: true },
  avif: { kind: 'image', mime: 'image/avif', previewable: true },
  bmp: { kind: 'image', mime: 'image/bmp', previewable: true },
  ico: { kind: 'image', mime: 'image/x-icon', previewable: true },
  svg: { kind: 'image', mime: 'image/svg+xml', previewable: true },
  mp3: { kind: 'audio', mime: 'audio/mpeg', previewable: true },
  wav: { kind: 'audio', mime: 'audio/wav', previewable: true },
  ogg: { kind: 'audio', mime: 'audio/ogg', previewable: true },
  oga: { kind: 'audio', mime: 'audio/ogg', previewable: true },
  m4a: { kind: 'audio', mime: 'audio/mp4', previewable: true },
  aac: { kind: 'audio', mime: 'audio/aac', previewable: true },
  flac: { kind: 'audio', mime: 'audio/flac', previewable: true },
  opus: { kind: 'audio', mime: 'audio/ogg', previewable: true },
  mp4: { kind: 'video', mime: 'video/mp4', previewable: true },
  m4v: { kind: 'video', mime: 'video/mp4', previewable: true },
  webm: { kind: 'video', mime: 'video/webm', previewable: true },
  mov: { kind: 'video', mime: 'video/quicktime', previewable: true },
  ogv: { kind: 'video', mime: 'video/ogg', previewable: true },
  zip: { kind: 'zip', mime: 'application/zip', previewable: true },
  pdf: { kind: 'unsupported', mime: 'application/pdf', previewable: false },
  doc: { kind: 'unsupported', mime: 'application/msword', previewable: false },
  docx: { kind: 'unsupported', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewable: false },
  xls: { kind: 'unsupported', mime: 'application/vnd.ms-excel', previewable: false },
  xlsx: { kind: 'unsupported', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewable: false },
  ppt: { kind: 'unsupported', mime: 'application/vnd.ms-powerpoint', previewable: false },
  pptx: { kind: 'unsupported', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', previewable: false },
  odt: { kind: 'unsupported', mime: 'application/vnd.oasis.opendocument.text', previewable: false },
  ods: { kind: 'unsupported', mime: 'application/vnd.oasis.opendocument.spreadsheet', previewable: false },
  odp: { kind: 'unsupported', mime: 'application/vnd.oasis.opendocument.presentation', previewable: false },
};

export function extensionOf(filePath: string): string {
  const name = filePath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function fileTypeOf(filePath: string): FileTypeInfo {
  return TYPES[extensionOf(filePath)] ?? { kind: 'unsupported', mime: 'application/octet-stream', previewable: false };
}

export function titleFallback(filePath: string): string {
  const name = fileNameOf(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function firstMarkdownHeading(markdown: string): string {
  const source = markdown.replace(/^\uFEFF/, '');
  for (const line of source.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return stripInlineMarkdown(match[1]).slice(0, 200);
  }
  return '';
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
}

function plainExcerpt(value: string, limit = 180): string {
  const text = value.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]*>/g, ' ').replace(/[#>*_`[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function decodeUtf8(data: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new PublicFileError('unsupported', `${label} 不是有效 UTF-8，无法安全显示为文本`);
  }
}

function dataUrl(mime: string, data: Buffer): string {
  return `data:${mime};base64,${data.toString('base64')}`;
}

export interface FilePreviewInput {
  data: Buffer;
  path: string;
  // Only passed for downloaded/public posts whose author mapping must match the
  // serving peer. Generic JSON is always treated as plain text.
  servingPeerId?: string;
}

function emptyPreview(kind: PublicFileKind, mime: string, title: string): FilePreview {
  return {
    status: 'ok', kind, mime, title, text: '', html: '', dataUrl: '',
    warnings: [], missingResources: [], error: '', post: null,
  };
}

export async function buildFilePreview(input: FilePreviewInput): Promise<FilePreview> {
  const type = fileTypeOf(input.path);
  const title = titleFallback(input.path);
  const preview = emptyPreview(type.kind, type.mime, title);
  if (type.kind === 'markdown') {
    const text = decodeUtf8(input.data, input.path);
    preview.title = firstMarkdownHeading(text) || title;
    preview.text = text.slice(0, MAX_TEXT_PREVIEW);
    return preview;
  }
  if (type.kind === 'json') {
    if (input.path.startsWith('posts/') && input.path.endsWith('.json') && input.servingPeerId) {
      try {
        const post = parsePublicPost(input.data, input.path, input.servingPeerId);
        return {
          ...preview, kind: 'markdown', mime: 'text/markdown', title: post.title,
          text: post.bodyMarkdown, post,
        };
      } catch (error) {
        if (!(error instanceof LocalDataError)) throw error;
        // A JSON file that is not a valid versioned post is still safe text.
      }
    }
    const text = decodeUtf8(input.data, input.path);
    preview.title = title;
    preview.text = text.slice(0, MAX_TEXT_PREVIEW);
    return preview;
  }
  if (type.kind === 'text' || type.kind === 'code') {
    const text = decodeUtf8(input.data, input.path);
    preview.text = text.slice(0, MAX_TEXT_PREVIEW);
    if (!preview.text.trim()) preview.text = '（空文件）';
    return preview;
  }
  if (type.kind === 'image' || type.kind === 'audio' || type.kind === 'video') {
    if (input.data.length > MAX_MEDIA_PREVIEW) {
      throw new PublicFileError('unsupported', `${input.path} 超过 ${MAX_MEDIA_PREVIEW} 字节，未生成内联媒体预览`);
    }
    preview.dataUrl = dataUrl(type.mime, input.data);
    return preview;
  }
  if (type.kind === 'html') {
    throw new PublicFileError('unsupported', 'HTML 需要带相对资源访问器的沙箱构建');
  }
  if (type.kind === 'zip') {
    throw new PublicFileError('unsupported', 'ZIP 需要带相对资源访问器的沙箱构建');
  }
  throw new PublicFileError('unsupported', `${input.path} 是 ${type.mime} 文件；当前只显示文件信息，不加载 PDF/Office 预览库`);
}

export interface HtmlBuildOptions {
  readResource: (relative: string, maxBytes: number) => Promise<Buffer | null>;
  maxEmbeddedBytes?: number;
  rootLabel?: string;
}

interface RewriteContext {
  readResource: (relative: string, maxBytes: number) => Promise<Buffer | null>;
  warnings: string[];
  missing: string[];
  embedded: number;
  maxEmbedded: number;
}

function externalLabel(raw: string): string {
  const value = raw.trim();
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function resolveRelative(raw: string, baseDir: string): { kind: 'data' | 'fragment' | 'external' | 'inside' | 'outside' | 'invalid'; path: string } {
  const value = raw.trim();
  if (value.length === 0) return { kind: 'invalid', path: '' };
  if (value.startsWith('#')) return { kind: 'fragment', path: value };
  if (value.startsWith('//')) return { kind: 'external', path: value };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return { kind: value.toLowerCase().startsWith('data:') ? 'data' : 'external', path: value };
  }
  const withoutQuery = value.split(/[?#]/, 1)[0];
  if (withoutQuery.length === 0) return { kind: 'invalid', path: '' };
  const decoded = decodePath(withoutQuery).replace(/\\/g, '/');
  if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) return { kind: 'outside', path: decoded };
  const joined = path.posix.normalize(path.posix.join(baseDir || '.', decoded));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return { kind: 'outside', path: decoded };
  return { kind: 'inside', path: joined === '.' ? '' : joined };
}

function mimeForResource(filePath: string): string {
  const type = fileTypeOf(filePath);
  if (type.kind === 'unsupported') {
    if (extensionOf(filePath) === 'woff') return 'font/woff';
    if (extensionOf(filePath) === 'woff2') return 'font/woff2';
    if (extensionOf(filePath) === 'ttf') return 'font/ttf';
    if (extensionOf(filePath) === 'otf') return 'font/otf';
    return 'application/octet-stream';
  }
  return type.mime;
}

async function readEmbedded(
  raw: string,
  baseDir: string,
  context: RewriteContext,
  maxBytes: number,
): Promise<string> {
  const target = resolveRelative(raw, baseDir);
  if (target.kind === 'data') {
    if (target.path.length > context.maxEmbedded - context.embedded) {
      context.warnings.push(`内联资源超出总上限：${externalLabel(raw)}`);
      return '';
    }
    context.embedded += target.path.length;
    return target.path;
  }
  if (target.kind === 'fragment') return target.path;
  if (target.kind === 'external') {
    context.warnings.push(`已阻止外部资源：${externalLabel(raw)}`);
    return '';
  }
  if (target.kind !== 'inside') {
    context.warnings.push(`已阻止越界或非法资源路径：${externalLabel(raw)}`);
    return '';
  }
  const available = Math.min(maxBytes, context.maxEmbedded - context.embedded);
  if (available <= 0) {
    context.warnings.push(`内联资源超出总上限：${externalLabel(raw)}`);
    return '';
  }
  let data: Buffer | null;
  try {
    data = await context.readResource(target.path, available);
  } catch (error) {
    context.warnings.push(`资源读取失败：${externalLabel(raw)}（${error instanceof Error ? error.message : String(error)}）`);
    return '';
  }
  if (data === null) {
    context.missing.push(externalLabel(raw));
    return '';
  }
  if (data.length > available) {
    context.warnings.push(`内联资源超出上限：${externalLabel(raw)}`);
    return '';
  }
  context.embedded += data.length;
  return dataUrl(mimeForResource(target.path), data);
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;

async function rewriteCss(
  css: string,
  baseDir: string,
  context: RewriteContext,
  depth = 0,
): Promise<string> {
  let source = css.slice(0, 1024 * 1024);
  if (depth < 5) {
    const imports: Array<{ raw: string; replacement: string }> = [];
    for (const match of source.matchAll(CSS_IMPORT)) {
      const raw = match[0];
      const target = match[2];
      const resolved = resolveRelative(target, baseDir);
      if (resolved.kind !== 'inside') {
        if (resolved.kind === 'external') context.warnings.push(`已阻止外部 CSS 导入：${externalLabel(target)}`);
        imports.push({ raw, replacement: '' });
        continue;
      }
      const available = Math.min(1024 * 1024, context.maxEmbedded - context.embedded);
      if (available <= 0) {
        imports.push({ raw, replacement: '' });
        continue;
      }
      try {
        const data = await context.readResource(resolved.path, available);
        if (data === null) {
          context.missing.push(externalLabel(target));
          imports.push({ raw, replacement: '' });
          continue;
        }
        context.embedded += data.length;
        const nestedDir = path.posix.dirname(resolved.path);
        const nested = await rewriteCss(data.toString('utf8'), nestedDir === '.' ? '' : nestedDir, context, depth + 1);
        imports.push({ raw, replacement: nested });
      } catch (error) {
        context.warnings.push(`CSS 导入失败：${externalLabel(target)}（${error instanceof Error ? error.message : String(error)}）`);
        imports.push({ raw, replacement: '' });
      }
    }
    for (const entry of imports) source = source.replace(entry.raw, () => entry.replacement);
  }
  const replacements: Array<{ raw: string; replacement: string }> = [];
  for (const match of source.matchAll(CSS_URL)) {
    const raw = match[0];
    const value = match[2];
    if (value.trim().toLowerCase().startsWith('data:')) continue;
    const embedded = await readEmbedded(value, baseDir, context, MAX_EMBED_FILE);
    replacements.push({
      raw,
      replacement: embedded.length > 0 ? `url("${embedded.replace(/"/g, '%22')}")` : 'url("data:application/octet-stream;base64,")',
    });
  }
  for (const entry of replacements) source = source.replace(entry.raw, () => entry.replacement);
  return source;
}

type P5Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: { childNodes?: P5Node[] };
};

const ACTIVE_TAGS = new Set(['script', 'base', 'object', 'embed', 'iframe', 'frame', 'frameset', 'applet', 'portal', 'template']);
const RESOURCE_ATTRS = new Set(['src', 'poster', 'data']);

function attr(node: P5Node, name: string): string {
  return node.attrs?.find((item) => item.name === name)?.value ?? '';
}

function setAttr(node: P5Node, name: string, value: string | null): void {
  if (!node.attrs) node.attrs = [];
  const index = node.attrs.findIndex((item) => item.name === name);
  if (value === null) {
    if (index >= 0) node.attrs.splice(index, 1);
    return;
  }
  if (index >= 0) node.attrs[index].value = value;
  else node.attrs.push({ name, value });
}

function textNode(value: string): P5Node {
  return { nodeName: '#text', value };
}

async function inlineSrcset(raw: string, baseDir: string, context: RewriteContext): Promise<string> {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const rewritten: string[] = [];
  for (const part of parts) {
    const [url, ...descriptor] = part.split(/\s+/);
    const embedded = await readEmbedded(url, baseDir, context, MAX_EMBED_FILE);
    if (embedded.length > 0) rewritten.push([embedded, ...descriptor].join(' '));
  }
  return rewritten.join(', ');
}

async function rewriteHtmlTree(
  root: P5Node,
  baseDir: string,
  context: RewriteContext,
): Promise<void> {
  const children = root.childNodes ?? [];
  const next: P5Node[] = [];
  for (const child of children) {
    if (child.nodeName === '#text' || child.nodeName === '#comment' || child.nodeName === '#documentType') {
      next.push(child);
      continue;
    }
    const tag = (child.tagName ?? '').toLowerCase();
    if (ACTIVE_TAGS.has(tag)) continue;
    if (tag === 'meta' && attr(child, 'http-equiv').toLowerCase() === 'refresh') continue;
    if (tag === 'link') {
      const rel = attr(child, 'rel').toLowerCase();
      const href = attr(child, 'href');
      if (rel.split(/\s+/).includes('stylesheet') && href) {
        const target = resolveRelative(href, baseDir);
        if (target.kind === 'inside') {
          try {
            const data = await context.readResource(target.path, 1024 * 1024);
            if (data !== null && data.length <= context.maxEmbedded - context.embedded) {
              context.embedded += data.length;
              const nestedDir = path.posix.dirname(target.path);
              const css = await rewriteCss(data.toString('utf8'), nestedDir === '.' ? '' : nestedDir, context);
              next.push({ nodeName: 'style', tagName: 'style', attrs: [], childNodes: [textNode(css)] });
              continue;
            }
            if (data === null) context.missing.push(externalLabel(href));
          } catch (error) {
            context.warnings.push(`样式表读取失败：${externalLabel(href)}（${error instanceof Error ? error.message : String(error)}）`);
          }
        } else if (target.kind === 'external') {
          context.warnings.push(`已阻止外部样式表：${externalLabel(href)}`);
        }
      }
      // No other link relation is allowed to trigger a host/browser request.
      continue;
    }
    if (tag === 'style') {
      const css = (child.childNodes ?? []).map((node) => node.value ?? '').join('');
      const rewritten = await rewriteCss(css, baseDir, context);
      child.childNodes = [textNode(rewritten)];
      next.push(child);
      continue;
    }
    if (tag === 'a') {
      const href = attr(child, 'href');
      if (href && href.startsWith('#')) {
        setAttr(child, 'href', href);
      } else {
        setAttr(child, 'href', '#');
        setAttr(child, 'target', null);
        setAttr(child, 'rel', null);
      }
    }
    if (tag === 'form') setAttr(child, 'action', null);
    if (child.attrs) {
      child.attrs = child.attrs.filter((item) => {
        const name = item.name.toLowerCase();
        if (name.startsWith('on') || name === 'ping' || name === 'download') return false;
        if (name === 'srcdoc' || name === 'integrity' || name === 'crossorigin' || name === 'target') return false;
        if ((name === 'href' || name === 'xlink:href') && tag !== 'a' && tag !== 'link') {
          const value = item.value.trim().toLowerCase();
          return value.startsWith('#') || value.startsWith('data:');
        }
        return true;
      });
    }
    const inlineStyle = attr(child, 'style');
    if (inlineStyle) setAttr(child, 'style', await rewriteCss(inlineStyle, baseDir, context));
    const attrs = child.attrs ?? [];
    for (const item of [...attrs]) {
      const name = item.name.toLowerCase();
      if (RESOURCE_ATTRS.has(name) || (tag === 'image' && name === 'xlink:href')) {
        if (item.value.trim().toLowerCase().startsWith('data:')) continue;
        const embedded = await readEmbedded(item.value, baseDir, context, MAX_EMBED_FILE);
        setAttr(child, item.name, embedded.length > 0 ? embedded : null);
      } else if (name === 'srcset') {
        const rewritten = await inlineSrcset(item.value, baseDir, context);
        setAttr(child, item.name, rewritten.length > 0 ? rewritten : null);
      }
    }
    if (tag === 'img') {
      setAttr(child, 'loading', 'lazy');
      if (!attr(child, 'src')) setAttr(child, 'alt', attr(child, 'alt') || '资源未能离线读取');
    }
    await rewriteHtmlTree(child, baseDir, context);
    next.push(child);
  }
  root.childNodes = next;
}

function findElement(node: P5Node, tag: string): P5Node | null {
  if ((node.tagName ?? '').toLowerCase() === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

export interface HtmlDocumentResult {
  html: string;
  title: string;
  warnings: string[];
  missingResources: string[];
  embeddedBytes: number;
}

const CSP = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline' data:; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'";

export async function buildSandboxedHtml(
  source: string,
  baseDir: string,
  options: HtmlBuildOptions,
): Promise<HtmlDocumentResult> {
  if (Buffer.byteLength(source, 'utf8') > MAX_HTML_SOURCE) {
    throw new PublicFileError('unsupported', `HTML 超过 ${MAX_HTML_SOURCE} 字节，未生成预览`);
  }
  const context: RewriteContext = {
    readResource: options.readResource,
    warnings: [],
    missing: [],
    embedded: 0,
    maxEmbedded: options.maxEmbeddedBytes ?? MAX_EMBED_TOTAL,
  };
  let document: P5Node;
  try {
    document = parse(source, { scriptingEnabled: false }) as unknown as P5Node;
  } catch (error) {
    throw new PublicFileError('error', `HTML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const html = findElement(document, 'html') ?? document;
  await rewriteHtmlTree(html, baseDir, context);
  const head = findElement(html, 'head') ?? findElement(document, 'head');
  if (head) {
    head.childNodes = [
      { nodeName: 'meta', tagName: 'meta', attrs: [{ name: 'charset', value: 'utf-8' }], childNodes: [] },
      {
        nodeName: 'meta',
        tagName: 'meta',
        attrs: [
          { name: 'http-equiv', value: 'Content-Security-Policy' },
          { name: 'content', value: CSP },
        ],
        childNodes: [],
      },
      ...(head.childNodes ?? []),
    ];
  }
  const output = serialize(document as unknown as DefaultTreeAdapterTypes.Document);
  if (Buffer.byteLength(output, 'utf8') > MAX_HTML_DOCUMENT) {
    throw new PublicFileError('resource-error', `内联后的 HTML 超过 ${MAX_HTML_DOCUMENT} 字节；请缩小包内资源后重试`);
  }
  const titleElement = findElement(document, 'title');
  const title = (titleElement?.childNodes ?? []).map((node) => node.value ?? '').join('').trim().slice(0, 200);
  return {
    html: output,
    title,
    warnings: unique(context.warnings).slice(0, 20),
    missingResources: unique(context.missing).slice(0, 50),
    embeddedBytes: context.embedded,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

interface ZipEntries {
  files: Map<string, Buffer>;
  lower: Map<string, string>;
  order: string[];
}

function zipOpen(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(new PublicFileError('zip-error', `ZIP 无法打开：${error?.message ?? '未知错误'}`));
      else resolve(zip);
    });
  });
}

function readEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new PublicFileError('zip-error', `ZIP 条目无法读取：${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          stream.destroy();
          reject(new PublicFileError('zip-error', `ZIP 条目超过解压上限：${entry.fileName}`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks, total)));
      stream.on('error', (error: Error) => reject(new PublicFileError('zip-error', `ZIP 条目读取失败：${entry.fileName}（${error.message}）`)));
    });
  });
}

function safeZipName(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.length > 512 || normalized.includes('\u0000')) {
    throw new PublicFileError('zip-error', 'ZIP 包含空、过长或含 NUL 的条目名');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PublicFileError('zip-error', `ZIP 包含绝对路径：${normalized}`);
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) throw new PublicFileError('zip-error', 'ZIP 包含空条目名');
  for (const part of parts) {
    if (part === '.' || part === '..') throw new PublicFileError('zip-error', `ZIP 包含路径穿越：${normalized}`);
  }
  return parts.join('/');
}

async function readZipEntries(buffer: Buffer): Promise<ZipEntries> {
  if (buffer.length > MAX_ZIP_ARCHIVE) {
    throw new PublicFileError('unsupported', `ZIP 超过 ${MAX_ZIP_ARCHIVE} 字节，未生成解压预览`);
  }
  const zip = await zipOpen(buffer);
  const files = new Map<string, Buffer>();
  const lower = new Map<string, string>();
  const order: string[] = [];
  let total = 0;
  let entryCount = 0;
  return await new Promise<ZipEntries>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* already closed */ }
      reject(error instanceof PublicFileError ? error : new PublicFileError('zip-error', `ZIP 解析失败：${error instanceof Error ? error.message : String(error)}`));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ files, lower, order });
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) throw new PublicFileError('zip-error', `ZIP 条目超过 ${MAX_ZIP_ENTRIES} 个`);
        const isDirectory = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\');
        const name = safeZipName(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new PublicFileError('zip-error', `ZIP 包含符号链接：${name}`);
        if (entry.isEncrypted()) throw new PublicFileError('zip-error', `ZIP 包含加密条目：${name}`);
        if (isDirectory) {
          zip.readEntry();
          return;
        }
        if (files.has(name) || lower.has(name.toLowerCase())) {
          throw new PublicFileError('zip-error', `ZIP 包含重复条目：${name}`);
        }
        if (entry.uncompressedSize > MAX_ZIP_ENTRY) throw new PublicFileError('zip-error', `ZIP 条目超过解压上限：${name}`);
        if (total + entry.uncompressedSize > MAX_ZIP_TOTAL) throw new PublicFileError('zip-error', `ZIP 解压总量超过 ${MAX_ZIP_TOTAL} 字节`);
        const data = await readEntryStream(zip, entry, MAX_ZIP_ENTRY);
        total += data.length;
        if (total > MAX_ZIP_TOTAL) throw new PublicFileError('zip-error', `ZIP 解压总量超过 ${MAX_ZIP_TOTAL} 字节`);
        files.set(name, data);
        lower.set(name.toLowerCase(), name);
        order.push(name);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

function zipIndexRoot(entries: ZipEntries): string | null {
  for (const name of entries.order) {
    const parts = name.split('/');
    if (parts.length === 1 && parts[0].toLowerCase() === 'index.html') return '';
  }
  const tops = new Set(entries.order.map((name) => name.split('/')[0]));
  if (tops.size === 1) {
    const [top] = tops;
    const candidate = `${top}/index.html`;
    const found = entries.order.find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (found) return `${top}/`;
  }
  return null;
}

function zipResourceResolver(entries: ZipEntries): (relative: string, maxBytes: number) => Promise<Buffer | null> {
  return async (relative: string) => {
    const full = path.posix.normalize(relative);
    if (full.startsWith('../') || full.startsWith('/')) return null;
    const exact = entries.files.get(full);
    if (exact) return exact;
    const lowerName = entries.lower.get(full.toLowerCase());
    return lowerName ? entries.files.get(lowerName) ?? null : null;
  };
}

/**
 * Single-file HTML previews never read sibling files. The file's discovery
 * hash covers only this document, so inlining a neighbouring image could mix
 * an old document with a newer unrelated resource. Relative resources are
 * reported missing; multi-resource pages must be published as one ZIP, whose
 * archive hash covers every embedded entry.
 */
export async function buildHtmlFilePreview(input: FilePreviewInput): Promise<FilePreview> {
  const source = decodeUtf8(input.data, input.path);
  const built = await buildSandboxedHtml(source, '', { readResource: async () => null });
  return {
    status: built.missingResources.length > 0 || built.warnings.length > 0 ? 'resource-error' : 'ok',
    kind: 'html',
    mime: 'text/html',
    title: built.title || titleFallback(input.path),
    text: '',
    html: built.html,
    dataUrl: '',
    warnings: built.warnings,
    missingResources: built.missingResources,
    error: '',
    post: null,
  };
}

export async function buildZipFilePreview(input: FilePreviewInput): Promise<FilePreview> {
  const entries = await readZipEntries(input.data);
  const root = zipIndexRoot(entries);
  if (root === null) {
    throw new PublicFileError('unsupported', 'ZIP 中没有唯一的 index.html；根目录或唯一顶层文件夹的 index.html 才能预览，普通 ZIP 仅显示文件信息');
  }
  const context: RewriteContext = {
    readResource: async () => null,
    warnings: [],
    missing: [],
    embedded: 0,
    maxEmbedded: MAX_EMBED_TOTAL,
  };
  context.readResource = zipResourceResolver(entries);
  const indexPath = entries.order.find((name) => name.toLowerCase() === `${root}index.html`.toLowerCase()) ?? `${root}index.html`;
  const htmlBytes = entries.files.get(indexPath);
  if (!htmlBytes) throw new PublicFileError('zip-error', 'ZIP 的 index.html 无法读取');
  const source = decodeUtf8(htmlBytes, indexPath);
  const built = await buildSandboxedHtml(source, root, { readResource: context.readResource });
  return {
    status: built.missingResources.length > 0 || built.warnings.length > 0 ? 'resource-error' : 'ok',
    kind: 'html',
    mime: 'text/html',
    title: built.title || titleFallback(indexPath),
    text: '',
    html: built.html,
    dataUrl: '',
    warnings: built.warnings,
    missingResources: built.missingResources,
    error: '',
    post: null,
    // Keep the caller's file metadata and ZIP provenance in the bridge.
  };
}
