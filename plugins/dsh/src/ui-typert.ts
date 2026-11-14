// Host-side Typert manifest for the minimal DSH Raminga panel bridge.
//
// This is a hand-written manifest in the shape produced by the Typert
// generator, following the installed dsh-cost-meter reference. The bridge
// service is a plain object with a non-enumerable `typertRemote` binding, so
// the Host does not import undefined internal dsh packages at runtime.
//
// Every result is JSON-safe status/event/contact data; the pass-through codecs
// below intentionally validate only the wiring shape. The real daemon values
// are produced by the existing RamingaApi/StatusResponse and ListFriendsResponse.
export const UI_SERVICE_KEY = 'ramingaUi';
export const UI_NAMESPACE = 'ramingaUi';

type PassthroughCodec = {
  mode: 'strict';
  typeSymbol: string;
  create: () => { parse: (value: unknown) => unknown; encode: (value: unknown) => unknown };
};

function codec(typeSymbol: string): PassthroughCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse(value: unknown) {
        return value;
      },
      encode(value: unknown) {
        return value;
      },
    }),
  };
}

const sessionIdCodec = codec('@raminga/dsh#SessionId');
const booleanCodec = codec('@raminga/dsh#UiBoolean');
const connectInputCodec = codec('@raminga/dsh#UiConnectInput');
const peerIdCodec = codec('@raminga/dsh#PeerId');
const beforeCodec = codec('@raminga/dsh#UiBeforeCursor');
const textCodec = codec('@raminga/dsh#UiMessageText');
const requestIdCodec = codec('@raminga/dsh#UiRequestId');
const messageIdCodec = codec('@raminga/dsh#MessageId');
const contentIdCodec = codec('@raminga/dsh#UiContentId');
export const UI_JSON_CODEC = codec('@raminga/dsh#UiJson');

export interface UiInvocationDescriptor {
  id: string;
  service: string;
  namespace: string;
  method: string;
  invocation: { kind: 'direct' };
  parameters: Array<{ name: string; wire: string; source: 'json'; codec: PassthroughCodec }>;
  result: PassthroughCodec;
}

type ParamKind = 'session' | 'boolean' | 'familiar' | 'connectInput' | 'peerId' | 'before' | 'text' | 'requestId' | 'messageId' | 'contentId';

const PARAMS: Record<ParamKind, { name: string; wire: string; codec: PassthroughCodec }> = {
  session: { name: 'sessionId', wire: 'sessionId', codec: sessionIdCodec },
  boolean: { name: 'force', wire: 'force', codec: booleanCodec },
  familiar: { name: 'familiar', wire: 'familiar', codec: booleanCodec },
  connectInput: { name: 'input', wire: 'input', codec: connectInputCodec },
  peerId: { name: 'peerId', wire: 'peerId', codec: peerIdCodec },
  before: { name: 'before', wire: 'before', codec: beforeCodec },
  text: { name: 'text', wire: 'text', codec: textCodec },
  requestId: { name: 'requestId', wire: 'requestId', codec: requestIdCodec },
  messageId: { name: 'messageId', wire: 'messageId', codec: messageIdCodec },
  contentId: { name: 'id', wire: 'id', codec: contentIdCodec },
};

function invocation(method: string, params: ParamKind[], resultType: string): UiInvocationDescriptor {
  return {
    id: `@raminga/dsh#${UI_NAMESPACE}/${method}`,
    service: UI_SERVICE_KEY,
    namespace: UI_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: params.map((kind) => ({ ...PARAMS[kind], source: 'json' as const })),
    result: codec(`@raminga/dsh#${resultType}`),
  };
}

export const UI_INVOCATIONS: UiInvocationDescriptor[] = [
  invocation('open', ['session'], 'UiSnapshot'),
  invocation('poll', ['session'], 'UiSnapshot'),
  invocation('refresh', ['session'], 'UiSnapshot'),
  invocation('close', ['session'], 'UiStats'),
  invocation('contacts', ['session', 'boolean'], 'UiContacts'),
  invocation('connect', ['session', 'connectInput'], 'UiConnectResult'),
  invocation('checkContact', ['session', 'peerId'], 'UiContactCheck'),
  invocation('share', ['session'], 'UiShareInfo'),
  invocation('conversations', ['session', 'boolean'], 'UiConversations'),
  invocation('messages', ['session', 'peerId', 'before', 'boolean'], 'UiMessagePage'),
  invocation('send', ['session', 'peerId', 'text', 'requestId'], 'UiSendResult'),
  invocation('cancelOutbox', ['session', 'messageId'], 'UiCancelResult'),
  invocation('discoveries', ['session', 'familiar', 'boolean'], 'UiDiscoveries'),
  invocation('discoveryContent', ['session', 'contentId'], 'UiDiscoveryContent'),
  invocation('humanOutbound', ['session', 'boolean'], 'UiHumanOutbound'),
  invocation('mine', ['session', 'boolean'], 'UiMine'),
  invocation('peerProfile', ['session', 'peerId', 'boolean'], 'UiPeerProfile'),
  invocation('journey', ['session', 'boolean'], 'UiJourney'),
  invocation('locateMessage', ['session', 'peerId', 'messageId'], 'UiLocatedMessage'),
];

export const TYPERT = {
  package: '@raminga/dsh',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        description: 'Raminga UI panel bridge: daemon Status/ListFriends/Conversations/Messages, human sends and share facts over a ref-counted Events subscription.',
        summary: 'Raminga UI panel bridge (ctx.ramingaUi).',
        tags: [],
        jsDoc: '/** Raminga UI panel bridge: Status/contacts, Connect and share facts. */',
        key: UI_SERVICE_KEY,
        exportName: 'RamingaUiService',
        members: [
          { kind: 'method', name: 'open', signature: 'open(sessionId: string): Promise<UiSnapshot>', summary: 'Open or reuse one panel lease and return Status plus pending events.' },
          { kind: 'method', name: 'poll', signature: 'poll(sessionId: string): Promise<UiSnapshot>', summary: 'Return a fresh Status snapshot and drain queued daemon events.' },
          { kind: 'method', name: 'refresh', signature: 'refresh(sessionId: string): Promise<UiSnapshot>', summary: 'Force a Status read and drain queued daemon events.' },
          { kind: 'method', name: 'close', signature: 'close(sessionId: string): Promise<UiStats>', summary: 'Release one panel lease; the last release stops the daemon Events stream.' },
          { kind: 'method', name: 'contacts', signature: 'contacts(sessionId: string, force?: boolean): Promise<UiContacts>', summary: 'Read ListFriends plus a fresh Status and normalize each contact connection state.' },
          { kind: 'method', name: 'connect', signature: 'connect(sessionId: string, input: string): Promise<UiConnectResult>', summary: 'Validate and dial one Peer ID or full multiaddr, then verify contacts and Status separately.' },
          { kind: 'method', name: 'checkContact', signature: 'checkContact(sessionId: string, peerId: string): Promise<UiContactCheck>', summary: 'Re-read ListFriends/Status without dialing again.' },
          { kind: 'method', name: 'share', signature: 'share(sessionId: string): Promise<UiShareInfo>', summary: 'Return the full local Peer ID and shareable advertised/relay addresses.' },
          { kind: 'method', name: 'conversations', signature: 'conversations(sessionId: string, force?: boolean): Promise<UiConversations>', summary: 'Read Peer-grouped conversation summaries from retained message rows.' },
          { kind: 'method', name: 'messages', signature: 'messages(sessionId: string, peerId: string, before?: string, force?: boolean): Promise<UiMessagePage>', summary: 'Read one Peer retained message page with a stable older cursor.' },
          { kind: 'method', name: 'send', signature: 'send(sessionId: string, peerId: string, text: string, requestId: string): Promise<UiSendResult>', summary: 'Send one human-origin message through the explicit local operator path.' },
          { kind: 'method', name: 'cancelOutbox', signature: 'cancelOutbox(sessionId: string, messageId: string): Promise<UiCancelResult>', summary: 'Cancel one pending outbox entry without claiming delivery.' },
          { kind: 'method', name: 'discoveries', signature: 'discoveries(sessionId: string, familiar?: boolean, force?: boolean): Promise<UiDiscoveries>', summary: 'Read private Agent acquisition evidence and verify versioned public posts; familiar filters against a complete human relation snapshot.' },
          { kind: 'method', name: 'discoveryContent', signature: 'discoveryContent(sessionId: string, id: string): Promise<UiDiscoveryContent>', summary: 'Read one verified downloaded post by its private discovery id; never returns a filesystem URL.' },
          { kind: 'method', name: 'humanOutbound', signature: 'humanOutbound(sessionId: string, force?: boolean): Promise<UiHumanOutbound>', summary: 'Read the durable human-outbound relation set through stable snapshot pages.' },
          { kind: 'method', name: 'mine', signature: 'mine(sessionId: string, force?: boolean): Promise<UiMine>', summary: 'Read the local public user profile and only explicitly user-authored public posts.' },
          { kind: 'method', name: 'peerProfile', signature: 'peerProfile(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerProfile>', summary: 'Read a remote user profile and separately sourced public Agent card.' },
          { kind: 'method', name: 'journey', signature: 'journey(sessionId: string, force?: boolean): Promise<UiJourney>', summary: 'Read controlled private Persona/Growth and existing Journey session schemas.' },
          { kind: 'method', name: 'locateMessage', signature: 'locateMessage(sessionId: string, peerId: string, messageId: string): Promise<UiLocatedMessage>', summary: 'Check whether a Journey message reference is still retained, without substituting another message.' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: UI_INVOCATIONS,
};

export default TYPERT;
