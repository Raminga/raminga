// Protected discovery document for the optional loopback-TCP local API.
// This stays entirely host-side: the token never enters the renderer or logs.
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { ENDPOINT_FILE } from './config.js';
const MAX_ENDPOINT_BYTES = 64 << 10;
export function normalizeFingerprint(value) {
    return String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}
function windowsEndpointGuard(endpointPath) {
    let fd;
    try {
        fd = fs.openSync(endpointPath, fs.constants.O_RDONLY);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw new Error('Raminga TCP endpoint cannot be inspected safely on Windows');
    }
    try {
        throw new Error('Raminga TCP endpoint is not supported on Windows');
    }
    finally {
        fs.closeSync(fd);
    }
}
function readEndpointFile(endpointPath) {
    if (process.platform === 'win32')
        return windowsEndpointGuard(endpointPath);
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
/** Read and validate the endpoint, or return null when it does not exist. */
export function readTcpEndpoint(dataDir, endpointPath = path.join(dataDir, ENDPOINT_FILE)) {
    const raw = readEndpointFile(endpointPath);
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('Raminga TCP endpoint is not valid JSON');
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
