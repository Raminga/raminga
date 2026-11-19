// Trigger one real registered raminga_* tool through the isolated test-only
// DSH control plugin. This script is test-only and is not shipped.
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
const base = process.env.B1_CONTROL_URL || `http://127.0.0.1:${process.env.B1_CONTROL_PORT || 4336}/run`;
const response = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool, args }),
});
const text = await response.text();
console.log(text);
process.exit(response.ok ? 0 : 1);
