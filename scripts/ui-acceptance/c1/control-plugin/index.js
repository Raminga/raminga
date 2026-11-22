// Test-only DSH plugin for the isolated first-batch-C host. It exposes the
// real registered raminga_* execute methods on localhost so the acceptance can
// prove that a read-only Agent history call does not advance human unread.
import http from 'node:http';

export const name = 'c1-return-control';
export const inject = ['tools'];

const PORT = Number(process.env.C1_CONTROL_PORT || 4337);

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
  server.on('error', (error) => console.error('[c1-control] server error', error));
  server.listen(PORT, '127.0.0.1', () => console.log(`[c1-control] listening on 127.0.0.1:${PORT}`));
  return () => new Promise((resolve) => server.close(resolve));
}
