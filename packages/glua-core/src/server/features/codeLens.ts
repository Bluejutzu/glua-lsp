import type { CodeLens, Location } from 'vscode-languageserver';
import { walk } from '../../parser/ast.js';
import { exprToPath, type FileAnalysis } from '../../analyze/binder.js';
import type { Workspace } from '../../analyze/workspace.js';

/**
 * Counts above the things whose other half lives in another file.
 *
 * The workspace index already knows all of this; a lens puts it where you are
 * looking, instead of making you run find-references to discover that a handler
 * has no sender.
 */
export function codeLenses(analysis: FileAnalysis, workspace: Workspace): CodeLens[] {
  const lenses: CodeLens[] = [];

  const add = (offset: number, title: string, locations: Location[]) => {
    lenses.push({
      range: analysis.lines.rangeAt(offset, offset),
      command: {
        title,
        // Only offer navigation when there is somewhere to go.
        command: locations.length ? 'glua.showReferences' : '',
        ...(locations.length
          ? { arguments: [analysis.uri, analysis.lines.positionAt(offset), locations] }
          : {}),
      },
    });
  };

  const locationsFor = (
    pick: (file: FileAnalysis) => { start: number; end: number }[],
  ): Location[] => {
    const out: Location[] = [];
    for (const uri of workspace.uris()) {
      const file = workspace.get(uri);
      if (!file) continue;
      for (const span of pick(file)) {
        out.push({ uri: file.uri, range: file.lines.rangeAt(span.start, span.end) });
      }
    }
    return out;
  };

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  walk(analysis.chunk, (node) => {
    if (node.type !== 'CallExpression') return;
    const path = exprToPath(node.base);
    const first = node.args[0];
    if (!path || first?.type !== 'StringLiteral') return;

    const name = first.value;

    switch (path) {
      case 'net.Receive': {
        const senders = locationsFor((f) =>
          f.netStarts.filter((s) => s.name === name).map((s) => s.nameSpan),
        );
        add(node.start, senders.length ? plural(senders.length, 'sender') : 'never sent', senders);
        break;
      }

      case 'net.Start': {
        const handlers = locationsFor((f) =>
          f.netReceives.filter((r) => r.name === name).map((r) => r.nameSpan),
        );
        add(
          node.start,
          handlers.length ? plural(handlers.length, 'handler') : 'no handler',
          handlers,
        );
        break;
      }

      case 'hook.Add': {
        // Only meaningful for hooks this workspace fires itself; the engine
        // fires the documented ones and there is nothing to point at.
        const runs = workspace.customHookNames().get(name);
        if (!runs?.length) break;
        const locations = locationsFor((f) =>
          f.hookRuns.filter((r) => r.hookName === name).map((r) => r.nameSpan),
        );
        add(node.start, plural(runs.length, 'call site'), locations);
        break;
      }

      default:
        break;
    }
  });

  // Globals this file defines, and how much the rest of the workspace uses them.
  for (const def of analysis.globalDefs) {
    if (def.kind !== 'function') continue;
    const references = locationsFor((f) =>
      f.globalRefs.filter((r) => r.path === def.path && !r.write).map((r) => r.span),
    );
    add(
      def.span.start,
      references.length ? plural(references.length, 'reference') : 'unused in this workspace',
      references,
    );
  }

  return lenses;
}
