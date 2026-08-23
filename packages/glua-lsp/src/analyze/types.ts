import type { FunctionExpression, TableConstructor } from '../parser/ast.js';
import type { ApiFunction } from '../api/types.js';
import type { GmodApi } from '../api/index.js';

/**
 * A deliberately small structural type lattice. It is not sound and does not
 * try to be — its job is to answer "what can I put after this dot" and "is this
 * argument obviously the wrong thing", which needs breadth, not rigour.
 */
export type GType =
  | { kind: 'unknown' }
  | { kind: 'nil' }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'string' }
  | { kind: 'vararg' }
  | { kind: 'function'; api?: ApiFunction; node?: FunctionExpression; name?: string }
  | {
      kind: 'table';
      /** Known string keys. */
      members?: Map<string, GType>;
      /** This table IS a GMod library namespace, e.g. `net`. */
      library?: string;
      /** This table matches a documented wiki structure. */
      struct?: string;
      /** This table IS a hook metatable, e.g. `ENT` or `SWEP`. */
      hookTable?: string;
      /** Element type when used as an array. */
      element?: GType;
      node?: TableConstructor;
    }
  | {
      kind: 'class';
      name: string;
      /**
       * A scripted entity/weapon class from this workspace. `name` stays the
       * wiki class it behaves as, so assignability is unaffected and only
       * completion and hover need to know the difference.
       */
      scripted?: string;
    }
  | { kind: 'union'; options: GType[] };

export const UNKNOWN: GType = { kind: 'unknown' };
export const NIL: GType = { kind: 'nil' };
export const BOOLEAN: GType = { kind: 'boolean' };
export const NUMBER: GType = { kind: 'number' };
export const STRING: GType = { kind: 'string' };

export const classType = (name: string): GType => ({ kind: 'class', name });
export const scriptedType = (base: string, scripted: string): GType => ({
  kind: 'class',
  name: base,
  scripted,
});
export const tableType = (init: Partial<Extract<GType, { kind: 'table' }>> = {}): GType => ({
  kind: 'table',
  ...init,
});

export function union(options: GType[]): GType {
  const flat: GType[] = [];
  for (const opt of options) {
    if (opt.kind === 'union') flat.push(...opt.options);
    else flat.push(opt);
  }
  const seen = new Set<string>();
  const unique = flat.filter((t) => {
    const key = typeToString(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return UNKNOWN;
  // An unknown branch alongside a known one would erase the known one, which
  // costs far more in completion than the imprecision saves.
  const known = unique.filter((t) => t.kind !== 'unknown');
  if (known.length === 0) return UNKNOWN;
  if (known.length === 1) return known[0]!;
  return { kind: 'union', options: known };
}

/** Drops `nil` from a union — what `IsValid(x)` or `if x then` tells us. */
export function withoutNil(type: GType): GType {
  if (type.kind === 'nil') return UNKNOWN;
  if (type.kind !== 'union') return type;
  return union(type.options.filter((t) => t.kind !== 'nil'));
}

export function typeToString(type: GType): string {
  switch (type.kind) {
    case 'unknown':
      return 'any';
    case 'function': {
      if (type.api) return formatApiSignature(type.api);
      if (type.node) {
        const params = type.node.params
          .map((p) => (p.type === 'VarargLiteral' ? '...' : p.name))
          .join(', ');
        return `function(${params})`;
      }
      return 'function';
    }
    case 'table':
      if (type.library) return `${type.library} (library)`;
      if (type.struct) return `${type.struct} (structure)`;
      if (type.element) return `${typeToString(type.element)}[]`;
      return 'table';
    case 'class':
      return type.scripted ? `${type.name} (${type.scripted})` : type.name;
    case 'union':
      return type.options.map(typeToString).join('|');
    default:
      return type.kind;
  }
}

export function formatApiSignature(fn: ApiFunction): string {
  const params = fn.params
    .map((p) => {
      const name = p.name || p.type;
      return p.optional || p.default !== undefined ? `${name}?: ${p.type}` : `${name}: ${p.type}`;
    })
    .join(', ');
  const rets = fn.returns.length
    ? ': ' + fn.returns.map((r) => r.type).join(', ')
    : '';
  return `function(${params})${rets}`;
}

/** Maps a wiki type name onto our lattice. */
export function fromApiType(raw: string | undefined, api: GmodApi): GType {
  if (!raw) return UNKNOWN;

  // The wiki occasionally writes unions as `number or nil`, `string|Entity`.
  const parts = raw.split(/\s*(?:\||\bor\b)\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return union(parts.map((p) => fromApiType(p, api)));

  const name = parts[0] ?? raw;
  switch (name.toLowerCase()) {
    case 'number':
      return NUMBER;
    case 'string':
      return STRING;
    case 'boolean':
    case 'bool':
      return BOOLEAN;
    case 'nil':
    // The wiki writes GMod's null-entity sentinel as `NULL` in return types,
    // e.g. `Player|NULL`. Treating it as nil keeps the Player half usable.
    case 'null':
      return NIL;
    case 'table':
      return tableType();
    case 'function':
      return { kind: 'function' };
    case 'vararg':
      return { kind: 'vararg' };
    case 'any':
    case '':
      return UNKNOWN;
  }

  if (api.isClass(name)) return classType(name);
  if (api.getStruct(name)) return tableType({ struct: name });
  return UNKNOWN;
}

/**
 * Is a value of `actual` possibly acceptable where `expected` is documented?
 * Deliberately permissive: only flags things that can never work, so the
 * argument-type diagnostic stays trustworthy instead of noisy.
 */
export function isAssignable(actual: GType, expected: GType, api: GmodApi): boolean {
  if (actual.kind === 'unknown' || expected.kind === 'unknown') return true;
  if (actual.kind === 'vararg' || expected.kind === 'vararg') return true;
  if (actual.kind === 'nil') return true; // nil is assignable to everything in Lua

  if (expected.kind === 'union') {
    return expected.options.some((opt) => isAssignable(actual, opt, api));
  }
  if (actual.kind === 'union') {
    return actual.options.some((opt) => isAssignable(opt, expected, api));
  }

  if (actual.kind === expected.kind) {
    if (actual.kind === 'class' && expected.kind === 'class') {
      if (actual.name === expected.name) return true;
      // Upcasts are fine: a Player is an Entity.
      for (let c: string | undefined = actual.name; c; c = api.parentOf(c)) {
        if (c === expected.name) return true;
      }
      // Downcasts are common and usually intentional (`ent` used as `Player`).
      for (let c: string | undefined = expected.name; c; c = api.parentOf(c)) {
        if (c === actual.name) return true;
      }
      return false;
    }
    return true;
  }

  // Lua coerces freely between these two.
  if (
    (actual.kind === 'number' && expected.kind === 'string') ||
    (actual.kind === 'string' && expected.kind === 'number')
  ) {
    return true;
  }
  // Anything is truthy-testable, and classes are tables underneath.
  if (expected.kind === 'boolean') return true;
  if (expected.kind === 'table' && actual.kind === 'class') return true;
  if (expected.kind === 'class' && actual.kind === 'table') return true;

  return false;
}
