// Small JSON CLI over the real isolated daemon API for the item 6 acceptance.
// It only touches the fixture data directories passed with --dir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  DownloadPeerFileRequest,
  GetPeerManifestRequest,
  GetPeerProfileRequest,
  PublishPublicDraftRequest,
  PublishedRequest,
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

function profileValue(value) {
  if (!value) return null;
  return {
    agentName: value.agentName,
    agentDescription: value.agentDescription,
    agentInterests: [...(value.agentInterests || [])],
    agentConversationStyle: value.agentConversationStyle,
    humanName: value.humanName,
    humanBioMarkdown: value.humanBioMarkdown,
    avatarPath: value.avatarPath,
    avatarSha256: value.avatarSha256,
    avatarMime: value.avatarMime,
    sourcePath: value.sourcePath,
    legacyFallback: value.legacyFallback === true,
    warning: value.warning,
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
    value = await api.call((client) => client.status(new StatusRequest()));
    value = { peerId: value.peerId, listenAddrs: value.listenAddrs, peers: (value.peers || []).length };
    break;
  case 'published':
    value = await api.call((client) => client.published(new PublishedRequest()), '读取已发布清单');
    break;
  case 'profile': {
    const response = await api.call((client) => client.getPeerProfile(new GetPeerProfileRequest({
      peerId: args.peer,
    }), { timeoutMs: 30000 }), '读取远端公开资料');
    value = {
      peerId: response.peerId, name: response.name, text: response.text,
      found: response.found, files: [...(response.files || [])],
      profile: profileValue(response.profile),
    };
    break;
  }
  case 'manifest': {
    const response = await api.call((client) => client.getPeerManifest(new GetPeerManifestRequest({
      peerId: args.peer, offset: 0, limit: 1000,
    }), { timeoutMs: 20000 }), '读取远端清单');
    value = {
      version: response.version,
      total: Number(response.total || 0),
      entries: (response.entries || []).map((entry) => ({
        path: entry.path, size: Number(entry.size), sha256: entry.sha256,
      })),
    };
    break;
  }
  case 'download':
    value = await downloadTo(args.peer, args.path, args.out);
    break;
  case 'connect': {
    const response = await api.call((client) => client.connect(new ConnectRequest({
      multiaddr: args.addr, peerId: args.peer,
    }), { timeoutMs: 20000 }), '连接节点');
    value = { ok: true, route: response.route, peerId: response.peerId, reused: response.reused };
    break;
  }
  case 'seed-profile': {
    // Fixture setup only: publish an old profile through the real daemon and
    // keep its private draft, matching the product's normal draft lifecycle.
    const input = JSON.parse(fs.readFileSync(args.json, 'utf8'));
    const created = await api.call((client) => client.savePublicDraft(new SavePublicDraftRequest({
      draftId: 'profile', kind: 'profile', expectedRevision: 0n,
      agentName: input.agentName,
      agentDescription: input.agentDescription,
      agentInterests: input.agentInterests || [],
      agentConversationStyle: input.agentConversationStyle,
      humanName: input.humanName,
      humanBioMarkdown: input.humanBioMarkdown,
    })), '准备旧公开资料草稿');
    const published = await api.call((client) => client.publishPublicDraft(new PublishPublicDraftRequest({
      draftId: 'profile',
      expectedRevision: created.draft.revision,
      expectedPublishedSha256: '',
    }), { timeoutMs: 30000 }), '发布旧公开资料');
    value = {
      draftRevision: String(created.draft.revision),
      status: String(published.status),
      profilePath: published.profilePath,
      manifestSha256: published.manifestSha256,
    };
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, value }, null, 2)}\n`);
