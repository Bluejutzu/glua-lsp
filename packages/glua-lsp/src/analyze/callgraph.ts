// Which function calls which, and which of them run every frame.
//
// Garry's Mod has no profiler you can point at a repository, and the mistakes
// that cost the most frames are structural rather than local: a `Material` call
// or an entity sweep is fine on its own and ruinous four calls below `HUDPaint`.
// Seeing that needs a call graph, so this extracts one.
//
// Like every other cross-file analysis here, what comes out is *facts* rather
// than nodes: the graph is derived once while the tree is in hand and survives
// the tree being dropped. Resolution across files happens in Workspace, since
// only it knows what else exists.

import {
  walk,
  type Chunk,
  type Expression,
  type Node,
  type Statement,
} from '../parser/ast.js';
import type { Span } from './binder.js';

/** How a function body got its name, which is also how it can be addressed. */
export type UnitKind = 'chunk' | 'global' | 'method' | 'local' | 'anonymous';

/** Why a function body runs often enough to be worth looking at. */
export interface HotEntry {
  /** `hook` — a gamemode hook; `class` — an ENT/SWEP/PANEL method; `timer`. */
  kind: 'hook' | 'class' | 'timer';
  /** Hook name, method name, or the timer's name. */
  name: string;
  /** Seconds between runs, for a timer. Per-frame entries leave this unset. */
  interval?: number;
}

export interface CallSite {
  /** The callee exactly as written: `ents.FindByClass`, `self:Update`, `Material`. */
  callee: string;
  span: Span;
  args: number;
  /**
   * Guarded by something that plausibly limits how often it runs — a CurTime
   * comparison, a `nextThink` field, a one-time `if not x then` gate. Findings
   * are not raised through a throttled call, and hotness does not propagate
   * through one either.
   */
  throttled: boolean;
}

export interface CallUnit {
  /**
   * How the rest of the workspace addresses this body: `MyAddon.Draw` for a
   * global, `ENT:Think` for a method, `local:helper` for a file-local. Empty
   * for a body nothing can name, like a callback written in place.
   */
  key: string;
  /** For display: the name a person would call it. */
  name: string;
  kind: UnitKind;
  span: Span;
  nameSpan: Span;
  /** Index of the enclosing unit; -1 for the file body itself. */
  parent: number;
  calls: CallSite[];
  /** Set when this body is itself registered somewhere that runs it often. */
  entry?: HotEntry;
}

/** `hook.Add("Think", "id", MyAddon.Update)` — a hot entry naming a function. */
export interface HandlerRef {
  entry: HotEntry;
  /** Path of the registered function, as written. */
  target: string;
  span: Span;
}

export interface CallGraph {
  /** `units[0]` is always the file body. */
  units: CallUnit[];
  handlers: HandlerRef[];
}

/* ------------------------------------------------------------ hot entries */

/**
 * Gamemode hooks that run at least once per frame or per tick. Anything called
 * on an event — a spawn, a death, a chat message — is deliberately absent: it
 * is only worth pointing at work that repeats forever.
 */
export const HOT_HOOKS = new Set([
  'Think', 'Tick', 'PlayerTick', 'CreateMove', 'SetupMove', 'FinishMove', 'Move',
  'StartCommand', 'CalcMainActivity', 'UpdateAnimation', 'CalcView',
  'CalcVehicleView', 'CalcViewModelView', 'HUDPaint', 'HUDPaintBackground',
  'HUDDrawTargetID', 'HUDDrawPickupHistory', 'HUDShouldDraw', 'DrawOverlay',
  'PreDrawHUD', 'PostDrawHUD', 'RenderHUD', 'PreRender', 'PostRender',
  'RenderScene', 'RenderScreenspaceEffects', 'PreDrawEffects', 'PostDrawEffects',
  'PreDrawOpaqueRenderables', 'PostDrawOpaqueRenderables',
  'PreDrawTranslucentRenderables', 'PostDrawTranslucentRenderables',
  'PreDrawSkyBox', 'PostDrawSkyBox', 'PreDrawViewModel', 'PostDrawViewModel',
  'PrePlayerDraw', 'PostPlayerDraw', 'PreDrawPlayerHands', 'PostDrawPlayerHands',
  'DrawPhysgunBeam', 'NeedsDepthPass', 'ShouldDrawLocalPlayer',
  'RenderScreenspaceEffects', 'SetupWorldFog', 'SetupSkyboxFog',
  'AdjustMouseSensitivity', 'TranslateFOV', 'GetMotionBlurValues',
]);

/**
 * Method names on a scripted class that the engine calls every frame or tick.
 * `Initialize`, `OnRemove` and friends run once, so they are not here.
 */
export const HOT_METHODS = new Set([
  'Think', 'Draw', 'DrawTranslucent', 'DrawWorldModel', 'DrawWorldModelTranslucent',
  'DrawHUD', 'DrawHUDBackground', 'DrawToolScreen', 'Paint', 'PaintOver',
  'PaintUnder', 'Render', 'ViewModelDrawn', 'PreDrawViewModel', 'PostDrawViewModel',
  'CalcView', 'CalcViewModelView', 'PhysicsSimulate', 'PhysicsUpdate',
  'CalcAbsolutePosition', 'FrameAdvance', 'Tick',
]);

/** Tables a scripted class is written on, so `function ENT:Think()` is found. */
export const CLASS_TABLES = new Set([
  'ENT', 'SWEP', 'PANEL', 'EFFECT', 'TOOL', 'GM', 'GAMEMODE', 'SANDBOX',
]);

/**
 * A timer at or under this interval is treated as a hot path. Longer than this
 * and the per-run cost stops mattering next to what it is spread over.
 */
export const HOT_TIMER_INTERVAL = 0.5;

/* ------------------------------------------------------------- cost table */

export interface CostRule {
  /** Full call path (`util.TableToJSON`) or a bare method name (`SetNWInt`). */
  match: string;
  kind: 'path' | 'method';
  /** What it does, as a clause following the call's name. */
  why: string;
  /** What to do instead. */
  advice: string;
  /**
   * The call takes only literals, so the fix is to evaluate it once at file
   * scope. Drives the quick fix.
   */
  hoistable?: boolean;
}

const REGISTER_ADVICE = 'Register it once at file scope instead.';

const COST_RULES: CostRule[] = [
  /* --------------------------------------------------- one-time setup */
  {
    match: 'surface.CreateFont', kind: 'path',
    why: 'rebuilds the font',
    advice: 'Create fonts once at file scope; recreating one every frame leaks and stalls.',
  },
  { match: 'hook.Add', kind: 'path', why: 'registers a hook', advice: REGISTER_ADVICE },
  { match: 'hook.Remove', kind: 'path', why: 'removes a hook', advice: REGISTER_ADVICE },
  {
    match: 'timer.Create', kind: 'path',
    why: 'creates a timer',
    advice: 'A timer recreated this often is replaced before it fires. Create it once.',
  },
  { match: 'concommand.Add', kind: 'path', why: 'registers a console command', advice: REGISTER_ADVICE },
  { match: 'CreateConVar', kind: 'path', why: 'creates a console variable', advice: REGISTER_ADVICE },
  { match: 'CreateClientConVar', kind: 'path', why: 'creates a console variable', advice: REGISTER_ADVICE },
  { match: 'util.AddNetworkString', kind: 'path', why: 'registers a net message name', advice: REGISTER_ADVICE },
  { match: 'net.Receive', kind: 'path', why: 'registers a net message handler', advice: REGISTER_ADVICE },
  { match: 'sound.Add', kind: 'path', why: 'registers a sound script', advice: REGISTER_ADVICE },
  { match: 'language.Add', kind: 'path', why: 'registers a translation', advice: REGISTER_ADVICE },
  { match: 'killicon.Add', kind: 'path', why: 'registers a kill icon', advice: REGISTER_ADVICE },
  { match: 'resource.AddFile', kind: 'path', why: 'queues a file for download', advice: REGISTER_ADVICE },
  {
    match: 'include', kind: 'path',
    why: 'compiles and runs a file',
    advice: 'Include it once, at load time.',
  },
  { match: 'AddCSLuaFile', kind: 'path', why: 'queues a file for the client', advice: REGISTER_ADVICE },
  {
    match: 'CompileString', kind: 'path',
    why: 'compiles Lua source',
    advice: 'Compile once and keep the function.',
  },
  {
    match: 'RunString', kind: 'path',
    why: 'compiles and runs Lua source',
    advice: 'Compile once and keep the function.',
  },
  { match: 'CompileFile', kind: 'path', why: 'compiles a file', advice: 'Compile once and keep the function.' },

  /* --------------------------------------------------------------- I/O */
  { match: 'file.Read', kind: 'path', why: 'reads from disk', advice: 'Read once and keep the contents in a local.' },
  { match: 'file.Write', kind: 'path', why: 'writes to disk', advice: 'Write on change, or on a timer.' },
  { match: 'file.Append', kind: 'path', why: 'writes to disk', advice: 'Write on change, or on a timer.' },
  { match: 'file.Find', kind: 'path', why: 'walks the filesystem', advice: 'Do it once and cache the listing.' },
  { match: 'file.Exists', kind: 'path', why: 'hits the filesystem', advice: 'Check once and keep the answer.' },
  { match: 'file.Size', kind: 'path', why: 'hits the filesystem', advice: 'Check once and keep the answer.' },
  { match: 'file.Time', kind: 'path', why: 'hits the filesystem', advice: 'Check once and keep the answer.' },
  { match: 'sql.Query', kind: 'path', why: 'runs a database query', advice: 'Query on change, or on a timer.' },
  { match: 'sql.QueryRow', kind: 'path', why: 'runs a database query', advice: 'Query on change, or on a timer.' },
  { match: 'sql.QueryValue', kind: 'path', why: 'runs a database query', advice: 'Query on change, or on a timer.' },
  { match: 'http.Fetch', kind: 'path', why: 'starts an HTTP request', advice: 'Request on demand, not on a schedule this tight.' },
  { match: 'http.Post', kind: 'path', why: 'starts an HTTP request', advice: 'Request on demand, not on a schedule this tight.' },
  { match: 'HTTP', kind: 'path', why: 'starts an HTTP request', advice: 'Request on demand, not on a schedule this tight.' },

  /* ----------------------------------------------------- serialisation */
  {
    match: 'util.TableToJSON', kind: 'path',
    why: 'walks the whole table and builds a string',
    advice: 'Serialise when the data changes, not when it is read.',
  },
  {
    match: 'util.JSONToTable', kind: 'path',
    why: 'parses a string into a new table',
    advice: 'Parse once and keep the table.',
  },
  { match: 'util.TableToKeyValues', kind: 'path', why: 'walks the whole table and builds a string', advice: 'Serialise on change instead.' },
  { match: 'util.KeyValuesToTable', kind: 'path', why: 'parses a string into a new table', advice: 'Parse once and keep the table.' },
  { match: 'util.Compress', kind: 'path', why: 'compresses the whole string', advice: 'Compress on change instead.' },
  { match: 'util.Decompress', kind: 'path', why: 'decompresses the whole string', advice: 'Decompress once and keep the result.' },
  { match: 'util.CRC', kind: 'path', why: 'hashes the whole string', advice: 'Hash on change instead.' },
  { match: 'util.Base64Encode', kind: 'path', why: 'encodes the whole string', advice: 'Encode on change instead.' },
  { match: 'util.Base64Decode', kind: 'path', why: 'decodes the whole string', advice: 'Decode once and keep the result.' },

  /* ------------------------------------------------------------ sweeps */
  {
    match: 'ents.GetAll', kind: 'path',
    why: 'builds a table of every entity in the map',
    advice: 'Keep your own list, or refresh it on a timer.',
  },
  {
    match: 'ents.FindByClass', kind: 'path',
    why: 'sweeps every entity in the map',
    advice: 'Collect them once and maintain the list from OnEntityCreated and EntityRemoved.',
  },
  { match: 'ents.FindByClassAndParent', kind: 'path', why: 'sweeps every entity in the map', advice: 'Cache the result and refresh it on a timer.' },
  { match: 'ents.FindByModel', kind: 'path', why: 'sweeps every entity in the map', advice: 'Cache the result and refresh it on a timer.' },
  { match: 'ents.FindByName', kind: 'path', why: 'sweeps every entity in the map', advice: 'Cache the result and refresh it on a timer.' },
  { match: 'ents.FindInSphere', kind: 'path', why: 'sweeps every entity in the map', advice: 'Widen the interval, or narrow it with a spatial check first.' },
  { match: 'ents.FindInBox', kind: 'path', why: 'sweeps every entity in the map', advice: 'Widen the interval, or narrow it with a spatial check first.' },
  { match: 'ents.FindInCone', kind: 'path', why: 'sweeps every entity in the map', advice: 'Widen the interval, or narrow it with a spatial check first.' },
  { match: 'ents.FindAlongRay', kind: 'path', why: 'sweeps every entity in the map', advice: 'Widen the interval, or use a trace.' },
  {
    match: 'player.GetAll', kind: 'path',
    why: 'walks every player',
    advice: 'Hoist it out of the frame, or iterate once and reuse the list.',
  },
  { match: 'player.GetHumans', kind: 'path', why: 'walks every player', advice: 'Hoist it out of the frame.' },
  { match: 'player.GetBots', kind: 'path', why: 'walks every player', advice: 'Hoist it out of the frame.' },
  { match: 'team.GetPlayers', kind: 'path', why: 'walks every player', advice: 'Hoist it out of the frame.' },

  /* ------------------------------------------------- per-frame lookups */
  {
    match: 'Material', kind: 'path', hoistable: true,
    why: 'looks the material up by string',
    advice: 'Hoist it into a file-scope local.',
  },
  {
    match: 'surface.GetTextureID', kind: 'path', hoistable: true,
    why: 'looks the texture up by string',
    advice: 'Hoist it into a file-scope local.',
  },
  {
    match: 'GetConVarNumber', kind: 'path',
    why: 'looks the console variable up by name and converts it',
    advice: 'Keep the ConVar object in a local and call :GetFloat() on it.',
  },
  {
    match: 'GetConVarString', kind: 'path',
    why: 'looks the console variable up by name',
    advice: 'Keep the ConVar object in a local and call :GetString() on it.',
  },

  /* -------------------------------------------------------- networking */
  {
    match: 'net.Start', kind: 'path',
    why: 'opens a net message',
    advice: 'Send on change, or on a timer — every client pays for this one.',
  },
  {
    match: 'SetNWInt', kind: 'method',
    why: 'networks a value to every client',
    advice: 'Set it only when the value actually changes.',
  },
  { match: 'SetNWFloat', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNWString', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNWBool', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNWEntity', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNWVector', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNWAngle', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Int', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Float', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2String', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Bool', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Entity', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Vector', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },
  { match: 'SetNW2Angle', kind: 'method', why: 'networks a value to every client', advice: 'Set it only when the value actually changes.' },

  /* ------------------------------------------------------------- other */
  {
    match: 'collectgarbage', kind: 'path',
    why: 'runs a garbage collection cycle',
    advice: 'Leave collection to the runtime.',
  },
  { match: 'debug.getinfo', kind: 'path', why: 'walks the call stack', advice: 'Look it up once, outside the frame.' },
  { match: 'debug.Trace', kind: 'path', why: 'walks the call stack', advice: 'Look it up once, outside the frame.' },
  { match: 'table.Copy', kind: 'path', why: 'deep-copies the table', advice: 'Copy once, outside the frame.' },
  { match: 'PrintTable', kind: 'path', why: 'prints a whole table to the console', advice: 'Left-over debug output; remove it.' },
  { match: 'RunConsoleCommand', kind: 'path', why: 'queues a console command', advice: 'Run it on change instead.' },
  { match: 'game.ConsoleCommand', kind: 'path', why: 'queues a console command', advice: 'Run it on change instead.' },
];

const COST_BY_PATH = new Map<string, CostRule>();
const COST_BY_METHOD = new Map<string, CostRule>();
for (const rule of COST_RULES) {
  if (rule.kind === 'path') COST_BY_PATH.set(rule.match, rule);
  else COST_BY_METHOD.set(rule.match, rule);
}

/** The cost rule a callee falls under, if any. */
export function costOf(callee: string): CostRule | undefined {
  const direct = COST_BY_PATH.get(callee);
  if (direct) return direct;
  const tail = callee.split(/[.:]/).pop();
  return tail ? COST_BY_METHOD.get(tail) : undefined;
}

/* ------------------------------------------------------ throttle guessing */

/**
 * Names that read as "only sometimes". A field called `nextThink` compared
 * against anything is the idiom for rate-limiting in this language, and there
 * is no type system here to confirm it — so this matches on the word.
 */
const THROTTLE_NAME = /^(next|last|cooldown|delay|_?think)/i;

const TIME_CALLS = new Set([
  'CurTime', 'RealTime', 'SysTime', 'UnPredictedCurTime', 'FrameNumber',
  'engine.TickCount', 'os.time', 'os.clock',
]);

const pathOf = (expr: Expression): string | null => {
  switch (expr.type) {
    case 'Identifier':
      return expr.missing ? null : expr.name;
    case 'MemberExpression': {
      const base = pathOf(expr.base);
      if (base === null || expr.identifier.missing) return null;
      return `${base}${expr.indexer}${expr.identifier.name}`;
    }
    default:
      return null;
  }
};

/**
 * Does this condition plausibly stop the block from running every frame?
 *
 * Deliberately generous. A missed finding costs nothing; a finding on code that
 * already rate-limits itself is the kind of noise that gets a rule switched off.
 */
function isThrottleCondition(condition: Expression): boolean {
  let found = false;
  walk(condition, (node) => {
    if (found) return false;
    if (node.type === 'CallExpression') {
      const path = pathOf(node.base);
      if (path && TIME_CALLS.has(path)) found = true;
      return;
    }
    // `if not ready then ... end` — a one-time gate.
    if (node.type === 'UnaryExpression' && node.operator === 'not') found = true;
    if (node.type === 'BinaryExpression' && node.operator === '==' &&
        (node.left.type === 'NilLiteral' || node.right.type === 'NilLiteral')) {
      found = true;
    }
    if (node.type === 'Identifier' && THROTTLE_NAME.test(node.name)) found = true;
    return;
  });
  return found;
}

/**
 * `if CurTime() < self.NextFire then return end` at the top of a body — the
 * standard way to rate-limit a Think, and invisible to a per-block check
 * because the guard is an early return rather than a wrapper.
 */
function bodyIsRateLimited(body: Statement[]): boolean {
  for (const statement of body) {
    if (statement.type !== 'IfStatement') return false;
    const clause = statement.clauses[0];
    if (!clause?.condition || statement.clauses.length !== 1) return false;
    const onlyReturns =
      clause.body.length === 1 && clause.body[0]!.type === 'ReturnStatement';
    if (!onlyReturns) return false;
    if (isThrottleCondition(clause.condition)) return true;
  }
  return false;
}

/* ----------------------------------------------------------------- build */

const numberArg = (args: Expression[], i: number): number | null => {
  const arg = args[i];
  return arg?.type === 'NumberLiteral' ? arg.value : null;
};

const stringArg = (args: Expression[], i: number): string | null => {
  const arg = args[i];
  return arg?.type === 'StringLiteral' ? arg.value : null;
};

/** Name and entry a function expression inherits from where it was written. */
interface PendingUnit {
  key: string;
  name: string;
  kind: UnitKind;
  nameSpan: Span;
  entry?: HotEntry;
}

export function buildCallGraph(chunk: Chunk): CallGraph {
  const units: CallUnit[] = [
    {
      key: '',
      name: '(file)',
      kind: 'chunk',
      span: { start: chunk.start, end: chunk.end },
      nameSpan: { start: chunk.start, end: chunk.start },
      parent: -1,
      calls: [],
    },
  ];
  const handlers: HandlerRef[] = [];

  /** Names handed down from a declaration to the function expression under it. */
  const pending = new Map<Expression, PendingUnit>();
  /** Bodies that rate-limit themselves, so nothing inside counts as per-frame. */
  const rateLimited = new Set<number>();

  const unitStack: number[] = [0];
  /** End offsets of blocks guarded by a throttling condition. */
  const throttleStack: number[] = [];

  const currentUnit = (): CallUnit => units[unitStack[unitStack.length - 1]!]!;

  const nameFunction = (func: Expression | undefined, info: PendingUnit): void => {
    if (func?.type === 'FunctionExpression') pending.set(func, info);
  };

  /** Registrations whose callback runs often, and what to call that entry. */
  const entryForCall = (path: string, args: Expression[]): HotEntry | null => {
    if (path === 'hook.Add') {
      const name = stringArg(args, 0);
      if (name && HOT_HOOKS.has(name)) return { kind: 'hook', name };
      return null;
    }
    if (path === 'timer.Create' || path === 'timer.Adjust') {
      const name = stringArg(args, 0);
      const interval = numberArg(args, 1);
      if (name !== null && interval !== null && interval <= HOT_TIMER_INTERVAL) {
        return { kind: 'timer', name, interval };
      }
    }
    return null;
  };

  walk(chunk, (node: Node) => {
    // Both stacks are unwound by position: the walk is pre-order over nodes
    // whose spans nest, so anything ending before this node has been left.
    while (unitStack.length > 1 && node.start >= units[unitStack[unitStack.length - 1]!]!.span.end) {
      unitStack.pop();
    }
    while (throttleStack.length && node.start >= throttleStack[throttleStack.length - 1]!) {
      throttleStack.pop();
    }

    switch (node.type) {
      case 'FunctionDeclaration': {
        const target = node.identifier;
        if (!target) break;
        if (node.isLocal && target.type === 'Identifier') {
          nameFunction(node.func, {
            key: `local:${target.name}`,
            name: target.name,
            kind: 'local',
            nameSpan: { start: target.start, end: target.end },
          });
          break;
        }
        const path = pathOf(target);
        if (!path) break;
        const isMethod = target.type === 'MemberExpression' && target.indexer === ':';
        const method = path.split(/[.:]/).pop()!;
        const root = path.split(/[.:]/)[0]!;
        const info: PendingUnit = {
          key: path,
          name: path,
          kind: isMethod ? 'method' : 'global',
          nameSpan: { start: target.start, end: target.end },
        };
        if (CLASS_TABLES.has(root) && HOT_METHODS.has(method)) {
          info.entry = { kind: 'class', name: path };
        }
        nameFunction(node.func, info);
        break;
      }

      case 'LocalStatement': {
        node.names.forEach((identifier, i) => {
          nameFunction(node.init[i], {
            key: `local:${identifier.name}`,
            name: identifier.name,
            kind: 'local',
            nameSpan: { start: identifier.start, end: identifier.end },
          });
        });
        break;
      }

      case 'AssignmentStatement': {
        node.targets.forEach((target, i) => {
          const path = pathOf(target);
          if (!path) return;
          const method = path.split(/[.:]/).pop()!;
          const root = path.split(/[.:]/)[0]!;
          const info: PendingUnit = {
            key: path,
            name: path,
            kind: 'global',
            nameSpan: { start: target.start, end: target.end },
          };
          if (CLASS_TABLES.has(root) && HOT_METHODS.has(method)) {
            info.entry = { kind: 'class', name: path };
          }
          nameFunction(node.init[i], info);
        });
        break;
      }

      case 'TableKeyField': {
        // `PANEL.Paint = ...` written as `{ Paint = function() end }`.
        if (node.kind !== 'name' || node.key?.type !== 'Identifier') break;
        nameFunction(node.value, {
          key: '',
          name: node.key.name,
          kind: 'anonymous',
          nameSpan: { start: node.key.start, end: node.key.end },
        });
        break;
      }

      case 'IfClause': {
        // Pushed per clause rather than per statement: an `elseif` that
        // rate-limits says nothing about the branch beside it.
        if (node.condition && isThrottleCondition(node.condition)) {
          throttleStack.push(node.end);
        }
        break;
      }

      case 'FunctionExpression': {
        const info = pending.get(node) ?? {
          key: '',
          name: '(anonymous)',
          kind: 'anonymous' as UnitKind,
          nameSpan: { start: node.start, end: node.start },
        };
        pending.delete(node);
        const index = units.length;
        units.push({
          key: info.key,
          name: info.name,
          kind: info.kind,
          span: { start: node.start, end: node.end },
          nameSpan: info.nameSpan,
          parent: unitStack[unitStack.length - 1]!,
          calls: [],
          ...(info.entry ? { entry: info.entry } : {}),
        });
        if (bodyIsRateLimited(node.body)) rateLimited.add(index);
        unitStack.push(index);
        break;
      }

      case 'CallExpression': {
        const path = pathOf(node.base);
        if (!path) break;

        const unitIndex = unitStack[unitStack.length - 1]!;
        currentUnit().calls.push({
          callee: path,
          span: { start: node.base.start, end: node.base.end },
          args: node.args.length,
          throttled: throttleStack.length > 0 || rateLimited.has(unitIndex),
        });

        const entry = entryForCall(path, node.args);
        if (!entry) break;

        // hook.Add takes the callback third, timer.Create fourth.
        const callback = path === 'hook.Add' ? node.args[2] : node.args[3];
        if (!callback) break;
        if (callback.type === 'FunctionExpression') {
          const existing = pending.get(callback);
          if (existing) existing.entry = entry;
          else {
            pending.set(callback, {
              key: '',
              name: entry.kind === 'timer' ? `timer ${entry.name}` : entry.name,
              kind: 'anonymous',
              nameSpan: { start: callback.start, end: callback.start },
              entry,
            });
          }
          break;
        }
        const target = pathOf(callback);
        if (target) {
          handlers.push({ entry, target, span: { start: callback.start, end: callback.end } });
        }
        break;
      }

      default:
        break;
    }
    return;
  });

  return { units, handlers };
}
