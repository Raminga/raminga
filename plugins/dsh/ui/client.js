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
    const friendNameCodec = passthrough('@raminga/dsh#UiFriendName');
    const friendDescriptionCodec = passthrough('@raminga/dsh#UiFriendDescription');
    const requestIdCodec = passthrough('@raminga/dsh#UiRequestId');
    const messageIdCodec = passthrough('@raminga/dsh#MessageId');
    const contentIdCodec = passthrough('@raminga/dsh#UiContentId');
    const subjectCodec = passthrough('@raminga/dsh#UiFileSubject');
    const filePathCodec = passthrough('@raminga/dsh#UiPublicFilePath');
    const sha256Codec = passthrough('@raminga/dsh#UiSha256');
    const sizeCodec = passthrough('@raminga/dsh#UiByteSize');
    const privateFieldCodec = passthrough('@raminga/dsh#UiPrivateField');
    const privateContentCodec = passthrough('@raminga/dsh#UiPrivateContent');
    const expectedShaCodec = passthrough('@raminga/dsh#UiExpectedSha256');
    const titleCodec = passthrough('@raminga/dsh#UiFavoriteTitle');
    const contactInputCodec = passthrough('@raminga/dsh#UiContactImpressionSave');
    const journeyIdCodec = passthrough('@raminga/dsh#UiJourneyId');
    const operationIdCodec = passthrough('@raminga/dsh#UiOperationId');
    const activityLimitCodec = passthrough('@raminga/dsh#UiActivityLimit');
    const draftIdCodec = passthrough('@raminga/dsh#UiDraftId');
    const assetIdCodec = passthrough('@raminga/dsh#UiDraftAssetId');
    const draftKindCodec = passthrough('@raminga/dsh#UiDraftKind');
    const draftInputCodec = passthrough('@raminga/dsh#UiPublicDraftSave');
    const draftRoleCodec = passthrough('@raminga/dsh#UiDraftImageRole');
    const filenameCodec = passthrough('@raminga/dsh#UiFileName');
    const imageDataCodec = passthrough('@raminga/dsh#UiImageBase64');
    const revisionCodec = passthrough('@raminga/dsh#UiDraftRevision');
    const publishedShaCodec = passthrough('@raminga/dsh#UiPublishedSha256');
    const bootstrapShareCodeCodec = passthrough('@raminga/dsh#UiBootstrapShareCode');
    const sessionParam = { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec };
    const param = {
      force: { name: 'force', wire: 'force', source: 'json', codec: booleanCodec },
      includeAddresses: { name: 'includeAddresses', wire: 'includeAddresses', source: 'json', codec: passthrough('@raminga/dsh#UiAddressSelection') },
      connectInput: { name: 'input', wire: 'input', source: 'json', codec: connectInputCodec },
      peerId: { name: 'peerId', wire: 'peerId', source: 'json', codec: peerIdCodec },
      before: { name: 'before', wire: 'before', source: 'json', codec: beforeCodec },
      text: { name: 'text', wire: 'text', source: 'json', codec: textCodec },
      friendName: { name: 'name', wire: 'name', source: 'json', codec: friendNameCodec },
      friendDescription: { name: 'description', wire: 'description', source: 'json', codec: friendDescriptionCodec },
      requestId: { name: 'requestId', wire: 'requestId', source: 'json', codec: requestIdCodec },
      messageId: { name: 'messageId', wire: 'messageId', source: 'json', codec: messageIdCodec },
      familiar: { name: 'familiar', wire: 'familiar', source: 'json', codec: booleanCodec },
      contentId: { name: 'id', wire: 'id', source: 'json', codec: contentIdCodec },
      subject: { name: 'subject', wire: 'subject', source: 'json', codec: subjectCodec },
      filePath: { name: 'path', wire: 'path', source: 'json', codec: filePathCodec },
      sha256: { name: 'sha256', wire: 'sha256', source: 'json', codec: sha256Codec },
      size: { name: 'size', wire: 'size', source: 'json', codec: sizeCodec },
      privateField: { name: 'field', wire: 'field', source: 'json', codec: privateFieldCodec },
      privateContent: { name: 'content', wire: 'content', source: 'json', codec: privateContentCodec },
      expectedSha: { name: 'expectedSha256', wire: 'expectedSha256', source: 'json', codec: expectedShaCodec },
      title: { name: 'title', wire: 'title', source: 'json', codec: titleCodec },
      favorite: { name: 'favorite', wire: 'favorite', source: 'json', codec: booleanCodec },
      contactInput: { name: 'input', wire: 'input', source: 'json', codec: contactInputCodec },
      journeyId: { name: 'journeyId', wire: 'journeyId', source: 'json', codec: journeyIdCodec },
      operationId: { name: 'operationId', wire: 'operationId', source: 'json', codec: operationIdCodec },
      limit: { name: 'limit', wire: 'limit', source: 'json', codec: activityLimitCodec },
      draftId: { name: 'draftId', wire: 'draftId', source: 'json', codec: draftIdCodec },
      assetId: { name: 'assetId', wire: 'assetId', source: 'json', codec: assetIdCodec },
      draftKind: { name: 'kind', wire: 'kind', source: 'json', codec: draftKindCodec },
      draftInput: { name: 'input', wire: 'input', source: 'json', codec: draftInputCodec },
      draftRole: { name: 'role', wire: 'role', source: 'json', codec: draftRoleCodec },
      filename: { name: 'filename', wire: 'filename', source: 'json', codec: filenameCodec },
      imageData: { name: 'dataBase64', wire: 'dataBase64', source: 'json', codec: imageDataCodec },
      revision: { name: 'expectedRevision', wire: 'expectedRevision', source: 'json', codec: revisionCodec },
      publishedSha: { name: 'expectedPublishedSha256', wire: 'expectedPublishedSha256', source: 'json', codec: publishedShaCodec },
      bootstrapShareCode: { name: 'shareCode', wire: 'shareCode', source: 'json', codec: bootstrapShareCodeCodec },
    };
    const descriptors = [
      ['open', 'UiSnapshot', [sessionParam]],
      ['poll', 'UiSnapshot', [sessionParam]],
      ['refresh', 'UiSnapshot', [sessionParam]],
      ['close', 'UiStats', [sessionParam]],
      ['contacts', 'UiContacts', [sessionParam, param.force]],
      ['setFriendName', 'UiFriendEdit', [sessionParam, param.peerId, param.friendName]],
      ['setFriendDescription', 'UiFriendEdit', [sessionParam, param.peerId, param.friendDescription]],
      ['connect', 'UiConnectResult', [sessionParam, param.connectInput]],
      ['checkContact', 'UiContactCheck', [sessionParam, param.peerId]],
      ['share', 'UiShareInfo', [sessionParam]],
      ['contactCard', 'UiContactCard', [sessionParam, param.peerId, param.includeAddresses]],
      ['previewContactCard', 'UiContactCardPreview', [sessionParam, param.connectInput]],
      ['conversations', 'UiConversations', [sessionParam, param.force]],
      ['messages', 'UiMessagePage', [sessionParam, param.peerId, param.before, param.force]],
      ['markRead', 'UiMarkRead', [sessionParam, param.peerId, param.messageId]],
      ['favorites', 'UiFavorites', [sessionParam, param.before, param.force]],
      ['setFavorite', 'UiFavoriteResult', [sessionParam, param.peerId, param.filePath, param.sha256, param.title, param.favorite]],
      ['peerDiscoveries', 'UiPeerDiscoveries', [sessionParam, param.peerId, param.force]],
      ['contactMemory', 'UiContactMemory', [sessionParam, param.peerId]],
      ['saveContactImpression', 'UiContactImpressionSave', [sessionParam, param.contactInput]],
      ['send', 'UiSendResult', [sessionParam, param.peerId, param.text, param.requestId]],
      ['cancelOutbox', 'UiCancelResult', [sessionParam, param.messageId]],
      ['discoveries', 'UiDiscoveries', [sessionParam, param.familiar, param.force]],
      ['refreshDiscoveries', 'UiManualDiscoveries', [sessionParam, param.familiar]],
      ['discoveryContent', 'UiDiscoveryContent', [sessionParam, param.contentId]],
      ['humanOutbound', 'UiHumanOutbound', [sessionParam, param.force]],
      ['mine', 'UiMine', [sessionParam, param.force]],
      ['mineFilePreview', 'UiFilePreview', [sessionParam, param.filePath, param.sha256, param.size]],
      ['peerProfile', 'UiPeerProfile', [sessionParam, param.peerId, param.force]],
      ['peerFriends', 'UiPeerFriends', [sessionParam, param.peerId, param.force]],
      ['contactProjection', 'UiContactProjection', [sessionParam]],
      ['peerManifest', 'UiPeerManifest', [sessionParam, param.peerId, param.force]],
      ['peerFilePreview', 'UiFilePreview', [sessionParam, param.peerId, param.filePath, param.sha256, param.size]],
      ['peerPostMeta', 'UiPostMeta', [sessionParam, param.peerId, param.filePath, param.sha256, param.size]],
      ['peerNodeInfo', 'UiPeerNodeInfo', [sessionParam, param.peerId, param.force]],
      ['revealDiscovery', 'UiRevealResult', [sessionParam, param.contentId]],
      ['revealFile', 'UiRevealResult', [sessionParam, param.subject, param.peerId, param.filePath, param.sha256, param.size]],
      ['bootstrap', 'UiBootstrapInfo', [sessionParam]],
      ['addBootstrap', 'UiBootstrapEdit', [sessionParam, param.bootstrapShareCode]],
      ['removeBootstrap', 'UiBootstrapEdit', [sessionParam, param.peerId]],
      ['journey', 'UiJourney', [sessionParam, param.force]],
      ['journeyReport', 'UiJourneyReport', [sessionParam, param.journeyId]],
      ['activity', 'UiActivity', [sessionParam, param.limit]],
      ['activityDetail', 'UiActivityDetail', [param.operationId]],
      ['savePrivateAgent', 'UiPrivateAgentSave', [sessionParam, param.privateField, param.privateContent, param.expectedSha]],
      ['publicDraft', 'UiPublicDraftRead', [sessionParam, param.draftId]],
      ['publicDrafts', 'UiPublicDraftList', [sessionParam, param.draftKind]],
      ['savePublicDraft', 'UiPublicDraftSaveResult', [sessionParam, param.draftInput]],
      ['putPublicDraftImage', 'UiPublicDraftImageResult', [sessionParam, param.draftId, param.draftRole, param.filename, param.imageData]],
      ['publicDraftAsset', 'UiPublicDraftAssetRead', [sessionParam, param.draftId, param.assetId]],
      ['importPublicPost', 'UiPublicDraftImportResult', [sessionParam, param.filePath]],
      ['deletePublicDraft', 'UiPublicDraftDelete', [sessionParam, param.draftId, param.revision]],
      ['publishPublicDraft', 'UiPublishResult', [sessionParam, param.draftId, param.revision, param.publishedSha, param.requestId]],
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
          // Isolate the plugin's internal z-indexes from the native sidebar
          // slot (z-index 15). The DSH shell still owns the one native
          // sidebar and its leading control; no second sidebar is created.
          style: { display: 'block', width: '100%', height: '100%', minHeight: 0, position: 'relative', zIndex: 0, isolation: 'isolate' },
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
