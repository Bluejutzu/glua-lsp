// Finding files and building a workspace, shared by both commands.

import fs from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';

import { GmodApi } from '@glua/api/index.js';
import { Workspace } from '@glua/analyze/workspace.js';
import { ConfigResolver, matchesGlob } from '@glua/config/index.js';
import { DEFAULT_SETTINGS } from '@glua/server/settings.js';
import { FactCache, hashOf } from './cache.js';

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

export function collectLuaFiles(
  targets: string[],
  maxFiles: number,
  options: {
    /** `.glua.json`'s `workspace.exclude`, in the same glob syntax as override `files` patterns. */
    exclude?: string[];
    /** What exclude patterns are relative to. Without it, only the bare entry name is checked. */
    root?: string;
  } = {},
): string[] {
  const exclude = options.exclude ?? [];
  const found: string[] = [];
  const seen = new Set<string>();

  const isExcluded = (fsPath: string, name: string): boolean => {
    if (exclude.length === 0) return false;
    const relative = options.root ? path.relative(options.root, fsPath).replace(/\\/g, '/') : name;
    return exclude.some((pattern) => matchesGlob(pattern, name) || matchesGlob(pattern, relative));
  };

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
        if (name.startsWith('.') || SKIP_DIRECTORIES.has(name) || isExcluded(full, entry.name)) continue;
        walkDir(full);
      } else if (name.endsWith('.lua') || name.endsWith('.glua')) {
        if (isExcluded(full, entry.name)) continue;
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
  /** How much of the index came off disk rather than being parsed again. */
  cache: { hits: number; misses: number };
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
  options: {
    maxFiles?: number;
    root?: string;
    indexProject?: boolean;
    onIndex?: (done: number, total: number, file: string) => void;
    /** A Garry's Mod directory, so base game content counts as existing. */
    gamePath?: string;
    /** Read and write the fact cache. On unless asked otherwise. */
    cache?: boolean;
  } = {},
): LoadedProject {
  const api = loadApi();
  const root = path.resolve(options.root ?? process.cwd());
  const indexProject = options.indexProject ?? true;

  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const projectSettings = config.projectSettings();
  // The raw file, not projectSettings(): that merges onto the server's 6000
  // default, which would silently shrink the CLI's own higher default the
  // moment any .glua.json exists, even one that never touched maxFiles.
  const configuredMaxFiles = config.loaded?.lint?.value.workspace?.maxFiles;
  const maxFiles = options.maxFiles ?? configuredMaxFiles ?? 20000;
  // An install path belongs to a machine, not a repository, so the flag and the
  // environment come before anything committed.
  const gamePath =
    options.gamePath || process.env.GLUA_GAME_PATH || projectSettings.workspace.gamePath;
  const exclude = projectSettings.workspace.exclude;
  const collectOptions = { exclude, root: config.root ?? root };

  const workspace = new Workspace(api, {
    maxFiles,
    exclude,
    ...(gamePath ? { gamePath } : {}),
  });
  // Files are loaded directly here rather than through scanFolder, so the
  // asset roots have to be set explicitly or nothing finds this addon's
  // materials, models or sounds.
  workspace.setFolders([root]);

  // Index the project root so cross-file facts are complete, then make sure
  // every explicitly named target is in there too. Callers that only care
  // about the target files (e.g. formatting) can skip this.
  const files = collectLuaFiles(targets, maxFiles, collectOptions);
  // A caller that indexes nothing must not touch the cache: saving prunes
  // entries this run did not look at, so `glua fmt` would empty the cache that
  // `glua lint` had just filled.
  const cache =
    options.cache === false || !indexProject ? FactCache.disabled() : FactCache.open(root);

  if (indexProject) {
    // Frameworks first: their globals are what stop the project's own files
    // reading as full of undefined names.
    for (const library of projectSettings.workspace.libraries) {
      workspace.indexLibrary(path.resolve(config.root ?? root, library));
    }

    const indexed = collectLuaFiles([root], maxFiles, collectOptions);
    indexed.forEach((file, i) => {
      index(workspace, cache, root, file);
      options.onIndex?.(i + 1, indexed.length, file);
    });

    for (const file of files) {
      if (!workspace.get(uriOf(file))) index(workspace, cache, root, file);
    }
  }

  cache.save();

  return { api, workspace, config, files, root, cache: cache.stats };
}

/**
 * Puts one file into the workspace, off the cache when its contents match.
 *
 * A hit still reads the file — the text is needed either way, to hash it and
 * because findings quote it. What it skips is the parse and the bind, which is
 * where the time actually goes.
 */
function index(workspace: Workspace, cache: FactCache, root: string, file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  // Relative, so a cache survives the project being moved or checked out
  // somewhere else — a CI runner and a laptop can share one.
  const key = path.relative(root, file).replace(/\\/g, '/');
  const hash = hashOf(text);
  const uri = uriOf(file);

  const cached = cache.get(key, hash);
  if (cached) {
    workspace.adopt(uri, text, 0, cached);
    return;
  }

  workspace.analyse(uri, text, 0, false);
  const facts = workspace.factsFor(uri);
  if (facts) cache.set(key, hash, facts);
}

/**
 * Must match how the workspace keys its files.
 *
 * Node's pathToFileURL and vscode-uri disagree on Windows — `file:///C:/x`
 * versus `file:///c%3A/x` — and a mismatch means every lookup silently misses.
 */
export const uriOf = (file: string): string => URI.file(path.resolve(file)).toString();
