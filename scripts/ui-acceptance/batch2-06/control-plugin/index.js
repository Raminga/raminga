// Test-only control surface for the isolated second-batch item 6 host.
// It reports health only; the acceptance operates the real UI with Playwright
// and the real daemon API through api.mjs. No user DSH home is touched.
import http from 'node:http';

export const name = 'b2-06-control';

const PORT = Number(process.env.B6_CONTROL_PORT || 4357);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { ok: true, port: PORT, plugin: 'b2-06-control' });
      return;
    }
    json(res, 404, { ok: false, error: 'GET /health only' });
  });
  server.on('error', (error) => console.error('[b2-06-control] server error', error));
  server.listen(PORT, '127.0.0.1', () => console.log(`[b2-06-control] listening on 127.0.0.1:${PORT}`));
  return () => new Promise((resolve) => server.close(resolve));
}
