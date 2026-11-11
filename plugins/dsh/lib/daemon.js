// Ensure-daemon: read the local bearer token and start a detached `raminga
// daemon` when the local API is not reachable. Mirrors cmd/raminga/lifecycle.go
// (spawnDaemon + waitForDaemon), simplified for the plugin.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_FILE } from './config.js';
const AUTO_START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
export function readToken(dataDir) {
    const tokenPath = path.join(dataDir, TOKEN_FILE);
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token) {
        throw new Error(`local API token is empty at ${tokenPath}`);
    }
    return token;
}
export function spawnDaemon(config) {
    // Fail fast with a clear message when the binary is missing, instead of
    // surfacing a 15s "not reachable" timeout that hides the real cause.
    const check = spawnSync(config.ramingaBin, ['version'], { stdio: 'ignore', timeout: 3000 });
    if (check.error) {
        throw new Error(`cannot run the Raminga binary "${config.ramingaBin}": ${check.error.message}. ` +
            'Set ramingaBin in the plugin config or install raminga on PATH.');
    }
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(config.dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
        child = spawn(config.ramingaBin, ['daemon', '--data-dir', config.dataDir], {
            stdio: ['ignore', logFd, logFd],
            detached: true,
            windowsHide: true,
        });
    }
    catch (error) {
        fs.closeSync(logFd);
        throw new Error(`cannot start the Raminga daemon: ${error.message}`);
    }
    // The child owns the log fd after Start; close our copy. Async spawn errors
    // (rare on Windows) fall through to the ensureDaemon timeout, which names the
    // daemon.log path for diagnosis.
    child.on('error', () => { });
    child.unref();
    fs.closeSync(logFd);
}
export async function ensureDaemon(config, probe) {
    if (await probe())
        return;
    spawnDaemon(config);
    const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
    for (;;) {
        if (await probe())
            return;
        if (Date.now() >= deadline) {
            throw new Error(`Raminga node did not become reachable within ${AUTO_START_TIMEOUT_MS / 1000}s. ` +
                `See ${path.join(config.dataDir, 'daemon.log')} for details.`);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
