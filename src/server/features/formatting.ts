import type { Range, TextEdit } from 'vscode-languageserver';
import { parse } from '../../parser/parser.js';
import { formatDocument } from '../../format/printer.js';
import type { FormatOptions } from '../../format/options.js';
import type { FileAnalysis } from '../../analyze/binder.js';

export function formatting(
  analysis: FileAnalysis,
  options: FormatOptions,
  enabled: boolean,
): TextEdit[] {
  if (!enabled) return [];
  // Never rewrite a file that does not parse.
  if (analysis.parseErrors.length) return [];

  const parsed = { chunk: analysis.chunk, comments: analysis.comments, errors: [], tokens: [] };
  const formatted = formatDocument(analysis.text, parsed, options);
  if (formatted === null || formatted === analysis.text) return [];

  return [{ range: analysis.lines.rangeAt(0, analysis.text.length), newText: formatted }];
}

/**
 * Range formatting.
 *
 * Formats whole top-level statements the range touches, because reflowing half
 * a statement is not meaningful, then restores their original indentation.
 */
export function rangeFormatting(
  analysis: FileAnalysis,
  range: Range,
  options: FormatOptions,
  enabled: boolean,
): TextEdit[] {
  if (!enabled) return [];
  if (analysis.parseErrors.length) return [];

  const from = analysis.lines.offsetAt(range.start);
  const to = analysis.lines.offsetAt(range.end);

  const touched = analysis.chunk.body.filter((s) => s.end > from && s.start < to);
  if (!touched.length) return [];

  const first = touched[0]!;
  const last = touched[touched.length - 1]!;

  // Re-parse just this slice so offsets inside it line up.
  const slice = analysis.text.slice(first.start, last.end);
  const parsed = parse(slice);
  if (parsed.errors.length) return [];

  const formatted = formatDocument(slice, parsed, options);
  if (formatted === null) return [];

  const lineStart = analysis.lines.lineStart(analysis.lines.lineOf(first.start));
  const indent = analysis.text.slice(lineStart, first.start);
  const body = formatted.replace(/\r?\n$/, '');
  const reindented =
    /^[ \t]*$/.test(indent) && indent
      ? body
          .split(/\r?\n/)
          .map((line, i) => (i === 0 || !line ? line : indent + line))
          .join(options.endOfLine)
      : body;

  if (reindented === slice) return [];

  return [{ range: analysis.lines.rangeAt(first.start, last.end), newText: reindented }];
}
