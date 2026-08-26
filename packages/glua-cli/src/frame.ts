// The offending line, with the offending part underlined.
//
// A line and column number is a lookup instruction: open the file, navigate,
// find out what the tool was talking about. In a CI log there is no file to
// open, and the number alone tells you nothing. Every tool that people describe
// as pleasant to use — rustc, ruff, TypeScript — prints the source instead.
//
// Deliberately small: one line of context either side, one underline, no
// multi-line spans stitched together with box drawing. The point is to answer
// "which bit?" without turning a hundred findings into a wall of text.

import fs from 'node:fs';
import { c, symbols } from './palette.js';

/** Reads each file once, however many findings land in it. */
export class SourceCache {
  private readonly lines = new Map<string, string[] | null>();

  /** Content the caller already has, for a file that is not on disk as given. */
  seed(file: string, text: string): void {
    this.lines.set(file, text.split(/\r?\n/));
  }

  linesOf(file: string): string[] | null {
    let cached = this.lines.get(file);
    if (cached === undefined) {
      try {
        cached = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      } catch {
        // Deleted or unreadable since the run started. A missing frame is a
        // cosmetic loss; the finding above it still says where to look.
        cached = null;
      }
      this.lines.set(file, cached);
    }
    return cached;
  }
}

export interface FrameRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** How much context to show either side. */
const CONTEXT = 1;

/**
 * A span wider than this is almost certainly a whole statement or block, and
 * underlining eighty characters says less than underlining nothing.
 */
const MAX_UNDERLINE = 60;

/**
 * The frame for one finding, or an empty array when there is nothing to show.
 *
 * Indented to sit under the finding it belongs to, so a file with several
 * findings still reads as a list rather than as separate reports.
 */
export function codeFrame(
  source: string[],
  range: FrameRange,
  paint: (text: string) => string,
): string[] {
  const line = range.start.line;
  if (line < 0 || line >= source.length) return [];

  const from = Math.max(0, line - CONTEXT);
  const to = Math.min(source.length - 1, line + CONTEXT);
  // A trailing newline gives a final empty line nobody wants to see.
  const last = to === source.length - 1 && source[to] === '' ? to - 1 : to;

  const gutter = String(last + 1).length;
  const out: string[] = [];

  for (let n = from; n <= last; n++) {
    const text = source[n] ?? '';
    const number = String(n + 1).padStart(gutter, ' ');
    const bar = c.faint('│');

    if (n !== line) {
      if (text.trim() === '' && n !== line) continue;
      out.push(`     ${c.faint(number)} ${bar} ${c.faint(expand(text))}`);
      continue;
    }

    out.push(`     ${c.faint(number)} ${bar} ${c.text(expand(text))}`);
    out.push(`     ${' '.repeat(gutter)} ${bar} ${paint(underline(text, range))}`);
  }

  return out;
}

/**
 * Tabs are one character to a range but eight columns to a terminal, so an
 * underline computed against the raw text lands in the wrong place. Expanding
 * them to a fixed width keeps the two in step; four matches the indentation
 * this project's own formatter writes.
 */
const TAB = '    ';

function expand(text: string): string {
  return text.replace(/\t/g, TAB);
}

/** Spaces up to the span, then a rule under it. */
function underline(text: string, range: FrameRange): string {
  const width = (upto: number) => expand(text.slice(0, upto)).length;

  const start = width(range.start.character);
  const singleLine = range.end.line === range.start.line;
  const end = singleLine ? width(range.end.character) : expand(text).length;

  const length = Math.min(Math.max(1, end - start), MAX_UNDERLINE);
  return `${' '.repeat(start)}${symbols.line.repeat(length)}`;
}
