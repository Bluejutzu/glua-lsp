// Formatter. Reprints the AST rather than patching the source text.
//
// Two rules keep it safe to run on other people's code:
//
//   1. It refuses to format a file that did not parse cleanly, so broken code is
//      never rewritten into something differently broken.
//   2. It never drops a comment. Comments are placed at statement and table-field
//      boundaries; anything sitting somewhere it cannot be placed makes that one
//      statement fall back to its original text, verbatim.

import type {
  Chunk,
  Expression,
  FunctionExpression,
  Identifier,
  Statement,
  TableKeyField,
  VarargLiteral,
} from '../parser/ast.js';
import { walk } from '../parser/ast.js';
import type { Comment } from '../parser/lexer.js';
import type { ParseResult } from '../parser/parser.js';
import { LineIndex } from '../util/lines.js';
import type { FormatOptions } from './options.js';

interface Span {
  start: number;
  end: number;
}

const OPERATOR_TO_LUA: Record<string, string> = {
  '!=': '~=',
  '&&': 'and',
  '||': 'or',
};

class Printer {
  private readonly lines: string[] = [];
  private current = '';
  private indentLevel = 0;
  private commentIndex = 0;
  /** Ranges that a nested block will print, so comments inside are not orphans. */
  private readonly blockRanges: Span[] = [];

  constructor(
    private readonly text: string,
    private readonly comments: Comment[],
    private readonly lineIndex: LineIndex,
    private readonly options: FormatOptions,
  ) {}

  /* -------------------------------------------------------------- output */

  private get indentText(): string {
    return this.options.useTabs
      ? '\t'.repeat(this.indentLevel)
      : ' '.repeat(this.indentLevel * this.options.indentSize);
  }

  /** Column in visual characters, counting a tab as one indent step. */
  private get column(): number {
    let width = 0;
    for (const char of this.current) width += char === '\t' ? this.options.indentSize : 1;
    return width;
  }

  private write(text: string): void {
    if (this.current === '' && text !== '') this.current = this.indentText;
    this.current += text;
  }

  private endLine(): void {
    this.lines.push(this.current.replace(/[ \t]+$/, ''));
    this.current = '';
  }

  private blankLine(): void {
    if (this.current !== '') this.endLine();
    this.lines.push('');
  }

  build(): string {
    if (this.current !== '') this.endLine();
    // Exactly one trailing newline.
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    return this.lines.join(this.options.endOfLine) + this.options.endOfLine;
  }

  /* ------------------------------------------------------------ comments */

  private commentText(comment: Comment): string {
    const raw = this.text.slice(comment.start, comment.end);
    if (this.options.commentStyle === 'preserve') return raw;
    if (comment.style === 'cline') return `--${comment.text}`;
    if (comment.style === 'block') return `--[[${comment.text}]]`;
    return raw;
  }

  /** Blank lines between two offsets, clamped to the configured maximum. */
  private blankLinesBetween(from: number, to: number): number {
    const gap = this.lineIndex.lineOf(to) - this.lineIndex.lineOf(from) - 1;
    return Math.max(0, Math.min(gap, this.options.maxBlankLines));
  }

  /**
   * Emits every pending comment that starts before `offset`, each on its own
   * line. Returns the offset the caller should treat as "previous end".
   */
  private emitCommentsBefore(offset: number, previousEnd: number): number {
    let last = previousEnd;
    while (this.commentIndex < this.comments.length) {
      const comment = this.comments[this.commentIndex]!;
      if (comment.start >= offset) break;
      this.commentIndex++;
      if (comment.end <= last) continue; // already consumed as a trailing comment

      for (let i = 0; i < this.blankLinesBetween(last, comment.start); i++) this.blankLine();
      if (this.current !== '') this.endLine();

      const body = this.commentText(comment);
      // Long comments keep their internal newlines; re-indent each line.
      const [first, ...rest] = body.split(/\r?\n/);
      this.write(first ?? '');
      for (const line of rest) {
        this.endLine();
        this.write(line.trim());
      }
      this.endLine();
      last = comment.end;
    }
    return last;
  }

  /** A comment on the same line as `end`, printed after the statement. */
  private emitTrailingComment(end: number): void {
    const comment = this.comments[this.commentIndex];
    if (!comment || comment.start < end) return;
    if (this.lineIndex.lineOf(comment.start) !== this.lineIndex.lineOf(end)) return;
    const body = this.commentText(comment);
    if (body.includes('\n')) return; // a long comment does not belong inline
    this.commentIndex++;
    this.write(` ${body}`);
  }

  private hasCommentIn(span: Span): boolean {
    return this.comments.some((c) => c.start >= span.start && c.end <= span.end);
  }

  /** A comment inside `span` that no nested block will print. */
  private hasOrphanCommentIn(span: Span): boolean {
    return this.comments.some(
      (c) =>
        c.start >= span.start &&
        c.end <= span.end &&
        !this.blockRanges.some((b) => c.start >= b.start && c.end <= b.end),
    );
  }

  /* ------------------------------------------------------------ verbatim */

  /** Reprints original source, re-indented to the current level. */
  private writeVerbatim(span: Span): void {
    const raw = this.text.slice(span.start, span.end);
    const rawLines = raw.split(/\r?\n/);

    // Strip the smallest common indent so the block can be re-indented.
    let common = Infinity;
    for (const line of rawLines.slice(1)) {
      if (!line.trim()) continue;
      common = Math.min(common, line.length - line.trimStart().length);
    }
    if (!Number.isFinite(common)) common = 0;

    this.write(rawLines[0]!.trim());
    for (const line of rawLines.slice(1)) {
      this.endLine();
      if (line.trim()) this.write(line.slice(common));
    }
  }

  /* ---------------------------------------------------------- expressions */

  /**
   * Single-line form of an expression, or null when it cannot be one — because
   * it holds a comment, or a function body that has to break.
   */
  private inline(node: Expression): string | null {
    if (this.hasCommentIn(node)) return null;

    const wrap = (text: string) => (node.parenthesized ? `(${text})` : text);
    const paren = (inner: string) =>
      this.options.spaceInsideParens && inner !== '' ? `( ${inner} )` : `(${inner})`;

    switch (node.type) {
      case 'Identifier':
        return wrap(node.name);
      case 'NumberLiteral':
        return wrap(node.raw);
      case 'StringLiteral':
        return wrap(this.stringLiteral(node.raw, node.value));
      case 'BooleanLiteral':
        return wrap(String(node.value));
      case 'NilLiteral':
        return wrap('nil');
      case 'VarargLiteral':
        return wrap('...');

      case 'BinaryExpression': {
        const left = this.inline(node.left);
        const right = this.inline(node.right);
        if (left === null || right === null) return null;
        return wrap(`${left} ${this.operator(node.operatorText)} ${right}`);
      }

      case 'UnaryExpression': {
        const argument = this.inline(node.argument);
        if (argument === null) return null;
        const op = this.unaryOperator(node.operatorText);
        // `not x` needs the space; `-x` and `#x` must not have one.
        const separator = /[a-z]$/.test(op) ? ' ' : '';
        return wrap(`${op}${separator}${argument}`);
      }

      case 'MemberExpression': {
        const base = this.inline(node.base);
        if (base === null) return null;
        return wrap(`${base}${node.indexer}${node.identifier.name}`);
      }

      case 'IndexExpression': {
        const base = this.inline(node.base);
        const index = this.inline(node.index);
        if (base === null || index === null) return null;
        return wrap(`${base}[${index}]`);
      }

      case 'CallExpression': {
        const base = this.inline(node.base);
        if (base === null) return null;
        if (node.argStyle === 'string' || node.argStyle === 'table') {
          const only = this.inline(node.args[0]!);
          if (only === null) return null;
          return wrap(`${base}${only}`);
        }
        const args: string[] = [];
        for (const arg of node.args) {
          const rendered = this.inline(arg);
          if (rendered === null) return null;
          args.push(rendered);
        }
        return wrap(`${base}${paren(args.join(', '))}`);
      }

      case 'TableConstructor': {
        if (!node.fields.length) return wrap('{}');
        const fields: string[] = [];
        for (const field of node.fields) {
          const rendered = this.inlineField(field);
          if (rendered === null) return null;
          fields.push(rendered);
        }
        return wrap(`{ ${fields.join(', ')} }`);
      }

      case 'FunctionExpression': {
        // Only an empty body can stay on one line.
        if (node.body.length) return null;
        return wrap(`function${paren(this.paramList(node.params))} end`);
      }

      default:
        return null;
    }
  }

  private inlineField(field: TableKeyField): string | null {
    const value = this.inline(field.value);
    if (value === null) return null;
    if (field.kind === 'list') return value;
    if (field.kind === 'name' && field.key?.type === 'Identifier') {
      return `${field.key.name} = ${value}`;
    }
    const key = field.key ? this.inline(field.key) : null;
    if (key === null) return null;
    return `[${key}] = ${value}`;
  }

  private paramList(params: (Identifier | VarargLiteral)[]): string {
    return params.map((p) => (p.type === 'VarargLiteral' ? '...' : p.name)).join(', ');
  }

  private operator(text: string): string {
    return this.options.operatorStyle === 'lua' ? (OPERATOR_TO_LUA[text] ?? text) : text;
  }

  private unaryOperator(text: string): string {
    if (this.options.operatorStyle === 'lua' && text === '!') return 'not';
    return text;
  }

  private stringLiteral(raw: string, value: string): string {
    if (this.options.quoteStyle === 'preserve') return raw;
    if (raw.startsWith('[')) return raw; // long strings keep their brackets

    const want = this.options.quoteStyle === 'double' ? '"' : "'";
    if (raw.startsWith(want)) return raw;
    // Only swap when it does not force new escapes.
    if (value.includes(want)) return raw;
    return want + value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + want;
  }

  /** Writes an expression, breaking it across lines if the inline form is too wide. */
  private writeExpression(node: Expression): void {
    const inline = this.inline(node);
    if (inline !== null && this.column + inline.length <= this.options.maxLineWidth) {
      this.write(inline);
      return;
    }

    switch (node.type) {
      case 'TableConstructor':
        this.writeTable(node);
        return;
      case 'CallExpression':
        this.writeCall(node);
        return;
      case 'FunctionExpression':
        this.writeFunctionExpression(node);
        return;
      case 'BinaryExpression': {
        // Break after the operator, keeping the operands whole.
        if (node.parenthesized) this.write('(');
        this.writeExpression(node.left);
        this.write(` ${this.operator(node.operatorText)}`);
        this.endLine();
        this.indentLevel++;
        this.writeExpression(node.right);
        this.indentLevel--;
        if (node.parenthesized) this.write(')');
        return;
      }
      case 'MemberExpression':
      case 'IndexExpression':
        // Nothing useful to break on; emit the base broken, then the accessor.
        if (node.parenthesized) this.write('(');
        this.writeExpression(node.base);
        this.write(
          node.type === 'MemberExpression'
            ? `${node.indexer}${node.identifier.name}`
            : `[${this.inline(node.index) ?? this.text.slice(node.index.start, node.index.end)}]`,
        );
        if (node.parenthesized) this.write(')');
        return;
      default:
        // Not breakable: fall back to the source text.
        this.writeVerbatim(node);
    }
  }

  private writeTable(node: Extract<Expression, { type: 'TableConstructor' }>): void {
    if (node.parenthesized) this.write('(');
    if (!node.fields.length) {
      this.write('{}');
      if (node.parenthesized) this.write(')');
      return;
    }

    this.write('{');
    this.endLine();
    this.indentLevel++;

    let previousEnd = node.start;
    for (const field of node.fields) {
      previousEnd = this.emitCommentsBefore(field.start, previousEnd);
      const inline = this.inlineField(field);
      if (inline !== null && this.column + inline.length <= this.options.maxLineWidth) {
        this.write(inline);
      } else if (field.kind === 'list') {
        this.writeExpression(field.value);
      } else if (field.kind === 'name' && field.key?.type === 'Identifier') {
        this.write(`${field.key.name} = `);
        this.writeExpression(field.value);
      } else {
        this.write('[');
        if (field.key) this.writeExpression(field.key);
        this.write('] = ');
        this.writeExpression(field.value);
      }
      this.write(',');
      this.emitTrailingComment(field.end);
      this.endLine();
      previousEnd = field.end;
    }

    this.emitCommentsBefore(node.end, previousEnd);
    this.indentLevel--;
    this.write('}');
    if (node.parenthesized) this.write(')');
  }

  private writeCall(node: Extract<Expression, { type: 'CallExpression' }>): void {
    if (node.parenthesized) this.write('(');
    this.writeExpression(node.base);

    if (node.argStyle === 'string' || node.argStyle === 'table') {
      this.writeExpression(node.args[0]!);
      if (node.parenthesized) this.write(')');
      return;
    }

    if (!node.args.length) {
      this.write(this.options.spaceInsideParens ? '()' : '()');
      if (node.parenthesized) this.write(')');
      return;
    }

    // A trailing function or table argument expands on its own, which is what
    // keeps `hook.Add("X", "Y", function() ... end)` readable.
    const last = node.args[node.args.length - 1]!;
    const leading = node.args.slice(0, -1);
    const leadingInline = leading.map((arg) => this.inline(arg));

    if (
      (last.type === 'FunctionExpression' || last.type === 'TableConstructor') &&
      leadingInline.every((rendered) => rendered !== null)
    ) {
      this.write(this.options.spaceInsideParens ? '( ' : '(');
      for (const rendered of leadingInline as string[]) {
        this.write(rendered);
        this.write(', ');
      }
      this.writeExpression(last);
      this.write(this.options.spaceInsideParens ? ' )' : ')');
      if (node.parenthesized) this.write(')');
      return;
    }

    // Otherwise put one argument per line.
    this.write('(');
    this.endLine();
    this.indentLevel++;
    node.args.forEach((arg, i) => {
      this.writeExpression(arg);
      if (i < node.args.length - 1) this.write(',');
      this.endLine();
    });
    this.indentLevel--;
    this.write(')');
    if (node.parenthesized) this.write(')');
  }

  private writeFunctionExpression(node: FunctionExpression): void {
    if (node.parenthesized) this.write('(');
    const params = this.paramList(node.params);
    this.write(
      this.options.spaceInsideParens && params ? `function( ${params} )` : `function(${params})`,
    );
    this.endLine();
    this.writeBlock(node.body, node.start, node.end);
    this.write('end');
    if (node.parenthesized) this.write(')');
  }

  /* ----------------------------------------------------------- statements */

  private writeBlock(body: Statement[], openEnd: number, closeStart: number): void {
    this.indentLevel++;
    let previousEnd = openEnd;
    for (const statement of body) {
      previousEnd = this.emitCommentsBefore(statement.start, previousEnd);
      for (let i = 0; i < this.blankLinesBetween(previousEnd, statement.start); i++) {
        this.blankLine();
      }
      this.writeStatement(statement);
      this.emitTrailingComment(statement.end);
      this.endLine();
      previousEnd = statement.end;
    }
    this.emitCommentsBefore(closeStart, previousEnd);
    this.indentLevel--;
  }

  /**
   * Single-line form of a statement, or null when it needs to span lines.
   * Used only to keep a one-liner the author already wrote as a one-liner.
   */
  private inlineStatement(statement: Statement): string | null {
    if (this.hasCommentIn(statement)) return null;

    const body = (statements: Statement[]): string | null => {
      const parts: string[] = [];
      for (const inner of statements) {
        const rendered = this.inlineStatement(inner);
        if (rendered === null) return null;
        parts.push(rendered);
      }
      return parts.join(' ');
    };

    const list = (expressions: Expression[]): string | null => {
      const parts: string[] = [];
      for (const expression of expressions) {
        const rendered = this.inline(expression);
        if (rendered === null) return null;
        parts.push(rendered);
      }
      return parts.join(', ');
    };

    switch (statement.type) {
      case 'BreakStatement':
        return 'break';
      case 'ContinueStatement':
        return 'continue';
      case 'GotoStatement':
        return `goto ${statement.label.name}`;
      case 'LabelStatement':
        return `::${statement.label.name}::`;

      case 'ReturnStatement': {
        if (!statement.args.length) return 'return';
        const args = list(statement.args);
        return args === null ? null : `return ${args}`;
      }

      case 'CallStatement':
        return this.inline(statement.expression);

      case 'LocalStatement': {
        const names = statement.names.map((n) => n.name).join(', ');
        if (!statement.init.length) return `local ${names}`;
        const init = list(statement.init);
        return init === null ? null : `local ${names} = ${init}`;
      }

      case 'AssignmentStatement': {
        const targets = list(statement.targets);
        const init = list(statement.init);
        return targets === null || init === null ? null : `${targets} = ${init}`;
      }

      case 'DoStatement': {
        const inner = body(statement.body);
        return inner === null ? null : `do ${inner} end`;
      }

      case 'WhileStatement': {
        const condition = this.inline(statement.condition);
        const inner = body(statement.body);
        return condition === null || inner === null ? null : `while ${condition} do ${inner} end`;
      }

      case 'RepeatStatement': {
        const condition = this.inline(statement.condition);
        const inner = body(statement.body);
        return condition === null || inner === null ? null : `repeat ${inner} until ${condition}`;
      }

      case 'NumericForStatement': {
        const from = this.inline(statement.from);
        const to = this.inline(statement.to);
        const step = statement.step ? this.inline(statement.step) : '';
        const inner = body(statement.body);
        if (from === null || to === null || step === null || inner === null) return null;
        const range = step ? `${from}, ${to}, ${step}` : `${from}, ${to}`;
        return `for ${statement.variable.name} = ${range} do ${inner} end`;
      }

      case 'GenericForStatement': {
        const iterators = list(statement.iterators);
        const inner = body(statement.body);
        if (iterators === null || inner === null) return null;
        const names = statement.names.map((n) => n.name).join(', ');
        return `for ${names} in ${iterators} do ${inner} end`;
      }

      case 'IfStatement': {
        const parts: string[] = [];
        for (const [i, clause] of statement.clauses.entries()) {
          const inner = body(clause.body);
          if (inner === null) return null;
          if (clause.condition) {
            const condition = this.inline(clause.condition);
            if (condition === null) return null;
            parts.push(`${i === 0 ? 'if' : 'elseif'} ${condition} then${inner ? ` ${inner}` : ''}`);
          } else {
            parts.push(`else${inner ? ` ${inner}` : ''}`);
          }
        }
        return `${parts.join(' ')} end`;
      }

      default:
        return null;
    }
  }

  private wasSingleLine(statement: Statement): boolean {
    return (
      this.lineIndex.lineOf(statement.start) === this.lineIndex.lineOf(statement.end)
    );
  }

  private writeStatement(statement: Statement): void {
    // Keep a one-liner the author wrote as a one-liner, when it still fits.
    if (this.options.keepSingleLineBlocks && this.wasSingleLine(statement)) {
      const inline = this.inlineStatement(statement);
      if (inline !== null && this.column + inline.length <= this.options.maxLineWidth) {
        this.write(inline);
        if (this.options.semicolons === 'preserve' && this.text[statement.end] === ';') {
          this.write(';');
        }
        return;
      }
    }

    // A comment somewhere we cannot place it: keep the original text instead of
    // silently dropping it.
    if (this.hasOrphanCommentIn(statement) && !this.handlesCommentsItself(statement)) {
      this.writeVerbatim(statement);
      // Mark those comments consumed so they are not printed twice.
      while (
        this.commentIndex < this.comments.length &&
        this.comments[this.commentIndex]!.start < statement.end
      ) {
        this.commentIndex++;
      }
      return;
    }

    switch (statement.type) {
      case 'LocalStatement': {
        this.write('local ');
        this.write(statement.names.map((n) => n.name).join(', '));
        if (statement.init.length) {
          this.write(' = ');
          this.writeExpressionList(statement.init);
        }
        break;
      }

      case 'AssignmentStatement': {
        statement.targets.forEach((target, i) => {
          if (i) this.write(', ');
          this.writeExpression(target);
        });
        this.write(' = ');
        this.writeExpressionList(statement.init);
        break;
      }

      case 'CallStatement':
        this.writeExpression(statement.expression);
        break;

      case 'DoStatement':
        this.write('do');
        this.endLine();
        this.writeBlock(statement.body, statement.start, statement.end);
        this.write('end');
        break;

      case 'WhileStatement':
        this.write('while ');
        this.writeExpression(statement.condition);
        this.write(' do');
        this.endLine();
        this.writeBlock(statement.body, statement.condition.end, statement.end);
        this.write('end');
        break;

      case 'RepeatStatement':
        this.write('repeat');
        this.endLine();
        this.writeBlock(statement.body, statement.start, statement.condition.start);
        this.write('until ');
        this.writeExpression(statement.condition);
        break;

      case 'IfStatement':
        statement.clauses.forEach((clause, i) => {
          if (i) {
            this.endLine();
          }
          if (clause.condition) {
            this.write(i === 0 ? 'if ' : 'elseif ');
            this.writeExpression(clause.condition);
            this.write(' then');
          } else {
            this.write('else');
          }
          this.endLine();
          this.writeBlock(clause.body, clause.condition?.end ?? clause.start, clause.end);
        });
        this.write('end');
        break;

      case 'NumericForStatement':
        this.write(`for ${statement.variable.name} = `);
        this.writeExpression(statement.from);
        this.write(', ');
        this.writeExpression(statement.to);
        if (statement.step) {
          this.write(', ');
          this.writeExpression(statement.step);
        }
        this.write(' do');
        this.endLine();
        this.writeBlock(statement.body, (statement.step ?? statement.to).end, statement.end);
        this.write('end');
        break;

      case 'GenericForStatement':
        this.write(`for ${statement.names.map((n) => n.name).join(', ')} in `);
        this.writeExpressionList(statement.iterators);
        this.write(' do');
        this.endLine();
        this.writeBlock(
          statement.body,
          statement.iterators[statement.iterators.length - 1]?.end ?? statement.start,
          statement.end,
        );
        this.write('end');
        break;

      case 'FunctionDeclaration': {
        this.write(statement.isLocal ? 'local function ' : 'function ');
        if (statement.identifier) {
          const name = this.inline(statement.identifier);
          this.write(name ?? this.text.slice(statement.identifier.start, statement.identifier.end));
        }
        const params = this.paramList(statement.func.params);
        this.write(
          this.options.spaceInsideParens && params ? `( ${params} )` : `(${params})`,
        );
        this.endLine();
        this.writeBlock(statement.func.body, statement.func.start, statement.func.end);
        this.write('end');
        break;
      }

      case 'ReturnStatement':
        this.write('return');
        if (statement.args.length) {
          this.write(' ');
          this.writeExpressionList(statement.args);
        }
        break;

      case 'BreakStatement':
        this.write('break');
        break;

      case 'ContinueStatement':
        this.write('continue');
        break;

      case 'GotoStatement':
        this.write(`goto ${statement.label.name}`);
        break;

      case 'LabelStatement':
        this.write(`::${statement.label.name}::`);
        break;

      default:
        this.writeVerbatim(statement);
    }

    if (this.options.semicolons === 'preserve' && this.text[statement.end] === ';') {
      this.write(';');
    }
  }

  private writeExpressionList(list: Expression[]): void {
    list.forEach((expression, i) => {
      if (i) this.write(', ');
      this.writeExpression(expression);
    });
  }

  /** Statements whose own printers place comments correctly. */
  private handlesCommentsItself(statement: Statement): boolean {
    switch (statement.type) {
      case 'DoStatement':
      case 'WhileStatement':
      case 'RepeatStatement':
      case 'IfStatement':
      case 'NumericForStatement':
      case 'GenericForStatement':
      case 'FunctionDeclaration':
        return true;
      default:
        // A local or a call is fine too when the comments sit inside a table or
        // a callback body, both of which have their own comment handling.
        return !this.hasOrphanCommentIn(statement);
    }
  }

  /* ---------------------------------------------------------------- entry */

  print(chunk: Chunk): string {
    this.collectBlockRanges(chunk);
    this.writeTopLevel(chunk);
    return this.build();
  }

  private writeTopLevel(chunk: Chunk): void {
    let previousEnd = 0;
    for (const statement of chunk.body) {
      previousEnd = this.emitCommentsBefore(statement.start, previousEnd);
      for (let i = 0; i < this.blankLinesBetween(previousEnd, statement.start); i++) {
        this.blankLine();
      }
      this.writeStatement(statement);
      this.emitTrailingComment(statement.end);
      this.endLine();
      previousEnd = statement.end;
    }
    this.emitCommentsBefore(this.text.length, previousEnd);
  }

  /** Regions a nested printer will handle, used to spot orphaned comments. */
  private collectBlockRanges(chunk: Chunk): void {
    walk(chunk, (node) => {
      switch (node.type) {
        case 'FunctionExpression':
        case 'DoStatement':
        case 'WhileStatement':
        case 'RepeatStatement':
        case 'NumericForStatement':
        case 'GenericForStatement':
        case 'IfClause':
        case 'TableConstructor':
          this.blockRanges.push({ start: node.start, end: node.end });
          break;
        default:
          break;
      }
    });
  }
}

/**
 * Formats a whole document.
 *
 * Returns null when the file did not parse, which the server turns into "no
 * edits" rather than an error dialog.
 */
export function formatDocument(
  text: string,
  parsed: ParseResult,
  options: FormatOptions,
): string | null {
  if (parsed.errors.length) return null;
  const lineIndex = new LineIndex(text);
  const printer = new Printer(text, parsed.comments, lineIndex, options);
  return printer.print(parsed.chunk);
}

/** Picks the line ending already used by the document. */
export function detectEndOfLine(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > lf / 2 ? '\r\n' : '\n';
}
