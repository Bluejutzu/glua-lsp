import type { Position, Range } from 'vscode-languageserver';

/**
 * Offset <-> Position mapping. LSP positions are UTF-16 code units, which is
 * also how JavaScript indexes strings, so offsets are directly comparable.
 */
export class LineIndex {
  private readonly starts: number[];

  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))]!;
  }

  lineEnd(line: number): number {
    const next = this.starts[line + 1];
    if (next === undefined) return this.text.length;
    // Trim the newline (and a preceding CR).
    let end = next - 1;
    if (end > 0 && this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineEnd(line));
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    const line = this.lineOf(clamped);
    return { line, character: clamped - this.starts[line]! };
  }

  offsetAt(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.starts.length - 1));
    const start = this.starts[line]!;
    return Math.min(start + Math.max(0, position.character), this.lineEnd(line));
  }

  rangeAt(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}
