// Send real unread messages from fixture B to fixture A while the isolated C1
// DSH host is running. It reconnects to A's current (random) TCP address first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import {
  ConnectRequest,
  SendChatRequest,
  StatusRequest,
} from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.C1_ACCEPTANCE_DIR
  ? path.resolve(process.env.C1_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'c1');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const bin = path.join(repoRoot, 'bin', 'raminga');
const count = Math.max(1, Math.min(10, Number(process.env.C1_UNREAD_COUNT || 3)));
const tag = String(process.env.C1_UNREAD_TAG || Date.now());

async function main() {
  const apiA = new RamingaApi(resolveConfig({ dataDir: fixture.nodeAData, ramingaBin: bin }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: fixture.nodeBData, ramingaBin: bin }));
  const a = await apiA.call((client) => client.status(new StatusRequest()));
  const addrA = (a.listenAddrs || []).find((item) => item.includes('/tcp/'));
  if (!addrA) throw new Error('node A has no TCP listen address');
  await apiB.call((client) => client.connect(new ConnectRequest({
    multiaddr: `${addrA}/p2p/${a.peerId}`,
    peerId: a.peerId,
  })));
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const result = await apiB.call((client) => client.sendChat(new SendChatRequest({
      peerId: a.peerId,
      multiaddr: `${addrA}/p2p/${a.peerId}`,
      text: `新的未读回信 ${tag}-${index + 1}：潮声又涨上来了一点。`,
      origin: 'human',
      agentOrigin: false,
      requestId: `c1-unread-${tag}-${index + 1}`,
    })));
    ids.push(String(result.messageId || ''));
  }
  console.log(JSON.stringify({ peerId: a.peerId, count, ids }));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
