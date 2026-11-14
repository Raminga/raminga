import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

test('bundle builds without imports, host packages, timers or a second network stack', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'pipe' });
  const bundle = fs.readFileSync(path.join(root, 'dist', 'raminga-ui.bundle.js'), 'utf8');
  assert.doesNotMatch(bundle, /^\s*import\s/m);
  assert.match(bundle, /(?:const|var) RamingaUI =/);
  assert.match(bundle, /mountRamingaApp/);
  assert.match(bundle, /还没有 Agent 带回的公开内容/);
  assert.match(bundle, /添加联系人/);
  assert.match(bundle, /分享节点信息/);
  assert.match(bundle, /当前保留消息/);
  assert.match(bundle, /加载更早消息/);
  assert.match(bundle, /重新读取历史/);
  assert.match(bundle, /游标没有前进/);
  assert.match(bundle, /协议已接收/);
  assert.match(bundle, /发送结果未知/);
  assert.match(bundle, /公开动态/);
  assert.match(bundle, /本人公开内容/);
  assert.match(bundle, /Journey 活动/);
  assert.match(bundle, /远端声明/);
  assert.match(bundle, /节点状态/);
  assert.doesNotMatch(bundle, /阶段\s*[0-9]|\bConnect\b|\bRPC\b|桥接|Persona|不会生成|不会根据|占位/);
  assert.doesNotMatch(bundle, /@connectrpc|raminga\.db|api\.token|@deepseek-ai/);
  assert.doesNotMatch(bundle, /<script/i);
  assert.doesNotMatch(bundle, /查看空状态|填入示例|预览状态|示例联系人|Alice|Nova|Momo/);
  // Page state survives unmounts in the adapter; the UI itself must not keep a
  // polling/streaming timer alive while hidden.
  assert.doesNotMatch(bundle, /setInterval|setTimeout/);
});
