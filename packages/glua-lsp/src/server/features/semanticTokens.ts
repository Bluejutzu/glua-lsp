import { SemanticTokensBuilder, type SemanticTokens, type SemanticTokensLegend } from 'vscode-languageserver';
import { walk } from '../../parser/ast.js';
import type { GmodApi } from '../../api/index.js';
import { HOOK_TABLES } from '../../api/index.js';
import type { FileAnalysis } from '../../analyze/binder.js';

export const TOKEN_TYPES = [
  'namespace',
  'class',
  'enumMember',
  'function',
  'method',
  'parameter',
  'variable',
  'property',
] as const;

export const TOKEN_MODIFIERS = [
  'declaration',
  'readonly',
  'deprecated',
  'defaultLibrary',
] as const;

export const LEGEND: SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS],
};

const T = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i])) as Record<
  (typeof TOKEN_TYPES)[number],
  number
>;

const M = {
  declaration: 1 << 0,
  readonly: 1 << 1,
  deprecated: 1 << 2,
  defaultLibrary: 1 << 3,
};

/**
 * Semantic highlighting driven by the real analysis: a library namespace, a
 * deprecated API call and a local variable all get distinct colours, which no
 * TextMate grammar can do.
 */
export function semanticTokens(analysis: FileAnalysis, api: GmodApi): SemanticTokens {
  const emitted = new Set<number>();
  // The builder needs tokens in document order, so collect then sort.
  const tokens: { start: number; length: number; type: number; modifiers: number }[] = [];

  const emit = (start: number, end: number, type: number, modifiers = 0) => {
    if (end <= start || emitted.has(start)) return;
    emitted.add(start);
    tokens.push({ start, length: end - start, type, modifiers });
  };

  // Declarations and every resolved reference to a local.
  for (const symbol of analysis.root.allDeclarations()) {
    const type =
      symbol.kind === 'param'
        ? T.parameter
        : symbol.type.kind === 'function'
          ? T.function
          : T.variable;
    const readonly = symbol.kind === 'self' || symbol.kind === 'loop' ? M.readonly : 0;

    emit(symbol.declStart, symbol.declEnd, type, M.declaration | readonly);
    for (const ref of symbol.refs) emit(ref.start, ref.end, type, readonly);
  }

  walk(analysis.chunk, (node) => {
    if (node.type === 'Identifier') {
      if (node.missing) return;
      // Locals were handled above; anything left is global-ish.
      if (analysis.scopeAt(node.start).lookup(node.name, node.start)) return;

      if (api.getLibrary(node.name)) {
        emit(node.start, node.end, T.namespace, M.defaultLibrary);
        return;
      }
      if (node.name in HOOK_TABLES) {
        emit(node.start, node.end, T.namespace, M.defaultLibrary | M.readonly);
        return;
      }
      const enumEntry = api.getEnum(node.name);
      if (enumEntry) {
        emit(node.start, node.end, T.enumMember, M.defaultLibrary | M.readonly);
        return;
      }
      const global = api.getGlobal(node.name);
      if (global) {
        emit(
          node.start,
          node.end,
          T.function,
          M.defaultLibrary | (global.deprecated || global.removed ? M.deprecated : 0),
        );
        return;
      }
      if (api.isClass(node.name)) {
        emit(node.start, node.end, T.class, M.defaultLibrary);
        return;
      }
      if (node.name === 'SERVER' || node.name === 'CLIENT' || node.name === 'MENU_DLL') {
        emit(node.start, node.end, T.variable, M.defaultLibrary | M.readonly);
      }
      return;
    }

    if (node.type === 'MemberExpression' && !node.identifier.missing) {
      const type = analysis.typeOf(node);
      const id = node.identifier;
      if (type.kind === 'function' && type.api) {
        emit(
          id.start,
          id.end,
          node.indexer === ':' ? T.method : T.function,
          M.defaultLibrary | (type.api.deprecated || type.api.removed ? M.deprecated : 0),
        );
      } else if (type.kind === 'function') {
        emit(id.start, id.end, node.indexer === ':' ? T.method : T.function);
      } else {
        emit(id.start, id.end, T.property);
      }
    }
  });

  const builder = new SemanticTokensBuilder();
  tokens.sort((a, b) => a.start - b.start);
  for (const token of tokens) {
    const position = analysis.lines.positionAt(token.start);
    builder.push(position.line, position.character, token.length, token.type, token.modifiers);
  }
  return builder.build();
}
