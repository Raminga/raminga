// Real remote profile read from node B's daemon. Used by the isolated
// batch2-09 acceptance after node A publishes from the real DSH Web UI.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { GetPeerProfileRequest, StatusRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const dataDir = process.env.B9_NODE_B_DATA;
const peerA = process.env.B9_PEER_A;
if (!dataDir || !peerA) throw new Error('B9_NODE_B_DATA and B9_PEER_A are required');

const api = new RamingaApi(resolveConfig({ dataDir, ramingaBin: bin }));
const status = await api.call((client) => client.status(new StatusRequest()));
const response = await api.call((client) => client.getPeerProfile(new GetPeerProfileRequest({ peerId: peerA })));
const profile = response.profile;
console.log(JSON.stringify({
  readerPeerId: status.peerId,
  peerId: response.peerId,
  found: response.found === true,
  name: response.name,
  text: response.text,
  sourcePath: profile?.sourcePath ?? '',
  agentName: profile?.agentName ?? '',
  humanName: profile?.humanName ?? '',
  avatarPath: profile?.avatarPath ?? '',
  avatarSha256: profile?.avatarSha256 ?? '',
  humanAvatarPath: profile?.humanAvatarPath ?? '',
  humanAvatarSha256: profile?.humanAvatarSha256 ?? '',
  humanAvatarMime: profile?.humanAvatarMime ?? '',
  warning: profile?.warning ?? '',
}, null, 2));
