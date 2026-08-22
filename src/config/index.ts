import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FORMAT_OPTIONS, type FormatOptions } from '../format/options.js';
import { mergeSettings, type Settings } from '../server/settings.js';

/**
 * Configuration precedence, lowest to highest:
 *
 *   1. built-in defaults
 *   2. editor settings (`glua.*`) — per person
 *   3. `.editorconfig`            — generic, shared
 *   4. `.prettierrc`              — generic, shared, mapped best-effort
 *   5. `.glua.json`               — this project's rules
 *   6. `.gluafmtrc.json`          — this project's formatting rules, most specific
 *
 * Generic tools get read because a repository that already pins indentation in
 * `.editorconfig` should not need to say it twice; anything GLua-specific wins
 * over them because it was written for this formatter.
 */

/* ------------------------------------------------------------ file shapes */

export interface GluaConfigFile {
  diagnostics?: Partial<Settings['diagnostics']>;
  format?: Partial<Settings['format']>;
  workspace?: Partial<Settings['workspace']>;
  completion?: Partial<Settings['completion']>;
  inlayHints?: Partial<Settings['inlayHints']>;
  hover?: Partial<Settings['hover']>;
  /** Globals from addons outside this workspace, e.g. `["ULib", "ulx"]`. */
  globals?: string[];
  /** Per-path rule overrides, applied in order. */
  overrides?: {
    files: string[];
    diagnostics?: Partial<Settings['diagnostics']>;
    globals?: string[];
  }[];
}

/** `.gluafmtrc.json` — formatting only. */
export type GluaFmtConfigFile = Partial<FormatOptions> & {
  $schema?: string;
  overrides?: { files: string[]; options: Partial<FormatOptions> }[];
};

export const LINT_CONFIG_FILENAMES = ['.glua.json', 'glua.json', '.gluarc.json'];
export const FORMAT_CONFIG_FILENAMES = ['.gluafmtrc.json', '.gluafmtrc', 'gluafmt.json'];

export interface LoadedFile<T> {
  value: T;
  file: string;
  error?: string;
}

/** JSON with comments and trailing commas — these are hand-edited files. */
function parseLooseJson<T>(raw: string): T {
  const cleaned = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned) as T;
}

function loadFirst<T>(root: string, names: string[]): LoadedFile<T> | null {
  for (const name of names) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      return { value: parseLooseJson<T>(fs.readFileSync(file, 'utf8')), file };
    } catch (error) {
      return {
        value: {} as T,
        file,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- globs */

/**
 * Minimal glob matcher: `**` spans directories, `*` and `?` do not, and
 * `{a,b}` alternates. Enough for the patterns people write in a config file.
 */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const source = globToRegexSource(normalise(pattern));
  return new RegExp(`^${source}$`, 'i').test(normalise(relativePath));
}

function globToRegexSource(glob: string): string {
  let source = '';

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is optional.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    if (char === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        source += '\\{';
        continue;
      }
      // Alternatives are globs themselves, so `{*.lua,*.glua}` keeps its stars.
      const options = glob.slice(i + 1, close).split(',');
      source += `(?:${options.map(globToRegexSource).join('|')})`;
      i = close;
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return source;
}

/* ------------------------------------------------------- generic configs */

/** The subset of `.editorconfig` that maps onto formatting decisions. */
function readEditorConfig(root: string): Partial<FormatOptions> {
  const file = path.join(root, '.editorconfig');
  if (!fs.existsSync(file)) return {};

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }

  const out: Partial<FormatOptions> = {};
  let applies = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      const pattern = section[1]!;
      applies =
        pattern === '*' ||
        matchesGlob(pattern, 'x.lua') ||
        matchesGlob(pattern, 'x.glua');
      continue;
    }
    if (!applies) continue;

    const [key, ...rest] = line.split('=');
    if (!key || !rest.length) continue;
    const name = key.trim().toLowerCase();
    const value = rest.join('=').trim().toLowerCase();

    switch (name) {
      case 'indent_style':
        if (value === 'tab') out.useTabs = true;
        else if (value === 'space') out.useTabs = false;
        break;
      case 'indent_size':
      case 'tab_width': {
        const size = Number.parseInt(value, 10);
        if (Number.isFinite(size) && size > 0) out.indentSize = size;
        break;
      }
      case 'max_line_length': {
        const width = Number.parseInt(value, 10);
        if (Number.isFinite(width) && width > 0) out.maxLineWidth = width;
        break;
      }
      case 'end_of_line':
        if (value === 'lf') out.endOfLine = '\n';
        else if (value === 'crlf') out.endOfLine = '\r\n';
        break;
      default:
        break;
    }
  }

  return out;
}

/** Prettier's options, mapped onto the ones that have a Lua equivalent. */
function readPrettierConfig(root: string): Partial<FormatOptions> {
  const candidates = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml'];
  let raw: Record<string, unknown> | null = null;

  for (const name of candidates) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      raw = name.endsWith('.yaml') || name.endsWith('.yml')
        ? parseSimpleYaml(text)
        : parseLooseJson<Record<string, unknown>>(text);
      break;
    } catch {
      return {};
    }
  }

  if (!raw) {
    // `prettier` key inside package.json.
    const pkg = path.join(root, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { prettier?: Record<string, unknown> };
        if (parsed.prettier) raw = parsed.prettier;
      } catch {
        return {};
      }
    }
  }
  if (!raw) return {};

  const out: Partial<FormatOptions> = {};
  if (typeof raw.useTabs === 'boolean') out.useTabs = raw.useTabs;
  if (typeof raw.tabWidth === 'number' && raw.tabWidth > 0) out.indentSize = raw.tabWidth;
  if (typeof raw.printWidth === 'number' && raw.printWidth > 0) out.maxLineWidth = raw.printWidth;
  if (typeof raw.singleQuote === 'boolean') out.quoteStyle = raw.singleQuote ? 'single' : 'double';
  if (raw.endOfLine === 'lf') out.endOfLine = '\n';
  if (raw.endOfLine === 'crlf') out.endOfLine = '\r\n';
  // `semi` is about statement terminators, which Lua does not require.
  if (raw.semi === false) out.semicolons = 'remove';

  return out;
}

/** Flat `key: value` YAML, which is all a .prettierrc ever is. */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else if (/^-?\d+$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------- resolver */

export interface ConfigSources {
  lint?: LoadedFile<GluaConfigFile>;
  format?: LoadedFile<GluaFmtConfigFile>;
  editorConfig: boolean;
  prettier: boolean;
  root: string;
}

/** Only keys the caller actually set, so `undefined` never clobbers a default. */
function defined<T extends object>(source: T | undefined): Partial<T> {
  if (!source) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

export class ConfigResolver {
  private base: Settings;
  private sources: ConfigSources | null = null;
  private readonly settingsCache = new Map<string, Settings>();
  private readonly formatCache = new Map<string, FormatOptions>();
  private readonly globalsCache = new Map<string, Set<string>>();

  constructor(base: Settings) {
    this.base = base;
  }

  get loaded(): ConfigSources | null {
    return this.sources;
  }

  /** Every config file being used, for reporting and for file watching. */
  get files(): string[] {
    const out: string[] = [];
    if (this.sources?.lint) out.push(this.sources.lint.file);
    if (this.sources?.format) out.push(this.sources.format.file);
    return out;
  }

  get errors(): string[] {
    const out: string[] = [];
    if (this.sources?.lint?.error) out.push(`${this.sources.lint.file}: ${this.sources.lint.error}`);
    if (this.sources?.format?.error) out.push(`${this.sources.format.file}: ${this.sources.format.error}`);
    return out;
  }

  setEditorSettings(settings: Settings): void {
    this.base = settings;
    this.clear();
  }

  private clear(): void {
    this.settingsCache.clear();
    this.formatCache.clear();
    this.globalsCache.clear();
  }

  /** Reads config files from the first workspace root that has any. */
  reload(roots: string[]): ConfigSources | null {
    this.sources = null;
    for (const root of roots) {
      const lint = loadFirst<GluaConfigFile>(root, LINT_CONFIG_FILENAMES);
      const format = loadFirst<GluaFmtConfigFile>(root, FORMAT_CONFIG_FILENAMES);
      const editorConfig = fs.existsSync(path.join(root, '.editorconfig'));
      const prettier = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml']
        .some((name) => fs.existsSync(path.join(root, name)));

      if (lint || format || editorConfig || prettier) {
        this.sources = {
          ...(lint ? { lint } : {}),
          ...(format ? { format } : {}),
          editorConfig,
          prettier,
          root,
        };
        break;
      }
    }
    this.clear();
    return this.sources;
  }

  private relative(fsPath: string): string {
    if (!this.sources) return path.basename(fsPath);
    return path.relative(this.sources.root, fsPath).replace(/\\/g, '/');
  }

  /** Linter and feature settings for one file. */
  settingsFor(fsPath: string): Settings {
    const cached = this.settingsCache.get(fsPath);
    if (cached) return cached;

    const config = this.sources?.lint?.value;
    let settings = config
      ? mergeSettings({
          ...this.base,
          diagnostics: { ...this.base.diagnostics, ...defined(config.diagnostics) },
          format: { ...this.base.format, ...defined(config.format) },
          workspace: { ...this.base.workspace, ...defined(config.workspace) },
          completion: { ...this.base.completion, ...defined(config.completion) },
          inlayHints: { ...this.base.inlayHints, ...defined(config.inlayHints) },
          hover: { ...this.base.hover, ...defined(config.hover) },
        })
      : this.base;

    const relative = this.relative(fsPath);
    for (const override of config?.overrides ?? []) {
      if (!override.files.some((pattern) => matchesGlob(pattern, relative))) continue;
      settings = {
        ...settings,
        diagnostics: { ...settings.diagnostics, ...defined(override.diagnostics) },
      };
    }

    this.settingsCache.set(fsPath, settings);
    return settings;
  }

  /**
   * Formatting options for one file.
   *
   * `editorIndent` is what the editor reports for the document; it is only used
   * when nothing more specific has an opinion, so an explicit `.editorconfig`
   * or `.gluafmtrc.json` still wins.
   */
  formatOptionsFor(
    fsPath: string,
    editorIndent?: { useTabs: boolean; indentSize: number },
    endOfLine?: '\n' | '\r\n',
  ): FormatOptions {
    const cacheKey = `${fsPath} ${editorIndent?.useTabs} ${editorIndent?.indentSize}`;
    const cached = this.formatCache.get(cacheKey);
    if (cached) return { ...cached, ...(endOfLine ? { endOfLine } : {}) };

    const settings = this.settingsFor(fsPath);
    const root = this.sources?.root;

    // Lowest to highest.
    let options: FormatOptions = {
      ...DEFAULT_FORMAT_OPTIONS,
      ...(editorIndent ? { useTabs: editorIndent.useTabs, indentSize: editorIndent.indentSize } : {}),
      maxLineWidth: settings.format.maxLineWidth,
      quoteStyle: settings.format.quoteStyle,
      operatorStyle: settings.format.operatorStyle,
      commentStyle: settings.format.commentStyle,
      spaceInsideParens: settings.format.spaceInsideParens,
      keepSingleLineBlocks: settings.format.keepSingleLineBlocks,
      maxBlankLines: settings.format.maxBlankLines,
      semicolons: settings.format.semicolons,
    };

    if (root) {
      options = { ...options, ...readEditorConfig(root) };
      options = { ...options, ...readPrettierConfig(root) };
    }

    const fmt = this.sources?.format?.value;
    if (fmt) {
      const { overrides, $schema, ...direct } = fmt;
      void $schema;
      options = { ...options, ...defined(direct as Partial<FormatOptions>) };

      const relative = this.relative(fsPath);
      for (const override of overrides ?? []) {
        if (!override.files.some((pattern) => matchesGlob(pattern, relative))) continue;
        options = { ...options, ...defined(override.options) };
      }
    }

    this.formatCache.set(cacheKey, options);
    return { ...options, ...(endOfLine ? { endOfLine } : {}) };
  }

  /** Globals declared for this file by the project config. */
  globalsFor(fsPath: string): Set<string> {
    const cached = this.globalsCache.get(fsPath);
    if (cached) return cached;

    const config = this.sources?.lint?.value;
    const out = new Set<string>(config?.globals ?? []);
    if (config) {
      const relative = this.relative(fsPath);
      for (const override of config.overrides ?? []) {
        if (!override.files.some((pattern) => matchesGlob(pattern, relative))) continue;
        for (const name of override.globals ?? []) out.add(name);
      }
    }

    this.globalsCache.set(fsPath, out);
    return out;
  }
}
