// Small admin helper for the P5 acceptance driver. It uses the same generated
// local API client as the DSH plugin and never talks to the user's node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  GetPeerManifestRequest,
  GetPeerProfileRequest,
  ListFavoritesRequest,
  ListFriendsRequest,
  PublishPublicDraftRequest,
  PublishedRequest,
  PutPublicDraftImageRequest,
  RecentMessagesRequest,
  SavePublicDraftRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const [command, raw = '{}'] = process.argv.slice(2);
const options = JSON.parse(raw);
const dataDir = options.dataDir;
if (!dataDir) throw new Error('dataDir is required');
const api = new RamingaApi(resolveConfig({ dataDir, ramingaBin: bin }));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function savePost() {
  let draft = null;
  if (options.draftId) {
    draft = (await api.call((client) => client.getPublicDraft({ draftId: options.draftId }))).draft;
  }
  let created = await api.call((client) => client.savePublicDraft(new SavePublicDraftRequest({
    draftId: options.draftId || '',
    kind: 'post',
    expectedRevision: draft ? Number(draft.revision) : 0,
    title: options.title,
    bodyMarkdown: options.body,
    tags: options.tags || [],
    authorKind: options.authorKind || 'user',
    imageAssetIds: draft ? (draft.images || []).map((image) => image.assetId) : [],
  })));
  draft = created.draft;
  if (options.image) {
    const data = fs.readFileSync(options.image);
    const uploaded = await api.call((client) => client.putPublicDraftImage(new PutPublicDraftImageRequest({
      draftId: draft.draftId,
      role: 'image',
      filename: path.basename(options.image),
      data,
    })));
    const next = await api.call((client) => client.savePublicDraft(new SavePublicDraftRequest({
      draftId: draft.draftId,
      kind: 'post',
      expectedRevision: Number(draft.revision),
      title: options.title,
      bodyMarkdown: options.body,
      tags: options.tags || [],
      authorKind: options.authorKind || 'user',
      imageAssetIds: [uploaded.image.assetId],
    })));
    draft = next.draft;
  }
  return draft.toJson({ emitDefaultValues: true });
}

async function manifestMap() {
  const published = await api.call((client) => client.published(new PublishedRequest()));
  const rows = [];
  for (const file of published.files) {
    const full = path.join(dataDir, 'public', file.path);
    let sha = '';
    try {
      sha = sha256(fs.readFileSync(full));
    } catch {
      sha = 'missing';
    }
    rows.push({ path: file.path, size: Number(file.size), sha256: sha });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { files: rows, count: rows.length };
}

let result;
switch (command) {
  case 'status':
    result = (await api.call((client) => client.status(new StatusRequest()))).toJson({ emitDefaultValues: true });
    break;
  case 'friends':
    result = (await api.call((client) => client.listFriends(new ListFriendsRequest({})))).toJson({ emitDefaultValues: true });
    break;
  case 'published':
    result = (await api.call((client) => client.published(new PublishedRequest()))).toJson({ emitDefaultValues: true });
    break;
  case 'manifest-map':
    result = await manifestMap();
    break;
  case 'remote-profile':
    result = (await api.call((client) => client.getPeerProfile(new GetPeerProfileRequest({ peerId: options.peerId })))).toJson({ emitDefaultValues: true });
    break;
  case 'manifest':
    result = (await api.call((client) => client.getPeerManifest(new GetPeerManifestRequest({ peerId: options.peerId, offset: 0, limit: options.limit || 100 })))).toJson({ emitDefaultValues: true });
    break;
  case 'favorites':
    result = (await api.call((client) => client.listFavorites(new ListFavoritesRequest({ limit: 100 })))).toJson({ emitDefaultValues: true });
    break;
  case 'messages':
    result = (await api.call((client) => client.recentMessages(new RecentMessagesRequest({ limit: options.limit || 20 })))).toJson({ emitDefaultValues: true });
    break;
  case 'save-post':
    result = await savePost();
    break;
  case 'publish':
    result = (await api.call((client) => client.publishPublicDraft(new PublishPublicDraftRequest({
      draftId: options.draftId,
      expectedRevision: options.expectedRevision,
      expectedPublishedSha256: options.expectedPublishedSha256 || '',
    })))).toJson({ emitDefaultValues: true });
    break;
  default:
    throw new Error(`unknown command ${command}`);
}
console.log(JSON.stringify(result));
