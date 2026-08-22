import type { Chunk, Expression, Statement } from '../parser/ast.js';
import type { Realm } from '../api/types.js';

/**
 * Which script container a file belongs to. Drives what `self` is, which hook
 * table completes, and whether the file needs AddCSLuaFile.
 */
export type FileKind =
  | 'entity'
  | 'weapon'
  | 'effect'
  | 'gamemode'
  | 'panel'
  | 'tool'
  | 'autorun'
  | 'library'
  | 'unknown';

export interface RealmRegion {
  start: number;
  end: number;
  realm: Realm;
}

export interface RealmInfo {
  /** Realm implied by the file's location and name. */
  file: Realm;
  /** How confident we are — a path match beats a filename prefix beats a guess. */
  confidence: 'path' | 'prefix' | 'default';
  kind: FileKind;
  /** The `if SERVER then` / `if CLIENT then` blocks inside the file. */
  regions: RealmRegion[];
  reason: string;
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Realm and container inferred from the file path alone. */
export function realmFromPath(fsPath: string): {
  realm: Realm;
  confidence: 'path' | 'prefix' | 'default';
  kind: FileKind;
  reason: string;
} {
  const p = norm(fsPath);
  const file = p.slice(p.lastIndexOf('/') + 1);

  const kind: FileKind = /\/lua\/entities\//.test(p)
    ? 'entity'
    : /\/lua\/weapons\/gmod_tool\/stools\//.test(p)
      ? 'tool'
      : /\/lua\/weapons\//.test(p)
        ? 'weapon'
        : /\/lua\/effects\//.test(p)
          ? 'effect'
          : /\/gamemodes\/[^/]+\/gamemode\//.test(p)
            ? 'gamemode'
            : /\/lua\/vgui\//.test(p)
              ? 'panel'
              : /\/lua\/autorun\//.test(p)
                ? 'autorun'
                : /\/lua\//.test(p)
                  ? 'library'
                  : 'unknown';

  // Container conventions are unambiguous, so they win outright.
  if (file === 'cl_init.lua') {
    return { realm: 'client', confidence: 'path', kind, reason: 'cl_init.lua is loaded clientside only' };
  }
  if (file === 'init.lua' && (kind === 'entity' || kind === 'weapon' || kind === 'gamemode' || kind === 'effect')) {
    return { realm: 'server', confidence: 'path', kind, reason: 'init.lua is loaded serverside only' };
  }
  if (file === 'shared.lua') {
    return { realm: 'shared', confidence: 'path', kind, reason: 'shared.lua is loaded in both realms' };
  }

  if (/\/lua\/autorun\/client\//.test(p)) {
    return { realm: 'client', confidence: 'path', kind, reason: 'in lua/autorun/client' };
  }
  if (/\/lua\/autorun\/server\//.test(p)) {
    return { realm: 'server', confidence: 'path', kind, reason: 'in lua/autorun/server' };
  }
  if (/\/lua\/menu\//.test(p)) {
    return { realm: 'menu', confidence: 'path', kind, reason: 'in lua/menu' };
  }
  if (kind === 'effect' || kind === 'panel' || /\/lua\/(postprocess|matproxy|skins)\//.test(p)) {
    return { realm: 'client', confidence: 'path', kind, reason: `${kind} scripts are clientside` };
  }
  // A `client/` or `server/` directory anywhere under lua/ is the common convention.
  if (/\/(client|cl)\//.test(p)) {
    return { realm: 'client', confidence: 'path', kind, reason: 'in a client/ directory' };
  }
  if (/\/(server|sv)\//.test(p)) {
    return { realm: 'server', confidence: 'path', kind, reason: 'in a server/ directory' };
  }

  if (/^cl_/.test(file)) {
    return { realm: 'client', confidence: 'prefix', kind, reason: 'cl_ filename prefix' };
  }
  if (/^sv_/.test(file)) {
    return { realm: 'server', confidence: 'prefix', kind, reason: 'sv_ filename prefix' };
  }
  if (/^sh_/.test(file)) {
    return { realm: 'shared', confidence: 'prefix', kind, reason: 'sh_ filename prefix' };
  }

  return { realm: 'shared', confidence: 'default', kind, reason: 'no realm convention matched; assuming shared' };
}

/** `SERVER`, `not CLIENT`, `SERVER and x` -> the realm the branch runs in. */
function realmOfCondition(expr: Expression | null): Realm | null {
  if (!expr) return null;
  switch (expr.type) {
    case 'Identifier':
      if (expr.name === 'SERVER') return 'server';
      if (expr.name === 'CLIENT') return 'client';
      if (expr.name === 'MENU_DLL') return 'menu';
      return null;
    case 'UnaryExpression': {
      if (expr.operator !== 'not') return null;
      const inner = realmOfCondition(expr.argument);
      if (inner === 'server') return 'client';
      if (inner === 'client') return 'server';
      return null;
    }
    case 'BinaryExpression':
      // `SERVER and something` still guarantees the realm; `or` does not.
      if (expr.operator === 'and') {
        return realmOfCondition(expr.left) ?? realmOfCondition(expr.right);
      }
      return null;
    default:
      return null;
  }
}

/** Inverse of a realm, for the `else` branch of `if SERVER then`. */
function oppositeRealm(realm: Realm): Realm | null {
  if (realm === 'server') return 'client';
  if (realm === 'client') return 'server';
  return null;
}

function collectRegions(body: Statement[], out: RealmRegion[]): void {
  for (const stat of body) {
    switch (stat.type) {
      case 'IfStatement': {
        let guardedRealm: Realm | null = null;
        for (const clause of stat.clauses) {
          if (clause.condition) {
            const realm = realmOfCondition(clause.condition);
            if (realm) {
              out.push({ start: clause.start, end: clause.end, realm });
              guardedRealm ??= realm;
            }
          } else if (guardedRealm) {
            // `else` of an `if SERVER then` is the client branch.
            const opposite = oppositeRealm(guardedRealm);
            if (opposite) out.push({ start: clause.start, end: clause.end, realm: opposite });
          }
          collectRegions(clause.body, out);
        }
        break;
      }
      case 'DoStatement':
      case 'WhileStatement':
      case 'RepeatStatement':
      case 'NumericForStatement':
      case 'GenericForStatement':
        collectRegions(stat.body, out);
        break;
      case 'FunctionDeclaration':
        collectRegions(stat.func.body, out);
        break;
      default:
        break;
    }
  }
}

export function analyseRealm(fsPath: string, chunk: Chunk): RealmInfo {
  const base = realmFromPath(fsPath);
  const regions: RealmRegion[] = [];
  collectRegions(chunk.body, regions);
  return { file: base.realm, confidence: base.confidence, kind: base.kind, regions, reason: base.reason };
}

/** Effective realm at a position: innermost `if SERVER`/`if CLIENT` block wins. */
export function realmAt(info: RealmInfo, offset: number): Realm {
  let best: RealmRegion | null = null;
  for (const region of info.regions) {
    if (offset < region.start || offset > region.end) continue;
    if (!best || region.start > best.start) best = region;
  }
  return best ? best.realm : info.file;
}
