import type { Comment } from '../parser/lexer.js';
import type { LineIndex } from '../util/lines.js';

/**
 * Inline rule suppressions.
 *
 * Any linter that reports on real code needs an escape hatch, otherwise the
 * only way to silence one wrong finding is to turn the whole rule off:
 *
 *   -- glua-ignore                     suppress every rule on the next line
 *   -- glua-ignore realm-violation     suppress one rule on the next line
 *   foo()  -- glua-ignore unused-local suppress on this line
 *   -- glua-disable net-unregistered   suppress from here on
 *   -- glua-enable net-unregistered    stop suppressing
 *   -- glua-disable-file               suppress for the whole file
 */
const DIRECTIVE = /\bglua-(ignore|disable-line|disable-file|disable|enable)\b[ \t]*([^\r\n]*)/;

const ALL = '*';

interface Region {
  fromLine: number;
  toLine: number;
  rules: Set<string>;
}

export class Suppressions {
  private readonly fileWide = new Set<string>();
  private readonly byLine = new Map<number, Set<string>>();
  private readonly regions: Region[] = [];

  /** True when nothing in the file suppresses anything, so checks can be skipped. */
  readonly empty: boolean;

  constructor(comments: Comment[], lines: LineIndex, text: string) {
    const open = new Map<string, number>();

    for (const comment of comments) {
      const match = DIRECTIVE.exec(comment.text);
      if (!match) continue;

      const kind = match[1]!;
      const rules = parseRules(match[2] ?? '');
      const line = lines.lineOf(comment.start);
      // A directive after code on the same line applies to that line; on its own
      // line it applies to the next one.
      const before = text.slice(lines.lineStart(line), comment.start);
      const trailing = before.trim() !== '';

      switch (kind) {
        case 'disable-file':
          for (const rule of rules) this.fileWide.add(rule);
          break;

        case 'ignore':
          this.addLine(trailing ? line : line + 1, rules);
          break;

        case 'disable-line':
          this.addLine(line, rules);
          break;

        case 'disable':
          for (const rule of rules) {
            if (!open.has(rule)) open.set(rule, line);
          }
          break;

        case 'enable':
          for (const rule of rules) {
            const from = open.get(rule);
            if (from === undefined) continue;
            this.regions.push({ fromLine: from, toLine: line, rules: new Set([rule]) });
            open.delete(rule);
          }
          break;

        default:
          break;
      }
    }

    // A `disable` with no matching `enable` runs to the end of the file.
    for (const [rule, from] of open) {
      this.regions.push({ fromLine: from, toLine: lines.lineCount, rules: new Set([rule]) });
    }

    this.empty =
      this.fileWide.size === 0 && this.byLine.size === 0 && this.regions.length === 0;
  }

  private addLine(line: number, rules: Set<string>): void {
    const existing = this.byLine.get(line);
    if (existing) {
      for (const rule of rules) existing.add(rule);
    } else {
      this.byLine.set(line, new Set(rules));
    }
  }

  isSuppressed(code: string, line: number): boolean {
    if (this.empty) return false;
    if (this.fileWide.has(ALL) || this.fileWide.has(code)) return true;

    const onLine = this.byLine.get(line);
    if (onLine && (onLine.has(ALL) || onLine.has(code))) return true;

    for (const region of this.regions) {
      if (line < region.fromLine || line > region.toLine) continue;
      if (region.rules.has(ALL) || region.rules.has(code)) return true;
    }

    return false;
  }
}

function parseRules(rest: string): Set<string> {
  const cleaned = rest.trim().replace(/^[-:]\s*/, '');
  if (!cleaned) return new Set([ALL]);
  const rules = cleaned
    .split(/[\s,]+/)
    // Stop at prose: `-- glua-ignore unused-local because it is a stub`
    .filter((word) => /^[a-z][a-z0-9-]*$/.test(word) && word.includes('-'));
  return rules.length ? new Set(rules) : new Set([ALL]);
}
