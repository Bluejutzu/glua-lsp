import {
  DocumentHighlightKind,
  type DocumentHighlight,
  type Location,
  type Position,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import type { GmodApi } from '../../api/index.js';
import type { FileAnalysis, Span } from '../../analyze/binder.js';
import type { Workspace } from '../../analyze/workspace.js';
import { resolveAt, type Resolution } from '../resolve.js';
import { wikiUrl } from '../render.js';

/** Strips the surrounding quotes from a string-literal span. */
function innerString(file: FileAnalysis, span: Span): Span {
  const first = file.text[span.start];
  if (first === '"' || first === "'") {
    return { start: span.start + 1, end: Math.max(span.start + 1, span.end - 1) };
  }
  return span;
}

const locationOf = (file: FileAnalysis, span: Span): Location => ({
  uri: file.uri,
  range: file.lines.rangeAt(span.start, span.end),
});

export function definition(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
  workspace: Workspace,
): Location[] {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return [];

  switch (resolution.kind) {
    case 'local':
      return [locationOf(analysis, { start: resolution.symbol.declStart, end: resolution.symbol.declEnd })];

    case 'global':
      return workspace.definitionsOf(resolution.path).flatMap(({ uri, value }) => {
        const file = workspace.get(uri);
        return file ? [locationOf(file, value.nameSpan)] : [];
      });

    case 'includePath': {
      const target = workspace.resolveReference(analysis.fsPath, resolution.path);
      if (!target) return [];
      return [{ uri: target.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    }

    case 'netMessage': {
      const out: Location[] = [];
      for (const uri of workspace.uris()) {
        const file = workspace.get(uri);
        if (!file) continue;
        for (const reg of file.netRegisters) {
          if (reg.name === resolution.name) out.push(locationOf(file, innerString(file, reg.nameSpan)));
        }
        for (const receive of file.netReceives) {
          if (receive.name === resolution.name) out.push(locationOf(file, innerString(file, receive.nameSpan)));
        }
      }
      return out;
    }

    case 'scriptedClass': {
      const entry = workspace.scriptedClass(resolution.name);
      if (!entry) return [];
      return [{
        uri: entry.primaryUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }];
    }

    case 'hookName': {
      const out: Location[] = [];
      for (const uri of workspace.uris()) {
        const file = workspace.get(uri);
        if (!file) continue;
        for (const add of file.hookAdds) {
          if (add.hookName === resolution.name) out.push(locationOf(file, innerString(file, add.nameSpan)));
        }
        for (const run of file.hookRuns) {
          if (run.hookName === resolution.name) out.push(locationOf(file, innerString(file, run.nameSpan)));
        }
      }
      return out;
    }

    default:
      return [];
  }
}

/** Wiki URL for an API symbol, surfaced as a command rather than a Location. */
export function wikiLinkFor(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
): string | null {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return null;
  if (resolution.kind === 'api') return wikiUrl(resolution.fn.address);
  if (resolution.kind === 'class' || resolution.kind === 'library' || resolution.kind === 'panelClass') {
    return wikiUrl(resolution.name);
  }
  if (resolution.kind === 'enum') return wikiUrl(resolution.lookup.enumName);
  return null;
}

export function references(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
  workspace: Workspace,
  includeDeclaration: boolean,
): Location[] {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return [];

  const sites = referenceSites(resolution, analysis, workspace, includeDeclaration);
  return sites.map(({ file, span }) => locationOf(file, span));
}

export function documentHighlights(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
  workspace: Workspace,
): DocumentHighlight[] {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return [];

  const out: DocumentHighlight[] = [];

  if (resolution.kind === 'local') {
    const { symbol } = resolution;
    out.push({
      range: analysis.lines.rangeAt(symbol.declStart, symbol.declEnd),
      kind: DocumentHighlightKind.Write,
    });
    for (const ref of symbol.refs) {
      out.push({
        range: analysis.lines.rangeAt(ref.start, ref.end),
        kind: ref.write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
      });
    }
    return out;
  }

  for (const { file, span, write } of referenceSites(resolution, analysis, workspace, true)) {
    if (file.uri !== analysis.uri) continue;
    out.push({
      range: file.lines.rangeAt(span.start, span.end),
      kind: write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
    });
  }
  return out;
}

export function rename(
  analysis: FileAnalysis,
  position: Position,
  newName: string,
  api: GmodApi,
  workspace: Workspace,
): WorkspaceEdit | null {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return null;

  // Renaming a documented API member would only break the code.
  if (resolution.kind === 'api' || resolution.kind === 'enum' || resolution.kind === 'library' || resolution.kind === 'class') {
    return null;
  }

  const isIdentifierRename = resolution.kind === 'local' || resolution.kind === 'global';
  if (isIdentifierRename && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return null;

  const sites = referenceSites(resolution, analysis, workspace, true);
  if (!sites.length) return null;

  const changes: Record<string, TextEdit[]> = {};
  for (const { file, span } of sites) {
    const edits = (changes[file.uri] ??= []);
    const range: Range = file.lines.rangeAt(span.start, span.end);
    if (!edits.some((e) => e.range.start.line === range.start.line && e.range.start.character === range.start.character)) {
      edits.push({ range, newText: newName });
    }
  }

  return { changes };
}

/** Whether a rename is legal here, and the range the editor should pre-fill. */
export function prepareRename(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
): { range: Range; placeholder: string } | null {
  const offset = analysis.lines.offsetAt(position);
  const resolution = resolveAt(analysis, offset, api);
  if (!resolution) return null;

  switch (resolution.kind) {
    case 'local':
      return {
        range: analysis.lines.rangeAt(resolution.nameSpan.start, resolution.nameSpan.end),
        placeholder: resolution.symbol.name,
      };
    case 'global':
      return {
        range: analysis.lines.rangeAt(resolution.nameSpan.start, resolution.nameSpan.end),
        placeholder: analysis.text.slice(resolution.nameSpan.start, resolution.nameSpan.end),
      };
    case 'hookName':
      return {
        range: analysis.lines.rangeAt(resolution.nameSpan.start, resolution.nameSpan.end),
        placeholder: resolution.name,
      };
    case 'netMessage':
      return {
        range: analysis.lines.rangeAt(resolution.nameSpan.start, resolution.nameSpan.end),
        placeholder: resolution.name,
      };
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- sites */

interface Site {
  file: FileAnalysis;
  span: Span;
  write: boolean;
}

function referenceSites(
  resolution: Resolution,
  analysis: FileAnalysis,
  workspace: Workspace,
  includeDeclaration: boolean,
): Site[] {
  const out: Site[] = [];

  switch (resolution.kind) {
    case 'local': {
      const { symbol } = resolution;
      if (includeDeclaration) {
        out.push({ file: analysis, span: { start: symbol.declStart, end: symbol.declEnd }, write: true });
      }
      for (const ref of symbol.refs) {
        out.push({ file: analysis, span: { start: ref.start, end: ref.end }, write: ref.write });
      }
      break;
    }

    case 'global': {
      const target = resolution.path;
      // The last segment is what actually gets renamed for a dotted path.
      for (const uri of workspace.uris()) {
        const file = workspace.get(uri);
        if (!file) continue;
        if (includeDeclaration) {
          for (const def of file.globalDefs) {
            if (def.path === target) out.push({ file, span: def.nameSpan, write: true });
          }
        }
        for (const ref of file.globalRefs) {
          if (ref.path === target) out.push({ file, span: ref.span, write: ref.write });
        }
      }
      break;
    }

    case 'hookName': {
      for (const uri of workspace.uris()) {
        const file = workspace.get(uri);
        if (!file) continue;
        for (const add of file.hookAdds) {
          if (add.hookName === resolution.name) {
            out.push({ file, span: innerString(file, add.nameSpan), write: true });
          }
        }
        for (const run of file.hookRuns) {
          if (run.hookName === resolution.name) {
            out.push({ file, span: innerString(file, run.nameSpan), write: false });
          }
        }
      }
      break;
    }

    case 'netMessage': {
      for (const uri of workspace.uris()) {
        const file = workspace.get(uri);
        if (!file) continue;
        for (const reg of file.netRegisters) {
          if (reg.name === resolution.name) out.push({ file, span: innerString(file, reg.nameSpan), write: true });
        }
        for (const start of file.netStarts) {
          if (start.name === resolution.name) out.push({ file, span: innerString(file, start.nameSpan), write: false });
        }
        for (const receive of file.netReceives) {
          if (receive.name === resolution.name) out.push({ file, span: innerString(file, receive.nameSpan), write: false });
        }
      }
      break;
    }

    default:
      break;
  }

  return out;
}

export function uriToPath(uri: string): string {
  return URI.parse(uri).fsPath;
}
