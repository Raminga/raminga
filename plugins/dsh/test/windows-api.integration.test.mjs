// Real Windows integration for the loopback-TCP local API and the DSH client.
//
// This file must run on windows-2025 with RAMINGA_BIN pointing at a freshly
// built raminga.exe. It deliberately fails (rather than skips) on any other
// platform or when the binary is missing, so a CI lane cannot silently pass
// without exercising the Windows path. Every daemon uses a temporary data
// directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { RamingaApi } from '../lib/client.js';
import { readTcpEndpoint } from '../lib/endpoint.js';
import { subscribeEvents } from '../lib/events.js';
import { ConnectRequest, StatusRequest } from '../lib/gen/raminga/api/v1/api_pb.js';

if (process.platform !== 'win32') {
  throw new Error('windows-api.integration.test.mjs must run on Windows');
}
const exe = process.env.RAMINGA_BIN;
if (!exe || !fs.existsSync(exe)) {
  throw new Error('RAMINGA_BIN must point at the built raminga.exe for the Windows integration test');
}
// The checks below set the transport explicitly. Do not let a host-level
// Raminga environment silently change the mode they exercise.
delete process.env.RAMINGA_API_TCP;
delete process.env.RAMINGA_DATA_DIR;

const testTimeout = 240_000;

function cli(args, timeout = 30_000, env = process.env) {
  return spawnSync(exe, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function unixEnv() {
  return { ...process.env, RAMINGA_API_TCP: '0' };
}

// DSH apiTcp:false must not start either transport. Start the Unix daemon
// directly through the CLI here, with the environment opt-in explicitly off.
// Windows AF_UNIX sockets are NTFS reparse points: Node's stat/existsSync
// cannot follow them, so the socket file is not a readiness signal. Only the
// Go CLI can say whether the daemon is actually serving. Keep the detached
// child's stderr in a file so a startup failure is diagnosable.
function startUnixDaemon(dir) {
  const logPath = path.join(dir, 'unix-daemon.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);
  const state = { logPath, child: null, exit: null, error: null };
  try {
    state.child = spawn(exe, ['daemon', '--data-dir', dir], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: unixEnv(),
    });
  } finally {
    fs.closeSync(logFd);
  }
  state.child.on('error', (error) => {
    state.error = error;
  });
  state.child.on('exit', (code, signal) => {
    state.exit = { code, signal };
  });
  state.child.unref();
  return state;
}

function daemonLogTail(logPath, maxBytes = 8192) {
  try {
    const info = fs.statSync(logPath);
    const start = Math.max(0, info.size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.subarray(0, read).toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function unixDaemonDiagnostic(message, daemon) {
  const tail = daemonLogTail(daemon.logPath);
  return `${message}\n--- ${daemon.logPath} ---\n${tail || '(daemon log is empty)'}`;
}

// Poll the real Go CLI Status instead of the socket pathname. On failure the
// error includes the daemon's exit status and stderr tail, not just "timeout".
async function waitForUnixStatus(dir, daemon, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = cli(['status', '--data-dir', dir], 10_000, unixEnv());
    if (last.status === 0) return last;
    if (daemon.error) {
      throw new Error(
        unixDaemonDiagnostic(`Unix daemon could not be started: ${daemon.error.message}`, daemon),
      );
    }
    if (daemon.exit) {
      throw new Error(
        unixDaemonDiagnostic(
          `Unix daemon exited before Status was ready (exit ${String(daemon.exit.code)}, signal ${String(daemon.exit.signal)})`,
          daemon,
        ),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        unixDaemonDiagnostic(
          `timed out waiting for Unix daemon Status after ${timeoutMs / 1000}s ` +
            `(last status exit ${String(last.status)}; stderr: ${String(last.stderr).trim()})`,
          daemon,
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function initNode(dir) {
  const res = cli([
    'init',
    '--data-dir',
    dir,
    '--listen',
    '/ip4/127.0.0.1/tcp/0',
  ]);
  assert.equal(res.status, 0, `raminga init failed: ${res.stderr}`);
}

function configFor(dir, apiTcp, env = {}) {
  return resolveConfig(
    {
      dataDir: dir,
      ramingaBin: exe,
      ...(apiTcp === undefined ? {} : { apiTcp }),
    },
    { env, platform: 'win32', arch: 'x64' },
  );
}

function newDataDir(_t, prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDirs(dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A failed test may leave a detached daemon; cleanup kills it first.
    }
  }
}

function stopNode(dir) {
  try {
    const res = cli(['stop', '--data-dir', dir], 20_000);
    if (res.status === 0) return true;
  } catch {
    // fall through
  }
  return false;
}

function killEndpointProcess(dir) {
  try {
    const endpoint = readTcpEndpoint(dir);
    if (endpoint) {
      spawnSync('taskkill', ['/PID', String(endpoint.pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'ignore',
      });
    }
  } catch {
    // The ACL may be the reason the endpoint cannot be read; no token is used.
  }
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('Windows default starts TCP; Status, real event and same-client restart reconnect', { timeout: testTimeout }, async (t) => {
  const dirA = newDataDir(t, 'raminga-win-a-');
  const dirB = newDataDir(t, 'raminga-win-b-');
  let stopEvents = () => {};
  t.after(() => {
    stopEvents();
    if (!stopNode(dirA)) killEndpointProcess(dirA);
    if (!stopNode(dirB)) killEndpointProcess(dirB);
    removeDirs([dirA, dirB]);
  });
  initNode(dirA);
  initNode(dirB);

  const configA = configFor(dirA, undefined);
  const configB = configFor(dirB, undefined);
  assert.equal(configA.apiTcp, true, 'Windows must default to the TCP local API');
  assert.equal(configA.apiTcpSource, 'platform-default');
  assert.equal(fs.existsSync(path.join(dirA, 'api.endpoint.json')), false);

  const apiA = new RamingaApi(configA);
  const apiB = new RamingaApi(configB);
  const clientA = await apiA.ensure();
  const clientB = await apiB.ensure();
  const statusA = await clientA.status(new StatusRequest(), { timeoutMs: 5_000 });
  const statusB = await clientB.status(new StatusRequest(), { timeoutMs: 5_000 });
  assert.ok(statusA.peerId.length > 0);
  assert.equal(statusA.apiVersion, '4');
  assert.notEqual(statusA.peerId, statusB.peerId);
  assert.equal(fs.existsSync(path.join(dirA, 'api.endpoint.json')), true);
  assert.equal(fs.existsSync(path.join(dirA, 'api.sock')), false);

  // The real Events stream must carry a real libp2p connection event, not a
  // heartbeat and not a synthetic message.
  const events = [];
  const states = [];
  stopEvents = subscribeEvents(
    apiA,
    (event) => events.push(event),
    () => {},
    (state) => states.push(state),
    { reconnectDelayMs: 250 },
  );
  await waitFor(() => states.includes('open'), 'initial Events stream open');

  const listen = statusB.listenAddrs.find((addr) => /^\/ip4\/127\.0\.0\.1\/tcp\/\d+$/.test(addr));
  assert.ok(listen, `B has no loopback TCP listen address: ${statusB.listenAddrs.join(',')}`);
  const dialAddress = `${listen}/p2p/${statusB.peerId}`;
  await clientA.connect(new ConnectRequest({ peerId: statusB.peerId, multiaddr: dialAddress }), { timeoutMs: 15_000 });
  await waitFor(
    () => events.some((event) => event.connection && event.connection.peerId === statusB.peerId),
    'a real connection event',
  );
  const connectionEventsBefore = events.filter((event) => event.connection).length;

  // Stop and restart the same data directory. The same RamingaApi instance
  // must read the rotated endpoint, rebuild its client and reconnect Events.
  const openCountBefore = states.filter((state) => state === 'open').length;
  // `restart` performs the stop and start through the real CLI, which also
  // waits out the old process's data-directory lock. The already-created
  // RamingaApi object is intentionally not replaced.
  const restarted = cli(['restart', '--data-dir', dirA], 40_000);
  assert.equal(restarted.status, 0, `restart failed: ${restarted.stderr}`);
  await waitFor(() => apiA.probeStatus(), 'restarted TCP Status');
  await waitFor(
    () => states.filter((state) => state === 'open').length > openCountBefore,
    'Events stream reopening after restart',
  );
  const refreshed = await apiA.ensure();
  const statusAfter = await refreshed.status(new StatusRequest(), { timeoutMs: 5_000 });
  assert.notEqual(statusAfter.startedAtUnixMs, statusA.startedAtUnixMs, 'same client must see the restarted daemon');
  assert.equal(statusAfter.peerId, statusA.peerId);

  // A new connection after the restart must still reach the reconnected stream.
  await refreshed.connect(new ConnectRequest({ peerId: statusB.peerId, multiaddr: dialAddress }), { timeoutMs: 15_000 });
  await waitFor(
    () => events.filter((event) => event.connection).length > connectionEventsBefore,
    'a connection event after restart',
  );
});

test('Windows explicit false starts no daemon and diagnoses an existing Unix daemon', { timeout: testTimeout }, async (t) => {
  const dir = newDataDir(t, 'raminga-win-false-');
  let unix;
  t.after(() => {
    // Stop through the real API first; if it never became ready, kill only the
    // still-running child we started, never a reused PID.
    if (!stopNode(dir) && unix?.child.exitCode === null && unix.child.pid) {
      spawnSync('taskkill', ['/PID', String(unix.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    removeDirs([dir]);
  });
  initNode(dir);

  // Environment true must not override an explicit Windows false.
  const configFalse = configFor(dir, false, { RAMINGA_API_TCP: '1' });
  assert.equal(configFalse.apiTcp, false);
  assert.equal(configFalse.apiTcpSource, 'config');
  const apiFalse = new RamingaApi(configFalse);
  assert.equal(await apiFalse.probeStatus(), false, 'probeStatus must not bypass the switch');
  await assert.rejects(
    () => apiFalse.ensure(),
    /apiTcp is false on Windows/,
    'DSH must not silently enable TCP when apiTcp is false',
  );
  assert.equal(fs.existsSync(path.join(dir, 'api.endpoint.json')), false, 'false must not start TCP');
  const noDaemon = cli(['status', '--data-dir', dir], 15_000, unixEnv());
  assert.notEqual(noDaemon.status, 0, 'explicit false must not start a Unix daemon');

  // Start the UDS daemon directly through the CLI; DSH false is forbidden to
  // start either transport. Go Status is the readiness proof because Node
  // cannot stat a Windows AF_UNIX socket file.
  unix = startUnixDaemon(dir);
  const goStatus = await waitForUnixStatus(dir, unix);
  assert.match(goStatus.stdout, /peer_id:/, 'Go CLI Status must describe the Unix daemon');
  assert.equal(fs.existsSync(path.join(dir, 'api.endpoint.json')), false, 'false must not start TCP');

  // A new default-TCP client pointed at the same data directory must explain
  // that an existing Unix-socket daemon blocks a second daemon, instead of
  // waiting for a lock timeout.
  const apiDefault = new RamingaApi(configFor(dir, undefined));
  await assert.rejects(
    () => apiDefault.ensure(),
    /already running.*Unix-socket/,
    'existing UDS daemon must be diagnosed precisely',
  );
});

test('Windows explicit false rejects an existing HTTPS endpoint despite env true', { timeout: testTimeout }, async (t) => {
  const dir = newDataDir(t, 'raminga-win-existing-');
  t.after(() => {
    if (!stopNode(dir)) killEndpointProcess(dir);
    removeDirs([dir]);
  });
  initNode(dir);

  const apiDefault = new RamingaApi(configFor(dir, undefined));
  const client = await apiDefault.ensure();
  const before = await client.status(new StatusRequest(), { timeoutMs: 5_000 });
  const endpointBefore = readTcpEndpoint(dir);
  assert.ok(endpointBefore && endpointBefore.pid > 0);
  assert.equal(fs.existsSync(path.join(dir, 'api.endpoint.json')), true);

  // Prove precedence with the real process environment, not a config map.
  const previous = process.env.RAMINGA_API_TCP;
  process.env.RAMINGA_API_TCP = '1';
  let configFalse;
  try {
    configFalse = resolveConfig(
      { dataDir: dir, ramingaBin: exe, apiTcp: false },
      { platform: 'win32', arch: 'x64' },
    );
  } finally {
    if (previous === undefined) delete process.env.RAMINGA_API_TCP;
    else process.env.RAMINGA_API_TCP = previous;
  }
  assert.equal(configFalse.apiTcp, false, 'explicit config false must beat RAMINGA_API_TCP=1');
  assert.equal(configFalse.apiTcpSource, 'config');

  const apiFalse = new RamingaApi(configFalse);
  assert.equal(
    await apiFalse.probeStatus(),
    false,
    'probeStatus must not connect to an existing HTTPS endpoint when apiTcp is false',
  );
  await assert.rejects(
    () => apiFalse.ensure(),
    /apiTcp is false on Windows/,
    'DSH must reject the existing HTTPS endpoint when apiTcp is false',
  );

  // Rejecting must not replace, stop or restart the live daemon.
  const endpointAfter = readTcpEndpoint(dir);
  assert.equal(endpointAfter.pid, endpointBefore.pid, 'false must not start another daemon');
  assert.equal(endpointAfter.token, endpointBefore.token, 'false must not rotate the endpoint');
  const stillLive = await apiDefault.ensure();
  const after = await stillLive.status(new StatusRequest(), { timeoutMs: 5_000 });
  assert.equal(after.startedAtUnixMs, before.startedAtUnixMs);
  assert.equal(after.peerId, before.peerId);
});

test('Windows ACL widening is rejected by Go and a cached DSH client before HTTPS', { timeout: testTimeout }, async (t) => {
  const dir = newDataDir(t, 'raminga-win-acl-');
  initNode(dir);
  const config = configFor(dir, undefined);
  const api = new RamingaApi(config);
  const client = await api.ensure();
  const before = await client.status(new StatusRequest(), { timeoutMs: 5_000 });
  const endpointPath = path.join(dir, 'api.endpoint.json');
  const endpoint = readTcpEndpoint(dir);
  assert.ok(endpoint && endpoint.pid > 0);
  const pid = endpoint.pid;
  t.after(() => {
    // Remove the extra ACE first so a normal stop can read the discovery file.
    spawnSync('icacls', [endpointPath, '/remove:g', '*S-1-1-0'], { stdio: 'ignore', windowsHide: true });
    if (!stopNode(dir)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    removeDirs([dir]);
  });

  // The daemon is live. If either client skipped the ACL check it would reach
  // this listener and Status would succeed; the assertions below only pass if
  // the rejection happens before any HTTPS request.
  const grant = spawnSync('icacls', [endpointPath, '/grant', '*S-1-1-0:(R)'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(grant.status, 0, `icacls grant failed: ${grant.stderr}`);

  const goStatus = cli(['status', '--data-dir', dir], 15_000);
  assert.notEqual(goStatus.status, 0, 'Go CLI accepted a widened discovery ACL');
  assert.match(goStatus.stderr, /ACL/, `Go ACL diagnostic missing: ${goStatus.stderr}`);

  // The same cached RamingaApi/client that succeeded before the change must
  // revalidate the endpoint on its next ensure/call and fail closed.
  await assert.rejects(() => api.ensure(), /ACL/, 'cached DSH ensure accepted a widened ACL');
  await assert.rejects(
    () => api.call((cached) => cached.status(new StatusRequest(), { timeoutMs: 5_000 })),
    /ACL/,
    'cached DSH call accepted a widened ACL',
  );

  const restore = spawnSync('icacls', [endpointPath, '/remove:g', '*S-1-1-0'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(restore.status, 0, `icacls remove failed: ${restore.stderr}`);
  const after = await api.ensure();
  const afterStatus = await after.status(new StatusRequest(), { timeoutMs: 5_000 });
  assert.equal(afterStatus.startedAtUnixMs, before.startedAtUnixMs);
});
