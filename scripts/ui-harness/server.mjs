// Zero-dependency local acceptance server for the shared workspace UI.
//
//   node scripts/ui-harness/server.mjs
//
// It rebuilds packages/ui/dist/raminga-ui.bundle.js, then serves the harness
// and the bundle at http://127.0.0.1:4173/. This is a simulated host mount:
// it exercises the same mount/destroy API as plugins/dsh, but it is not the
// real DSH shell. Keep that distinction in screenshots and reports.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const uiRoot = path.join(repoRoot, 'packages', 'ui');
const bundle = path.join(uiRoot, 'dist', 'raminga-ui.bundle.js');
const page = path.join(here, 'index.html');
const script = path.join(here, 'harness.js');
const paginationPage = path.join(here, 'pagination.html');
const paginationScript = path.join(here, 'pagination.js');
const reopenPage = path.join(here, 'reopen.html');
const reopenScript = path.join(here, 'reopen.js');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

execFileSync(process.execPath, [path.join(uiRoot, 'scripts', 'build.mjs')], { stdio: 'inherit' });

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, file) {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok\n');
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    send(res, page);
    return;
  }
  if (url.pathname === '/harness.js') {
    send(res, script);
    return;
  }
  if (url.pathname === '/pagination.html') {
    send(res, paginationPage);
    return;
  }
  if (url.pathname === '/pagination.js') {
    send(res, paginationScript);
    return;
  }
  if (url.pathname === '/reopen.html') {
    send(res, reopenPage);
    return;
  }
  if (url.pathname === '/reopen.js') {
    send(res, reopenScript);
    return;
  }
  if (url.pathname === '/bundle.js') {
    send(res, bundle);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('not found\n');
});

server.listen(port, host, () => {
  console.log(`Raminga UI harness (simulated host) listening on http://${host}:${port}/`);
  console.log('Production UI bundle:', path.relative(repoRoot, bundle));
  console.log('This page is not the DSH shell; see plugins/dsh/README.md for real loading steps.');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
