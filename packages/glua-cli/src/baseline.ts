// Drawing a line under the findings a project already has.
//
// Pointing a linter at code you inherited is where most adoptions die: several
// hundred findings arrive at once, none of them are the change you were making,
// and the rule gets switched off. PHPStan, Psalm and ESLint all landed on the
// same answer independently — record what exists today, enforce the rules on
// everything written after it, and pay the backlog down when you choose to.
//
// Counts, not line numbers. A baseline keyed by position is invalidated by the
// first person who adds an import, and a baseline that is wrong after every
// commit is worse than none. Recording "this file has four unused locals"
// survives the file moving around and still notices when a fifth appears.

import fs from 'node:fs';
import path from 'node:path';

/** What the file on disk looks like. Sorted on write so diffs stay readable. */
export interface BaselineFile {
  $schema?: string;
  /** Written for humans reading a diff, never read back. */
  generated?: string;
  /** file path (relative, forward slashes) -> rule code -> how many were found. */
  files: Record<string, Record<string, number>>;
}

export const BASELINE_NAME = '.glua-baseline.json';

export interface BaselineEntry {
  file: string;
  rule: string;
}

/** A counted set of findings, which is all a baseline ever compares. */
export type Tally = Map<string, Map<string, number>>;

export function baselinePath(root: string): string {
  return path.join(root, BASELINE_NAME);
}

/** The baseline for a project, or null when it has none. */
export function readBaseline(root: string): BaselineFile | null {
  const file = baselinePath(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as BaselineFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
      throw new Error('missing a "files" object');
    }
    return parsed;
  } catch (error) {
    // A corrupt baseline must not silently suppress everything, and must not
    // silently suppress nothing either. Say so and stop.
    throw new Error(
      `${BASELINE_NAME} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeBaseline(root: string, tally: Tally): void {
  const files: BaselineFile['files'] = {};
  for (const file of [...tally.keys()].sort()) {
    const rules = tally.get(file)!;
    const sorted: Record<string, number> = {};
    for (const rule of [...rules.keys()].sort()) sorted[rule] = rules.get(rule)!;
    if (Object.keys(sorted).length) files[file] = sorted;
  }

  const contents: BaselineFile = {
    $schema: 'https://docs.bluejutzu.dev/glua/schemas/baseline.schema.json',
    generated: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(baselinePath(root), `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

export function countsOf(baseline: BaselineFile): Tally {
  const tally: Tally = new Map();
  for (const [file, rules] of Object.entries(baseline.files)) {
    const inner = new Map<string, number>();
    for (const [rule, count] of Object.entries(rules)) {
      if (typeof count === 'number' && count > 0) inner.set(rule, count);
    }
    if (inner.size) tally.set(file, inner);
  }
  return tally;
}

/**
 * Splits findings into the ones a baseline covers and the ones it does not.
 *
 * Within a file and rule the first `count` findings are suppressed and the rest
 * are reported. Which specific ones get suppressed is arbitrary — they are
 * indistinguishable to a counted baseline — but the number reported is right,
 * and that is the property the whole idea rests on.
 */
export function applyBaseline<T extends { file: string; rule: string }>(
  findings: T[],
  baseline: Tally,
): { reported: T[]; suppressed: T[] } {
  const remaining = new Map<string, Map<string, number>>();
  for (const [file, rules] of baseline) remaining.set(file, new Map(rules));

  const reported: T[] = [];
  const suppressed: T[] = [];

  for (const finding of findings) {
    const left = remaining.get(finding.file)?.get(finding.rule) ?? 0;
    if (left > 0) {
      remaining.get(finding.file)!.set(finding.rule, left - 1);
      suppressed.push(finding);
    } else {
      reported.push(finding);
    }
  }

  return { reported, suppressed };
}

/**
 * Entries claiming findings that no longer happen.
 *
 * Worth surfacing rather than quietly fixing: a baseline that has drifted below
 * what the code actually does is a promise nobody is keeping, and `--prune` is
 * the deliberate act of updating it.
 */
export function staleEntries(findings: { file: string; rule: string }[], baseline: Tally): BaselineEntry[] {
  const actual: Tally = new Map();
  for (const finding of findings) {
    const rules = actual.get(finding.file) ?? new Map<string, number>();
    rules.set(finding.rule, (rules.get(finding.rule) ?? 0) + 1);
    actual.set(finding.file, rules);
  }

  const stale: BaselineEntry[] = [];
  for (const [file, rules] of baseline) {
    for (const [rule, count] of rules) {
      if ((actual.get(file)?.get(rule) ?? 0) < count) stale.push({ file, rule });
    }
  }
  return stale.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

/** Every finding, counted, which is what `--suppress-all` records. */
export function tally(findings: { file: string; rule: string }[]): Tally {
  const counts: Tally = new Map();
  for (const finding of findings) {
    const rules = counts.get(finding.file) ?? new Map<string, number>();
    rules.set(finding.rule, (rules.get(finding.rule) ?? 0) + 1);
    counts.set(finding.file, rules);
  }
  return counts;
}
