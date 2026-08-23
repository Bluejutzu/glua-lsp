import { nodePathAt, type MemberExpression } from '../parser/ast.js';
import { exprToPath, type FileAnalysis, type Span } from '../analyze/binder.js';
import { scriptedClassArg } from '../analyze/entities.js';
import type { VarSymbol } from '../analyze/scope.js';
import { HOOK_TABLES, type GmodApi, type EnumLookup } from '../api/index.js';
import type { ApiFunction } from '../api/types.js';
import type { GType } from '../analyze/types.js';
import { enclosingCall } from './context.js';

export type Resolution =
  | { kind: 'local'; symbol: VarSymbol; nameSpan: Span }
  | { kind: 'api'; fn: ApiFunction; nameSpan: Span; receiver?: GType }
  | { kind: 'enum'; key: string; lookup: EnumLookup; nameSpan: Span }
  | { kind: 'library'; name: string; nameSpan: Span }
  | { kind: 'class'; name: string; nameSpan: Span }
  | { kind: 'global'; path: string; root: string; nameSpan: Span; type: GType }
  | { kind: 'hookName'; name: string; nameSpan: Span }
  | { kind: 'netMessage'; name: string; nameSpan: Span }
  | { kind: 'includePath'; path: string; nameSpan: Span }
  | { kind: 'panelClass'; name: string; nameSpan: Span }
  | { kind: 'scriptedClass'; name: string; nameSpan: Span }
  | {
      kind: 'hookTable';
      name: string;
      hookParent: string;
      selfClass: string;
      nameSpan: Span;
    };

const span = (node: { start: number; end: number }): Span => ({ start: node.start, end: node.end });

/**
 * What is under the cursor? Shared by hover, go-to-definition, references and
 * rename so they can never disagree about what the user pointed at.
 */
export function resolveAt(
  analysis: FileAnalysis,
  offset: number,
  api: GmodApi,
): Resolution | null {
  const path = nodePathAt(analysis.chunk, offset);
  if (!path.length) return null;

  const innermost = path[0]!;

  if (innermost.type === 'StringLiteral') {
    const call = enclosingCall(analysis, innermost.start);
    const callPath = call ? exprToPath(call.call.base) : null;
    const nameSpan = { start: innermost.start + 1, end: innermost.end - 1 };

    // Whether the workspace actually has this class is the caller's problem —
    // resolveAt has no index to check against.
    const classArg = scriptedClassArg(callPath);
    if (classArg && call?.argIndex === classArg.arg) {
      return { kind: 'scriptedClass', name: innermost.value, nameSpan };
    }

    if (call?.argIndex === 0) {
      switch (callPath) {
        case 'hook.Add':
        case 'hook.Run':
        case 'hook.Call':
        case 'hook.Remove':
          return { kind: 'hookName', name: innermost.value, nameSpan };
        case 'net.Start':
        case 'net.Receive':
        case 'util.AddNetworkString':
          return { kind: 'netMessage', name: innermost.value, nameSpan };
        case 'include':
        case 'AddCSLuaFile':
        case 'IncludeCS':
          return { kind: 'includePath', path: innermost.value, nameSpan };
        case 'vgui.Create':
          if (api.isClass(innermost.value)) {
            return { kind: 'panelClass', name: innermost.value, nameSpan };
          }
          break;
        case 'FindMetaTable':
          if (api.isClass(innermost.value)) {
            return { kind: 'class', name: innermost.value, nameSpan };
          }
          break;
        default:
          break;
      }
    }
    return null;
  }

  if (innermost.type !== 'Identifier' || innermost.missing) return null;
  const identifier = innermost;
  const parent = path[1];

  // Member access: resolve against the base expression's inferred type.
  if (parent?.type === 'MemberExpression' && parent.identifier === identifier) {
    return resolveMember(analysis, parent, api);
  }

  // A plain identifier.
  const local = analysis.scopeAt(identifier.start).lookup(identifier.name, identifier.start);
  if (local) return { kind: 'local', symbol: local, nameSpan: span(identifier) };

  const global = api.getGlobal(identifier.name);
  if (global) return { kind: 'api', fn: global, nameSpan: span(identifier) };

  if (api.getLibrary(identifier.name)) {
    return { kind: 'library', name: identifier.name, nameSpan: span(identifier) };
  }

  const enumEntry = api.getEnum(identifier.name);
  if (enumEntry) {
    return { kind: 'enum', key: identifier.name, lookup: enumEntry, nameSpan: span(identifier) };
  }

  if (api.isClass(identifier.name)) {
    return { kind: 'class', name: identifier.name, nameSpan: span(identifier) };
  }

  const hookTable = HOOK_TABLES[identifier.name];
  if (hookTable) {
    return {
      kind: 'hookTable',
      name: identifier.name,
      hookParent: hookTable.hookParent,
      selfClass: hookTable.selfClass,
      nameSpan: span(identifier),
    };
  }

  return {
    kind: 'global',
    path: identifier.name,
    root: identifier.name,
    nameSpan: span(identifier),
    type: analysis.typeOf(identifier),
  };
}

function resolveMember(
  analysis: FileAnalysis,
  member: MemberExpression,
  api: GmodApi,
): Resolution | null {
  const { base, identifier, indexer } = member;
  const baseType = analysis.typeOf(base);
  const nameSpan = span(identifier);

  const fromType = (type: GType): ApiFunction | undefined => {
    switch (type.kind) {
      case 'table':
        if (type.library) {
          return api.getLibrary(type.library)?.[identifier.name] ??
            api.getClassMember(type.library, identifier.name);
        }
        if (type.hookTable) return api.getHooksFor(type.hookTable)[identifier.name];
        return undefined;
      case 'class':
        return api.getClassMember(type.name, identifier.name);
      case 'union':
        for (const option of type.options) {
          const hit = fromType(option);
          if (hit) return hit;
        }
        return undefined;
      default:
        return undefined;
    }
  };

  const fn = fromType(baseType);
  if (fn) return { kind: 'api', fn, nameSpan, receiver: baseType };

  const basePath = exprToPath(base);
  if (basePath) {
    return {
      kind: 'global',
      path: `${basePath}${indexer}${identifier.name}`,
      root: basePath.split(/[.:]/)[0]!,
      nameSpan,
      type: analysis.typeOf(member),
    };
  }

  return null;
}
