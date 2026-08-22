import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiData, ApiEnumItem, ApiFunction, ApiStruct, Realm } from './types.js';

/**
 * Class inheritance the wiki does not encode. Small, stable, and the difference
 * between `ply:GetPos()` resolving or not.
 */
const EXPLICIT_PARENTS: Record<string, string> = {
  Player: 'Entity',
  Weapon: 'Entity',
  NPC: 'Entity',
  Vehicle: 'Entity',
  NextBot: 'Entity',
  CSEnt: 'Entity',
  DTree_Node: 'Panel',
  DListView_Line: 'Panel',
  DListView_Column: 'Panel',
};

/**
 * Hook tables and the class whose `self` they bind. `function ENT:Think()` puts
 * an Entity in scope; `function SWEP:PrimaryAttack()` puts a Weapon.
 */
export const HOOK_TABLES: Record<string, { hookParent: string; selfClass: string }> = {
  ENT: { hookParent: 'ENTITY', selfClass: 'Entity' },
  ENTITY: { hookParent: 'ENTITY', selfClass: 'Entity' },
  SWEP: { hookParent: 'WEAPON', selfClass: 'Weapon' },
  WEAPON: { hookParent: 'WEAPON', selfClass: 'Weapon' },
  PANEL: { hookParent: 'PANEL', selfClass: 'Panel' },
  EFFECT: { hookParent: 'EFFECT', selfClass: 'Entity' },
  TOOL: { hookParent: 'TOOL', selfClass: 'Tool' },
  GM: { hookParent: 'GM', selfClass: 'table' },
  GAMEMODE: { hookParent: 'GM', selfClass: 'table' },
};

/** Hook parents that `hook.Add` actually dispatches. The rest are metatables. */
const GLOBAL_HOOK_PARENTS = ['GM', 'SANDBOX'];

/**
 * Lua/LuaJIT base globals that may be absent from the wiki dump. Listing them
 * only suppresses "undefined global"; documented ones still win for hover.
 */
const EXTRA_BASE_GLOBALS = [
  '_G', '_VERSION', 'arg', 'assert', 'collectgarbage', 'dofile', 'error',
  'getfenv', 'getmetatable', 'gcinfo', 'ipairs', 'load', 'loadfile', 'loadstring',
  'module', 'newproxy', 'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget',
  'rawlen', 'rawset', 'require', 'select', 'setfenv', 'setmetatable', 'tonumber',
  'tostring', 'type', 'unpack', 'xpcall',
  // Ubiquitous GMod globals that are variables, not functions, so the wiki
  // documents them (if at all) outside the function pages we scrape.
  'CLIENT', 'SERVER', 'MENU_DLL', 'CLIENT_DLL', 'SERVER_DLL', 'GAMEMODE', 'GM',
  'ENT', 'SWEP', 'PANEL', 'EFFECT', 'TOOL', 'NULL', 'Entity', 'self',
  'color_white', 'color_black', 'color_transparent',
  'vector_origin', 'vector_up', 'angle_zero',
  'VERSION', 'VERSIONSTR', 'BRANCH', 'Msg', 'MsgN',
  'RealTime', 'SysTime', 'FrameTime', 'CurTime',
  'ScrW', 'ScrH', 'LocalPlayer', 'DEFINE_BASECLASS',
  'list', 'spawnmenu', 'derma',
];

export interface EnumLookup {
  item: ApiEnumItem;
  enumName: string;
  realm: Realm;
}

export class GmodApi {
  readonly data: ApiData;

  private readonly parents = new Map<string, string>();
  private readonly flatClassCache = new Map<string, Map<string, ApiFunction>>();
  private readonly enumIndex = new Map<string, EnumLookup>();
  private readonly baseGlobals = new Set(EXTRA_BASE_GLOBALS);
  private readonly hookNameCache = new Map<string, ApiFunction>();

  constructor(data: ApiData) {
    this.data = data;

    for (const [child, parent] of Object.entries(EXPLICIT_PARENTS)) {
      this.parents.set(child, parent);
    }
    // Every documented panel type inherits the Panel metatable.
    for (const panel of Object.keys(data.panels)) {
      if (panel !== 'Panel' && !this.parents.has(panel)) this.parents.set(panel, 'Panel');
    }
    for (const cls of Object.keys(data.classes)) {
      if (cls !== 'Panel' && /^D[A-Z]/.test(cls) && !this.parents.has(cls)) {
        this.parents.set(cls, 'Panel');
      }
    }

    for (const [enumName, entry] of Object.entries(data.enums)) {
      for (const item of entry.items) {
        // Enum keys are written `MOVETYPE_WALK` or occasionally `Enum.FIELD`.
        if (!this.enumIndex.has(item.key)) {
          this.enumIndex.set(item.key, { item, enumName, realm: entry.realm });
        }
      }
    }

    for (const parent of GLOBAL_HOOK_PARENTS) {
      for (const [name, fn] of Object.entries(data.hooks[parent] ?? {})) {
        if (!this.hookNameCache.has(name)) this.hookNameCache.set(name, fn);
      }
    }
  }

  static load(dataFile?: string): GmodApi {
    const file =
      dataFile ?? path.join(__dirname, 'gmod-api.json');
    const raw = readFileSync(file, 'utf8');
    return new GmodApi(JSON.parse(raw) as ApiData);
  }

  /* ------------------------------------------------------------- lookups */

  getGlobal(name: string): ApiFunction | undefined {
    return this.data.globals[name];
  }

  isKnownGlobal(name: string): boolean {
    return (
      name in this.data.globals ||
      name in this.data.libraries ||
      this.enumIndex.has(name) ||
      this.baseGlobals.has(name) ||
      name in this.data.classes ||
      name in HOOK_TABLES
    );
  }

  getLibrary(name: string): Record<string, ApiFunction> | undefined {
    return this.data.libraries[name];
  }

  libraryNames(): string[] {
    return Object.keys(this.data.libraries);
  }

  classNames(): string[] {
    return Object.keys(this.data.classes);
  }

  parentOf(className: string): string | undefined {
    return this.parents.get(className);
  }

  /** All members of a class including inherited ones, nearest override winning. */
  getClassMembers(className: string): Map<string, ApiFunction> {
    const cached = this.flatClassCache.get(className);
    if (cached) return cached;

    const out = new Map<string, ApiFunction>();
    const seen = new Set<string>();
    let current: string | undefined = className;

    while (current && !seen.has(current)) {
      seen.add(current);
      // A type can appear in both buckets — DFrame's own methods are scraped as
      // panelfunc while some are documented as classfunc. Merge, do not pick.
      for (const own of [this.data.classes[current], this.data.panels[current]]) {
        if (!own) continue;
        for (const [name, fn] of Object.entries(own)) {
          if (!out.has(name)) out.set(name, fn);
        }
      }
      current = this.parents.get(current);
    }

    this.flatClassCache.set(className, out);
    return out;
  }

  getClassMember(className: string, member: string): ApiFunction | undefined {
    return this.getClassMembers(className).get(member);
  }

  isClass(name: string): boolean {
    return name in this.data.classes || name in this.data.panels;
  }

  /** Hooks dispatchable through `hook.Add`. */
  getGlobalHook(name: string): ApiFunction | undefined {
    return this.hookNameCache.get(name);
  }

  globalHookNames(): IterableIterator<string> {
    return this.hookNameCache.keys();
  }

  getHooksFor(parent: string): Record<string, ApiFunction> {
    return this.data.hooks[parent] ?? {};
  }

  getEnum(key: string): EnumLookup | undefined {
    return this.enumIndex.get(key);
  }

  enumKeys(): IterableIterator<string> {
    return this.enumIndex.keys();
  }

  getStruct(name: string): ApiStruct | undefined {
    return this.data.structs[name];
  }

  structNames(): string[] {
    return Object.keys(this.data.structs);
  }

  /* --------------------------------------------------------------- realm */

  /** Can a member documented for `memberRealm` be used from `fileRealm`? */
  static realmAllows(fileRealm: Realm, memberRealm: Realm): boolean {
    if (memberRealm === 'shared') return true;
    if (fileRealm === 'shared') return true; // shared files branch at runtime
    if (fileRealm === 'menu') return memberRealm === 'menu' || memberRealm === 'client';
    return fileRealm === memberRealm;
  }
}
