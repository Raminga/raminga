// Ensure-daemon: read the local bearer token and start a detached `raminga
// daemon` when the local API is not reachable. Mirrors cmd/raminga/lifecycle.go
// (spawnDaemon + waitForDaemon), simplified for the plugin.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENDPOINT_FILE, TOKEN_FILE } from './config.js';
import { readTcpEndpoint } from './endpoint.js';
const AUTO_START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
/** Options for the Windows host-private endpoint reader. */
function endpointOptions(config) {
    return {
        ramingaBin: config.ramingaBin,
        platform: config.platform,
    };
}
/**
 * Choose the daemon transport for a cold start. Explicit config/ENV selection
 * wins. Without it, an existing endpoint is rejected rather than treated as
 * permission to start: malformed discovery, or a well-formed but dead
 * descriptor, leaves both transports unstarted and the file untouched.
 */
function coldStartUsesTcp(config) {
    if (config.apiTcp)
        return true;
    const endpointPath = config.endpointPath || path.join(config.dataDir, ENDPOINT_FILE);
    let endpoint;
    try {
        endpoint = readTcpEndpoint(config.dataDir, endpointPath, endpointOptions(config));
    }
    catch (error) {
        throw new Error(`Raminga TCP endpoint "${endpointPath}" is invalid: ${error.message}. ` +
            'Refusing to auto-start either transport without an explicit apiTcp/RAMINGA_API_TCP=1 opt-in; ' +
            'the endpoint was left unchanged. Fix or remove it, or enable the opt-in to regenerate stale discovery.');
    }
    if (endpoint !== null) {
        throw new Error(`Raminga TCP endpoint "${endpointPath}" exists but its authenticated node is unreachable. ` +
            'Refusing to auto-start either transport without an explicit apiTcp/RAMINGA_API_TCP=1 opt-in; ' +
            'the endpoint was left unchanged. Start TCP explicitly to regenerate stale discovery, or remove the stale file.');
    }
    return false;
}
/**
 * On Windows a cold start defaults to TCP. Before spawning, prove that the
 * selected binary can validate and read the protected endpoint. An old binary
 * that lacks the hidden reader fails here with an upgrade message instead of a
 * generic 15-second startup timeout.
 */
function verifyWindowsEndpointReader(config) {
    if (config.platform !== 'win32')
        return;
    readTcpEndpoint(config.dataDir, config.endpointPath, endpointOptions(config));
}
/**
 * If a daemon is already running over the Unix socket, TCP cannot claim the
 * same data directory. Ask the Go CLI (which can speak AF_UNIX on Windows) and
 * report the exact remediation instead of waiting for the child to lose the
 * data-directory lock. The command line never contains a token.
 *
 * A protected HTTPS description makes a successful `status` ambiguous: the CLI
 * may have reached a live TCP daemon. Only diagnose Unix when the absence of
 * any HTTPS description is confirmed; an unreadable/invalid description is not
 * evidence of a Unix daemon either.
 */
export function existingUnixDaemon(config) {
    if (config.platform !== 'win32')
        return false;
    try {
        if (readTcpEndpoint(config.dataDir, config.endpointPath, endpointOptions(config)) !== null) {
            return false;
        }
    }
    catch {
        return false;
    }
    const result = spawnSync(config.ramingaBin, ['status', '--data-dir', config.dataDir], {
        stdio: 'ignore',
        timeout: 3_000,
        windowsHide: true,
        // Probe the Unix socket explicitly; an inherited RAMINGA_API_TCP=1 would
        // make the CLI report "no TCP endpoint" instead of reaching the daemon.
        env: { ...process.env, RAMINGA_API_TCP: '0' },
    });
    return result.status === 0;
}
export function readToken(dataDir) {
    const tokenPath = path.join(dataDir, TOKEN_FILE);
    // This default transport is Unix-only in the DSH client. readToken is kept
    // for explicit explore/debug uses and non-Windows platforms; the Windows path
    // obtains its per-run token only through endpoint.ts's private Go pipe.
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!token) {
        throw new Error(`local API token is empty at ${tokenPath}`);
    }
    return token;
}
/** Explain a startup timeout from the daemon log without dumping its contents. */
function startupDiagnostic(config) {
    const logPath = path.join(config.dataDir, 'daemon.log');
    let tail = '';
    try {
        const info = fs.statSync(logPath);
        const start = Math.max(0, info.size - 8192);
        const fd = fs.openSync(logPath, 'r');
        try {
            const buffer = Buffer.alloc(8192);
            const read = fs.readSync(fd, buffer, 0, buffer.length, start);
            tail = buffer.subarray(0, read).toString('utf8');
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        // A missing/unreadable log keeps the generic timeout message below.
    }
    if (/unknown flag: --api-tcp|flag provided but not defined:.*api-tcp/i.test(tail)) {
        return new Error(`Raminga binary "${config.ramingaBin}" does not support the Windows loopback TCP local API. ` +
            'Upgrade or reinstall raminga; this plugin did not silently fall back to the Unix socket. ' +
            `See ${logPath}.`);
    }
    if (/requires verified owner-only file ACLs/i.test(tail)) {
        return new Error(`Raminga binary "${config.ramingaBin}" predates Windows protected endpoint support. ` +
            'Upgrade or reinstall raminga, then retry. ' +
            `See ${logPath}.`);
    }
    if (/data directory is locked by another raminga daemon/i.test(tail)) {
        return new Error(`Another Raminga daemon already owns the data directory "${config.dataDir}" and this start lost the lock race. ` +
            'If it was started with the Unix-socket local API, stop it first and restart it with the loopback TCP API ' +
            `(--api-tcp) so this Windows client can connect. See ${logPath}.`);
    }
    return new Error(`Raminga node did not become reachable within ${AUTO_START_TIMEOUT_MS / 1000}s. ` +
        `See ${logPath} for details.`);
}
export function spawnDaemon(config) {
    // Fail fast with a clear message when the binary is missing, instead of
    // surfacing a 15s "not reachable" timeout that hides the real cause.
    const check = spawnSync(config.ramingaBin, ['version'], { stdio: 'ignore', timeout: 3000 });
    if (check.error) {
        const diagnostic = config.ramingaBinDiagnostic ? ` ${config.ramingaBinDiagnostic}` : '';
        throw new Error(`cannot run the Raminga binary "${config.ramingaBin}": ${check.error.message}. ` +
            'Set ramingaBin in the plugin config or install raminga on PATH.' +
            diagnostic);
    }
    // Verify the endpoint reader / ACL path before deciding on a transport. On
    // Windows this also rejects an old binary that lacks the hidden reader.
    verifyWindowsEndpointReader(config);
    const useTcp = coldStartUsesTcp(config);
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(config.dataDir, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
        // The selected transport is explicit. Existing discovery is never treated
        // as opt-in, and the child never inherits or logs the token. Pin the env
        // opt-in to the selected transport so a directly constructed false config
        // cannot inherit RAMINGA_API_TCP=1 and make the Go daemon open TCP anyway.
        const args = ['daemon', '--data-dir', config.dataDir];
        if (useTcp)
            args.push('--api-tcp');
        child = spawn(config.ramingaBin, args, {
            stdio: ['ignore', logFd, logFd],
            detached: true,
            windowsHide: true,
            env: { ...process.env, RAMINGA_API_TCP: useTcp ? '1' : '0' },
        });
    }
    catch (error) {
        fs.closeSync(logFd);
        throw new Error(`cannot start the Raminga daemon: ${error.message}`);
    }
    // The child owns the log fd after Start; close our copy. Async spawn errors
    // (rare on Windows) fall through to the ensureDaemon timeout, which reads the
    // daemon.log for a precise diagnosis.
    child.on('error', () => { });
    child.unref();
    fs.closeSync(logFd);
}
export async function ensureDaemon(config, probe) {
    // On Windows a false switch has no usable transport in the DSH client.
    // Refuse before any probe or spawn so neither a Unix nor a TCP daemon starts.
    if (config.platform === 'win32' && !config.apiTcp) {
        throw new Error('Raminga apiTcp is false on Windows; refusing to start a daemon. ' +
            'The DSH client cannot use the daemon AF_UNIX socket (Node maps that path to a named pipe), ' +
            'and it does not start the loopback TCP API without an explicit opt-in. ' +
            'Set apiTcp to true or remove the key, then retry.');
    }
    if (await probe())
        return;
    if (config.apiTcp && existingUnixDaemon(config)) {
        throw new Error(`A Raminga daemon is already running for "${config.dataDir}" over the Unix-socket local API, ` +
            'so a TCP daemon cannot start. The Windows DSH client cannot use that AF_UNIX socket. ' +
            `Stop the existing daemon (raminga stop --data-dir "${config.dataDir}") and retry; ` +
            'the next start will use the loopback TCP API.');
    }
    spawnDaemon(config);
    const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
    for (;;) {
        if (await probe())
            return;
        if (Date.now() >= deadline) {
            throw startupDiagnostic(config);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
