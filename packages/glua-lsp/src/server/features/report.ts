import type { Diagnostic } from 'vscode-languageserver';
import type { GmodApi } from '../../api/index.js';
import type { Realm } from '../../api/types.js';
import type { Workspace } from '../../analyze/workspace.js';
import type { Settings } from '../settings.js';
import { diagnose } from './diagnostics.js';

/**
 * A whole-project view, rather than the per-line one every other feature gives.
 *
 * Every number here comes from an index that already existed for some other
 * reason; nothing new is analysed. The point is the question it answers — "what
 * shape is this codebase in" — which no amount of squiggles adds up to.
 */

export interface Counted {
  name: string;
  count: number;
}

/**
 * A registration made twice.
 *
 * The index keys these by event and identifier joined with a NUL, because hook
 * names contain spaces themselves — `Org Clear` — so any printable separator
 * could make two different pairs look like the same key. That key is never fit
 * to show, so it is split back out here.
 */
export interface Collision {
  event: string;
  identifier: string;
  count: number;
}

/** The separator `duplicateRegistrations` composes its keys with. */
const KEY_SEPARATOR = '\0';

export interface FileSummary {
  file: string;
  lines: number;
  findings: number;
  globals: number;
  realm: Realm;
}

export interface ProjectReport {
  files: number;
  lines: number;
  /** Files indexed from a framework rather than written here. */
  libraryFiles: number;

  realms: Record<Realm, number>;

  net: {
    registered: number;
    senders: number;
    handlers: number;
    /** Registered and sent, but nothing listens. */
    unhandled: string[];
    /** Handled, but nothing sends it. */
    unsent: string[];
    /** Sent without ever being registered — a runtime failure. */
    unregistered: string[];
  };

  hooks: {
    custom: number;
    /** Custom hooks whose call sites gave the callback parameters a type. */
    typed: number;
    /** hook.Add pairs sharing an event and identifier in overlapping realms. */
    collisions: Collision[];
  };

  timers: { collisions: Counted[] };

  entities: {
    total: number;
    byKind: Record<string, number>;
    /** Biggest by what they define, which is where the complexity sits. */
    largest: { name: string; kind: string; members: number; files: number }[];
  };

  assets: { references: number; byKind: Record<string, number>; indexed: number };

  diagnostics: { total: number; byCode: Counted[] };

  /** Globals used but defined nowhere, which is usually a missing dependency. */
  undefinedGlobals: Counted[];

  worstFiles: FileSummary[];
}

export interface ReportOptions {
  settingsFor: (fsPath: string) => Settings;
  globalsFor?: (fsPath: string) => Set<string>;
  onProgress?: (done: number, total: number) => void;
  /** How many entries to keep in each "worst of" list. */
  top?: number;
}

const REALMS: Realm[] = ['client', 'server', 'shared', 'menu'];

export function buildReport(
  api: GmodApi,
  workspace: Workspace,
  options: ReportOptions,
): ProjectReport {
  const top = options.top ?? 10;

  const realms = Object.fromEntries(REALMS.map((r) => [r, 0])) as Record<Realm, number>;
  const byCode = new Map<string, number>();
  const undefinedNames = new Map<string, number>();
  const assetsByKind = new Map<string, number>();
  const files: FileSummary[] = [];

  let lines = 0;
  let assetReferences = 0;
  let totalFindings = 0;
  let ownFiles = 0;

  const uris = [...workspace.uris()];
  uris.forEach((uri, index) => {
    options.onProgress?.(index + 1, uris.length);
    if (workspace.isLibrary(uri)) return;

    const analysis = workspace.full(uri);
    if (!analysis) return;
    ownFiles++;

    const fileLines = analysis.lines.lineCount;
    lines += fileLines;
    realms[analysis.realm.file] = (realms[analysis.realm.file] ?? 0) + 1;

    for (const asset of analysis.assets) {
      assetReferences++;
      assetsByKind.set(asset.kind, (assetsByKind.get(asset.kind) ?? 0) + 1);
    }

    let found: Diagnostic[] = [];
    try {
      found = diagnose(analysis, api, workspace, options.settingsFor(analysis.fsPath), {
        ...(options.globalsFor ? { extraGlobals: options.globalsFor(analysis.fsPath) } : {}),
      });
    } catch {
      // A file that cannot be analysed should cost that file, not the report.
    }

    for (const diagnostic of found) {
      const code = String(diagnostic.code ?? 'unknown');
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      if (code === 'undefined-global') {
        const name = nameOf(diagnostic);
        if (name) undefinedNames.set(name, (undefinedNames.get(name) ?? 0) + 1);
      }
    }
    totalFindings += found.length;

    files.push({
      file: analysis.fsPath,
      lines: fileLines,
      findings: found.length,
      globals: analysis.globalDefs.length,
      realm: analysis.realm.file,
    });

    // The whole point is to look at everything, so nothing may be retained.
    workspace.releaseAst(uri);
  });

  return {
    files: ownFiles,
    lines,
    libraryFiles: workspace.libraryCount,
    realms,
    net: netHealth(workspace),
    hooks: hookHealth(api, workspace),
    timers: { collisions: collisionsOf(workspace.duplicateRegistrations().timers) },
    entities: entityHealth(workspace, top),
    assets: {
      references: assetReferences,
      byKind: Object.fromEntries(assetsByKind),
      indexed: workspace.assets().size,
    },
    diagnostics: {
      total: totalFindings,
      byCode: rank(byCode, Number.POSITIVE_INFINITY),
    },
    undefinedGlobals: rank(undefinedNames, top),
    worstFiles: files
      .sort((a, b) => b.findings - a.findings || b.lines - a.lines)
      .slice(0, top),
  };
}

/* ------------------------------------------------------------------- net */

function netHealth(workspace: Workspace): ProjectReport['net'] {
  const registered = workspace.netRegistered();
  const starts = workspace.netStarts();
  const receives = workspace.netReceives();

  const unhandled: string[] = [];
  const unsent: string[] = [];
  const unregistered: string[] = [];

  for (const name of starts.keys()) {
    if (!receives.has(name)) unhandled.push(name);
    if (!registered.has(name)) unregistered.push(name);
  }
  for (const name of receives.keys()) {
    if (!starts.has(name)) unsent.push(name);
  }

  return {
    registered: registered.size,
    senders: starts.size,
    handlers: receives.size,
    unhandled: unhandled.sort(),
    unsent: unsent.sort(),
    unregistered: unregistered.sort(),
  };
}

/* ----------------------------------------------------------------- hooks */

function hookHealth(api: GmodApi, workspace: Workspace): ProjectReport['hooks'] {
  let custom = 0;
  let typed = 0;

  for (const name of workspace.customHookNames().keys()) {
    if (api.getGlobalHook(name)) continue;
    custom++;
    const signature = workspace.customHookSignature(name);
    if (signature?.params.some((p) => p !== 'any')) typed++;
  }

  return {
    custom,
    typed,
    collisions: collisionsOf(workspace.duplicateRegistrations().hooks).map((clash) => {
      const at = clash.name.indexOf(KEY_SEPARATOR);
      return {
        event: at === -1 ? clash.name : clash.name.slice(0, at),
        identifier: at === -1 ? '' : clash.name.slice(at + 1),
        count: clash.count,
      };
    }),
  };
}

function collisionsOf(map: Map<string, { value: { realm: Realm } }[]>): Counted[] {
  const out: Counted[] = [];
  for (const [name, sites] of map) {
    // Two registrations in realms that never both run are not a clash.
    const overlapping = sites.filter((site) =>
      sites.some(
        (other) =>
          other !== site &&
          (other.value.realm === 'shared' ||
            site.value.realm === 'shared' ||
            other.value.realm === site.value.realm),
      ),
    );
    if (overlapping.length > 1) out.push({ name, count: overlapping.length });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------- entities */

function entityHealth(workspace: Workspace, top: number): ProjectReport['entities'] {
  const classes = workspace.scriptedClasses();
  const byKind = new Map<string, number>();
  const sized: ProjectReport['entities']['largest'] = [];

  for (const entry of classes.values()) {
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    sized.push({
      name: entry.name,
      kind: entry.kind,
      members:
        workspace.classMembers(entry.name).length + workspace.accessorsForClass(entry.name).length,
      files: entry.uris.length,
    });
  }

  return {
    total: classes.size,
    byKind: Object.fromEntries(byKind),
    largest: sized.sort((a, b) => b.members - a.members).slice(0, top),
  };
}

/* ----------------------------------------------------------------- utils */

function nameOf(diagnostic: Diagnostic): string | null {
  const data = diagnostic.data as { name?: string } | undefined;
  if (data?.name) return data.name;
  const message = typeof diagnostic.message === 'string' ? diagnostic.message : '';
  return /'([^']+)'/.exec(message)?.[1] ?? null;
}

function rank(counts: Map<string, number>, limit: number): Counted[] {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
