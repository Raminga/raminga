// Resolved plugin configuration: where the node lives and which binary can
// (re)start it. Mirrors the Go CLI's data-dir resolution and the api/paths
// file names (internal/api/paths/paths.go).
import os from 'node:os';
import path from 'node:path';

export const SOCKET_FILE = 'api.sock';
export const TOKEN_FILE = 'api.token';
export const EXPECTED_API_VERSION = '2';

export interface PluginConfig {
  dataDir?: string;
  ramingaBin?: string;
}

export interface ResolvedConfig {
  dataDir: string;
  socketPath: string;
  tokenPath: string;
  ramingaBin: string;
}

export function resolveConfig(config: PluginConfig): ResolvedConfig {
  const dataDir =
    config.dataDir || process.env.RAMINGA_DATA_DIR || path.join(os.homedir(), '.raminga');
  return {
    dataDir,
    socketPath: path.join(dataDir, SOCKET_FILE),
    tokenPath: path.join(dataDir, TOKEN_FILE),
    ramingaBin: config.ramingaBin || 'raminga',
  };
}
