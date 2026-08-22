import type {
  Chunk,
  Expression,
  FunctionExpression,
  Identifier,
  Statement,
} from '../parser/ast.js';
import { walk } from '../parser/ast.js';
import type { Comment } from '../parser/lexer.js';
import type { ParseError } from '../parser/parser.js';
import { parse } from '../parser/parser.js';
import { GmodApi, HOOK_TABLES } from '../api/index.js';
import type { ApiFunction, Realm } from '../api/types.js';
import { LineIndex } from '../util/lines.js';
import { Scope, type VarSymbol } from './scope.js';
import { analyseRealm, realmAt, type RealmInfo } from './realm.js';
import { parseLuaDoc, typeFromDoc, type LuaDoc } from './luadoc.js';
import {
  BOOLEAN,
  NIL,
  NUMBER,
  STRING,
  UNKNOWN,
  classType,
  fromApiType,
  tableType,
  union,
  type GType,
} from './types.js';

export interface Span {
  start: number;
  end: number;
}

export interface GlobalDefinition {
  /** Dotted path exactly as written: `MyAddon.Config`, `PrintFoo`. */
  path: string;
  /** The leading global name. */
  root: string;
  nameSpan: Span;
  span: Span;
  kind: 'function' | 'table' | 'value';
  realm: Realm;
  doc?: string;
  params?: string[];
  isMethod?: boolean;
}

export interface GlobalReference {
  path: string;
  root: string;
  span: Span;
  write: boolean;
}

export interface HookAddFact {
  hookName: string;
  nameSpan: Span;
  identifier?: string;
  span: Span;
  realm: Realm;
  callbackParams: string[];
  hasCallback: boolean;
}

export interface HookRunFact {
  hookName: string;
  nameSpan: Span;
}

export interface NetOp {
  /** `WriteString`, `ReadEntity`, ... */
  method: string;
  /** The payload type: `String`, `Entity`, `UInt`, ... */
  payload: string;
  span: Span;
}

export interface NetStartFact {
  name: string;
  nameSpan: Span;
  span: Span;
  writes: NetOp[];
  realm: Realm;
  /** `net.Send`, `net.Broadcast`, `net.SendToServer`, ... */
  dispatch?: string;
}

export interface NetReceiveFact {
  name: string;
  nameSpan: Span;
  span: Span;
  reads: NetOp[];
  realm: Realm;
}

export interface NetRegisterFact {
  name: string;
  nameSpan: Span;
}

export interface FileReference {
  path: string;
  span: Span;
}

export type SymbolKindName = 'function' | 'method' | 'variable' | 'table' | 'field';

export interface SymbolFact {
  name: string;
  detail: string;
  kind: SymbolKindName;
  span: Span;
  selectionSpan: Span;
  children: SymbolFact[];
}

export interface FileAnalysis {
  uri: string;
  fsPath: string;
  version: number;
  text: string;
  lines: LineIndex;
  /**
   * False once the syntax tree has been released to save memory. Everything
   * below `symbols` stays valid; `chunk`, `root` and the closures do not.
   * Only ever false for files that are not open in the editor.
   */
  hasAst: boolean;
  chunk: Chunk;
  comments: Comment[];
  parseErrors: ParseError[];
  root: Scope;
  realm: RealmInfo;
  globalDefs: GlobalDefinition[];
  globalRefs: GlobalReference[];
  hookAdds: HookAddFact[];
  hookRuns: HookRunFact[];
  netRegisters: NetRegisterFact[];
  netStarts: NetStartFact[];
  netReceives: NetReceiveFact[];
  includes: FileReference[];
  addCSLuaFiles: FileReference[];
  concommands: FileReference[];
  convars: FileReference[];
  symbols: SymbolFact[];
  /**
   * Globals the file tests for existence before using — `if eightbit and ...`.
   * Reporting these as undefined would punish the correct way to depend on an
   * optional addon.
   */
  guardedGlobals: Set<string>;
  /** Locals that are declared but never read, for the unused diagnostic. */
  unusedLocals: VarSymbol[];
  typeOf(expr: Expression): GType;
  scopeAt(offset: number): Scope;
  docFor(offset: number): string | undefined;
}

export interface AnalyseOptions {
  /**
   * Resolves a global defined elsewhere in the workspace. Supplied by the
   * workspace index so single-file analysis stays usable on its own.
   */
  externalGlobal?: (path: string) => GType | undefined;
}

/**
 * Library functions whose documented return type is just `table`, but which
 * always yield an array of a known class. Makes `for _, ply in ipairs(...)`
 * produce a real Player.
 */
const ARRAY_RETURNS: Record<string, string> = {
  'player.GetAll': 'Player',
  'player.GetHumans': 'Player',
  'player.GetBots': 'Player',
  'team.GetPlayers': 'Player',
  'ents.GetAll': 'Entity',
  'ents.FindByClass': 'Entity',
  'ents.FindByClassAndParent': 'Entity',
  'ents.FindByModel': 'Entity',
  'ents.FindByName': 'Entity',
  'ents.FindInBox': 'Entity',
  'ents.FindInCone': 'Entity',
  'ents.FindInSphere': 'Entity',
  'ents.FindAlongRay': 'Entity',
  'Entity.GetChildren': 'Entity',
  'Player.GetWeapons': 'Weapon',
  'Entity.GetMaterials': 'string',
  'Panel.GetChildren': 'Panel',
};

/**
 * Callback signatures the wiki does not document in a <callback> block. Almost
 * everything else comes from the scraped data itself.
 */
const CALLBACK_PARAMS: Record<string, { arg: number; params: { name: string; type: string }[] }> = {
  'net.Receive': {
    arg: 1,
    params: [
      { name: 'len', type: 'number' },
      { name: 'ply', type: 'Player' },
    ],
  },
  'usermessage.Hook': {
    arg: 1,
    params: [{ name: 'msg', type: 'bf_read' }],
  },
};

/** Classes whose metatables overload +, -, * and /. */
const OPERATOR_CLASSES = new Set(['Vector', 'Angle', 'VMatrix']);

/**
 * The types worth guessing at when a parameter is used but never annotated.
 * Kept to things people actually pass between functions.
 */
const DUCK_TYPE_CANDIDATES = [
  'Entity', 'Player', 'Weapon', 'NPC', 'Vehicle', 'NextBot', 'CSEnt',
  'Panel', 'Vector', 'Angle', 'VMatrix', 'PhysObj', 'ConVar', 'File',
  'CUserCmd', 'CMoveData', 'CTakeDamageInfo', 'CNavArea', 'IMaterial',
  'ITexture', 'CSoundPatch', 'CRecipientFilter', 'Color', 'bf_read',
];

/** Global constants GMod defines in Lua, so they never reach the wiki dump. */
const TYPED_CONSTANTS: Record<string, string> = {
  vector_origin: 'Vector',
  vector_up: 'Vector',
  angle_zero: 'Angle',
  color_white: 'Color',
  color_black: 'Color',
  color_transparent: 'Color',
};

const NET_WRITE = /^Write([A-Za-z0-9]+)$/;
const NET_READ = /^Read([A-Za-z0-9]+)$/;
const NET_DISPATCH = new Set([
  'Send', 'SendToServer', 'Broadcast', 'SendOmit', 'SendPVS', 'SendPAS',
]);

/** Dotted/colon path for an identifier chain, or null if it is not one. */
export function exprToPath(expr: Expression): string | null {
  switch (expr.type) {
    case 'Identifier':
      return expr.missing ? null : expr.name;
    case 'MemberExpression': {
      const base = exprToPath(expr.base);
      if (base === null || expr.identifier.missing) return null;
      return `${base}${expr.indexer}${expr.identifier.name}`;
    }
    default:
      return null;
  }
}

/** Root identifier of a member chain. */
function rootIdentifier(expr: Expression): Identifier | null {
  let current: Expression = expr;
  for (;;) {
    if (current.type === 'Identifier') return current;
    if (current.type === 'MemberExpression' || current.type === 'IndexExpression') {
      current = current.base;
      continue;
    }
    return null;
  }
}

const stringArg = (args: Expression[], i: number): { value: string; span: Span } | null => {
  const arg = args[i];
  if (!arg || arg.type !== 'StringLiteral') return null;
  return { value: arg.value, span: { start: arg.start, end: arg.end } };
};

export function analyseFile(
  uri: string,
  fsPath: string,
  text: string,
  version: number,
  api: GmodApi,
  options: AnalyseOptions = {},
): FileAnalysis {
  const { chunk, comments, errors: parseErrors } = parse(text);
  const lines = new LineIndex(text);
  const realm = analyseRealm(fsPath, chunk);

  const root = new Scope(null, 0, text.length, true);
  const globalDefs: GlobalDefinition[] = [];
  const globalRefs: GlobalReference[] = [];
  const hookAdds: HookAddFact[] = [];
  const hookRuns: HookRunFact[] = [];
  const netRegisters: NetRegisterFact[] = [];
  const netStarts: NetStartFact[] = [];
  const netReceives: NetReceiveFact[] = [];
  const includes: FileReference[] = [];
  const addCSLuaFiles: FileReference[] = [];
  const concommands: FileReference[] = [];
  const convars: FileReference[] = [];
  const symbols: SymbolFact[] = [];

  const typeCache = new WeakMap<Expression, GType>();
  const inferring = new Set<Expression>();
  /** Doc comment of the statement currently being bound, for its function. */
  let pendingDoc: LuaDoc | null = null;
  /** Filled while binding, consumed by net read/write pairing. */
  let netOpSink: { writes: NetOp[]; reads: NetOp[] } | null = null;

  /* ------------------------------------------------------------- comments */

  // Line -> the comment that ends on it, for doc-comment lookup.
  const commentByEndLine = new Map<number, Comment>();
  for (const comment of comments) {
    if (comment.style === 'line' || comment.style === 'cline') {
      commentByEndLine.set(lines.lineOf(comment.end), comment);
    } else {
      commentByEndLine.set(lines.lineOf(comment.end), comment);
    }
  }

  function docFor(offset: number): string | undefined {
    const declLine = lines.lineOf(offset);
    const collected: string[] = [];
    for (let line = declLine - 1; line >= 0; line--) {
      const comment = commentByEndLine.get(line);
      if (!comment) {
        // Allow the comment block to sit directly above only.
        if (collected.length) break;
        if (lines.lineText(line).trim() === '') continue;
        break;
      }
      // Only take the comment if it is the whole line.
      const before = text.slice(lines.lineStart(lines.lineOf(comment.start)), comment.start);
      if (before.trim() !== '') break;
      collected.unshift(comment.text.replace(/^-+/, '').trim());
      line = lines.lineOf(comment.start);
    }
    const doc = collected.join('\n').trim();
    return doc || undefined;
  }

  /* ------------------------------------------------------------ inference */

  function resolveIdentifierType(name: string, offset: number, scope: Scope): GType {
    const local = scope.lookup(name, offset);
    if (local) return local.type;

    if (api.getLibrary(name)) return tableType({ library: name });
    const global = api.getGlobal(name);
    if (global) return { kind: 'function', api: global, name };
    if (api.getEnum(name)) return NUMBER;
    if (name in HOOK_TABLES) return tableType({ hookTable: HOOK_TABLES[name]!.hookParent });
    if (name === 'CLIENT' || name === 'SERVER' || name === 'MENU_DLL') return BOOLEAN;
    const constant = TYPED_CONSTANTS[name];
    if (constant) return classType(constant);

    const external = options.externalGlobal?.(name);
    if (external) return external;
    return UNKNOWN;
  }

  function memberType(base: GType, name: string): GType {
    switch (base.kind) {
      case 'table': {
        if (base.library) {
          const fn = api.getLibrary(base.library)?.[name];
          if (fn) return { kind: 'function', api: fn, name: `${base.library}.${name}` };
          // Some libraries are also documented as classes (Panel, PropSelect).
          const asClass = api.getClassMember(base.library, name);
          if (asClass) return { kind: 'function', api: asClass, name };
          return UNKNOWN;
        }
        if (base.struct) {
          const field = api.getStruct(base.struct)?.fields.find((f) => f.name === name);
          return field ? fromApiType(field.type, api) : UNKNOWN;
        }
        if (base.hookTable) {
          const hook = api.getHooksFor(base.hookTable)[name];
          if (hook) return { kind: 'function', api: hook, name };
          return base.members?.get(name) ?? UNKNOWN;
        }
        return base.members?.get(name) ?? UNKNOWN;
      }
      case 'class': {
        const fn = api.getClassMember(base.name, name);
        if (fn) return { kind: 'function', api: fn, name: `${base.name}:${name}` };
        return UNKNOWN;
      }
      case 'union':
        return union(base.options.map((opt) => memberType(opt, name)));
      default:
        return UNKNOWN;
    }
  }

  function returnTypeOfApi(fn: ApiFunction, path: string | null, args: Expression[], scope: Scope): GType {
    // Panel and metatable constructors carry their real type in a string arg.
    if (path === 'vgui.Create' || path === 'vgui.CreateFromTable') {
      const literal = stringArg(args, 0);
      if (literal && api.isClass(literal.value)) return classType(literal.value);
      return classType('Panel');
    }
    if (path === 'FindMetaTable') {
      const literal = stringArg(args, 0);
      if (literal && api.isClass(literal.value)) return classType(literal.value);
      return tableType();
    }
    if (path === 'Panel.Add' || path === 'Panel:Add') {
      const literal = stringArg(args, 0);
      if (literal && api.isClass(literal.value)) return classType(literal.value);
    }
    if (path && ARRAY_RETURNS[path]) {
      const element = ARRAY_RETURNS[path]!;
      return tableType({ element: api.isClass(element) ? classType(element) : fromApiType(element, api) });
    }

    const first = fn.returns[0];
    if (!first) return UNKNOWN;
    void scope;
    return fromApiType(first.type, api);
  }

  function inferFunctionReturn(node: FunctionExpression, scope: Scope): GType {
    const returns: GType[] = [];
    const visit = (body: Statement[]) => {
      for (const stat of body) {
        switch (stat.type) {
          case 'ReturnStatement':
            returns.push(stat.args[0] ? inferType(stat.args[0], scope) : NIL);
            break;
          case 'IfStatement':
            for (const clause of stat.clauses) visit(clause.body);
            break;
          case 'DoStatement':
          case 'WhileStatement':
          case 'RepeatStatement':
          case 'NumericForStatement':
          case 'GenericForStatement':
            visit(stat.body);
            break;
          default:
            break;
        }
      }
    };
    visit(node.body);
    return returns.length ? union(returns) : UNKNOWN;
  }

  /**
   * The nth value of a multiple-return expression.
   *
   * `local w, h = ScrW(), ScrH()` is easy; `local a, b = f()` needs the
   * function's second documented return, and guessing the first for both is how
   * a number ends up looking like a table.
   */
  function nthValueOf(expr: Expression, index: number, scope: Scope): GType {
    if (index === 0) return inferType(expr, scope);
    if (expr.type !== 'CallExpression') return UNKNOWN;
    const baseType = inferType(expr.base, scope);
    if (baseType.kind !== 'function' || !baseType.api) return UNKNOWN;
    const ret = baseType.api.returns[index];
    return ret ? fromApiType(ret.type, api) : UNKNOWN;
  }

  function inferType(expr: Expression, scope: Scope): GType {
    const cached = typeCache.get(expr);
    if (cached) return cached;
    if (inferring.has(expr)) return UNKNOWN; // recursive definition
    inferring.add(expr);

    let result: GType = UNKNOWN;
    switch (expr.type) {
      case 'NumberLiteral':
        result = NUMBER;
        break;
      case 'StringLiteral':
        result = STRING;
        break;
      case 'BooleanLiteral':
        result = BOOLEAN;
        break;
      case 'NilLiteral':
        result = NIL;
        break;
      case 'VarargLiteral':
        result = { kind: 'vararg' };
        break;
      case 'FunctionExpression':
        result = { kind: 'function', node: expr };
        break;
      case 'TableConstructor': {
        const members = new Map<string, GType>();
        const elements: GType[] = [];
        for (const field of expr.fields) {
          if (field.kind === 'name' && field.key?.type === 'Identifier') {
            members.set(field.key.name, inferType(field.value, scope));
          } else if (field.kind === 'index' && field.key?.type === 'StringLiteral') {
            members.set(field.key.value, inferType(field.value, scope));
          } else if (field.kind === 'list') {
            elements.push(inferType(field.value, scope));
          }
        }
        result = tableType({
          members,
          node: expr,
          ...(elements.length ? { element: union(elements) } : {}),
        });
        break;
      }
      case 'UnaryExpression': {
        if (expr.operator === 'not') {
          result = BOOLEAN;
        } else if (expr.operator === '#') {
          result = NUMBER;
        } else {
          // Unary minus is overloaded on Vector and Angle, and says nothing
          // useful about an operand we could not infer.
          const operand = inferType(expr.argument, scope);
          result =
            operand.kind === 'class' && OPERATOR_CLASSES.has(operand.name)
              ? operand
              : operand.kind === 'unknown'
                ? UNKNOWN
                : NUMBER;
        }
        break;
      }
      case 'BinaryExpression':
        switch (expr.operator) {
          case '..':
            result = STRING;
            break;
          case '==': case '~=': case '<': case '<=': case '>': case '>=':
            result = BOOLEAN;
            break;
          case 'and':
            result = inferType(expr.right, scope);
            break;
          case 'or':
            result = union([inferType(expr.left, scope), inferType(expr.right, scope)]);
            break;
          default: {
            // Vector, Angle and VMatrix overload the arithmetic metamethods, so
            // `pos + dir * 32` is a Vector, not a number. And when an operand is
            // unknown the result is unknown too — claiming `number` there is
            // what turns an un-inferable expression into a bogus type error.
            const left = inferType(expr.left, scope);
            const right = inferType(expr.right, scope);
            if (left.kind === 'class' && OPERATOR_CLASSES.has(left.name)) result = left;
            else if (right.kind === 'class' && OPERATOR_CLASSES.has(right.name)) result = right;
            else if (left.kind === 'unknown' || right.kind === 'unknown') result = UNKNOWN;
            else result = NUMBER;
          }
        }
        break;
      case 'Identifier':
        result = resolveIdentifierType(expr.name, expr.start, scope);
        break;
      case 'MemberExpression': {
        if (expr.identifier.missing) {
          result = UNKNOWN;
          break;
        }
        const path = exprToPath(expr);
        const external = path ? options.externalGlobal?.(path) : undefined;
        if (external) {
          result = external;
          break;
        }
        result = memberType(inferType(expr.base, scope), expr.identifier.name);
        break;
      }
      case 'IndexExpression': {
        const base = inferType(expr.base, scope);
        if (expr.index.type === 'StringLiteral') {
          result = memberType(base, expr.index.value);
        } else if (base.kind === 'table' && base.element) {
          result = base.element;
        }
        break;
      }
      case 'CallExpression': {
        const baseType = inferType(expr.base, scope);
        const path = exprToPath(expr.base);
        if (baseType.kind === 'function') {
          if (baseType.api) {
            result = returnTypeOfApi(baseType.api, path ?? baseType.name ?? null, expr.args, scope);
          } else if (baseType.node) {
            result = inferFunctionReturn(baseType.node, scope);
          }
        }
        break;
      }
      default:
        result = UNKNOWN;
    }

    inferring.delete(expr);
    typeCache.set(expr, result);
    return result;
  }

  /* --------------------------------------------------------------- facts */

  function recordGlobal(target: Expression, valueType: GType, span: Span, doc?: string): void {
    const path = exprToPath(target);
    const rootId = rootIdentifier(target);
    if (!path || !rootId) return;
    if (root.lookup(rootId.name, rootId.start)) return; // it's a local, not a global

    const kind: GlobalDefinition['kind'] =
      valueType.kind === 'function' ? 'function' : valueType.kind === 'table' ? 'table' : 'value';

    const def: GlobalDefinition = {
      path,
      root: rootId.name,
      nameSpan:
        target.type === 'MemberExpression'
          ? { start: target.identifier.start, end: target.identifier.end }
          : { start: target.start, end: target.end },
      span,
      kind,
      realm: realmAt(realm, span.start),
      isMethod: target.type === 'MemberExpression' && target.indexer === ':',
    };
    if (doc) def.doc = doc;
    if (valueType.kind === 'function' && valueType.node) {
      def.params = valueType.node.params.map((p) => (p.type === 'VarargLiteral' ? '...' : p.name));
    }
    globalDefs.push(def);
  }

  function recordCallFacts(call: Extract<Expression, { type: 'CallExpression' }>, scope: Scope): void {
    const path = exprToPath(call.base);
    if (!path) return;
    const args = call.args;
    const span = { start: call.start, end: call.end };

    switch (path) {
      case 'hook.Add': {
        const name = stringArg(args, 0);
        if (!name) break;
        const idArg = args[1];
        const callback = args[2];
        const fact: HookAddFact = {
          hookName: name.value,
          nameSpan: name.span,
          span,
          realm: realmAt(realm, call.start),
          callbackParams:
            callback?.type === 'FunctionExpression'
              ? callback.params.map((p) => (p.type === 'VarargLiteral' ? '...' : p.name))
              : [],
          hasCallback: Boolean(callback),
        };
        if (idArg?.type === 'StringLiteral') fact.identifier = idArg.value;
        hookAdds.push(fact);
        break;
      }
      case 'hook.Run':
      case 'hook.Call': {
        const name = stringArg(args, 0);
        if (name) hookRuns.push({ hookName: name.value, nameSpan: name.span });
        break;
      }
      case 'gameevent.Listen': {
        // Listening to an engine game event makes its name a valid hook.Add
        // target, which is otherwise indistinguishable from a typo.
        const name = stringArg(args, 0);
        if (name) hookRuns.push({ hookName: name.value, nameSpan: name.span });
        break;
      }
      case 'util.AddNetworkString': {
        const name = stringArg(args, 0);
        if (name) netRegisters.push({ name: name.value, nameSpan: name.span });
        break;
      }
      case 'net.Start': {
        const name = stringArg(args, 0);
        if (!name) break;
        netStarts.push({
          name: name.value,
          nameSpan: name.span,
          span,
          writes: [],
          realm: realmAt(realm, call.start),
        });
        // Everything written until the next dispatch belongs to this message.
        netOpSink = { writes: netStarts.at(-1)!.writes, reads: [] };
        break;
      }
      case 'net.Receive': {
        const name = stringArg(args, 0);
        if (!name) break;
        const fact: NetReceiveFact = {
          name: name.value,
          nameSpan: name.span,
          span,
          reads: [],
          realm: realmAt(realm, call.start),
        };
        netReceives.push(fact);
        break;
      }
      case 'include':
      case 'IncludeCS': {
        const file = stringArg(args, 0);
        if (file) includes.push({ path: file.value, span: file.span });
        break;
      }
      case 'AddCSLuaFile': {
        const file = stringArg(args, 0);
        if (file) addCSLuaFiles.push({ path: file.value, span: file.span });
        else addCSLuaFiles.push({ path: '', span });
        break;
      }
      case 'concommand.Add': {
        const name = stringArg(args, 0);
        if (name) concommands.push({ path: name.value, span: name.span });
        break;
      }
      case 'CreateConVar':
      case 'CreateClientConVar': {
        const name = stringArg(args, 0);
        if (name) convars.push({ path: name.value, span: name.span });
        break;
      }
      default:
        break;
    }

    // net.WriteX / net.ReadX sequencing.
    if (path.startsWith('net.')) {
      const method = path.slice(4);
      const write = NET_WRITE.exec(method);
      const read = NET_READ.exec(method);
      if (write && netOpSink) {
        netOpSink.writes.push({ method, payload: write[1]!, span });
      } else if (read && netOpSink) {
        netOpSink.reads.push({ method, payload: read[1]!, span });
      } else if (NET_DISPATCH.has(method)) {
        const open = netStarts.at(-1);
        if (open && !open.dispatch) open.dispatch = `net.${method}`;
        netOpSink = null;
      }
    }

    void scope;
  }

  /** Binds callback parameter types for well-known higher-order API calls. */
  function typedCallbackParams(
    call: Extract<Expression, { type: 'CallExpression' }>,
    argIndex: number,
  ): { name: string; type: string }[] | null {
    const path = exprToPath(call.base);
    if (!path) return null;

    if (path === 'hook.Add' && argIndex === 2) {
      const name = stringArg(call.args, 0);
      if (!name) return null;
      const hook = api.getGlobalHook(name.value);
      if (!hook) return null;
      return hook.params.map((p) => ({ name: p.name, type: p.type }));
    }

    const known = CALLBACK_PARAMS[path];
    if (known && known.arg === argIndex) return known.params;

    // The wiki documents most callback signatures inline; use them.
    const calleeType = inferType(call.base, scopeForCall(call));
    if (calleeType.kind === 'function' && calleeType.api) {
      const documented = calleeType.api.params[argIndex]?.callback;
      if (documented?.length) {
        return documented.map((p) => ({ name: p.name, type: p.type }));
      }
    }
    return null;
  }

  /** The scope a call sits in — callbacks are resolved before binding descends. */
  function scopeForCall(call: Extract<Expression, { type: 'CallExpression' }>): Scope {
    return root.scopeAt(call.start);
  }

  /* -------------------------------------------------------------- binding */

  function bindFunction(
    node: FunctionExpression,
    parent: Scope,
    selfType: GType | null,
    paramTypes?: { name: string; type: string }[] | null,
    doc?: LuaDoc,
  ): void {
    // A doc comment sits above the statement, not the function expression, so
    // the statement stashes it here for whichever function it introduces.
    const effectiveDoc = doc ?? pendingDoc;
    pendingDoc = null;

    const scope = new Scope(parent, node.start, node.end, true);

    if (node.isMethod || selfType) {
      scope.declare('self', 'self', node.start, node.start, node.start, selfType ?? UNKNOWN);
    }

    const declared: VarSymbol[] = [];
    node.params.forEach((param, i) => {
      if (param.type === 'VarargLiteral') {
        scope.declare('...', 'vararg', param.start, param.end, node.start, { kind: 'vararg' });
        return;
      }

      // An explicit ---@param annotation beats anything we could infer.
      const annotation = effectiveDoc?.params.get(param.name);
      const documented = paramTypes?.[i];
      const type = annotation
        ? typeFromDoc(annotation.type, api)
        : documented
          ? fromApiType(documented.type, api)
          : UNKNOWN;

      const symbol = scope.declare(param.name, 'param', param.start, param.end, node.start, type);
      if (annotation?.description) symbol.doc = annotation.description;
      declared.push(symbol);
    });

    bindBlock(node.body, scope);

    // Anything still untyped: work it out from the methods called on it.
    for (const symbol of declared) {
      if (symbol.type.kind === 'unknown') {
        const inferred = classFromUsage(symbol, node);
        if (inferred) symbol.type = inferred;
      }
    }
  }

  /**
   * Duck-types a parameter from the methods called on it.
   *
   * `function f(ply) ply:IsAdmin() end` can only be a Player, because nothing
   * else has IsAdmin. Ambiguous method sets are left alone rather than guessed.
   */
  function classFromUsage(symbol: VarSymbol, node: FunctionExpression): GType | null {
    const methods = new Set<string>();
    walk(node, (child) => {
      if (child.type !== 'MemberExpression' || child.indexer !== ':') return;
      if (child.base.type !== 'Identifier' || child.base.name !== symbol.name) return;
      if (child.identifier.missing) return;
      // Make sure this really is our parameter and not a shadowing local.
      if (root.scopeAt(child.base.start).lookup(symbol.name, child.base.start) !== symbol) return;
      methods.add(child.identifier.name);
    });
    if (!methods.size) return null;

    const matches = (className: string) => {
      const members = api.getClassMembers(className);
      for (const method of methods) {
        if (!members.has(method)) return false;
      }
      return true;
    };

    // Try the classes people actually pass around first. Searching every class
    // would let the ~90 panel types outvote Entity on a method they share.
    let candidates = DUCK_TYPE_CANDIDATES.filter(matches);
    if (!candidates.length) candidates = api.classNames().filter(matches);
    if (!candidates.length) return null;
    if (candidates.length === 1) return classType(candidates[0]!);

    // Several match: prefer the one the others inherit from.
    const isAncestor = (ancestor: string, child: string): boolean => {
      for (let c: string | undefined = child; c; c = api.parentOf(c)) {
        if (c === ancestor) return true;
      }
      return false;
    };

    let best: string | null = null;
    let bestCoverage = 0;
    for (const candidate of candidates) {
      const coverage = candidates.filter((other) => isAncestor(candidate, other)).length;
      if (coverage > bestCoverage) {
        best = candidate;
        bestCoverage = coverage;
      }
    }

    // Only commit when one candidate accounts for most of the others.
    return best && bestCoverage / candidates.length >= 0.6 ? classType(best) : null;
  }

  function bindExpression(expr: Expression, scope: Scope): void {
    switch (expr.type) {
      case 'Identifier': {
        if (expr.missing) break;
        const local = scope.lookup(expr.name, expr.start);
        if (local) {
          local.refs.push({ start: expr.start, end: expr.end, write: false });
        } else {
          globalRefs.push({
            path: expr.name,
            root: expr.name,
            span: { start: expr.start, end: expr.end },
            write: false,
          });
        }
        break;
      }
      case 'MemberExpression': {
        bindExpression(expr.base, scope);
        const rootId = rootIdentifier(expr);
        if (rootId && !scope.lookup(rootId.name, rootId.start) && !expr.identifier.missing) {
          const path = exprToPath(expr);
          if (path) {
            globalRefs.push({
              path,
              root: rootId.name,
              span: { start: expr.identifier.start, end: expr.identifier.end },
              write: false,
            });
          }
        }
        break;
      }
      case 'IndexExpression':
        bindExpression(expr.base, scope);
        bindExpression(expr.index, scope);
        break;
      case 'CallExpression': {
        bindExpression(expr.base, scope);
        expr.args.forEach((arg, i) => {
          if (arg.type === 'FunctionExpression') {
            bindFunction(arg, scope, null, typedCallbackParams(expr, i));
          } else {
            bindExpression(arg, scope);
          }
        });
        recordCallFacts(expr, scope);
        // Attach net.Read* calls inside a net.Receive callback to that receiver.
        break;
      }
      case 'FunctionExpression':
        bindFunction(expr, scope, null);
        break;
      case 'TableConstructor':
        for (const field of expr.fields) {
          if (field.key && field.kind === 'index') bindExpression(field.key, scope);
          bindExpression(field.value, scope);
        }
        break;
      case 'BinaryExpression':
        bindExpression(expr.left, scope);
        bindExpression(expr.right, scope);
        break;
      case 'UnaryExpression':
        bindExpression(expr.argument, scope);
        break;
      default:
        break;
    }
  }

  /** `self` for `function X:Y()` given the base expression `X`. */
  function selfTypeFor(base: Expression, scope: Scope): GType {
    const name = base.type === 'Identifier' ? base.name : null;
    if (name && HOOK_TABLES[name]) {
      const cls = HOOK_TABLES[name]!.selfClass;
      return cls === 'table' ? tableType() : classType(cls);
    }
    return inferType(base, scope);
  }

  /** Hook parameter types for `function GM:PlayerSpawn(ply)` style definitions. */
  function hookParamsFor(target: Expression): { name: string; type: string }[] | null {
    if (target.type !== 'MemberExpression' || target.base.type !== 'Identifier') return null;
    const table = HOOK_TABLES[target.base.name];
    if (!table || target.identifier.missing) return null;
    const hook = api.getHooksFor(table.hookParent)[target.identifier.name];
    if (!hook) return null;
    return hook.params.map((p) => ({ name: p.name, type: p.type }));
  }

  function bindStatement(stat: Statement, scope: Scope): void {
    switch (stat.type) {
      case 'LocalStatement': {
        // Parse the doc first: a function in the initialiser needs the
        // ---@param annotations while its own scope is being built.
        const doc = parseLuaDoc(docFor(stat.start), api);
        pendingDoc = doc;
        for (const expr of stat.init) bindExpression(expr, scope);
        pendingDoc = null;

        // `---@type Player` overrides whatever the initialiser looked like.
        const annotated = doc.type ? typeFromDoc(doc.type, api) : null;

        stat.names.forEach((name, i) => {
          const inferred =
            stat.init.length === 1
              ? nthValueOf(stat.init[0]!, i, scope)
              : stat.init[i]
                ? inferType(stat.init[i]!, scope)
                : UNKNOWN;
          const type = annotated && i === 0 ? annotated : inferred;
          const sym = scope.declare(name.name, 'local', name.start, name.end, stat.end, type);
          if (doc.description) sym.doc = doc.description;
        });
        break;
      }

      case 'AssignmentStatement': {
        const parsed = parseLuaDoc(docFor(stat.start), api);
        pendingDoc = parsed;
        for (const expr of stat.init) bindExpression(expr, scope);
        pendingDoc = null;

        const doc = parsed.description || undefined;
        stat.targets.forEach((target, i) => {
          const value = stat.init[i];
          const valueType = value ? inferType(value, scope) : UNKNOWN;

          if (target.type === 'Identifier') {
            const local = scope.lookup(target.name, target.start);
            if (local) {
              local.refs.push({ start: target.start, end: target.end, write: true });
              if (local.type.kind === 'unknown') local.type = valueType;
            } else {
              globalRefs.push({
                path: target.name,
                root: target.name,
                span: { start: target.start, end: target.end },
                write: true,
              });
              recordGlobal(target, valueType, { start: stat.start, end: stat.end }, doc);
            }
          } else {
            bindExpression(target, scope);
            recordGlobal(target, valueType, { start: stat.start, end: stat.end }, doc);
          }

          if (value?.type === 'FunctionExpression') {
            // Already bound above, but a method assignment needs `self`.
            void value;
          }
        });
        break;
      }

      case 'CallStatement':
        bindExpression(stat.expression, scope);
        break;

      case 'FunctionDeclaration': {
        const parsed = parseLuaDoc(docFor(stat.start), api);
        const doc = parsed.description || undefined;
        const target = stat.identifier;

        if (stat.isLocal && target?.type === 'Identifier') {
          // Visible inside its own body so recursion resolves.
          const sym = scope.declare(target.name, 'local', target.start, target.end, target.start, {
            kind: 'function',
            node: stat.func,
          });
          if (doc) sym.doc = doc;
          bindFunction(stat.func, scope, null, null, parsed);
          break;
        }

        let selfType: GType | null = null;
        let paramTypes: { name: string; type: string }[] | null = null;

        if (target?.type === 'MemberExpression') {
          bindExpression(target.base, scope);
          if (target.indexer === ':') selfType = selfTypeFor(target.base, scope);
          paramTypes = hookParamsFor(target);
        } else if (target?.type === 'Identifier') {
          const local = scope.lookup(target.name, target.start);
          if (local) {
            local.refs.push({ start: target.start, end: target.end, write: true });
            local.type = { kind: 'function', node: stat.func };
          }
        }

        bindFunction(stat.func, scope, selfType, paramTypes, parsed);

        if (target) {
          const rootId = rootIdentifier(target);
          if (rootId && !scope.lookup(rootId.name, rootId.start)) {
            recordGlobal(
              target,
              { kind: 'function', node: stat.func },
              { start: stat.start, end: stat.end },
              doc,
            );
          }
        }
        break;
      }

      case 'DoStatement': {
        const inner = new Scope(scope, stat.start, stat.end);
        bindBlock(stat.body, inner);
        break;
      }

      case 'WhileStatement': {
        bindExpression(stat.condition, scope);
        const inner = new Scope(scope, stat.start, stat.end);
        bindBlock(stat.body, inner);
        break;
      }

      case 'RepeatStatement': {
        // The `until` condition can see locals from the body.
        const inner = new Scope(scope, stat.start, stat.end);
        bindBlock(stat.body, inner);
        bindExpression(stat.condition, inner);
        break;
      }

      case 'IfStatement':
        for (const clause of stat.clauses) {
          if (clause.condition) bindExpression(clause.condition, scope);
          const inner = new Scope(scope, clause.start, clause.end);
          bindBlock(clause.body, inner);
        }
        break;

      case 'NumericForStatement': {
        bindExpression(stat.from, scope);
        bindExpression(stat.to, scope);
        if (stat.step) bindExpression(stat.step, scope);
        const inner = new Scope(scope, stat.start, stat.end);
        inner.declare(stat.variable.name, 'loop', stat.variable.start, stat.variable.end, stat.start, NUMBER);
        bindBlock(stat.body, inner);
        break;
      }

      case 'GenericForStatement': {
        for (const iterator of stat.iterators) bindExpression(iterator, scope);
        const inner = new Scope(scope, stat.start, stat.end);

        // `for k, v in pairs(t)` / `ipairs(t)` -> type k and v from t.
        const iterator = stat.iterators[0];
        let keyType: GType = UNKNOWN;
        let valueType: GType = UNKNOWN;
        if (iterator?.type === 'CallExpression') {
          const fn = exprToPath(iterator.base);
          const subject = iterator.args[0] ? inferType(iterator.args[0], scope) : UNKNOWN;
          if (fn === 'ipairs') {
            keyType = NUMBER;
            valueType = subject.kind === 'table' ? (subject.element ?? UNKNOWN) : UNKNOWN;
          } else if (fn === 'pairs') {
            valueType = subject.kind === 'table' ? (subject.element ?? UNKNOWN) : UNKNOWN;
          }
        }

        stat.names.forEach((name, i) => {
          const type = i === 0 ? keyType : i === 1 ? valueType : UNKNOWN;
          inner.declare(name.name, 'loop', name.start, name.end, stat.start, type);
        });
        bindBlock(stat.body, inner);
        break;
      }

      case 'ReturnStatement':
        for (const arg of stat.args) bindExpression(arg, scope);
        break;

      default:
        break;
    }
  }

  function bindBlock(body: Statement[], scope: Scope): void {
    for (const stat of body) bindStatement(stat, scope);
  }

  bindBlock(chunk.body, root);

  /* ------------------------------------------------- net receive payloads */

  // net.Read* calls belong to whichever net.Receive body encloses them. Doing
  // this as a second pass is simpler than threading receiver state through the
  // binder, and it correctly reaches reads nested inside the callback.
  {
    const reads: NetOp[] = [];
    walk(chunk, (node) => {
      if (node.type !== 'CallExpression') return;
      const path = exprToPath(node.base);
      if (!path?.startsWith('net.')) return;
      const match = NET_READ.exec(path.slice(4));
      if (match) {
        reads.push({
          method: path.slice(4),
          payload: match[1]!,
          span: { start: node.start, end: node.end },
        });
      }
    });

    for (const receive of netReceives) {
      receive.reads = reads.filter(
        (op) => op.span.start >= receive.span.start && op.span.end <= receive.span.end,
      );
    }
  }

  /* ----------------------------------------------------- guarded globals */

  const guardedGlobals = new Set<string>();
  {
    const markGuarded = (expr: Expression | null): void => {
      if (!expr) return;
      // The root of a member chain is what the guard actually tests.
      const rootId = rootIdentifier(expr);
      if (rootId && !rootId.missing) guardedGlobals.add(rootId.name);
    };

    walk(chunk, (node) => {
      switch (node.type) {
        case 'BinaryExpression':
          if (node.operator === 'and' || node.operator === 'or') {
            markGuarded(node.left);
          } else if (node.operator === '==' || node.operator === '~=') {
            if (node.right.type === 'NilLiteral') markGuarded(node.left);
            if (node.left.type === 'NilLiteral') markGuarded(node.right);
          }
          break;
        case 'UnaryExpression':
          if (node.operator === 'not') markGuarded(node.argument);
          break;
        case 'IfClause':
          markGuarded(node.condition);
          break;
        case 'WhileStatement':
          markGuarded(node.condition);
          break;
        default:
          break;
      }
    });
  }

  /* ------------------------------------------------------------- symbols */

  for (const def of globalDefs) {
    symbols.push({
      name: def.path,
      detail: def.kind === 'function' ? `(${(def.params ?? []).join(', ')})` : def.kind,
      kind: def.kind === 'function' ? (def.isMethod ? 'method' : 'function') : def.kind === 'table' ? 'table' : 'variable',
      span: def.span,
      selectionSpan: def.nameSpan,
      children: [],
    });
  }
  for (const hookAdd of hookAdds) {
    symbols.push({
      name: `hook: ${hookAdd.hookName}`,
      detail: hookAdd.identifier ?? '',
      kind: 'function',
      span: hookAdd.span,
      selectionSpan: hookAdd.nameSpan,
      children: [],
    });
  }
  for (const receive of netReceives) {
    symbols.push({
      name: `net: ${receive.name}`,
      detail: 'net.Receive',
      kind: 'function',
      span: receive.span,
      selectionSpan: receive.nameSpan,
      children: [],
    });
  }

  const unusedLocals = root
    .allDeclarations()
    .filter((sym) => sym.kind === 'local' && sym.name !== '_' && !sym.refs.some((r) => !r.write));

  return {
    uri,
    fsPath,
    version,
    text,
    lines,
    hasAst: true,
    chunk,
    comments,
    parseErrors,
    root,
    realm,
    globalDefs,
    globalRefs,
    hookAdds,
    hookRuns,
    netRegisters,
    netStarts,
    netReceives,
    includes,
    addCSLuaFiles,
    concommands,
    convars,
    symbols,
    guardedGlobals,
    unusedLocals,
    typeOf: (expr) => inferType(expr, root.scopeAt(expr.start)),
    scopeAt: (offset) => root.scopeAt(offset),
    docFor,
  };
}

