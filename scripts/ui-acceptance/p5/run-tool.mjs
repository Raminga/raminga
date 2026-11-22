// Trigger one real registered raminga_* tool through the isolated P5 test-only
// DSH control plugin. Usage:
//   node scripts/ui-acceptance/p5/run-tool.mjs raminga_status '{}'
//   node scripts/ui-acceptance/p5/run-tool.mjs raminga_chat_history '{"limit":10}'
// The endpoint exists only in the .local acceptance host, never in production.
const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error('usage: run-tool.mjs <raminga_tool> [json-args]');
  process.exit(2);
}
let args;
try {
  args = JSON.parse(rawArgs);
} catch (error) {
  console.error(`invalid JSON args: ${error.message}`);
  process.exit(2);
}
const url = process.env.P5_CONTROL_URL || 'http://127.0.0.1:4346/run';
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool, args }),
});
const text = await response.text();
console.log(text);
process.exit(response.ok ? 0 : 1);
