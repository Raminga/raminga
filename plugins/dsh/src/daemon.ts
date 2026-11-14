// Ensure-daemon: read the local bearer token and start a detached `raminga
// daemon` when the local API is not reachable. Mirrors cmd/raminga/lifecycle.go
// (spawnDaemon + waitForDaemon), simplified for the plugin.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENDPOINT_FILE, TOKEN_FILE, type ResolvedConfig } from './config.js';
import { readTcpEndpoint } from './endpoint.js';

const AUTO_START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

/**
 * Choose the daemon transport for a cold start. Only configured/ENV opt-in may
 * start TCP. Without it, an existing endpoint is rejected rather than treated
 * as permission to start: malformed discovery, or a well-formed but dead
 * descriptor, leaves both transports unstarted and the file untouched.
 */
function coldStartUsesTcp(config: ResolvedConfig): boolean {
  if (config.apiTcp) return true;
  const endpointPath = config.endpointPath || path.join(config.dataDir, ENDPOINT_FILE);
  let endpoint;
  try {
    endpoint = readTcpEndpoint(config.dataDir, endpointPath);
  } catch (error) {
    throw new Error(
      `Raminga TCP endpoint "${endpointPath}" is invalid: ${(error as Error).message}. ` +
        'Refusing to auto-start either transport without an explicit apiTcp/RAMINGA_API_TCP=1 opt-in; ' +
        'the endpoint was left unchanged. Fix or remove it, or enable the opt-in to regenerate stale discovery.',
    );
  }
  if (endpoint !== null) {
    throw new Error(
      `Raminga TCP endpoint "${endpointPath}" exists but its authenticated node is unreachable. ` +
        'Refusing to auto-start either transport without an explicit apiTcp/RAMINGA_API_TCP=1 opt-in; ' +
        'the endpoint was left unchanged. Start TCP explicitly to regenerate stale discovery, or remove the stale file.',
    );
  }
  return false;
}

export function readToken(dataDir: string): string {
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new Error(`local API token is empty at ${tokenPath}`);
  }
  return token;
}

export function spawnDaemon(config: ResolvedConfig): void {
  // Fail fast with a clear message when the binary is missing, instead of
  // surfacing a 15s "not reachable" timeout that hides the real cause.
  const check = spawnSync(config.ramingaBin, ['version'], { stdio: 'ignore', timeout: 3000 });
  if (check.error) {
    const diagnostic = config.ramingaBinDiagnostic ? ` ${config.ramingaBinDiagnostic}` : '';
    throw new Error(
      `cannot run the Raminga binary "${config.ramingaBin}": ${check.error.message}. ` +
        'Set ramingaBin in the plugin config or install raminga on PATH.' +
        diagnostic,
    );
  }

  const useTcp = coldStartUsesTcp(config);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(config.dataDir, 'daemon.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    // Explicit opt-in (config or ENV) is the only reason to cold start TCP.
    // Existing discovery is never treated as opt-in, and the child never
    // inherits or logs the token.
    const args = ['daemon', '--data-dir', config.dataDir];
    if (useTcp) args.push('--api-tcp');
    child = spawn(config.ramingaBin, args, {
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    fs.closeSync(logFd);
    throw new Error(`cannot start the Raminga daemon: ${(error as Error).message}`);
  }
  // The child owns the log fd after Start; close our copy. Async spawn errors
  // (rare on Windows) fall through to the ensureDaemon timeout, which names the
  // daemon.log path for diagnosis.
  child.on('error', () => {});
  child.unref();
  fs.closeSync(logFd);
}

export async function ensureDaemon(
  config: ResolvedConfig,
  probe: () => Promise<boolean>,
): Promise<void> {
  if (await probe()) return;
  spawnDaemon(config);
  const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Raminga node did not become reachable within ${AUTO_START_TIMEOUT_MS / 1000}s. ` +
          `See ${path.join(config.dataDir, 'daemon.log')} for details.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
