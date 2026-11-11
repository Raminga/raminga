// Framing test for the DSH shell's connect-es client layer.
//
// Starts a real Connect server (via connectNodeAdapter) on loopback TCP and
// drives the generated `RamingaService` client through `authInterceptor` to
// prove the framing path end to end:
//   1. the bearer-token interceptor sets `Authorization` on every request,
//   2. unary `Status` round-trips and deserializes typed fields,
//   3. server-streaming `DownloadPeerFile` yields every progress frame,
//   4. `Events` streaming yields heartbeats + payloads,
//   5. a server `ConnectError(Unauthenticated)` surfaces with its code intact.
//
// The transport under test is the same `authInterceptor`/`createConnectTransport`
// shape used in src/transport.ts; only `socketPath` is swapped for a loopback
// port (Node on Windows maps `socketPath` to named pipes, not AF_UNIX, so the
// UDS path itself cannot be exercised here — see the P5 report).
import http from 'node:http';
import assert from 'node:assert/strict';
import { createConnectRouter, createClient, ConnectError, Code } from '@connectrpc/connect';
import { connectNodeAdapter, createConnectTransport } from '@connectrpc/connect-node';
import { RamingaService } from '../lib/gen/raminga/api/v1/api_connect.js';
import {
  StatusRequest,
  StatusResponse,
  DownloadPeerFileRequest,
  DownloadPeerFileResponse,
  EventsRequest,
  EventsResponse,
} from '../lib/gen/raminga/api/v1/api_pb.js';
import { authInterceptor } from '../lib/transport.js';

const seenAuth = [];

function makeRouter() {
  return createConnectRouter();
}

const routes = (router) => {
  router.service(RamingaService, {
    status(req, ctx) {
      seenAuth.push(ctx.requestHeader.get('Authorization'));
      return new StatusResponse({ peerId: '12D3KooFramingTest', apiVersion: '1' });
    },
    downloadPeerFile(req, ctx) {
      seenAuth.push(ctx.requestHeader.get('Authorization'));
      return (async function* () {
        yield new DownloadPeerFileResponse({ phase: 'started', path: req.path });
        yield new DownloadPeerFileResponse({
          phase: 'complete',
          path: req.path,
          localPath: '/tmp/framing-test/file.txt',
          sha256: 'sha256-placeholder',
        });
      })();
    },
    events(req, ctx) {
      seenAuth.push(ctx.requestHeader.get('Authorization'));
      return (async function* () {
        yield new EventsResponse({ heartbeat: true });
        yield new EventsResponse({ heartbeat: false });
      })();
    },
    getPeerProfile(req, ctx) {
      // Used only to assert ConnectError code surfacing.
      seenAuth.push(ctx.requestHeader.get('Authorization'));
      throw new ConnectError('token mismatch', Code.Unauthenticated);
    },
  });
};

function listen(router) {
  const handler = connectNodeAdapter({ routes });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

async function main() {
  const router = makeRouter();
  const server = await listen(router);
  const port = server.address().port;

  const transport = createConnectTransport({
    httpVersion: '1.1',
    baseUrl: `http://127.0.0.1:${port}`,
    interceptors: [authInterceptor('test-token')],
  });
  const client = createClient(RamingaService, transport);

  check('unary Status round-trips and deserializes peerId', async () => {
    const res = await client.status(new StatusRequest());
    assert.equal(res.peerId, '12D3KooFramingTest');
    assert.equal(res.apiVersion, '1');
  });

  check('server-streaming DownloadPeerFile yields every frame', async () => {
    const frames = [];
    for await (const f of client.downloadPeerFile(new DownloadPeerFileRequest({ peerId: 'p', path: '/x' }))) {
      frames.push(f.phase);
    }
    assert.deepEqual(frames, ['started', 'complete']);
  });

  check('server-streaming Events yields heartbeats + payloads', async () => {
    const kinds = [];
    for await (const e of client.events(new EventsRequest())) {
      kinds.push(e.heartbeat);
    }
    assert.deepEqual(kinds, [true, false]);
  });

  check('server ConnectError(Unauthenticated) surfaces with code intact', async () => {
    await assert.rejects(
      () => client.getPeerProfile({}),
      (err) => err instanceof ConnectError && err.code === Code.Unauthenticated,
    );
  });

  check('auth interceptor set Bearer token on every request', () => {
    assert.ok(seenAuth.length >= 4, `expected >=4 requests, saw ${seenAuth.length}`);
    for (const header of seenAuth) {
      assert.equal(header, 'Bearer test-token');
    }
  });

  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}\n      ${err.message}`);
    }
  }

  await new Promise((resolve) => server.close(resolve));
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`\n${checks.length}/${checks.length} checks passed`);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
