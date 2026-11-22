// Test-only DSH plugin for the P5 acceptance host. It exposes the real
// registered raminga_* tool execute methods on a loopback endpoint so the
// acceptance driver can exercise the same code path an Agent uses, without
// configuring a model or calling the production UI. This directory is never
// shipped in plugins/dsh and is installed only in the isolated p5 DSH_HOME.
import http from 'node:http';

export const name = 'p5-acceptance-control';
export const inject = ['tools'];

const port = Number(process.env.P5_CONTROL_PORT || '4346');

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { ok: true, port });
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
      const controller = new AbortController();
      try {
        const value = await tool.execute(args, {
          name: toolName,
          arguments: args,
          signal: controller.signal,
        });
        json(res, 200, { ok: true, value });
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  server.on('error', (error) => console.error('[p5-control] server error', error));
  server.listen(port, '127.0.0.1', () => {
    console.log(`[p5-control] listening on 127.0.0.1:${port}`);
  });
  return () => new Promise((resolve) => server.close(resolve));
}
