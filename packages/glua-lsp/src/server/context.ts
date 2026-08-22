import { nodePathAt, type CallExpression, type Expression, type Node, type StringLiteral } from '../parser/ast.js';
import { exprToPath, type FileAnalysis } from '../analyze/binder.js';
import { UNKNOWN, type GType } from '../analyze/types.js';

export interface MemberContext {
  kind: 'member';
  indexer: '.' | ':';
  base: Expression | null;
  baseType: GType;
  /** Dotted path of the base, when it is a plain identifier chain. */
  basePath: string | null;
  prefix: string;
  replaceStart: number;
}

export interface IdentifierContext {
  kind: 'identifier';
  prefix: string;
  replaceStart: number;
}

export interface StringContext {
  kind: 'string';
  callPath: string | null;
  argIndex: number;
  prefix: string;
  replaceStart: number;
  replaceEnd: number;
}

export type CompletionContext = MemberContext | IdentifierContext | StringContext;

const isNamePart = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** The innermost string literal containing `offset`, if the cursor is inside one. */
function stringLiteralAt(analysis: FileAnalysis, offset: number): StringLiteral | null {
  const path = nodePathAt(analysis.chunk, offset);
  for (const node of path) {
    if (node.type === 'StringLiteral' && offset > node.start && offset <= node.end) return node;
  }
  return null;
}

/** Innermost call expression whose argument list contains `offset`. */
export function enclosingCall(
  analysis: FileAnalysis,
  offset: number,
): { call: CallExpression; argIndex: number } | null {
  const path = nodePathAt(analysis.chunk, offset);
  for (const node of path) {
    if (node.type !== 'CallExpression') continue;
    if (offset < node.argsStart) continue;
    if (!node.unclosed && offset > node.end) continue;

    let argIndex = node.args.length ? node.args.length - 1 : 0;
    for (let i = 0; i < node.args.length; i++) {
      const arg = node.args[i]!;
      if (offset <= arg.end) {
        argIndex = i;
        break;
      }
    }
    // A trailing comma means the cursor sits in the next, not-yet-written slot.
    if (node.args.length) {
      const last = node.args[node.args.length - 1]!;
      if (offset > last.end) {
        const between = analysis.text.slice(last.end, offset);
        if (between.includes(',')) argIndex = node.args.length;
      }
    }
    return { call: node, argIndex };
  }
  return null;
}

/**
 * Works out what the user is completing.
 *
 * This reads the raw text around the cursor to find the trigger character and
 * only then consults the AST for the base expression. Doing it that way means a
 * half-written `ply:` still resolves even when the parser had to recover.
 */
export function completionContextAt(analysis: FileAnalysis, offset: number): CompletionContext {
  const text = analysis.text;

  const literal = stringLiteralAt(analysis, offset);
  if (literal) {
    const raw = text.slice(literal.start, literal.end);
    const quote = raw[0];
    const terminated = raw.length > 1 && raw[raw.length - 1] === quote && !raw.startsWith('[');
    const contentStart = raw.startsWith('[') ? literal.start + raw.indexOf('[', 1) + 1 : literal.start + 1;
    const contentEnd = terminated ? literal.end - 1 : literal.end;

    const call = enclosingCall(analysis, literal.start);
    return {
      kind: 'string',
      callPath: call ? exprToPath(call.call.base) : null,
      argIndex: call?.argIndex ?? 0,
      prefix: text.slice(contentStart, Math.min(offset, contentEnd)),
      replaceStart: contentStart,
      replaceEnd: Math.max(contentEnd, offset),
    };
  }

  let wordStart = offset;
  while (wordStart > 0 && isNamePart(text[wordStart - 1])) wordStart--;
  const prefix = text.slice(wordStart, offset);

  let i = wordStart - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  const trigger = text[i];

  if (trigger === '.' || trigger === ':') {
    // `..` is concatenation, not a member access.
    if (!(trigger === '.' && text[i - 1] === '.')) {
      const base = baseExpressionBefore(analysis, i);
      return {
        kind: 'member',
        indexer: trigger,
        base,
        baseType: base ? analysis.typeOf(base) : UNKNOWN,
        basePath: base ? exprToPath(base) : null,
        prefix,
        replaceStart: wordStart,
      };
    }
  }

  return { kind: 'identifier', prefix, replaceStart: wordStart };
}

/** The expression immediately left of the `.`/`:` at `dotOffset`. */
function baseExpressionBefore(analysis: FileAnalysis, dotOffset: number): Expression | null {
  // Preferred path: the parser already built a MemberExpression spanning the dot.
  for (const node of nodePathAt(analysis.chunk, dotOffset)) {
    if (node.type === 'MemberExpression' && node.identifier.start >= dotOffset) {
      return node.base;
    }
  }

  // Recovery path: take the innermost expression that ends at the dot.
  let best: Expression | null = null;
  const consider = (node: Node): void => {
    if (!isExpression(node)) return;
    if (node.end !== dotOffset) return;
    if (!best || node.start > best.start) best = node;
  };
  for (const node of nodePathAt(analysis.chunk, Math.max(0, dotOffset - 1))) consider(node);
  return best;
}

function isExpression(node: Node): node is Expression {
  switch (node.type) {
    case 'Identifier':
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NilLiteral':
    case 'VarargLiteral':
    case 'TableConstructor':
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'MemberExpression':
    case 'IndexExpression':
    case 'CallExpression':
    case 'FunctionExpression':
      return true;
    default:
      return false;
  }
}
