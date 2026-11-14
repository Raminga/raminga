// Resolved plugin configuration: where the node lives and which binary can
// (re)start it. Mirrors the Go CLI's data-dir resolution and the api/paths
// file names (internal/api/paths/paths.go).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
export const SOCKET_FILE = 'api.sock';
export const TOKEN_FILE = 'api.token';
export const EXPECTED_API_VERSION = '4';
const requireFromHere = createRequire(import.meta.url);
const NPM_OS = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
};
const NPM_CPU = {
    arm64: 'arm64',
    x64: 'x64',
};
/**
 * npm platform package for a Node platform/arch pair, or null when the host
 * cannot be served by a published package (for example freebsd/ia32).
 */
export function platformPackageName(platform = process.platform, arch = process.arch) {
    const npmOS = NPM_OS[platform];
    const npmCPU = NPM_CPU[arch];
    if (!npmOS || !npmCPU)
        return null;
    return `@raminga/bin-${npmOS}-${npmCPU}`;
}
export function resolveConfig(config, options = {}) {
    const env = options.env ?? process.env;
    const dataDir = config.dataDir || env.RAMINGA_DATA_DIR || path.join(os.homedir(), '.raminga');
    const base = {
        dataDir,
        socketPath: path.join(dataDir, SOCKET_FILE),
        tokenPath: path.join(dataDir, TOKEN_FILE),
    };
    // Precedence: explicit config > RAMINGA_BIN > npm platform package > PATH.
    if (config.ramingaBin) {
        return { ...base, ramingaBin: config.ramingaBin, ramingaBinSource: 'config' };
    }
    if (env.RAMINGA_BIN) {
        return { ...base, ramingaBin: env.RAMINGA_BIN, ramingaBinSource: 'env' };
    }
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const packageName = platformPackageName(platform, arch);
    if (packageName) {
        try {
            const resolvePackageJson = options.resolvePackageJson ?? ((specifier) => requireFromHere.resolve(specifier));
            const packageJSON = resolvePackageJson(`${packageName}/package.json`);
            const executable = platform === 'win32' ? 'raminga.exe' : 'raminga';
            const binary = path.join(path.dirname(packageJSON), 'bin', executable);
            const exists = options.fileExists ?? fs.existsSync;
            if (!exists(binary)) {
                throw new Error(`package ${packageName} does not contain bin/${executable}`);
            }
            // Published npm tarballs preserve 0755, but pnpm stores may hardlink the
            // file. Repair a missing execute bit only for the package-owned binary.
            if (platform !== 'win32')
                ensureExecutable(binary, options);
            return {
                ...base,
                ramingaBin: binary,
                ramingaBinSource: 'platform-package',
            };
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                ...base,
                ramingaBin: 'raminga',
                ramingaBinSource: 'path',
                ramingaBinDiagnostic: `npm platform package ${packageName} is unavailable (${reason}); ` +
                    'falling back to "raminga" on PATH. Reinstall @raminga/dsh or set ramingaBin.',
            };
        }
    }
    return {
        ...base,
        ramingaBin: 'raminga',
        ramingaBinSource: 'path',
        ramingaBinDiagnostic: `no npm platform package for ${platform}/${arch}; ` +
            'falling back to "raminga" on PATH. Install raminga or set ramingaBin.',
    };
}
function ensureExecutable(binary, options) {
    const mode = (options.fileMode ?? ((file) => fs.statSync(file).mode))(binary);
    if ((mode & 0o111) !== 0)
        return;
    (options.chmod ?? ((file, bits) => fs.chmodSync(file, bits)))(binary, 0o755);
}
