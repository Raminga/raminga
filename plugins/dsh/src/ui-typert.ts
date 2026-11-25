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
const addressSelectionCodec = codec('@raminga/dsh#UiAddressSelection');
const connectInputCodec = codec('@raminga/dsh#UiConnectInput');
const peerIdCodec = codec('@raminga/dsh#PeerId');
const beforeCodec = codec('@raminga/dsh#UiBeforeCursor');
const textCodec = codec('@raminga/dsh#UiMessageText');
const friendNameCodec = codec('@raminga/dsh#UiFriendName');
const friendDescriptionCodec = codec('@raminga/dsh#UiFriendDescription');
const requestIdCodec = codec('@raminga/dsh#UiRequestId');
const messageIdCodec = codec('@raminga/dsh#MessageId');
const contentIdCodec = codec('@raminga/dsh#UiContentId');
const subjectCodec = codec('@raminga/dsh#UiFileSubject');
const filePathCodec = codec('@raminga/dsh#UiPublicFilePath');
const sha256Codec = codec('@raminga/dsh#UiSha256');
const privateFieldCodec = codec('@raminga/dsh#UiPrivateField');
const privateContentCodec = codec('@raminga/dsh#UiPrivateContent');
const expectedShaCodec = codec('@raminga/dsh#UiExpectedSha256');
const sizeCodec = codec('@raminga/dsh#UiByteSize');
const draftIdCodec = codec('@raminga/dsh#UiDraftId');
const assetIdCodec = codec('@raminga/dsh#UiDraftAssetId');
const draftKindCodec = codec('@raminga/dsh#UiDraftKind');
const draftInputCodec = codec('@raminga/dsh#UiPublicDraftSave');
const draftRoleCodec = codec('@raminga/dsh#UiDraftImageRole');
const filenameCodec = codec('@raminga/dsh#UiFileName');
const imageDataCodec = codec('@raminga/dsh#UiImageBase64');
const revisionCodec = codec('@raminga/dsh#UiDraftRevision');
const publishedShaCodec = codec('@raminga/dsh#UiPublishedSha256');
const bootstrapShareCodeCodec = codec('@raminga/dsh#UiBootstrapShareCode');
const titleCodec = codec('@raminga/dsh#UiFavoriteTitle');
const contactInputCodec = codec('@raminga/dsh#UiContactImpressionSave');
const journeyIdCodec = codec('@raminga/dsh#UiJourneyId');
const operationIdCodec = codec('@raminga/dsh#UiOperationId');
const activityLimitCodec = codec('@raminga/dsh#UiActivityLimit');
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

type ParamKind = 'session' | 'boolean' | 'includeAddresses' | 'familiar' | 'bootstrapShareCode' | 'connectInput' | 'peerId' | 'before' | 'text' | 'friendName' | 'friendDescription' | 'requestId' | 'messageId' | 'contentId' | 'subject' | 'filePath' | 'sha256' | 'size' | 'privateField' | 'privateContent' | 'expectedSha' | 'draftId' | 'draftKind' | 'draftInput' | 'draftRole' | 'filename' | 'imageData' | 'assetId' | 'revision' | 'publishedSha' | 'title' | 'favorite' | 'contactInput' | 'journeyId' | 'operationId' | 'limit';

const PARAMS: Record<ParamKind, { name: string; wire: string; codec: PassthroughCodec }> = {
  session: { name: 'sessionId', wire: 'sessionId', codec: sessionIdCodec },
  boolean: { name: 'force', wire: 'force', codec: booleanCodec },
  includeAddresses: { name: 'includeAddresses', wire: 'includeAddresses', codec: addressSelectionCodec },
  familiar: { name: 'familiar', wire: 'familiar', codec: booleanCodec },
  bootstrapShareCode: { name: 'shareCode', wire: 'shareCode', codec: bootstrapShareCodeCodec },
  connectInput: { name: 'input', wire: 'input', codec: connectInputCodec },
  peerId: { name: 'peerId', wire: 'peerId', codec: peerIdCodec },
  before: { name: 'before', wire: 'before', codec: beforeCodec },
  text: { name: 'text', wire: 'text', codec: textCodec },
  friendName: { name: 'name', wire: 'name', codec: friendNameCodec },
  friendDescription: { name: 'description', wire: 'description', codec: friendDescriptionCodec },
  requestId: { name: 'requestId', wire: 'requestId', codec: requestIdCodec },
  messageId: { name: 'messageId', wire: 'messageId', codec: messageIdCodec },
  contentId: { name: 'id', wire: 'id', codec: contentIdCodec },
  subject: { name: 'subject', wire: 'subject', codec: subjectCodec },
  filePath: { name: 'path', wire: 'path', codec: filePathCodec },
  sha256: { name: 'sha256', wire: 'sha256', codec: sha256Codec },
  size: { name: 'size', wire: 'size', codec: sizeCodec },
  privateField: { name: 'field', wire: 'field', codec: privateFieldCodec },
  privateContent: { name: 'content', wire: 'content', codec: privateContentCodec },
  expectedSha: { name: 'expectedSha256', wire: 'expectedSha256', codec: expectedShaCodec },
  draftId: { name: 'draftId', wire: 'draftId', codec: draftIdCodec },
  assetId: { name: 'assetId', wire: 'assetId', codec: assetIdCodec },
  draftKind: { name: 'kind', wire: 'kind', codec: draftKindCodec },
  draftInput: { name: 'input', wire: 'input', codec: draftInputCodec },
  draftRole: { name: 'role', wire: 'role', codec: draftRoleCodec },
  filename: { name: 'filename', wire: 'filename', codec: filenameCodec },
  imageData: { name: 'dataBase64', wire: 'dataBase64', codec: imageDataCodec },
  revision: { name: 'expectedRevision', wire: 'expectedRevision', codec: revisionCodec },
  publishedSha: { name: 'expectedPublishedSha256', wire: 'expectedPublishedSha256', codec: publishedShaCodec },
  title: { name: 'title', wire: 'title', codec: titleCodec },
  favorite: { name: 'favorite', wire: 'favorite', codec: booleanCodec },
  contactInput: { name: 'input', wire: 'input', codec: contactInputCodec },
  journeyId: { name: 'journeyId', wire: 'journeyId', codec: journeyIdCodec },
  operationId: { name: 'operationId', wire: 'operationId', codec: operationIdCodec },
  limit: { name: 'limit', wire: 'limit', codec: activityLimitCodec },
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
  invocation('setFriendName', ['session', 'peerId', 'friendName'], 'UiFriendEdit'),
  invocation('setFriendDescription', ['session', 'peerId', 'friendDescription'], 'UiFriendEdit'),
  invocation('connect', ['session', 'connectInput'], 'UiConnectResult'),
  invocation('checkContact', ['session', 'peerId'], 'UiContactCheck'),
  invocation('share', ['session'], 'UiShareInfo'),
  invocation('contactCard', ['session', 'peerId', 'includeAddresses'], 'UiContactCard'),
  invocation('previewContactCard', ['session', 'connectInput'], 'UiContactCardPreview'),
  invocation('conversations', ['session', 'boolean'], 'UiConversations'),
  invocation('messages', ['session', 'peerId', 'before', 'boolean'], 'UiMessagePage'),
  invocation('markRead', ['session', 'peerId', 'messageId'], 'UiMarkRead'),
  invocation('favorites', ['session', 'before', 'boolean'], 'UiFavorites'),
  invocation('setFavorite', ['session', 'peerId', 'filePath', 'sha256', 'title', 'favorite'], 'UiFavoriteResult'),
  invocation('peerDiscoveries', ['session', 'peerId', 'boolean'], 'UiPeerDiscoveries'),
  invocation('contactMemory', ['session', 'peerId'], 'UiContactMemory'),
  invocation('saveContactImpression', ['session', 'contactInput'], 'UiContactImpressionSave'),
  invocation('send', ['session', 'peerId', 'text', 'requestId'], 'UiSendResult'),
  invocation('cancelOutbox', ['session', 'messageId'], 'UiCancelResult'),
  invocation('discoveries', ['session', 'familiar', 'boolean'], 'UiDiscoveries'),
  invocation('refreshDiscoveries', ['session', 'familiar'], 'UiManualDiscoveries'),
  invocation('discoveryContent', ['session', 'contentId'], 'UiDiscoveryContent'),
  invocation('humanOutbound', ['session', 'boolean'], 'UiHumanOutbound'),
  invocation('mine', ['session', 'boolean'], 'UiMine'),
  invocation('mineFilePreview', ['session', 'filePath', 'sha256', 'size'], 'UiFilePreview'),
  invocation('peerProfile', ['session', 'peerId', 'boolean'], 'UiPeerProfile'),
  invocation('peerFriends', ['session', 'peerId', 'boolean'], 'UiPeerFriends'),
  invocation('contactProjection', ['session'], 'UiContactProjection'),
  invocation('peerManifest', ['session', 'peerId', 'boolean'], 'UiPeerManifest'),
  invocation('peerFilePreview', ['session', 'peerId', 'filePath', 'sha256', 'size'], 'UiFilePreview'),
  invocation('peerPostMeta', ['session', 'peerId', 'filePath', 'sha256', 'size'], 'UiPostMeta'),
  invocation('peerNodeInfo', ['session', 'peerId', 'boolean'], 'UiPeerNodeInfo'),
  invocation('revealDiscovery', ['session', 'contentId'], 'UiRevealResult'),
  invocation('revealFile', ['session', 'subject', 'peerId', 'filePath', 'sha256', 'size'], 'UiRevealResult'),
  invocation('bootstrap', ['session'], 'UiBootstrapInfo'),
  invocation('addBootstrap', ['session', 'bootstrapShareCode'], 'UiBootstrapEdit'),
  invocation('removeBootstrap', ['session', 'peerId'], 'UiBootstrapEdit'),
  invocation('journey', ['session', 'boolean'], 'UiJourney'),
  invocation('journeyReport', ['session', 'journeyId'], 'UiJourneyReport'),
  invocation('activity', ['session', 'limit'], 'UiActivity'),
  invocation('activityDetail', ['operationId'], 'UiActivityDetail'),
  invocation('savePrivateAgent', ['session', 'privateField', 'privateContent', 'expectedSha'], 'UiPrivateAgentSave'),
  invocation('publicDraft', ['session', 'draftId'], 'UiPublicDraftRead'),
  invocation('publicDrafts', ['session', 'draftKind'], 'UiPublicDraftList'),
  invocation('savePublicDraft', ['session', 'draftInput'], 'UiPublicDraftSaveResult'),
  invocation('putPublicDraftImage', ['session', 'draftId', 'draftRole', 'filename', 'imageData'], 'UiPublicDraftImageResult'),
  invocation('publicDraftAsset', ['session', 'draftId', 'assetId'], 'UiPublicDraftAssetRead'),
  invocation('importPublicPost', ['session', 'filePath'], 'UiPublicDraftImportResult'),
  invocation('deletePublicDraft', ['session', 'draftId', 'revision'], 'UiPublicDraftDelete'),
  invocation('publishPublicDraft', ['session', 'draftId', 'revision', 'publishedSha', 'requestId'], 'UiPublishResult'),
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
          { kind: 'method', name: 'setFriendName', signature: 'setFriendName(sessionId: string, peerId: string, name: string): Promise<UiFriendEdit>', summary: 'Save one local contact name, then reread ListFriends. Blank explicitly clears the local label.' },
          { kind: 'method', name: 'setFriendDescription', signature: 'setFriendDescription(sessionId: string, peerId: string, description: string): Promise<UiFriendEdit>', summary: 'Save one local contact description, then reread ListFriends. Blank explicitly clears the local note.' },
          { kind: 'method', name: 'connect', signature: 'connect(sessionId: string, input: string): Promise<UiConnectResult>', summary: 'Validate and dial one Peer ID or full multiaddr, then verify contacts and Status separately.' },
          { kind: 'method', name: 'checkContact', signature: 'checkContact(sessionId: string, peerId: string): Promise<UiContactCheck>', summary: 'Re-read ListFriends/Status without dialing again.' },
          { kind: 'method', name: 'share', signature: 'share(sessionId: string): Promise<UiShareInfo>', summary: 'Return the full local Peer ID and shareable advertised/relay addresses.' },
          { kind: 'method', name: 'contactCard', signature: 'contactCard(sessionId: string, peerId: string, addressSelection: number | boolean): Promise<UiContactCard>', summary: 'Generate a local contact card.' },
          { kind: 'method', name: 'previewContactCard', signature: 'previewContactCard(sessionId: string, input: string): Promise<UiContactCardPreview>', summary: 'Verify and preview an identity without dialing.' },
          { kind: 'method', name: 'conversations', signature: 'conversations(sessionId: string, force?: boolean): Promise<UiConversations>', summary: 'Read Peer-grouped conversation summaries from retained message rows.' },
          { kind: 'method', name: 'messages', signature: 'messages(sessionId: string, peerId: string, before?: string, force?: boolean): Promise<UiMessagePage>', summary: 'Read one Peer retained message page with a stable older cursor.' },
          { kind: 'method', name: 'markRead', signature: 'markRead(sessionId: string, peerId: string, throughMessageId: string): Promise<UiMarkRead>', summary: 'Advance the human read cursor through one retained message; reads never write it.' },
          { kind: 'method', name: 'favorites', signature: 'favorites(sessionId: string, before?: string, force?: boolean): Promise<UiFavorites>', summary: 'List private public-post bookmarks with availability and paging.' },
          { kind: 'method', name: 'setFavorite', signature: 'setFavorite(sessionId: string, peerId: string, path: string, sha256: string, title: string, favorite: boolean): Promise<UiFavoriteResult>', summary: 'Idempotently save or clear one public-post bookmark.' },
          { kind: 'method', name: 'peerDiscoveries', signature: 'peerDiscoveries(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerDiscoveries>', summary: 'List one Peer local discovery copies; never claims a current manifest.' },
          { kind: 'method', name: 'contactMemory', signature: 'contactMemory(sessionId: string, peerId: string): Promise<UiContactMemory>', summary: 'Merge private contact-notes with persisted messages and Journey evidence.' },
          { kind: 'method', name: 'saveContactImpression', signature: 'saveContactImpression(sessionId: string, input: UiContactImpressionSaveInput): Promise<UiContactImpressionSave>', summary: 'Atomically edit one private impression with SHA-256 conflict detection.' },
          { kind: 'method', name: 'send', signature: 'send(sessionId: string, peerId: string, text: string, requestId: string): Promise<UiSendResult>', summary: 'Send one human-origin message through the explicit local operator path.' },
          { kind: 'method', name: 'cancelOutbox', signature: 'cancelOutbox(sessionId: string, messageId: string): Promise<UiCancelResult>', summary: 'Cancel one pending outbox entry without claiming delivery.' },
          { kind: 'method', name: 'discoveries', signature: 'discoveries(sessionId: string, familiar?: boolean, force?: boolean): Promise<UiDiscoveries>', summary: 'Read private Agent acquisition evidence and verify versioned public posts; familiar filters on persisted human or real Agent outbound messages.' },
          { kind: 'method', name: 'refreshDiscoveries', signature: 'refreshDiscoveries(sessionId: string, familiar?: boolean): Promise<UiManualDiscoveries>', summary: 'Explicit Feed refresh only: bounded remote manifest checks for local candidate peers plus a fresh local index read.' },
          { kind: 'method', name: 'discoveryContent', signature: 'discoveryContent(sessionId: string, id: string): Promise<UiDiscoveryContent>', summary: 'Read one verified downloaded post by its private discovery id; never returns a filesystem URL.' },
          { kind: 'method', name: 'humanOutbound', signature: 'humanOutbound(sessionId: string, force?: boolean): Promise<UiHumanOutbound>', summary: 'Read the durable human-outbound relation set through stable snapshot pages.' },
          { kind: 'method', name: 'mine', signature: 'mine(sessionId: string, force?: boolean): Promise<UiMine>', summary: 'Read the local public user profile and only explicitly user-authored public posts.' },
          { kind: 'method', name: 'peerProfile', signature: 'peerProfile(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerProfile>', summary: 'Read a remote user profile and separately sourced public Agent card.' },
          { kind: 'method', name: 'peerFriends', signature: 'peerFriends(sessionId: string, peerId: string, force?: boolean): Promise<UiPeerFriends>', summary: 'Read a remote friends.json as untrusted public address-book claims; never replaces local contacts.' },
          { kind: 'method', name: 'journey', signature: 'journey(sessionId: string, force?: boolean): Promise<UiJourney>', summary: 'Read controlled private Persona/Growth and existing Journey session schemas.' },
          { kind: 'method', name: 'journeyReport', signature: 'journeyReport(sessionId: string, journeyId: string): Promise<UiJourneyReport>', summary: 'Build an offline preview of the selected private Journey report.' },
          { kind: 'method', name: 'activity', signature: 'activity(sessionId: string, limit?: number): Promise<UiActivity>', summary: 'Read the private raminga_* tool-call log with instance id, truncation and bad-line diagnostics.' },
          { kind: 'method', name: 'activityDetail', signature: 'activityDetail(operationId: string): Promise<UiActivityDetail>', summary: 'Return one sanitized tool operation plus a bounded Journey state summary and missing-evidence reason.' },
          { kind: 'method', name: 'savePrivateAgent', signature: 'savePrivateAgent(sessionId: string, field: \'persona\' | \'growth\', content: string, expectedSha256: string): Promise<UiPrivateAgentSave>', summary: 'Atomically save one fixed private Markdown file with optimistic SHA-256 conflict detection.' },
          { kind: 'method', name: 'publicDraft', signature: 'publicDraft(sessionId: string, draftId: string): Promise<UiPublicDraftRead>', summary: 'Read one private SQLite public draft; never publishes it.' },
          { kind: 'method', name: 'publicDrafts', signature: 'publicDrafts(sessionId: string, kind: string): Promise<UiPublicDraftList>', summary: 'List private profile/post drafts.' },
          { kind: 'method', name: 'savePublicDraft', signature: 'savePublicDraft(sessionId: string, input: UiPublicDraftSave): Promise<UiPublicDraftSaveResult>', summary: 'Save a private draft with optimistic revision conflict detection.' },
          { kind: 'method', name: 'putPublicDraftImage', signature: 'putPublicDraftImage(sessionId: string, draftId: string, role: string, filename: string, dataBase64: string): Promise<UiPublicDraftImageResult>', summary: 'Validate and store one private avatar/image; bytes stay in SQLite until publish.' },
          { kind: 'method', name: 'publicDraftAsset', signature: 'publicDraftAsset(sessionId: string, draftId: string, assetId: string): Promise<UiPublicDraftAssetRead>', summary: 'Read one private draft image bytes scoped by draft and asset id; never exposes a public path.' },
          { kind: 'method', name: 'importPublicPost', signature: 'importPublicPost(sessionId: string, publicPath: string): Promise<UiPublicDraftImportResult>', summary: 'Open one existing local public post as a private draft that updates the original path.' },
          { kind: 'method', name: 'deletePublicDraft', signature: 'deletePublicDraft(sessionId: string, draftId: string, expectedRevision: number): Promise<UiPublicDraftDelete>', summary: 'Delete one private draft with revision check.' },
          { kind: 'method', name: 'publishPublicDraft', signature: 'publishPublicDraft(sessionId: string, draftId: string, expectedRevision: number, expectedPublishedSha256: string, requestId?: string): Promise<UiPublishResult>', summary: 'Commit one draft under the daemon publication lock and return real files plus manifest digest.' },
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
