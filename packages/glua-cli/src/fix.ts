import fs from 'node:fs';
import path from 'node:path';
import { DiagnosticSeverity, type CodeAction, type TextEdit } from 'vscode-languageserver-types';

import { codeActions, isAutoApplicable, safetyOf } from '@glua/server/features/codeActions.js';
import { diagnose } from '@glua/server/features/diagnostics.js';
import { bold, c, heading, symbols } from './palette.js';
import { loadProject, uriOf } from './project.js';
import { createProgress } from './progress.js';

export interface FixOptions {
  root?: string;
  progress?: boolean;
  /** Report what would change without touching anything. */
  dryRun?: boolean;
  /**
   * Also apply fixes that change what the code does. Off by default: see
   * `FixSafety` in the server for what the line is drawn on.
   */
  unsafe?: boolean;
}

export interface FixResult {
  /** Files changed, with how many fixes each took. */
  fixed: { file: string; applied: number; titles: string[] }[];
  remaining: number;
  /**
   * Severity of what is left. Fixing must not turn a failing build green: a
   * parse error no fix could resolve is still an error.
   */
  remainingErrors: number;
  remainingWarnings: number;
  /**
   * Preferred fixes left on the table because they are unsafe. Zero when
   * `unsafe` was asked for, since then there is nothing being held back.
   */
  unsafeAvailable: number;
  filesChecked: number;
  output: string;
}

/**
 * One fix can expose another — adding `util.AddNetworkString` clears the way for
 * the handler check on the same message — but a cycle would spin forever, so
 * passes are capped.
 */
const MAX_PASSES = 5;

/**
 * Applies the quick fixes that have exactly one sensible outcome.
 *
 * Only `isPreferred` actions are considered at all. The rest either guess (a
 * hook name suggested from an edit distance), insert a stub for you to fill in,
 * or change control flow by wrapping a call in a realm guard — none of which
 * should happen without someone looking at it.
 *
 * Of those, only the `safe` ones are applied unless `unsafe` is asked for. A
 * preferred fix can still move when a call runs, and `--fix` writes to files
 * nobody is watching — often in a pre-commit hook or CI job. The unsafe ones
 * are counted and offered rather than taken.
 */
export function fix(targets: string[], options: FixOptions): FixResult {
  const progress = createProgress(options.progress ?? false);

  const { api, workspace, config, files, root } = loadProject(targets, {
    root: options.root,
    onIndex: (done, total, file) => progress.update(done, total, `indexing ${path.basename(file)}`),
  });

  const fixed: FixResult['fixed'] = [];
  let remaining = 0;
  let remainingErrors = 0;
  let remainingWarnings = 0;
  let unsafeAvailable = 0;

  files.forEach((file, i) => {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    progress.update(i + 1, files.length, `fixing ${relative}`);

    let text = readOrNull(file);
    if (text === null) return;

    const titles: string[] = [];
    let applied = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const analysis = workspace.analyse(uriOf(file), text, pass + 1);
      const settings = config.settingsFor(analysis.fsPath);
      const diagnostics = diagnose(analysis, api, workspace, settings, {
        extraGlobals: config.globalsFor(analysis.fsPath),
      });
      if (!diagnostics.length) break;

      const actions = codeActions(analysis, wholeFile(analysis), diagnostics, { api, workspace })
        .filter((action) => (options.unsafe ? action.isPreferred === true : isAutoApplicable(action)));

      const applying = editsFor(actions, analysis.uri);
      if (!applying.edits.length) break;

      const next = applyEdits(text, applying.edits, analysis);
      if (next === text) break;

      text = next;
      applied += applying.actions.length;
      for (const action of applying.actions) {
        if (titles.length < 12) titles.push(action.title);
      }
    }

    // Whatever no preferred fix could resolve is still a finding.
    const finalAnalysis = workspace.analyse(uriOf(file), text, MAX_PASSES + 1);
    const left = diagnose(finalAnalysis, api, workspace, config.settingsFor(finalAnalysis.fsPath), {
      extraGlobals: config.globalsFor(finalAnalysis.fsPath),
    });
    remaining += left.length;
    for (const diagnostic of left) {
      if (diagnostic.severity === DiagnosticSeverity.Error) remainingErrors++;
      else if (diagnostic.severity === DiagnosticSeverity.Warning) remainingWarnings++;
    }

    // What is still on the table, counted against the file as it now stands so
    // the number is one `--unsafe-fixes` would actually apply.
    if (!options.unsafe && left.length) {
      unsafeAvailable += codeActions(finalAnalysis, wholeFile(finalAnalysis), left, { api, workspace })
        .filter((action) => action.isPreferred === true && safetyOf(action) === 'unsafe').length;
    }

    if (applied) {
      fixed.push({ file, applied, titles });
      if (!options.dryRun) fs.writeFileSync(file, text);
    }
    workspace.releaseAst(finalAnalysis.uri);
  });

  progress.done();

  return {
    fixed,
    remaining,
    remainingErrors,
    remainingWarnings,
    unsafeAvailable,
    filesChecked: files.length,
    output: render({
      fixed,
      remaining,
      remainingErrors,
      unsafeAvailable,
      filesChecked: files.length,
      root,
      dryRun: options.dryRun ?? false,
    }),
  };
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const wholeFile = (analysis: { lines: { positionAt(offset: number): { line: number; character: number } }; text: string }) => ({
  start: { line: 0, character: 0 },
  end: analysis.lines.positionAt(analysis.text.length),
});

/**
 * The edits to apply, and the actions they came from.
 *
 * Two diagnostics for the same net message each ask for the same insertion at
 * the top of the file: the second one is dropped, and so is the action, so the
 * count reported is fixes made rather than edits attempted. An action worth one
 * line of output should not be reported as two because it moves a call and
 * leaves a local behind.
 */
function editsFor(actions: CodeAction[], uri: string): { edits: TextEdit[]; actions: CodeAction[] } {
  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  const kept: CodeAction[] = [];

  for (const action of actions) {
    let contributed = false;
    for (const edit of action.edit?.changes?.[uri] ?? []) {
      const { start, end } = edit.range;
      const key = `${start.line}:${start.character}:${end.line}:${end.character}:${edit.newText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push(edit);
      contributed = true;
    }
    if (contributed) kept.push(action);
  }

  return { edits, actions: kept };
}

/**
 * Applies edits back to front so earlier offsets stay valid, dropping any that
 * overlap one already applied — two fixes wanting the same span cannot both be
 * right, and a partial application would corrupt the file.
 */
function applyEdits(
  text: string,
  edits: TextEdit[],
  analysis: { lines: { offsetAt(position: { line: number; character: number }): number } },
): string {
  const resolved = edits.map((edit) => ({
    start: analysis.lines.offsetAt(edit.range.start),
    end: analysis.lines.offsetAt(edit.range.end),
    newText: edit.newText,
  }));

  resolved.sort((a, b) => b.start - a.start);

  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    // Genuine overlap only. Two *different* insertions at one offset — one per
    // unregistered message, say — are both wanted, and applying them back to
    // front stacks them correctly.
    if (edit.end > lastStart) continue;
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

interface Render {
  fixed: FixResult['fixed'];
  remaining: number;
  remainingErrors: number;
  unsafeAvailable: number;
  filesChecked: number;
  root: string;
  dryRun: boolean;
}

function render({
  fixed,
  remaining,
  remainingErrors,
  unsafeAvailable,
  filesChecked,
  root,
  dryRun,
}: Render): string {
  const lines: string[] = [];

  for (const entry of fixed) {
    lines.push('');
    lines.push(bold(c.text(path.relative(root, entry.file).replace(/\\/g, '/'))));
    for (const title of entry.titles) {
      lines.push(`  ${c.success(symbols.pass)} ${c.faint(title)}`);
    }
  }

  lines.push(heading('Summary'));
  lines.push('');

  const total = fixed.reduce((sum, entry) => sum + entry.applied, 0);
  if (!total) {
    lines.push(`  ${c.success(symbols.pass)} ${c.success('nothing to fix')} ${c.faint(`in ${filesChecked} files`)}`);
  } else {
    const verb = dryRun ? 'would fix' : 'fixed';
    lines.push(
      `  ${c.success(bold(`${verb} ${total}`))} ${c.faint(
        `in ${fixed.length} file${fixed.length === 1 ? '' : 's'}, of ${filesChecked} checked`,
      )}`,
    );
  }

  if (remaining) {
    const errors = remainingErrors
      ? `${c.failure(`${remainingErrors} error${remainingErrors === 1 ? '' : 's'}`)}${c.faint(' of ')}`
      : '';
    lines.push(
      `  ${errors}${c.warning(String(remaining))} ` +
        c.faint('left, which need a look — run `glua lint` to see them'),
    );
  }

  if (unsafeAvailable) {
    lines.push(
      `  ${c.faint(symbols.arrow)} ${c.text(
        `${unsafeAvailable} unsafe fix${unsafeAvailable === 1 ? '' : 'es'} available`,
      )} ${c.faint('— run with `--unsafe-fixes` to apply them')}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
