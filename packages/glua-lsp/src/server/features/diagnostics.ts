import {
  DiagnosticSeverity,
  DiagnosticTag,
  type Diagnostic,
} from 'vscode-languageserver';
import { walk, type CallExpression } from '../../parser/ast.js';
import { GmodApi } from '../../api/index.js';
import type { ApiFunction, ApiParam, Realm } from '../../api/types.js';
import type { FileAnalysis, Span } from '../../analyze/binder.js';
import { realmAt } from '../../analyze/realm.js';
import { Suppressions } from '../../analyze/suppressions.js';
import { isAssignable, fromApiType, typeToString } from '../../analyze/types.js';
import type { Workspace } from '../../analyze/workspace.js';
import { realmLabel } from '../render.js';
import { severityOf, type Settings } from '../settings.js';

export const SOURCE = 'glua';

/**
 * The wiki's coverage of the Lua/LuaJIT standard library is not precise enough
 * to check call shapes against: `table.insert` is documented only in its
 * three-argument form, `math.atan` only in its one-argument form, and both of
 * the omitted forms are everywhere in real code. Arity and type checks are
 * skipped for these libraries; they stay on for the Garry's Mod API, where the
 * documentation is accurate and the checks actually find bugs.
 */
const LUA_STDLIB = new Set([
  'string', 'table', 'math', 'os', 'io', 'coroutine', 'debug', 'bit', 'jit',
  'utf8', 'package',
]);

/** Codes are stable so users can disable individual rules from the UI. */
export const enum Code {
  Syntax = 'syntax',
  UndefinedGlobal = 'undefined-global',
  RealmViolation = 'realm-violation',
  UnusedLocal = 'unused-local',
  Deprecated = 'deprecated',
  ArgumentCount = 'argument-count',
  ArgumentType = 'argument-type',
  UnknownHook = 'unknown-hook',
  NetUnregistered = 'net-unregistered',
  NetNeverSent = 'net-never-sent',
  NetNeverReceived = 'net-never-received',
  NetNeverDispatched = 'net-never-dispatched',
  NetPayloadMismatch = 'net-payload-mismatch',
  MissingAddCSLuaFile = 'missing-addcsluafile',
  GlobalWrite = 'global-write',
  CompoundAssignment = 'compound-assignment',
  DuplicateHookIdentifier = 'duplicate-hook-identifier',
  DuplicateTimerName = 'duplicate-timer-name',
  MissingAsset = 'missing-asset',
}

export interface DiagnoseContext {
  /** Globals declared in the project config, e.g. an addon this depends on. */
  extraGlobals?: Set<string>;
}

export function diagnose(
  analysis: FileAnalysis,
  api: GmodApi,
  workspace: Workspace,
  settings: Settings,
  context: DiagnoseContext = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!settings.diagnostics.enable) return out;

  const suppressions = new Suppressions(analysis.comments, analysis.lines, analysis.text);

  const push = (
    span: Span,
    message: string,
    severity: DiagnosticSeverity | null,
    code: Code,
    extra: Partial<Diagnostic> = {},
  ) => {
    if (severity === null) return;
    const range = analysis.lines.rangeAt(span.start, span.end);
    if (suppressions.isSuppressed(code, range.start.line)) return;
    out.push({
      range,
      message,
      severity,
      code,
      source: SOURCE,
      ...extra,
    });
  };

  /* ----------------------------------------------------------- syntax */

  for (const error of analysis.parseErrors) {
    const isCompound = error.message.startsWith('Compound assignment');
    push(
      error,
      error.message,
      DiagnosticSeverity.Error,
      isCompound ? Code.CompoundAssignment : Code.Syntax,
    );
  }

  const d = settings.diagnostics;

  /* ---------------------------------------------------------- globals */

  if (d.undefinedGlobal !== 'off') {
    const severity = severityOf(d.undefinedGlobal);
    const reported = new Set<string>();
    for (const ref of analysis.globalRefs) {
      if (ref.write) continue;
      if (ref.path !== ref.root) continue; // only flag unknown roots, not fields
      if (api.isKnownGlobal(ref.root)) continue;
      if (workspace.isKnownGlobalPath(ref.root)) continue;
      if (context.extraGlobals?.has(ref.root)) continue;
      // `if someAddon and someAddon.Thing then` is how you depend on an
      // optional addon; do not punish it.
      if (analysis.guardedGlobals.has(ref.root)) continue;
      // Assigned anywhere in this file counts as defined.
      if (analysis.globalDefs.some((def) => def.root === ref.root)) continue;

      const key = `${ref.root}:${ref.span.start}`;
      if (reported.has(key)) continue;
      reported.add(key);

      push(
        ref.span,
        `'${ref.root}' is not defined anywhere in this workspace or the Garry's Mod API.`,
        severity,
        Code.UndefinedGlobal,
        { data: { name: ref.root } },
      );
    }
  }

  if (d.globalWrite !== 'off') {
    const severity = severityOf(d.globalWrite);
    for (const def of analysis.globalDefs) {
      if (def.path !== def.root) continue;
      push(
        def.nameSpan,
        `'${def.path}' is written as a global. Prefer 'local' to avoid leaking into _G.`,
        severity,
        Code.GlobalWrite,
        { data: { name: def.path } },
      );
    }
  }

  /* ----------------------------------------------------------- locals */

  if (d.unusedLocal !== 'off') {
    const severity = severityOf(d.unusedLocal);
    for (const symbol of analysis.unusedLocals) {
      push(
        { start: symbol.declStart, end: symbol.declEnd },
        `'${symbol.name}' is never read.`,
        severity,
        Code.UnusedLocal,
        { tags: [DiagnosticTag.Unnecessary], data: { name: symbol.name } },
      );
    }
  }

  /* ------------------------------------------------------------ calls */

  walk(analysis.chunk, (node) => {
    if (node.type !== 'CallExpression') return;
    checkCall(node as CallExpression);
  });

  function checkCall(call: CallExpression): void {
    const calleeType = analysis.typeOf(call.base);
    if (calleeType.kind !== 'function' || !calleeType.api) return;
    const fn = calleeType.api;

    const nameSpan =
      call.base.type === 'MemberExpression'
        ? { start: call.base.identifier.start, end: call.base.identifier.end }
        : { start: call.base.start, end: call.base.end };

    // Realm.
    if (d.realmViolation !== 'off') {
      const here = realmAt(analysis.realm, call.start);
      if (!GmodApi.realmAllows(here, fn.realm)) {
        // A cl_/sv_ prefix is a convention, not a guarantee — plenty of addons
        // include a cl_ file on both realms. Say so instead of crying wolf.
        const certain = analysis.realm.confidence === 'path';
        const severity = certain
          ? severityOf(d.realmViolation)
          : DiagnosticSeverity.Information;
        push(
          nameSpan,
          `'${fn.address}' only exists ${realmLabel(fn.realm)}-side, but this code runs ` +
            `${realmLabel(here)}-side (${analysis.realm.reason})` +
            (certain ? '. It will be nil here.' : '. Guard it with an if SERVER/CLIENT check if this file is shared.'),
          severity,
          Code.RealmViolation,
          { data: { address: fn.address, memberRealm: fn.realm, fileRealm: here } },
        );
      }
    }

    // Deprecated.
    if (d.deprecated !== 'off' && (fn.deprecated || fn.removed)) {
      const note = typeof fn.deprecated === 'string' ? ` ${fn.deprecated}` : '';
      push(
        nameSpan,
        `'${fn.address}' is ${fn.removed ? 'removed' : 'deprecated'}.${note}`,
        severityOf(d.deprecated),
        Code.Deprecated,
        { tags: [DiagnosticTag.Deprecated], data: { address: fn.address } },
      );
    }

    // Argument count and types, checked against every documented call form.
    const explicitSelf =
      (fn.kind === 'classfunc' || fn.kind === 'panelfunc') &&
      call.base.type === 'MemberExpression' &&
      call.base.indexer === '.';
    const args = explicitSelf ? call.args.slice(1) : call.args;

    const forms: ApiParam[][] = [fn.params, ...(fn.overloads ?? []).map((o) => o.params)];
    const trustSignature = !LUA_STDLIB.has(fn.parent);

    if (d.argumentCount !== 'off' && !call.unclosed && trustSignature) {
      // A trailing call or `...` expands to fill the remaining parameters.
      const lastArg = args[args.length - 1];
      const mayExpand = lastArg?.type === 'CallExpression' || lastArg?.type === 'VarargLiteral';

      const fits = forms.some((params) => countFits(args.length, params, mayExpand, fn.parent));
      if (!fits) {
        const required = requiredCount(fn.params);
        if (args.length < required) {
          const missing = fn.params.slice(args.length, required).map((p) => p.name || p.type);
          push(
            { start: call.argsStart, end: call.end },
            `'${fn.address}' expects ${required} argument${required === 1 ? '' : 's'}, got ${args.length}. ` +
              `Missing: ${missing.join(', ')}.`,
            severityOf(d.argumentCount),
            Code.ArgumentCount,
          );
        } else if (args.length > fn.params.length && args.length) {
          push(
            { start: args[Math.min(fn.params.length, args.length - 1)]!.start, end: args[args.length - 1]!.end },
            `'${fn.address}' takes at most ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, got ${args.length}.`,
            severityOf(d.argumentCount),
            Code.ArgumentCount,
          );
        }
      }
    }

    if (d.argumentType !== 'off' && trustSignature) {
      const severity = severityOf(d.argumentType);
      // Only complain when no documented form accepts what was passed.
      const candidates = forms.filter((params) => countFits(args.length, params, true, fn.parent));
      const checkAgainst = candidates.length ? candidates : [fn.params];

      args.forEach((arg, i) => {
        const actual = analysis.typeOf(arg);
        if (actual.kind === 'unknown' || actual.kind === 'nil') return;

        let sawTypedParam = false;
        const acceptable = checkAgainst.some((params) => {
          const param = params[i];
          if (!param || param.type === 'vararg') return true;
          const expected = fromApiType(param.type, api);
          if (expected.kind === 'unknown') return true;
          sawTypedParam = true;
          return isAssignable(actual, expected, api);
        });
        if (acceptable || !sawTypedParam) return;

        const param = checkAgainst[0]![i]!;
        push(
          arg,
          `'${param.name || `argument ${i + 1}`}' of '${fn.address}' expects ${param.type}, got ${typeToString(actual)}.`,
          severity,
          Code.ArgumentType,
        );
      });
    }

    checkHookCall(call, fn);
  }

  function requiredCount(params: ApiParam[]): number {
    return params.filter((p) => !p.optional && p.default === undefined && p.type !== 'vararg').length;
  }

  function countFits(count: number, params: ApiParam[], mayExpand: boolean, parent: string): boolean {
    if (LUA_STDLIB.has(parent)) return true;
    const required = requiredCount(params);
    if (count < required && !mayExpand) return false;
    if (params.some((p) => p.type === 'vararg' || p.name === '...')) return true;
    return count <= params.length;
  }

  /* ------------------------------------------------------------ hooks */

  function checkHookCall(call: CallExpression, fn: ApiFunction): void {
    if (fn.address !== 'hook.Add') return;
    const nameArg = call.args[0];
    const callback = call.args[2];
    if (nameArg?.type !== 'StringLiteral') return;

    const documented = api.getGlobalHook(nameArg.value);

    if (d.unknownHook !== 'off' && !documented) {
      const fired = workspace.customHookNames().has(nameArg.value);
      if (!fired) {
        push(
          { start: nameArg.start + 1, end: nameArg.end - 1 },
          `'${nameArg.value}' is not a documented gamemode hook, and nothing in this workspace ` +
            `fires it with hook.Run or hook.Call. Check for a typo.`,
          severityOf(d.unknownHook),
          Code.UnknownHook,
          { data: { name: nameArg.value } },
        );
      }
    }

    if (callback?.type !== 'FunctionExpression' || callback.isVararg) return;
    const declared = callback.params.length;

    if (documented) {
      const available = documented.params.length;
      if (declared > available) {
        push(
          { start: callback.params[available]!.start, end: callback.params[declared - 1]!.end },
          `'${nameArg.value}' passes ${available} argument${available === 1 ? '' : 's'} ` +
            `(${documented.params.map((p) => p.name).join(', ') || 'none'}), but this callback declares ${declared}.`,
          severityOf(d.argumentCount),
          Code.ArgumentCount,
        );
      }
      return;
    }

    // A hook of your own: every hook.Run for it is the documentation.
    const custom = workspace.customHookSignature(nameArg.value);
    if (!custom || declared <= custom.maxArity) return;

    // Call sites that disagree with each other are a weaker claim, so say what
    // was actually seen rather than asserting one arity.
    const spread = custom.minArity === custom.maxArity;
    push(
      { start: callback.params[custom.maxArity]!.start, end: callback.params[declared - 1]!.end },
      `Nothing passes this many arguments to '${nameArg.value}'. ` +
        (spread
          ? `Its ${custom.sites} call site${custom.sites === 1 ? '' : 's'} pass ${custom.maxArity}, ` +
            `but this callback declares ${declared}.`
          : `Its ${custom.sites} call sites pass between ${custom.minArity} and ${custom.maxArity}, ` +
            `but this callback declares ${declared}.`),
      severityOf(d.argumentCount),
      Code.ArgumentCount,
    );
  }

  /* ----------------------------------------------------------- assets */

  // Only ever runs with a game directory configured. Workspace content alone
  // cannot tell a typo from a base-game path, and every finding would be wrong.
  if (d.missingAsset !== 'off' && analysis.assets.length && workspace.assets().canValidate) {
    const assets = workspace.assets();
    const label: Record<string, string> = {
      material: 'Material',
      model: 'Model',
      sound: 'Sound',
    };

    for (const asset of analysis.assets) {
      // A path built at runtime is not something we can check.
      if (/[%{}]|\.\./.test(asset.path)) continue;
      if (assets.has(asset.kind, asset.path)) continue;

      push(
        { start: asset.span.start + 1, end: asset.span.end - 1 },
        `${label[asset.kind]} '${asset.path}' was not found in the workspace or the game ` +
          `directory. It will load as ${
            asset.kind === 'material'
              ? 'the missing-texture checkerboard'
              : asset.kind === 'model'
                ? 'the error model'
                : 'silence'
          } rather than raising an error.`,
        severityOf(d.missingAsset),
        Code.MissingAsset,
        { data: { kind: asset.kind, path: asset.path } },
      );
    }
  }

  /* -------------------------------------------------------------- net */

  if (d.netMessage !== 'off') {
    const severity = severityOf(d.netMessage);
    const registered = workspace.netRegistered();
    const receives = workspace.netReceives();
    const starts = workspace.netStarts();

    for (const start of analysis.netStarts) {
      if (!registered.has(start.name)) {
        push(
          { start: start.nameSpan.start + 1, end: start.nameSpan.end - 1 },
          `Net message '${start.name}' is never registered with util.AddNetworkString. ` +
            `net.Start will fail at runtime.`,
          severity,
          Code.NetUnregistered,
          { data: { name: start.name } },
        );
      }
      if (!receives.has(start.name)) {
        push(
          { start: start.nameSpan.start + 1, end: start.nameSpan.end - 1 },
          `Nothing calls net.Receive('${start.name}'), so this message is never handled.`,
          severity,
          Code.NetNeverReceived,
          { data: { name: start.name } },
        );
      }
      if (!start.dispatch) {
        push(
          start.span,
          `net.Start('${start.name}') is never followed by net.Send, net.Broadcast or ` +
            `net.SendToServer, so the message is never actually sent.`,
          severity,
          Code.NetNeverDispatched,
          { data: { name: start.name } },
        );
      }
    }

    for (const receive of analysis.netReceives) {
      if (!starts.has(receive.name)) {
        push(
          { start: receive.nameSpan.start + 1, end: receive.nameSpan.end - 1 },
          `Nothing calls net.Start('${receive.name}'), so this handler never runs.`,
          severity,
          Code.NetNeverSent,
          { data: { name: receive.name } },
        );
      }
    }
  }

  if (d.netReadWriteMismatch !== 'off') {
    const severity = severityOf(d.netReadWriteMismatch);
    for (const receive of analysis.netReceives) {
      if (!receive.reads.length) continue;
      const writes = findWriteSequence(workspace, receive.name);
      if (!writes || !writes.length) continue;

      const readPayloads = receive.reads.map((r) => r.payload);
      const writePayloads = writes.map((w) => w.payload);
      if (payloadsMatch(writePayloads, readPayloads)) continue;

      push(
        { start: receive.nameSpan.start + 1, end: receive.nameSpan.end - 1 },
        `Payload mismatch for '${receive.name}': sender writes ` +
          `[${writePayloads.join(', ')}] but this handler reads [${readPayloads.join(', ')}]. ` +
          `net reads must mirror the writes in order.`,
        severity,
        Code.NetPayloadMismatch,
        { data: { name: receive.name } },
      );
    }
  }

  /* ------------------------------------------- duplicate registrations */

  if (d.duplicateIdentifier !== 'off') {
    const severity = severityOf(d.duplicateIdentifier);
    const duplicates = workspace.duplicateRegistrations();

    // Two registrations in different realms never actually collide.
    const overlaps = (a: Realm, b: Realm) =>
      a === 'shared' || b === 'shared' || a === b;

    const report = (
      sites: { uri: string; value: { span: Span; realm: Realm } }[],
      describe: (others: number) => string,
      code: Code,
    ) => {
      const mine = sites.filter((s) => s.uri === analysis.uri);
      for (const site of mine) {
        const clashing = sites.filter(
          (other) => other !== site && overlaps(other.value.realm, site.value.realm),
        );
        if (!clashing.length) continue;
        push(
          { start: site.value.span.start + 1, end: site.value.span.end - 1 },
          describe(clashing.length),
          severity,
          code,
        );
      }
    };

    for (const [key, sites] of duplicates.hooks) {
      const [event, identifier] = key.split(' ');
      report(
        sites,
        (n) =>
          `'${identifier}' is already used as the identifier for '${event}' in ` +
          `${n} other place${n === 1 ? '' : 's'}. Only the last hook.Add wins; ` +
          `the others are silently replaced.`,
        Code.DuplicateHookIdentifier,
      );
    }

    for (const [name, sites] of duplicates.timers) {
      report(
        sites,
        (n) =>
          `A timer named '${name}' is created in ${n} other place${n === 1 ? '' : 's'}. ` +
          `timer.Create replaces an existing timer with the same name.`,
        Code.DuplicateTimerName,
      );
    }
  }

  /* ------------------------------------------------------ AddCSLuaFile */

  if (d.missingAddCSLuaFile !== 'off') {
    const severity = severityOf(d.missingAddCSLuaFile);
    const reachable = workspace.clientReachableFiles();

    for (const include of analysis.includes) {
      const target = workspace.resolveReference(analysis.fsPath, include.path);
      if (!target) continue;
      if (target.realm.file === 'server') continue;
      if (isEngineAutoloaded(target.fsPath)) continue;

      const key = target.fsPath.replace(/\\/g, '/').toLowerCase();
      if (reachable.has(key)) continue;

      push(
        include.span,
        `'${include.path}' runs ${realmLabel(target.realm.file)}-side but is never passed to ` +
          `AddCSLuaFile, so clients will never receive it.`,
        severity,
        Code.MissingAddCSLuaFile,
        { data: { path: include.path } },
      );
    }
  }

  return out;
}

/** Directories the engine networks to clients on its own. */
function isEngineAutoloaded(fsPath: string): boolean {
  const p = fsPath.replace(/\\/g, '/').toLowerCase();
  return /\/lua\/(autorun|entities|weapons|effects|vgui|postprocess|matproxy|skins)\//.test(p);
}

function findWriteSequence(workspace: Workspace, name: string) {
  for (const uri of workspace.uris()) {
    const start = workspace.get(uri)?.netStarts.find((s) => s.name === name && s.writes.length);
    if (start) return start.writes;
  }
  return null;
}

/**
 * Write/read payload names line up except for a few aliases the net library
 * treats as interchangeable. Anything else is a genuine mismatch.
 */
const PAYLOAD_ALIASES: Record<string, string> = {
  Int: 'Int',
  UInt: 'UInt',
  Double: 'Double',
  Float: 'Float',
  Bool: 'Bool',
  Bit: 'Bool',
  String: 'String',
  Data: 'Data',
  Entity: 'Entity',
  Player: 'Entity',
  Vector: 'Vector',
  Angle: 'Angle',
  Color: 'Color',
  Normal: 'Normal',
  Matrix: 'Matrix',
  Table: 'Table',
  Type: 'Type',
};

function payloadsMatch(writes: string[], reads: string[]): boolean {
  if (writes.length !== reads.length) return false;
  return writes.every((w, i) => {
    const a = PAYLOAD_ALIASES[w] ?? w;
    const b = PAYLOAD_ALIASES[reads[i]!] ?? reads[i]!;
    return a === b;
  });
}
