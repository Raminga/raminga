// Public entry of the shared Raminga three-page workspace.
// This module is host-agnostic: it renders NodeStatus and NodeEvent values it
// is handed, but never opens a socket, reads a token, or knows about DSH.
import { CSS, TEMPLATE } from './generated-assets.js';
import { createRamingaApp, resolveNodePhase } from './app.js';
import { createViewState, normalizeViewState } from './view-state.js';

export { createViewState, normalizeViewState, resolveNodePhase };

let mountCount = 0;

/**
 * Mount the workspace into a ShadowRoot owned by `host`.
 * @param {HTMLElement} host
 * @param {{onRefresh?: () => void, onLoadContacts?: (force: boolean) => Promise<object>,
 *   onSetFriendName?: (peerId: string, name: string) => Promise<object>,
 *   onSetFriendDescription?: (peerId: string, description: string) => Promise<object>,
 *   onConnect?: (input: string) => Promise<object>, onCheckContact?: (peerId: string) => Promise<object>,
 *   onShare?: () => Promise<object>, onContactCard?: (peerId: string, addressScopes: number) => Promise<object>,
 *   onPreviewContactCard?: (input: string) => Promise<object>, onLoadConversations?: (force: boolean) => Promise<object>,
 *   onLoadMessages?: (peerId: string, force: boolean) => Promise<object>,
 *   onLoadOlder?: (peerId: string, before: string) => Promise<object>,
 *   onSend?: (peerId: string, text: string, requestId: string) => Promise<object>,
 *   onCancelOutbox?: (peerId: string, messageId: string) => Promise<object>,
 *   onLoadPeerFriends?: (peerId: string, force: boolean) => Promise<object>,
 *   onLoadContactProjection?: () => Promise<object>,
 *   onLoadJourney?: (force: boolean) => Promise<object>,
 *   onLoadActivity?: (limit: number) => Promise<object>,
 *   onLoadActivityDetail?: (operationId: string) => Promise<object>,
 *   onSavePrivateAgent?: (field: 'persona'|'growth', content: string, expectedSha256: string) => Promise<object>,
 *   onLoadPublicDraft?: (draftId: string) => Promise<object>,
 *   onLoadPublicDrafts?: (kind: string) => Promise<object>,
 *   onSavePublicDraft?: (input: object) => Promise<object>,
 *   onPutPublicDraftImage?: (draftId: string, role: string, filename: string, dataBase64: string) => Promise<object>,
 *   onLoadPublicDraftAsset?: (draftId: string, assetId: string) => Promise<{image: object, dataBase64: string}>,
 *   onImportPublicPost?: (path: string) => Promise<{draft: object}>,
 *   onPublishPublicDraft?: (draftId: string, revision: number, expectedPublishedSha256: string) => Promise<object>,
 *   onCopyText?: (text: string) => Promise<boolean>, viewState?: object}} [options]
 * @returns {{
 *   setNodeStatus: Function,
 *   pushNodeEvent: Function,
 *   setStats: Function,
 *   setActivity: Function,
 *   setActivityError: Function,
 *   setContacts: Function,
 *   setContactsError: Function,
 *   setConversations: Function,
 *   setConversationsError: Function,
 *   setMessagePage: Function,
 *   appendMessagePage: Function,
 *   setMessagesError: Function,
 *   activeConversationPeer: () => string,
 *   getDraft: (key: string) => string,
 *   setDraft: (key: string, value: string) => void,
 *   destroy: () => void,
 * }}
 */
export function mountRamingaApp(host, options = {}) {
  if (!host || host.nodeType !== 1) throw new TypeError('mountRamingaApp requires an HTMLElement host');
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style data-raminga-styles>${CSS}</style><div class="rm-ui-root">${TEMPLATE}</div>`;
  const app = createRamingaApp(shadow, options);
  mountCount += 1;
  let destroyed = false;
  return {
    setNodeStatus(snapshot) {
      if (!destroyed) app.setNodeStatus(snapshot);
    },
    pushNodeEvent(event) {
      if (!destroyed) app.pushNodeEvent(event);
    },
    setStats(stats) {
      if (!destroyed) app.setStats(stats);
    },
    setActivity(activity) {
      if (!destroyed) app.setActivity(activity);
    },
    setActivityError(error) {
      if (!destroyed) app.setActivityError(error);
    },
    setContacts(contacts) {
      if (!destroyed) app.setContacts(contacts);
    },
    setContactsError(error) {
      if (!destroyed) app.setContactsError(error);
    },
    setConversations(conversations) {
      if (!destroyed) app.setConversations(conversations);
    },
    setConversationsError(error) {
      if (!destroyed) app.setConversationsError(error);
    },
    setMessagePage(page) {
      if (!destroyed) app.setMessagePage(page);
    },
    appendMessagePage(page) {
      if (!destroyed) app.appendMessagePage(page);
    },
    setMessagesError(peerId, error) {
      if (!destroyed) app.setMessagesError(peerId, error);
    },
    activeConversationPeer() {
      return destroyed ? '' : app.activeConversationPeer();
    },
    onLeaseReady() {
      if (!destroyed) app.onLeaseReady();
    },
    getDraft(key) {
      return destroyed ? '' : app.getDraft(key);
    },
    setDraft(key, value) {
      if (!destroyed) app.setDraft(key, value);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      app.destroy();
      mountCount -= 1;
    },
  };
}

/** Number of live mounts; used by focused unit tests and diagnostics. */
export function liveMountCount() {
  return mountCount;
}
