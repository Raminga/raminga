// Test-only DSH plugin for the isolated second-batch item 4 host. It exposes
// the real registered raminga_status / raminga_friends tools on localhost so
// acceptance can prove which contacts were read or dialed. It never ships.
import http from 'node:http';

export const name = 'b2-04-interactions-control';
export const inject = ['tools'];

const PORT = Number(process.env.B4_CONTROL_PORT || 4349);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { ok: true, port: PORT });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') {
      json(res, 404, { ok: false, error: 'POST /run only' });
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const toolName = typeof body.tool === 'string' ? body.tool : '';
      const tool = ctx.tools.get(toolName);
      if (!tool) {
        json(res, 503, { ok: false, error: `tool not registered: ${toolName}` });
        return;
      }
      const args = body.args && typeof body.args === 'object' ? body.args : {};
      try {
        const value = await tool.execute(args, { name: toolName, arguments: args, signal: new AbortController().signal });
        json(res, 200, { ok: true, value });
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  server.on('error', (error) => console.error('[b2-04-interactions-control] server error', error));
  server.listen(PORT, '127.0.0.1', () => console.log(`[b2-04-interactions-control] listening on 127.0.0.1:${PORT}`));
  return () => new Promise((resolve) => server.close(resolve));
}
