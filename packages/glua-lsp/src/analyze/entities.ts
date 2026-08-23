/**
 * Scripted entity, weapon and effect classes.
 *
 * Garry's Mod takes the class name from where the file sits — the directory in
 * `lua/entities/my_turret/`, or the file itself in `lua/entities/my_turret.lua`
 * — and never from anything written in the source. So this is a path question,
 * not a syntax one.
 */

export type ScriptedKind = 'entity' | 'weapon' | 'effect';

export interface ScriptedClass {
  /** The name `ents.Create` expects, in the casing the folder uses. */
  name: string;
  kind: ScriptedKind;
  /** Wiki class an instance behaves as, so the base API still completes. */
  base: string;
  /** Which table the file's methods hang off. */
  table: string;
}

const SHAPES: Record<ScriptedKind, { base: string; table: string }> = {
  entity: { base: 'Entity', table: 'ENT' },
  weapon: { base: 'Weapon', table: 'SWEP' },
  effect: { base: 'Entity', table: 'EFFECT' },
};

const CONTAINERS: Record<string, ScriptedKind> = {
  entities: 'entity',
  weapons: 'weapon',
  effects: 'effect',
};

/** The class a file contributes to, or null if it is not part of one. */
export function scriptedClassOf(fsPath: string): ScriptedClass | null {
  const parts = fsPath.replace(/\\/g, '/').split('/');

  // Last `lua` wins, so an addon nested under another one still resolves.
  let lua = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.toLowerCase() === 'lua') {
      lua = i;
      break;
    }
  }
  if (lua < 0) return null;

  const kind = CONTAINERS[(parts[lua + 1] ?? '').toLowerCase()];
  if (!kind) return null;

  const entry = parts[lua + 2];
  if (!entry) return null;

  // Toolgun tools live under weapons/gmod_tool/stools and are not classes of
  // their own — they all share the gmod_tool weapon.
  if (kind === 'weapon' && entry.toLowerCase() === 'gmod_tool') return null;

  // A file directly in the container is a single-file class; otherwise the
  // directory names it and the file is one of its parts.
  const name = entry.toLowerCase().endsWith('.lua') ? entry.slice(0, -4) : entry;
  if (!name) return null;

  return { name, kind, ...SHAPES[kind] };
}

/**
 * Calls whose string argument names a scripted class. Shared by completion and
 * go-to-definition so they can never disagree about which strings are classes.
 */
const CLASS_ARGS: Record<string, { arg: number; kinds: ScriptedKind[] }> = {
  'ents.Create': { arg: 0, kinds: ['entity', 'weapon'] },
  'ents.CreateClientside': { arg: 0, kinds: ['entity'] },
  'ents.FindByClass': { arg: 0, kinds: ['entity', 'weapon'] },
  'ents.FindByClassAndParent': { arg: 0, kinds: ['entity', 'weapon'] },
  'scripted_ents.Get': { arg: 0, kinds: ['entity'] },
  'scripted_ents.GetStored': { arg: 0, kinds: ['entity'] },
  'weapons.Get': { arg: 0, kinds: ['weapon'] },
  'weapons.GetStored': { arg: 0, kinds: ['weapon'] },
  'util.Effect': { arg: 0, kinds: ['effect'] },
};

/**
 * Methods matched by name alone, because a call is written on the receiver
 * variable (`ply:Give`) and not on the class it was documented against.
 */
const CLASS_ARG_METHODS: Record<string, { arg: number; kinds: ScriptedKind[] }> = {
  Give: { arg: 0, kinds: ['weapon'] },
  GetWeapon: { arg: 0, kinds: ['weapon'] },
  HasWeapon: { arg: 0, kinds: ['weapon'] },
  StripWeapon: { arg: 0, kinds: ['weapon'] },
};

export function scriptedClassArg(
  callPath: string | null | undefined,
): { arg: number; kinds: ScriptedKind[] } | undefined {
  if (!callPath) return undefined;
  const direct = CLASS_ARGS[callPath];
  if (direct) return direct;
  const colon = callPath.lastIndexOf(':');
  return colon === -1 ? undefined : CLASS_ARG_METHODS[callPath.slice(colon + 1)];
}

/**
 * Which file to open when someone jumps to a class.
 *
 * shared.lua holds the class definition in the usual three-file layout, so it
 * is a better landing spot than the realm-specific halves.
 */
const FILE_RANK = ['shared.lua', 'init.lua', 'cl_init.lua'];

export function rankClassFile(fsPath: string): number {
  const file = fsPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const rank = FILE_RANK.indexOf(file);
  return rank === -1 ? FILE_RANK.length : rank;
}
