import type { Diagnostic } from 'vscode-languageserver';
import type { GmodApi } from '../../api/index.js';
import type { Realm } from '../../api/types.js';
import type { Workspace } from '../../analyze/workspace.js';
import type { Settings } from '../settings.js';
import { entryLabel } from '../../analyze/hotpath.js';
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

  /**
   * What the engine ends up running on a schedule. Distinct from the rest of
   * the report, which is about whether the code is right: this is about whether
   * the server keeps its tick rate.
   */
  performance: {
    /** Functions registered somewhere that runs them every frame or tick. */
    entryPoints: number;
    /** Expensive calls reachable from one of them. */
    findings: number;
    /** Which expensive calls turn up most often on those paths. */
    byCall: Counted[];
    /** The ones furthest from their entry point, which are the easiest to miss. */
    worst: {
      file: string;
      line: number;
      callee: string;
      entry: string;
      chain: string[];
      advice: string;
    }[];
  };

  /** Functions defined here that nothing here ever names. */
  deadCode: {
    total: number;
    functions: { file: string; line: number; path: string }[];
  };

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
  /** 0 never yields, for a caller that owns its thread. */
  yieldEvery?: number;
}

const REALMS: Realm[] = ['client', 'server', 'shared', 'menu'];

/**
 * @param yieldEvery Files to process between handing the event loop back. The
 * server shares a thread with everything else it answers, so a report over a
 * large workspace must not hold it for the whole scan.
 */
export async function buildReport(
  api: GmodApi,
  workspace: Workspace,
  options: ReportOptions,
): Promise<ProjectReport> {
  const top = options.top ?? 10;
  const yieldEvery = options.yieldEvery ?? 25;

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
  for (const [index, uri] of uris.entries()) {
    options.onProgress?.(index + 1, uris.length);
    if (yieldEvery > 0 && index > 0 && index % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (workspace.isLibrary(uri)) continue;

    const analysis = workspace.full(uri);
    if (!analysis) continue;
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
  }

  return {
    files: ownFiles,
    lines,
    libraryFiles: workspace.libraryCount,
    realms,
    net: netHealth(workspace),
    hooks: hookHealth(api, workspace),
    timers: { collisions: collisionsOf(workspace.duplicateRegistrations().timers, workspace) },
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
    performance: performanceHealth(workspace, top),
    deadCode: deadCodeHealth(workspace, top),
    undefinedGlobals: rank(undefinedNames, top),
    worstFiles: files
      .sort((a, b) => b.findings - a.findings || b.lines - a.lines)
      .slice(0, top),
  };
}

/* --------------------------------------------------------------- filters */

/**
 * Names this project itself contributes to.
 *
 * The cross-file indexes cover libraries too, on purpose — a message your code
 * sends and ULib handles has to resolve. But a report describes *your* project,
 * so a net message or hook living entirely inside a dependency is not yours to
 * count.
 */
function ownNames<T>(
  index: Map<string, { uri: string; value: T }[]>,
  workspace: Workspace,
): Set<string> {
  const out = new Set<string>();
  for (const [name, sites] of index) {
    if (sites.some((site) => !workspace.isLibrary(site.uri))) out.add(name);
  }
  return out;
}

/* ------------------------------------------------------------------- net */

function netHealth(workspace: Workspace): ProjectReport['net'] {
  const registered = ownNames(workspace.netRegistered(), workspace);
  const starts = ownNames(workspace.netStarts(), workspace);
  // A handler is a real handler wherever it lives: if a dependency listens for
  // a message you send, that message is handled.
  const anyReceives = workspace.netReceives();
  const anyRegisters = workspace.netRegistered();

  const unhandled: string[] = [];
  const unsent: string[] = [];
  const unregistered: string[] = [];

  for (const name of starts) {
    if (!anyReceives.has(name)) unhandled.push(name);
    if (!anyRegisters.has(name)) unregistered.push(name);
  }
  for (const name of ownNames(anyReceives, workspace)) {
    if (!workspace.netStarts().has(name)) unsent.push(name);
  }

  return {
    registered: registered.size,
    senders: starts.size,
    handlers: ownNames(anyReceives, workspace).size,
    unhandled: unhandled.sort(),
    unsent: unsent.sort(),
    unregistered: unregistered.sort(),
  };
}

/* ----------------------------------------------------------------- hooks */

function hookHealth(api: GmodApi, workspace: Workspace): ProjectReport['hooks'] {
  let custom = 0;
  let typed = 0;

  for (const name of ownNames(workspace.customHookNames(), workspace)) {
    if (api.getGlobalHook(name)) continue;
    custom++;
    const signature = workspace.customHookSignature(name);
    if (signature?.params.some((p) => p !== 'any')) typed++;
  }

  return {
    custom,
    typed,
    collisions: collisionsOf(workspace.duplicateRegistrations().hooks, workspace).map((clash) => {
      const at = clash.name.indexOf(KEY_SEPARATOR);
      return {
        event: at === -1 ? clash.name : clash.name.slice(0, at),
        identifier: at === -1 ? '' : clash.name.slice(at + 1),
        count: clash.count,
      };
    }),
  };
}

function collisionsOf(
  map: Map<string, { uri: string; value: { realm: Realm } }[]>,
  workspace: Workspace,
): Counted[] {
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
    // A clash entirely inside a dependency is that dependency's problem, and
    // nothing you could do about it belongs in your report.
    if (overlapping.length > 1 && overlapping.some((site) => !workspace.isLibrary(site.uri))) {
      out.push({ name, count: overlapping.length });
    }
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------- entities */

function entityHealth(workspace: Workspace, top: number): ProjectReport['entities'] {
  const classes = workspace.scriptedClasses();
  const byKind = new Map<string, number>();
  const sized: ProjectReport['entities']['largest'] = [];

  for (const entry of classes.values()) {
    // A dependency's own entities are not this project's classes.
    if (entry.uris.every((uri) => workspace.isLibrary(uri))) continue;
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
    total: sized.length,
    byKind: Object.fromEntries(byKind),
    largest: sized.sort((a, b) => b.members - a.members).slice(0, top),
  };
}

/* ----------------------------------------------------------- performance */

function performanceHealth(workspace: Workspace, top: number): ProjectReport['performance'] {
  const findings = workspace.hotPaths().filter((f) => !workspace.isLibrary(f.uri));
  const byCall = new Map<string, number>();
  for (const finding of findings) {
    byCall.set(finding.callee, (byCall.get(finding.callee) ?? 0) + 1);
  }

  const entryPoints = workspace
    .calls()
    .entryPoints()
    .filter((seed) => !workspace.isLibrary(seed.ref.uri)).length;

  const worst = [...findings]
    .sort((a, b) => b.chain.length - a.chain.length)
    .slice(0, top)
    .map((finding) => ({
      file: workspace.get(finding.uri)?.fsPath ?? finding.uri,
      line: (workspace.get(finding.uri)?.lines.lineOf(finding.span.start) ?? 0) + 1,
      callee: finding.callee,
      entry: entryLabel(finding.entry),
      chain: finding.chain,
      advice: finding.rule.advice,
    }));

  return { entryPoints, findings: findings.length, byCall: rank(byCall, top), worst };
}

/* -------------------------------------------------------------- dead code */

function deadCodeHealth(workspace: Workspace, top: number): ProjectReport['deadCode'] {
  const dead = workspace.deadFunctions();
  return {
    total: dead.length,
    functions: dead
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, top)
      .map((fn) => ({
        file: workspace.get(fn.uri)?.fsPath ?? fn.uri,
        line: (workspace.get(fn.uri)?.lines.lineOf(fn.nameSpan.start) ?? 0) + 1,
        path: fn.path,
      })),
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
