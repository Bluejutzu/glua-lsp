// Lexer for Lua 5.1 as GMod actually runs it: LuaJIT plus Garry's C-style
// operator aliases (`!`, `!=`, `&&`, `||`, `//`, `/* */`) and `continue`.
//
// It never throws. Malformed input produces an Invalid token plus a recorded
// error, so the rest of the pipeline keeps working on half-typed code.

export const enum T {
  EOF,
  Name,
  Number,
  String,
  // keywords
  And,
  Break,
  Continue,
  Do,
  Else,
  Elseif,
  End,
  False,
  For,
  Function,
  Goto,
  If,
  In,
  Local,
  Nil,
  Not,
  Or,
  Repeat,
  Return,
  Then,
  True,
  Until,
  While,
  // symbols
  Plus,
  Minus,
  Star,
  Slash,
  Percent,
  Caret,
  Hash,
  Eq,
  Ne,
  Le,
  Ge,
  Lt,
  Gt,
  Assign,
  LParen,
  RParen,
  LBrace,
  RBrace,
  LBracket,
  RBracket,
  DoubleColon,
  Semi,
  Colon,
  Comma,
  Dot,
  DotDot,
  Ellipsis,
  Invalid,
}

export interface Token {
  type: T;
  /** Source text exactly as written, so `!=` and `~=` stay distinguishable. */
  text: string;
  start: number;
  end: number;
  /** For String tokens: the decoded value. For Number tokens: the numeric value. */
  value?: string | number;
  /** True when a newline appeared between the previous token and this one. */
  newlineBefore?: boolean;
}

export interface Comment {
  start: number;
  end: number;
  text: string;
  /** `--`, `//`, `--[[`, `/*` */
  style: 'line' | 'cline' | 'long' | 'block';
}

export interface LexError {
  start: number;
  end: number;
  message: string;
}

const KEYWORDS = new Map<string, T>([
  ['and', T.And],
  ['break', T.Break],
  ['continue', T.Continue],
  ['do', T.Do],
  ['else', T.Else],
  ['elseif', T.Elseif],
  ['end', T.End],
  ['false', T.False],
  ['for', T.For],
  ['function', T.Function],
  ['goto', T.Goto],
  ['if', T.If],
  ['in', T.In],
  ['local', T.Local],
  ['nil', T.Nil],
  ['not', T.Not],
  ['or', T.Or],
  ['repeat', T.Repeat],
  ['return', T.Return],
  ['then', T.Then],
  ['true', T.True],
  ['until', T.Until],
  ['while', T.While],
]);

export const TOKEN_NAMES: Record<number, string> = {
  [T.EOF]: '<eof>',
  [T.Name]: 'identifier',
  [T.Number]: 'number',
  [T.String]: 'string',
  [T.And]: 'and',
  [T.Break]: 'break',
  [T.Continue]: 'continue',
  [T.Do]: 'do',
  [T.Else]: 'else',
  [T.Elseif]: 'elseif',
  [T.End]: 'end',
  [T.False]: 'false',
  [T.For]: 'for',
  [T.Function]: 'function',
  [T.Goto]: 'goto',
  [T.If]: 'if',
  [T.In]: 'in',
  [T.Local]: 'local',
  [T.Nil]: 'nil',
  [T.Not]: 'not',
  [T.Or]: 'or',
  [T.Repeat]: 'repeat',
  [T.Return]: 'return',
  [T.Then]: 'then',
  [T.True]: 'true',
  [T.Until]: 'until',
  [T.While]: 'while',
  [T.Plus]: "'+'",
  [T.Minus]: "'-'",
  [T.Star]: "'*'",
  [T.Slash]: "'/'",
  [T.Percent]: "'%'",
  [T.Caret]: "'^'",
  [T.Hash]: "'#'",
  [T.Eq]: "'=='",
  [T.Ne]: "'~='",
  [T.Le]: "'<='",
  [T.Ge]: "'>='",
  [T.Lt]: "'<'",
  [T.Gt]: "'>'",
  [T.Assign]: "'='",
  [T.LParen]: "'('",
  [T.RParen]: "')'",
  [T.LBrace]: "'{'",
  [T.RBrace]: "'}'",
  [T.LBracket]: "'['",
  [T.RBracket]: "']'",
  [T.DoubleColon]: "'::'",
  [T.Semi]: "';'",
  [T.Colon]: "':'",
  [T.Comma]: "','",
  [T.Dot]: "'.'",
  [T.DotDot]: "'..'",
  [T.Ellipsis]: "'...'",
  [T.Invalid]: 'invalid token',
};

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
  errors: LexError[];
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isHexDigit = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isNameStart = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
const isNamePart = (c: number) => isNameStart(c) || isDigit(c);

export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const errors: LexError[] = [];
  const n = src.length;
  let i = 0;
  let sawNewline = false;

  const error = (start: number, end: number, message: string) =>
    errors.push({ start, end, message });

  const push = (type: T, start: number, value?: string | number) => {
    const tok: Token = { type, text: src.slice(start, i), start, end: i };
    if (value !== undefined) tok.value = value;
    if (sawNewline) tok.newlineBefore = true;
    sawNewline = false;
    tokens.push(tok);
  };

  /** Reads `[==[ ... ]==]`. Returns null if `start` is not a long bracket open. */
  function readLongBracket(start: number): { body: string; level: number } | null {
    let p = start;
    if (src.charCodeAt(p) !== 91 /* [ */) return null;
    p++;
    let level = 0;
    while (src.charCodeAt(p) === 61 /* = */) {
      level++;
      p++;
    }
    if (src.charCodeAt(p) !== 91) return null;
    p++;
    // Lua skips a newline immediately after the opening bracket.
    if (src.charCodeAt(p) === 13) p++;
    if (src.charCodeAt(p) === 10) p++;
    const bodyStart = p;
    const close = ']' + '='.repeat(level) + ']';
    const at = src.indexOf(close, bodyStart);
    if (at === -1) {
      i = n;
      error(start, n, 'Unterminated long bracket.');
      return { body: src.slice(bodyStart), level };
    }
    i = at + close.length;
    return { body: src.slice(bodyStart, at), level };
  }

  function readShortString(quote: number) {
    const start = i;
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === quote) {
        i++;
        push(T.String, start, out);
        return;
      }
      if (c === 10 || c === 13) break; // unterminated
      if (c === 92 /* \ */) {
        i++;
        const e = src.charCodeAt(i);
        switch (e) {
          case 110: out += '\n'; i++; break; // n
          case 116: out += '\t'; i++; break; // t
          case 114: out += '\r'; i++; break; // r
          case 97: out += '\x07'; i++; break; // a
          case 98: out += '\b'; i++; break; // b
          case 102: out += '\f'; i++; break; // f
          case 118: out += '\v'; i++; break; // v
          case 92: out += '\\'; i++; break;
          case 34: out += '"'; i++; break;
          case 39: out += "'"; i++; break;
          case 10: out += '\n'; i++; break; // line continuation
          case 120: { // \xHH
            i++;
            let hex = '';
            while (hex.length < 2 && isHexDigit(src.charCodeAt(i))) hex += src[i++];
            out += String.fromCharCode(parseInt(hex || '0', 16));
            break;
          }
          default:
            if (isDigit(e)) {
              let dec = '';
              while (dec.length < 3 && isDigit(src.charCodeAt(i))) dec += src[i++];
              out += String.fromCharCode(parseInt(dec, 10));
            } else {
              // GLua tolerates unknown escapes by dropping the backslash.
              out += src[i] ?? '';
              i++;
            }
        }
        continue;
      }
      out += src[i];
      i++;
    }
    error(start, i, 'Unterminated string.');
    push(T.String, start, out);
  }

  function readNumber() {
    const start = i;
    if (src.charCodeAt(i) === 48 && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      i += 2;
      while (isHexDigit(src.charCodeAt(i)) || src[i] === '.') i++;
      if (src[i] === 'p' || src[i] === 'P') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (isDigit(src.charCodeAt(i))) i++;
      }
    } else if (src.charCodeAt(i) === 48 && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      i += 2;
      while (src[i] === '0' || src[i] === '1') i++;
    } else {
      while (isDigit(src.charCodeAt(i))) i++;
      if (src[i] === '.') {
        i++;
        while (isDigit(src.charCodeAt(i))) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (isDigit(src.charCodeAt(i))) i++;
      }
    }
    // LuaJIT 64-bit integer literals: 1LL, 1ULL
    const suffix = src.slice(i, i + 3).toUpperCase();
    if (suffix.startsWith('ULL')) i += 3;
    else if (suffix.startsWith('LL')) i += 2;

    const text = src.slice(start, i);
    const parsed = Number(text.replace(/[uUlL]+$/, ''));
    push(T.Number, start, Number.isNaN(parsed) ? 0 : parsed);
  }

  while (i < n) {
    const c = src.charCodeAt(i);

    // whitespace (0xFEFF is a UTF-8 BOM; plenty of GMod files are saved with one)
    if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
      i++;
      continue;
    }
    if (c === 10) {
      sawNewline = true;
      i++;
      continue;
    }

    // comments
    if (c === 45 /* - */ && src.charCodeAt(i + 1) === 45) {
      const start = i;
      i += 2;
      const long = readLongBracket(i);
      if (long) {
        comments.push({ start, end: i, text: long.body, style: 'long' });
      } else {
        while (i < n && src.charCodeAt(i) !== 10) i++;
        comments.push({ start, end: i, text: src.slice(start + 2, i), style: 'line' });
      }
      continue;
    }
    if (c === 47 /* / */ && src.charCodeAt(i + 1) === 47) {
      const start = i;
      i += 2;
      while (i < n && src.charCodeAt(i) !== 10) i++;
      comments.push({ start, end: i, text: src.slice(start + 2, i), style: 'cline' });
      continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42 /* * */) {
      const start = i;
      i += 2;
      const at = src.indexOf('*/', i);
      if (at === -1) {
        error(start, n, 'Unterminated block comment.');
        i = n;
      } else {
        i = at + 2;
      }
      comments.push({ start, end: i, text: src.slice(start + 2, i - 2), style: 'block' });
      continue;
    }

    // strings
    if (c === 34 || c === 39) {
      readShortString(c);
      continue;
    }
    if (c === 91) {
      const start = i;
      const long = readLongBracket(i);
      if (long) {
        push(T.String, start, long.body);
        continue;
      }
      i++;
      push(T.LBracket, start);
      continue;
    }

    // numbers
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      readNumber();
      continue;
    }

    // names & keywords
    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNamePart(src.charCodeAt(i))) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.get(word) ?? T.Name, start);
      continue;
    }

    // operators
    const start = i;
    const two = src.substr(i, 2);
    const three = src.substr(i, 3);

    if (three === '...') { i += 3; push(T.Ellipsis, start); continue; }
    if (two === '==') { i += 2; push(T.Eq, start); continue; }
    if (two === '~=' || two === '!=') { i += 2; push(T.Ne, start); continue; }
    if (two === '<=') { i += 2; push(T.Le, start); continue; }
    if (two === '>=') { i += 2; push(T.Ge, start); continue; }
    if (two === '..') { i += 2; push(T.DotDot, start); continue; }
    if (two === '::') { i += 2; push(T.DoubleColon, start); continue; }
    if (two === '&&') { i += 2; push(T.And, start); continue; }
    if (two === '||') { i += 2; push(T.Or, start); continue; }

    switch (c) {
      case 43: i++; push(T.Plus, start); continue;
      case 45: i++; push(T.Minus, start); continue;
      case 42: i++; push(T.Star, start); continue;
      case 47: i++; push(T.Slash, start); continue;
      case 37: i++; push(T.Percent, start); continue;
      case 94: i++; push(T.Caret, start); continue;
      case 35: i++; push(T.Hash, start); continue;
      case 33: i++; push(T.Not, start); continue; // GLua `!`
      case 60: i++; push(T.Lt, start); continue;
      case 62: i++; push(T.Gt, start); continue;
      case 61: i++; push(T.Assign, start); continue;
      case 40: i++; push(T.LParen, start); continue;
      case 41: i++; push(T.RParen, start); continue;
      case 123: i++; push(T.LBrace, start); continue;
      case 125: i++; push(T.RBrace, start); continue;
      case 93: i++; push(T.RBracket, start); continue;
      case 59: i++; push(T.Semi, start); continue;
      case 58: i++; push(T.Colon, start); continue;
      case 44: i++; push(T.Comma, start); continue;
      case 46: i++; push(T.Dot, start); continue;
      default:
        i++;
        error(start, i, `Unexpected character ${JSON.stringify(src[start])}.`);
        push(T.Invalid, start);
    }
  }

  sawNewline = false;
  tokens.push({ type: T.EOF, text: '', start: n, end: n });
  return { tokens, comments, errors };
}
