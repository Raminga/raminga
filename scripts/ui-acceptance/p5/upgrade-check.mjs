// P5 T15 upgrade check: copy the pristine schema-9 fixture, migrate it once
// with the real daemon, and compare before/after rows, files, legacy contact
// notes and the exported v1->v2 view-state normalizer. It leaves
// <root>/upgrade-live in the migrated state for the UI check and never touches
// upgrade-v9.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { normalizeViewState } from '../../../packages/ui/src/view-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'bin', 'raminga');
const root = process.env.P5_ACCEPTANCE_DIR
  ? path.resolve(process.env.P5_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p5');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const source = path.join(root, 'upgrade-v9');
const live = path.join(root, 'upgrade-live');
const evidence = path.join(root, 'evidence');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 8000 });
}
function start(dir) {
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a');
  const child = spawn(bin, ['daemon', '--data-dir', dir], { stdio: ['ignore', log, log], detached: true });
  child.unref();
  fs.closeSync(log);
  return child;
}
async function waitStatus(dir, timeoutMs = 20000) {
  const { RamingaApi } = await import('../../../plugins/dsh/lib/client.js');
  const { resolveConfig } = await import('../../../plugins/dsh/lib/config.js');
  const { StatusRequest } = await import('../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js');
  const api = new RamingaApi(resolveConfig({ dataDir: dir, ramingaBin: bin }));
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await api.call((client) => client.status(new StatusRequest()), 'P5 upgrade status');
      if (value?.peerId) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw last ?? new Error('upgrade daemon did not become ready');
}
function fileMap(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        const data = fs.readFileSync(full);
        out.push({ path: rel, size: data.length, sha256: sha256(data) });
      }
    }
  };
  walk(path.join(dir, 'public'), '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      } catch {
        return -1;
      }
    };
    let version = -1;
    try {
      version = Number(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v);
    } catch {
      version = -1;
    }
    let readState = [];
    try {
      readState = db.prepare('SELECT peer_id, last_read_at_ms, last_read_message_id FROM conversation_read_state ORDER BY peer_id').all()
        .map((row) => ({ peerId: row.peer_id, lastReadAtMs: Number(row.last_read_at_ms), lastReadMessageId: row.last_read_message_id }));
    } catch {
      readState = [];
    }
    let unread = [];
    try {
      unread = db.prepare(`SELECT m.peer_id AS peer_id,
          SUM(CASE WHEN m.direction = 'in' AND m.created_at_ms > COALESCE(r.last_read_at_ms, 0) THEN 1 ELSE 0 END) AS n
        FROM messages m LEFT JOIN conversation_read_state r ON r.peer_id = m.peer_id
        GROUP BY m.peer_id ORDER BY m.peer_id`).all()
        .map((row) => ({ peerId: row.peer_id, unread: Number(row.n) }));
    } catch {
      unread = [];
    }
    return {
      version,
      messages: count('messages'),
      friends: count('friends'),
      discoveries: count('public_discoveries'),
      knownPeers: count('known_peers'),
      outbox: count('outbox'),
      pausedPeers: count('paused_peers'),
      readState,
      unread,
    };
  } finally {
    db.close();
  }
}
function legacyContactNotesHash(dir) {
  const file = path.join(dir, 'agent', 'contact-notes.json');
  return { path: 'agent/contact-notes.json', sha256: sha256(fs.readFileSync(file)), size: fs.statSync(file).size };
}
function viewStateSummary(file, peerId) {
  const before = JSON.parse(fs.readFileSync(file, 'utf8').split('__PEER_ID__').join(peerId));
  const after = normalizeViewState(before);
  const summary = (state) => ({
    version: state.version,
    page: state.page,
    home: state.home,
    settings: state.settings,
    messages: state.pages.messages,
    contactProfile: state.contactProfile,
    drafts: state.drafts,
    explore: state.pages.explore,
    contacts: state.pages.contacts,
  });
  const result = { before: summary(before), after: summary(after) };
  const checks = {
    pageLegacyNormalized: before.page === 'mine' && after.page === 'home',
    scrollPreserved: after.home.scroll === 640,
    humanAnchorPreserved: after.home.agentAnchor === 'human',
    expandedJourneyPreserved: after.home.expandedJourneys['session-old-1'] === true,
    settingsPreserved: after.settings.tab === 'memory' && after.settings.index === false,
    messagesPeerPreserved: after.pages.messages.peerId === peerId,
    legacyChatReturnNormalized: after.pages.messages.returnPage === 'home',
    profileTabPreserved: after.contactProfile.tab === 'posts',
    draftPreserved: after.drafts[`chat:${peerId}`] === '旧版草稿不能丢',
    explorePreserved: after.pages.explore.filter === 'familiar' && after.pages.explore.query === '潮汐',
    contactsPreserved: after.pages.contacts.filter === 'unread' && after.pages.contacts.query === '旧',
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`view-state migration failed: ${failed.join(', ')}`);
  return { ...result, checks };
}

fs.mkdirSync(evidence, { recursive: true });
stop(live);
fs.rmSync(live, { recursive: true, force: true });
fs.cpSync(source, live, { recursive: true, verbatimSymlinks: true });

const before = {
  schema: counts(path.join(live, 'raminga.db')),
  files: fileMap(live),
  agent: legacyContactNotesHash(live),
  viewState: viewStateSummary(path.join(live, 'viewstate-v1.json'), fixture.upgradePeerId),
};
const child = start(live);
const status = await waitStatus(live);
spawnSync(bin, ['content', 'published', '--data-dir', live, '--json'], { encoding: 'utf8' });
const pid = child.pid;
stop(live);
try { process.kill(pid, 0); process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }

const after = {
  schema: counts(path.join(live, 'raminga.db')),
  files: fileMap(live),
  agent: legacyContactNotesHash(live),
};
const backupPath = path.join(live, 'raminga.db.bak-9');
const backup = fs.existsSync(backupPath)
  ? { exists: true, size: fs.statSync(backupPath).size, schema: counts(backupPath).version }
  : { exists: false };
const stable = (rows) => rows.filter((file) => file.path !== 'friends.json');
const filesEqual = JSON.stringify(stable(before.files)) === JSON.stringify(stable(after.files));
const friendsAfter = after.files.find((file) => file.path === 'friends.json');
const friendsJson = friendsAfter
  ? JSON.parse(fs.readFileSync(path.join(live, 'public', 'friends.json'), 'utf8'))
  : { friends: [] };
const checks = {
  schema9Before: before.schema.version === 9,
  schema11After: after.schema.version === 11,
  messagesPreserved: before.schema.messages === after.schema.messages,
  friendsPreserved: before.schema.friends === after.schema.friends,
  discoveriesPreserved: before.schema.discoveries === after.schema.discoveries,
  knownPeersPreserved: before.schema.knownPeers === after.schema.knownPeers,
  outboxPreserved: before.schema.outbox === after.schema.outbox,
  pausedPeersPreserved: before.schema.pausedPeers === after.schema.pausedPeers,
  publicFilesByteIdentical: filesEqual,
  generatedFriendsJsonPreservesContact: Array.isArray(friendsJson.friends)
    && friendsJson.friends.some((row) => row.peer_id === fixture.nodeB),
  legacyContactNotesUnchanged: before.agent.sha256 === after.agent.sha256,
  backupCreated: backup.exists && backup.schema === 9,
  readBaselineBackfilled: after.schema.readState.length > 0,
  historyNotUnreadByDefault: after.schema.unread.every((row) => row.unread === 0),
  oldClientManifestStillWorks: before.files.some((file) => file.path === 'profile/index.md')
    && before.files.some((file) => file.path === 'posts/legacy-user.json')
    && before.files.some((file) => file.path === 'posts/legacy-agent.json'),
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const result = { before, after, backup, checks, failed, liveDir: live, peerId: status.peerId };
fs.writeFileSync(path.join(evidence, 'upgrade-results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failed.length > 0) process.exitCode = 1;
