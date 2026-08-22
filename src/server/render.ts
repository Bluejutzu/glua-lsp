import { MarkupKind, type MarkupContent } from 'vscode-languageserver';
import type { ApiEnum, ApiFunction, ApiParam, ApiStruct, Realm } from '../api/types.js';
import { formatApiSignature } from '../analyze/types.js';

const WIKI = 'https://wiki.facepunch.com/gmod';

export const wikiUrl = (address: string): string => `${WIKI}/${encodeURI(address)}`;

export function realmLabel(realm: Realm): string {
  switch (realm) {
    case 'client':
      return 'Client';
    case 'server':
      return 'Server';
    case 'menu':
      return 'Menu';
    default:
      return 'Shared';
  }
}

/** Compact one-line signature used for completion `detail` and hover headers. */
export function signatureLine(fn: ApiFunction): string {
  const qualified =
    fn.kind === 'classfunc' || fn.kind === 'panelfunc' || fn.kind === 'hook'
      ? `${fn.parent}:${fn.name}`
      : fn.parent && fn.parent !== 'Global'
        ? `${fn.parent}.${fn.name}`
        : fn.name;

  const params = fn.params
    .map((p) => {
      const name = p.name || p.type;
      return p.optional || p.default !== undefined ? `${name}?` : name;
    })
    .join(', ');

  const rets = fn.returns.length ? ` -> ${fn.returns.map((r) => r.type).join(', ')}` : '';
  return `${qualified}(${params})${rets}`;
}

function paramTable(params: ApiParam[], heading: string): string {
  if (!params.length) return '';
  const rows = params
    .map((p) => {
      const name = p.name || '_';
      const optional = p.optional || p.default !== undefined ? ' *(optional)*' : '';
      const dflt = p.default !== undefined ? ` — defaults to \`${p.default}\`` : '';
      const desc = p.description ? ` — ${p.description.replace(/\n+/g, ' ')}` : '';
      return `- \`${name}\`: **${p.type}**${optional}${desc}${dflt}`;
    })
    .join('\n');
  return `\n\n**${heading}**\n${rows}`;
}

export interface RenderOptions {
  wikiLinks: boolean;
  /** Include the full parameter and return breakdown. */
  detailed: boolean;
}

export function renderApiFunction(
  fn: ApiFunction,
  options: RenderOptions = { wikiLinks: true, detailed: true },
): MarkupContent {
  const lines: string[] = [];

  lines.push('```glua', signatureLine(fn), '```');

  const badges: string[] = [`**${realmLabel(fn.realm)}**`];
  if (fn.deprecated) badges.push('**Deprecated**');
  if (fn.internal) badges.push('**Internal**');
  if (fn.removed) badges.push('**Removed**');
  lines.push(badges.join(' · '));

  if (typeof fn.deprecated === 'string' && fn.deprecated.trim()) {
    lines.push('', `> **Deprecated:** ${fn.deprecated}`);
  }

  if (fn.description) lines.push('', fn.description);

  if (options.detailed) {
    const params = paramTable(fn.params, 'Parameters');
    if (params) lines.push(params);
    const returns = paramTable(fn.returns, 'Returns');
    if (returns) lines.push(returns);
  }

  if (fn.example) {
    lines.push('', '**Example**', '```glua', fn.example, '```');
  }

  if (options.wikiLinks && fn.address) {
    lines.push('', `[Wiki: ${fn.address}](${wikiUrl(fn.address)})`);
  }

  return { kind: MarkupKind.Markdown, value: lines.join('\n') };
}

export function renderEnum(
  entry: ApiEnum,
  key: string,
  value: string,
  options: RenderOptions = { wikiLinks: true, detailed: true },
): MarkupContent {
  const item = entry.items.find((i) => i.key === key);
  const lines = ['```glua', `${key} = ${value}`, '```', `**${realmLabel(entry.realm)}** · enum \`${entry.name}\``];
  if (item?.description) lines.push('', item.description);
  if (options.wikiLinks && entry.address) {
    lines.push('', `[Wiki: ${entry.address}](${wikiUrl(entry.address)})`);
  }
  return { kind: MarkupKind.Markdown, value: lines.join('\n') };
}

export function renderStruct(
  struct: ApiStruct,
  options: RenderOptions = { wikiLinks: true, detailed: true },
): MarkupContent {
  const lines = [`**${struct.name}** structure · **${realmLabel(struct.realm)}**`];
  if (struct.description) lines.push('', struct.description);
  if (options.detailed) {
    const fields = paramTable(struct.fields, 'Fields');
    if (fields) lines.push(fields);
  }
  if (options.wikiLinks && struct.address) {
    lines.push('', `[Wiki: ${struct.address}](${wikiUrl(struct.address)})`);
  }
  return { kind: MarkupKind.Markdown, value: lines.join('\n') };
}

export function markdown(value: string): MarkupContent {
  return { kind: MarkupKind.Markdown, value };
}

export { formatApiSignature };
