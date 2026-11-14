// DSH browser adapter for the shared Raminga five-page workspace.
//
// Supported mounting path (verified against the installed DSH 0.2.2-rc.2
// public client contracts and the shipped plugin-manager panel):
//   package.json dsh.client.platform = "web"
//   package.json exports["./client"] = this lazy window.__ModuleLoader__ bundle
//   ctx.remote.$mount(<ramingaUi contribution>)
//   ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'raminga' }, Panel))
//   ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ id: 'raminga' }, Icon))
// Selecting the native sidebar row is DSH's own `ctx.layout.selectPanel('raminga')`.
// No iframe, no second app root, no DOM writes outside the React-owned host.
window.__ModuleLoader__.load({
  id: '@raminga/dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*__RAMINGA_UI_BUNDLE__*/
    /*__RAMINGA_PANEL_RUNTIME__*/

    const PANEL_ID = 'raminga';
    const REMOTE_PACKAGE = '@raminga/dsh';

    function passthrough(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol,
        create: () => ({ parse: (value) => value, encode: (value) => value }),
      };
    }

    const sessionIdCodec = passthrough('@raminga/dsh#SessionId');
    const booleanCodec = passthrough('@raminga/dsh#UiBoolean');
    const connectInputCodec = passthrough('@raminga/dsh#UiConnectInput');
    const peerIdCodec = passthrough('@raminga/dsh#PeerId');
    const beforeCodec = passthrough('@raminga/dsh#UiBeforeCursor');
    const textCodec = passthrough('@raminga/dsh#UiMessageText');
    const requestIdCodec = passthrough('@raminga/dsh#UiRequestId');
    const messageIdCodec = passthrough('@raminga/dsh#MessageId');
    const contentIdCodec = passthrough('@raminga/dsh#UiContentId');
    const sessionParam = { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec };
    const param = {
      force: { name: 'force', wire: 'force', source: 'json', codec: booleanCodec },
      connectInput: { name: 'input', wire: 'input', source: 'json', codec: connectInputCodec },
      peerId: { name: 'peerId', wire: 'peerId', source: 'json', codec: peerIdCodec },
      before: { name: 'before', wire: 'before', source: 'json', codec: beforeCodec },
      text: { name: 'text', wire: 'text', source: 'json', codec: textCodec },
      requestId: { name: 'requestId', wire: 'requestId', source: 'json', codec: requestIdCodec },
      messageId: { name: 'messageId', wire: 'messageId', source: 'json', codec: messageIdCodec },
      familiar: { name: 'familiar', wire: 'familiar', source: 'json', codec: booleanCodec },
      contentId: { name: 'id', wire: 'id', source: 'json', codec: contentIdCodec },
    };
    const descriptors = [
      ['open', 'UiSnapshot', [sessionParam]],
      ['poll', 'UiSnapshot', [sessionParam]],
      ['refresh', 'UiSnapshot', [sessionParam]],
      ['close', 'UiStats', [sessionParam]],
      ['contacts', 'UiContacts', [sessionParam, param.force]],
      ['connect', 'UiConnectResult', [sessionParam, param.connectInput]],
      ['checkContact', 'UiContactCheck', [sessionParam, param.peerId]],
      ['share', 'UiShareInfo', [sessionParam]],
      ['conversations', 'UiConversations', [sessionParam, param.force]],
      ['messages', 'UiMessagePage', [sessionParam, param.peerId, param.before, param.force]],
      ['send', 'UiSendResult', [sessionParam, param.peerId, param.text, param.requestId]],
      ['cancelOutbox', 'UiCancelResult', [sessionParam, param.messageId]],
      ['discoveries', 'UiDiscoveries', [sessionParam, param.familiar, param.force]],
      ['discoveryContent', 'UiDiscoveryContent', [sessionParam, param.contentId]],
      ['humanOutbound', 'UiHumanOutbound', [sessionParam, param.force]],
      ['mine', 'UiMine', [sessionParam, param.force]],
      ['peerProfile', 'UiPeerProfile', [sessionParam, param.peerId, param.force]],
      ['journey', 'UiJourney', [sessionParam, param.force]],
      ['locateMessage', 'UiLocatedMessage', [sessionParam, param.peerId, param.messageId]],
    ].map(([method, resultType, parameters]) => ({
      id: `${REMOTE_PACKAGE}#ramingaUi/${method}`,
      service: 'ramingaUi',
      namespace: 'ramingaUi',
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: passthrough(`${REMOTE_PACKAGE}#${resultType}`),
    }));
    const contribution = { package: REMOTE_PACKAGE, descriptors };

    function remoteValue(result) {
      if (result === null || typeof result !== 'object') throw new Error('Raminga Remote returned no result');
      if (result.ok !== true) throw new Error(result.error?.message ?? 'Raminga Remote failed');
      return result.value;
    }


    function createSessionId() {
      return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    // One workspace view-state object lives for the loaded plugin. The native
    // DSH main panel unmounts when another panel is selected; this object lets
    // the next mount restore navigation/search/scroll (and future drafts)
    // without retaining subscriptions, timers or detached DOM.
    const viewState = RamingaUI.createViewState();

    function createPanel(rpc) {
      return function RamingaPanel() {
        const hostRef = React.useRef(null);
        const [bootError, setBootError] = React.useState(null);

        React.useEffect(() => {
          const runtime = createPanelRuntime({
            rpc,
            mount: (host, options) => RamingaUI.mountRamingaApp(host, options),
            viewState,
            resolvePhase: RamingaUI.resolveNodePhase,
            sessionId: createSessionId(),
            onBootError: (error) => {
              console.error('[raminga-ui] panel mount failed', error);
              setBootError('Raminga 暂时无法打开，请切换到其他页面后重试。');
            },
          });
          runtime.start(hostRef.current);
          return () => runtime.dispose();
        }, []);

        if (bootError) {
          return h('div', {
            role: 'alert',
            'data-raminga-panel-error': 'true',
            style: { display: 'block', width: '100%', height: '100%', padding: 24, font: '13px system-ui, sans-serif' },
          }, bootError);
        }
        return h('div', {
          ref: hostRef,
          className: 'raminga-main-host',
          'data-raminga-panel': 'true',
          'aria-label': 'Raminga 主工作区',
          style: { display: 'block', width: '100%', height: '100%', minHeight: 0 },
        });
      };
    }

    // The native sidebar owns the row, selection state and click handling;
    // this is only the glyph it renders at the requested size.
    function RamingaPanelIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 256 256',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        fill: 'currentColor',
        d: 'M 132 138 C 157 143 184 159 206 182 C 224 203 220 222 204 229 C 189 237 175 230 162 214 L 140 188 C 129 176 116 171 101 170 Z',
      }), h('path', {
        fill: 'currentColor',
        d: 'M 48 102 C 36 102 28 93 31 81 C 40 51 84 27 126 27 C 178 27 214 53 214 88 C 214 123 184 147 145 162 L 122 171 C 98 182 80 198 67 221 C 60 233 44 236 32 228 C 21 221 18 208 24 195 C 44 155 73 132 113 116 L 145 104 C 162 97 173 91 173 82 C 173 70 155 64 137 64 C 107 64 80 76 63 94 C 59 99 54 102 48 102 Z',
      }));
    }

    return {
      inject: ['remote', 'slots', 'layout'],
      async apply(ctx) {
        const remote = ctx.remote;
        if (remote === undefined || typeof remote.$mount !== 'function') {
          console.warn('[raminga-ui] ctx.remote.$mount is unavailable; main workspace not mounted');
          return;
        }
        const disposeRemote = await remote.$mount(contribution);
        ctx.effect(() => () => { void disposeRemote(); }, 'raminga-ui: remote contribution');
        const rpc = ctx.get('remote.ramingaUi');
        if (rpc === undefined) {
          console.warn('[raminga-ui] remote.ramingaUi namespace is unavailable; main workspace not mounted');
          return;
        }
        const Panel = createPanel(rpc);
        ctx.effect(() => {
          const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, Panel));
          const disposeEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => 'Raminga',
          }, RamingaPanelIcon));
          return () => {
            disposeEntry();
            disposeMain();
          };
        }, 'raminga-ui: native main workspace + sidebar entry');
      },
    };
  },
});
