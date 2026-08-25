import {
  CodeActionKind,
  type CodeAction,
  type Diagnostic,
  type Range,
  type TextEdit,
} from 'vscode-languageserver';
import { nodePathAt, walk, type CallExpression } from '../../parser/ast.js';
import type { GmodApi } from '../../api/index.js';
import { exprToPath, type FileAnalysis } from '../../analyze/binder.js';
import type { Workspace } from '../../analyze/workspace.js';
import { Code } from './diagnostics.js';

export interface CodeActionDeps {
  api: GmodApi;
  workspace: Workspace;
}

/**
 * Whether a fix can be applied without someone looking at the result.
 *
 * `safe` means the code does the same thing afterwards. `unsafe` means it very
 * probably does what you wanted but the tool cannot promise it — the value now
 * evaluates at a different moment, or lands somewhere the tool had to guess.
 * Ruff's split, for the same reason: `glua lint --fix` writes files nobody is
 * watching, and the difference between "reformat this" and "change when this
 * runs" should not be invisible at that moment.
 */
export type FixSafety = 'safe' | 'unsafe';

/** Our own actions carry a safety marker; the protocol has nowhere for one. */
export interface GluaCodeAction extends CodeAction {
  data?: { safety?: FixSafety };
}

/** Reads the marker back off an action, defaulting to the cautious answer. */
export function safetyOf(action: CodeAction): FixSafety {
  const data = (action as GluaCodeAction).data;
  return data?.safety === 'safe' ? 'safe' : 'unsafe';
}

/** True for actions `--fix` may apply on its own. */
export function isAutoApplicable(action: CodeAction): boolean {
  return action.isPreferred === true && safetyOf(action) === 'safe';
}

export function codeActions(
  analysis: FileAnalysis,
  range: Range,
  diagnostics: Diagnostic[],
  deps: CodeActionDeps,
): GluaCodeAction[] {
  const actions: GluaCodeAction[] = [];
  const edit = (edits: TextEdit[]): CodeAction['edit'] => ({ changes: { [analysis.uri]: edits } });
  /**
   * Names already handed out by an action in this batch. `glua lint --fix`
   * applies every preferred action from one call together, so two hoists that
   * would both pick `mat_icon` have to be told about each other — otherwise the
   * file ends up with two declarations of that name and one call site reading
   * the wrong one.
   */
  const claimed = new Set<string>();

  for (const diagnostic of diagnostics) {
    switch (diagnostic.code) {
      case Code.CompoundAssignment:
        pushCompoundFix(analysis, diagnostic, actions);
        break;

      case Code.UnusedLocal: {
        const name = (diagnostic.data as { name?: string })?.name;
        if (!name || name.startsWith('_')) break;
        actions.push({
          title: `Rename '${name}' to '_${name}' to mark it intentionally unused`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: edit([{ range: diagnostic.range, newText: `_${name}` }]),
        });
        break;
      }

      case Code.NetUnregistered: {
        const name = (diagnostic.data as { name?: string })?.name;
        if (!name) break;
        // The insert goes to the top of the file, above any realm guard. In a
        // server file that is where it belongs; anywhere else it may end up
        // running clientside, where util.AddNetworkString does not exist.
        const serverside = analysis.realm.file === 'server';
        actions.push({
          title: `Add util.AddNetworkString("${name}")`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          diagnostics: [diagnostic],
          data: { safety: serverside ? 'safe' : 'unsafe' },
          edit: edit([insertAtTop(analysis, `util.AddNetworkString("${name}")\n`)]),
        });
        break;
      }

      case Code.NetNeverReceived: {
        const name = (diagnostic.data as { name?: string })?.name;
        if (!name) break;
        actions.push({
          title: `Add a net.Receive("${name}") handler at the end of this file`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: edit([
            insertAtEnd(
              analysis,
              `\nnet.Receive("${name}", function(len, ply)\n\t\nend)\n`,
            ),
          ]),
        });
        break;
      }

      case Code.MissingAddCSLuaFile: {
        const path = (diagnostic.data as { path?: string })?.path;
        if (!path) break;
        const line = diagnostic.range.start.line;
        const indent = analysis.lines.lineText(line).match(/^[ \t]*/)?.[0] ?? '';
        actions.push({
          title: `Add AddCSLuaFile("${path}") above this include`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          // Shared, idempotent, and a no-op clientside: nothing to get wrong.
          data: { safety: 'safe' },
          diagnostics: [diagnostic],
          edit: edit([
            {
              range: {
                start: { line, character: 0 },
                end: { line, character: 0 },
              },
              newText: `${indent}AddCSLuaFile("${path}")\n`,
            },
          ]),
        });
        break;
      }

      case Code.RealmViolation: {
        const data = diagnostic.data as { memberRealm?: string } | undefined;
        const guard = data?.memberRealm === 'server' ? 'SERVER' : 'CLIENT';
        const statement = statementRangeAt(analysis, diagnostic.range);
        if (!statement) break;
        const indent = analysis.lines.lineText(statement.start.line).match(/^[ \t]*/)?.[0] ?? '';
        const body = analysis.text.slice(
          analysis.lines.offsetAt(statement.start),
          analysis.lines.offsetAt(statement.end),
        );
        actions.push({
          title: `Wrap in 'if ${guard} then ... end'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: edit([
            {
              range: statement,
              newText: `if ${guard} then\n${indent}\t${body}\n${indent}end`,
            },
          ]),
        });
        break;
      }

      case Code.PerfHotPath: {
        const data = diagnostic.data as { callee?: string; hoistable?: boolean } | undefined;
        if (!data?.hoistable || !data.callee) break;
        pushHoistAction(analysis, diagnostic, data.callee, actions, edit, claimed);
        break;
      }

      case Code.UnknownHook: {
        const name = (diagnostic.data as { name?: string })?.name;
        if (!name) break;
        for (const suggestion of nearestHookNames(name, deps.api)) {
          actions.push({
            title: `Change to "${suggestion}"`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: edit([{ range: diagnostic.range, newText: suggestion }]),
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // Refactors offered on selection, not tied to a diagnostic.
  pushLocaliseAction(analysis, range, actions);
  pushCStyleRewrite(analysis, actions);

  pushFixAll(analysis, actions);

  return actions;
}

/**
 * One action that applies every safe fix in the file.
 *
 * This is what an editor runs on save under `source.fixAll`, and it is exactly
 * the set `glua lint --fix` writes — an editor and a pre-commit hook disagreeing
 * about what "fix it" means is a diff nobody asked for. Unsafe fixes are left
 * for someone to choose one at a time, with the result in front of them, and
 * the C-style rewrite stays out of it: `!=` is valid GLua, so rewriting it is a
 * preference rather than a fix, and preferences do not get applied on save.
 */
function pushFixAll(analysis: FileAnalysis, actions: GluaCodeAction[]): void {
  const applicable = actions.filter(isAutoApplicable);
  if (!applicable.length) return;

  const merged = mergeEdits(applicable, analysis.uri);
  if (!merged.edits.length) return;

  const count = merged.actions.length;
  actions.push({
    title: `Fix all ${count} auto-fixable problem${count === 1 ? '' : 's'}`,
    kind: CodeActionKind.SourceFixAll,
    data: { safety: 'safe' },
    edit: { changes: { [analysis.uri]: merged.edits } },
  });
}

/**
 * The edits from a batch of actions, deduplicated, and the actions that
 * actually contributed one.
 *
 * Two findings for the same unregistered net message each ask for the same
 * insertion at the top of the file; applying both writes the line twice, and
 * counting both reports two fixes where one line was written. Shared with the
 * CLI so `--fix` and `source.fixAll` cannot drift apart.
 */
export function mergeEdits<T extends CodeAction>(
  actions: T[],
  uri: string,
): { edits: TextEdit[]; actions: T[] } {
  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  const contributing: T[] = [];

  for (const action of actions) {
    let contributed = false;
    for (const edit of action.edit?.changes?.[uri] ?? []) {
      const { start, end } = edit.range;
      const key = `${start.line}:${start.character}:${end.line}:${end.character}:${edit.newText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push(edit);
      contributed = true;
    }
    if (contributed) contributing.push(action);
  }

  return { edits, actions: contributing };
}

/* ----------------------------------------------------------- hoisting */

/** Short prefix for the local a hoisted call is bound to. */
const HOIST_PREFIX: Record<string, string> = {
  Material: 'mat',
  'surface.GetTextureID': 'tex',
};

/**
 * Lifts `Material("icon16/cog.png")` out of a render path and points the call
 * site at a local instead.
 *
 * Only offered when every argument is a literal. Anything else — a variable, a
 * concatenation, a call — may differ between runs, and hoisting it would change
 * what the code does rather than how often it does it.
 *
 * The local goes immediately above the statement that *writes* the function,
 * not at the top of the file. A shared file often opens with a realm guard
 * (`if SERVER then return end`), and a clientside call hoisted above one runs
 * on the server, where the library it belongs to does not exist. Staying in the
 * call site's own block keeps every guard around it intact, and still gets the
 * work out of the frame.
 */
function pushHoistAction(
  analysis: FileAnalysis,
  diagnostic: Diagnostic,
  callee: string,
  actions: CodeAction[],
  edit: (edits: TextEdit[]) => CodeAction['edit'],
  claimed: Set<string>,
): void {
  const offset = analysis.lines.offsetAt(diagnostic.range.start);
  const call = callAt(analysis, offset);
  if (!call || !call.args.length) return;

  const literal = call.args.every(
    (arg) =>
      arg.type === 'StringLiteral' ||
      arg.type === 'NumberLiteral' ||
      arg.type === 'BooleanLiteral',
  );
  if (!literal) return;

  const first = call.args[0];
  if (first?.type !== 'StringLiteral') return;

  const anchor = hoistAnchor(analysis, call.start);
  if (anchor === null) return;

  const site = analysis.lines.rangeAt(call.start, call.end);
  const anchorLine = analysis.lines.lineOf(anchor);
  // A closure only captures a local declared above it, so anything else is
  // not a hoist.
  if (anchorLine >= site.start.line) return;

  const name = freeName(analysis, `${HOIST_PREFIX[callee] ?? 'cached'}_${slug(first.value)}`, claimed);
  claimed.add(name);
  const source = analysis.text.slice(call.start, call.end);
  const indent = analysis.lines.lineText(anchorLine).match(/^[ \t]*/)?.[0] ?? '';

  actions.push({
    title: `Hoist into a local '${name}'`,
    kind: CodeActionKind.QuickFix,
    isPreferred: true,
    // Unsafe by definition: the call now runs when the file loads rather than
    // when the frame draws. Almost always what you want, and not something to
    // do to someone's file while they are not looking.
    data: { safety: 'unsafe' },
    diagnostics: [diagnostic],
    edit: edit([
      {
        range: {
          start: { line: anchorLine, character: 0 },
          end: { line: anchorLine, character: 0 },
        },
        newText: `${indent}local ${name} = ${source}\n`,
      },
      { range: site, newText: name },
    ]),
  });
}

/**
 * Where a hoisted local can go: the start of the statement that contains the
 * outermost function body the call sits inside.
 *
 * That is as far out as the value can move without leaving a block — and so
 * without escaping an `if CLIENT then` or an early-returning realm guard — but
 * still outside every function that runs repeatedly. Returns null when the call
 * is not inside a function at all, since then there is nothing to hoist out of.
 */
function hoistAnchor(analysis: FileAnalysis, offset: number): number | null {
  // Root first, so the first function body found is the outermost one.
  const path = nodePathAt(analysis.chunk, offset).reverse();
  let statement: number | null = null;
  for (const node of path) {
    if (node.type === 'FunctionExpression') return statement;
    if (STATEMENTS.has(node.type)) statement = node.start;
  }
  return null;
}

/** Node types that can carry a `local` declaration beside them in a block. */
const STATEMENTS = new Set([
  'LocalStatement', 'AssignmentStatement', 'CallStatement', 'DoStatement',
  'WhileStatement', 'RepeatStatement', 'IfStatement', 'NumericForStatement',
  'GenericForStatement', 'FunctionDeclaration', 'ReturnStatement',
]);

/** `materials/icon16/cog.png` -> `cog`, and never something Lua would reject. */
function slug(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const cleaned = base.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9]+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '').slice(0, 24);
  return /^[A-Za-z_]/.test(trimmed) ? trimmed : `_${trimmed}`;
}

/** A name neither the file nor another action in this batch is using. */
function freeName(analysis: FileAnalysis, base: string, claimed: Set<string>): string {
  const taken = (name: string) =>
    claimed.has(name) ||
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(analysis.text);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken(`${base}_${i}`)) return `${base}_${i}`;
  }
  return `${base}_x`;
}

/** Innermost call expression starting at an offset. */
function callAt(analysis: FileAnalysis, offset: number): CallExpression | null {
  let found: CallExpression | null = null;
  walk(analysis.chunk, (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.start !== offset) return;
    found = node;
  });
  return found;
}

/* -------------------------------------------------------------- helpers */

function insertAtTop(analysis: FileAnalysis, text: string): TextEdit {
  // Below any leading comment block, so the file header stays first.
  let line = 0;
  while (line < analysis.lines.lineCount) {
    const trimmed = analysis.lines.lineText(line).trim();
    if (trimmed === '' || trimmed.startsWith('--') || trimmed.startsWith('//')) {
      line++;
      continue;
    }
    break;
  }
  return {
    range: { start: { line, character: 0 }, end: { line, character: 0 } },
    newText: text,
  };
}

function insertAtEnd(analysis: FileAnalysis, text: string): TextEdit {
  const line = Math.max(0, analysis.lines.lineCount - 1);
  const character = analysis.lines.lineText(line).length;
  return { range: { start: { line, character }, end: { line, character } }, newText: text };
}

/** The full line range of the statement covering `range`. */
function statementRangeAt(analysis: FileAnalysis, range: Range): Range | null {
  const offset = analysis.lines.offsetAt(range.start);
  let best: { start: number; end: number } | null = null;
  walk(analysis.chunk, (node) => {
    switch (node.type) {
      case 'CallStatement':
      case 'LocalStatement':
      case 'AssignmentStatement':
        if (node.start <= offset && offset <= node.end) {
          if (!best || node.start > best.start) best = { start: node.start, end: node.end };
        }
        break;
      default:
        break;
    }
  });
  if (!best) return null;
  const found = best as { start: number; end: number };
  return analysis.lines.rangeAt(found.start, found.end);
}

function pushCompoundFix(
  analysis: FileAnalysis,
  diagnostic: Diagnostic,
  actions: CodeAction[],
): void {
  const offset = analysis.lines.offsetAt(diagnostic.range.start);
  walk(analysis.chunk, (node) => {
    if (node.type !== 'AssignmentStatement' || !node.compoundOperator) return;
    if (offset < node.start || offset > node.end) return;
    const target = node.targets[0];
    const value = node.init[0];
    if (!target || !value) return;

    const targetText = analysis.text.slice(target.start, target.end);
    const valueText = analysis.text.slice(value.start, value.end);
    const operator = node.compoundOperator!;
    // Concatenation and comparison bind loosely; parenthesise to be safe.
    const rhs = value.type === 'BinaryExpression' ? `(${valueText})` : valueText;

    actions.push({
      title: `Rewrite as '${targetText} = ${targetText} ${operator} ...'`,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      // The file does not parse as written, so this changes nothing that ran.
      data: { safety: 'safe' },
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [analysis.uri]: [
            {
              range: analysis.lines.rangeAt(node.start, node.end),
              newText: `${targetText} = ${targetText} ${operator} ${rhs}`,
            },
          ],
        },
      },
    });
  });
}

/** `math.floor` used repeatedly -> hoist to a local at the top of the file. */
function pushLocaliseAction(analysis: FileAnalysis, range: Range, actions: CodeAction[]): void {
  const offset = analysis.lines.offsetAt(range.start);
  let target: { path: string; local: string } | null = null;
  let uses = 0;

  walk(analysis.chunk, (node) => {
    if (node.type !== 'MemberExpression' || node.indexer !== '.') return;
    const path = exprToPath(node);
    if (!path || path.includes(':')) return;
    if (node.start <= offset && offset <= node.end && !target) {
      target = { path, local: path.replace(/\./g, '_') };
    }
  });

  if (!target) return;
  const found = target as { path: string; local: string };

  walk(analysis.chunk, (node) => {
    if (node.type === 'MemberExpression' && exprToPath(node) === found.path) uses++;
  });
  if (uses < 2) return;

  const edits: TextEdit[] = [insertAtTop(analysis, `local ${found.local} = ${found.path}\n`)];
  walk(analysis.chunk, (node) => {
    if (node.type === 'MemberExpression' && exprToPath(node) === found.path) {
      edits.push({ range: analysis.lines.rangeAt(node.start, node.end), newText: found.local });
    }
  });

  actions.push({
    title: `Localise '${found.path}' (${uses} uses) as 'local ${found.local}'`,
    kind: CodeActionKind.RefactorExtract,
    edit: { changes: { [analysis.uri]: edits } },
  });
}

/** Rewrites GLua's C-style operators to standard Lua, document-wide. */
function pushCStyleRewrite(analysis: FileAnalysis, actions: CodeAction[]): void {
  const edits: TextEdit[] = [];

  walk(analysis.chunk, (node) => {
    if (node.type === 'BinaryExpression') {
      const replacement =
        node.operatorText === '!=' ? '~=' :
        node.operatorText === '&&' ? 'and' :
        node.operatorText === '||' ? 'or' : null;
      if (!replacement) return;
      const start = analysis.text.indexOf(node.operatorText, node.left.end);
      if (start === -1 || start > node.right.start) return;
      edits.push({
        range: analysis.lines.rangeAt(start, start + node.operatorText.length),
        newText: replacement,
      });
    } else if (node.type === 'UnaryExpression' && node.operatorText === '!') {
      edits.push({
        range: analysis.lines.rangeAt(node.start, node.start + 1),
        newText: 'not ',
      });
    }
  });

  if (!edits.length) return;

  actions.push({
    title: `Convert ${edits.length} C-style operator${edits.length === 1 ? '' : 's'} to Lua (!= && || !)`,
    // Offered from the lightbulb, and folded into `source.fixAll` below. Not a
    // `source.fixAll` action in its own right: two of those both claiming the
    // whole document is how an editor applies overlapping edits on save.
    kind: CodeActionKind.RefactorRewrite,
    // A spelling change: `!=` and `~=` are the same operator to the parser.
    data: { safety: 'safe' },
    edit: { changes: { [analysis.uri]: edits } },
  });
}

/** Cheap edit-distance suggestions for a mistyped hook name. */
function nearestHookNames(name: string, api: GmodApi): string[] {
  const scored: { name: string; distance: number }[] = [];
  for (const candidate of api.globalHookNames()) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(name.length / 4))) {
      scored.push({ name: candidate, distance });
    }
  }
  return scored.sort((a, b) => a.distance - b.distance).slice(0, 3).map((s) => s.name);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  return previous[b.length]!;
}
