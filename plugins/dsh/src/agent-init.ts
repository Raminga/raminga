// Private Agent onboarding for the DSH shell.
//
// Mirrors internal/mcp's raminga_agent_init: create only missing files under
// <data-dir>/agent/ from generated templates, never overwrite existing files,
// never follow a symlinked agent/ or sessions/ directory, and never touch
// public/. Kept in TypeScript because DSH registers native tools rather than
// calling the raminga binary over MCP.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentOnboardingFile } from './tools.generated.js';

export interface AgentInitResult {
  data_dir: string;
  agent_dir: string;
  created: string[];
  existing: string[];
  directories_created: string[];
}

/** Join a fixed relative path inside dataDir; reject absolute or escaping paths. */
export function safeAgentPath(dataDir: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    throw new Error(`invalid Agent path: ${JSON.stringify(rel)}`);
  }
  const root = path.resolve(dataDir);
  const dest = path.resolve(root, rel);
  const back = path.relative(root, dest);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`Agent path escapes the data directory: ${JSON.stringify(rel)}`);
  }
  return dest;
}

function ensurePrivateDir(dir: string): boolean {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return true;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to follow symlinked Agent directory: ${dir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Agent path is not a directory: ${dir}`);
  }
  return false;
}

function writeNewFile(file: string, content: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true;
    throw error;
  }
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return false;
}

/**
 * Refuse to create agent/ before the node itself has an identity. Otherwise
 * the data directory would look like a foreign non-empty directory to the
 * daemon's first-run safety check on every later start.
 */
function requireNodeIdentity(root: string): void {
  const keyPath = path.join(root, 'identity', 'key');
  let info: fs.Stats;
  try {
    info = fs.lstatSync(keyPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(
        `Raminga node is not initialized: ${keyPath} is missing. ` +
          'Call raminga_status to confirm the node and initialize it before creating private Agent data; ' +
          'no files or directories were created.',
      );
    }
    throw new Error(
      `failed to inspect node identity ${keyPath}: ${(error as Error).message}; ` +
        'no files or directories were created.',
    );
  }
  if (!info.isFile()) {
    throw new Error(
      `Raminga node identity ${keyPath} is not a regular file; ` +
        'check raminga_status and repair the node before creating private Agent data; ' +
        'no files or directories were created.',
    );
  }
}

export function initAgentData(
  dataDir: string,
  templates: readonly AgentOnboardingFile[],
): AgentInitResult {
  const root = path.resolve(dataDir);
  requireNodeIdentity(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`data directory is not a directory: ${root}`);
  }

  const created: string[] = [];
  const existing: string[] = [];
  const directoriesCreated: string[] = [];

  const agentDir = safeAgentPath(root, 'agent');
  if (ensurePrivateDir(agentDir)) directoriesCreated.push('agent/');

  for (const template of templates) {
    // Generated paths are bare file names under agent/. Reject separators and
    // parent segments here so a corrupt generator cannot redirect a write.
    if (
      !template.path ||
      template.path === '.' ||
      template.path === '..' ||
      path.basename(template.path) !== template.path
    ) {
      throw new Error(`invalid Agent template path: ${JSON.stringify(template.path)}`);
    }
    const dest = safeAgentPath(root, path.join('agent', template.path));
    const existed = writeNewFile(dest, template.content);
    const rel = path.posix.join('agent', template.path.split(path.sep).join('/'));
    if (existed) existing.push(rel);
    else created.push(rel);
  }

  const sessionsDir = safeAgentPath(root, path.join('agent', 'sessions'));
  if (ensurePrivateDir(sessionsDir)) directoriesCreated.push('agent/sessions/');

  return {
    data_dir: root,
    agent_dir: agentDir,
    created,
    existing,
    directories_created: directoriesCreated,
  };
}
