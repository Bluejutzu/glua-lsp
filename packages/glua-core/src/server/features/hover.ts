import type { Hover, Position } from 'vscode-languageserver';
import type { GmodApi } from '../../api/index.js';
import type { FileAnalysis } from '../../analyze/binder.js';
import { realmAt } from '../../analyze/realm.js';
import { typeToString } from '../../analyze/types.js';
import type { Workspace } from '../../analyze/workspace.js';
import { resolveAt } from '../resolve.js';
import { markdown, realmLabel, renderApiFunction, renderEnum, renderStruct, wikiUrl } from '../render.js';
import type { Settings } from '../settings.js';

export interface HoverDeps {
  api: GmodApi;
  workspace: Workspace;
  settings: Settings;
}

export function hover(analysis: FileAnalysis, position: Position, deps: HoverDeps): Hover | null {
  const { api, workspace, settings } = deps;
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return null;

  const range = analysis.lines.rangeAt(resolution.nameSpan.start, resolution.nameSpan.end);
  const renderOptions = { wikiLinks: settings.hover.wikiLinks, detailed: true };

  switch (resolution.kind) {
    case 'api': {
      const contents = renderApiFunction(resolution.fn, renderOptions);
      const fileRealm = realmAt(analysis.realm, offset);
      if (!apiUsableHere(resolution.fn.realm, fileRealm)) {
        contents.value =
          `> ⚠ This is **${realmLabel(resolution.fn.realm)}**-only, but this code runs ` +
          `**${realmLabel(fileRealm)}**-side. It will be nil here.\n\n` +
          contents.value;
      }
      return { contents, range };
    }

    case 'local': {
      const { symbol } = resolution;
      const lines = [
        '```glua',
        `${symbol.kind === 'self' ? 'self' : `local ${symbol.name}`}: ${typeToString(symbol.type)}`,
        '```',
      ];
      if (symbol.doc) lines.push('', symbol.doc);
      const reads = symbol.refs.filter((r) => !r.write).length;
      const writes = symbol.refs.filter((r) => r.write).length;
      lines.push('', `*${reads} read${reads === 1 ? '' : 's'}, ${writes} write${writes === 1 ? '' : 's'} in this file*`);
      return { contents: markdown(lines.join('\n')), range };
    }

    case 'library': {
      const members = Object.keys(api.getLibrary(resolution.name) ?? {});
      return {
        contents: markdown(
          [
            '```glua',
            `${resolution.name} -- library`,
            '```',
            `${members.length} documented functions.`,
            '',
            `[Wiki: ${resolution.name}](${wikiUrl(resolution.name)})`,
          ].join('\n'),
        ),
        range,
      };
    }

    case 'class': {
      const struct = api.getStruct(resolution.name);
      if (struct) return { contents: renderStruct(struct, renderOptions), range };
      const members = api.getClassMembers(resolution.name);
      const parent = api.parentOf(resolution.name);
      return {
        contents: markdown(
          [
            '```glua',
            `${resolution.name}${parent ? ` : ${parent}` : ''} -- class`,
            '```',
            `${members.size} methods (including inherited).`,
            '',
            `[Wiki: ${resolution.name}](${wikiUrl(resolution.name)})`,
          ].join('\n'),
        ),
        range,
      };
    }

    case 'scriptedClass': {
      const entry = workspace.scriptedClass(resolution.name);
      if (!entry) return null;
      const methods = workspace.classMembers(entry.name).length;
      const accessors = workspace.accessorsForClass(entry.name).length;
      const parts = [`${methods} method${methods === 1 ? '' : 's'}`];
      if (accessors) parts.push(`${accessors} networked value${accessors === 1 ? '' : 's'}`);
      return {
        contents: markdown(
          [
            '```glua',
            `${entry.name} -- scripted ${entry.kind} : ${entry.base}`,
            '```',
            `${parts.join(', ')} across ${entry.uris.length} file${entry.uris.length === 1 ? '' : 's'}.`,
          ].join('\n'),
        ),
        range,
      };
    }

    case 'hookTable': {
      const hooks = api.getHooksFor(resolution.hookParent);
      const count = Object.keys(hooks).length;
      const kindLabel =
        resolution.name === 'GM' || resolution.name === 'GAMEMODE'
          ? 'gamemode'
          : resolution.name === 'SWEP'
            ? 'weapon'
            : resolution.name === 'PANEL'
              ? 'panel'
              : resolution.name === 'TOOL'
                ? 'toolgun'
                : resolution.name === 'EFFECT'
                  ? 'effect'
                  : 'entity';
      return {
        contents: markdown(
          [
            '```glua',
            `${resolution.name} -- ${kindLabel} definition table`,
            '```',
            `Garry's Mod creates this table for you before running the file, so it is ` +
              `never declared anywhere.`,
            '',
            `Define a method on it with \`function ${resolution.name}:Name()\` — ` +
              `${count} documented ${resolution.hookParent} hooks are available, and ` +
              `\`self\` inside them is ${resolution.selfClass === 'table' ? 'the table itself' : `a \`${resolution.selfClass}\``}.`,
            '',
            `[Wiki: ${resolution.hookParent} hooks](${wikiUrl(`${resolution.hookParent}_Hooks`)})`,
          ].join('\n'),
        ),
        range,
      };
    }

    case 'enum':
      return {
        contents: renderEnum(
          api.data.enums[resolution.lookup.enumName]!,
          resolution.key,
          resolution.lookup.item.value,
          renderOptions,
        ),
        range,
      };

    case 'hookName': {
      const documented = api.getGlobalHook(resolution.name);
      if (documented) return { contents: renderApiFunction(documented, renderOptions), range };
      const sites = workspace.customHookNames().get(resolution.name) ?? [];
      return {
        contents: markdown(
          [
            `**${resolution.name}** — custom hook`,
            '',
            sites.length
              ? `Fired from ${sites.length} place${sites.length === 1 ? '' : 's'} in this workspace.`
              : '⚠ Not a documented hook, and nothing in this workspace calls `hook.Run` with this name. Check for a typo.',
          ].join('\n'),
        ),
        range,
      };
    }

    case 'netMessage': {
      const registered = workspace.netRegistered().get(resolution.name) ?? [];
      const starts = workspace.netStarts().get(resolution.name) ?? [];
      const receives = workspace.netReceives().get(resolution.name) ?? [];
      const lines = [`**${resolution.name}** — net message`, ''];
      lines.push(
        registered.length
          ? `- Registered by \`util.AddNetworkString\` in ${registered.length} place${registered.length === 1 ? '' : 's'}`
          : '- ⚠ Never passed to `util.AddNetworkString` — `net.Start` will fail',
      );
      lines.push(`- Sent from ${starts.length} place${starts.length === 1 ? '' : 's'}`);
      lines.push(`- Received in ${receives.length} place${receives.length === 1 ? '' : 's'}`);

      const payload = describePayload(workspace, resolution.name);
      if (payload) lines.push('', payload);
      return { contents: markdown(lines.join('\n')), range };
    }

    case 'includePath': {
      const target = workspace.resolveReference(analysis.fsPath, resolution.path);
      return {
        contents: markdown(
          target
            ? [
                `\`${resolution.path}\``,
                '',
                `Resolves to \`${target.fsPath}\``,
                `Realm: **${realmLabel(target.realm.file)}** (${target.realm.reason})`,
              ].join('\n')
            : `\`${resolution.path}\`\n\n⚠ No matching file found in the indexed workspace.`,
        ),
        range,
      };
    }

    case 'panelClass': {
      const members = api.getClassMembers(resolution.name);
      return {
        contents: markdown(
          [`**${resolution.name}** — VGUI panel`, '', `${members.size} methods (including inherited).`, '', `[Wiki: ${resolution.name}](${wikiUrl(resolution.name)})`].join('\n'),
        ),
        range,
      };
    }

    case 'global': {
      const defs = workspace.definitionsOf(resolution.path);
      const lines = ['```glua', `${resolution.path}: ${typeToString(resolution.type)}`, '```'];
      const doc = defs.find((d) => d.value.doc)?.value.doc;
      if (doc) lines.push('', doc);
      if (defs.length) {
        lines.push('', `*Defined in ${defs.length} place${defs.length === 1 ? '' : 's'} in this workspace.*`);
      } else {
        lines.push('', '⚠ *Global with no definition found in the workspace or the GMod API.*');
      }
      return { contents: markdown(lines.join('\n')), range };
    }

    default:
      return null;
  }
}

function apiUsableHere(memberRealm: string, fileRealm: string): boolean {
  if (memberRealm === 'shared' || fileRealm === 'shared') return true;
  return memberRealm === fileRealm;
}

/** Summarises the write sequence for a net message, so you can eyeball pairing. */
function describePayload(workspace: Workspace, name: string): string | null {
  for (const uri of workspace.uris()) {
    const file = workspace.get(uri);
    const start = file?.netStarts.find((s) => s.name === name && s.writes.length);
    if (start) {
      return `**Payload:** ${start.writes.map((w) => w.payload).join(' → ')}`;
    }
  }
  return null;
}
