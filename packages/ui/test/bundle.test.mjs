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
  assert.match(bundle, /近期记录/);
  assert.match(bundle, /漫游日志/);
  assert.match(bundle, /最近记录/);
  assert.match(bundle, /他的通讯录/);
  assert.match(bundle, /onLoadPeerFriends/);
  // P4 adds a real-tool "正在访问" card; "正在漫游" remains forbidden.
  assert.match(bundle, /正在访问：/);
  assert.doesNotMatch(bundle, /正在漫游/);
  assert.doesNotMatch(bundle, /P[1-4] 编辑|P[1-4] 尚未|不会假装保存|不能冒充|公开资料（P[1-4]/);
  assert.match(bundle, /home-agent-hero/);
  assert.match(bundle, /settings-private/);
  assert.match(bundle, /id: "explore"/);
  assert.match(bundle, /id: "home"/);
  assert.match(bundle, /id: "contacts"/);
  assert.match(bundle, /label: "动态"/);
  assert.match(bundle, /label: "主页"/);
  assert.match(bundle, /label: "联系人"/);
  assert.doesNotMatch(bundle, /id="page-mine"|id="page-raminga"/);
  assert.match(bundle, /远端声明/);
  assert.match(bundle, /节点状态/);
  assert.match(bundle, /dsh-frame-leading-clearance/);
  assert.match(bundle, /isolation:\s*isolate/);
  assert.match(bundle, /rm-composer-overlay/);
  assert.doesNotMatch(bundle, /阶段\s*[0-9]|\bConnect\b|\bRPC\b|桥接|Persona|不会生成|不会根据|占位/);
  assert.doesNotMatch(bundle, /@connectrpc|raminga\.db|api\.token|@deepseek-ai/);
  assert.doesNotMatch(bundle, /<script/i);
  assert.doesNotMatch(bundle, /查看空状态|填入示例|预览状态|示例联系人|Alice|Nova|Momo/);
  // Page state survives unmounts in the adapter; the UI must not keep a
  // polling/streaming interval alive while hidden. P2's draft autosave uses one
  // bounded 600ms debounce, never a background poll.
  assert.doesNotMatch(bundle, /setInterval/);
  assert.match(bundle, /draft-save-debounce/);
});
