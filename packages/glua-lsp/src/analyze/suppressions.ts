import type { Comment } from '../parser/lexer.js';
import { RULES } from '../rules.js';
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
  directive: number;
}

/** One suppression comment, so an unused one can be pointed at. */
export interface Directive {
  span: { start: number; end: number };
  /** The rules it names, or `*` when it names none. */
  rules: string[];
  kind: string;
}

interface Targeted {
  rules: Set<string>;
  directive: number;
}

export class Suppressions {
  private readonly fileWide: Targeted[] = [];
  private readonly byLine = new Map<number, Targeted[]>();
  private readonly regions: Region[] = [];

  /** Every directive in the file, and which of them suppressed something. */
  private readonly directives: Directive[] = [];
  private readonly used = new Set<number>();

  /** True when nothing in the file suppresses anything, so checks can be skipped. */
  readonly empty: boolean;

  constructor(comments: Comment[], lines: LineIndex, text: string) {
    const open = new Map<string, { line: number; directive: number }>();

    for (const comment of comments) {
      const match = DIRECTIVE.exec(comment.text);
      if (!match) continue;

      const kind = match[1]!;
      const rules = parseRules(match[2] ?? '');
      const line = lines.lineOf(comment.start);
      const directive = this.directives.length;
      this.directives.push({
        span: { start: comment.start, end: comment.end },
        rules: [...rules],
        kind,
      });
      // A directive after code on the same line applies to that line; on its own
      // line it applies to the next one.
      const before = text.slice(lines.lineStart(line), comment.start);
      const trailing = before.trim() !== '';

      switch (kind) {
        case 'disable-file':
          this.fileWide.push({ rules, directive });
          break;

        case 'ignore':
          this.addLine(trailing ? line : line + 1, rules, directive);
          break;

        case 'disable-line':
          this.addLine(line, rules, directive);
          break;

        case 'disable':
          for (const rule of rules) {
            if (!open.has(rule)) open.set(rule, { line, directive });
          }
          break;

        case 'enable':
          for (const rule of rules) {
            const from = open.get(rule);
            if (from === undefined) continue;
            this.regions.push({
              fromLine: from.line,
              toLine: line,
              rules: new Set([rule]),
              directive: from.directive,
            });
            open.delete(rule);
          }
          break;

        default:
          break;
      }
    }

    // A `disable` with no matching `enable` runs to the end of the file.
    for (const [rule, from] of open) {
      this.regions.push({
        fromLine: from.line,
        toLine: lines.lineCount,
        rules: new Set([rule]),
        directive: from.directive,
      });
    }

    this.empty =
      this.fileWide.length === 0 && this.byLine.size === 0 && this.regions.length === 0;
  }

  private addLine(line: number, rules: Set<string>, directive: number): void {
    const existing = this.byLine.get(line);
    if (existing) existing.push({ rules, directive });
    else this.byLine.set(line, [{ rules, directive }]);
  }

  isSuppressed(code: string, line: number): boolean {
    if (this.empty) return false;

    // Every directive that covers this finding is marked, not just the first.
    // Two of them silencing the same thing means both are doing something, and
    // reporting the second as dead would be wrong.
    let suppressed = false;
    const mark = (target: Targeted | Region): void => {
      if (!target.rules.has(ALL) && !target.rules.has(code)) return;
      this.used.add(target.directive);
      suppressed = true;
    };

    for (const target of this.fileWide) mark(target);
    for (const target of this.byLine.get(line) ?? []) mark(target);
    for (const region of this.regions) {
      if (line < region.fromLine || line > region.toLine) continue;
      mark(region);
    }

    return suppressed;
  }

  /**
   * Directives that never silenced anything, once every rule has run.
   *
   * Only meaningful after a full pass: asking earlier reports directives whose
   * finding simply had not been reached yet.
   */
  unused(): Directive[] {
    return this.directives.filter((_, index) => !this.used.has(index));
  }
}

/**
 * The rules a directive names, or `*` when it names none.
 *
 * Three things have to be told apart, and the difference matters because the
 * fallback is "suppress everything":
 *
 *   -- glua-ignore                      no rules: silence this line entirely
 *   -- glua-ignore unused-local ok now  a rule, then prose about why
 *   -- glua-ignore unusedLocal          meant to be a rule, and is not one
 *
 * The third used to fall through to the first, so a settings key written where
 * a code belonged silenced every rule on the line while looking specific. Now
 * it names a rule nothing reports, which silences nothing and is reported by
 * `unused-suppression`.
 */
function parseRules(rest: string): Set<string> {
  const cleaned = rest.trim().replace(/^[-:]\s*/, '');
  if (!cleaned) return new Set([ALL]);

  const words = cleaned.split(/[\s,]+/).filter(Boolean);
  const rules: string[] = [];
  for (const word of words) {
    if (!KNOWN.has(word)) break;
    rules.push(word);
  }
  if (rules.length) return new Set(rules);

  // Nothing known. A hyphen or an inner capital says someone was aiming at a
  // rule name and missed; a plain word is prose, and prose is not a rule.
  const first = words[0];
  if (first && /^[A-Za-z][A-Za-z0-9-]*$/.test(first) && /[-A-Z]/.test(first.slice(1))) {
    return new Set([first]);
  }
  return new Set([ALL]);
}

const KNOWN = new Set(RULES.map((rule) => rule.code));
