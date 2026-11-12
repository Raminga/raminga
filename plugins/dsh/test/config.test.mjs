// Binary-resolution tests for the DSH shell.
//
// The precedence is explicit config > RAMINGA_BIN > bundled npm platform
// package > PATH. These tests use a fake package tree and injected resolution
// so they never depend on the host's installed packages or on PATH contents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { platformPackageName, resolveConfig } from '../lib/config.js';

function tempPackage(t, { platform = 'darwin', executable = 'raminga', mode = 0o755 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-dsh-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'node_modules', '@raminga', `bin-${platform}-arm64`);
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  const packageJSON = path.join(packageDir, 'package.json');
  fs.writeFileSync(packageJSON, '{"name":"fake"}\n');
  const binary = path.join(packageDir, 'bin', executable);
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(binary, mode);
  return { binary, packageJSON };
}

test('explicit config wins over env, package and PATH', () => {
  const resolved = resolveConfig(
    { ramingaBin: '/config/raminga', dataDir: '/config/data' },
    {
      env: { RAMINGA_BIN: '/env/raminga', RAMINGA_DATA_DIR: '/env/data' },
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => '/never/used/package.json',
    },
  );
  assert.equal(resolved.ramingaBin, '/config/raminga');
  assert.equal(resolved.ramingaBinSource, 'config');
  assert.equal(resolved.dataDir, '/config/data');
});

test('RAMINGA_BIN wins over the bundled package', () => {
  const resolved = resolveConfig(
    {},
    {
      env: { RAMINGA_BIN: '/env/raminga', RAMINGA_DATA_DIR: '/env/data' },
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => '/never/used/package.json',
    },
  );
  assert.equal(resolved.ramingaBin, '/env/raminga');
  assert.equal(resolved.ramingaBinSource, 'env');
  assert.equal(resolved.dataDir, '/env/data');
});

test('platform package binary is preferred over PATH', (t) => {
  const { binary, packageJSON } = tempPackage(t);
  const resolved = resolveConfig(
    {},
    {
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: (specifier) => {
        assert.equal(specifier, '@raminga/bin-darwin-arm64/package.json');
        return packageJSON;
      },
    },
  );
  assert.equal(resolved.ramingaBin, binary);
  assert.equal(resolved.ramingaBinSource, 'platform-package');
  assert.equal(resolved.ramingaBinDiagnostic, undefined);
});

test('missing execute bit on the package binary is repaired to 0755', (t) => {
  const { binary, packageJSON } = tempPackage(t, { mode: 0o644 });
  const resolved = resolveConfig(
    {},
    {
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => packageJSON,
    },
  );
  assert.equal(resolved.ramingaBin, binary);
  assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
});

test('already executable package binary is not chmodded', (t) => {
  const { packageJSON } = tempPackage(t, { mode: 0o755 });
  let chmods = 0;
  resolveConfig(
    {},
    {
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => packageJSON,
      chmod: () => {
        chmods++;
      },
    },
  );
  assert.equal(chmods, 0);
});

test('Windows package uses raminga.exe and never chmods', (t) => {
  const { binary, packageJSON } = tempPackage(t, {
    platform: 'win32',
    executable: 'raminga.exe',
    mode: 0o644,
  });
  let chmods = 0;
  const resolved = resolveConfig(
    {},
    {
      env: {},
      platform: 'win32',
      arch: 'x64',
      resolvePackageJson: () => packageJSON,
      chmod: () => {
        chmods++;
      },
    },
  );
  assert.equal(resolved.ramingaBin, binary);
  assert.equal(resolved.ramingaBinSource, 'platform-package');
  assert.equal(chmods, 0);
});

test('missing package falls back to PATH with a clear diagnostic', () => {
  const resolved = resolveConfig(
    {},
    {
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageJson: () => {
        throw new Error("Cannot find module '@raminga/bin-darwin-arm64/package.json'");
      },
    },
  );
  assert.equal(resolved.ramingaBin, 'raminga');
  assert.equal(resolved.ramingaBinSource, 'path');
  assert.match(resolved.ramingaBinDiagnostic, /@raminga\/bin-darwin-arm64/);
  assert.match(resolved.ramingaBinDiagnostic, /PATH/);
});

test('unsupported platform falls back to PATH with a clear diagnostic', () => {
  const resolved = resolveConfig(
    {},
    {
      env: {},
      platform: 'freebsd',
      arch: 'arm64',
    },
  );
  assert.equal(resolved.ramingaBin, 'raminga');
  assert.equal(resolved.ramingaBinSource, 'path');
  assert.match(resolved.ramingaBinDiagnostic, /freebsd\/arm64/);
});

test('platformPackageName uses npm os/cpu names', () => {
  assert.equal(platformPackageName('darwin', 'arm64'), '@raminga/bin-darwin-arm64');
  assert.equal(platformPackageName('linux', 'x64'), '@raminga/bin-linux-x64');
  assert.equal(platformPackageName('win32', 'arm64'), '@raminga/bin-win32-arm64');
  assert.equal(platformPackageName('freebsd', 'x64'), null);
});
