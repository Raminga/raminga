// Public entry of the shared Raminga five-page workspace.
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
 *   onConnect?: (input: string) => Promise<object>, onCheckContact?: (peerId: string) => Promise<object>,
 *   onShare?: () => Promise<object>, onLoadConversations?: (force: boolean) => Promise<object>,
 *   onLoadMessages?: (peerId: string, force: boolean) => Promise<object>,
 *   onLoadOlder?: (peerId: string, before: string) => Promise<object>,
 *   onSend?: (peerId: string, text: string, requestId: string) => Promise<object>,
 *   onCancelOutbox?: (peerId: string, messageId: string) => Promise<object>,
 *   onCopyText?: (text: string) => Promise<boolean>, viewState?: object}} [options]
 * @returns {{
 *   setNodeStatus: Function,
 *   pushNodeEvent: Function,
 *   setStats: Function,
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
