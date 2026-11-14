import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationItems,
  conversationListState,
  conversationSummaryText,
  countTextBytes,
  deliveryStatusText,
  mergeMessages,
  messageListState,
  previewText,
  sendOutcome,
  sortMessagesNewestFirst,
} from '../src/messages.js';

const PEER_A = '12D3KooWMessagePeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWMessagePeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function message(id, overrides = {}) {
  return {
    messageId: id,
    peerId: PEER_A,
    direction: 'out',
    text: id,
    acked: false,
    createdAt: 1000,
    ackedAt: null,
    deliveryStatus: 'pending',
    deliveryError: '',
    origin: 'human',
    deliveryUpdatedAt: null,
    clientRequestId: '',
    ...overrides,
  };
}

test('delivery wording only claims protocol acceptance and never a read state', () => {
  assert.equal(deliveryStatusText(message('m', { deliveryStatus: 'acked' })), '协议已接收');
  assert.doesNotMatch(deliveryStatusText(message('m', { deliveryStatus: 'acked' })), /已读|未读/);
  assert.match(deliveryStatusText(message('m', { deliveryStatus: 'pending' })), /待发送/);
  assert.match(deliveryStatusText(message('m', { deliveryStatus: 'failed' })), /发送失败/);
  assert.match(deliveryStatusText(message('m', { deliveryStatus: 'cancelled' })), /已取消/);
  assert.match(deliveryStatusText(message('m', { deliveryStatus: 'unknown' })), /投递状态未知/);
  assert.equal(deliveryStatusText(message('m', { direction: 'in', deliveryStatus: 'received' })), '已收到');
});

test('mergeMessages dedupes by stable ID, keeps peer boundaries and equal-timestamp order', () => {
  const existing = [
    message('b', { createdAt: 1000 }),
    message('a', { createdAt: 1000 }),
    message('old', { createdAt: 900 }),
  ];
  const incoming = [
    message('b', { deliveryStatus: 'acked', acked: true, deliveryUpdatedAt: 3000 }),
    message('c', { createdAt: 1100 }),
    message('other-peer', { peerId: PEER_B, createdAt: 5000 }),
  ];
  const merged = mergeMessages(existing, incoming, { peerId: PEER_A });
  assert.deepEqual(merged.map((row) => row.messageId), ['c', 'b', 'a', 'old']);
  // Direction is part of the stable business key even when a malformed host
  // supplied the same ID in both directions.
  const directional = mergeMessages(
    [message('same', { direction: 'out' })],
    [message('same', { direction: 'in' })],
    { peerId: PEER_A },
  );
  assert.equal(directional.length, 2, 'direction is not collapsed');
  assert.equal(merged.find((row) => row.messageId === 'b').deliveryStatus, 'acked');
  assert.equal(merged.some((row) => row.peerId === PEER_B), false);
  const sorted = sortMessagesNewestFirst([message('a', { createdAt: 1 }), message('b', { createdAt: 1 })]);
  assert.deepEqual(sorted.map((row) => row.messageId), ['b', 'a'], 'messageId is the stable tie-breaker');
});

test('conversation items merge contacts without messages and keep search reachable', () => {
  const conversations = {
    conversations: [
      { peerId: PEER_A, lastMessageId: 'm1', direction: 'out', preview: 'hello there', lastAt: 2000, deliveryStatus: 'acked', origin: 'human', messageCount: 3 },
    ],
    at: 100,
    freshness: 'live',
  };
  const contacts = {
    friends: [
      { peerId: PEER_A, name: 'Alice', description: '', connection: 'connected' },
      { peerId: PEER_B, name: 'Bob', description: '', connection: 'unknown' },
    ],
    at: 100,
    freshness: 'live',
  };
  const items = conversationItems(conversations, contacts.friends);
  assert.equal(items[0].peerId, PEER_A);
  assert.equal(items[0].hasMessages, true);
  assert.equal(items[1].peerId, PEER_B);
  assert.equal(items[1].hasMessages, false);
  assert.match(conversationSummaryText(items[1]), /还没有消息/);

  const ready = conversationListState({ conversations, contacts, query: '' });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.items.length, 2);
  const noResult = conversationListState({ conversations, contacts, query: 'nobody' });
  assert.equal(noResult.kind, 'search-empty');
  assert.equal(noResult.all.length, 2);

  const loading = conversationListState({ conversations: { conversations: [], at: null, freshness: 'loading' }, contacts: { friends: [], at: null, freshness: 'loading' } });
  assert.equal(loading.kind, 'loading');
  const empty = conversationListState({ conversations: { conversations: [], at: 100, freshness: 'live' }, contacts: { friends: [], at: 100, freshness: 'live' } });
  assert.equal(empty.kind, 'empty');
  const failed = conversationListState({ conversations: { conversations: [], at: 0, error: 'read failed', freshness: 'unavailable' }, contacts: { friends: [], at: 0, freshness: 'loading' } });
  assert.equal(failed.kind, 'error');
  // A failed summary read with local contacts must still show what is known and
  // mark it stale rather than pretending there are no conversations.
  const partial = conversationListState({ conversations: { conversations: [], at: 0, error: 'read failed', freshness: 'unavailable' }, contacts: { friends: contacts.friends, at: 100, freshness: 'live' } });
  assert.equal(partial.kind, 'ready');
  assert.equal(partial.stale, true);
  assert.equal(partial.items.length, 2);
});

test('message list state distinguishes empty, loading, failed and retained stale rows', () => {
  const loading = messageListState({ messages: [], freshness: 'loading', peerId: PEER_A });
  assert.equal(loading.kind, 'loading');
  const empty = messageListState({ messages: [], freshness: 'live', peerId: PEER_A });
  assert.equal(empty.kind, 'empty');
  const failed = messageListState({ messages: [], error: 'read failed', freshness: 'unavailable', peerId: PEER_A });
  assert.equal(failed.kind, 'error');
  const retained = messageListState({ messages: [message('m')], error: 'read failed', freshness: 'stale', peerId: PEER_A });
  assert.equal(retained.kind, 'ready');
  assert.equal(retained.stale, true);
});

test('send outcomes are honest about unknown, pending, failed and replayed sends', () => {
  assert.equal(sendOutcome({ ok: false, unknown: true }).title, '发送结果未知');
  assert.match(sendOutcome({ ok: true, deliveryStatus: 'pending' }).title, /已交给节点/);
  assert.match(sendOutcome({ ok: true, deliveryStatus: 'acked' }).body, /阅读状态未知/);
  assert.doesNotMatch(sendOutcome({ ok: true, deliveryStatus: 'acked' }).body, /已读|未读/);
  assert.match(sendOutcome({ ok: true, deliveryStatus: 'failed' }).body, /再次发送会创建一条新消息/);
  assert.match(sendOutcome({ ok: true, deliveryStatus: 'failed' }).body, /没有获得送达确认/);
  assert.doesNotMatch(sendOutcome({ ok: true, deliveryStatus: 'failed' }).body, /没有送达|未被对端接收/);
  assert.match(sendOutcome({ ok: true, deliveryStatus: 'acked', replayed: true }).body, /没有重复创建消息/);

  // Raw dial/transport text is returned as a separate disclosure payload, not
  // appended to the short status sentence.
  const raw = `dial peer failed after 4 candidate(s): ${'/ip4/127.0.0.1/tcp/1 connection refused; '.repeat(20)}`.trimEnd();
  const pending = sendOutcome({ ok: true, deliveryStatus: 'pending', error: raw, detail: null });
  assert.doesNotMatch(pending.body, /dial peer|candidate\(s\)|connection refused/);
  assert.equal(pending.detail, raw);
  const unknown = sendOutcome({ ok: false, unknown: true, error: '这次发送没有收到节点结果。', detail: raw });
  assert.doesNotMatch(unknown.body, /dial peer|candidate\(s\)/);
  assert.match(unknown.detail, /这次发送没有收到节点结果/);
  assert.match(unknown.detail, /dial peer failed/);

  const cancelled = sendOutcome({ ok: true, deliveryStatus: 'cancelled' });
  assert.match(cancelled.body, /停止自动重试/);
  assert.match(cancelled.body, /已经发生的投递无法撤回/);
  assert.doesNotMatch(cancelled.body, /没有被对端接收|对端没有收到|未接收/);
});

test('byte counting and previews handle Chinese and long text safely', () => {
  assert.equal(countTextBytes('你好'), 6);
  assert.equal(countTextBytes('abc'), 3);
  assert.equal(previewText('a\nb   c'), 'a b c');
  assert.match(previewText('x'.repeat(200), 10), /…$/);
});
