import fs from 'node:fs';
import path from 'node:path';
import type { CodeAction, TextEdit } from 'vscode-languageserver-types';

import { codeActions } from '@glua/server/features/codeActions.js';
import { diagnose } from '@glua/server/features/diagnostics.js';
import { bold, c, heading, symbols } from './palette.js';
import { loadProject, uriOf } from './project.js';
import { createProgress } from './progress.js';

export interface FixOptions {
  root?: string;
  progress?: boolean;
  /** Report what would change without touching anything. */
  dryRun?: boolean;
}

export interface FixResult {
  /** Files changed, with how many fixes each took. */
  fixed: { file: string; applied: number; titles: string[] }[];
  remaining: number;
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
 * Only `isPreferred` actions are used. The rest either guess (a hook name
 * suggested from an edit distance), insert a stub for you to fill in, or change
 * control flow by wrapping a call in a realm guard — none of which should
 * happen without someone looking at it.
 */
export function fix(targets: string[], options: FixOptions): FixResult {
  const progress = createProgress(options.progress ?? false);

  const { api, workspace, config, files, root } = loadProject(targets, {
    root: options.root,
    onIndex: (done, total, file) => progress.update(done, total, `indexing ${path.basename(file)}`),
  });

  const fixed: FixResult['fixed'] = [];
  let remaining = 0;

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
        .filter((action) => action.isPreferred);

      const edits = editsFor(actions, analysis.uri);
      if (!edits.length) break;

      const next = applyEdits(text, edits, analysis);
      if (next === text) break;

      text = next;
      applied += edits.length;
      for (const action of actions) {
        if (titles.length < 12) titles.push(action.title);
      }
    }

    // Whatever no preferred fix could resolve is still a finding.
    const finalAnalysis = workspace.analyse(uriOf(file), text, MAX_PASSES + 1);
    remaining += diagnose(finalAnalysis, api, workspace, config.settingsFor(finalAnalysis.fsPath), {
      extraGlobals: config.globalsFor(finalAnalysis.fsPath),
    }).length;

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
    filesChecked: files.length,
    output: render(fixed, remaining, files.length, root, options.dryRun ?? false),
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

function editsFor(actions: CodeAction[], uri: string): TextEdit[] {
  const out: TextEdit[] = [];
  for (const action of actions) {
    for (const edit of action.edit?.changes?.[uri] ?? []) out.push(edit);
  }
  return out;
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
  const resolved = edits
    .map((edit) => ({
      start: analysis.lines.offsetAt(edit.range.start),
      end: analysis.lines.offsetAt(edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start);

  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    if (edit.end > lastStart) continue;
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

function render(
  fixed: FixResult['fixed'],
  remaining: number,
  filesChecked: number,
  root: string,
  dryRun: boolean,
): string {
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
    lines.push(
      `  ${c.warning(String(remaining))} ${c.faint('left, which need a look — run `glua lint` to see them')}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
