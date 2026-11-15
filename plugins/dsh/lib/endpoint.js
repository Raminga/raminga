// Protected discovery document for the optional loopback-TCP local API.
// This stays entirely host-side: the token never enters the renderer or logs.
//
// On Windows the Node client never opens api.endpoint.json by pathname. It
// asks the local Raminga binary (the same Go implementation used by the CLI)
// to validate the owner/DACL/type and read the file through one handle, then
// receives the document over a private stdout pipe. Go is the ACL authority;
// Node only revalidates the document's transport contract and certificate.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { ENDPOINT_FILE } from './config.js';
const MAX_ENDPOINT_BYTES = 64 << 10;
const WINDOWS_READ_TIMEOUT_MS = 5_000;
const WINDOWS_READ_MAX_BUFFER = 256 << 10;
const WINDOWS_INTERNAL_COMMAND = 'internal-api-endpoint';
export function normalizeFingerprint(value) {
    return String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}
function readEndpointFile(endpointPath) {
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error('Raminga TCP endpoint cannot be read safely on this platform');
    }
    let fd;
    try {
        fd = fs.openSync(endpointPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return null;
        if (code === 'ELOOP' || code === 'EMLINK') {
            throw new Error('Raminga TCP endpoint is not a regular file');
        }
        throw new Error('Raminga TCP endpoint cannot be opened safely');
    }
    try {
        // Validate the descriptor we actually opened; never stat or read by path.
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('Raminga TCP endpoint is not a regular file');
        }
        if ((info.mode & 0o077) !== 0) {
            throw new Error(`Raminga TCP endpoint permissions ${(info.mode & 0o777).toString(8)} expose secrets; want 0600`);
        }
        if (info.size > MAX_ENDPOINT_BYTES)
            throw new Error('Raminga TCP endpoint is too large');
        const buffer = Buffer.allocUnsafe(MAX_ENDPOINT_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
            const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
            if (read === 0)
                break;
            total += read;
        }
        if (total > MAX_ENDPOINT_BYTES)
            throw new Error('Raminga TCP endpoint is too large');
        return buffer.subarray(0, total).toString('utf8');
    }
    finally {
        fs.closeSync(fd);
    }
}
function windowsBinary(options) {
    return options.ramingaBin || process.env.RAMINGA_BIN || 'raminga';
}
function oldBinaryError(binary) {
    return new Error(`Raminga binary "${binary}" is too old to read the Windows-protected local API endpoint. ` +
        'Upgrade or reinstall raminga, then retry. The endpoint was not read by this plugin.');
}
/**
 * Read the endpoint through the local Go binary on Windows. The child receives
 * only --data-dir (never the token), writes the token-bearing document to a
 * private stdout pipe, and is never asked to print anything else. We never
 * include the child's stdout in an error or log.
 */
function readWindowsEndpointDocument(dataDir, endpointPath, options) {
    const expectedPath = path.join(dataDir, ENDPOINT_FILE);
    if (path.resolve(endpointPath) !== path.resolve(expectedPath)) {
        throw new Error('Raminga TCP endpoint path differs from the protected data-directory path');
    }
    const binary = windowsBinary(options);
    const result = spawnSync(binary, [WINDOWS_INTERNAL_COMMAND, '--data-dir', dataDir], {
        encoding: 'utf8',
        timeout: WINDOWS_READ_TIMEOUT_MS,
        maxBuffer: WINDOWS_READ_MAX_BUFFER,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
        const code = result.error.code;
        if (code === 'ENOENT') {
            throw new Error(`cannot run the Raminga binary "${binary}" to read the Windows-protected endpoint; ` +
                'set ramingaBin or install raminga.');
        }
        if (code === 'ETIMEDOUT') {
            throw new Error('the Raminga binary timed out while reading the Windows-protected endpoint');
        }
        throw new Error(`the Raminga binary could not read the Windows-protected endpoint: ${result.error.message}`);
    }
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.status !== 0) {
        if (/unknown command|unknown flag|flag provided but not defined/i.test(stderr)) {
            throw oldBinaryError(binary);
        }
        const localApiMessage = /raminga:\s*(local API endpoint:.*)$/im.exec(stderr)?.[1]?.trim();
        if (localApiMessage) {
            throw new Error(`Raminga TCP endpoint rejected by the Windows ACL reader: ${localApiMessage}`);
        }
        throw new Error(`the Raminga binary could not read the Windows-protected endpoint (exit ${String(result.status)}); ` +
            'the endpoint was not opened by this plugin.');
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout ?? ''));
    }
    catch {
        throw new Error('the Raminga binary returned an invalid private endpoint response');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the Raminga binary returned an invalid private endpoint response');
    }
    const envelope = parsed;
    if (typeof envelope.found !== 'boolean') {
        throw new Error('the Raminga binary returned an invalid private endpoint response');
    }
    if (!envelope.found)
        return null;
    if (envelope.document === null || typeof envelope.document !== 'object' || Array.isArray(envelope.document)) {
        throw new Error('the Raminga binary returned an invalid private endpoint document');
    }
    return envelope.document;
}
/** Read and validate the endpoint, or return null when it does not exist. */
export function readTcpEndpoint(dataDir, endpointPath = path.join(dataDir, ENDPOINT_FILE), options = {}) {
    const platform = options.platform ?? process.platform;
    let parsed;
    if (platform === 'win32') {
        const document = readWindowsEndpointDocument(dataDir, endpointPath, options);
        if (document === null)
            return null;
        parsed = document;
    }
    else {
        const raw = readEndpointFile(endpointPath);
        if (raw === null)
            return null;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('Raminga TCP endpoint is not valid JSON');
        }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Raminga TCP endpoint has an unsupported version or transport');
    }
    if (parsed.version !== 1 || parsed.network !== 'tcp') {
        throw new Error('Raminga TCP endpoint has an unsupported version or transport');
    }
    const address = String(parsed.address ?? '');
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(address);
    if (!match)
        throw new Error('Raminga TCP endpoint must be literal 127.0.0.1:port');
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
        throw new Error('Raminga TCP endpoint port is invalid');
    const token = String(parsed.token ?? '');
    if (token.length < 32 || /\s/.test(token))
        throw new Error('Raminga TCP endpoint token is invalid');
    const certPem = String(parsed.cert_pem ?? '');
    const pin = normalizeFingerprint(String(parsed.cert_sha256 ?? ''));
    if (!certPem.includes('BEGIN CERTIFICATE') || pin.length !== 64) {
        throw new Error('Raminga TCP endpoint certificate material is incomplete');
    }
    let cert;
    try {
        cert = new X509Certificate(certPem);
    }
    catch {
        throw new Error('Raminga TCP endpoint certificate is invalid');
    }
    const checkIP = cert.checkIP;
    if (typeof checkIP === 'function') {
        if (!checkIP.call(cert, '127.0.0.1')) {
            throw new Error('Raminga TCP endpoint certificate does not cover 127.0.0.1');
        }
    }
    else if (!cert.subjectAltName?.includes('IP Address:127.0.0.1')) {
        throw new Error('Raminga TCP endpoint certificate does not cover 127.0.0.1');
    }
    if (normalizeFingerprint(cert.fingerprint256) !== pin) {
        throw new Error('Raminga TCP endpoint certificate pin does not match');
    }
    const validFrom = Date.parse(cert.validFrom);
    const validTo = Date.parse(cert.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom - 300_000 || now > validTo + 300_000) {
        throw new Error('Raminga TCP endpoint certificate is not currently valid');
    }
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Raminga TCP endpoint has no daemon pid');
    return {
        address,
        host: '127.0.0.1',
        port,
        token,
        certPem,
        certSha256: pin,
        pid,
        startedAtUnixMs: Number(parsed.started_at_unix_ms) || 0,
    };
}
/**
 * TLS options that trust only this run's certificate, keep normal hostname
 * verification, and additionally pin the leaf SHA-256. No environment proxy or
 * rejectUnauthorized override is used.
 */
export function tlsNodeOptions(endpoint) {
    const options = {
        ca: endpoint.certPem,
        rejectUnauthorized: true,
    };
    options.checkServerIdentity = (host, cert) => {
        const base = checkServerIdentity(host, cert);
        if (base)
            return base;
        if (normalizeFingerprint(String(cert.fingerprint256 ?? '')) !== endpoint.certSha256) {
            return new Error('Raminga TCP endpoint certificate pin mismatch');
        }
        return undefined;
    };
    return options;
}
