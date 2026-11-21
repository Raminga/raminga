// Controlled local-data reader for the DSH workspace.
//
// The browser never receives a filesystem path it can use as a URL. This
// module resolves a small, explicit set of files under the actual data
// directory, rejects traversal/symlinks/oversized or non-regular files, and
// returns structured data plus the exact evidence (SHA-256/mtime) it read.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { peerIdFromString } from '@libp2p/peer-id';

export const MAX_PROFILE_BYTES = 256 * 1024;
export const MAX_POST_BYTES = 128 * 1024;
export const MAX_AGENT_CARD_BYTES = 96 * 1024;
export const MAX_PERSONA_BYTES = 512 * 1024;
export const MAX_GROWTH_BYTES = 512 * 1024;
export const MAX_PRIVATE_SAVE_BYTES = 256 * 1024;
export const MAX_CONTACT_NOTES_BYTES = 1024 * 1024;
export const MAX_SESSION_STATE_BYTES = 128 * 1024;
export const MAX_EVENTS_BYTES = 1024 * 1024;
export const MAX_REPORT_BYTES = 512 * 1024;
export const MAX_SESSIONS = 50;
export const MAX_EVENTS = 500;
export const MAX_POSTS = 200;
// The contact-list projection is a small, host-owned snapshot of public facts
// that were actually read and verified. It never contains chat text, private
// notes, absolute paths, or data/blob URLs. 1 MiB is the fixed budget for the
// largest legal payload: 128 profiles at the 80/400/10x80/300-character UTF-8
// limits plus 80 maximum clues serialize to under 1 MiB (~0.82 MiB measured),
// so a full legal projection and one newer record can always be written.
export const MAX_CONTACT_PROJECTION_BYTES = 1024 * 1024;
export const MAX_CONTACT_PROJECTION_PROFILES = 128;
export const MAX_CONTACT_PROJECTION_CLUES = 80;
export const MAX_CONTACT_PROJECTION_AVATAR_BYTES = 512 * 1024;
export const MAX_CONTACT_PROJECTION_AVATAR_TOTAL = 8 * 1024 * 1024;

const MAX_TEXT = 120;
const MAX_BODY = 64 * 1024;
const MAX_SUMMARY = 320;
const MAX_TAGS = 10;
const MAX_TAG = 32;
const V1_POST_PATH = /^posts\/[A-Za-z0-9._-]+\.json$/;
const V2_POST_PATH = /^posts\/[A-Za-z0-9._-]+\/post\.json$/;
const POST_PATH = /^(?:posts\/[A-Za-z0-9._-]+\.json|posts\/[A-Za-z0-9._-]+\/post\.json)$/;
const POST_IMAGE_PATH = /^posts\/[A-Za-z0-9._-]+\/images\/[a-f0-9]{64}\.(?:png|jpg)$/;
const CONTACT_AVATAR_PATH = /^profile\/avatar-([a-f0-9]{8})\.(png|jpg)$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CONTROL_TEST = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PLACEHOLDER = /replace-[a-z][a-z0-9-]*/i;

export class LocalDataError extends Error {
  constructor(
    readonly code: 'missing' | 'invalid' | 'too_large' | 'symlink' | 'unreadable' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'LocalDataError';
  }
}

export type LocalState = 'available' | 'missing' | 'error';

/** Versioned public-post paths accepted by the reader. */
export function isVersionedPostPath(value: string): boolean {
  return POST_PATH.test(value);
}

/** v2 posts are directories containing post.json plus images/. */
export function isV2PostPath(value: string): boolean {
  return V2_POST_PATH.test(value);
}

/** A v2 post image lives under the same post directory as post.json. */
export function postImagePublicPath(postPath: string, imagePath: string): string {
  return `${postPath.slice(0, postPath.lastIndexOf('/'))}/${imagePath}`;
}

/** Only these paths may be read through the post-image preview path. */
export function isPostImagePublicPath(value: string): boolean {
  return POST_IMAGE_PATH.test(value);
}

export interface LocalText {
  state: LocalState;
  markdown: string;
  error: string;
  /** SHA-256 of the exact UTF-8 bytes, used for optimistic private-file saves. */
  sha256: string;
}

export interface LocalPostImage {
  path: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface LocalPost {
  schemaVersion: 1 | 2;
  title: string;
  summary: string;
  bodyMarkdown: string;
  tags: string[];
  publishedAt: string;
  authorPeerId: string;
  /** Unknown is preserved as unknown; it is never guessed from the path. */
  authorKind: 'user' | 'agent' | 'unknown';
  authorName: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  revision: number;
  images: LocalPostImage[];
}

export interface LocalPostError {
  path: string;
  reason: string;
}

export interface LocalOwnProfile {
  state: LocalState;
  markdown: string;
  displayName: string;
  error: string;
  path: string;
  at: number | null;
}

export interface LocalOwnPosts {
  state: LocalState;
  /** Both user- and Agent-authored valid posts are included. */
  posts: LocalPost[];
  error: string;
  /** Public JSON files without a valid author mapping, or with unknown kind. */
  unattributed: number;
  /** Valid posts explicitly authored by the user's Agent. */
  agentAuthored: number;
  /** Files that could not be parsed or were too large. */
  invalid: number;
  errors: LocalPostError[];
  truncated: boolean;
}

export interface LocalPublicProfile {
  schemaVersion: 2;
  agentName: string;
  agentDescription: string;
  agentInterests: string[];
  agentConversationStyle: string;
  humanName: string;
  humanBioMarkdown: string;
  avatarPath: string;
  avatarSha256: string;
  avatarMime: string;
  /** Linked human's optional public avatar; empty when profile.json has none. */
  humanAvatarPath: string;
  humanAvatarSha256: string;
  humanAvatarMime: string;
  updatedAt: string;
  path: string;
  sha256: string;
}

export interface LocalPublicProfileRead {
  state: LocalState;
  profile: LocalPublicProfile | null;
  error: string;
}

export interface LocalAgentCard {
  schemaVersion: 1;
  displayName: string;
  description: string;
  interests: string[];
  conversationStyle: string;
  updatedAt: string;
  path: string;
  sha256: string;
  /** Populated from profile.json v2 when available; empty for a v1 card. */
  avatarPath?: string;
  avatarSha256?: string;
  avatarMime?: string;
  legacyFallback?: boolean;
  sourceWarning?: string;
}

export interface LocalAgentCardRead {
  state: LocalState;
  card: LocalAgentCard | null;
  error: string;
}

export interface JourneyMessageEvidence {
  messageId: string;
  peerId: string;
  direction: string;
  summary: string;
  observedAt: string;
  createdAtUnixMs: string;
  acked: boolean | null;
  ackedAtUnixMs: string;
  contentSha256: string;
}

export interface JourneyEvent {
  sequence: number;
  type: string;
  timestamp: string;
  summary: string;
  peerId: string;
  sourcePeerId: string;
  messageIds: string[];
  contentPaths: string[];
  messageEvidence: JourneyMessageEvidence | null;
}

export interface JourneySessionState {
  status: string;
  mode: string;
  intent: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string;
  completionReason: string;
  summary: string;
  currentPeerId: string;
  visitedPeerIds: string[];
  discoverySources: string[];
}

export interface JourneySession {
  id: string;
  /** Directory mtime, used only for ordering when state timestamps are bad. */
  dirModifiedAt: number;
  stateRead: LocalState;
  stateError: string;
  state: JourneySessionState | null;
  eventsRead: LocalState;
  eventsError: string;
  events: JourneyEvent[];
  eventsTruncated: boolean;
  badEventLines: number;
  reportRead: LocalState;
  reportError: string;
  reportMarkdown: string;
}

export interface JourneyData {
  state: LocalState;
  at: number;
  persona: LocalText;
  growth: LocalText;
  sessions: JourneySession[];
  sessionsState: LocalState;
  sessionsError: string;
  sessionsTruncated: boolean;
}

export interface ContactEvidenceRefs {
  sessionIds: string[];
  eventIds: string[];
  messageIds: string[];
  contentPaths: string[];
  contentSha256: string[];
}

export interface ContactObservation {
  id: string;
  summary: string;
  observedAt: string;
  evidenceRefs: ContactEvidenceRefs;
}

export interface ContactImpression {
  id: string;
  summary: string;
  uncertainty: 'low' | 'medium' | 'high' | '';
  createdAt: string;
  updatedAt: string;
  evidenceRefs: ContactEvidenceRefs;
}

export interface ContactCuriosity {
  id: string;
  question: string;
  createdAt: string;
  evidenceRefs: ContactEvidenceRefs;
}

export interface ContactNote {
  peerId: string;
  displayNameSnapshot: string;
  updatedAt: string;
  observations: ContactObservation[];
  impressions: ContactImpression[];
  curiosities: ContactCuriosity[];
}

export interface LocalContactNotes {
  state: 'available' | 'missing' | 'error';
  schemaVersion: 2 | 0;
  contact: ContactNote | null;
  sha256: string;
  error: string;
  at: number;
}

export interface ContactImpressionSaveInput {
  peerId: string;
  impressionId: string;
  summary: string;
  uncertainty: 'low' | 'medium' | 'high';
  expectedSha256: string;
}

export interface ContactImpressionSave {
  saved: true;
  sha256: string;
  savedAt: number;
  contact: ContactNote;
}

export interface OwnPublicData {
  profile: LocalOwnProfile;
  posts: LocalOwnPosts;
  agentCard: LocalAgentCardRead;
  publicProfile: LocalPublicProfileRead;
}

function text(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').replace(/\r\n/g, '\n').trim().slice(0, limit);
}

function rfc3339(value: unknown): string {
  const raw = text(value, 64);
  if (raw === '' || Number.isNaN(Date.parse(raw))) return '';
  return raw;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPeer(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return '';
  try {
    return peerIdFromString(value.trim()).toString();
  } catch {
    return '';
  }
}

function safeRelative(relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 512) {
    throw new LocalDataError('invalid', '路径为空或过长');
  }
  if (relative.includes('\u0000') || relative.includes('\\') || relative.startsWith('/')) {
    throw new LocalDataError('invalid', '路径包含非法字符');
  }
  const parts = relative.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new LocalDataError('invalid', '路径包含非法段');
    if (part.length > 255) throw new LocalDataError('invalid', '路径段过长');
  }
  return parts.join(path.sep);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fsErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  return String((error as NodeJS.ErrnoException).code);
}

/** Keep filesystem failures distinct: only ENOENT means "not there". */
function fsFailure(error: unknown, label: string): LocalDataError {
  switch (fsErrorCode(error)) {
    case 'ENOENT':
      return new LocalDataError('missing', `${label}不存在`);
    case 'ENOTDIR':
      return new LocalDataError('invalid', `${label}的路径中有组件不是目录`);
    case 'EACCES':
    case 'EPERM':
      return new LocalDataError('unreadable', `${label}没有读取权限`);
    case 'ELOOP':
      return new LocalDataError('symlink', `${label}是符号链接或链接循环，已拒绝读取`);
    default:
      return new LocalDataError('unreadable', `${label}无法读取`);
  }
}

async function realRoot(dataDir: string, child: string): Promise<string> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new LocalDataError('unreadable', '宿主没有提供数据目录');
  }
  const root = path.resolve(dataDir);
  let real: string;
  try {
    real = await fsp.realpath(root);
  } catch (error) {
    throw fsFailure(error, '数据目录');
  }
  let rootStat: fs.Stats;
  try {
    rootStat = await fsp.stat(real);
  } catch (error) {
    throw fsFailure(error, '数据目录');
  }
  if (!rootStat.isDirectory()) throw new LocalDataError('invalid', '数据目录不是目录');
  const target = path.join(real, child);
  if (!inside(real, target)) throw new LocalDataError('invalid', '路径越界');
  const stat = await lstatOrNull(target, child);
  if (stat === null) throw new LocalDataError('missing', `${child} 不存在`);
  if (stat.isSymbolicLink()) throw new LocalDataError('symlink', `${child} 是符号链接，已拒绝读取`);
  if (!stat.isDirectory()) throw new LocalDataError('invalid', `${child} 不是目录`);
  let realTarget: string;
  try {
    realTarget = await fsp.realpath(target);
  } catch (error) {
    throw fsFailure(error, child);
  }
  if (!inside(real, realTarget)) throw new LocalDataError('symlink', `${child} 解析后越过受控根目录`);
  return realTarget;
}

async function lstatOrNull(
  target: string,
  label = path.basename(target),
): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw fsFailure(error, label);
  }
}

/** Read at most maxBytes+1 bytes, so a concurrently growing file cannot be
 * consumed in full before the size check rejects it. */
async function readBounded(
  handle: fsp.FileHandle,
  maxBytes: number,
  relative: string,
): Promise<Buffer> {
  const data = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const { bytesRead } = await handle.read(data, offset, maxBytes + 1 - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节上限`);
  return data.subarray(0, offset);
}

async function safeReadUnder(root: string, relative: string, maxBytes: number): Promise<{ data: Buffer; stats: fs.Stats }> {
  const rel = safeRelative(relative);
  const rootStat = await lstatOrNull(root, '受控根目录');
  if (rootStat === null) throw new LocalDataError('missing', '受控根目录不存在');
  if (rootStat.isSymbolicLink()) throw new LocalDataError('symlink', '受控根目录是符号链接');
  if (!rootStat.isDirectory()) throw new LocalDataError('invalid', '受控根目录不是目录');
  try {
    root = await fsp.realpath(root);
  } catch (error) {
    throw fsFailure(error, '受控根目录');
  }
  let current = root;
  const parts = rel.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const label = parts.slice(0, index + 1).join('/');
    const stat = await lstatOrNull(current, label);
    if (stat === null) throw new LocalDataError('missing', `${label} 不存在`);
    if (stat.isSymbolicLink()) throw new LocalDataError('symlink', `${label} 是符号链接，已拒绝读取`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new LocalDataError('invalid', `${label} 不是目录`);
    } else {
      if (!stat.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
      if (stat.size > maxBytes) throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节上限`);
    }
  }
  let real: string;
  try {
    real = await fsp.realpath(current);
  } catch (error) {
    throw fsFailure(error, relative);
  }
  if (!inside(root, real)) throw new LocalDataError('symlink', `${relative} 解析后越过受控根目录`);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw fsFailure(error, relative);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
    if (stats.size > maxBytes) throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节上限`);
    const data = await readBounded(handle, maxBytes, relative);
    return { data, stats };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readOptionalText(root: string, relative: string, maxBytes: number): Promise<LocalText> {
  try {
    const { data } = await safeReadUnder(root, relative, maxBytes);
    const markdown = data.toString('utf8');
    if (markdown.includes('\uFFFD')) return { state: 'error', markdown: '', error: `${relative} 不是有效 UTF-8`, sha256: '' };
    return { state: 'available', markdown, error: '', sha256: sha256(data) };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', markdown: '', error: `${relative} 不存在`, sha256: '' };
    }
    return { state: 'error', markdown: '', error: error instanceof Error ? error.message : String(error), sha256: '' };
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function validSha(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

function collectTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const raw of value.slice(0, MAX_TAGS)) {
    const tag = text(raw, MAX_TAG);
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function collectStringList(value: unknown, limit: number, maxLength = 256): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value.slice(0, limit)) {
    const entry = text(raw, maxLength);
    if (entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Parse and validate one versioned public post (v1 or v2). */
export function parsePublicPost(data: Buffer, expectedPath: string, servingPeerId: string): LocalPost {
  if (!POST_PATH.test(expectedPath)) throw new LocalDataError('invalid', '公开帖子路径必须是 posts/*.json 或 posts/*/post.json');
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new LocalDataError('invalid', '公开帖子不是有效 JSON');
  }
  if (!isRecord(value)) throw new LocalDataError('invalid', '公开帖子必须是 JSON 对象');
  const schemaVersion = value.schema_version === 2 ? 2 : value.schema_version === 1 ? 1 : 0;
  if (schemaVersion === 0) throw new LocalDataError('invalid', '公开帖子 schema_version 必须为 1 或 2');
  if (schemaVersion === 2 && !V2_POST_PATH.test(expectedPath)) {
    throw new LocalDataError('invalid', 'schema v2 公开帖子必须位于 posts/*/post.json');
  }
  if (schemaVersion === 1 && !V1_POST_PATH.test(expectedPath)) {
    throw new LocalDataError('invalid', 'schema v1 公开帖子必须位于 posts/*.json');
  }
  if (value.format !== 'markdown') throw new LocalDataError('invalid', '公开帖子 format 必须为 markdown');
  const title = text(value.title, schemaVersion === 2 ? 120 : 200);
  if (title.length === 0) throw new LocalDataError('invalid', '公开帖子缺少标题');
  if (PLACEHOLDER.test(title)) throw new LocalDataError('invalid', '公开帖子仍包含模板占位');
  const bodyMarkdown = typeof value.body === 'string' ? value.body.replace(/\u0000/g, '') : '';
  if (bodyMarkdown.trim().length === 0) throw new LocalDataError('invalid', '公开帖子正文为空');
  if (Buffer.byteLength(bodyMarkdown, 'utf8') > MAX_BODY) throw new LocalDataError('too_large', '公开帖子正文超过 64 KiB');
  const author = isRecord(value.author) ? value.author : null;
  if (author === null) throw new LocalDataError('invalid', '公开帖子缺少 author 映射');
  const authorPeerId = canonicalPeer(author.peer_id);
  if (authorPeerId.length === 0) throw new LocalDataError('invalid', '公开帖子 author.peer_id 无效');
  if (authorPeerId !== canonicalPeer(servingPeerId)) {
    throw new LocalDataError('invalid', '公开帖子作者声明与发布节点不一致，不能映射到该作者');
  }
  const authorKind = author.kind === 'user' || author.kind === 'agent'
    ? author.kind
    : author.kind === undefined || author.kind === null || author.kind === '' ? 'unknown' : 'unknown';
  const authorName = text(author.display_name, MAX_TEXT);
  if (PLACEHOLDER.test(authorName)) throw new LocalDataError('invalid', '公开帖子作者名仍是模板占位');
  const publishedAt = rfc3339(value.published_at);
  if (publishedAt === '') throw new LocalDataError('invalid', '公开帖子 published_at 不是 RFC 3339');
  const bodyForSummary = bodyMarkdown.replace(/^\s*#\s+([^\n]+)(?:\r?\n)+/, (match, heading: string) => (
    heading.trim() === title ? '' : match
  ));
  const summary = text(value.summary, MAX_SUMMARY)
    || bodyForSummary.replace(/[#*_>`[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  const tags = collectTags(value.tags);
  let revision = 0;
  if (Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && Number(value.revision) <= Number.MAX_SAFE_INTEGER) {
    revision = Number(value.revision);
  }
  const images: LocalPostImage[] = [];
  if (schemaVersion === 2) {
    if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(value.id))) {
      throw new LocalDataError('invalid', '公开帖子 id 无效');
    }
    if (value.images !== undefined && !Array.isArray(value.images)) throw new LocalDataError('invalid', '公开帖子 images 必须是数组');
    if (Array.isArray(value.images) && value.images.length > 4) throw new LocalDataError('invalid', '公开帖子最多 4 张图片');
    const seenPaths = new Set<string>();
    let totalImageBytes = 0;
    for (const raw of Array.isArray(value.images) ? value.images : []) {
      if (!isRecord(raw)) throw new LocalDataError('invalid', '公开帖子图片条目无效');
      const imagePath = text(raw.path, 256);
      if (!/^images\/[a-f0-9]{64}\.(?:png|jpg)$/.test(imagePath)) {
        throw new LocalDataError('invalid', '公开帖子图片路径必须是 images/<sha256>.(png|jpg)');
      }
      if (seenPaths.has(imagePath)) throw new LocalDataError('invalid', '公开帖子不能重复引用同一图片');
      seenPaths.add(imagePath);
      const sha = validSha(raw.sha256);
      if (sha === '' || imagePath !== `images/${sha}${imagePath.endsWith('.png') ? '.png' : '.jpg'}`) {
        throw new LocalDataError('invalid', '公开帖子图片哈希与路径不一致');
      }
      const mime = raw.mime === 'image/png' || raw.mime === 'image/jpeg' ? raw.mime : '';
      if (mime === '' || (mime === 'image/png') !== imagePath.endsWith('.png')) {
        throw new LocalDataError('invalid', '公开帖子图片 MIME 与路径不一致');
      }
      const width = Number(raw.width);
      const height = Number(raw.height);
      const size = Number(raw.size_bytes);
      if (!Number.isSafeInteger(width) || width <= 0 || width > 8192 || !Number.isSafeInteger(height) || height <= 0 || height > 8192
        || width * height > 32 * 1024 * 1024
        || !Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024) {
        throw new LocalDataError('invalid', '公开帖子图片尺寸或大小无效');
      }
      totalImageBytes += size;
      if (totalImageBytes > 20 * 1024 * 1024) throw new LocalDataError('invalid', '公开帖子图片总量超过 20 MiB');
      images.push({ path: imagePath, sha256: sha, mime, width, height, sizeBytes: size });
    }
  }
  return {
    schemaVersion,
    title,
    summary,
    bodyMarkdown,
    tags,
    publishedAt,
    authorPeerId,
    authorKind,
    authorName,
    path: expectedPath,
    sha256: sha256(data),
    sizeBytes: data.length,
    revision,
    images,
  };
}

export async function readOwnProfile(dataDir: string): Promise<LocalOwnProfile> {
  try {
    const root = await realRoot(dataDir, 'public');
    const { data, stats } = await safeReadUnder(root, 'profile/index.md', MAX_PROFILE_BYTES);
    const markdown = data.toString('utf8');
    if (markdown.includes('\uFFFD')) {
      return { state: 'error', markdown: '', displayName: '', error: '公开档案不是有效 UTF-8', path: 'profile/index.md', at: stats.mtimeMs };
    }
    const heading = markdown.split(/\r?\n/).map((line) => /^#\s+(.+)$/.exec(line)?.[1]?.trim() ?? '').find((line) => line.length > 0) ?? '';
    return { state: 'available', markdown, displayName: text(heading, 80), error: '', path: 'profile/index.md', at: stats.mtimeMs };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', markdown: '', displayName: '', error: '本机公开档案 index.md 不存在', path: 'profile/index.md', at: null };
    }
    return { state: 'error', markdown: '', displayName: '', error: error instanceof Error ? error.message : String(error), path: 'profile/index.md', at: null };
  }
}

async function walkPublicPosts(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: 'posts', depth: 0 }];
  while (queue.length > 0 && files.length <= MAX_POSTS) {
    const { rel, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      const dir = path.join(root, safeRelative(rel));
      const stat = await lstatOrNull(dir);
      if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 4) queue.push({ rel: child, depth: depth + 1 });
      else if (entry.isFile() && POST_PATH.test(child)) {
        files.push(child);
        if (files.length > MAX_POSTS) return { files: files.slice(0, MAX_POSTS), truncated: true };
      }
    }
  }
  return { files, truncated: files.length > MAX_POSTS };
}

export async function readOwnPosts(dataDir: string, localPeerId: string): Promise<LocalOwnPosts> {
  const peer = canonicalPeer(localPeerId);
  const empty: LocalOwnPosts = {
    state: 'available', posts: [], error: '', unattributed: 0, agentAuthored: 0, invalid: 0, errors: [], truncated: false,
  };
  if (peer.length === 0) return { ...empty, state: 'error', error: '本机 Peer ID 无效，无法核对作者声明' };
  let root: string;
  try {
    root = await realRoot(dataDir, 'public');
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { ...empty, state: 'missing', error: '公开目录不存在' };
    }
    return { ...empty, state: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  let walked: { files: string[]; truncated: boolean };
  try {
    walked = await walkPublicPosts(root);
  } catch (error) {
    return { ...empty, state: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  const out: LocalOwnPosts = { ...empty, truncated: walked.truncated };
  for (const relative of walked.files) {
    try {
      const { data } = await safeReadUnder(root, relative, MAX_POST_BYTES);
      const post = parsePublicPost(data, relative, peer);
      if (post.authorKind === 'agent') out.agentAuthored += 1;
      if (post.authorKind === 'unknown') out.unattributed += 1;
      out.posts.push(post);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('作者声明') || message.includes('author')) out.unattributed += 1;
      else out.invalid += 1;
      if (out.errors.length < 10) out.errors.push({ path: relative, reason: message });
    }
  }
  out.posts.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return out;
}

/** Validate one content-addressed avatar triplet from profile.json v2. The
 * Agent avatar and the human avatar use distinct filename prefixes but the
 * same MIME/extension/hash-prefix rules. */
function parseProfileAvatar(
  source: Record<string, unknown>,
  prefix: string,
  label: string,
): { path: string; sha256: string; mime: string } {
  const avatarPath = text(source.avatar, 128);
  const avatarSha256 = validSha(source.avatar_sha256);
  const avatarMime = source.avatar_mime === 'image/png' || source.avatar_mime === 'image/jpeg' ? source.avatar_mime : '';
  if (avatarPath === '' && avatarSha256 === '' && avatarMime === '') return { path: '', sha256: '', mime: '' };
  if (!new RegExp(`^${prefix}-[a-f0-9]{8}\\.(?:png|jpg)$`).test(avatarPath)) {
    throw new LocalDataError('invalid', `公开资料${label}文件名无效`);
  }
  if (avatarSha256 === '' || avatarMime === '') throw new LocalDataError('invalid', `公开资料${label}缺少哈希或 MIME`);
  if ((avatarMime === 'image/png') !== avatarPath.endsWith('.png')) {
    throw new LocalDataError('invalid', `公开资料${label}扩展名与 MIME 不一致`);
  }
  if (avatarPath !== `${prefix}-${avatarSha256.slice(0, 8)}${avatarPath.endsWith('.png') ? '.png' : '.jpg'}`) {
    throw new LocalDataError('invalid', `公开资料${label}文件名与哈希不一致`);
  }
  return { path: `profile/${avatarPath}`, sha256: avatarSha256, mime: avatarMime };
}

/** Parse the canonical public profile.json v2. Invalid fields never become a
 * half-real profile: the caller falls back to agent-card.json/index.md. */
export function parsePublicProfile(data: Buffer): LocalPublicProfile {
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new LocalDataError('invalid', '公开资料不是有效 JSON');
  }
  if (!isRecord(value)) throw new LocalDataError('invalid', '公开资料必须是 JSON 对象');
  if (value.schema_version !== 2) throw new LocalDataError('invalid', '公开资料 schema_version 必须为 2');
  const agent = isRecord(value.agent) ? value.agent : null;
  const human = isRecord(value.human) ? value.human : null;
  if (agent === null) throw new LocalDataError('invalid', '公开资料缺少 agent 对象');
  const agentName = text(agent.name, 64);
  const agentDescription = text(agent.description, 2000);
  const agentConversationStyle = text(agent.conversation_style, 1000);
  const agentInterests = collectStringList(agent.interests, 10, 80);
  if (PLACEHOLDER.test(agentName) || PLACEHOLDER.test(agentDescription) || PLACEHOLDER.test(agentConversationStyle)) {
    throw new LocalDataError('invalid', '公开资料仍包含模板占位');
  }
  const humanName = human === null ? '' : text(human.name, 64);
  const humanBioMarkdown = human === null ? '' : text(human.bio_markdown, 4000);
  const avatar = parseProfileAvatar(agent, 'avatar', '头像');
  const humanAvatar = parseProfileAvatar(human ?? {}, 'human-avatar', '人类头像');
  return {
    schemaVersion: 2,
    agentName,
    agentDescription,
    agentInterests,
    agentConversationStyle,
    humanName,
    humanBioMarkdown,
    avatarPath: avatar.path,
    avatarSha256: avatar.sha256,
    avatarMime: avatar.mime,
    humanAvatarPath: humanAvatar.path,
    humanAvatarSha256: humanAvatar.sha256,
    humanAvatarMime: humanAvatar.mime,
    updatedAt: rfc3339(value.updated_at),
    path: 'profile/profile.json',
    sha256: sha256(data),
  };
}

export async function readOwnPublicProfile(dataDir: string): Promise<LocalPublicProfileRead> {
  try {
    const root = await realRoot(dataDir, 'public');
    const { data } = await safeReadUnder(root, 'profile/profile.json', 128 * 1024);
    return { state: 'available', profile: parsePublicProfile(data), error: '' };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', profile: null, error: '本机还没有公开资料 profile.json' };
    }
    return { state: 'error', profile: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read the optional public Agent card from this node's own public root. */
export async function readOwnAgentCard(dataDir: string, localPeerId: string): Promise<LocalAgentCardRead> {
  const peer = canonicalPeer(localPeerId);
  if (peer.length === 0) return { state: 'error', card: null, error: '本机 Peer ID 无效，无法核对 Agent 卡片' };
  try {
    const root = await realRoot(dataDir, 'public');
    const { data } = await safeReadUnder(root, 'profile/agent-card.json', MAX_AGENT_CARD_BYTES);
    const card = parseAgentCard(data, peer);
    return { state: 'available', card: { ...card, path: 'profile/agent-card.json', sha256: sha256(data) }, error: '' };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', card: null, error: '本机还没有公开 Agent 卡片（public/profile/agent-card.json）' };
    }
    return { state: 'error', card: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readOwnPublic(dataDir: string, localPeerId: string): Promise<OwnPublicData> {
  const [profile, posts, agentCard, publicProfile] = await Promise.all([
    readOwnProfile(dataDir),
    readOwnPosts(dataDir, localPeerId),
    readOwnAgentCard(dataDir, localPeerId),
    readOwnPublicProfile(dataDir),
  ]);
  return { profile, posts, agentCard, publicProfile };
}

export interface DiscoveryInput {
  peerId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}

/** Read the exact downloaded bytes for one discovery row and verify its evidence. */
export async function readDiscoveryPost(dataDir: string, discovery: DiscoveryInput): Promise<LocalPost> {
  const peer = canonicalPeer(discovery.peerId);
  if (peer.length === 0) throw new LocalDataError('invalid', '发现记录的 Peer ID 无效');
  if (!POST_PATH.test(discovery.path)) throw new LocalDataError('invalid', '发现记录路径不是公开帖子');
  const expectedSha = validSha(discovery.sha256);
  if (expectedSha === '') throw new LocalDataError('invalid', '发现记录缺少有效 SHA-256');
  const root = await realRoot(dataDir, 'downloads');
  const socketRoot = path.join(root, peer);
  const { data } = await safeReadUnder(socketRoot, discovery.path, MAX_POST_BYTES);
  if (data.length !== discovery.sizeBytes) throw new LocalDataError('invalid', '本地副本大小与发现记录不一致');
  if (sha256(data) !== expectedSha) throw new LocalDataError('invalid', '本地副本哈希与发现记录不一致，不能当作同一版本');
  return parsePublicPost(data, discovery.path, peer);
}

export function parseAgentCard(data: Buffer, servingPeerId: string): LocalAgentCard {
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new LocalDataError('invalid', 'Agent 公开卡片不是有效 JSON');
  }
  if (!isRecord(value)) throw new LocalDataError('invalid', 'Agent 公开卡片必须是 JSON 对象');
  if (value.schema_version !== 1) throw new LocalDataError('invalid', 'Agent 公开卡片 schema_version 必须为 1');
  const displayName = text(value.display_name, MAX_TEXT);
  if (displayName.length === 0) throw new LocalDataError('invalid', 'Agent 公开卡片缺少 display_name');
  if (PLACEHOLDER.test(displayName) || PLACEHOLDER.test(text(value.description, 2000)) || PLACEHOLDER.test(text(value.conversation_style, 1000))) {
    throw new LocalDataError('invalid', 'Agent 公开卡片仍包含模板占位');
  }
  return {
    schemaVersion: 1,
    displayName,
    description: text(value.description, 2000),
    interests: collectStringList(value.interests, 10, 80),
    conversationStyle: text(value.conversation_style, 1000),
    updatedAt: rfc3339(value.updated_at),
    path: '',
    sha256: sha256(data),
  };
}

export async function readDownloadedAgentCard(dataDir: string, peerId: string, relative: string, expectedSha: string, expectedSize: number): Promise<LocalAgentCardRead> {
  if (relative !== 'profile/agent-card.json') {
    return { state: 'error', card: null, error: '公开 Agent 卡片路径不在允许范围' };
  }
  const peer = canonicalPeer(peerId);
  if (peer.length === 0) return { state: 'error', card: null, error: 'Peer ID 无效' };
  try {
    const root = await realRoot(dataDir, 'downloads');
    const { data } = await safeReadUnder(path.join(root, peer), relative, MAX_AGENT_CARD_BYTES);
    const sha = validSha(expectedSha);
    if (sha !== '' && sha256(data) !== sha) return { state: 'error', card: null, error: '本地 Agent 卡片哈希与下载结果不一致' };
    if (expectedSize > 0 && data.length !== expectedSize) return { state: 'error', card: null, error: '本地 Agent 卡片大小与下载结果不一致' };
    const card = parseAgentCard(data, peer);
    return { state: 'available', card: { ...card, path: relative, sha256: sha || card.sha256 }, error: '' };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') return { state: 'missing', card: null, error: '对方没有下载到公开 Agent 卡片' };
    return { state: 'error', card: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseJourneyEvent(raw: unknown): JourneyEvent | null {
  if (!isRecord(raw)) return null;
  const type = text(raw.type, 80);
  if (type.length === 0) return null;
  const evidence = isRecord(raw.evidence_refs) ? raw.evidence_refs : {};
  const messageIds = collectStringList(evidence.message_ids, 20, 160);
  const contentPaths = collectStringList(evidence.content_paths, 20, 256);
  let messageEvidence: JourneyMessageEvidence | null = null;
  if (isRecord(raw.message_evidence)) {
    const item = raw.message_evidence;
    messageEvidence = {
      messageId: text(item.message_id, 160),
      peerId: canonicalPeer(item.peer_id),
      direction: text(item.direction, 16),
      summary: text(item.summary, 500),
      observedAt: text(item.observed_at, 64),
      createdAtUnixMs: text(item.created_at_unix_ms, 32),
      acked: booleanOrNull(item.acked),
      ackedAtUnixMs: text(item.acked_at_unix_ms, 32),
      contentSha256: validSha(item.content_sha256),
    };
    if (messageEvidence.messageId.length === 0) messageEvidence = null;
  }
  return {
    sequence: Number.isSafeInteger(Number(raw.sequence)) ? Number(raw.sequence) : 0,
    type,
    timestamp: text(raw.timestamp, 64),
    summary: text(raw.summary, 1000),
    peerId: canonicalPeer(raw.peer_id),
    sourcePeerId: canonicalPeer(raw.source_peer_id),
    messageIds,
    contentPaths,
    messageEvidence,
  };
}

function parseSessionState(raw: unknown): JourneySessionState {
  if (!isRecord(raw)) throw new LocalDataError('invalid', 'state.json 不是 JSON 对象');
  if (raw.schema_version !== 1) throw new LocalDataError('invalid', 'state.json schema_version 必须为 1');
  const status = text(raw.status, 32);
  if (!['running', 'paused', 'completed', 'failed'].includes(status)) throw new LocalDataError('invalid', 'state.json status 无效');
  return {
    status,
    mode: text(raw.mode, 64),
    intent: text(raw.intent, 2000),
    startedAt: rfc3339(raw.started_at),
    updatedAt: rfc3339(raw.updated_at),
    completedAt: rfc3339(raw.completed_at),
    completionReason: text(raw.completion_reason, 1000),
    summary: text(raw.summary, 1000),
    currentPeerId: canonicalPeer(raw.current_peer_id),
    visitedPeerIds: Array.isArray(raw.visited_peer_ids)
      ? raw.visited_peer_ids.map(canonicalPeer).filter((value: string) => value.length > 0).slice(0, 200)
      : [],
    discoverySources: collectStringList(raw.discovery_sources, 50, 256),
  };
}

/** The host supplies the file name. Only the selected session is readable. */
export async function readJourneyReportFile(
  dataDir: string,
  sessionId: string,
  relative: string,
  maxBytes: number,
): Promise<Buffer> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || ['.', '..', '__proto__'].includes(sessionId)) {
    throw new LocalDataError('invalid', '漫游会话 ID 无效');
  }
  const file = safeRelative(relative).split(path.sep).join('/');
  if (file !== 'report.html' && !file.startsWith('assets/')) {
    throw new LocalDataError('invalid', '漫游报告只能加载会话的 assets/ 素材');
  }
  const agent = await realRoot(dataDir, 'agent');
  return (await safeReadUnder(agent, `sessions/${sessionId}/${file}`, maxBytes)).data;
}

async function readJourneySession(base: string, id: string, dirModifiedAt: number): Promise<JourneySession> {
  const session: JourneySession = {
    id,
    dirModifiedAt,
    stateRead: 'missing',
    stateError: '',
    state: null,
    eventsRead: 'missing',
    eventsError: '',
    events: [],
    eventsTruncated: false,
    badEventLines: 0,
    reportRead: 'missing',
    reportError: '',
    reportMarkdown: '',
  };
  try {
    const { data } = await safeReadUnder(path.join(base, id), 'state.json', MAX_SESSION_STATE_BYTES);
    session.state = parseSessionState(JSON.parse(data.toString('utf8')));
    session.stateRead = 'available';
  } catch (error) {
    session.stateRead = error instanceof LocalDataError && error.code === 'missing' ? 'missing' : 'error';
    session.stateError = error instanceof Error ? error.message : String(error);
  }
  try {
    const { data } = await safeReadUnder(path.join(base, id), 'events.jsonl', MAX_EVENTS_BYTES);
    const textValue = data.toString('utf8');
    const lines = textValue.split(/\r?\n/);
    if (!textValue.endsWith('\n') && lines.length > 0) lines.pop();
    session.eventsRead = 'available';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      if (session.events.length >= MAX_EVENTS) {
        session.eventsTruncated = true;
        break;
      }
      try {
        const event = parseJourneyEvent(JSON.parse(line));
        if (event === null) session.badEventLines += 1;
        else session.events.push(event);
      } catch {
        session.badEventLines += 1;
      }
    }
  } catch (error) {
    session.eventsRead = error instanceof LocalDataError && error.code === 'missing' ? 'missing' : 'error';
    session.eventsError = error instanceof Error ? error.message : String(error);
  }
  try {
    const { data } = await safeReadUnder(path.join(base, id), 'report.md', MAX_REPORT_BYTES);
    const markdown = data.toString('utf8');
    if (markdown.includes('\uFFFD')) throw new LocalDataError('invalid', 'report.md 不是有效 UTF-8');
    session.reportMarkdown = markdown;
    session.reportRead = 'available';
  } catch (error) {
    session.reportRead = error instanceof LocalDataError && error.code === 'missing' ? 'missing' : 'error';
    session.reportError = error instanceof Error ? error.message : String(error);
  }
  session.events.sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return Date.parse(left.timestamp || '') - Date.parse(right.timestamp || '');
  });
  return session;
}

function journeyFailure(missing: JourneyData, error: unknown, persona?: LocalText, growth?: LocalText): JourneyData {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ...missing,
    state: 'error',
    persona: persona ?? { state: 'error', markdown: '', error: reason, sha256: '' },
    growth: growth ?? { state: 'error', markdown: '', error: reason, sha256: '' },
    sessionsState: 'error',
    sessionsError: reason,
  };
}

export async function readJourney(dataDir: string): Promise<JourneyData> {
  const missing: JourneyData = {
    state: 'missing',
    at: Date.now(),
    persona: { state: 'missing', markdown: '', error: 'agent/persona.md 不存在', sha256: '' },
    growth: { state: 'missing', markdown: '', error: 'agent/growth.md 不存在', sha256: '' },
    sessions: [],
    sessionsState: 'missing',
    sessionsError: 'agent/sessions 不存在',
    sessionsTruncated: false,
  };
  let agentRoot: string;
  try {
    agentRoot = await realRoot(dataDir, 'agent');
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') return missing;
    return journeyFailure(missing, error);
  }
  let rootStat: fs.Stats | null;
  try {
    rootStat = await lstatOrNull(agentRoot, 'agent');
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') return missing;
    return journeyFailure(missing, error);
  }
  if (rootStat === null) return missing;
  if (rootStat.isSymbolicLink()) {
    return journeyFailure(missing, new LocalDataError('symlink', 'agent 是符号链接，已拒绝读取'));
  }
  if (!rootStat.isDirectory()) {
    return journeyFailure(missing, new LocalDataError('invalid', 'agent 不是目录'));
  }
  const [persona, growth] = await Promise.all([
    readOptionalText(agentRoot, 'persona.md', MAX_PERSONA_BYTES),
    readOptionalText(agentRoot, 'growth.md', MAX_GROWTH_BYTES),
  ]);
  const sessionsRoot = path.join(agentRoot, 'sessions');
  let sessionsStat: fs.Stats | null;
  try {
    sessionsStat = await lstatOrNull(sessionsRoot, 'agent/sessions');
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { ...missing, state: 'available', persona, growth };
    }
    return journeyFailure(missing, error, persona, growth);
  }
  if (sessionsStat === null) {
    return { ...missing, state: 'available', persona, growth };
  }
  if (sessionsStat.isSymbolicLink()) {
    return journeyFailure(missing, new LocalDataError('symlink', 'agent/sessions 是符号链接，已拒绝读取'), persona, growth);
  }
  if (!sessionsStat.isDirectory()) {
    return journeyFailure(missing, new LocalDataError('invalid', 'agent/sessions 不是目录'), persona, growth);
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    return journeyFailure(missing, error, persona, growth);
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[A-Za-z0-9._-]{1,128}$/.test(entry.name) && entry.name !== '__proto__')
    .slice(0, MAX_SESSIONS);
  const sessions: JourneySession[] = [];
  for (const entry of dirs) {
    const directory = path.join(sessionsRoot, entry.name);
    let stat: fs.Stats | null;
    try {
      stat = await lstatOrNull(directory, entry.name);
    } catch (error) {
      return journeyFailure(missing, error, persona, growth);
    }
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    sessions.push(await readJourneySession(sessionsRoot, entry.name, stat.mtimeMs));
  }
  sessions.sort((left, right) => {
    const leftTime = Date.parse(left.state?.updatedAt || left.state?.startedAt || '') || left.dirModifiedAt;
    const rightTime = Date.parse(right.state?.updatedAt || right.state?.startedAt || '') || right.dirModifiedAt;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.id.localeCompare(right.id);
  });
  return {
    state: 'available',
    at: Date.now(),
    persona,
    growth,
    sessions,
    sessionsState: sessions.length === 0 ? 'missing' : 'available',
    sessionsError: sessions.length === 0 ? '还没有 Journey 记录' : '',
    sessionsTruncated: entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length > MAX_SESSIONS,
  };
}

// --- Private contact memory ------------------------------------------------
//
// Each memory.json is private Agent data under agent/contacts/<Peer ID>/.
// Reads and writes are bounded by 1 MiB, reject symlinks/traversal, and
// never expose a browser-supplied filesystem path. Saves preserve every
// unknown field and use optimistic SHA-256 concurrency plus atomic rename.

function emptyEvidenceRefs(): ContactEvidenceRefs {
  return { sessionIds: [], eventIds: [], messageIds: [], contentPaths: [], contentSha256: [] };
}

function parseEvidenceRefs(raw: unknown): ContactEvidenceRefs {
  if (!isRecord(raw)) return emptyEvidenceRefs();
  const digests = collectStringList(raw.content_sha256, 20, 64)
    .map((value) => validSha(value))
    .filter((value) => value.length > 0);
  return {
    sessionIds: collectStringList(raw.session_ids, 20, 128),
    eventIds: collectStringList(raw.event_ids, 20, 128),
    messageIds: collectStringList(raw.message_ids, 20, 160),
    contentPaths: collectStringList(raw.content_paths, 20, 256),
    contentSha256: digests,
  };
}

function contactRecordId(value: unknown, label: string): string {
  const id = text(value, 128);
  if (id === '' || CONTROL_TEST.test(id)) throw new LocalDataError('invalid', `${label} 缺少有效 id`);
  return id;
}

function parseContactObservation(raw: unknown): ContactObservation {
  if (!isRecord(raw)) throw new LocalDataError('invalid', '联系人观察必须是对象');
  const hasObservedAt = raw.observed_at !== undefined && raw.observed_at !== null;
  const observedAt = hasObservedAt ? rfc3339(raw.observed_at) : '';
  if (hasObservedAt && observedAt === '') throw new LocalDataError('invalid', '联系人观察缺少有效 observed_at');
  const summary = text(raw.summary, 2000);
  if (summary === '') throw new LocalDataError('invalid', '联系人观察缺少摘要');
  return {
    id: contactRecordId(raw.id, '联系人观察'),
    summary,
    observedAt,
    evidenceRefs: parseEvidenceRefs(raw.evidence_refs),
  };
}

function parseContactImpression(raw: unknown): ContactImpression {
  if (!isRecord(raw)) throw new LocalDataError('invalid', '联系人印象必须是对象');
  const uncertainty = raw.uncertainty === 'low' || raw.uncertainty === 'medium' || raw.uncertainty === 'high'
    ? raw.uncertainty
    : '';
  const summary = text(raw.summary, 2000);
  if (summary === '') throw new LocalDataError('invalid', '联系人印象缺少摘要');
  return {
    id: contactRecordId(raw.id, '联系人印象'),
    summary,
    uncertainty,
    createdAt: rfc3339(raw.created_at),
    updatedAt: rfc3339(raw.updated_at),
    evidenceRefs: parseEvidenceRefs(raw.evidence_refs),
  };
}

function parseContactCuriosity(raw: unknown): ContactCuriosity {
  if (!isRecord(raw)) throw new LocalDataError('invalid', '联系人好奇必须是对象');
  const question = text(raw.question, 2000);
  if (question === '') throw new LocalDataError('invalid', '联系人好奇缺少问题');
  return {
    id: contactRecordId(raw.id, '联系人好奇'),
    question,
    createdAt: rfc3339(raw.created_at),
    evidenceRefs: parseEvidenceRefs(raw.evidence_refs),
  };
}

function parseContactNote(raw: unknown): ContactNote {
  if (!isRecord(raw)) throw new LocalDataError('invalid', 'contact-notes 联系人必须是对象');
  const peerId = canonicalPeer(raw.peer_id);
  if (peerId === '') throw new LocalDataError('invalid', 'contact-notes 联系人 peer_id 无效');
  const parseList = <T>(value: unknown, label: string, parser: (item: unknown) => T): T[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new LocalDataError('invalid', `contact-notes ${label} 必须是数组`);
    if (value.length > 200) throw new LocalDataError('too_large', `contact-notes ${label} 超过 200 条`);
    return value.map(parser);
  };
  return {
    peerId,
    displayNameSnapshot: text(raw.display_name_snapshot, MAX_TEXT),
    updatedAt: rfc3339(raw.updated_at),
    observations: parseList(raw.observations, 'observations', parseContactObservation),
    impressions: parseList(raw.impressions, 'impressions', parseContactImpression),
    curiosities: parseList(raw.curiosities, 'curiosities', parseContactCuriosity),
  };
}

function parseContactMemoryObject(data: Buffer, peerId: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new LocalDataError('invalid', 'memory.json 不是有效的 UTF-8 JSON');
  }
  if (!isRecord(value) || value.schema_version !== 2) {
    throw new LocalDataError('invalid', 'memory.json 必须是 schema_version 为 2 的对象');
  }
  if (canonicalPeer(value.peer_id) !== peerId) {
    throw new LocalDataError('invalid', 'memory.json 的 peer_id 与联系人不一致');
  }
  return value;
}

/** Read only the selected contact's private file. */
export async function readContactNotes(dataDir: string, inputPeerId: string): Promise<LocalContactNotes> {
  const peerId = canonicalPeer(inputPeerId);
  if (peerId === '') throw new LocalDataError('invalid', 'Peer ID 格式无效');
  const missing: LocalContactNotes = {
    state: 'missing', schemaVersion: 0, contact: null, sha256: '', error: '', at: Date.now(),
  };
  try {
    const agentRoot = await realRoot(dataDir, 'agent');
    const { data } = await safeReadUnder(agentRoot, `contacts/${peerId}/memory.json`, MAX_CONTACT_NOTES_BYTES);
    const contact = parseContactNote(parseContactMemoryObject(data, peerId));
    return { ...missing, state: 'available', schemaVersion: 2, contact, sha256: sha256(data) };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') return missing;
    return { ...missing, state: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

const contactNoteSaveQueues = new Map<string, Promise<unknown>>();

function validUncertainty(value: unknown): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new LocalDataError('invalid', '印象不确定性必须是 low、medium 或 high');
}

function impressionIdFor(now: Date): string {
  return `imp-${now.getTime().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

async function performContactImpressionSave(
  dataDir: string,
  input: ContactImpressionSaveInput,
): Promise<ContactImpressionSave> {
  const peerId = canonicalPeer(input.peerId);
  if (peerId === '') throw new LocalDataError('invalid', 'Peer ID 格式无效');
  const summary = String(input.summary ?? '').replace(/\u0000/g, '').trim();
  if (summary.length === 0) throw new LocalDataError('invalid', '印象内容不能为空');
  if ([...summary].length > 2000) throw new LocalDataError('invalid', '印象内容超过 2000 字符');
  if (Buffer.byteLength(summary, 'utf8') > 8000) throw new LocalDataError('too_large', '印象内容超过 8000 字节');
  const uncertainty = validUncertainty(input.uncertainty);
  const wantedId = text(input.impressionId, 128);
  if (wantedId !== '' && !/^[A-Za-z0-9._:-]{1,128}$/.test(wantedId)) {
    throw new LocalDataError('invalid', '印象 id 格式无效');
  }
  const expected = typeof input.expectedSha256 === 'string' ? input.expectedSha256.trim().toLowerCase() : '';
  if (expected !== '' && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new LocalDataError('invalid', '版本哈希格式无效，未保存');
  }
  const agent = await privateAgentRoot(dataDir);
  const contacts = await ensurePrivateChild(agent, 'contacts');
  const root = await ensurePrivateChild(contacts, peerId);
  const target = path.join(root, 'memory.json');
  const current = await readPrivateBytes(target, 'memory.json', MAX_CONTACT_NOTES_BYTES);
  const currentSha = current === null ? '' : sha256(current);
  if (expected !== currentSha) {
    throw new LocalDataError('conflict', 'memory.json 已在别处修改，未覆盖；请重新读取后再保存');
  }
  const now = new Date();
  const nowIso = now.toISOString();
  if (current === null && wantedId !== '') {
    throw new LocalDataError('missing', '联系人没有可编辑的私有印象');
  }
  const contact = current === null ? {
    schema_version: 2,
    peer_id: peerId,
    display_name_snapshot: '',
    observations: [],
    impressions: [],
    curiosities: [],
  } : parseContactMemoryObject(current, peerId);
  const impressions = contact.impressions ?? [];
  if (!Array.isArray(impressions)) {
    throw new LocalDataError('invalid', '联系人 impressions 必须是数组');
  }
  contact.impressions = impressions;
  let targetImpression: Record<string, unknown> | null = null;
  if (wantedId !== '') {
    for (const candidate of impressions) {
      if (isRecord(candidate) && text(candidate.id, 128) === wantedId) {
        targetImpression = candidate;
        break;
      }
    }
    if (targetImpression === null) throw new LocalDataError('missing', '要编辑的私有印象不在 memory.json 中');
  }
  if (targetImpression === null) {
    if (impressions.length >= 200) throw new LocalDataError('too_large', '单个联系人的印象超过 200 条');
    targetImpression = {
      id: impressionIdFor(now),
      summary,
      uncertainty,
      created_at: nowIso,
      updated_at: nowIso,
      evidence_refs: { session_ids: [], event_ids: [], message_ids: [], content_paths: [], content_sha256: [] },
    };
    impressions.push(targetImpression);
  } else {
    targetImpression.summary = summary;
    targetImpression.uncertainty = uncertainty;
    targetImpression.updated_at = nowIso;
  }
  contact.updated_at = nowIso;
  const bytes = Buffer.from(`${JSON.stringify(contact, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_CONTACT_NOTES_BYTES) {
    throw new LocalDataError('too_large', `memory.json 超过 ${MAX_CONTACT_NOTES_BYTES} 字节上限`);
  }
  const savedContact = parseContactNote(contact);
  const digest = sha256(bytes);

  const stamp = nowIso.replace(/[-:.TZ]/g, '');
  if (current !== null) {
    const backupName = `memory.json.bak-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await fsp.writeFile(path.join(root, backupName), current, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw fsFailure(error, 'memory.json 备份');
    }
  }
  const temp = path.join(root, `.memory.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(temp, 0o600);
    const commitCurrent = await readPrivateBytes(target, 'memory.json', MAX_CONTACT_NOTES_BYTES);
    const commitSha = commitCurrent === null ? '' : sha256(commitCurrent);
    if (commitSha !== currentSha) {
      throw new LocalDataError('conflict', 'memory.json 在准备写入期间被别处修改，未覆盖；请重新读取后再保存');
    }
    await fsp.rename(temp, target);
    let directory: fsp.FileHandle | null = null;
    try {
      directory = await fsp.open(root, 'r');
      await directory.sync();
    } catch {
      // Directory fsync is not available on every platform.
    } finally {
      await directory?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (error instanceof LocalDataError) throw error;
    throw fsFailure(error, 'memory.json 保存');
  }
  return {
    saved: true,
    sha256: digest,
    savedAt: Date.now(),
    contact: savedContact,
  };
}

/** Save one private contact impression with optimistic hash conflict checks.
 * Saves for the same contact are serialized in-process. */
export async function saveContactImpression(
  dataDir: string,
  input: ContactImpressionSaveInput,
): Promise<ContactImpressionSave> {
  const peerId = canonicalPeer(input.peerId);
  if (peerId === '') throw new LocalDataError('invalid', 'Peer ID 格式无效');
  const key = path.resolve(dataDir, 'agent', 'contacts', peerId);
  const previous = contactNoteSaveQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => performContactImpressionSave(dataDir, input));
  contactNoteSaveQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (contactNoteSaveQueues.get(key) === run) contactNoteSaveQueues.delete(key);
  }
}

// --- Generic public-file access -------------------------------------------
//
// The workspace lists only paths from the daemon's Published manifest. These
// helpers keep the filesystem boundary: a path supplied by the browser is
// re-validated under one resolved root, symlinks are rejected and reads are
// bounded.

// The Mine page lists only paths returned by the daemon's Published RPC, then
// reads each controlled path without expanding the published set.
export const MAX_MINE_FILES = 500;
export const MAX_MINE_HASH_BYTES = 128 * 1024 * 1024;

/** Read one public file after the same root/symlink/size checks as profiles. */
export async function readPublicFile(dataDir: string, relative: string, maxBytes: number): Promise<Buffer> {
  const root = await realRoot(dataDir, 'public');
  const { data } = await safeReadUnder(root, relative, maxBytes);
  return data;
}

export interface LocalFileVersion {
  size: number;
  modifiedAt: number;
  sha256: string;
}

/** Hash one controlled public file without keeping its bytes in memory. Used
 * by the Mine list, whose authority is the daemon's Published manifest. */
export async function hashPublicFile(
  dataDir: string,
  relative: string,
  maxBytes: number,
): Promise<LocalFileVersion & { absolutePath: string }> {
  const root = await realRoot(dataDir, 'public');
  const absolutePath = await originalPathUnder(root, relative, '公开文件');
  const version = await hashControlledFile(absolutePath, relative, maxBytes);
  return { ...version, absolutePath };
}

/** Resolve a controlled public original for a Host reveal-only action. The
 * caller must first constrain the path to the daemon's Published manifest. */
export async function publicOriginalPath(dataDir: string, relative: string): Promise<string> {
  const root = await realRoot(dataDir, 'public');
  return originalPathUnder(root, relative, '公开文件');
}

/** Read one downloaded original under downloads/<peer>/. */
export async function readDownloadedFile(
  dataDir: string,
  peerId: string,
  relative: string,
  maxBytes: number,
): Promise<Buffer> {
  const peer = canonicalPeer(peerId);
  if (peer.length === 0) throw new LocalDataError('invalid', 'Peer ID 无效');
  const root = await realRoot(dataDir, 'downloads');
  const { data } = await safeReadUnder(path.join(root, peer), relative, maxBytes);
  return data;
}

/** Read the exact downloaded bytes for one discovery row and verify hash/size. */
export async function readDiscoveryFile(
  dataDir: string,
  discovery: DiscoveryInput,
  maxBytes: number,
): Promise<Buffer> {
  const peer = canonicalPeer(discovery.peerId);
  if (peer.length === 0) throw new LocalDataError('invalid', '发现记录的 Peer ID 无效');
  const expectedSha = validSha(discovery.sha256);
  if (expectedSha === '') throw new LocalDataError('invalid', '发现记录缺少有效 SHA-256');
  const root = await realRoot(dataDir, 'downloads');
  const { data } = await safeReadUnder(path.join(root, peer), discovery.path, maxBytes);
  if (data.length !== discovery.sizeBytes) throw new LocalDataError('invalid', '本地副本大小与发现记录不一致');
  if (sha256(data) !== expectedSha) throw new LocalDataError('invalid', '本地副本哈希与发现记录不一致，不能当作同一版本');
  return data;
}

/** Verify one path component by component under an already resolved root and
 * return its real absolute path. Symlinks and escapes are rejected. */
async function originalPathUnder(root: string, relative: string, label: string): Promise<string> {
  const rel = safeRelative(relative);
  const rootStat = await lstatOrNull(root, label);
  if (rootStat === null) throw new LocalDataError('missing', `${label}控制目录不存在`);
  if (rootStat.isSymbolicLink()) throw new LocalDataError('symlink', `${label}控制目录是符号链接`);
  if (!rootStat.isDirectory()) throw new LocalDataError('invalid', `${label}控制目录不是目录`);
  let current = root;
  const parts = rel.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const component = parts.slice(0, index + 1).join('/');
    const stat = await lstatOrNull(current, component);
    if (stat === null) throw new LocalDataError('missing', `${component} 不存在`);
    if (stat.isSymbolicLink()) throw new LocalDataError('symlink', `${component} 是符号链接，已拒绝读取`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new LocalDataError('invalid', `${component} 不是目录`);
    } else if (!stat.isFile()) {
      throw new LocalDataError('invalid', `${relative} 不是普通文件`);
    }
  }
  let real: string;
  try {
    real = await fsp.realpath(current);
  } catch (error) {
    throw fsFailure(error, relative);
  }
  if (!inside(root, real)) throw new LocalDataError('symlink', `${relative} 解析后越过受控根目录`);
  return real;
}

/** Stream one already-controlled regular file through SHA-256. O_NOFOLLOW
 * keeps the final component from being swapped for a symlink at open time. */
async function hashControlledFile(absolutePath: string, relative: string, maxBytes: number): Promise<LocalFileVersion> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw fsFailure(error, relative);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
    if (stats.size > maxBytes) {
      throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节核对上限`);
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节核对上限`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { size: total, modifiedAt: stats.mtimeMs, sha256: digest.digest('hex') };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Verify that one downloaded original still exists as a regular file and
 * return its absolute path for the Host's reveal-only action. */
export async function downloadedOriginalPath(dataDir: string, peerId: string, relative: string): Promise<string> {
  const peer = canonicalPeer(peerId);
  if (peer.length === 0) throw new LocalDataError('invalid', 'Peer ID 无效');
  const root = await realRoot(dataDir, 'downloads');
  return originalPathUnder(path.join(root, peer), relative, '下载副本');
}

/** Hash one downloaded original under downloads/<peer>/. */
export async function hashDownloadedFile(
  dataDir: string,
  peerId: string,
  relative: string,
  maxBytes: number,
): Promise<LocalFileVersion & { absolutePath: string }> {
  const absolutePath = await downloadedOriginalPath(dataDir, peerId, relative);
  const version = await hashControlledFile(absolutePath, relative, maxBytes);
  return { ...version, absolutePath };
}

export interface DownloadedFileInfo {
  absolutePath: string;
  size: number;
  modifiedAt: number;
}

/** Stat one downloaded original without reading it. Rejects symlinks and any
 * component outside downloads/<peer>/. */
export async function downloadedFileInfo(dataDir: string, peerId: string, relative: string): Promise<DownloadedFileInfo> {
  const absolutePath = await downloadedOriginalPath(dataDir, peerId, relative);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (error) {
    throw fsFailure(error, relative);
  }
  if (!stat.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
  return { absolutePath, size: stat.size, modifiedAt: stat.mtimeMs };
}

/** Read the downloaded public profile without touching the network. */
export interface LocalDownloadedProfile {
  state: LocalState;
  markdown: string;
  displayName: string;
  error: string;
}

/** Avatar metadata is stored without bytes and without a URL. The bytes are
 * re-read from downloads/<peer>/ and hash/size/magic checked on every load. */
export interface ContactProjectionAvatar {
  path: string;
  sha256: string;
  mime: string;
  sizeBytes: number;
}

export interface ContactProjectionProfile {
  peerId: string;
  displayName: string;
  description: string;
  interests: string[];
  conversationStyle: string;
  avatar: ContactProjectionAvatar | null;
  source: string;
  verifiedAt: number;
  /** Runtime-only fields added by readContactProjection, never persisted. */
  avatarKey?: string;
  avatarUrl?: string;
  avatarMime?: string;
  avatarSha256?: string;
  avatarSizeBytes?: number;
  avatarState?: 'none' | 'ready' | 'missing' | 'unreadable' | 'hash-mismatch' | 'skipped';
  avatarError?: string;
}

export interface ContactProjectionClue {
  peerId: string;
  name: string;
  description: string;
  sourcePeerId: string;
  sourceName: string;
  readAt: number;
}

export interface ContactProjectionData {
  schemaVersion: 1;
  updatedAt: number;
  profiles: ContactProjectionProfile[];
  clues: ContactProjectionClue[];
}

export interface ContactProjectionRead {
  state: 'available' | 'missing' | 'error';
  updatedAt: number;
  profiles: ContactProjectionProfile[];
  clues: ContactProjectionClue[];
  error: string;
}

export async function readDownloadedProfile(dataDir: string, peerId: string): Promise<LocalDownloadedProfile> {
  try {
    const data = await readDownloadedFile(dataDir, peerId, 'profile/index.md', MAX_PROFILE_BYTES);
    const markdown = data.toString('utf8');
    if (markdown.includes('\uFFFD')) {
      return { state: 'error', markdown: '', displayName: '', error: '本地公开档案不是有效 UTF-8' };
    }
    const displayName = markdown.split(/\r?\n/)
      .map((line) => /^#\s+(.+)$/.exec(line)?.[1]?.trim() ?? '')
      .find((line) => line.length > 0) ?? '';
    return { state: 'available', markdown, displayName: text(displayName, 80), error: '' };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', markdown: '', displayName: '', error: '本机没有对方公开档案的历史副本' };
    }
    return { state: 'error', markdown: '', displayName: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read the first heading of a downloaded public profile when it exists. */
export async function readDownloadedProfileName(dataDir: string, peerId: string): Promise<string> {
  const profile = await readDownloadedProfile(dataDir, peerId);
  return profile.state === 'available' ? profile.displayName : '';
}


// --- Contact-list local projection ----------------------------------------
//
// The contact list must not dial, download, read a profile, or read a remote
// address book just to paint rows. The host therefore keeps a small private
// snapshot of public facts that an explicit profile/directory read already
// returned. This module owns the fixed path and all validation:
//
//   <data-dir>/agent/host/dsh/contact-list.json   (0600, private)
//
// It stores names/description/avatar metadata/source claims only. Avatar bytes
// stay in the existing downloads/<peer>/ tree; a data URL is computed in
// memory after re-checking size, SHA-256 and the image signature. The browser
// never receives a filesystem path, and the projection is never written under
// public/.

function epochMillis(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function validContactProjectionAvatar(value: unknown): ContactProjectionAvatar | null {
  if (!isRecord(value)) return null;
  const avatarPath = text(value.path, 128);
  const match = CONTACT_AVATAR_PATH.exec(avatarPath);
  const avatarSha = validSha(value.sha256);
  const mime = value.mime === 'image/png' || value.mime === 'image/jpeg' ? value.mime : '';
  const sizeBytes = Number(value.size ?? value.sizeBytes);
  if (match === null || avatarSha === '' || mime === '') return null;
  const extension = match[2] === 'png' ? 'image/png' : 'image/jpeg';
  if (mime !== extension) return null;
  if (avatarSha.slice(0, 8) !== match[1]) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_CONTACT_PROJECTION_AVATAR_BYTES) return null;
  return { path: avatarPath, sha256: avatarSha, mime, sizeBytes };
}

function avatarSignatureError(avatar: ContactProjectionAvatar, data: Buffer): string {
  if (avatar.mime === 'image/png') {
    const png = data.length >= 8
      && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
      && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
    return png ? '' : '本地头像字节与声明的 PNG 类型不一致';
  }
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return jpeg ? '' : '本地头像字节与声明的 JPEG 类型不一致';
}

function parseContactProjection(data: Buffer): ContactProjectionData {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    throw new LocalDataError('invalid', '联系人本地投影不是有效 JSON');
  }
  if (!isRecord(raw)) throw new LocalDataError('invalid', '联系人本地投影必须是 JSON 对象');
  if (raw.schema_version !== 1) throw new LocalDataError('invalid', '联系人本地投影 schema_version 必须为 1');
  if (!Array.isArray(raw.profiles) || !Array.isArray(raw.clues)) {
    throw new LocalDataError('invalid', '联系人本地投影缺少 profiles 或 clues 数组');
  }
  const profiles = new Map<string, ContactProjectionProfile>();
  for (const item of raw.profiles.slice(0, MAX_CONTACT_PROJECTION_PROFILES)) {
    if (!isRecord(item)) continue;
    const peerId = canonicalPeer(item.peer_id);
    const displayName = text(item.display_name, 80);
    if (peerId === '' || displayName === '') continue;
    const verifiedAt = epochMillis(item.verified_at);
    if (verifiedAt === 0) continue;
    const previous = profiles.get(peerId);
    if (previous !== undefined && previous.verifiedAt > verifiedAt) continue;
    profiles.set(peerId, {
      peerId,
      displayName,
      description: text(item.description, 400),
      interests: collectStringList(item.interests, 10, 80),
      conversationStyle: text(item.conversation_style, 300),
      avatar: validContactProjectionAvatar(item.avatar),
      source: text(item.source, 40) || 'remote-profile',
      verifiedAt,
    });
  }
  const clues = new Map<string, ContactProjectionClue>();
  for (const item of raw.clues.slice(0, MAX_CONTACT_PROJECTION_CLUES)) {
    if (!isRecord(item)) continue;
    const peerId = canonicalPeer(item.peer_id);
    const sourcePeerId = canonicalPeer(item.source_peer_id);
    const name = text(item.name, 120);
    const readAt = epochMillis(item.read_at);
    if (peerId === '' || sourcePeerId === '' || name === '' || readAt === 0) continue;
    if (peerId === sourcePeerId) continue;
    const key = `${sourcePeerId}\u0000${peerId}`;
    const previous = clues.get(key);
    if (previous !== undefined && previous.readAt > readAt) continue;
    clues.set(key, {
      peerId,
      name,
      description: text(item.description, 280),
      sourcePeerId,
      sourceName: text(item.source_name, 80) || `节点 ${sourcePeerId.slice(0, 10)}…`,
      readAt,
    });
  }
  return {
    schemaVersion: 1,
    updatedAt: epochMillis(raw.updated_at) || Math.max(0, ...[...profiles.values()].map((item) => item.verifiedAt)),
    profiles: [...profiles.values()].sort((left, right) => right.verifiedAt - left.verifiedAt),
    clues: [...clues.values()].sort((left, right) => right.readAt - left.readAt),
  };
}

function contactProjectionForStorage(projection: ContactProjectionData): Buffer {
  const profiles = [];
  const newestProfiles = [...projection.profiles]
    .sort((left, right) => epochMillis(right.verifiedAt) - epochMillis(left.verifiedAt));
  for (const item of newestProfiles.slice(0, MAX_CONTACT_PROJECTION_PROFILES)) {
    const peerId = canonicalPeer(item.peerId);
    const displayName = text(item.displayName, 80);
    const verifiedAt = epochMillis(item.verifiedAt);
    if (peerId === '' || displayName === '' || verifiedAt === 0) continue;
    const avatar = validContactProjectionAvatar(item.avatar);
    profiles.push({
      peer_id: peerId,
      display_name: displayName,
      description: text(item.description, 400),
      interests: collectStringList(item.interests, 10, 80),
      conversation_style: text(item.conversationStyle, 300),
      avatar: avatar === null ? null : {
        path: avatar.path,
        sha256: avatar.sha256,
        mime: avatar.mime,
        size: avatar.sizeBytes,
      },
      source: text(item.source, 40) || 'remote-profile',
      verified_at: verifiedAt,
    });
  }
  const clues = [];
  const newestClues = [...projection.clues]
    .sort((left, right) => epochMillis(right.readAt) - epochMillis(left.readAt));
  for (const item of newestClues.slice(0, MAX_CONTACT_PROJECTION_CLUES)) {
    const peerId = canonicalPeer(item.peerId);
    const sourcePeerId = canonicalPeer(item.sourcePeerId);
    const name = text(item.name, 120);
    const readAt = epochMillis(item.readAt);
    if (peerId === '' || sourcePeerId === '' || name === '' || readAt === 0 || peerId === sourcePeerId) continue;
    clues.push({
      peer_id: peerId,
      name,
      description: text(item.description, 280),
      source_peer_id: sourcePeerId,
      source_name: text(item.sourceName, 80) || `节点 ${sourcePeerId.slice(0, 10)}…`,
      read_at: readAt,
    });
  }
  const bytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    updated_at: epochMillis(projection.updatedAt) || Date.now(),
    profiles,
    clues,
  }, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_CONTACT_PROJECTION_BYTES) {
    throw new LocalDataError('too_large', `联系人本地投影超过 ${MAX_CONTACT_PROJECTION_BYTES} 字节上限`);
  }
  return bytes;
}

async function readProjectionAvatar(
  dataDir: string,
  profile: ContactProjectionProfile,
): Promise<{ key: string; dataUrl: string }> {
  const avatar = profile.avatar;
  if (avatar === null) throw new LocalDataError('missing', '没有已核对的公开头像');
  const data = await readDownloadedFile(dataDir, profile.peerId, avatar.path, MAX_CONTACT_PROJECTION_AVATAR_BYTES);
  if (data.length !== avatar.sizeBytes) {
    throw new LocalDataError('invalid', '本地头像大小与已核对版本不一致，未展示');
  }
  if (sha256(data) !== avatar.sha256) {
    throw new LocalDataError('invalid', '本地头像哈希与已核对版本不一致，未展示');
  }
  const signatureError = avatarSignatureError(avatar, data);
  if (signatureError !== '') throw new LocalDataError('invalid', signatureError);
  return {
    key: `${profile.peerId}\u0000${avatar.path}\u0000${avatar.sha256}\u0000${avatar.sizeBytes}`,
    dataUrl: `data:${avatar.mime};base64,${data.toString('base64')}`,
  };
}

/**
 * Read the host-owned contact projection without any network/API action.
 * `avatars: false` is used by the host's read-modify-write path so a merge
 * never loads image bytes. Every available avatar is re-verified against the
 * stored size/SHA-256 and the PNG/JPEG signature before it becomes a data URL.
 */
export async function readContactProjection(
  dataDir: string,
  options: { avatars?: boolean } = {},
): Promise<ContactProjectionRead> {
  let agentRoot: string;
  try {
    agentRoot = await realRoot(dataDir, 'agent');
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', updatedAt: 0, profiles: [], clues: [], error: '' };
    }
    return {
      state: 'error', updatedAt: 0, profiles: [], clues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let projection: ContactProjectionData;
  try {
    const { data } = await safeReadUnder(agentRoot, 'host/dsh/contact-list.json', MAX_CONTACT_PROJECTION_BYTES);
    projection = parseContactProjection(data);
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', updatedAt: 0, profiles: [], clues: [], error: '' };
    }
    return {
      state: 'error', updatedAt: 0, profiles: [], clues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (options.avatars === false) {
    return { state: 'available', updatedAt: projection.updatedAt, profiles: projection.profiles, clues: projection.clues, error: '' };
  }
  let budget = MAX_CONTACT_PROJECTION_AVATAR_TOTAL;
  const profiles: ContactProjectionProfile[] = [];
  for (const profile of projection.profiles) {
    if (profile.avatar === null) {
      profiles.push({ ...profile, avatarState: 'none' });
      continue;
    }
    const size = profile.avatar.sizeBytes;
    if (size > budget) {
      profiles.push({
        ...profile, avatarState: 'skipped',
        avatarKey: `${profile.peerId}\u0000${profile.avatar.path}\u0000${profile.avatar.sha256}\u0000${size}`,
        avatarError: '本次头像读取预算不足，稍后打开档案可重新核对',
      });
      continue;
    }
    budget -= size;
    try {
      const hydrated = await readProjectionAvatar(dataDir, profile);
      profiles.push({
        ...profile,
        avatarKey: hydrated.key,
        avatarUrl: hydrated.dataUrl,
        avatarMime: profile.avatar.mime,
        avatarSha256: profile.avatar.sha256,
        avatarSizeBytes: size,
        avatarState: 'ready',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof LocalDataError ? error.code : 'unreadable';
      profiles.push({
        ...profile,
        avatarKey: `${profile.peerId}\u0000${profile.avatar.path}\u0000${profile.avatar.sha256}\u0000${size}`,
        avatarState: code === 'missing' ? 'missing' : /哈希|大小|不一致/.test(message) ? 'hash-mismatch' : 'unreadable',
        avatarError: message,
      });
    }
  }
  return { state: 'available', updatedAt: projection.updatedAt, profiles, clues: projection.clues, error: '' };
}

async function ensurePrivateChild(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  if (!inside(parent, target)) throw new LocalDataError('invalid', '私有投影目录越界');
  let stat = await lstatOrNull(target, name);
  if (stat === null) {
    try {
      await fsp.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (fsErrorCode(error) !== 'EEXIST') throw fsFailure(error, name);
    }
    stat = await lstatOrNull(target, name);
  }
  if (stat === null) throw new LocalDataError('unreadable', `${name} 目录无法创建`);
  if (stat.isSymbolicLink()) throw new LocalDataError('symlink', `${name} 是符号链接，已拒绝保存`);
  if (!stat.isDirectory()) throw new LocalDataError('invalid', `${name} 不是目录`);
  let real: string;
  try {
    real = await fsp.realpath(target);
  } catch (error) {
    throw fsFailure(error, name);
  }
  if (!inside(parent, real)) throw new LocalDataError('symlink', `${name} 解析后越过私有目录`);
  try {
    await fsp.chmod(real, 0o700);
  } catch (error) {
    throw fsFailure(error, `${name} 目录权限`);
  }
  return real;
}

/** Atomically replace the private contact projection with validated data. */
export async function writeContactProjection(dataDir: string, projection: ContactProjectionData): Promise<void> {
  const agentRoot = await privateAgentRoot(dataDir);
  const hostRoot = await ensurePrivateChild(agentRoot, 'host');
  const hostSpecific = await ensurePrivateChild(hostRoot, 'dsh');
  const target = path.join(hostSpecific, 'contact-list.json');
  const existing = await lstatOrNull(target, 'contact-list.json');
  if (existing !== null && existing.isSymbolicLink()) {
    throw new LocalDataError('symlink', '联系人本地投影是符号链接，已拒绝保存');
  }
  if (existing !== null && !existing.isFile()) {
    throw new LocalDataError('invalid', '联系人本地投影不是普通文件，已拒绝保存');
  }
  const bytes = contactProjectionForStorage(projection);
  const temp = path.join(hostSpecific, `.contact-list.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, target);
    let directory: fsp.FileHandle | null = null;
    try {
      directory = await fsp.open(hostSpecific, 'r');
      await directory.sync();
    } catch {
      // Directory fsync is not available on every platform.
    } finally {
      await directory?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (error instanceof LocalDataError) throw error;
    throw fsFailure(error, '联系人本地投影保存');
  }
}


// --- Private Agent Markdown saves -----------------------------------------
//
// P1 keeps private Persona/Growth editing local-only. The browser supplies no
// absolute path: `field` is mapped to one fixed filename under `agent/`. Saves
// use optimistic SHA-256 concurrency control, a 0600 temp file, fsync, rename
// and a directory fsync. A failed save never overwrites the previous file.

export interface PrivateAgentSave {
  saved: true;
  field: 'persona' | 'growth';
  sha256: string;
  savedAt: number;
  backupName: string;
}

const PRIVATE_FIELDS = {
  persona: 'persona.md',
  growth: 'growth.md',
} as const;

const privateSaveQueues = new Map<string, Promise<unknown>>();

async function privateAgentRoot(dataDir: string): Promise<string> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new LocalDataError('unreadable', '宿主没有提供数据目录');
  }
  let real: string;
  try {
    real = await fsp.realpath(path.resolve(dataDir));
  } catch (error) {
    throw fsFailure(error, '数据目录');
  }
  const agent = path.join(real, 'agent');
  if (!inside(real, agent)) throw new LocalDataError('invalid', '私有目录越界');
  let stat = await lstatOrNull(agent, 'agent');
  if (stat === null) {
    try {
      await fsp.mkdir(agent, { mode: 0o700 });
    } catch (error) {
      if (fsErrorCode(error) !== 'EEXIST') throw fsFailure(error, 'agent 目录');
    }
    stat = await lstatOrNull(agent, 'agent');
  }
  if (stat === null) throw new LocalDataError('unreadable', 'agent 目录无法创建');
  if (stat.isSymbolicLink()) throw new LocalDataError('symlink', 'agent 是符号链接，已拒绝保存');
  if (!stat.isDirectory()) throw new LocalDataError('invalid', 'agent 不是目录');
  let realAgent: string;
  try {
    realAgent = await fsp.realpath(agent);
  } catch (error) {
    throw fsFailure(error, 'agent 目录');
  }
  if (!inside(real, realAgent)) throw new LocalDataError('symlink', 'agent 解析后越过数据目录');
  try {
    await fsp.chmod(realAgent, 0o700);
  } catch (error) {
    throw fsFailure(error, 'agent 目录权限');
  }
  return realAgent;
}

async function readPrivateBytes(target: string, relative: string, maxBytes = MAX_PRIVATE_SAVE_BYTES): Promise<Buffer | null> {
  const stat = await lstatOrNull(target, relative);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) throw new LocalDataError('symlink', `${relative} 是符号链接，已拒绝保存`);
  if (!stat.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
  if (stat.size > maxBytes) {
    throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节上限`);
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw fsFailure(error, relative);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new LocalDataError('invalid', `${relative} 不是普通文件`);
    if (opened.size > maxBytes) {
      throw new LocalDataError('too_large', `${relative} 超过 ${maxBytes} 字节上限`);
    }
    return await readBounded(handle, maxBytes, relative);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Test-only barrier invoked after the replacement temp file is synced and
 * immediately before the atomic rename. Production leaves it null. */
export const privateSaveTestHooks: {
  beforeCommit: null | (() => Promise<void> | void);
} = { beforeCommit: null };

async function performPrivateAgentSave(
  dataDir: string,
  field: 'persona' | 'growth',
  content: string,
  expectedSha256: string,
): Promise<PrivateAgentSave> {
  const fileName = PRIVATE_FIELDS[field];
  const root = await privateAgentRoot(dataDir);
  const target = path.join(root, fileName);
  const current = await readPrivateBytes(target, fileName);
  const currentSha = current === null ? '' : sha256(current);
  const expected = typeof expectedSha256 === 'string' ? expectedSha256.trim().toLowerCase() : '';
  if (expected !== '' && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new LocalDataError('invalid', '版本哈希格式无效，未保存');
  }
  if (expected !== currentSha) {
    throw new LocalDataError('conflict', '文件已在别处修改，未覆盖；请重新读取后再保存');
  }
  if (typeof content !== 'string') throw new LocalDataError('invalid', '保存内容必须是文本');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_PRIVATE_SAVE_BYTES) {
    throw new LocalDataError('too_large', `内容 ${bytes.length} 字节，超过 ${MAX_PRIVATE_SAVE_BYTES} 字节上限`);
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  let backupName = '';
  if (current !== null) {
    backupName = `${fileName}.bak-${stamp}`;
    try {
      await fsp.writeFile(path.join(root, backupName), current, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw fsFailure(error, `${fileName} 备份`);
    }
  }
  const temp = path.join(root, `.${fileName}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(temp, 0o600);
    // Re-read the original immediately before commit. This catches an external
    // edit that happened while the replacement temp file was being prepared;
    // without this second check the stale first hash would overwrite it.
    if (privateSaveTestHooks.beforeCommit !== null) await privateSaveTestHooks.beforeCommit();
    const commitCurrent = await readPrivateBytes(target, fileName);
    const commitSha = commitCurrent === null ? '' : sha256(commitCurrent);
    if (commitSha !== currentSha) {
      throw new LocalDataError('conflict', '文件已在准备写入期间被别处修改，未覆盖；请重新读取后再保存');
    }
    await fsp.rename(temp, target);
    let directory: fsp.FileHandle | null = null;
    try {
      directory = await fsp.open(root, 'r');
      await directory.sync();
    } catch {
      // Directory fsync is not available on every platform; rename already
      // completed and the file content is durable after handle.sync().
    } finally {
      await directory?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (error instanceof LocalDataError) throw error;
    throw fsFailure(error, `${fileName} 保存`);
  }
  return {
    saved: true,
    field,
    sha256: sha256(bytes),
    savedAt: Date.now(),
    backupName,
  };
}

/** Save one of the two fixed private Markdown files with optimistic conflict
 * detection. Saves for the same data directory are serialized in-process. */
export async function savePrivateAgentFile(
  dataDir: string,
  field: 'persona' | 'growth',
  content: string,
  expectedSha256: string,
): Promise<PrivateAgentSave> {
  if (field !== 'persona' && field !== 'growth') {
    throw new LocalDataError('invalid', '只允许保存 persona 或 growth');
  }
  const key = `${path.resolve(dataDir)}\u0000${field}`;
  const previous = privateSaveQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => performPrivateAgentSave(dataDir, field, content, expectedSha256));
  privateSaveQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (privateSaveQueues.get(key) === run) privateSaveQueues.delete(key);
  }
}
