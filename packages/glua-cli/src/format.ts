import fs from 'node:fs';
import path from 'node:path';

import { parse } from '@glua/parser/parser.js';
import { detectEndOfLine, formatDocument } from '@glua/format/printer.js';
import { bold, c, heading, symbols } from './palette.js';
import { loadProject } from './project.js';
import { createProgress } from './progress.js';

export interface FormatOptions {
  write: boolean;
  check: boolean;
  root?: string;
  progress?: boolean;
}

export interface FormatResult {
  changed: string[];
  unchanged: number;
  skipped: { file: string; reason: string }[];
  output: string;
}

export function format(targets: string[], options: FormatOptions): FormatResult {
  const progress = createProgress(options.progress ?? false);

  const { config, files, root } = loadProject(targets, {
    root: options.root,
    onIndex: (done, total, file) => progress.update(done, total, `indexing ${path.basename(file)}`),
  });

  const changed: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let unchanged = 0;

  for (const [i, file] of files.entries()) {
    progress.update(i + 1, files.length, `formatting ${path.relative(root, file).replace(/\\/g, '/')}`);
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const parsed = parse(source);
    if (parsed.errors.length) {
      // Formatting a file that does not parse is how you turn one problem into
      // two. Report it and move on.
      const first = parsed.errors[0]!;
      const line = source.slice(0, first.start).split('\n').length;
      skipped.push({ file, reason: `does not parse (line ${line}: ${first.message})` });
      continue;
    }

    const formatted = formatDocument(source, parsed, {
      ...config.formatOptionsFor(file),
      endOfLine: detectEndOfLine(source),
    });

    if (formatted === null || formatted === source) {
      unchanged++;
      continue;
    }

    changed.push(file);
    if (options.write) fs.writeFileSync(file, formatted);
  }
  progress.done();

  return {
    changed,
    unchanged,
    skipped,
    output: render(changed, unchanged, skipped, root, options),
  };
}

function render(
  changed: string[],
  unchanged: number,
  skipped: { file: string; reason: string }[],
  root: string,
  options: FormatOptions,
): string {
  const lines: string[] = [];
  const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');

  if (changed.length) {
    lines.push('');
    for (const file of changed) {
      const mark = options.write ? c.success(symbols.pass) : c.warning(symbols.warning);
      const what = options.write ? 'formatted' : 'would reformat';
      lines.push(`  ${mark} ${c.faint(what)} ${c.text(rel(file))}`);
    }
  }

  if (skipped.length) {
    lines.push(heading('Skipped'));
    lines.push('');
    for (const { file, reason } of skipped) {
      lines.push(`  ${c.failure(symbols.error)} ${c.text(rel(file))}`);
      lines.push(`    ${c.faint(reason)}`);
    }
  }

  lines.push(heading('Summary'));
  lines.push('');

  const parts = [
    changed.length
      ? (options.write ? c.success : c.warning)(
          bold(`${changed.length} ${options.write ? 'formatted' : 'to reformat'}`),
        )
      : null,
    unchanged ? c.faint(`${unchanged} unchanged`) : null,
    skipped.length ? c.failure(`${skipped.length} skipped`) : null,
  ].filter(Boolean) as string[];

  if (!parts.length) {
    lines.push(`  ${c.success(symbols.pass)} ${c.success('nothing to do')}`);
  } else {
    lines.push(`  ${parts.join(c.faint('  ' + symbols.bullet + '  '))}`);
  }

  lines.push('');
  return lines.join('\n');
}
