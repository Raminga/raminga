// Pure host-side parser checks for the optional loopback-TCP discovery file.
// No renderer or daemon is involved; the token must never leave this module's
// caller and malformed/stale documents fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTcpEndpoint } from '../lib/endpoint.js';
import { resolveConfig } from '../lib/config.js';
import { spawnDaemon, ensureDaemon, existingUnixDaemon } from '../lib/daemon.js';

// Fixed self-signed certificate for 127.0.0.1 (valid 2020-2045). A descriptor
// carrying this material and a dead port is well-formed: it must not authorize
// a TCP cold start without the explicit plugin/env opt-in.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU6gAwIBAgIUZ23QTVJYwFQgFTsEi/AiqjWRbJcwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWcmFtaW5nYS1sb2NhbC1hcGktdGVzdDAeFw0yMDAxMDEwMDAw
MDBaFw00NTAxMDEwMDAwMDBaMCExHzAdBgNVBAMMFnJhbWluZ2EtbG9jYWwtYXBp
LXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATblYfAHWpF2gNm3qZcY8LC
XN7RDc6+DYnZT0/E5VTcS+5yuUAgprgEhUAiFu62xhaAHCMD08CaOvflzyjmwq3y
o2QwYjAdBgNVHQ4EFgQUNfMqw4ELFTBoWmMPk21Ud1De/kwwHwYDVR0jBBgwFoAU
NfMqw4ELFTBoWmMPk21Ud1De/kwwDwYDVR0RBAgwBocEfwAAATAPBgNVHRMBAf8E
BTADAQH/MAoGCCqGSM49BAMCA0cAMEQCICo58P2DcyJ/Z6P1hgu7oLUONMjqa4X+
d0zq5AOkP1UgAiByXCShk/LK2YU5GmUiUrgVpbkn8XKeLhdJ9b5T/lMg1g==
-----END CERTIFICATE-----
`;
const TEST_CERT_SHA256 = '281dcc9f6ae6382a6921a5bbbdcb8658e806af4b314aa8117bd7a08fedcb0e00';

// Synthetic markers: parser failures must never echo descriptor bytes.
const SYNTHETIC_JSON_MARKER = 'synthetic-json-secret-excerpt-marker';
const SYNTHETIC_PEM_MARKER = 'synthetic-pem-secret-excerpt-marker';

test('config keeps Unix default and exposes explicit TCP opt-in', () => {
  const unix = resolveConfig({ dataDir: '/tmp/raminga-config-test' }, { env: {}, platform: 'linux', arch: 'x64' });
  assert.equal(unix.apiTcp, false);
  assert.equal(unix.apiTcpSource, 'platform-default');
  assert.equal(unix.endpointPath, '/tmp/raminga-config-test/api.endpoint.json');
  const tcp = resolveConfig({ dataDir: '/tmp/raminga-config-test', apiTcp: true }, { env: {}, platform: 'linux', arch: 'x64' });
  assert.equal(tcp.apiTcp, true);
  assert.equal(tcp.apiTcpSource, 'config');
  const env = resolveConfig({ dataDir: '/tmp/raminga-config-test' }, { env: { RAMINGA_API_TCP: '1' }, platform: 'linux', arch: 'x64' });
  assert.equal(env.apiTcp, true);
  assert.equal(env.apiTcpSource, 'env');
});

test('Windows defaults to TCP; explicit false and environment false win', () => {
  const win = resolveConfig({ dataDir: '/tmp/raminga-config-test' }, { env: {}, platform: 'win32', arch: 'x64' });
  assert.equal(win.apiTcp, true);
  assert.equal(win.apiTcpSource, 'platform-default');
  const winEnvFalse = resolveConfig({ dataDir: '/tmp/raminga-config-test' }, { env: { RAMINGA_API_TCP: '0' }, platform: 'win32', arch: 'x64' });
  assert.equal(winEnvFalse.apiTcp, false);
  assert.equal(winEnvFalse.apiTcpSource, 'env');
  const winFalse = resolveConfig({ dataDir: '/tmp/raminga-config-test', apiTcp: false }, { env: { RAMINGA_API_TCP: '1' }, platform: 'win32', arch: 'x64' });
  assert.equal(winFalse.apiTcp, false, 'explicit config false must beat env true');
  assert.equal(winFalse.apiTcpSource, 'config');
  const winTrue = resolveConfig({ dataDir: '/tmp/raminga-config-test', apiTcp: true }, { env: { RAMINGA_API_TCP: '0' }, platform: 'win32', arch: 'x64' });
  assert.equal(winTrue.apiTcp, true, 'explicit config true must beat env false');
  assert.equal(winTrue.apiTcpSource, 'config');
});

test('macOS/Linux keep config true OR environment truthy TCP opt-in', () => {
  for (const platform of ['darwin', 'linux']) {
    const falseEnvTrue = resolveConfig(
      { dataDir: '/tmp/raminga-config-test', apiTcp: false },
      { env: { RAMINGA_API_TCP: '1' }, platform, arch: 'arm64' },
    );
    assert.equal(falseEnvTrue.apiTcp, true, `${platform}: a truthy environment still enables TCP`);
    assert.equal(falseEnvTrue.apiTcpSource, 'env');
    const trueEnvFalse = resolveConfig(
      { dataDir: '/tmp/raminga-config-test', apiTcp: true },
      { env: { RAMINGA_API_TCP: '0' }, platform, arch: 'arm64' },
    );
    assert.equal(trueEnvFalse.apiTcp, true, `${platform}: explicit config true still enables TCP`);
    assert.equal(trueEnvFalse.apiTcpSource, 'config');
  }
});

test('missing endpoint is not a fallback decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    assert.equal(readTcpEndpoint(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON uses a generic error without any descriptor excerpt', (t) => {
  if (process.platform === 'win32') return t.skip('Unix descriptor parser only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    writeEndpoint(dir, `{"token":"${SYNTHETIC_JSON_MARKER}",`);
    assert.throws(
      () => readTcpEndpoint(dir),
      (error) => {
        assert.equal(error.message, 'Raminga TCP endpoint is not valid JSON');
        assert.equal(error.message.includes(SYNTHETIC_JSON_MARKER), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed PEM uses a generic error without any descriptor excerpt', (t) => {
  if (process.platform === 'win32') return t.skip('Unix descriptor parser only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    const payload = deadEndpoint();
    payload.cert_pem = `-----BEGIN CERTIFICATE-----\n${SYNTHETIC_PEM_MARKER}\n-----END CERTIFICATE-----\n`;
    writeEndpoint(dir, payload);
    assert.throws(
      () => readTcpEndpoint(dir),
      (error) => {
        assert.equal(error.message, 'Raminga TCP endpoint certificate is invalid');
        assert.equal(error.message.includes(SYNTHETIC_PEM_MARKER), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('symbolic-link descriptor is refused without reading its target', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symbolic links only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(deadEndpoint()), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, path.join(dir, 'api.endpoint.json'));
    assert.throws(() => readTcpEndpoint(dir), /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized descriptor is rejected by the bounded read', (t) => {
  if (process.platform === 'win32') return t.skip('Unix descriptor parser only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    const file = path.join(dir, 'api.endpoint.json');
    fs.writeFileSync(file, Buffer.alloc((64 << 10) + 1, 0x78), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    assert.throws(() => readTcpEndpoint(dir), /too large/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows reads through the Go private bridge without reopening the path', (t) => {
  if (process.platform === 'win32') return t.skip('fake POSIX helper');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    // The pathname deliberately holds malformed bytes. A successful read proves
    // the Windows branch used the helper's document, not this file.
    writeEndpoint(dir, '{not-json');
    const helper = fakeWindowsReader(t, { found: true, document: deadEndpoint() });
    const endpoint = readTcpEndpoint(dir, path.join(dir, 'api.endpoint.json'), {
      ramingaBin: helper,
      platform: 'win32',
    });
    assert.equal(endpoint.address, '127.0.0.1:9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows private bridge distinguishes missing, old binary and ACL rejection', (t) => {
  if (process.platform === 'win32') return t.skip('fake POSIX helper');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    const missing = fakeWindowsReader(t, { found: false });
    assert.equal(
      readTcpEndpoint(dir, path.join(dir, 'api.endpoint.json'), { ramingaBin: missing, platform: 'win32' }),
      null,
    );

    const old = fakeWindowsReader(t, null, {
      exitCode: 1,
      stderr: 'Error: unknown command "internal-api-endpoint" for "raminga"',
    });
    assert.throws(
      () => readTcpEndpoint(dir, path.join(dir, 'api.endpoint.json'), { ramingaBin: old, platform: 'win32' }),
      /too old/,
    );

    const denied = fakeWindowsReader(t, null, {
      exitCode: 1,
      stderr: 'raminga: local API endpoint: Windows ACL for "C:\\data\\api.endpoint.json" must contain exactly one owner-only entry',
    });
    assert.throws(
      () => readTcpEndpoint(dir, path.join(dir, 'api.endpoint.json'), { ramingaBin: denied, platform: 'win32' }),
      /ACL reader.*exactly one owner-only entry/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-loopback, group-readable and malformed documents fail closed', (t) => {
  if (process.platform === 'win32') return t.skip('Unix descriptor parser only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  const file = path.join(dir, 'api.endpoint.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, network: 'tcp', address: '0.0.0.0:43123', token: 'a'.repeat(64),
      cert_pem: 'not-a-cert', cert_sha256: 'b'.repeat(64), pid: process.pid,
    }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    assert.throws(() => readTcpEndpoint(dir), /literal 127\.0\.0\.1/);

    fs.writeFileSync(file, JSON.stringify({
      version: 1, network: 'tcp', address: '127.0.0.1:43123', token: 'a'.repeat(64),
      cert_pem: 'not-a-cert', cert_sha256: 'b'.repeat(64), pid: process.pid,
    }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    if (process.platform !== 'win32') {
      assert.throws(() => readTcpEndpoint(dir), /permissions/);
    }

    fs.writeFileSync(file, '{not-json', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    assert.throws(() => readTcpEndpoint(dir), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeWindowsReader(t, payload, { exitCode = 0, stderr = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-win-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'raminga-fake');
  const output = payload === null ? '' : JSON.stringify(payload);
  const quoted = output.replace(/'/g, `'\\''`);
  const err = stderr.replace(/'/g, `'\\''`);
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      (output ? `printf '%s\\n' '${quoted}'\n` : '') +
      (err ? `printf '%s\\n' '${err}' >&2\n` : '') +
      `exit ${exitCode}\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function writeEndpoint(dataDir, payload) {
  const file = path.join(dataDir, 'api.endpoint.json');
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function deadEndpoint() {
  return {
    version: 1,
    network: 'tcp',
    address: '127.0.0.1:9',
    token: 'a'.repeat(64),
    cert_pem: TEST_CERT_PEM,
    cert_sha256: TEST_CERT_SHA256,
    pid: process.pid,
    started_at_unix_ms: Date.now(),
  };
}

function fakeDaemon(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-dsh-daemon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = path.join(root, 'args.log');
  const script = path.join(root, 'raminga');
  const quoted = record.replace(/'/g, `'\\''`);
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      'if [ "$1" = "version" ]; then exit 0; fi\n' +
      `printf '%s\\n' "$*" >> '${quoted}'\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(script, 0o755);
  return { record, script };
}

function dataDirFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-dsh-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configFor(dataDir, ramingaBin, apiTcp = false) {
  return resolveConfig(
    { dataDir, ramingaBin, ...(apiTcp ? { apiTcp: true } : {}) },
    { env: {}, platform: 'linux', arch: 'x64' },
  );
}

function fakeWindowsDaemon(t, { statusExit = 1, endpoint = null, recordEnv = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-dsh-windaemon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = path.join(root, 'args.log');
  const envRecord = path.join(root, 'env.log');
  const script = path.join(root, 'raminga-fake');
  const quoted = record.replace(/'/g, `'\\''`);
  const quotedEnv = envRecord.replace(/'/g, `'\\''`);
  const payload = JSON.stringify(
    endpoint === null ? { found: false } : { found: true, document: endpoint },
  ).replace(/'/g, `'\\''`);
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      'if [ "$1" = "version" ]; then exit 0; fi\n' +
      `if [ "$1" = "internal-api-endpoint" ]; then printf '%s\\n' '${payload}'; exit 0; fi\n` +
      `if [ "$1" = "status" ]; then exit ${statusExit}; fi\n` +
      (recordEnv ? `printf '%s\\n' "\${RAMINGA_API_TCP-}" >> '${quotedEnv}'\n` : '') +
      `printf '%s\\n' "$*" >> '${quoted}'\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(script, 0o755);
  return { envRecord, record, script };
}

function windowsConfigFor(dataDir, ramingaBin, apiTcp) {
  return resolveConfig(
    { dataDir, ramingaBin, ...(apiTcp === undefined ? {} : { apiTcp }) },
    { env: {}, platform: 'win32', arch: 'x64' },
  );
}

async function waitForArgs(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    if (Date.now() > deadline) throw new Error(`fake daemon never recorded args at ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('cold start without opt-in keeps the Unix default and no endpoint', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeDaemon(t);
  spawnDaemon(configFor(dataDir, fake.script));
  const args = await waitForArgs(fake.record);
  assert.match(args, /^daemon --data-dir /);
  assert.doesNotMatch(args, /--api-tcp/);
});

test('malformed descriptor blocks auto-start without opt-in and is left intact', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeDaemon(t);
  const endpointPath = writeEndpoint(dataDir, '{not-json');
  assert.throws(
    () => spawnDaemon(configFor(dataDir, fake.script)),
    /invalid: .*not valid JSON.*Refusing to auto-start either transport/s,
  );
  assert.equal(fs.readFileSync(endpointPath, 'utf8'), '{not-json');
  await sleep(150);
  assert.equal(fs.existsSync(fake.record), false, 'no daemon may be spawned');
});

test('well-formed but dead descriptor blocks auto-start without opt-in', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeDaemon(t);
  const endpointPath = writeEndpoint(dataDir, deadEndpoint());
  const before = fs.readFileSync(endpointPath);
  assert.throws(
    () => spawnDaemon(configFor(dataDir, fake.script)),
    /exists but its authenticated node is unreachable.*Refusing to auto-start either transport/s,
  );
  assert.deepEqual(fs.readFileSync(endpointPath), before, 'stale discovery must not be deleted');
  await sleep(150);
  assert.equal(fs.existsSync(fake.record), false, 'no daemon may be spawned');
});

test('explicit opt-in starts TCP even with stale discovery and never Unix', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeDaemon(t);
  writeEndpoint(dataDir, deadEndpoint());
  spawnDaemon(configFor(dataDir, fake.script, true));
  const args = await waitForArgs(fake.record);
  assert.match(args, /^daemon --data-dir /);
  assert.match(args, /--api-tcp$/);
});

test('Windows default cold start passes --api-tcp; explicit false does not', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const defaultData = dataDirFor(t);
  const defaultFake = fakeWindowsDaemon(t);
  spawnDaemon(windowsConfigFor(defaultData, defaultFake.script, undefined));
  const defaultArgs = await waitForArgs(defaultFake.record);
  assert.match(defaultArgs, /^daemon --data-dir /);
  assert.match(defaultArgs, /--api-tcp$/);

  const falseData = dataDirFor(t);
  const falseFake = fakeWindowsDaemon(t);
  spawnDaemon(windowsConfigFor(falseData, falseFake.script, false));
  const falseArgs = await waitForArgs(falseFake.record);
  assert.doesNotMatch(falseArgs, /--api-tcp/);
});

test('Windows explicit false pins RAMINGA_API_TCP=0 for the daemon child', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeWindowsDaemon(t, { recordEnv: true });
  const previous = process.env.RAMINGA_API_TCP;
  t.after(() => {
    if (previous === undefined) delete process.env.RAMINGA_API_TCP;
    else process.env.RAMINGA_API_TCP = previous;
  });
  process.env.RAMINGA_API_TCP = '1';
  spawnDaemon(windowsConfigFor(dataDir, fake.script, false));
  await waitForArgs(fake.record);
  assert.equal(
    fs.readFileSync(fake.envRecord, 'utf8').trim(),
    '0',
    'a false transport must not inherit RAMINGA_API_TCP=1 into the Go daemon',
  );
});

test('Windows Unix diagnostic requires the absence of an HTTPS description', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const unix = fakeWindowsDaemon(t, { statusExit: 0 });
  assert.equal(
    existingUnixDaemon(windowsConfigFor(dataDir, unix.script, true)),
    true,
    'a successful status without any endpoint description is a Unix daemon',
  );
  const tcp = fakeWindowsDaemon(t, { statusExit: 0, endpoint: deadEndpoint() });
  assert.equal(
    existingUnixDaemon(windowsConfigFor(dataDir, tcp.script, true)),
    false,
    'a transient CLI status success must not turn an HTTPS description into Unix',
  );
});

test('Windows ensureDaemon diagnoses an already-running Unix daemon', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX fake daemon script');
  const dataDir = dataDirFor(t);
  const fake = fakeWindowsDaemon(t, { statusExit: 0 });
  await assert.rejects(
    () => ensureDaemon(windowsConfigFor(dataDir, fake.script, undefined), async () => false),
    /already running.*Unix-socket/,
  );
  await sleep(100);
  assert.equal(fs.existsSync(fake.record), false, 'a second daemon must not be spawned');
});
