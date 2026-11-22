// Isolated third-batch bootstrap fixture. It creates three real local nodes
// (A client + DSH host, B DHT server, C ordinary contact) and a fresh DSH seed
// profile. It never touches ~/.raminga, the user's DSH_HOME, the desktop, or
// another acceptance port.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RamingaApi } from '../../../plugins/dsh/lib/client.js';
import { resolveConfig } from '../../../plugins/dsh/lib/config.js';
import { StatusRequest } from '../../../plugins/dsh/lib/gen/raminga/api/v1/api_pb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const root = process.env.B3_ACCEPTANCE_DIR
  ? path.resolve(process.env.B3_ACCEPTANCE_DIR)
  : path.join(repoRoot, '.local', 'prototype-remediation', 'b3-01-bootstrap');
const expectedRoot = path.join(repoRoot, '.local', 'prototype-remediation', 'b3-01-bootstrap');
if (root !== expectedRoot && !root.startsWith(`${expectedRoot}${path.sep}`)) {
  throw new Error(`refusing unexpected B3_ACCEPTANCE_DIR: ${root}`);
}
const bin = path.join(repoRoot, 'bin', 'raminga');
const seedHome = path.join(repoRoot, '.local', 'ui-refresh-20261117', 'p4-acceptance', 'dsh-home');
const dshHome = path.join(root, 'dsh-home');
const dirA = path.join(root, 'node-a');
const dirB = path.join(root, 'node-b');
const dirC = path.join(root, 'node-c');
const evidence = path.join(root, 'evidence');
const portA = Number(process.env.B3_NODE_A_PORT || 44741);
const portB = Number(process.env.B3_NODE_B_PORT || 44742);
const portC = Number(process.env.B3_NODE_C_PORT || 44743);
const hostPort = Number(process.env.B3_HOST_PORT || 44744);

if (!fs.existsSync(bin)) throw new Error(`missing ${bin}; run make build first`);
if (!fs.existsSync(seedHome)) throw new Error(`missing isolated DSH seed profile: ${seedHome}`);
if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535) throw new Error('invalid B3_HOST_PORT');

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(true));
  });
}

function init(dir, port, mode) {
  fs.rmSync(dir, { recursive: true, force: true });
  const result = spawnSync(bin, [
    'init', '--data-dir', dir, '--listen', `/ip4/127.0.0.1/tcp/${port}`,
    '--dht-mode', mode, '--no-bootstrap-preset', '--json',
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`init ${dir} failed: ${result.stderr || result.stdout}`);
}

function start(dir, name) {
  const log = path.join(evidence, `${name}.log`);
  const out = fs.openSync(log, 'a');
  const child = spawn(bin, ['daemon', '--data-dir', dir], { stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(path.join(root, `${name}.pid`), String(child.pid));
  return child;
}

function stop(dir) {
  spawnSync(bin, ['stop', '--data-dir', dir], { encoding: 'utf8', timeout: 12000 });
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw last ?? new Error(`timed out waiting for ${label}`);
}

async function status(api, label) {
  return waitFor(() => api.call((client) => client.status(new StatusRequest()), label), label);
}

function prepareDshHome() {
  fs.rmSync(dshHome, { recursive: true, force: true });
  fs.cpSync(seedHome, dshHome, { recursive: true, verbatimSymlinks: true });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const name of Object.keys(pkg.dependencies)) {
    if (/control$/.test(name)) delete pkg.dependencies[name];
  }
  pkg.dependencies['@raminga/dsh'] = `link:${path.join(repoRoot, 'plugins', 'dsh')}`;
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [])
    .filter((name) => !/control$/.test(name) && name !== '@raminga/dsh')
    .concat('@raminga/dsh');
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const modules = path.join(profileDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of ['p4-activity-control', 'b1-activity-control', 'c1-return-control']) {
    fs.rmSync(path.join(modules, name), { force: true });
  }
  fs.rmSync(path.join(modules, '@raminga', 'dsh'), { force: true });
  fs.mkdirSync(path.join(modules, '@raminga'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'plugins', 'dsh'), path.join(modules, '@raminga', 'dsh'), 'dir');
}

for (const port of [portA, portB, portC, hostPort]) {
  if (!(await portFree(port))) throw new Error(`port ${port} is already in use; refusing to prepare`);
}

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(path.join(root, 'home'), { recursive: true });
for (const dir of [dirA, dirB, dirC]) stop(dir);
prepareDshHome();

init(dirA, portA, 'client');
init(dirB, portB, 'server');
init(dirC, portC, 'client');

// A uses a 2s refresh/query window so the explicit-disconnect check does not
// wait for production defaults. This is fixture-only and captured as the TOML
// baseline; the product code never rewrites it.
const configAPath = path.join(dirA, 'config.toml');
let configA = fs.readFileSync(configAPath, 'utf8');
configA = configA.replace('refresh_interval = "30s"', 'refresh_interval = "2s"').replace('query_timeout = "20s"', 'query_timeout = "2s"');
fs.writeFileSync(configAPath, configA);
fs.writeFileSync(path.join(evidence, 'node-a-config.baseline.toml'), configA);

try {
  start(dirB, 'node-b');
  start(dirC, 'node-c');
  start(dirA, 'node-a');
  const apiA = new RamingaApi(resolveConfig({ dataDir: dirA, ramingaBin: bin }));
  const apiB = new RamingaApi(resolveConfig({ dataDir: dirB, ramingaBin: bin }));
  const apiC = new RamingaApi(resolveConfig({ dataDir: dirC, ramingaBin: bin }));
  const a = await status(apiA, 'node A status');
  const b = await status(apiB, 'node B status');
  const c = await status(apiC, 'node C status');
  const fixture = {
    root,
    hostPort,
    nodeAData: dirA,
    nodeBData: dirB,
    nodeCData: dirC,
    nodeA: a.peerId,
    nodeB: b.peerId,
    nodeC: c.peerId,
    addrB: `/ip4/127.0.0.1/tcp/${portB}/p2p/${b.peerId}`,
    addrC: `/ip4/127.0.0.1/tcp/${portC}/p2p/${c.peerId}`,
    portA, portB, portC,
    dshHome,
    configAPath,
    configASha256: (await import('node:crypto')).createHash('sha256').update(configA).digest('hex'),
    preparedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, fixture: path.join(root, 'fixture.json'), ...fixture }, null, 2));
} finally {
  for (const dir of [dirA, dirB, dirC]) stop(dir);
}
