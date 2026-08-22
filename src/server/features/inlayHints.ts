import { InlayHintKind, type InlayHint, type Range } from 'vscode-languageserver';
import { walk } from '../../parser/ast.js';
import type { FileAnalysis } from '../../analyze/binder.js';
import { realmLabel } from '../render.js';
import type { Settings } from '../settings.js';

export function inlayHints(
  analysis: FileAnalysis,
  range: Range,
  settings: Settings,
): InlayHint[] {
  const hints: InlayHint[] = [];
  const from = analysis.lines.offsetAt(range.start);
  const to = analysis.lines.offsetAt(range.end);

  if (settings.inlayHints.realm && from === 0) {
    const realm = analysis.realm;
    hints.push({
      position: { line: 0, character: 0 },
      label: ` ${realmLabel(realm.file)} · ${realm.kind} — ${realm.reason} `,
      paddingRight: true,
      kind: InlayHintKind.Type,
    });
  }

  if (!settings.inlayHints.parameterNames) return hints;

  walk(analysis.chunk, (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.end < from || node.start > to) return;
    if (node.argStyle !== 'paren') return;

    const calleeType = analysis.typeOf(node.base);
    if (calleeType.kind !== 'function' || !calleeType.api) return;

    const explicitSelf =
      (calleeType.api.kind === 'classfunc' || calleeType.api.kind === 'panelfunc') &&
      node.base.type === 'MemberExpression' &&
      node.base.indexer === '.';
    const offset = explicitSelf ? 1 : 0;

    node.args.forEach((arg, i) => {
      const param = calleeType.api!.params[i - offset];
      if (!param?.name || param.type === 'vararg') return;
      // A variable already named after the parameter needs no hint.
      if (arg.type === 'Identifier' && arg.name.toLowerCase() === param.name.toLowerCase()) return;
      if (arg.type === 'FunctionExpression' || arg.type === 'TableConstructor') return;
      if (arg.start < from || arg.end > to) return;

      hints.push({
        position: analysis.lines.positionAt(arg.start),
        label: `${param.name}:`,
        kind: InlayHintKind.Parameter,
        paddingRight: true,
        tooltip: param.description,
      });
    });
  });

  return hints;
}
