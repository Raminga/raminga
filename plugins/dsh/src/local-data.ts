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
export const MAX_SESSION_STATE_BYTES = 128 * 1024;
export const MAX_EVENTS_BYTES = 1024 * 1024;
export const MAX_REPORT_BYTES = 512 * 1024;
export const MAX_SESSIONS = 50;
export const MAX_EVENTS = 500;
export const MAX_POSTS = 200;

const MAX_TEXT = 120;
const MAX_BODY = 64 * 1024;
const MAX_SUMMARY = 320;
const MAX_TAGS = 10;
const MAX_TAG = 32;
const POST_PATH = /^posts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PLACEHOLDER = /replace-[a-z][a-z0-9-]*/i;

export class LocalDataError extends Error {
  constructor(
    readonly code: 'missing' | 'invalid' | 'too_large' | 'symlink' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'LocalDataError';
  }
}

export type LocalState = 'available' | 'missing' | 'error';

export interface LocalText {
  state: LocalState;
  markdown: string;
  error: string;
}

export interface LocalPost {
  schemaVersion: 1;
  title: string;
  summary: string;
  bodyMarkdown: string;
  tags: string[];
  publishedAt: string;
  authorPeerId: string;
  authorKind: 'user' | 'agent';
  authorName: string;
  path: string;
  sha256: string;
  sizeBytes: number;
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
  posts: LocalPost[];
  error: string;
  /** Public JSON files without a valid explicit author mapping. */
  unattributed: number;
  /** Valid posts explicitly authored by the user's Agent, not the user. */
  agentAuthored: number;
  /** Files that could not be parsed or were too large. */
  invalid: number;
  errors: LocalPostError[];
  truncated: boolean;
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

export interface OwnPublicData {
  profile: LocalOwnProfile;
  posts: LocalOwnPosts;
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
    if (markdown.includes('\uFFFD')) return { state: 'error', markdown: '', error: `${relative} 不是有效 UTF-8` };
    return { state: 'available', markdown, error: '' };
  } catch (error) {
    if (error instanceof LocalDataError && error.code === 'missing') {
      return { state: 'missing', markdown: '', error: `${relative} 不存在` };
    }
    return { state: 'error', markdown: '', error: error instanceof Error ? error.message : String(error) };
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

/** Parse and validate one versioned public post. */
export function parsePublicPost(data: Buffer, expectedPath: string, servingPeerId: string): LocalPost {
  if (!POST_PATH.test(expectedPath)) throw new LocalDataError('invalid', '公开帖子路径必须位于 posts/ 且为 .json');
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch {
    throw new LocalDataError('invalid', '公开帖子不是有效 JSON');
  }
  if (!isRecord(value)) throw new LocalDataError('invalid', '公开帖子必须是 JSON 对象');
  if (value.schema_version !== 1) throw new LocalDataError('invalid', '公开帖子 schema_version 必须为 1');
  if (value.format !== 'markdown') throw new LocalDataError('invalid', '公开帖子 format 必须为 markdown');
  const title = text(value.title, 200);
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
  const authorKind = author.kind === 'user' || author.kind === 'agent' ? author.kind : '';
  if (authorKind === '') throw new LocalDataError('invalid', '公开帖子 author.kind 必须为 user 或 agent');
  const authorName = text(author.display_name, MAX_TEXT);
  if (PLACEHOLDER.test(authorName)) throw new LocalDataError('invalid', '公开帖子作者名仍是模板占位');
  const publishedAt = rfc3339(value.published_at);
  if (publishedAt === '') throw new LocalDataError('invalid', '公开帖子 published_at 不是 RFC 3339');
  const summary = text(value.summary, MAX_SUMMARY) || bodyMarkdown.replace(/[#*_>`[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  return {
    schemaVersion: 1,
    title,
    summary,
    bodyMarkdown,
    tags: collectTags(value.tags),
    publishedAt,
    authorPeerId,
    authorKind,
    authorName,
    path: expectedPath,
    sha256: sha256(data),
    sizeBytes: data.length,
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
      else if (entry.isFile() && entry.name.endsWith('.json')) {
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
      if (post.authorKind !== 'user') {
        out.agentAuthored += 1;
      } else {
        out.posts.push(post);
      }
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

export async function readOwnPublic(dataDir: string, localPeerId: string): Promise<OwnPublicData> {
  const [profile, posts] = await Promise.all([readOwnProfile(dataDir), readOwnPosts(dataDir, localPeerId)]);
  return { profile, posts };
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
    currentPeerId: canonicalPeer(raw.current_peer_id),
    visitedPeerIds: Array.isArray(raw.visited_peer_ids)
      ? raw.visited_peer_ids.map(canonicalPeer).filter((value: string) => value.length > 0).slice(0, 200)
      : [],
    discoverySources: collectStringList(raw.discovery_sources, 50, 256),
  };
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
    persona: persona ?? { state: 'error', markdown: '', error: reason },
    growth: growth ?? { state: 'error', markdown: '', error: reason },
    sessionsState: 'error',
    sessionsError: reason,
  };
}

export async function readJourney(dataDir: string): Promise<JourneyData> {
  const missing: JourneyData = {
    state: 'missing',
    at: Date.now(),
    persona: { state: 'missing', markdown: '', error: 'agent/persona.md 不存在' },
    growth: { state: 'missing', markdown: '', error: 'agent/growth.md 不存在' },
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
