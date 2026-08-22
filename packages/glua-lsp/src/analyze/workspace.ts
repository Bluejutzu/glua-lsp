import fs from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { GmodApi } from '../api/index.js';
import {
  analyseFile,
  type FileAnalysis,
  type GeneratedAccessor,
  type GlobalDefinition,
  type Span,
} from './binder.js';
import type { Realm } from '../api/types.js';
import { Scope } from './scope.js';
import { tableType, UNKNOWN, type GType } from './types.js';

export interface Located<T> {
  uri: string;
  value: T;
}

export interface WorkspaceOptions {
  maxFiles: number;
  exclude: string[];
}

const DEFAULT_EXCLUDE = [
  'node_modules', '.git', '.svn', 'out', 'dist', 'cache', 'downloads', 'download',
];

/** `lua/`-relative root for a GMod script path, used to resolve `include()`. */
export function luaRootOf(fsPath: string): string | null {
  const parts = fsPath.replace(/\\/g, '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.toLowerCase() === 'lua') return parts.slice(0, i + 1).join('/');
    // Gamemode scripts resolve relative to the gamemode directory.
    if (parts[i]!.toLowerCase() === 'gamemode' && parts[i - 2]?.toLowerCase() === 'gamemodes') {
      return parts.slice(0, i + 1).join('/');
    }
  }
  return null;
}

/** Candidate absolute paths for an `include("...")` / `AddCSLuaFile("...")` argument. */
export function resolveGluaPath(fromFsPath: string, includePath: string): string[] {
  const clean = includePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean) return [];
  const candidates: string[] = [];
  const dir = path.dirname(fromFsPath).replace(/\\/g, '/');

  const root = luaRootOf(fromFsPath);
  if (root) candidates.push(`${root}/${clean}`);
  candidates.push(`${dir}/${clean}`);

  return [...new Set(candidates.map((c) => path.normalize(c)))];
}

export class Workspace {
  private readonly files = new Map<string, FileAnalysis>();

  /** Cross-file indexes, rebuilt lazily after any change. */
  private globalsByPath: Map<string, Located<GlobalDefinition>[]> | null = null;
  private childrenByPrefix: Map<string, Set<string>> | null = null;
  private hookRunNames: Map<string, Located<Span>[]> | null = null;
  private netRegisteredNames: Map<string, Located<Span>[]> | null = null;
  private netStartNames: Map<string, Located<Span>[]> | null = null;
  private netReceiveNames: Map<string, Located<Span>[]> | null = null;
  private clientFiles: Set<string> | null = null;
  private readonly accessorCache = new Map<string, Located<GeneratedAccessor>[]>();
  private duplicateCache: {
    hooks: Map<string, Located<{ span: Span; realm: Realm }>[]>;
    timers: Map<string, Located<{ span: Span; realm: Realm }>[]>;
  } | null = null;

  constructor(
    private readonly api: GmodApi,
    private options: WorkspaceOptions = { maxFiles: 6000, exclude: [] },
  ) {}

  setOptions(options: WorkspaceOptions): void {
    this.options = options;
  }

  get size(): number {
    return this.files.size;
  }

  uris(): IterableIterator<string> {
    return this.files.keys();
  }

  get(uri: string): FileAnalysis | undefined {
    return this.files.get(uri);
  }

  all(): IterableIterator<FileAnalysis> {
    return this.files.values();
  }

  private invalidate(): void {
    this.globalsByPath = null;
    this.childrenByPrefix = null;
    this.hookRunNames = null;
    this.netRegisteredNames = null;
    this.netStartNames = null;
    this.netReceiveNames = null;
    this.clientFiles = null;
    this.accessorCache.clear();
    this.duplicateCache = null;
  }

  /**
   * @param retainAst Keep the syntax tree and scopes. Only worth it for files
   * open in the editor: on a real gamemode the trees dominate memory by two
   * orders of magnitude over the extracted facts, and nothing cross-file needs
   * them.
   */
  analyse(uri: string, text: string, version: number, retainAst = true): FileAnalysis {
    const fsPath = URI.parse(uri).fsPath;
    const analysis = analyseFile(uri, fsPath, text, version, this.api, {
      externalGlobal: (p) => this.externalGlobal(p, uri),
    });
    this.files.set(uri, retainAst ? analysis : releaseAst(analysis));
    this.invalidate();
    return analysis;
  }

  /** An analysis guaranteed to carry a syntax tree, re-parsing if needed. */
  full(uri: string): FileAnalysis | undefined {
    const cached = this.files.get(uri);
    if (!cached) return undefined;
    if (cached.hasAst) return cached;
    return this.analyse(uri, cached.text, cached.version, true);
  }

  /**
   * Drops a file's syntax tree again after a one-off use, so scanning the whole
   * workspace does not end up holding every tree at once.
   */
  releaseAst(uri: string): void {
    const cached = this.files.get(uri);
    if (cached?.hasAst) this.files.set(uri, releaseAst(cached));
  }

  remove(uri: string): void {
    if (this.files.delete(uri)) this.invalidate();
  }

  /* ------------------------------------------------------------- indexes */

  private buildGlobalIndex(): void {
    const byPath = new Map<string, Located<GlobalDefinition>[]>();
    const children = new Map<string, Set<string>>();

    for (const file of this.files.values()) {
      for (const def of file.globalDefs) {
        const list = byPath.get(def.path);
        if (list) list.push({ uri: file.uri, value: def });
        else byPath.set(def.path, [{ uri: file.uri, value: def }]);

        // `MyLib.Sub.Fn` contributes `MyLib` -> `Sub` and `MyLib.Sub` -> `Fn`.
        const segments = def.path.split(/[.:]/);
        for (let i = 1; i < segments.length; i++) {
          const prefix = segments.slice(0, i).join('.');
          const child = segments[i]!;
          const set = children.get(prefix);
          if (set) set.add(child);
          else children.set(prefix, new Set([child]));
        }
      }
    }

    this.globalsByPath = byPath;
    this.childrenByPrefix = children;
  }

  private globalIndex(): Map<string, Located<GlobalDefinition>[]> {
    if (!this.globalsByPath) this.buildGlobalIndex();
    return this.globalsByPath!;
  }

  private childIndex(): Map<string, Set<string>> {
    if (!this.childrenByPrefix) this.buildGlobalIndex();
    return this.childrenByPrefix!;
  }

  definitionsOf(globalPath: string): Located<GlobalDefinition>[] {
    return this.globalIndex().get(globalPath) ?? [];
  }

  /** Member names contributed by the workspace under a global table path. */
  membersOf(globalPath: string): string[] {
    return [...(this.childIndex().get(globalPath) ?? [])];
  }

  isKnownGlobalPath(globalPath: string): boolean {
    return this.globalIndex().has(globalPath) || this.childIndex().has(globalPath);
  }

  /**
   * Type of a global defined elsewhere. Kept structural and shallow so it never
   * holds references into another file's AST — that would break invalidation.
   */
  private externalGlobal(globalPath: string, excludeUri: string, depth = 0): GType | undefined {
    const defs = this.globalIndex().get(globalPath)?.filter((d) => d.uri !== excludeUri) ?? [];
    const kids = this.childIndex().get(globalPath);

    if (defs.some((d) => d.value.kind === 'function')) {
      return { kind: 'function', name: globalPath };
    }

    if (kids?.size || defs.some((d) => d.value.kind === 'table')) {
      const members = new Map<string, GType>();
      if (depth < 3 && kids) {
        for (const child of kids) {
          const childType = this.externalGlobal(`${globalPath}.${child}`, excludeUri, depth + 1);
          members.set(child, childType ?? { kind: 'unknown' });
        }
      }
      return tableType({ members });
    }

    if (defs.length) return { kind: 'unknown' };
    return undefined;
  }

  private buildHookIndex(): void {
    const runs = new Map<string, Located<Span>[]>();
    for (const file of this.files.values()) {
      for (const run of file.hookRuns) {
        const list = runs.get(run.hookName);
        if (list) list.push({ uri: file.uri, value: run.nameSpan });
        else runs.set(run.hookName, [{ uri: file.uri, value: run.nameSpan }]);
      }
    }
    this.hookRunNames = runs;
  }

  /** Custom hooks fired somewhere in the workspace via hook.Run / hook.Call. */
  customHookNames(): Map<string, Located<Span>[]> {
    if (!this.hookRunNames) this.buildHookIndex();
    return this.hookRunNames!;
  }

  private buildNetIndex(): void {
    const registered = new Map<string, Located<Span>[]>();
    const starts = new Map<string, Located<Span>[]>();
    const receives = new Map<string, Located<Span>[]>();

    const add = (map: Map<string, Located<Span>[]>, name: string, uri: string, span: Span) => {
      const list = map.get(name);
      if (list) list.push({ uri, value: span });
      else map.set(name, [{ uri, value: span }]);
    };

    for (const file of this.files.values()) {
      for (const r of file.netRegisters) add(registered, r.name, file.uri, r.nameSpan);
      for (const s of file.netStarts) add(starts, s.name, file.uri, s.nameSpan);
      for (const r of file.netReceives) add(receives, r.name, file.uri, r.nameSpan);
    }

    this.netRegisteredNames = registered;
    this.netStartNames = starts;
    this.netReceiveNames = receives;
  }

  netRegistered(): Map<string, Located<Span>[]> {
    if (!this.netRegisteredNames) this.buildNetIndex();
    return this.netRegisteredNames!;
  }

  netStarts(): Map<string, Located<Span>[]> {
    if (!this.netStartNames) this.buildNetIndex();
    return this.netStartNames!;
  }

  netReceives(): Map<string, Located<Span>[]> {
    if (!this.netReceiveNames) this.buildNetIndex();
    return this.netReceiveNames!;
  }

  /** Every file reachable by clients via AddCSLuaFile, normalised to lowercase. */
  clientReachableFiles(): Set<string> {
    if (this.clientFiles) return this.clientFiles;
    const out = new Set<string>();

    for (const file of this.files.values()) {
      for (const ref of file.addCSLuaFiles) {
        if (!ref.path) {
          // Bare AddCSLuaFile() sends the current file.
          out.add(file.fsPath.replace(/\\/g, '/').toLowerCase());
          continue;
        }
        for (const candidate of resolveGluaPath(file.fsPath, ref.path)) {
          out.add(candidate.replace(/\\/g, '/').toLowerCase());
        }
      }
    }

    this.clientFiles = out;
    return out;
  }

  /**
   * Generated accessors visible to a file.
   *
   * An entity's NetworkVars are declared in one of its files (usually
   * shared.lua) and used from all of them, so the whole directory contributes.
   */
  accessorsNear(fsPath: string): Located<GeneratedAccessor>[] {
    const dir = path.dirname(fsPath).replace(/\\/g, '/').toLowerCase();
    const cached = this.accessorCache.get(dir);
    if (cached) return cached;

    const out: Located<GeneratedAccessor>[] = [];
    for (const file of this.files.values()) {
      if (path.dirname(file.fsPath).replace(/\\/g, '/').toLowerCase() !== dir) continue;
      for (const accessor of file.accessors) out.push({ uri: file.uri, value: accessor });
    }

    this.accessorCache.set(dir, out);
    return out;
  }

  /**
   * `hook.Add` calls that share an event and identifier, and `timer.Create`
   * calls that share a name. Registering twice silently replaces the first.
   */
  duplicateRegistrations(): {
    hooks: Map<string, Located<{ span: Span; realm: Realm }>[]>;
    timers: Map<string, Located<{ span: Span; realm: Realm }>[]>;
  } {
    if (this.duplicateCache) return this.duplicateCache;

    const hooks = new Map<string, Located<{ span: Span; realm: Realm }>[]>();
    const timers = new Map<string, Located<{ span: Span; realm: Realm }>[]>();

    const add = (
      map: Map<string, Located<{ span: Span; realm: Realm }>[]>,
      key: string,
      uri: string,
      span: Span,
      realm: Realm,
    ) => {
      const list = map.get(key);
      if (list) list.push({ uri, value: { span, realm } });
      else map.set(key, [{ uri, value: { span, realm } }]);
    };

    for (const file of this.files.values()) {
      for (const hook of file.hookAdds) {
        // An anonymous identifier is a different situation; skip it.
        if (!hook.identifier) continue;
        add(hooks, `${hook.hookName} ${hook.identifier}`, file.uri, hook.nameSpan, hook.realm);
      }
      for (const timer of file.timers) {
        add(timers, timer.path, file.uri, timer.span, file.realm.file);
      }
    }

    for (const map of [hooks, timers]) {
      for (const [key, sites] of map) {
        if (sites.length < 2) map.delete(key);
      }
    }

    this.duplicateCache = { hooks, timers };
    return this.duplicateCache;
  }

  /** The file an `include()` / `AddCSLuaFile()` argument points at, if indexed. */
  resolveReference(fromFsPath: string, includePath: string): FileAnalysis | undefined {
    for (const candidate of resolveGluaPath(fromFsPath, includePath)) {
      const uri = URI.file(candidate).toString();
      const hit = this.files.get(uri);
      if (hit) return hit;
      // Case-insensitive fallback for Windows and for GMod's own leniency.
      const lower = candidate.replace(/\\/g, '/').toLowerCase();
      for (const file of this.files.values()) {
        if (file.fsPath.replace(/\\/g, '/').toLowerCase() === lower) return file;
      }
    }
    return undefined;
  }

  /* ------------------------------------------------------------ scanning */

  /** Recursively finds .lua files under a folder, honouring the exclude list. */
  scanFolder(folderFsPath: string): string[] {
    const excluded = new Set([...DEFAULT_EXCLUDE, ...this.options.exclude.map((e) => e.toLowerCase())]);
    const found: string[] = [];

    const walkDir = (dir: string): void => {
      if (found.length >= this.options.maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= this.options.maxFiles) return;
        const name = entry.name.toLowerCase();
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (name.startsWith('.') || excluded.has(name)) continue;
          walkDir(full);
        } else if (name.endsWith('.lua') || name.endsWith('.glua')) {
          found.push(full);
        }
      }
    };

    walkDir(folderFsPath);
    return found;
  }

  /** Reads and analyses a file from disk. Used for files not open in the editor. */
  loadFromDisk(fsPath: string): FileAnalysis | undefined {
    try {
      const text = fs.readFileSync(fsPath, 'utf8');
      return this.analyse(URI.file(fsPath).toString(), text, 0, false);
    } catch {
      return undefined;
    }
  }
}

const EMPTY_CHUNK: FileAnalysis['chunk'] = { type: 'Chunk', body: [], start: 0, end: 0 };

/**
 * Drops the syntax tree, scopes and every closure that captured them, leaving
 * the extracted facts intact. The closures matter as much as the tree: a single
 * retained closure keeps its whole enclosing scope alive.
 */
function releaseAst(analysis: FileAnalysis): FileAnalysis {
  return {
    ...analysis,
    hasAst: false,
    chunk: EMPTY_CHUNK,
    comments: [],
    parseErrors: [],
    root: new Scope(null, 0, 0, true),
    unusedLocals: [],
    guardedGlobals: new Set(),
    // Facts survive; only the tree and its closures are dropped.
    typeOf: () => UNKNOWN,
    scopeAt: () => new Scope(null, 0, 0, true),
    docFor: () => undefined,
  };
}

/**
 * Does this folder look like a Garry's Mod project? Used so the extension can
 * stay out of the way of unrelated Lua workspaces instead of hijacking `.lua`.
 */
export function looksLikeGmodProject(folderFsPath: string): boolean {
  const probes = [
    'lua/autorun',
    'lua/entities',
    'lua/weapons',
    'gamemodes',
    'addon.json',
    'garrysmod',
    'lua/includes',
  ];
  for (const probe of probes) {
    if (fs.existsSync(path.join(folderFsPath, ...probe.split('/')))) return true;
  }
  // A `.lua` file that mentions GMod-only APIs is also a strong signal.
  try {
    const entries = fs.readdirSync(folderFsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.lua')) continue;
      const text = fs.readFileSync(path.join(folderFsPath, entry.name), 'utf8').slice(0, 8192);
      if (/\b(AddCSLuaFile|hook\.Add|util\.AddNetworkString|surface\.|ents\.|SERVER|CLIENT)\b/.test(text)) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}
