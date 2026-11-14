// The DSH shell must consume the generated single source, not a second copy of
// tool descriptions or guidance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ONBOARDING_FILES,
  CONFIRM_TOOLS,
  CORE_GUIDANCE,
  GENERATED_TOOLS,
} from '../lib/tools.generated.js';
import { StatusResponse } from '../lib/gen/raminga/api/v1/api_pb.js';
import { defineRamingaTools } from '../lib/tools.js';

test('generated catalog covers every tool with unique names', () => {
  assert.equal(GENERATED_TOOLS.length, 12);
  const names = new Set(GENERATED_TOOLS.map((tool) => tool.name));
  assert.equal(names.size, GENERATED_TOOLS.length);
  for (const name of [
    'raminga_status',
    'raminga_chat_send',
    'raminga_content_get',
    'raminga_agent_init',
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test('all Raminga tools are auto-permitted, so no confirm prompts remain', () => {
  assert.deepEqual([...CONFIRM_TOOLS], []);
  for (const tool of GENERATED_TOOLS) {
    assert.equal(tool.permission, 'auto', tool.name);
  }
  const init = GENERATED_TOOLS.find((tool) => tool.name === 'raminga_agent_init');
  assert.equal(init.resultUntrusted, false);
});

test('untrusted results and core guidance are generated', () => {
  for (const name of ['raminga_peer_profile', 'raminga_peer_manifest', 'raminga_peer_friends', 'raminga_content_get']) {
    assert.equal(GENERATED_TOOLS.find((tool) => tool.name === name).resultUntrusted, true, name);
  }
  assert.match(CORE_GUIDANCE, /Trust boundary/);
  assert.match(CORE_GUIDANCE, /Source rule/);
  assert.match(CORE_GUIDANCE, /Never query or mutate `raminga\.db`/);
});

test('core guidance is self-contained and carries the node clock rule', () => {
  for (const want of [
    /## Journey workflow/,
    /## Data contract/,
    /## Session file examples/,
    /"session_id": "replace-with-session-id"/,
    /session directories at mode `0700`/,
    /`current_time` field \(UTC RFC3339\)/,
  ]) {
    assert.match(CORE_GUIDANCE, want);
  }
});

test('status exposes the node current_time field through the DSH handler', async () => {
  const status = new StatusResponse({
    peerId: '12D3KooFake',
    apiVersion: '4',
    currentTime: '2026-11-11T12:34:56Z',
  });
  const api = {
    call: async (fn) => fn({ status: async () => status }),
  };
  const tools = defineRamingaTools(api);
  const tool = tools.find((candidate) => candidate.name === 'raminga_status');
  const value = await tool.execute({});
  assert.equal(value.current_time, '2026-11-11T12:34:56Z');
});

test('onboarding templates are generated from agent/templates', () => {
  assert.deepEqual(AGENT_ONBOARDING_FILES.map((file) => file.path), [
    'persona.md',
    'growth.md',
    'contact-notes.json',
  ]);
  assert.match(AGENT_ONBOARDING_FILES[0].content, /Persona|persona/);
});
