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
import { spawnDaemon } from '../lib/daemon.js';

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
  assert.equal(unix.endpointPath, '/tmp/raminga-config-test/api.endpoint.json');
  const tcp = resolveConfig({ dataDir: '/tmp/raminga-config-test', apiTcp: true }, { env: {}, platform: 'linux', arch: 'x64' });
  assert.equal(tcp.apiTcp, true);
  const env = resolveConfig({ dataDir: '/tmp/raminga-config-test' }, { env: { RAMINGA_API_TCP: '1' }, platform: 'linux', arch: 'x64' });
  assert.equal(env.apiTcp, true);
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

test('Windows refuses an existing TCP descriptor safely', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only safety check');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-endpoint-'));
  try {
    writeEndpoint(dir, deadEndpoint());
    assert.throws(() => readTcpEndpoint(dir), /not supported on Windows/);
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
