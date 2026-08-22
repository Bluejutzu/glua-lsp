import {
  SymbolKind,
  type DocumentSymbol,
  type WorkspaceSymbol,
} from 'vscode-languageserver';
import { walk } from '../../parser/ast.js';
import { exprToPath, type FileAnalysis, type Span } from '../../analyze/binder.js';
import type { Workspace } from '../../analyze/workspace.js';

interface Entry {
  name: string;
  detail: string;
  kind: SymbolKind;
  span: Span;
  selectionSpan: Span;
}

export function documentSymbols(analysis: FileAnalysis): DocumentSymbol[] {
  const entries: Entry[] = [];

  walk(analysis.chunk, (node) => {
    switch (node.type) {
      case 'FunctionDeclaration': {
        const name = node.identifier ? (exprToPath(node.identifier) ?? '<anonymous>') : '<anonymous>';
        const params = node.func.params
          .map((p) => (p.type === 'VarargLiteral' ? '...' : p.name))
          .join(', ');
        entries.push({
          name,
          detail: `(${params})`,
          kind: node.isLocal
            ? SymbolKind.Function
            : name.includes(':')
              ? SymbolKind.Method
              : SymbolKind.Function,
          span: { start: node.start, end: node.end },
          selectionSpan: node.identifier
            ? { start: node.identifier.start, end: node.identifier.end }
            : { start: node.start, end: node.start + 8 },
        });
        break;
      }

      case 'CallExpression': {
        const path = exprToPath(node.base);
        const first = node.args[0];
        if (!path || first?.type !== 'StringLiteral') break;

        if (path === 'hook.Add') {
          const id = node.args[1];
          entries.push({
            name: `hook ${first.value}`,
            detail: id?.type === 'StringLiteral' ? id.value : '',
            kind: SymbolKind.Event,
            span: { start: node.start, end: node.end },
            selectionSpan: { start: first.start, end: first.end },
          });
        } else if (path === 'net.Receive') {
          entries.push({
            name: `net ${first.value}`,
            detail: 'net.Receive',
            kind: SymbolKind.Event,
            span: { start: node.start, end: node.end },
            selectionSpan: { start: first.start, end: first.end },
          });
        } else if (path === 'concommand.Add') {
          entries.push({
            name: `cmd ${first.value}`,
            detail: 'concommand',
            kind: SymbolKind.Event,
            span: { start: node.start, end: node.end },
            selectionSpan: { start: first.start, end: first.end },
          });
        } else if (path === 'timer.Create') {
          entries.push({
            name: `timer ${first.value}`,
            detail: 'timer.Create',
            kind: SymbolKind.Event,
            span: { start: node.start, end: node.end },
            selectionSpan: { start: first.start, end: first.end },
          });
        }
        break;
      }

      default:
        break;
    }
  });

  // Global tables assigned at the top level, e.g. `MyAddon = MyAddon or {}`.
  for (const def of analysis.globalDefs) {
    if (def.kind !== 'table') continue;
    entries.push({
      name: def.path,
      detail: 'table',
      kind: SymbolKind.Namespace,
      span: def.span,
      selectionSpan: def.nameSpan,
    });
  }

  return nest(entries, analysis);
}

/** Turns a flat list into a tree by span containment. */
function nest(entries: Entry[], analysis: FileAnalysis): DocumentSymbol[] {
  const sorted = [...entries].sort((a, b) =>
    a.span.start - b.span.start || b.span.end - a.span.end,
  );

  const roots: DocumentSymbol[] = [];
  const stack: { entry: Entry; symbol: DocumentSymbol }[] = [];

  for (const entry of sorted) {
    const symbol: DocumentSymbol = {
      name: entry.name,
      detail: entry.detail,
      kind: entry.kind,
      range: analysis.lines.rangeAt(entry.span.start, entry.span.end),
      selectionRange: analysis.lines.rangeAt(entry.selectionSpan.start, entry.selectionSpan.end),
      children: [],
    };

    while (stack.length && stack[stack.length - 1]!.entry.span.end < entry.span.end) stack.pop();

    const parent = stack[stack.length - 1];
    if (parent && parent.entry.span.start <= entry.span.start && parent.entry.span.end >= entry.span.end) {
      parent.symbol.children!.push(symbol);
    } else {
      roots.push(symbol);
    }
    stack.push({ entry, symbol });
  }

  return roots;
}

export function workspaceSymbols(workspace: Workspace, query: string): WorkspaceSymbol[] {
  const needle = query.toLowerCase();
  const out: WorkspaceSymbol[] = [];

  for (const uri of workspace.uris()) {
    const file = workspace.get(uri);
    if (!file) continue;

    for (const symbol of file.symbols) {
      if (needle && !symbol.name.toLowerCase().includes(needle)) continue;
      out.push({
        name: symbol.name,
        kind:
          symbol.kind === 'function' || symbol.kind === 'method'
            ? SymbolKind.Function
            : symbol.kind === 'table'
              ? SymbolKind.Namespace
              : SymbolKind.Variable,
        location: {
          uri: file.uri,
          range: file.lines.rangeAt(symbol.selectionSpan.start, symbol.selectionSpan.end),
        },
        containerName: file.fsPath.split(/[\\/]/).pop(),
      });
      if (out.length >= 512) return out;
    }
  }

  return out;
}
