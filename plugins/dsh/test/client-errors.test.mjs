// Focused error mapping for RamingaApi.call.
//
// Code.Unavailable has two very different sources:
//   - ensure()/auto-start could not reach the local daemon;
//   - a handler that already reached the daemon returned Unavailable (for
//     example Connect failing to dial a remote multiaddr).
// Only the first one may be described as "local node is not running".
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectError, Code } from '@connectrpc/connect';
import { RamingaApi, describeError } from '../lib/client.js';

const config = {
  dataDir: '/tmp/raminga-client-errors',
  socketPath: '/tmp/raminga-client-errors/api.sock',
  ramingaBin: '/bin/true',
};

function unavailable(message) {
  return new ConnectError(message, Code.Unavailable);
}

test('a remote Connect Unavailable keeps the real dial error without blaming the local daemon', () => {
  const raw = 'failed to dial /ip4/127.0.0.1/tcp/1/p2p/12D3KooWQ9ZmTDyCK5A1npdydkdYAnrn4cMhBQ9AwaE4MvABrUBe: connection refused';
  const described = describeError(unavailable(raw), config.socketPath, {
    operation: '连接节点',
    phase: 'call',
  });
  assert.match(described.message, /连接节点没有完成/);
  assert.match(described.message, /connection refused/);
  assert.match(described.message, /本机节点在这次操作前可以访问/);
  assert.match(described.message, /不是自动启动失败/);
  assert.doesNotMatch(described.message, /node is not running at|tried to auto-start/);
});

test('a local ensure/auto-start failure still gives the real local-unreachable feedback', () => {
  const described = describeError(unavailable('connect ECONNREFUSED'), config.socketPath, {
    operation: '连接节点',
    phase: 'ensure',
  });
  assert.match(described.message, /Raminga node is not running at \/tmp\/raminga-client-errors\/api\.sock/);
  assert.match(described.message, /tried to auto-start/);
});

test('call distinguishes local ensure failures from daemon-handler failures', async () => {
  const api = new RamingaApi(config);

  api.ensure = async () => ({});
  await assert.rejects(
    api.call(async () => {
      throw unavailable('failed to dial remote peer: connection refused');
    }, '连接节点'),
    (error) => {
      assert.match(error.message, /连接节点没有完成/);
      assert.match(error.message, /connection refused/);
      assert.doesNotMatch(error.message, /node is not running at|tried to auto-start/);
      return true;
    },
  );

  api.ensure = async () => {
    throw unavailable('socket closed before auto-start');
  };
  await assert.rejects(
    api.call(async () => 'not reached', '连接节点'),
    (error) => {
      assert.match(error.message, /Raminga node is not running at/);
      assert.match(error.message, /socket closed before auto-start/);
      return true;
    },
  );
});

test('non-connect failures are not rewritten', async () => {
  const original = new Error('unexpected local failure');
  const described = describeError(original, config.socketPath, { operation: '连接节点', phase: 'call' });
  assert.equal(described, original);
});
