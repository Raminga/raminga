// Small JSON CLI over the real daemon API for the batch2-05 acceptance driver.
// It only talks to the isolated fixture data directories passed with --dir.
// Usage examples:
//   node api.mjs status --dir /path/node-a
//   node api.mjs published --dir /path/node-a
//   node api.mjs manifest --dir /path/node-b --peer <peerId>
//   node api.mjs download --dir /path/node-b --peer <peerId> --path posts/x/post.json --out /tmp/post.json
//   node api.mjs drafts --dir /path/node-a
//   node api.mjs import --dir /path/node-a --path posts/x/post.json
//   node api.mjs save-draft --dir /path/node-a --json /tmp/draft.json
//   node api.mjs publish --dir /path/node-a --id draft-x --revision 3 --sha <hex>
//   node api.mjs connect --dir /path/node-a --peer <peerId> --addr /ip4/.../p2p/<peerId>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DownloadPeerFileRequest,
  GetPeerManifestRequest,
  GetPublicDraftRequest,
  ImportPublicPostRequest,
  ListPublicDraftsRequest,
  PublishedRequest,
  PublishPublicDraftRequest,
  SavePublicDraftRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(3));
const command = process.argv[2] || '';
const dir = args.dir;
if (!dir) throw new Error('--dir is required');
const api = new RamingaApi(resolveConfig({ dataDir: path.resolve(dir), ramingaBin: bin }));

function draftJson(draft) {
  return {
    draftId: draft.draftId, kind: draft.kind, revision: String(draft.revision),
    title: draft.title, bodyMarkdown: draft.bodyMarkdown, tags: draft.tags,
    authorKind: draft.authorKind, publishedPath: draft.publishedPath,
    publishedSha256: draft.publishedSha256, publishedRevision: String(draft.publishedRevision),
    images: (draft.images || []).map((image) => ({
      assetId: image.assetId, sha256: image.sha256, mime: image.mime,
      width: Number(image.width), height: Number(image.height), sizeBytes: Number(image.sizeBytes),
    })),
  };
}

async function downloadTo(peerId, remotePath, out) {
  const frames = await api.call(async (client) => {
    const stream = await client.downloadPeerFile(new DownloadPeerFileRequest({
      peerId, path: remotePath, recordDiscovery: false,
    }), { timeoutMs: 30000 });
    const collected = [];
    for await (const frame of stream) {
      collected.push({
        phase: String(frame.phase ?? ''), path: String(frame.path ?? ''),
        receivedBytes: Number(frame.receivedBytes) || 0, totalBytes: Number(frame.totalBytes) || 0,
        localPath: String(frame.localPath ?? ''), sha256: String(frame.sha256 ?? ''),
        error: String(frame.error ?? ''),
      });
    }
    return collected;
  }, `下载 ${remotePath}`);
  const last = frames.at(-1);
  if (!last || last.phase !== 'complete' || last.error) {
    throw new Error(`download failed: ${JSON.stringify(last || frames)}`);
  }
  if (out) fs.copyFileSync(last.localPath, out);
  return { ...last, out: out || '', frames: frames.length };
}

let value;
switch (command) {
  case 'status':
    value = await api.call((client) => client.status(new StatusRequest()), '读取节点状态');
    value = { peerId: value.peerId, apiVersion: value.apiVersion, listenAddrs: value.listenAddrs, peers: value.peers?.length ?? 0 };
    break;
  case 'published':
    value = await api.call((client) => client.published(new PublishedRequest()), '读取已发布清单');
    break;
  case 'manifest': {
    const response = await api.call((client) => client.getPeerManifest(new GetPeerManifestRequest({
      peerId: args.peer, offset: 0, limit: 1000,
    }), { timeoutMs: 20000 }), '读取远端清单');
    value = {
      version: response.version, total: response.total,
      entries: (response.entries || []).map((entry) => ({
        path: entry.path, size: Number(entry.size), sha256: entry.sha256,
      })),
    };
    break;
  }
  case 'download':
    value = await downloadTo(args.peer, args.path, args.out);
    break;
  case 'drafts': {
    const response = await api.call((client) => client.listPublicDrafts(new ListPublicDraftsRequest({
      kind: args.kind || 'post', limit: 100,
    })), '读取草稿列表');
    value = { drafts: (response.drafts || []).map(draftJson) };
    break;
  }
  case 'draft': {
    const response = await api.call((client) => client.getPublicDraft(new GetPublicDraftRequest({
      draftId: args.id,
    })), '读取草稿');
    value = { found: response.found, draft: response.draft ? draftJson(response.draft) : null };
    break;
  }
  case 'import': {
    const response = await api.call((client) => client.importPublicPost(new ImportPublicPostRequest({
      path: args.path,
    }), { timeoutMs: 30000 }), '导入动态草稿');
    value = { draft: draftJson(response.draft) };
    break;
  }
  case 'save-draft': {
    const input = JSON.parse(fs.readFileSync(args.json, 'utf8'));
    const response = await api.call((client) => client.savePublicDraft(new SavePublicDraftRequest({
      draftId: input.draftId || '',
      kind: 'post',
      expectedRevision: BigInt(input.expectedRevision || 0),
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      tags: input.tags || [],
      imageAssetIds: input.imageAssetIds || [],
      authorKind: input.authorKind || 'user',
    })), '保存草稿');
    value = { draft: draftJson(response.draft) };
    break;
  }
  case 'publish': {
    const response = await api.call((client) => client.publishPublicDraft(new PublishPublicDraftRequest({
      draftId: args.id,
      expectedRevision: BigInt(args.revision || 0),
      expectedPublishedSha256: args.sha || '',
    }), { timeoutMs: 30000 }), '发布草稿');
    const statusNames = {
      0: 'unspecified', 1: 'published', 2: 'already_published',
      3: 'conflict', 4: 'invalid', 5: 'partial',
    };
    value = {
      status: statusNames[response.status] || String(response.status), error: response.error,
      currentRevision: String(response.currentRevision),
      currentPublishedSha256: response.currentPublishedSha256,
      postPath: response.postPath,
      files: (response.files || []).map((file) => ({ path: file.path, sizeBytes: Number(file.sizeBytes), sha256: file.sha256 })),
      manifestSha256: response.manifestSha256,
    };
    break;
  }
  case 'connect': {
    const response = await api.call((client) => client.connect(new ConnectRequest({
      multiaddr: args.addr, peerId: args.peer,
    }), { timeoutMs: 20000 }), '连接节点');
    value = { ok: true, route: response.route, peerId: response.peerId, reused: response.reused };
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, value }, null, 2)}\n`);
