#!/usr/bin/env node
// Builds src/api/data/gmod-api.json from the Garry's Mod wiki.
//
// The wiki serves a machine-readable `markup` field for every page
// (https://wiki.facepunch.com/gmod/<page>?format=json). That markup is an
// XML-ish dialect: regular enough to extract with targeted regexes, but not
// well-formed enough for a real XML parser (descriptions contain bare `&`,
// unclosed <br>, nested prose tags). So we scrape structurally, not strictly.
//
//   node tools/generate-api.mjs            # incremental, uses .cache/wiki
//   node tools/generate-api.mjs --fresh    # ignore cache
//   node tools/generate-api.mjs --limit 50 # smoke test

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'wiki');
const OUT_FILE = path.join(ROOT, 'src', 'api', 'data', 'gmod-api.json');
const WIKI = 'https://wiki.facepunch.com/gmod';

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i === -1 ? Infinity : Number(args[i + 1]);
})();
const CONCURRENCY = 24;

/* ------------------------------------------------------------------ fetch */

async function fetchJson(address) {
  const cacheKey = address.replace(/[^A-Za-z0-9_.:-]/g, '_').replace(/:/g, '__') || '_index';
  const cacheFile = path.join(CACHE_DIR, cacheKey + '.json');

  if (!FRESH) {
    try {
      return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      /* cache miss */
    }
  }

  const url = `${WIKI}/${encodeURIComponent(address).replace(/%2F/g, '/')}?format=json`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'glua-lsp api generator (+https://github.com/)' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(json));
      return json;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  console.warn(`  ! ${address}: ${lastErr?.message ?? 'failed'}`);
  return null;
}

async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = [];
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      if (++done % 250 === 0) process.stdout.write(`  ${done}/${items.length}\r`);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ----------------------------------------------------------------- markup */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Turn wiki prose into markdown suitable for a hover popup.
function prose(raw) {
  if (!raw) return '';
  let s = raw.replace(/\r\n?/g, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<page[^>]*>(.*?)<\/page>/gis, (_, inner) => {
    const target = inner.trim();
    const label = target.includes('|') ? target.split('|')[1] : target;
    return `[\`${label}\`](${WIKI}/${encodeURI(target.split('|')[0])})`;
  });
  s = s.replace(/<note[^>]*>(.*?)<\/note>/gis, (_, i) => `\n\n> **Note:** ${i.trim()}\n`);
  s = s.replace(/<warning[^>]*>(.*?)<\/warning>/gis, (_, i) => `\n\n> **Warning:** ${i.trim()}\n`);
  s = s.replace(/<bug[^>]*>(.*?)<\/bug>/gis, (_, i) => `\n\n> **Bug:** ${i.trim()}\n`);
  s = s.replace(/<deprecated[^>]*>(.*?)<\/deprecated>/gis, (_, i) => `\n\n> **Deprecated:** ${i.trim()}\n`);
  s = s.replace(/<validate[^>]*>(.*?)<\/validate>/gis, '$1');
  s = s.replace(/<internal[^>]*>(.*?)<\/internal>/gis, (_, i) => `\n\n> **Internal:** ${i.trim()}\n`);
  s = s.replace(/<key>(.*?)<\/key>/gis, '<kbd>$1</kbd>');
  s = s.replace(/<removed[^>]*>(.*?)<\/removed>/gis, (_, i) => `\n\n> **Removed:** ${i.trim()}\n`);
  s = s.replace(/<(rendercontext|file|upload|image|video|youtube)[^>]*>.*?<\/\1>/gis, '');
  s = s.replace(/<\/?(?:cat|added|source)[^>]*>/gi, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function section(markup, name) {
  const m = markup.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

/** Every occurrence of a section, with its opening-tag attributes. */
function allSections(markup, name) {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, 'gi');
  return [...markup.matchAll(re)].map((m) => ({ attrs: attrs(m[1]), body: m[2] }));
}

function parseRealm(markup) {
  const raw = (section(markup, 'realm') ?? '').trim().toLowerCase();
  if (raw.includes('shared')) return 'shared';
  const client = raw.includes('client') || raw.includes('menu');
  const server = raw.includes('server');
  if (client && server) return 'shared';
  if (client) return 'client';
  if (server) return 'server';
  return 'shared';
}

function makeParam(attrsRaw, content) {
  const a = attrs(attrsRaw);
  if (!a.name && !a.type) return null;
  const p = { name: a.name || '', type: a.type || 'any' };

  // A function-typed argument documents its own parameters in a nested
  // <callback> block. Pull those out before they pollute the description.
  const callbackBody = /<callback\b[^>]*>([\s\S]*?)<\/callback>/i.exec(content);
  let body = content;
  if (callbackBody) {
    body = content.replace(/<callback\b[^>]*>[\s\S]*?<\/callback>/gi, '');
    const params = parseNested(callbackBody[1], 'arg');
    if (params.length) p.callback = params;
    const returns = parseNested(callbackBody[1], 'ret');
    if (returns.length) p.callbackReturns = returns;
  }

  const desc = prose(body);
  if (desc) p.description = desc;
  if (a.default !== undefined) p.default = a.default;
  if (/\bnil\b/.test(a.type ?? '') || a.default !== undefined) p.optional = true;
  return p;
}

/** Flat scan for a tag, used inside a <callback> where nesting cannot recur. */
function parseNested(body, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, 'gi');
  for (const m of body.matchAll(re)) {
    const a = attrs(m[1]);
    if (!a.name && !a.type) continue;
    const p = { name: a.name || '', type: a.type || 'any' };
    const desc = prose(m[2] ?? '');
    if (desc) p.description = desc;
    out.push(p);
  }
  return out;
}

/**
 * <args> / <rets> bodies.
 *
 * Depth-aware, because a function-typed <arg> contains a <callback> holding
 * more <arg> tags. A naive non-greedy match stops at the inner `</arg>` and
 * then reports the callback's own parameters as parameters of the function
 * itself — which is how `concommand.Add` ends up looking like it takes eight.
 */
function parseParams(body, tagName) {
  if (!body) return [];
  const out = [];
  // Attribute values can contain `>` (e.g. type="table<number>"), so match
  // quoted runs rather than "anything up to the next >".
  const open = new RegExp(`<${tagName}\\b((?:[^>"]|"[^"]*")*?)(/>|>)`, 'gi');
  let m;

  while ((m = open.exec(body)) !== null) {
    if (m[2] === '/>') {
      const param = makeParam(m[1], '');
      if (param) out.push(param);
      continue;
    }

    const contentStart = open.lastIndex;
    const tags = new RegExp(`<(/?)${tagName}\\b[^>]*?(/?)>`, 'gi');
    tags.lastIndex = contentStart;

    let depth = 1;
    let contentEnd = body.length;
    let resumeAt = body.length;
    let t;
    while ((t = tags.exec(body)) !== null) {
      if (t[2] === '/') continue; // self-closing changes nothing
      if (t[1] === '/') {
        depth--;
        if (depth === 0) {
          contentEnd = t.index;
          resumeAt = tags.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }

    const param = makeParam(m[1], body.slice(contentStart, contentEnd));
    if (param) out.push(param);
    open.lastIndex = resumeAt;
  }

  return out;
}

/**
 * Overloads are documented as several <args> blocks inside one <function>, the
 * extra ones carrying a name like "Use color object". Keeping only the first
 * makes every call using another form look like it has the wrong argument
 * count — `surface.SetDrawColor(color)` for example.
 */
function parseFunctionPage(page) {
  const markup = page.markup ?? '';
  const block = /<function\b([^>]*)>([\s\S]*?)<\/function>/i.exec(markup);
  if (!block) return null;

  const a = attrs(block[1]);
  const name = a.name;
  if (!name) return null;

  const body = block[2];
  const argBlocks = allSections(body, 'args');
  const retBlocks = allSections(body, 'rets');

  const forms = (argBlocks.length ? argBlocks : [{ attrs: {}, body: '' }]).map((argBlock, i) => ({
    label: argBlock.attrs.name,
    params: parseParams(argBlock.body, 'arg'),
    returns: parseParams((retBlocks[i] ?? retBlocks[0])?.body ?? '', 'ret'),
  }));

  const entry = {
    name,
    parent: a.parent ?? '',
    kind: a.type ?? 'func',
    realm: parseRealm(body),
    address: page.address,
    params: forms[0].params,
    returns: forms[0].returns,
  };

  const desc = prose(section(body, 'description') ?? '');
  if (desc) entry.description = desc;
  if (/<deprecated/i.test(body)) {
    entry.deprecated = prose(section(body, 'deprecated') ?? '') || true;
  }
  if (/<internal/i.test(body)) entry.internal = true;
  if (/<removed/i.test(body)) entry.removed = true;

  if (forms.length > 1) {
    entry.overloads = forms.slice(1).map((form) => {
      const overload = { params: form.params, returns: form.returns };
      if (form.label) overload.description = form.label;
      return overload;
    });
  }

  const example = markup.match(/<example>[\s\S]*?<code>([\s\S]*?)<\/code>/i);
  if (example) entry.example = decodeEntities(example[1]).trim();

  return entry;
}

function parseEnumPage(page) {
  const markup = page.markup ?? '';
  const body = section(markup, 'enum');
  if (!body) return null;
  const items = [];
  const re = /<item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/item>)/gi;
  for (const m of body.matchAll(re)) {
    const a = attrs(m[1]);
    if (!a.key) continue;
    const item = { key: a.key, value: a.value ?? '' };
    const desc = prose(m[2] ?? '');
    if (desc) item.description = desc;
    items.push(item);
  }
  if (!items.length) return null;
  return {
    name: page.address.replace(/^Enums\//, ''),
    address: page.address,
    realm: parseRealm(body),
    description: prose(section(body, 'description') ?? ''),
    items,
  };
}

function parseStructPage(page) {
  const markup = page.markup ?? '';
  const body = section(markup, 'structure');
  if (!body) return null;
  // Struct fields are <item name= type=>, not <field>, unlike function args.
  const fieldsBody = section(body, 'fields') ?? body;
  const fields = [...parseParams(fieldsBody, 'item'), ...parseParams(fieldsBody, 'field')];
  if (!fields.length) return null;
  return {
    name: page.address.replace(/^Structures\//, ''),
    address: page.address,
    realm: parseRealm(body),
    description: prose(section(body, 'description') ?? ''),
    fields,
  };
}

/* ------------------------------------------------------------------- main */

const HOOK_PARENTS = new Set(['GM', 'GAMEMODE', 'ENTITY', 'SWEP', 'WEAPON', 'PANEL', 'EFFECT', 'TOOL']);

function isApiAddress(address) {
  if (!address) return false;
  if (address.startsWith('Enums/') || address.startsWith('Structures/')) return true;
  if (address.includes('/')) return false; // guides, categories, dev pages
  return /^[A-Za-z_][\w]*[.:][A-Za-z_][\w]*$/.test(address);
}

async function main() {
  console.log('Fetching page list...');
  const listRes = await fetch(`${WIKI}/~pagelist?format=json`);
  if (!listRes.ok) throw new Error(`page list: HTTP ${listRes.status}`);
  const list = await listRes.json();

  const addresses = list
    .map((p) => p.address)
    .filter(isApiAddress)
    .sort();

  const targets = addresses.slice(0, LIMIT === Infinity ? addresses.length : LIMIT);
  console.log(`${targets.length} API pages to read (of ${list.length} total wiki pages).`);

  const pages = await pool(targets, fetchJson);
  console.log(`\nFetched. Parsing...`);

  const api = {
    generatedAt: new Date().toISOString(),
    source: WIKI,
    globals: {},   // Global.Foo         -> function
    libraries: {}, // net.Start          -> lib -> function
    classes: {},   // Entity:SetHealth   -> class -> method
    hooks: {},     // GM:PlayerSpawn     -> parent -> hook
    panels: {},    // DFrame:SetTitle    -> panel -> method
    enums: {},
    structs: {},
  };

  let skipped = 0;
  for (const page of pages) {
    if (!page || !page.markup) {
      skipped++;
      continue;
    }
    const address = page.address ?? '';

    if (address.startsWith('Enums/')) {
      const e = parseEnumPage(page);
      if (e) api.enums[e.name] = e;
      else skipped++;
      continue;
    }
    if (address.startsWith('Structures/')) {
      const s = parseStructPage(page);
      if (s) api.structs[s.name] = s;
      else skipped++;
      continue;
    }

    const fn = parseFunctionPage(page);
    if (!fn) {
      skipped++;
      continue;
    }

    const { parent, kind, name } = fn;
    const bucket = (obj, key) => (obj[key] ??= {});

    if (parent === 'Global' || kind === 'func') {
      api.globals[name] = fn;
    } else if (kind === 'hook' || HOOK_PARENTS.has(parent)) {
      bucket(api.hooks, parent === 'GAMEMODE' ? 'GM' : parent)[name] = fn;
    } else if (kind === 'panelfunc') {
      bucket(api.panels, parent)[name] = fn;
    } else if (kind === 'classfunc' || address.includes(':')) {
      bucket(api.classes, parent)[name] = fn;
    } else {
      bucket(api.libraries, parent)[name] = fn;
    }
  }

  // Panel methods are inherited by every VGUI element; the wiki documents them
  // once on Panel. Keep them addressable under classes too.
  if (api.panels.Panel && !api.classes.Panel) api.classes.Panel = api.panels.Panel;

  const count = (o) => Object.values(o).reduce((n, v) => n + Object.keys(v).length, 0);
  console.log(
    [
      `  globals   ${Object.keys(api.globals).length}`,
      `  libraries ${Object.keys(api.libraries).length} (${count(api.libraries)} functions)`,
      `  classes   ${Object.keys(api.classes).length} (${count(api.classes)} methods)`,
      `  hooks     ${Object.keys(api.hooks).length} (${count(api.hooks)} hooks)`,
      `  panels    ${Object.keys(api.panels).length} (${count(api.panels)} methods)`,
      `  enums     ${Object.keys(api.enums).length}`,
      `  structs   ${Object.keys(api.structs).length}`,
      `  skipped   ${skipped}`,
    ].join('\n'),
  );

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(api));
  const { size } = await fs.stat(OUT_FILE);
  console.log(`\nWrote ${OUT_FILE} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
