// Finding files and building a workspace, shared by both commands.

import fs from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';

import { GmodApi } from '@glua/api/index.js';
import { Workspace } from '@glua/analyze/workspace.js';
import { ConfigResolver } from '@glua/config/index.js';
import { DEFAULT_SETTINGS } from '@glua/server/settings.js';

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', 'out', 'dist', 'cache', 'downloads', 'download',
]);

/** The API dataset sits next to the bundle after a build, or in src during dev. */
export function loadApi(): GmodApi {
  const candidates = [
    path.join(__dirname, 'gmod-api.json'),
    path.join(__dirname, '..', '..', 'glua-lsp', 'src', 'api', 'data', 'gmod-api.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return GmodApi.load(file);
  }
  throw new Error(
    'Could not find gmod-api.json. Run `pnpm run build` in packages/glua-cli.',
  );
}

export function collectLuaFiles(targets: string[], maxFiles: number): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const addFile = (file: string) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || found.length >= maxFiles) return;
    seen.add(resolved);
    found.push(resolved);
  };

  const walkDir = (dir: string): void => {
    if (found.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const name = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRECTORIES.has(name)) continue;
        walkDir(full);
      } else if (name.endsWith('.lua') || name.endsWith('.glua')) {
        addFile(full);
      }
    }
  };

  for (const target of targets) {
    const resolved = path.resolve(target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`No such file or directory: ${target}`);
    }
    if (stat.isDirectory()) walkDir(resolved);
    else addFile(resolved);
  }

  return found;
}

export interface LoadedProject {
  api: GmodApi;
  workspace: Workspace;
  config: ConfigResolver;
  files: string[];
  /** Directory config files were resolved from. */
  root: string;
}

/**
 * Indexes the whole project, not just the files being reported on.
 *
 * Cross-file rules — an unhandled net message, a duplicate hook identifier —
 * are only correct when the index has seen everything, so linting one file
 * still means reading the project around it.
 */
export function loadProject(
  targets: string[],
  options: { maxFiles?: number; root?: string } = {},
): LoadedProject {
  const api = loadApi();
  const maxFiles = options.maxFiles ?? 20000;
  const root = path.resolve(options.root ?? process.cwd());

  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const workspace = new Workspace(api, { maxFiles, exclude: [] });

  // Index the project root so cross-file facts are complete, then make sure
  // every explicitly named target is in there too.
  const indexed = collectLuaFiles([root], maxFiles);
  for (const file of indexed) workspace.loadFromDisk(file);

  const files = collectLuaFiles(targets, maxFiles);
  for (const file of files) {
    if (!workspace.get(uriOf(file))) workspace.loadFromDisk(file);
  }

  return { api, workspace, config, files, root };
}

/**
 * Must match how the workspace keys its files.
 *
 * Node's pathToFileURL and vscode-uri disagree on Windows — `file:///C:/x`
 * versus `file:///c%3A/x` — and a mismatch means every lookup silently misses.
 */
export const uriOf = (file: string): string => URI.file(path.resolve(file)).toString();
