// Unit tests for the DSH raminga_agent_init implementation. They exercise the
// same lib/agent-init.js used by the native tool: create, idempotency, no
// overwrite, and path/symlink containment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initAgentData, safeAgentPath } from '../lib/agent-init.js';

const templates = [
  { path: 'persona.md', content: 'persona template\n' },
  { path: 'growth.md', content: 'growth template\n' },
  { path: 'contact-notes.json', content: '{"schema_version":1}\n' },
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raminga-dsh-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedIdentity(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'identity'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'identity', 'key'), 'test-key');
}

test('creates the missing private layout and sessions directory', (t) => {
  const dataDir = tempDir(t);
  seedIdentity(dataDir);
  const result = initAgentData(dataDir, templates);
  assert.deepEqual(result.created, [
    'agent/persona.md',
    'agent/growth.md',
    'agent/contact-notes.json',
  ]);
  assert.deepEqual(result.existing, []);
  assert.deepEqual(result.directories_created, ['agent/', 'agent/sessions/']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'agent/persona.md'), 'utf8'), 'persona template\n');
  assert.ok(fs.statSync(path.join(dataDir, 'agent/sessions')).isDirectory());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dataDir, 'agent')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dataDir, 'agent/sessions')).mode & 0o777, 0o700);
    for (const name of ['persona.md', 'growth.md', 'contact-notes.json']) {
      assert.equal(fs.statSync(path.join(dataDir, 'agent', name)).mode & 0o777, 0o600, name);
    }
  }
});

test('is idempotent and never overwrites an existing file', (t) => {
  const dataDir = tempDir(t);
  seedIdentity(dataDir);
  fs.mkdirSync(path.join(dataDir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agent/persona.md'), 'keep me\n');

  const first = initAgentData(dataDir, templates);
  assert.deepEqual(first.existing, ['agent/persona.md']);
  assert.equal(first.created.length, 2);
  assert.equal(fs.readFileSync(path.join(dataDir, 'agent/persona.md'), 'utf8'), 'keep me\n');

  const second = initAgentData(dataDir, templates);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.existing, [
    'agent/persona.md',
    'agent/growth.md',
    'agent/contact-notes.json',
  ]);
  assert.equal(fs.readFileSync(path.join(dataDir, 'agent/persona.md'), 'utf8'), 'keep me\n');
});

test('rejects template paths that escape the data directory', (t) => {
  const dataDir = tempDir(t);
  seedIdentity(dataDir);
  const outside = path.join(dataDir, '..', 'escape.md');
  assert.throws(() => safeAgentPath(dataDir, '../escape.md'), /escapes/);
  assert.throws(
    () => initAgentData(dataDir, [{ path: '../escape.md', content: 'x' }]),
    /invalid|escapes/,
  );
  assert.equal(fs.existsSync(outside), false);
});

test('refuses a symlinked agent directory', (t) => {
  const dataDir = tempDir(t);
  seedIdentity(dataDir);
  const outside = tempDir(t);
  fs.symlinkSync(outside, path.join(dataDir, 'agent'));
  assert.throws(() => initAgentData(dataDir, templates), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('refuses to initialize before the node has an identity', (t) => {
  const dataDir = tempDir(t);
  assert.throws(
    () => initAgentData(dataDir, templates),
    (error) => {
      assert.match(error.message, /identity\/key/);
      assert.match(error.message, /missing|not initialized/);
      assert.match(error.message, /raminga_status/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(dataDir), []);

  const withAgent = tempDir(t);
  fs.mkdirSync(path.join(withAgent, 'agent'), { recursive: true });
  assert.throws(() => initAgentData(withAgent, templates), /not initialized/);
  assert.deepEqual(fs.readdirSync(path.join(withAgent, 'agent')), []);
  assert.equal(fs.existsSync(path.join(withAgent, 'identity')), false);
});

test('does not create a missing data directory without an identity', (t) => {
  const parent = tempDir(t);
  const dataDir = path.join(parent, 'not-initialized');
  assert.throws(() => initAgentData(dataDir, templates), /not initialized/);
  assert.equal(fs.existsSync(dataDir), false);
});
