// Resolved plugin configuration: where the node lives and which binary can
// (re)start it. Mirrors the Go CLI's data-dir resolution and the api/paths
// file names (internal/api/paths/paths.go).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const SOCKET_FILE = 'api.sock';
export const TOKEN_FILE = 'api.token';
export const ENDPOINT_FILE = 'api.endpoint.json';
export const EXPECTED_API_VERSION = '4';

export interface PluginConfig {
  dataDir?: string;
  ramingaBin?: string;
  /** Explicitly use the optional 127.0.0.1-only TLS local API. */
  apiTcp?: boolean;
}

export type RamingaBinSource = 'config' | 'env' | 'platform-package' | 'path';

export type ApiTcpSource = 'config' | 'env' | 'platform-default';

export interface ResolvedConfig {
  dataDir: string;
  socketPath: string;
  tokenPath: string;
  endpointPath: string;
  /** True selects the loopback TCP API. On Windows it is the default. */
  apiTcp: boolean;
  /** Where apiTcp came from; useful for an accurate existing-daemon diagnostic. */
  apiTcpSource: ApiTcpSource;
  /** Resolved host platform (test seam included). */
  platform: NodeJS.Platform;
  ramingaBin: string;
  ramingaBinSource: RamingaBinSource;
  /** Set when a bundled platform package was unavailable and PATH is the fallback. */
  ramingaBinDiagnostic?: string;
}

export interface ResolveConfigOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for resolving a package's package.json. */
  resolvePackageJson?: (specifier: string) => string;
  fileExists?: (file: string) => boolean;
  fileMode?: (file: string) => number;
  chmod?: (file: string, mode: number) => void;
}

const requireFromHere = createRequire(import.meta.url);

const NPM_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win32',
};

const NPM_CPU: Record<string, string> = {
  arm64: 'arm64',
  x64: 'x64',
};

/**
 * npm platform package for a Node platform/arch pair, or null when the host
 * cannot be served by a published package (for example freebsd/ia32).
 */
export function platformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const npmOS = NPM_OS[platform];
  const npmCPU = NPM_CPU[arch];
  if (!npmOS || !npmCPU) return null;
  return `@raminga/bin-${npmOS}-${npmCPU}`;
}

/** Explicit environment opt-in/out. null means unset or empty. */
function envTcpSetting(env: NodeJS.ProcessEnv): boolean | null {
  const raw = env.RAMINGA_API_TCP;
  if (raw === undefined || String(raw).trim() === '') return null;
  const value = String(raw).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function resolveConfig(
  config: PluginConfig,
  options: ResolveConfigOptions = {},
): ResolvedConfig {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const dataDir =
    config.dataDir || env.RAMINGA_DATA_DIR || path.join(os.homedir(), '.raminga');
  // Windows defaults to the loopback TCP API because Node's socketPath maps to
  // a named pipe, not the daemon's AF_UNIX socket. An explicit Windows false
  // wins over the environment and is never silently upgraded to TCP.
  //
  // macOS/Linux keep the original opt-in behavior: TCP is enabled by
  // `apiTcp: true` OR a truthy RAMINGA_API_TCP, so `apiTcp: false` does not
  // suppress an explicit environment opt-in there.
  let apiTcp: boolean;
  let apiTcpSource: ApiTcpSource;
  if (platform === 'win32') {
    if (config.apiTcp === true || config.apiTcp === false) {
      apiTcp = config.apiTcp;
      apiTcpSource = 'config';
    } else {
      const envSetting = envTcpSetting(env);
      if (envSetting !== null) {
        apiTcp = envSetting;
        apiTcpSource = 'env';
      } else {
        apiTcp = true;
        apiTcpSource = 'platform-default';
      }
    }
  } else if (config.apiTcp === true) {
    apiTcp = true;
    apiTcpSource = 'config';
  } else {
    const envSetting = envTcpSetting(env);
    if (envSetting === true) {
      apiTcp = true;
      apiTcpSource = 'env';
    } else if (config.apiTcp === false) {
      apiTcp = false;
      apiTcpSource = 'config';
    } else if (envSetting === false) {
      apiTcp = false;
      apiTcpSource = 'env';
    } else {
      apiTcp = false;
      apiTcpSource = 'platform-default';
    }
  }
  const base = {
    dataDir,
    socketPath: path.join(dataDir, SOCKET_FILE),
    tokenPath: path.join(dataDir, TOKEN_FILE),
    endpointPath: path.join(dataDir, ENDPOINT_FILE),
    apiTcp,
    apiTcpSource,
    platform,
  };

  // Precedence: explicit config > RAMINGA_BIN > npm platform package > PATH.
  if (config.ramingaBin) {
    return { ...base, ramingaBin: config.ramingaBin, ramingaBinSource: 'config' };
  }
  if (env.RAMINGA_BIN) {
    return { ...base, ramingaBin: env.RAMINGA_BIN, ramingaBinSource: 'env' };
  }

  const packageName = platformPackageName(platform, arch);
  if (packageName) {
    try {
      const resolvePackageJson =
        options.resolvePackageJson ?? ((specifier: string) => requireFromHere.resolve(specifier));
      const packageJSON = resolvePackageJson(`${packageName}/package.json`);
      const executable = platform === 'win32' ? 'raminga.exe' : 'raminga';
      const binary = path.join(path.dirname(packageJSON), 'bin', executable);
      const exists = options.fileExists ?? fs.existsSync;
      if (!exists(binary)) {
        throw new Error(`package ${packageName} does not contain bin/${executable}`);
      }
      // Published npm tarballs preserve 0755, but pnpm stores may hardlink the
      // file. Repair a missing execute bit only for the package-owned binary.
      if (platform !== 'win32') ensureExecutable(binary, options);
      return {
        ...base,
        ramingaBin: binary,
        ramingaBinSource: 'platform-package',
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        ramingaBin: 'raminga',
        ramingaBinSource: 'path',
        ramingaBinDiagnostic:
          `npm platform package ${packageName} is unavailable (${reason}); ` +
          'falling back to "raminga" on PATH. Reinstall @raminga/dsh or set ramingaBin.',
      };
    }
  }

  return {
    ...base,
    ramingaBin: 'raminga',
    ramingaBinSource: 'path',
    ramingaBinDiagnostic:
      `no npm platform package for ${platform}/${arch}; ` +
      'falling back to "raminga" on PATH. Install raminga or set ramingaBin.',
  };
}

function ensureExecutable(binary: string, options: ResolveConfigOptions): void {
  const mode = (options.fileMode ?? ((file: string) => fs.statSync(file).mode))(binary);
  if ((mode & 0o111) !== 0) return;
  (options.chmod ?? ((file: string, bits: number) => fs.chmodSync(file, bits)))(binary, 0o755);
}
