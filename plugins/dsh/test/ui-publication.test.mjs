// P2 host bridge: private draft RPC mapping, real publish receipts and
// profile.json v2 reads. No daemon is started; these are deterministic adapter
// tests, with the real dual-node path covered by bridge.integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RamingaUiBridge } from '../lib/ui-bridge.js';

const PEER_A = '12D3KooWCU5mTmYUM99MTejrAGiGhKQDQxLq6M26RnAmXKH9XoSR';

function statusResponse() {
  return {
    peerId: PEER_A, nodeId: 'node-a', version: 'test', protocolVersion: '1', apiVersion: '6',
    startedAtUnixMs: 1, currentTime: 'now', listenAddrs: [], connections: [], peers: [],
    relays: [], maxChatTextBytes: 4096, maxStoredMessages: 1000,
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'raminga-ui-publication-'));
}

function draft({ revision = 0, authorKind = 'user', publishedSha = '' } = {}) {
  return {
    draftId: 'draft-1-abcdef123456', kind: 'post', revision: BigInt(revision), authorKind,
    agentName: '', agentDescription: '', agentInterests: [], agentConversationStyle: '',
    humanName: '', humanBioMarkdown: '', avatar: undefined, title: '标题', bodyMarkdown: '正文',
    tags: ['标签'], images: [], publishedPath: '', publishedSha256: publishedSha,
    publishedRevision: 0n, createdAtUnixMs: 1000n, updatedAtUnixMs: 2000n,
  };
}

function makeClient(overrides = {}) {
  return {
    async status() { return statusResponse(); },
    async listFriends() { return { friends: [] }; },
    async published() { return { files: [], skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1 }; },
    async getPublicDraft() { return { found: false }; },
    async listPublicDrafts() { return { drafts: [], hasMore: false, nextBefore: '' }; },
    async savePublicDraft() { return { draft: draft() }; },
    async putPublicDraftImage() { return { image: { assetId: 'image-a', sha256: 'a'.repeat(64), mime: 'image/png', width: 10, height: 10, sizeBytes: 3 } }; },
    async getPublicDraftAsset() { return { image: { assetId: 'image-a', sha256: 'a'.repeat(64), mime: 'image/png', width: 10, height: 10, sizeBytes: 3 }, data: new Uint8Array([1, 2, 3]) }; },
    async importPublicPost() { return { draft: draft() }; },
    async deletePublicDraft() { return { deleted: true }; },
    async publishPublicDraft() {
      return {
        status: 1, error: '', currentRevision: 1n, currentPublishedSha256: 'b'.repeat(64),
        files: [{ path: 'posts/post-1/post.json', sizeBytes: 20n, sha256: 'c'.repeat(64) }],
        manifestVersion: 1, manifestGeneratedAtUnixMs: 3000n,
        postPath: 'posts/post-1/post.json', profilePath: '', warnings: [], manifestSha256: 'e'.repeat(64),
      };
    },
    events(_request, { signal }) {
      return (async function* stream() {
        yield { toJson: () => ({ heartbeat: true }) };
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      })();
    },
    ...overrides,
  };
}

function makeBridge(client, dataDir) {
  return new RamingaUiBridge({ async ensure() { return client; }, async call(fn) { return fn(client); } }, { dataDir });
}

test('draft bridge maps revisions, optional fields, images and publish receipts', async () => {
  let saved;
  let uploaded;
  let published;
  let assetRequest;
  let importedRequest;
  const client = makeClient({
    async getPublicDraft(request) {
      if (request.draftId === 'missing') return { found: false };
      return { found: true, draft: draft({ revision: 4, authorKind: 'agent', publishedSha: 'd'.repeat(64) }) };
    },
    async listPublicDrafts() {
      return { drafts: [draft({ revision: 2 })], hasMore: true, nextBefore: 'cursor-2' };
    },
    async savePublicDraft(request) {
      saved = request;
      return { draft: draft({ revision: Number(request.expectedRevision) + 1, authorKind: request.authorKind }) };
    },
    async putPublicDraftImage(request) {
      uploaded = request;
      return { image: { assetId: 'image-a', sha256: 'a'.repeat(64), mime: 'image/png', width: 10, height: 10, sizeBytes: 3 } };
    },
    async getPublicDraftAsset(request) {
      assetRequest = request;
      return makeClient().getPublicDraftAsset(request);
    },
    async importPublicPost(request) {
      importedRequest = request;
      return makeClient().importPublicPost(request);
    },
    async publishPublicDraft(request) {
      published = request;
      return makeClient().publishPublicDraft();
    },
  });
  const bridge = makeBridge(client, await tempDir());
  try {
    await bridge.open('ui-publication-drafts');
    const found = await bridge.publicDraft('ui-publication-drafts', 'draft-1-abcdef123456');
    assert.equal(found.found, true);
    assert.equal(found.draft.revision, 4);
    assert.equal(found.draft.authorKind, 'agent');
    assert.equal(found.draft.publishedSha256, 'd'.repeat(64));

    const missing = await bridge.publicDraft('ui-publication-drafts', 'missing');
    assert.equal(missing.found, false);

    const list = await bridge.publicDrafts('ui-publication-drafts', 'post');
    assert.equal(list.drafts.length, 1);
    assert.equal(list.hasMore, true);
    assert.equal(list.nextBefore, 'cursor-2');

    const savedResult = await bridge.savePublicDraft('ui-publication-drafts', {
      draftId: 'draft-1-abcdef123456', kind: 'post', expectedRevision: 3,
      authorKind: 'agent', title: 'Agent 标题', bodyMarkdown: '正文', tags: ['a'],
      agentInterests: ['天文'], imageAssetIds: ['image-a'], avatarAssetId: '',
    });
    assert.equal(savedResult.draft.revision, 4);
    assert.equal(saved.expectedRevision, 3n);
    assert.equal(saved.authorKind, 'agent');
    assert.deepEqual(saved.agentInterests, ['天文']);
    assert.deepEqual(saved.imageAssetIds, ['image-a']);
    assert.equal(saved.title, 'Agent 标题');

    const upload = await bridge.putPublicDraftImage(
      'ui-publication-drafts', 'draft-1-abcdef123456', 'image', 'photo.png', Buffer.from([1, 2, 3]).toString('base64'),
    );
    assert.equal(upload.image.assetId, 'image-a');
    assert.equal(uploaded.role, 'image');
    assert.equal(uploaded.filename, 'photo.png');
    assert.deepEqual([...uploaded.data], [1, 2, 3]);

    const privateImage = await bridge.publicDraftAsset('ui-publication-drafts', 'draft-1-abcdef123456', 'image-a');
    assert.equal(privateImage.image.assetId, 'image-a');
    assert.equal(privateImage.dataBase64, Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(assetRequest.draftId, 'draft-1-abcdef123456');
    assert.equal(assetRequest.assetId, 'image-a');

    const imported = await bridge.importPublicPost('ui-publication-drafts', 'posts/post-agent/post.json');
    assert.equal(imported.draft.draftId, 'draft-1-abcdef123456');
    assert.equal(importedRequest.path, 'posts/post-agent/post.json');
    await assert.rejects(
      bridge.importPublicPost('ui-publication-drafts', 'downloads/peer/posts/post.json'),
      /posts/,
    );
    await assert.rejects(
      bridge.publicDraftAsset('ui-publication-drafts', '', 'image-a'),
      /draftId/,
    );

    const receipt = await bridge.publishPublicDraft('ui-publication-drafts', 'draft-1-abcdef123456', 3, 'd'.repeat(64));
    assert.equal(receipt.status, 'published');
    assert.equal(receipt.manifestSha256, 'e'.repeat(64));
    assert.equal(receipt.files[0].path, 'posts/post-1/post.json');
    assert.equal(published.draftId, 'draft-1-abcdef123456');
    assert.equal(published.expectedRevision, 3n);
    assert.equal(published.expectedPublishedSha256, 'd'.repeat(64));

    await assert.rejects(
      bridge.putPublicDraftImage('ui-publication-drafts', 'draft-1-abcdef123456', 'image', 'x.png', 'not base64!'),
      /base64/,
    );
  } finally {
    bridge.dispose();
  }
});

test('mine prefers profile.json v2 and includes user and Agent posts', async () => {
  const dir = await tempDir();
  const profile = {
    schema_version: 2,
    agent: {
      name: 'Nebula', description: '喜欢星空', interests: ['天文'],
      conversation_style: '好奇', avatar: 'avatar-12345678.png',
      avatar_sha256: '12345678' + 'a'.repeat(56), avatar_mime: 'image/png',
    },
    human: { name: 'JO JO', bio_markdown: '喜欢创造' },
    updated_at: '2026-11-18T10:00:00Z',
  };
  const avatar = Buffer.from('fake-png');
  const postV2 = (kind, title) => ({
    schema_version: 2, id: `post-${kind}`, title, format: 'markdown',
    author: { peer_id: PEER_A, kind, display_name: kind === 'agent' ? 'Nebula' : 'JO JO' },
    published_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:00:00Z',
    tags: ['测试'], body: '正文', images: [], revision: 1,
  });
  const files = {
    'profile/profile.json': Buffer.from(JSON.stringify(profile)),
    'profile/index.md': Buffer.from('# JO JO\n\n喜欢创造'),
    [`profile/avatar-12345678.png`]: avatar,
    'posts/post-user/post.json': Buffer.from(JSON.stringify(postV2('user', '本人动态'))),
    'posts/post-agent/post.json': Buffer.from(JSON.stringify(postV2('agent', 'Agent 动态'))),
  };
  for (const [relative, data] of Object.entries(files)) {
    const absolute = path.join(dir, 'public', relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data);
  }
  const listed = Object.entries(files).map(([relative, data]) => ({ path: relative, size: data.length }));
  const client = makeClient({
    async published() {
      return { files: listed, skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1 };
    },
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-publication-mine');
    const mine = await bridge.mine('ui-publication-mine', true);
    assert.equal(mine.publicProfile.state, 'available');
    assert.equal(mine.publicProfile.profile.agentName, 'Nebula');
    assert.equal(mine.agentCard.state, 'available');
    assert.equal(mine.agentCard.card.displayName, 'Nebula');
    assert.equal(mine.agentCard.card.avatarPath, 'profile/avatar-12345678.png');
    assert.equal(mine.posts.posts.length, 2);
    assert.deepEqual(mine.posts.posts.map((post) => post.authorKind).sort(), ['agent', 'user']);
    assert.equal(mine.posts.agentAuthored, 1);
    assert.equal(mine.profile.state, 'available');
    assert.equal(mine.profile.displayName, 'JO JO');
  } finally {
    bridge.dispose();
  }
});

test('mine does not expose profile.json outside the daemon published manifest', async () => {
  const dir = await tempDir();
  const profile = {
    schema_version: 2,
    agent: { name: 'Nebula', description: '', interests: [], conversation_style: '' },
    human: { name: 'JO JO', bio_markdown: '' },
    updated_at: '2026-11-18T10:00:00Z',
  };
  const absolute = path.join(dir, 'public', 'profile', 'profile.json');
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, JSON.stringify(profile));
  const client = makeClient({
    async published() { return { files: [], skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1 }; },
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-publication-unpublished');
    const mine = await bridge.mine('ui-publication-unpublished', true);
    assert.equal(mine.publicProfile.state, 'missing');
    assert.match(mine.publicProfile.error, /不在节点当前发布清单/);
    assert.equal(mine.agentCard.state, 'missing');
  } finally {
    bridge.dispose();
  }
});

test('own post parser accepts v2 history and rejects a forged image path', async () => {
  const dir = await tempDir();
  const base = {
    schema_version: 2, id: 'post-a', title: '图文', format: 'markdown',
    author: { peer_id: PEER_A, kind: 'agent', display_name: 'Nova' },
    published_at: '2026-11-18T10:00:00Z', body: '正文', tags: [],
    images: [{
      path: 'images/' + 'a'.repeat(64) + '.png', sha256: 'a'.repeat(64),
      mime: 'image/png', width: 10, height: 10, size_bytes: 3,
    }],
  };
  const file = path.join(dir, 'public', 'posts', 'post-a', 'post.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(base));
  const client = makeClient({
    async published() { return { files: [{ path: 'posts/post-a/post.json', size: (await fs.stat(file)).size }], skipped: [], generatedAtUnixMs: 1, friendsSyncedAtUnixMs: 1 }; },
  });
  const bridge = makeBridge(client, dir);
  try {
    await bridge.open('ui-publication-v2-post');
    const mine = await bridge.mine('ui-publication-v2-post', true);
    assert.equal(mine.posts.posts.length, 1);
    assert.equal(mine.posts.posts[0].schemaVersion, 2);
    assert.equal(mine.posts.posts[0].images.length, 1);
    assert.equal(mine.posts.posts[0].authorKind, 'agent');
  } finally {
    bridge.dispose();
  }
  // A path whose hash does not match the filename is invalid, not a guessed image.
  const forged = {
    ...base,
    images: [{ ...base.images[0], path: 'images/' + crypto.randomBytes(32).toString('hex') + '.png' }],
  };
  await fs.writeFile(file, JSON.stringify(forged));
  const bridge2 = makeBridge(client, dir);
  try {
    await bridge2.open('ui-publication-forged');
    const mine = await bridge2.mine('ui-publication-forged', true);
    assert.equal(mine.posts.posts.length, 0);
    assert.ok(mine.posts.invalid >= 1);
  } finally {
    bridge2.dispose();
  }
});
