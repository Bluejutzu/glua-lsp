import fs from 'node:fs';
import path from 'node:path';
import { readVpkDirectory } from './vpk.js';

/**
 * Materials, models and sounds referenced by string literal.
 *
 * None of these fail loudly at runtime: a missing material renders as the
 * purple-and-black checkerboard, a missing sound is silence, a missing model is
 * the red error sign. Nothing raises a Lua error, so nothing else catches them.
 */
export type AssetKind = 'material' | 'model' | 'sound';

interface AssetRoot {
  /** Directory holding the kind's tree, e.g. `<addon>/materials`. */
  dir: string;
  kind: AssetKind;
}

/** Directory each kind lives under, and the extensions it can have. */
const SHAPES: Record<AssetKind, { dir: string; extensions: string[] }> = {
  material: { dir: 'materials', extensions: ['.vmt', '.png', '.jpg', '.jpeg', '.vtf'] },
  model: { dir: 'models', extensions: ['.mdl'] },
  sound: { dir: 'sound', extensions: ['.wav', '.mp3', '.ogg'] },
};

/**
 * Which asset a string argument names, keyed on the wiki address so a method
 * written on a receiver still matches.
 */
const ASSET_ARGS: Record<string, { arg: number; kind: AssetKind }> = {
  Material: { arg: 0, kind: 'material' },
  'surface.GetTextureID': { arg: 0, kind: 'material' },
  'Entity:SetModel': { arg: 0, kind: 'model' },
  'Player:SetModel': { arg: 0, kind: 'model' },
  'util.PrecacheModel': { arg: 0, kind: 'model' },
  'ClientsideModel': { arg: 0, kind: 'model' },
  'Entity:EmitSound': { arg: 0, kind: 'sound' },
  'surface.PlaySound': { arg: 0, kind: 'sound' },
  'sound.Play': { arg: 0, kind: 'sound' },
  'util.PrecacheSound': { arg: 0, kind: 'sound' },
};

/** Methods matched by bare name, for calls written on a receiver variable. */
const ASSET_METHODS: Record<string, { arg: number; kind: AssetKind }> = {
  SetModel: { arg: 0, kind: 'model' },
  EmitSound: { arg: 0, kind: 'sound' },
};

export function assetArgOf(
  address: string | null | undefined,
  callPath?: string | null,
): { arg: number; kind: AssetKind } | undefined {
  if (address && ASSET_ARGS[address]) return ASSET_ARGS[address];
  const source = callPath ?? address;
  if (!source) return undefined;
  const colon = source.lastIndexOf(':');
  if (colon !== -1) return ASSET_METHODS[source.slice(colon + 1)];
  return ASSET_ARGS[source];
}

/**
 * The asset trees reachable from a set of folders.
 *
 * A Garry's Mod addon keeps its content beside `lua/`, and an install keeps the
 * base content under `garrysmod/`. Both shapes are checked so a workspace works
 * with or without a configured game directory.
 */
export class AssetIndex {
  private readonly roots: AssetRoot[] = [];
  /** Lowercase `materials/foo/bar.vmt` style paths, per kind. */
  private readonly files = new Map<AssetKind, Set<string>>();
  private scanned = false;

  /** Whether a game directory was supplied, not just workspace content. */
  private hasGameContent = false;

  constructor(
    private readonly folders: string[],
    private readonly gamePath?: string,
  ) {}

  /**
   * Diagnostics need a reasonably complete picture, and workspace content alone
   * is not one — a material can come from the base game or another addon. So
   * they stay off until a game directory says what else exists.
   */
  get canValidate(): boolean {
    this.scan();
    return this.hasGameContent && this.files.size > 0;
  }

  get size(): number {
    this.scan();
    let total = 0;
    for (const set of this.files.values()) total += set.size;
    return total;
  }

  private scan(): void {
    if (this.scanned) return;
    this.scanned = true;

    for (const folder of this.folders) this.addRootsUnder(folder, false);
    if (this.gamePath) this.addRootsUnder(this.gamePath, true);

    for (const root of this.roots) {
      walk(root.dir, SHAPES[root.kind].dir.toLowerCase(), this.setFor(root.kind), 0);
    }

    // Nearly all base content is packed, so the loose tree alone is a few
    // hundred files out of hundreds of thousands.
    if (this.gamePath) this.addPackedFiles(this.gamePath);
  }

  private setFor(kind: AssetKind): Set<string> {
    const set = this.files.get(kind) ?? new Set<string>();
    this.files.set(kind, set);
    return set;
  }

  private addPackedFiles(gamePath: string): void {
    for (const archive of findVpkDirectories(gamePath)) {
      for (const entry of readVpkDirectory(archive)) {
        for (const [kind, shape] of Object.entries(SHAPES) as [AssetKind, typeof SHAPES.material][]) {
          if (entry.startsWith(`${shape.dir}/`)) {
            this.setFor(kind).add(entry);
            this.hasGameContent = true;
            break;
          }
        }
      }
    }
  }

  /** Finds `materials/`, `models/` and `sound/` at a folder, or under `garrysmod/`. */
  private addRootsUnder(folder: string, isGame: boolean): void {
    const bases = [folder, path.join(folder, 'garrysmod')];
    // Mounted addons keep their content loose, one directory each.
    if (isGame) bases.push(...childDirectories(path.join(folder, 'garrysmod', 'addons')));
    for (const base of bases) {
      for (const [kind, shape] of Object.entries(SHAPES) as [AssetKind, typeof SHAPES.material][]) {
        const dir = path.join(base, shape.dir);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        this.roots.push({ dir, kind });
        if (isGame) this.hasGameContent = true;
      }
    }
  }

  /**
   * Is this path present?
   *
   * Extensions are optional in GMod — `Material("foo/bar")` finds `foo/bar.vmt`
   * — so a bare path matches any extension the kind allows.
   */
  has(kind: AssetKind, reference: string): boolean {
    this.scan();
    const set = this.files.get(kind);
    if (!set) return false;

    for (const candidate of candidatesFor(kind, reference)) {
      if (set.has(candidate)) return true;
    }
    return false;
  }

  /** Every known path of a kind, as written in source (without the leading dir). */
  entries(kind: AssetKind): string[] {
    this.scan();
    const prefix = `${SHAPES[kind].dir.toLowerCase()}/`;
    const out: string[] = [];
    for (const file of this.files.get(kind) ?? []) {
      out.push(kind === 'material' ? stripExtension(file.slice(prefix.length)) : file);
    }
    return out;
  }
}

/**
 * How a reference could be spelled on disk.
 *
 * `Material` takes a path relative to `materials/` and usually omits the
 * extension; models and sounds are written with their directory and extension.
 */
function candidatesFor(kind: AssetKind, reference: string): string[] {
  const clean = reference.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (!clean) return [];

  const shape = SHAPES[kind];
  const withDir = clean.startsWith(`${shape.dir}/`) ? clean : `${shape.dir}/${clean}`;

  const out = [withDir];
  if (!shape.extensions.some((ext) => withDir.endsWith(ext))) {
    for (const ext of shape.extensions) out.push(`${withDir}${ext}`);
  }
  return out;
}

function stripExtension(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? file : file.slice(0, dot);
}

function childDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** `_dir.vpk` archives anywhere under an install, a couple of levels down. */
function findVpkDirectories(gamePath: string, depth = 0): string[] {
  if (depth > 2) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(gamePath, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(gamePath, entry.name);
    if (entry.isDirectory()) {
      out.push(...findVpkDirectories(full, depth + 1));
    } else if (entry.name.toLowerCase().endsWith('_dir.vpk')) {
      out.push(full);
    }
  }
  return out;
}

const MAX_ASSET_FILES = 60000;

function walk(dir: string, prefix: string, out: Set<string>, depth: number): void {
  if (depth > 12 || out.size >= MAX_ASSET_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= MAX_ASSET_FILES) return;
    const name = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), `${prefix}/${name}`, out, depth + 1);
    } else {
      out.add(`${prefix}/${name}`);
    }
  }
}
