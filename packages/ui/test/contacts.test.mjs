import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressScopeText,
  contactCheckOutcome,
  contactDisplayName,
  contactInitial,
  contactListState,
  connectionStateText,
  contactsEmptyStaleText,
  contactsReadErrorText,
  contactsStaleText,
  connectOutcome,
  filterContacts,
  shareText,
} from '../src/contacts.js';

const PEER_A = '12D3KooWContactsPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWContactsPeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function friend(peerId, overrides = {}) {
  return {
    peerId,
    name: '',
    description: '',
    connection: 'unknown',
    ...overrides,
  };
}

test('contacts preserve an explicit read state instead of treating errors as empty', () => {
  assert.equal(contactListState(null).kind, 'loading');
  assert.equal(contactListState({ friends: [], freshness: 'loading' }).kind, 'loading');

  const empty = contactListState({ friends: [], at: 10, freshness: 'live' }, '');
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.stale, false);
  const staleEmpty = contactListState({ friends: [], at: 10, freshness: 'stale' }, '');
  assert.equal(staleEmpty.kind, 'empty');
  assert.equal(staleEmpty.stale, true);

  const failed = contactListState({ friends: [], at: 0, freshness: 'unavailable', error: 'daemon down' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.error, /daemon down/);

  const retained = contactListState({
    friends: [friend(PEER_A, { connection: 'connected' })],
    at: 10,
    freshness: 'stale',
    error: 'refresh failed',
  }, '');
  assert.equal(retained.kind, 'ready');
  assert.equal(retained.stale, true);
  assert.match(contactsStaleText({
    friends: [friend(PEER_A)],
    at: Date.now() - 5000,
    freshness: 'stale',
    error: 'refresh failed',
  }), /刷新失败/);

  const noMatch = contactListState({ friends: [friend(PEER_A, { name: 'alice' })], at: 10, freshness: 'live' }, 'bob');
  assert.equal(noMatch.kind, 'search-empty');
  assert.equal(noMatch.friends.length, 0);
  assert.equal(noMatch.stale, false);

  const staleNoMatch = contactListState({
    friends: [friend(PEER_A, { name: 'alice' })],
    at: 10,
    freshness: 'stale',
    error: 'refresh failed',
  }, 'bob');
  assert.equal(staleNoMatch.kind, 'search-empty');
  assert.equal(staleNoMatch.stale, true);
  assert.equal(staleNoMatch.error, 'refresh failed');
  assert.equal(staleNoMatch.at, 10);
  assert.equal(staleNoMatch.all.length, 1, 'the old rows stay available behind the search');
});

test('a stale empty read keeps its time and never claims the list is currently empty', () => {
  const now = 100_000;
  const text = contactsEmptyStaleText({
    friends: [],
    at: 90_000,
    freshness: 'stale',
    error: '',
  }, '', now);
  assert.match(text, /上次成功读取/);
  assert.match(text, /秒前|刚刚/);
  assert.match(text, /当时没有联系人/);
  assert.match(text, /不代表现在也没有/);
  assert.match(text, /实时更新已中断/);
  assert.match(text, /重试/);
  assert.doesNotMatch(text, /^还没有联系人/);

  const failed = contactsEmptyStaleText({
    friends: [],
    at: 90_000,
    freshness: 'stale',
    error: 'daemon down',
  }, '', now);
  assert.match(failed, /最近一次刷新失败/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /daemon down/, 'raw daemon detail stays out of the list body');

  const readError = contactsReadErrorText({ friends: [], at: 90_000, freshness: 'unavailable' }, now);
  assert.match(readError, /上次成功读取/);
  assert.match(readError, /当时没有联系人/);
  assert.match(readError, /不代表现在也没有/);
  assert.doesNotMatch(readError, /^还没有联系人/);

  const noSnapshot = contactsReadErrorText({ friends: [], at: 0, freshness: 'unavailable' }, now);
  assert.match(noSnapshot, /不代表联系人列表为空/);
  assert.doesNotMatch(noSnapshot, /当时没有联系人/);
});

test('contact search covers only real local fields and keeps full Peer IDs', () => {
  const friends = [
    friend(PEER_A, { name: 'Alice', description: 'music' }),
    friend(PEER_B, { name: '', description: 'woodworking' }),
  ];
  assert.deepEqual(filterContacts(friends, 'alice').map((item) => item.peerId), [PEER_A]);
  assert.deepEqual(filterContacts(friends, 'music').map((item) => item.peerId), [PEER_A]);
  assert.deepEqual(filterContacts(friends, PEER_B.slice(-12)).map((item) => item.peerId), [PEER_B]);
  assert.equal(filterContacts(friends, '   ').length, 2);
  assert.match(contactDisplayName(friends[1]), /^12D3KooWCo…/);
  assert.match(contactDisplayName(friends[1]), /…/);
  assert.equal(contactInitial(friends[0]), 'A');
  assert.equal(contactInitial(friends[1]), '1');
  assert.equal(connectionStateText('connected'), '已连接');
  assert.equal(connectionStateText('something-else'), '未知');
});

test('connect outcomes separate a dial from contact-list refresh and persistence', () => {
  const invalid = connectOutcome({ ok: false, invalid: true, error: 'Peer ID 格式不正确。' });
  assert.equal(invalid.tone, 'invalid');
  assert.equal(invalid.showRetry, false);

  const failed = connectOutcome({ ok: false, error: 'dial timeout' });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.showRetry, true);
  assert.match(failed.body, /输入已经保留/);
  assert.match(failed.detail, /dial timeout/);

  const saved = connectOutcome({
    ok: true,
    reused: false,
    route: 'direct',
    transport: 'tcp',
    contact: { ok: true, found: true },
  });
  assert.equal(saved.tone, 'success');
  assert.match(saved.body, /已建立直连连接/);
  assert.equal(saved.showViewContacts, true);

  const refreshFailed = connectOutcome({
    ok: true,
    reused: true,
    route: 'direct',
    contact: { ok: false, found: false, error: 'list failed' },
    status: { ok: true },
  });
  assert.equal(refreshFailed.tone, 'partial');
  assert.match(refreshFailed.contactNote, /联系人列表刷新失败/);
  assert.match(refreshFailed.detail, /list failed/);
  assert.equal(refreshFailed.showCheck, true);
  assert.equal(refreshFailed.showViewContacts, false);

  const notSaved = connectOutcome({
    ok: true,
    route: 'relay',
    contact: { ok: true, found: false },
    status: { ok: false, error: 'status timeout' },
  });
  assert.match(notSaved.contactNote, /尚未保存/);
  assert.equal(notSaved.statusNote, '连接已建立，但节点状态刷新也失败了。');
  assert.match(notSaved.detail, /status timeout/);

  assert.equal(contactCheckOutcome({ ok: true, found: true }).tone, 'success');
  assert.equal(contactCheckOutcome({ ok: true, found: false }).tone, 'partial');
  assert.equal(contactCheckOutcome({ ok: false, error: 'list failed' }).tone, 'error');
});

test('share text includes the complete Peer ID and only supplied shareable addresses', () => {
  const share = {
    peerId: PEER_A,
    addresses: [
      { multiaddr: `/ip4/203.0.113.5/tcp/4001/p2p/${PEER_A}`, kind: 'direct', scope: 'public' },
      { multiaddr: `/ip4/192.168.1.5/tcp/4001/p2p/${PEER_A}`, kind: 'direct', scope: 'private' },
      { multiaddr: `/ip4/198.51.100.2/tcp/4001/p2p/relay/p2p-circuit/p2p/${PEER_A}`, kind: 'relay', scope: 'public' },
    ],
  };
  const text = shareText(share);
  assert.match(text, new RegExp(PEER_A));
  assert.match(text, /公网/);
  assert.match(text, /局域网/);
  assert.match(text, /中继/);
  assert.equal(text.includes('api.token'), false);
  assert.equal(text.includes('127.0.0.1'), false);

  const idOnly = shareText({ peerId: PEER_A, addresses: [] });
  assert.match(idOnly, new RegExp(PEER_A));
  assert.match(idOnly, /当前没有可直接分享的地址/);
  assert.equal(shareText({ peerId: '', addresses: [] }), '');
  assert.equal(addressScopeText({ kind: 'relay', scope: 'private' }), '中继 · 局域网');
});
