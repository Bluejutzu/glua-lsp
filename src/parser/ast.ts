// AST for Lua 5.1 + GLua. Every node carries absolute [start, end) offsets into
// the source string (UTF-16 code units, matching both JS strings and the LSP
// position encoding), so any feature can map a cursor straight onto a node.
//
// Nodes may be marked `missing` — that is deliberate. `ply:` with nothing after
// the colon still produces a MemberExpression whose identifier is missing, which
// is what makes completion work while you are mid-keystroke.

export interface NodeBase {
  start: number;
  end: number;
}

export type Node = Statement | Expression | Chunk | TableKeyField | IfClause;

/* ------------------------------------------------------------ expressions */

export interface Identifier extends NodeBase {
  type: 'Identifier';
  name: string;
  /** Synthesised to fill a hole in incomplete source. */
  missing?: boolean;
}

export interface NumberLiteral extends NodeBase {
  type: 'NumberLiteral';
  value: number;
  raw: string;
}

export interface StringLiteral extends NodeBase {
  type: 'StringLiteral';
  value: string;
  raw: string;
}

export interface BooleanLiteral extends NodeBase {
  type: 'BooleanLiteral';
  value: boolean;
}

export interface NilLiteral extends NodeBase {
  type: 'NilLiteral';
}

export interface VarargLiteral extends NodeBase {
  type: 'VarargLiteral';
}

export interface TableKeyField extends NodeBase {
  type: 'TableKeyField';
  /** `list` = positional, `name` = `k = v`, `index` = `[expr] = v` */
  kind: 'list' | 'name' | 'index';
  key: Expression | null;
  value: Expression;
}

export interface TableConstructor extends NodeBase {
  type: 'TableConstructor';
  fields: TableKeyField[];
}

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%' | '^' | '..'
  | '==' | '~=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export interface BinaryExpression extends NodeBase {
  type: 'BinaryExpression';
  operator: BinaryOperator;
  /** How it was spelled in source: `!=` vs `~=`, `&&` vs `and`. */
  operatorText: string;
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends NodeBase {
  type: 'UnaryExpression';
  operator: 'not' | '-' | '#';
  operatorText: string;
  argument: Expression;
}

export interface MemberExpression extends NodeBase {
  type: 'MemberExpression';
  base: Expression;
  indexer: '.' | ':';
  identifier: Identifier;
}

export interface IndexExpression extends NodeBase {
  type: 'IndexExpression';
  base: Expression;
  index: Expression;
}

export interface CallExpression extends NodeBase {
  type: 'CallExpression';
  base: Expression;
  args: Expression[];
  /** `f(x)` vs `f"x"` vs `f{x}` */
  argStyle: 'paren' | 'string' | 'table';
  /** Argument list was never closed — the user is still typing it. */
  unclosed?: boolean;
  /** Offset just after `(`, used to place signature help. */
  argsStart: number;
}

export interface FunctionExpression extends NodeBase {
  type: 'FunctionExpression';
  params: (Identifier | VarargLiteral)[];
  body: Statement[];
  isVararg: boolean;
  /** Set when this came from `function a:b()` so `self` is in scope. */
  isMethod?: boolean;
}

export type Expression =
  | Identifier
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NilLiteral
  | VarargLiteral
  | TableConstructor
  | BinaryExpression
  | UnaryExpression
  | MemberExpression
  | IndexExpression
  | CallExpression
  | FunctionExpression;

/* ------------------------------------------------------------- statements */

export interface LocalStatement extends NodeBase {
  type: 'LocalStatement';
  names: Identifier[];
  init: Expression[];
}

export interface AssignmentStatement extends NodeBase {
  type: 'AssignmentStatement';
  targets: Expression[];
  init: Expression[];
  /** Compound assignment isn't real Lua, but people write it; we parse and flag it. */
  compoundOperator?: string;
}

export interface CallStatement extends NodeBase {
  type: 'CallStatement';
  expression: Expression;
}

export interface DoStatement extends NodeBase {
  type: 'DoStatement';
  body: Statement[];
}

export interface WhileStatement extends NodeBase {
  type: 'WhileStatement';
  condition: Expression;
  body: Statement[];
}

export interface RepeatStatement extends NodeBase {
  type: 'RepeatStatement';
  body: Statement[];
  condition: Expression;
}

export interface IfClause extends NodeBase {
  type: 'IfClause';
  /** null for the `else` clause. */
  condition: Expression | null;
  body: Statement[];
}

export interface IfStatement extends NodeBase {
  type: 'IfStatement';
  clauses: IfClause[];
}

export interface NumericForStatement extends NodeBase {
  type: 'NumericForStatement';
  variable: Identifier;
  start: number;
  end: number;
  from: Expression;
  to: Expression;
  step: Expression | null;
  body: Statement[];
}

export interface GenericForStatement extends NodeBase {
  type: 'GenericForStatement';
  names: Identifier[];
  iterators: Expression[];
  body: Statement[];
}

export interface FunctionDeclaration extends NodeBase {
  type: 'FunctionDeclaration';
  /** `function foo.bar:baz()` -> the whole `foo.bar:baz` expression. */
  identifier: Expression | null;
  isLocal: boolean;
  func: FunctionExpression;
}

export interface ReturnStatement extends NodeBase {
  type: 'ReturnStatement';
  args: Expression[];
}

export interface BreakStatement extends NodeBase {
  type: 'BreakStatement';
}

export interface ContinueStatement extends NodeBase {
  type: 'ContinueStatement';
}

export interface GotoStatement extends NodeBase {
  type: 'GotoStatement';
  label: Identifier;
}

export interface LabelStatement extends NodeBase {
  type: 'LabelStatement';
  label: Identifier;
}

export type Statement =
  | LocalStatement
  | AssignmentStatement
  | CallStatement
  | DoStatement
  | WhileStatement
  | RepeatStatement
  | IfStatement
  | NumericForStatement
  | GenericForStatement
  | FunctionDeclaration
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | GotoStatement
  | LabelStatement;

export interface Chunk extends NodeBase {
  type: 'Chunk';
  body: Statement[];
}

/* --------------------------------------------------------------- walking */

type AnyNode = Chunk | Statement | Expression | TableKeyField | IfClause;

/** Child nodes in source order. */
export function childrenOf(node: AnyNode): AnyNode[] {
  switch (node.type) {
    case 'Chunk':
      return node.body;
    case 'LocalStatement':
      return [...node.names, ...node.init];
    case 'AssignmentStatement':
      return [...node.targets, ...node.init];
    case 'CallStatement':
      return [node.expression];
    case 'DoStatement':
      return node.body;
    case 'WhileStatement':
      return [node.condition, ...node.body];
    case 'RepeatStatement':
      return [...node.body, node.condition];
    case 'IfStatement':
      return node.clauses;
    case 'IfClause':
      return node.condition ? [node.condition, ...node.body] : node.body;
    case 'NumericForStatement':
      return [
        node.variable,
        node.from,
        node.to,
        ...(node.step ? [node.step] : []),
        ...node.body,
      ];
    case 'GenericForStatement':
      return [...node.names, ...node.iterators, ...node.body];
    case 'FunctionDeclaration':
      return node.identifier ? [node.identifier, node.func] : [node.func];
    case 'FunctionExpression':
      return [...node.params, ...node.body];
    case 'ReturnStatement':
      return node.args;
    case 'GotoStatement':
    case 'LabelStatement':
      return [node.label];
    case 'TableConstructor':
      return node.fields;
    case 'TableKeyField':
      return node.key ? [node.key, node.value] : [node.value];
    case 'BinaryExpression':
      return [node.left, node.right];
    case 'UnaryExpression':
      return [node.argument];
    case 'MemberExpression':
      return [node.base, node.identifier];
    case 'IndexExpression':
      return [node.base, node.index];
    case 'CallExpression':
      return [node.base, ...node.args];
    default:
      return [];
  }
}

/** Pre-order walk. Return `false` from `enter` to skip a subtree. */
export function walk(
  node: AnyNode,
  enter: (node: AnyNode, parent: AnyNode | null) => boolean | void,
  parent: AnyNode | null = null,
): void {
  if (enter(node, parent) === false) return;
  for (const child of childrenOf(node)) walk(child, enter, node);
}

export function contains(node: NodeBase, offset: number): boolean {
  return offset >= node.start && offset <= node.end;
}

/**
 * Innermost-first chain of nodes containing `offset`, root last.
 * This is the primitive every cursor-driven feature is built on.
 */
export function nodePathAt(chunk: Chunk, offset: number): AnyNode[] {
  const path: AnyNode[] = [];
  const descend = (node: AnyNode) => {
    if (!contains(node, offset)) return;
    path.push(node);
    for (const child of childrenOf(node)) {
      if (contains(child, offset)) {
        descend(child);
        return;
      }
    }
  };
  descend(chunk);
  return path.reverse();
}
