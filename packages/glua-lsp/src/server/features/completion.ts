import {
  CompletionItemKind,
  CompletionItemTag,
  InsertTextFormat,
  type CompletionItem,
  type CompletionList,
  type Position,
} from 'vscode-languageserver';
import { GmodApi, HOOK_TABLES } from '../../api/index.js';
import type { ApiFunction, Realm } from '../../api/types.js';
import type { FileAnalysis } from '../../analyze/binder.js';
import { realmAt } from '../../analyze/realm.js';
import { typeToString, type GType } from '../../analyze/types.js';
import type { Workspace } from '../../analyze/workspace.js';
import { completionContextAt, type CompletionContext } from '../context.js';
import { renderApiFunction, signatureLine } from '../render.js';
import type { Settings } from '../settings.js';

/** Sort buckets, lowest first — locals should always beat the 5,000 API names. */
const enum Sort {
  Local = 0,
  Self = 1,
  WorkspaceMember = 2,
  ApiMember = 3,
  WorkspaceGlobal = 4,
  ApiGlobal = 5,
  Enum = 6,
  Keyword = 7,
  Snippet = 8,
}

const KEYWORDS = [
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat',
  'return', 'then', 'true', 'until', 'while',
];

const SNIPPETS: { label: string; detail: string; body: string }[] = [
  {
    label: 'hook.Add',
    detail: 'Add a gamemode hook',
    body: 'hook.Add("${1:PlayerSpawn}", "${2:unique.identifier}", function(${3:ply})\n\t$0\nend)',
  },
  {
    label: 'net message (server -> client)',
    detail: 'AddNetworkString + Start + Send',
    body:
      'util.AddNetworkString("${1:my_message}")\n\nnet.Start("${1:my_message}")\n\t' +
      'net.Write${2:String}(${3:value})\nnet.Send(${4:ply})',
  },
  {
    label: 'net.Receive',
    detail: 'Receive a net message',
    body: 'net.Receive("${1:my_message}", function(len, ply)\n\t$0\nend)',
  },
  {
    label: 'timer.Create',
    detail: 'Repeating timer',
    body: 'timer.Create("${1:name}", ${2:1}, ${3:0}, function()\n\t$0\nend)',
  },
  {
    label: 'ternary (a and b or c)',
    detail: "Lua's conditional expression idiom",
    body: '${1:cond} and ${2:whenTrue} or ${3:whenFalse}',
  },
  {
    label: 'IsValid guard',
    detail: 'Bail out when an entity is invalid',
    body: 'if not IsValid(${1:ent}) then return end\n$0',
  },
];

export interface CompletionDeps {
  api: GmodApi;
  workspace: Workspace;
  settings: Settings;
}

export function completion(
  analysis: FileAnalysis,
  position: Position,
  deps: CompletionDeps,
): CompletionList {
  const offset = analysis.lines.offsetAt(position);
  const context = completionContextAt(analysis, offset);
  const realm = realmAt(analysis.realm, offset);

  const items: CompletionItem[] =
    context.kind === 'string'
      ? stringCompletions(analysis, context, deps)
      : context.kind === 'member'
        ? memberCompletions(analysis, context, realm, deps)
        : identifierCompletions(analysis, context, offset, realm, deps);

  return {
    // Large and context-dependent: let the client re-ask as the prefix grows.
    isIncomplete: items.length > 400,
    items,
  };
}

/* -------------------------------------------------------------- members */

function memberCompletions(
  analysis: FileAnalysis,
  context: Extract<CompletionContext, { kind: 'member' }>,
  realm: Realm,
  deps: CompletionDeps,
): CompletionItem[] {
  const { api, workspace, settings } = deps;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const base = context.baseType;

  const addApiFunction = (fn: ApiFunction, kind: CompletionItemKind, sort: Sort) => {
    if (seen.has(fn.name)) return;
    // `:` and `.` select different halves of a class's surface.
    if (settings.completion.filterByRealm && !GmodApi.realmAllows(realm, fn.realm)) return;
    seen.add(fn.name);
    items.push(apiItem(fn, kind, sort, settings));
  };

  switch (base.kind) {
    case 'table': {
      if (base.library) {
        for (const fn of Object.values(api.getLibrary(base.library) ?? {})) {
          addApiFunction(fn, CompletionItemKind.Function, Sort.ApiMember);
        }
        // A handful of names are documented as both library and class.
        for (const fn of api.getClassMembers(base.library).values()) {
          addApiFunction(fn, CompletionItemKind.Method, Sort.ApiMember);
        }
      }
      if (base.hookTable) {
        for (const fn of Object.values(api.getHooksFor(base.hookTable))) {
          if (seen.has(fn.name)) continue;
          seen.add(fn.name);
          items.push(hookDefinitionItem(fn, settings));
        }
      }
      if (base.struct) {
        for (const field of api.getStruct(base.struct)?.fields ?? []) {
          if (seen.has(field.name)) continue;
          seen.add(field.name);
          items.push({
            label: field.name,
            kind: CompletionItemKind.Field,
            detail: field.type,
            documentation: field.description,
            sortText: `${Sort.ApiMember}${field.name}`,
          });
        }
      }
      for (const [name, type] of base.members ?? []) {
        if (seen.has(name)) continue;
        seen.add(name);
        items.push(localMemberItem(name, type, Sort.WorkspaceMember));
      }
      break;
    }

    case 'class': {
      for (const fn of api.getClassMembers(base.name).values()) {
        addApiFunction(fn, CompletionItemKind.Method, Sort.ApiMember);
      }
      // Getters and setters Garry's Mod generates from NetworkVar and
      // AccessorFunc. They only exist at runtime, so nothing else knows them.
      if (isEntityLike(base.name, api)) {
        for (const { value } of workspace.accessorsNear(analysis.fsPath)) {
          for (const prefix of ['Get', 'Set'] as const) {
            const label = `${prefix}${value.name}`;
            if (seen.has(label)) continue;
            seen.add(label);
            items.push({
              label,
              kind: CompletionItemKind.Method,
              detail:
                prefix === 'Get'
                  ? `(): ${value.valueType}`
                  : `(value: ${value.valueType})`,
              documentation: `Generated by \`${value.origin}("${value.name}")\` in this ${
                value.origin === 'AccessorFunc' ? 'file' : 'entity'
              }.`,
              sortText: `${Sort.WorkspaceMember}${label}`,
            });
          }
        }
      }
      break;
    }

    case 'union': {
      for (const option of base.options) {
        if (option.kind !== 'class') continue;
        for (const fn of api.getClassMembers(option.name).values()) {
          addApiFunction(fn, CompletionItemKind.Method, Sort.ApiMember);
        }
      }
      break;
    }

    default:
      break;
  }

  // Members contributed by other files in the workspace, e.g. `MyAddon.Config`.
  if (context.basePath) {
    for (const name of workspace.membersOf(context.basePath)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const defs = workspace.definitionsOf(`${context.basePath}.${name}`);
      const def = defs[0]?.value;
      items.push({
        label: name,
        kind: def?.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Field,
        detail: def?.kind === 'function' ? `(${(def.params ?? []).join(', ')})` : 'workspace',
        documentation: def?.doc,
        sortText: `${Sort.WorkspaceMember}${name}`,
      });
    }
  }

  void analysis;
  return items;
}

/* ---------------------------------------------------------- identifiers */

function identifierCompletions(
  analysis: FileAnalysis,
  context: Extract<CompletionContext, { kind: 'identifier' }>,
  offset: number,
  realm: Realm,
  deps: CompletionDeps,
): CompletionItem[] {
  const { api, workspace, settings } = deps;
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // Locals first — they are what the user almost always means.
  for (const symbol of analysis.scopeAt(offset).visibleAt(offset)) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    items.push({
      label: symbol.name,
      kind:
        symbol.type.kind === 'function'
          ? CompletionItemKind.Function
          : symbol.kind === 'param'
            ? CompletionItemKind.Variable
            : CompletionItemKind.Variable,
      detail: `${symbol.kind}: ${typeToString(symbol.type)}`,
      documentation: symbol.doc,
      sortText: `${symbol.kind === 'self' ? Sort.Self : Sort.Local}${symbol.name}`,
    });
  }

  // Libraries and hook tables.
  for (const name of api.libraryNames()) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Module,
      detail: 'library',
      sortText: `${Sort.ApiGlobal}${name}`,
    });
  }
  for (const [name, table] of Object.entries(HOOK_TABLES)) {
    if (seen.has(name) || name === 'ENTITY' || name === 'WEAPON') continue;
    seen.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Class,
      detail: `${table.hookParent} hook table`,
      sortText: `${Sort.ApiGlobal}${name}`,
    });
  }

  for (const fn of Object.values(api.data.globals)) {
    if (seen.has(fn.name)) continue;
    if (settings.completion.filterByRealm && !GmodApi.realmAllows(realm, fn.realm)) continue;
    seen.add(fn.name);
    items.push(apiItem(fn, CompletionItemKind.Function, Sort.ApiGlobal, settings));
  }

  // Workspace globals from every indexed file.
  for (const uri of workspace.uris()) {
    const file = workspace.get(uri);
    if (!file) continue;
    for (const def of file.globalDefs) {
      const name = def.root;
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        label: name,
        kind: def.kind === 'function' && def.path === name
          ? CompletionItemKind.Function
          : def.kind === 'table' || def.path !== name
            ? CompletionItemKind.Module
            : CompletionItemKind.Variable,
        detail: def.path === name && def.kind === 'function'
          ? `(${(def.params ?? []).join(', ')})`
          : 'workspace global',
        documentation: def.doc,
        sortText: `${Sort.WorkspaceGlobal}${name}`,
      });
    }
  }

  for (const key of api.enumKeys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = api.getEnum(key)!;
    items.push({
      label: key,
      kind: CompletionItemKind.EnumMember,
      detail: `${entry.enumName} = ${entry.item.value}`,
      documentation: entry.item.description,
      sortText: `${Sort.Enum}${key}`,
    });
  }

  for (const keyword of KEYWORDS) {
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      sortText: `${Sort.Keyword}${keyword}`,
    });
  }

  if (context.prefix.length === 0 || /^[a-z]/i.test(context.prefix)) {
    for (const snippet of SNIPPETS) {
      items.push({
        label: snippet.label,
        kind: CompletionItemKind.Snippet,
        detail: snippet.detail,
        insertText: snippet.body,
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: `${Sort.Snippet}${snippet.label}`,
      });
    }
  }

  return items;
}

/* --------------------------------------------------------- string args */

function stringCompletions(
  analysis: FileAnalysis,
  context: Extract<CompletionContext, { kind: 'string' }>,
  deps: CompletionDeps,
): CompletionItem[] {
  const { api, workspace } = deps;
  const items: CompletionItem[] = [];
  const { callPath, argIndex } = context;

  const push = (
    label: string,
    detail: string,
    documentation?: string,
    kind: CompletionItemKind = CompletionItemKind.Value,
  ) => {
    items.push({ label, kind, detail, documentation, sortText: `0${label}` });
  };

  if ((callPath === 'hook.Add' || callPath === 'hook.Run' || callPath === 'hook.Call' || callPath === 'hook.Remove') && argIndex === 0) {
    for (const name of api.globalHookNames()) {
      const hook = api.getGlobalHook(name)!;
      push(name, signatureLine(hook), hook.description, CompletionItemKind.Event);
    }
    // Hooks this workspace defines itself via hook.Run.
    for (const [name, sites] of workspace.customHookNames()) {
      if (api.getGlobalHook(name)) continue;
      push(name, `custom hook · ${sites.length} call site${sites.length === 1 ? '' : 's'}`, undefined, CompletionItemKind.Event);
    }
    return items;
  }

  if ((callPath === 'net.Start' || callPath === 'net.Receive' || callPath === 'util.AddNetworkString') && argIndex === 0) {
    const registered = workspace.netRegistered();
    const starts = workspace.netStarts();
    const receives = workspace.netReceives();
    const names = new Set([...registered.keys(), ...starts.keys(), ...receives.keys()]);
    for (const name of names) {
      const where: string[] = [];
      if (registered.has(name)) where.push('registered');
      if (starts.has(name)) where.push(`${starts.get(name)!.length} send`);
      if (receives.has(name)) where.push(`${receives.get(name)!.length} receive`);
      push(name, `net message · ${where.join(', ')}`, undefined, CompletionItemKind.Event);
    }
    return items;
  }

  if ((callPath === 'vgui.Create' || callPath === 'Panel:Add' || callPath?.endsWith(':Add')) && argIndex === 0) {
    for (const name of Object.keys(api.data.panels)) {
      if (name === 'Panel') continue;
      push(name, 'VGUI panel', undefined, CompletionItemKind.Class);
    }
    return items;
  }

  if ((callPath === 'include' || callPath === 'AddCSLuaFile' || callPath === 'IncludeCS') && argIndex === 0) {
    const here = analysis.fsPath.replace(/\\/g, '/');
    const luaRoot = here.toLowerCase().lastIndexOf('/lua/');
    for (const uri of workspace.uris()) {
      const file = workspace.get(uri);
      if (!file || file.uri === analysis.uri) continue;
      const other = file.fsPath.replace(/\\/g, '/');
      const relative =
        luaRoot >= 0 && other.toLowerCase().startsWith(here.slice(0, luaRoot + 5).toLowerCase())
          ? other.slice(luaRoot + 5)
          : other.split('/').pop()!;
      push(relative, `${file.realm.file} · ${file.realm.kind}`, undefined, CompletionItemKind.File);
    }
    return items;
  }

  if (callPath === 'FindMetaTable' && argIndex === 0) {
    for (const name of api.classNames()) push(name, 'metatable', undefined, CompletionItemKind.Class);
    return items;
  }

  if (callPath === 'concommand.Add' && argIndex === 0) {
    for (const uri of workspace.uris()) {
      for (const cmd of workspace.get(uri)?.concommands ?? []) {
        push(cmd.path, 'existing console command');
      }
    }
    return items;
  }

  return items;
}

/* ---------------------------------------------------------------- items */

function apiItem(
  fn: ApiFunction,
  kind: CompletionItemKind,
  sort: Sort,
  settings: Settings,
): CompletionItem {
  const item: CompletionItem = {
    label: fn.name,
    kind,
    detail: signatureLine(fn),
    documentation: renderApiFunction(fn, {
      wikiLinks: settings.hover.wikiLinks,
      detailed: false,
    }),
    sortText: `${sort}${fn.name}`,
  };

  if (fn.deprecated || fn.removed) item.tags = [CompletionItemTag.Deprecated];

  if (settings.completion.callSnippets) {
    const required = fn.params.filter((p) => !p.optional && p.default === undefined);
    const placeholders = required
      .map((p, i) => `\${${i + 1}:${p.name || p.type}}`)
      .join(', ');
    item.insertText = `${fn.name}(${placeholders})${required.length ? '' : '$0'}`;
    item.insertTextFormat = InsertTextFormat.Snippet;
  }

  return item;
}

/** `function ENT:Think()` style completion — inserts the whole stub. */
function hookDefinitionItem(fn: ApiFunction, settings: Settings): CompletionItem {
  const params = fn.params.map((p) => p.name || p.type).join(', ');
  return {
    label: fn.name,
    kind: CompletionItemKind.Method,
    detail: signatureLine(fn),
    documentation: renderApiFunction(fn, { wikiLinks: settings.hover.wikiLinks, detailed: false }),
    insertText: `${fn.name}(${params})\n\t$0\nend`,
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: `${Sort.ApiMember}${fn.name}`,
  };
}

/** Entity and its descendants, plus Panel — the things accessors get attached to. */
function isEntityLike(className: string, api: GmodApi): boolean {
  for (let c: string | undefined = className; c; c = api.parentOf(c)) {
    if (c === 'Entity' || c === 'Panel') return true;
  }
  return false;
}

function localMemberItem(name: string, type: GType, sort: Sort): CompletionItem {
  return {
    label: name,
    kind: type.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Field,
    detail: typeToString(type),
    sortText: `${sort}${name}`,
  };
}
