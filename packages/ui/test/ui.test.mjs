import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrimaryNav } from '../src/components/navigation.js';
import { resolveNodePhase } from '../src/app.js';
import { navIdForPage, pageForNav, isMainPage, MAIN_PAGES } from '../src/router.js';
import {
  connectionFactText,
  connectionSummary,
  nodePhaseText,
  nodePillText,
  refreshedText,
  routeFactText,
  routeText,
  shortPeer,
  subscriptionText,
} from '../src/node-status.js';
import {
  journeyDirectionText,
  journeyEventLabel,
  journeyMessageRefs,
  journeyModeText,
  journeySessionTitle,
  journeyStatusText,
} from '../src/content.js';
import {
  copyViewState,
  createViewState,
  getDraft,
  normalizeViewState,
  setDraft,
} from '../src/view-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.resolve(here, '..', 'src', 'template.html'), 'utf8');

test('snapshot phase prefers errors over stale status and marks a stopped stream closed', () => {
  const status = { peerId: '12D3KooWabcdefghijklmnop', connections: [] };
  assert.equal(resolveNodePhase({ status, stats: { streamActive: true } }), 'ready');
  assert.equal(resolveNodePhase({ status, error: 'daemon timeout', stats: { streamActive: true } }), 'error');
  assert.equal(resolveNodePhase({ status, error: null, stats: { streamActive: false } }), 'closed');
  assert.equal(resolveNodePhase({ status: null, error: null, stats: { streamActive: false } }), 'closed');
  assert.equal(resolveNodePhase({ status: null, error: null, stats: { streamActive: true } }), 'loading');
  assert.equal(resolveNodePhase({ status, freshness: 'live', stats: { streamActive: true } }), 'ready');
  assert.equal(
    resolveNodePhase({ status, freshness: 'stale', stream: { phase: 'reconnecting' }, stats: { streamActive: false } }),
    'stale',
  );
  assert.equal(
    resolveNodePhase({ status: null, freshness: 'unavailable', error: 'daemon down', stats: { streamActive: false } }),
    'error',
  );
});

test('stale status keeps its read time and an absent status never becomes zero connections', () => {
  const status = { connections: [{ peerId: 'peer-a', route: 'direct' }] };
  const now = 100_000;
  assert.equal(connectionFactText(null, { freshness: 'unavailable', statusAt: 0, now }), '—');
  assert.equal(connectionFactText(status, { freshness: 'live', statusAt: 90_000, now }), '1 条连接 · 1 个已连接节点');
  assert.match(connectionFactText(status, { freshness: 'stale', statusAt: 90_000, now }), /非实时/);
  assert.match(connectionFactText(status, { freshness: 'stale', statusAt: 90_000, now }), /刚刚|秒前|分钟前/);
  assert.equal(routeFactText(null, { freshness: 'stale' }), '—');
  assert.match(routeFactText(status, { freshness: 'stale', statusAt: 90_000, now }), /直连 1.*非实时/);
  assert.equal(refreshedText(0), '尚无成功读取');
  assert.match(refreshedText(90_000, now), /秒前/);
  assert.equal(nodePillText('stale', status), '节点状态 · 更新中断');
  assert.equal(subscriptionText({ subscriptions: 0, openSessions: 1, streamPhase: 'reconnecting' }), '已中断，正在重试');
  assert.equal(subscriptionText({ subscriptions: 0, openSessions: 1, streamPhase: 'connecting' }), '正在连接');
});

test('primary navigation keeps the accepted five-entry order and one current entry', () => {
  const nav = renderPrimaryNav('contacts');
  const buttons = [...nav.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(buttons, ['home', 'contacts', 'raminga', 'messages', 'mine']);
  assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
  assert.match(nav, /data-nav="contacts" aria-current="page"/);
  assert.doesNotMatch(nav, /data-nav="topic"/);
});

test('router maps the five fixed pages and the centered logo page', () => {
  assert.deepEqual(MAIN_PAGES, ['explore', 'contacts', 'raminga', 'messages', 'mine']);
  assert.equal(pageForNav('home'), 'explore');
  assert.equal(pageForNav('raminga'), 'raminga');
  assert.equal(navIdForPage('explore'), 'home');
  assert.equal(navIdForPage('mine'), 'mine');
  assert.equal(isMainPage('messages'), true);
  assert.equal(isMainPage('chat/nova'), false);
});

test('connection summary counts links and unique peers, not sessions or agents', () => {
  const status = {
    connections: [
      { peerId: 'peer-a', route: 'direct' },
      { peerId: 'peer-a', route: 'relay' },
      { peerId: 'peer-b', route: 'direct' },
    ],
  };
  assert.deepEqual(connectionSummary(status), {
    connections: 3,
    peers: 2,
    routes: { direct: 2, relay: 1, other: 0 },
  });
  assert.equal(routeText(status), '直连 2 · 中继 1');
  assert.equal(nodePillText('ready', status), '节点状态 · 3 条连接');
  assert.equal(nodePillText('error', status), '节点状态 · 暂不可用');
  assert.equal(nodePillText('closed', status), '节点状态 · 已断开');
  assert.equal(nodePhaseText('loading'), '正在读取本机节点');
  assert.equal(subscriptionText({ subscriptions: 1, openSessions: 2 }), '已开启');
  assert.equal(subscriptionText({ subscriptions: 0, openSessions: 1, streamActive: false }), '已暂停');
  assert.equal(subscriptionText(null), '—');
  assert.equal(shortPeer('1234567890123456789012345'), '1234567890…89012345');
});

test('view state restores pages, searches, filters, scroll and drafts with bounded input', () => {
  const input = {
    page: 'contacts',
    pages: {
      explore: { filter: 'familiar', query: 'rain', searchOpen: true, scroll: 128.7 },
      contacts: { query: 'alice', scroll: 42 },
      raminga: { scroll: 3 },
      messages: {
        scroll: 4,
        chatAnchors: {
          '12D3KooWPeerA': { messageId: 'm0001', offset: 18.4 },
          'bad key': { messageId: 'm0002', offset: 1 },
          '12D3KooWPeerB': { messageId: 'bad\nid', offset: 1 },
          '12D3KooWPeerC': { messageId: 'm0003', offset: 9999 },
          '12D3KooWPeerD': { messageId: 'm0004', offset: -2, atBottom: true },
        },
      },
      mine: { scroll: 5 },
    },
    drafts: { 'chat/peer-a': 'draft text', 'bad key': 'drop', empty: '', __proto__: 'drop', constructor: 'drop' },
    ignored: true,
  };
  const state = normalizeViewState(input);
  assert.equal(state.page, 'contacts');
  assert.deepEqual(state.pages.explore, { filter: 'familiar', query: 'rain', searchOpen: true, scroll: 128, expanded: {}, sourceOpen: {} });
  assert.deepEqual(state.pages.contacts, { query: 'alice', scroll: 42 });
  assert.equal(state.pages.mine.scroll, 5);
  assert.deepEqual(state.pages.messages.chatAnchors, {
    '12D3KooWPeerA': { messageId: 'm0001', offset: 18 },
    '12D3KooWPeerC': { messageId: 'm0003', offset: 4000 },
    '12D3KooWPeerD': { messageId: 'm0004', offset: -2, atBottom: true },
  });
  assert.deepEqual(state.drafts, { 'chat/peer-a': 'draft text' });
  assert.equal(state.ignored, undefined);

  const hostile = normalizeViewState({
    page: 'javascript:alert(1)',
    pages: {
      explore: { filter: 'topic', query: 'x'.repeat(500), searchOpen: 'yes', scroll: -1 },
      contacts: { query: 42, scroll: '9' },
    },
    drafts: { 'chat/a': 'x'.repeat(9000), constructor: 'drop' },
  });
  assert.equal(hostile.page, 'explore');
  assert.equal(hostile.pages.explore.filter, 'all');
  assert.equal(hostile.pages.explore.searchOpen, false);
  assert.equal(hostile.pages.explore.query.length, 200);
  assert.equal(hostile.pages.explore.scroll, 0);
  assert.equal(hostile.pages.contacts.query, '');
  assert.equal(hostile.drafts['chat/a'].length, 8192);

  const fresh = createViewState();
  assert.notEqual(fresh.pages.explore, state.pages.explore);
  const target = {};
  copyViewState(target, state);
  target.pages.contacts.query = 'mutated';
  assert.equal(state.pages.contacts.query, 'alice', 'copy must not alias nested state');

  setDraft(state, 'chat/peer-b', 'hello');
  assert.equal(getDraft(state, 'chat/peer-b'), 'hello');
  setDraft(state, 'chat/peer-b', '');
  assert.equal(getDraft(state, 'chat/peer-b'), '');

  const conversation = normalizeViewState({
    pages: {
      messages: {
        scroll: 12, peerId: '12D3KooWPeerA', returnPage: 'contacts', returnPeer: '12D3KooWPeerA',
      },
    },
  });
  assert.equal(conversation.pages.messages.peerId, '12D3KooWPeerA');
  assert.equal(conversation.pages.messages.returnPage, 'contacts');
  assert.equal(conversation.pages.messages.returnPeer, '12D3KooWPeerA');
  const mismatchedSource = normalizeViewState({
    pages: {
      messages: {
        peerId: '12D3KooWPeerA', returnPage: 'contacts', returnPeer: '12D3KooWPeerB',
      },
    },
  });
  assert.equal(mismatchedSource.pages.messages.returnPage, '', 'a trigger for another Peer is not a valid source');
  assert.equal(mismatchedSource.pages.messages.returnPeer, '');
  assert.equal(normalizeViewState({ pages: { messages: { peerId: 'not a peer/../id' } } }).pages.messages.peerId, '');

  const stage6 = normalizeViewState({
    profile: { peerId: '12D3KooWPeerA', returnPage: 'messages', returnPeer: '12D3KooWPeerA', triggerId: 'chat:12D3KooWPeerA' },
    pages: {
      explore: { filter: 'familiar', expanded: { '17': true, '../bad': true, '__proto__': true }, sourceOpen: { '17': true, '../bad': true } },
      raminga: { expandedSessions: { 'session-1': true, '../bad': true } },
      messages: { peerId: '12D3KooWPeerA', returnPage: 'raminga', returnPeer: '12D3KooWPeerA' },
    },
  });
  assert.deepEqual(stage6.profile, {
    peerId: '12D3KooWPeerA', returnPage: 'messages', returnPeer: '12D3KooWPeerA', triggerId: 'chat:12D3KooWPeerA',
  });
  assert.deepEqual(stage6.pages.explore.expanded, { '17': true });
  assert.deepEqual(stage6.pages.explore.sourceOpen, { '17': true });
  assert.deepEqual(stage6.pages.raminga.expandedSessions, { 'session-1': true });
  assert.equal(stage6.pages.messages.returnPage, 'raminga');
  const stage6Copy = {};
  copyViewState(stage6Copy, stage6);
  stage6Copy.pages.explore.expanded['17'] = false;
  stage6Copy.pages.explore.sourceOpen['17'] = false;
  assert.equal(stage6.pages.explore.expanded['17'], true, 'expanded maps must not alias');
  assert.equal(stage6.pages.explore.sourceOpen['17'], true, 'source-open maps must not alias');
  const copied = createViewState();
  copyViewState(copied, conversation);
  copied.pages.messages.chatAnchors['12D3KooWPeerA'] = { messageId: 'mutated', offset: 0 };
  assert.equal(conversation.pages.messages.chatAnchors['12D3KooWPeerA']?.messageId, undefined,
    'anchor copies must not alias the source state');
  assert.equal(copied.pages.messages.peerId, '12D3KooWPeerA');
  assert.equal(copied.pages.messages.returnPage, 'contacts');
});

test('template has the accepted native workspace chrome and honest states', () => {
  assert.match(template, /class="rm-brand"/);
  assert.match(template, /id="desktopNav"/);
  assert.match(template, /id="mobileNav"/);
  assert.match(template, /id="nodeTrigger"/);
  for (const page of MAIN_PAGES) assert.match(template, new RegExp(`data-page="${page}"`));
  assert.equal((template.match(/data-filter=/g) || []).length, 2, 'only discover / familiar filters');
  assert.doesNotMatch(template, /data-filter="topic"/);
  assert.match(template, /id="contactQuery"/);
  assert.match(template, /id="addContact"/);
  assert.doesNotMatch(template, /<h1>联系人/);
  assert.match(template, /id="contactList"/);
  assert.match(template, /id="addContactDialog"/);
  assert.match(template, /id="addContactInput"/);
  assert.match(template, /id="addContactFeedback"/);
  assert.match(template, /id="shareDialog"/);
  assert.match(template, /id="sharePeerId"/);
  assert.match(template, /id="shareManual"/);
  assert.match(template, /id="conversationView"/);
  assert.match(template, /id="conversationList"/);
  assert.match(template, /id="conversationQuery"/);
  assert.match(template, /id="messageList"/);
  assert.match(template, /id="messageInput"/);
  assert.match(template, /id="messageSend"/);
  assert.match(template, /id="loadOlder"/);
  assert.match(template, /id="messageRetention"/);
  assert.match(template, /rm-contact-list/);
  assert.match(template, /id="statusDialog"/);
  assert.match(template, /id="noticeDialog"/);
  assert.match(template, /最近刷新/);
  assert.match(template, /连接方式/);
  assert.doesNotMatch(template, /查看空状态|填入示例|预览状态|演示控制|示例联系人|>接上话题</);
  assert.doesNotMatch(template, /阶段\s*[0-9]|\bConnect\b|\bRPC\b|桥接|Persona|不会生成|不会根据|占位|multiaddr/);
  assert.doesNotMatch(template, /<script[\s>]/i);
  const appSource = fs.readFileSync(path.resolve(here, '..', 'src', 'app.js'), 'utf8');
  // Check user-facing string literals, not JS identifiers or comments: the
  // adapter callback is legitimately named onConnect, while product copy must
  // never expose that implementation term.
  const uiStrings = [...appSource.matchAll(/(['"`])(?:\\.|(?!\1).)*\1/g)].map((match) => match[0]).join('\n');
  assert.doesNotMatch(uiStrings, /阶段\s*[0-9]|\bConnect\b|\bRPC\b|桥接|Persona|不会生成|不会根据|占位/);
});

test('Journey view helpers localize known values and dedupe message pointers', () => {
  assert.equal(journeyStatusText({ status: 'completed' }).label, '已完成');
  assert.equal(journeyStatusText({ status: 'running' }).label, '运行中');
  assert.equal(journeyModeText('explore'), '探索');
  assert.equal(journeyModeText('exploration'), '探索');
  assert.equal(journeyModeText('bespoke-mode'), '其他模式');
  assert.equal(journeySessionTitle({ state: { mode: 'explore' } }), 'Journey · 探索');
  assert.equal(journeyEventLabel({ type: 'observation' }), '观察记录');
  assert.equal(journeyEventLabel({ type: 'bespoke-event' }), '其他活动');
  assert.equal(journeyDirectionText('out'), '发出');
  assert.equal(journeyDirectionText('in'), '收到');
  assert.equal(journeyDirectionText('sideways'), '方向未记录');

  const refs = journeyMessageRefs({
    peerId: 'peer-a',
    messageIds: ['m-one', 'm-two'],
    messageEvidence: { messageId: 'm-one', peerId: 'peer-a' },
  });
  assert.deepEqual(refs.map((ref) => ref.messageId), ['m-one', 'm-two'],
    'the same message ID from evidence_refs and message_evidence appears once');
  assert.equal(refs[0].peerId, 'peer-a');
  assert.equal(refs[0].peerConflict, false);

  const conflicted = journeyMessageRefs({
    peerId: 'peer-a',
    messageIds: ['m-one'],
    messageEvidence: { messageId: 'm-one', peerId: 'peer-b' },
  });
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0].peerConflict, true, 'a peer conflict is surfaced instead of guessing');
});
