// Error-tolerant recursive-descent parser.
//
// The contract that matters: parse() ALWAYS returns a Chunk, however broken the
// input. Half-typed code produces real nodes with `missing` holes rather than an
// exception, which is what lets completion, hover and signature help keep
// working on the line you are actively editing.

import {
  lex,
  T,
  TOKEN_NAMES,
  type Comment,
  type Token,
} from './lexer.js';
import type {
  BinaryOperator,
  CallExpression,
  Chunk,
  Expression,
  FunctionExpression,
  Identifier,
  IfClause,
  Statement,
  TableKeyField,
  VarargLiteral,
} from './ast.js';

export interface ParseError {
  start: number;
  end: number;
  message: string;
}

export interface ParseResult {
  chunk: Chunk;
  comments: Comment[];
  errors: ParseError[];
  tokens: Token[];
}

/**
 * [precedence, subExpressionLimit]. The limit equals the precedence for
 * left-associative operators and precedence-1 for right-associative ones
 * (`..` and `^`), which is what makes `a-b-c` group left and `2^3^4` group right.
 */
const BINARY_POWER: Partial<Record<T, [number, number]>> = {
  [T.Or]: [1, 1],
  [T.And]: [2, 2],
  [T.Lt]: [3, 3],
  [T.Gt]: [3, 3],
  [T.Le]: [3, 3],
  [T.Ge]: [3, 3],
  [T.Ne]: [3, 3],
  [T.Eq]: [3, 3],
  [T.DotDot]: [9, 8],
  [T.Plus]: [10, 10],
  [T.Minus]: [10, 10],
  [T.Star]: [11, 11],
  [T.Slash]: [11, 11],
  [T.Percent]: [11, 11],
  [T.Caret]: [14, 13],
};

const UNARY_POWER = 12;

const BINARY_OP_NAME: Partial<Record<T, BinaryOperator>> = {
  [T.Or]: 'or',
  [T.And]: 'and',
  [T.Lt]: '<',
  [T.Gt]: '>',
  [T.Le]: '<=',
  [T.Ge]: '>=',
  [T.Ne]: '~=',
  [T.Eq]: '==',
  [T.DotDot]: '..',
  [T.Plus]: '+',
  [T.Minus]: '-',
  [T.Star]: '*',
  [T.Slash]: '/',
  [T.Percent]: '%',
  [T.Caret]: '^',
};

const BLOCK_END = new Set<T>([T.End, T.Else, T.Elseif, T.Until, T.EOF]);

/** Tokens that can begin a statement — used to resynchronise after an error. */
const STATEMENT_START = new Set<T>([
  T.Local, T.Function, T.If, T.While, T.For, T.Repeat, T.Do, T.Return,
  T.Break, T.Continue, T.Goto, T.DoubleColon, T.Semi, T.Name, T.LParen,
]);

export function parse(src: string): ParseResult {
  const { tokens, comments, errors: lexErrors } = lex(src);
  const errors: ParseError[] = lexErrors.map((e) => ({ ...e }));

  let pos = 0;
  /** Guards against a recovery path that fails to consume anything. */
  let lastErrorAt = -1;

  const peek = (offset = 0): Token =>
    tokens[Math.max(0, Math.min(pos + offset, tokens.length - 1))]!;
  const at = (type: T): boolean => peek().type === type;
  const next = (): Token => tokens[Math.min(pos++, tokens.length - 1)]!;

  function error(message: string, token: Token = peek()): void {
    // One error per position keeps the squiggle list readable.
    if (token.start === lastErrorAt) return;
    lastErrorAt = token.start;
    errors.push({ start: token.start, end: Math.max(token.end, token.start + 1), message });
  }

  function accept(type: T): Token | null {
    return at(type) ? next() : null;
  }

  function expect(type: T, context?: string): Token | null {
    if (at(type)) return next();
    const what = TOKEN_NAMES[type] ?? 'token';
    const got = peek().type === T.EOF ? '<eof>' : `'${peek().text}'`;
    error(`Expected ${what}${context ? ` ${context}` : ''}, got ${got}.`);
    return null;
  }

  /** Consumes `end`, pointing at the opener when it is missing. */
  function expectEnd(opener: Token, keyword: string): number {
    const tok = accept(T.End);
    if (tok) return tok.end;
    error(`Missing 'end' to close '${keyword}' opened here.`, opener);
    return peek().start;
  }

  function missingIdentifier(): Identifier {
    const p = peek().start;
    return { type: 'Identifier', name: '', start: p, end: p, missing: true };
  }

  function parseName(): Identifier {
    const tok = accept(T.Name);
    if (!tok) {
      error('Expected an identifier.');
      return missingIdentifier();
    }
    return { type: 'Identifier', name: tok.text, start: tok.start, end: tok.end };
  }

  /* ----------------------------------------------------------- expressions */

  function parsePrimaryExpression(): Expression {
    const tok = peek();
    switch (tok.type) {
      case T.Name:
        next();
        return { type: 'Identifier', name: tok.text, start: tok.start, end: tok.end };
      case T.LParen: {
        next();
        const inner = parseExpression();
        expect(T.RParen, 'to close a parenthesised expression');
        // Parenthesised expressions are truncated to one value in Lua, but for
        // our purposes the inner node with widened bounds is enough.
        return { ...inner, start: tok.start, end: peek(-1)?.end ?? inner.end };
      }
      default:
        error('Expected an expression.');
        return missingIdentifier();
    }
  }

  function parseCallArgs(base: Expression): CallExpression {
    const tok = peek();

    if (tok.type === T.String) {
      next();
      return {
        type: 'CallExpression',
        base,
        args: [
          { type: 'StringLiteral', value: String(tok.value ?? ''), raw: tok.text, start: tok.start, end: tok.end },
        ],
        argStyle: 'string',
        argsStart: tok.start,
        start: base.start,
        end: tok.end,
      };
    }

    if (tok.type === T.LBrace) {
      const table = parseTableConstructor();
      return {
        type: 'CallExpression',
        base,
        args: [table],
        argStyle: 'table',
        argsStart: table.start,
        start: base.start,
        end: table.end,
      };
    }

    const open = next(); // '('
    const args: Expression[] = [];
    let unclosed = false;

    if (!at(T.RParen)) {
      do {
        // `f(a, )` and `f(` both land here; record the hole and stop.
        if (at(T.RParen) || at(T.EOF)) break;
        args.push(parseExpression());
      } while (accept(T.Comma));
    }

    const close = accept(T.RParen);
    if (!close) {
      unclosed = true;
      error(`Missing ')' to close this call.`, open);
    }

    const call: CallExpression = {
      type: 'CallExpression',
      base,
      args,
      argStyle: 'paren',
      argsStart: open.end,
      start: base.start,
      // An unclosed call must span up to wherever parsing gave up, otherwise a
      // cursor sitting after a trailing comma falls outside the node and
      // signature help has nothing to attach to.
      end: close
        ? close.end
        : Math.max(args.at(-1)?.end ?? open.end, peek().start),
    };
    if (unclosed) call.unclosed = true;
    return call;
  }

  /** Applies `.a`, `[a]`, `:a(...)` and call suffixes to a base expression. */
  function parseSuffixes(base: Expression, allowCalls: boolean): Expression {
    for (;;) {
      const tok = peek();
      switch (tok.type) {
        case T.Dot: {
          next();
          const id = parseName();
          base = {
            type: 'MemberExpression',
            base,
            indexer: '.',
            identifier: id,
            start: base.start,
            end: id.end,
          };
          break;
        }
        case T.Colon: {
          next();
          const id = parseName();
          const member: Expression = {
            type: 'MemberExpression',
            base,
            indexer: ':',
            identifier: id,
            start: base.start,
            end: id.end,
          };
          // `obj:method` must be called, but if the user hasn't typed `(` yet we
          // keep the member node so completion and signature help still resolve.
          if (at(T.LParen) || at(T.String) || at(T.LBrace)) {
            base = parseCallArgs(member);
          } else {
            base = member;
          }
          break;
        }
        case T.LBracket: {
          next();
          const index = parseExpression();
          const close = expect(T.RBracket, 'to close an index');
          base = {
            type: 'IndexExpression',
            base,
            index,
            start: base.start,
            end: close ? close.end : index.end,
          };
          break;
        }
        case T.LParen:
          if (!allowCalls) return base;
          // A `(` on a fresh line after a complete expression is almost always a
          // new statement, not a call. Lua's own ambiguity rule; follow it.
          if (tok.newlineBefore) return base;
          base = parseCallArgs(base);
          break;
        case T.String:
        case T.LBrace:
          if (!allowCalls) return base;
          base = parseCallArgs(base);
          break;
        default:
          return base;
      }
    }
  }

  function parseTableConstructor(): Expression {
    const open = next(); // '{'
    const fields: TableKeyField[] = [];

    while (!at(T.RBrace) && !at(T.EOF)) {
      const fieldStart = peek().start;

      if (at(T.LBracket)) {
        next();
        const key = parseExpression();
        expect(T.RBracket, 'to close a table key');
        expect(T.Assign, 'after a table key');
        const value = parseExpression();
        fields.push({ type: 'TableKeyField', kind: 'index', key, value, start: fieldStart, end: value.end });
      } else if (at(T.Name) && peek(1).type === T.Assign) {
        const key = parseName();
        next(); // '='
        const value = parseExpression();
        fields.push({ type: 'TableKeyField', kind: 'name', key, value, start: fieldStart, end: value.end });
      } else {
        const before = pos;
        const value = parseExpression();
        if (pos === before) break; // no progress; bail out of the table
        fields.push({ type: 'TableKeyField', kind: 'list', key: null, value, start: fieldStart, end: value.end });
      }

      if (!accept(T.Comma) && !accept(T.Semi)) break;
    }

    const close = accept(T.RBrace);
    if (!close) error(`Missing '}' to close this table.`, open);

    return {
      type: 'TableConstructor',
      fields,
      start: open.start,
      end: close ? close.end : (fields.at(-1)?.end ?? open.end),
    };
  }

  function parseFunctionBody(open: Token, isMethod: boolean): FunctionExpression {
    const params: (Identifier | VarargLiteral)[] = [];
    let isVararg = false;

    if (expect(T.LParen, 'to open a parameter list')) {
      while (!at(T.RParen) && !at(T.EOF)) {
        const tok = peek();
        if (tok.type === T.Ellipsis) {
          next();
          isVararg = true;
          params.push({ type: 'VarargLiteral', start: tok.start, end: tok.end });
        } else if (tok.type === T.Name) {
          params.push(parseName());
        } else {
          error('Expected a parameter name.');
          break;
        }
        if (!accept(T.Comma)) break;
      }
      expect(T.RParen, 'to close a parameter list');
    }

    const body = parseBlock();
    const end = expectEnd(open, 'function');

    const fn: FunctionExpression = {
      type: 'FunctionExpression',
      params,
      body,
      isVararg,
      start: open.start,
      end,
    };
    if (isMethod) fn.isMethod = true;
    return fn;
  }

  function parseSimpleExpression(): Expression {
    const tok = peek();
    switch (tok.type) {
      case T.Nil:
        next();
        return { type: 'NilLiteral', start: tok.start, end: tok.end };
      case T.True:
      case T.False:
        next();
        return { type: 'BooleanLiteral', value: tok.type === T.True, start: tok.start, end: tok.end };
      case T.Number:
        next();
        return { type: 'NumberLiteral', value: Number(tok.value ?? 0), raw: tok.text, start: tok.start, end: tok.end };
      case T.String:
        next();
        return { type: 'StringLiteral', value: String(tok.value ?? ''), raw: tok.text, start: tok.start, end: tok.end };
      case T.Ellipsis:
        next();
        return { type: 'VarargLiteral', start: tok.start, end: tok.end };
      case T.LBrace:
        return parseTableConstructor();
      case T.Function:
        next();
        return parseFunctionBody(tok, false);
      default:
        return parseSuffixes(parsePrimaryExpression(), true);
    }
  }

  function parseExpression(limit = 0): Expression {
    let left: Expression;

    const tok = peek();
    if (tok.type === T.Not || tok.type === T.Minus || tok.type === T.Hash) {
      next();
      const argument = parseExpression(UNARY_POWER);
      const operator = tok.type === T.Not ? 'not' : tok.type === T.Minus ? '-' : '#';
      left = {
        type: 'UnaryExpression',
        operator,
        operatorText: tok.text,
        argument,
        start: tok.start,
        end: argument.end,
      };
    } else {
      left = parseSimpleExpression();
    }

    for (;;) {
      const op = peek();
      const power = BINARY_POWER[op.type];
      if (!power || power[0] <= limit) break;
      next();
      const right = parseExpression(power[1]);
      left = {
        type: 'BinaryExpression',
        operator: BINARY_OP_NAME[op.type]!,
        operatorText: op.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }

    return left;
  }

  /* ------------------------------------------------------------ statements */

  function parseBlock(): Statement[] {
    const body: Statement[] = [];
    while (!BLOCK_END.has(peek().type)) {
      const before = pos;
      const stat = parseStatement();
      if (stat) body.push(stat);
      if (pos === before) {
        // Nothing consumed: skip the offending token so we cannot spin.
        error(`Unexpected ${peek().type === T.EOF ? '<eof>' : `'${peek().text}'`}.`);
        next();
        // Resynchronise on the next plausible statement start.
        while (!BLOCK_END.has(peek().type) && !STATEMENT_START.has(peek().type)) next();
      }
      if (stat?.type === 'ReturnStatement') break; // `return` must end a block
    }
    return body;
  }

  function parseIfStatement(open: Token): Statement {
    const clauses: IfClause[] = [];
    let clauseStart = open;
    let condition = parseExpression();
    expect(T.Then, `after an 'if' condition`);
    let body = parseBlock();
    clauses.push({
      type: 'IfClause',
      condition,
      body,
      start: clauseStart.start,
      end: peek().start,
    });

    while (at(T.Elseif)) {
      clauseStart = next();
      condition = parseExpression();
      expect(T.Then, `after an 'elseif' condition`);
      body = parseBlock();
      clauses.push({ type: 'IfClause', condition, body, start: clauseStart.start, end: peek().start });
    }

    if (at(T.Else)) {
      clauseStart = next();
      body = parseBlock();
      clauses.push({ type: 'IfClause', condition: null, body, start: clauseStart.start, end: peek().start });
    }

    const end = expectEnd(open, 'if');
    return { type: 'IfStatement', clauses, start: open.start, end };
  }

  function parseForStatement(open: Token): Statement {
    const first = parseName();

    if (accept(T.Assign)) {
      const from = parseExpression();
      expect(T.Comma, `after the start value of a numeric 'for'`);
      const to = parseExpression();
      const step = accept(T.Comma) ? parseExpression() : null;
      expect(T.Do, `to open a 'for' body`);
      const body = parseBlock();
      const end = expectEnd(open, 'for');
      return {
        type: 'NumericForStatement',
        variable: first,
        from,
        to,
        step,
        body,
        start: open.start,
        end,
      };
    }

    const names = [first];
    while (accept(T.Comma)) names.push(parseName());
    expect(T.In, `in a generic 'for'`);
    const iterators: Expression[] = [parseExpression()];
    while (accept(T.Comma)) iterators.push(parseExpression());
    expect(T.Do, `to open a 'for' body`);
    const body = parseBlock();
    const end = expectEnd(open, 'for');
    return { type: 'GenericForStatement', names, iterators, body, start: open.start, end };
  }

  function parseFunctionStatement(open: Token): Statement {
    let identifier: Expression = parseName();
    let isMethod = false;

    for (;;) {
      if (accept(T.Dot)) {
        const id = parseName();
        identifier = {
          type: 'MemberExpression',
          base: identifier,
          indexer: '.',
          identifier: id,
          start: identifier.start,
          end: id.end,
        };
      } else if (accept(T.Colon)) {
        const id = parseName();
        identifier = {
          type: 'MemberExpression',
          base: identifier,
          indexer: ':',
          identifier: id,
          start: identifier.start,
          end: id.end,
        };
        isMethod = true;
        break; // a method name ends the path
      } else {
        break;
      }
    }

    const func = parseFunctionBody(open, isMethod);
    return {
      type: 'FunctionDeclaration',
      identifier,
      isLocal: false,
      func,
      start: open.start,
      end: func.end,
    };
  }

  function parseLocalStatement(open: Token): Statement {
    if (at(T.Function)) {
      const fnTok = next();
      const name = parseName();
      const func = parseFunctionBody(fnTok, false);
      return {
        type: 'FunctionDeclaration',
        identifier: name,
        isLocal: true,
        func,
        start: open.start,
        end: func.end,
      };
    }

    const names: Identifier[] = [parseName()];
    while (accept(T.Comma)) names.push(parseName());

    const init: Expression[] = [];
    if (accept(T.Assign)) {
      do {
        init.push(parseExpression());
      } while (accept(T.Comma));
    }

    return {
      type: 'LocalStatement',
      names,
      init,
      start: open.start,
      end: init.at(-1)?.end ?? names.at(-1)?.end ?? open.end,
    };
  }

  /** Assignment or call — only distinguishable after parsing the first target. */
  function parseExpressionStatement(): Statement {
    const start = peek().start;
    const first = parseSuffixes(parsePrimaryExpression(), true);

    // `x += 1` is not Lua, but it is written often enough to be worth a good
    // error plus a quick fix rather than a cascade of nonsense.
    const compound = peek();
    if (
      (compound.type === T.Plus || compound.type === T.Minus || compound.type === T.Star ||
        compound.type === T.Slash || compound.type === T.Percent || compound.type === T.DotDot) &&
      peek(1).type === T.Assign
    ) {
      next();
      next();
      const value = parseExpression();
      error(
        `Compound assignment '${compound.text}=' is not valid Lua. Write 'x = x ${compound.text} ...' instead.`,
        compound,
      );
      return {
        type: 'AssignmentStatement',
        targets: [first],
        init: [value],
        compoundOperator: compound.text,
        start,
        end: value.end,
      };
    }

    if (at(T.Assign) || at(T.Comma)) {
      const targets = [first];
      while (accept(T.Comma)) targets.push(parseSuffixes(parsePrimaryExpression(), true));
      expect(T.Assign, 'in an assignment');
      const init: Expression[] = [];
      do {
        init.push(parseExpression());
      } while (accept(T.Comma));
      return {
        type: 'AssignmentStatement',
        targets,
        init,
        start,
        end: init.at(-1)?.end ?? targets.at(-1)?.end ?? start,
      };
    }

    if (first.type !== 'CallExpression') {
      // Keep the node anyway — `net.` mid-edit lands here and completion needs it.
      error('This expression has no effect; expected a function call or an assignment.', peek());
    }
    return { type: 'CallStatement', expression: first, start, end: first.end };
  }

  function parseStatement(): Statement | null {
    const tok = peek();
    switch (tok.type) {
      case T.Semi:
        next();
        return null;

      case T.If:
        next();
        return parseIfStatement(tok);

      case T.While: {
        next();
        const condition = parseExpression();
        expect(T.Do, `to open a 'while' body`);
        const body = parseBlock();
        const end = expectEnd(tok, 'while');
        return { type: 'WhileStatement', condition, body, start: tok.start, end };
      }

      case T.Do: {
        next();
        const body = parseBlock();
        const end = expectEnd(tok, 'do');
        return { type: 'DoStatement', body, start: tok.start, end };
      }

      case T.For:
        next();
        return parseForStatement(tok);

      case T.Repeat: {
        next();
        const body = parseBlock();
        if (!expect(T.Until, `to close a 'repeat' block`)) {
          return { type: 'RepeatStatement', body, condition: missingIdentifier(), start: tok.start, end: peek().start };
        }
        const condition = parseExpression();
        return { type: 'RepeatStatement', body, condition, start: tok.start, end: condition.end };
      }

      case T.Function:
        next();
        return parseFunctionStatement(tok);

      case T.Local:
        next();
        return parseLocalStatement(tok);

      case T.Return: {
        next();
        const args: Expression[] = [];
        if (!BLOCK_END.has(peek().type) && !at(T.Semi)) {
          do {
            args.push(parseExpression());
          } while (accept(T.Comma));
        }
        accept(T.Semi);
        return { type: 'ReturnStatement', args, start: tok.start, end: args.at(-1)?.end ?? tok.end };
      }

      case T.Break:
        next();
        return { type: 'BreakStatement', start: tok.start, end: tok.end };

      case T.Continue:
        next();
        return { type: 'ContinueStatement', start: tok.start, end: tok.end };

      case T.Goto: {
        next();
        const label = parseName();
        return { type: 'GotoStatement', label, start: tok.start, end: label.end };
      }

      case T.DoubleColon: {
        next();
        const label = parseName();
        expect(T.DoubleColon, 'to close a label');
        return { type: 'LabelStatement', label, start: tok.start, end: peek(-1)?.end ?? label.end };
      }

      default:
        return parseExpressionStatement();
    }
  }

  const body = parseBlock();
  if (!at(T.EOF)) {
    error(`Unexpected '${peek().text}' after the end of the chunk.`);
  }

  const chunk: Chunk = { type: 'Chunk', body, start: 0, end: src.length };
  return { chunk, comments, errors, tokens };
}
