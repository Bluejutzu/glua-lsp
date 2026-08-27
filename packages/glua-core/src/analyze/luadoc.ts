import type { GmodApi } from '../api/index.js';
import { NIL, UNKNOWN, fromApiType, tableType, union, type GType } from './types.js';

/**
 * LuaDoc annotations, the same `---@param` dialect the Lua Language Server uses.
 *
 * Lua has no type syntax, so a comment is the only place to say "this parameter
 * is a Player". Following LuaLS rather than inventing something means the
 * annotations already in people's code work, and annotations written for this
 * keep working elsewhere.
 */
export interface DocParam {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

export interface LuaDoc {
  params: Map<string, DocParam>;
  returns: { type: string; name?: string }[];
  /** `---@type X` on a local or field declaration. */
  type?: string;
  /** `---@class Name : Parent` */
  class?: { name: string; parent?: string };
  fields: Map<string, DocParam>;
  /** Whether the symbol is marked `---@deprecated`. */
  deprecated?: string | true;
  /** The prose left after the annotations are removed. */
  description: string;
}

const EMPTY: LuaDoc = {
  params: new Map(),
  returns: [],
  fields: new Map(),
  description: '',
};

/**
 * Splits a type expression on top-level `|`, ignoring separators nested inside
 * `<>`, `()` or `[]` so `table<string, Player|nil>` stays in one piece.
 */
function splitUnion(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth++;
    else if (char === '>' || char === ')' || char === ']') depth--;
    if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Resolves a LuaDoc type expression against the GMod API. */
export function typeFromDoc(text: string, api: GmodApi): GType {
  const raw = text.trim();
  if (!raw) return UNKNOWN;

  const options = splitUnion(raw);
  if (options.length > 1) return union(options.map((o) => typeFromDoc(o, api)));

  let name = options[0]!;

  // `Player?` is shorthand for `Player|nil`.
  if (name.endsWith('?')) {
    return union([typeFromDoc(name.slice(0, -1), api), NIL]);
  }
  // `Entity[]` is an array of Entity.
  if (name.endsWith('[]')) {
    return tableType({ element: typeFromDoc(name.slice(0, -2), api) });
  }
  // `table<string, Player>` — the value type is the useful half.
  const generic = /^table\s*<\s*(.+?)\s*,\s*(.+?)\s*>$/.exec(name);
  if (generic) {
    return tableType({ element: typeFromDoc(generic[2]!, api) });
  }
  if (/^fun\s*\(/.test(name)) return { kind: 'function' };

  // Strip a wrapping paren group, e.g. `(Player|Entity)[]` already handled above.
  if (name.startsWith('(') && name.endsWith(')')) name = name.slice(1, -1);

  return fromApiType(name, api);
}

/**
 * Is this token actually a type, or just the first word of a description?
 *
 * People write `--- @param ply the player who fired` without a type at all, and
 * guessing that `the` is a type would be worse than ignoring the line.
 */
export function looksLikeType(text: string, api: GmodApi): boolean {
  const raw = text.trim().replace(/[?]$/, '').replace(/\[\]$/, '');
  if (!raw) return false;

  if (/^(?:table|fun)\s*[<(]/.test(raw)) return true;
  if (splitUnion(raw).length > 1) return splitUnion(raw).every((o) => looksLikeType(o, api));

  const known = new Set([
    'any', 'nil', 'null', 'boolean', 'bool', 'number', 'integer', 'int',
    'string', 'table', 'function', 'thread', 'userdata', 'vararg', 'self',
  ]);
  if (known.has(raw.toLowerCase())) return true;

  return api.isClass(raw) || Boolean(api.getStruct(raw));
}

const ANNOTATION = /^\s*@(\w+)\s*(.*)$/;

/**
 * Parses a documentation comment block.
 *
 * `raw` is the comment text with the leading dashes already stripped, one
 * comment line per text line.
 */
export function parseLuaDoc(raw: string | undefined, api: GmodApi): LuaDoc {
  if (!raw || !raw.includes('@')) {
    return raw ? { ...EMPTY, params: new Map(), fields: new Map(), returns: [], description: raw } : EMPTY;
  }

  const doc: LuaDoc = {
    params: new Map(),
    returns: [],
    fields: new Map(),
    description: '',
  };
  const prose: string[] = [];

  for (const line of raw.split('\n')) {
    const match = ANNOTATION.exec(line);
    if (!match) {
      prose.push(line);
      continue;
    }

    const tag = match[1]!.toLowerCase();
    const rest = match[2]!.trim();

    switch (tag) {
      case 'param': {
        // `---@param name[?] <type> [description]`
        const parts = /^([A-Za-z_][\w]*)(\??)\s+(\S+)\s*(.*)$/.exec(rest);
        if (!parts) {
          prose.push(line);
          break;
        }
        const [, name, question, type, description] = parts;
        if (!looksLikeType(type!, api)) {
          // No type given — keep the line as documentation.
          prose.push(line);
          break;
        }
        doc.params.set(name!, {
          name: name!,
          type: type!,
          optional: question === '?' || type!.endsWith('?'),
          ...(description ? { description } : {}),
        });
        break;
      }

      case 'return': {
        const parts = /^(\S+)\s*(.*)$/.exec(rest);
        if (!parts || !looksLikeType(parts[1]!, api)) {
          prose.push(line);
          break;
        }
        const name = /^([A-Za-z_][\w]*)\b/.exec(parts[2] ?? '')?.[1];
        doc.returns.push({ type: parts[1]!, ...(name ? { name } : {}) });
        break;
      }

      case 'type': {
        const first = rest.split(/\s+/)[0];
        if (first && looksLikeType(first, api)) doc.type = first;
        else prose.push(line);
        break;
      }

      case 'class': {
        const parts = /^([A-Za-z_][\w.]*)\s*(?::\s*([A-Za-z_][\w.]*))?/.exec(rest);
        if (parts) {
          doc.class = { name: parts[1]!, ...(parts[2] ? { parent: parts[2] } : {}) };
        }
        break;
      }

      case 'field': {
        const parts = /^([A-Za-z_][\w]*)(\??)\s+(\S+)\s*(.*)$/.exec(rest);
        if (!parts || !looksLikeType(parts[3]!, api)) {
          prose.push(line);
          break;
        }
        doc.fields.set(parts[1]!, {
          name: parts[1]!,
          type: parts[3]!,
          optional: parts[2] === '?',
          ...(parts[4] ? { description: parts[4] } : {}),
        });
        break;
      }

      case 'deprecated':
        doc.deprecated = rest || true;
        break;

      default:
        // Unknown tags (@see, @usage, @author, ...) stay as documentation.
        prose.push(line);
    }
  }

  doc.description = prose.join('\n').trim();
  return doc;
}
