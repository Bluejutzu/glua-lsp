import {
  CodeActionKind,
  type CodeAction,
  type Diagnostic,
  type Range,
  type TextEdit,
} from 'vscode-languageserver';
import { walk } from '../../parser/ast.js';
import type { GmodApi } from '../../api/index.js';
import { exprToPath, type FileAnalysis } from '../../analyze/binder.js';
import type { Workspace } from '../../analyze/workspace.js';
import { Code } from './diagnostics.js';

export interface CodeActionDeps {
  api: GmodApi;
  workspace: Workspace;
}

export function codeActions(
  analysis: FileAnalysis,
  range: Range,
  diagnostics: Diagnostic[],
  deps: CodeActionDeps,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const edit = (edits: TextEdit[]): CodeAction['edit'] => ({ changes: { [analysis.uri]: edits } });

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
        actions.push({
          title: `Add util.AddNetworkString("${name}")`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          diagnostics: [diagnostic],
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

  return actions;
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
    kind: CodeActionKind.SourceFixAll,
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
