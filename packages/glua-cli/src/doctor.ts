import { statSync } from 'node:fs';
import path from 'node:path';

import { buildReport, type ProjectReport } from '@glua/server/features/report.js';
import { renderHtml } from '@glua/server/features/reportHtml.js';
import { bold, c, heading, pad, symbols } from './palette.js';
import { loadProject } from './project.js';
import { createProgress } from './progress.js';

export type DoctorFormat = 'pretty' | 'json' | 'html';

export interface DoctorOptions {
  format: DoctorFormat;
  root?: string;
  gamePath?: string;
  progress?: boolean;
  top?: number;
}

export interface DoctorResult {
  report: ProjectReport;
  output: string;
}

export async function doctor(targets: string[], options: DoctorOptions): Promise<DoctorResult> {
  const progress = createProgress(options.progress ?? false);

  // A report is about the project named on the command line, not about
  // wherever the terminal happens to be sitting.
  const root = options.root ?? inferRoot(targets);

  const { api, workspace, config, root: resolved } = loadProject(targets, {
    root,
    ...(options.gamePath ? { gamePath: options.gamePath } : {}),
    onIndex: (done, total, file) => progress.update(done, total, `indexing ${path.basename(file)}`),
  });

  // Nothing else is waiting on this process, so keep the scan uninterrupted.
  const report = await buildReport(api, workspace, {
    settingsFor: (fsPath) => config.settingsFor(fsPath),
    globalsFor: (fsPath) => config.globalsFor(fsPath),
    onProgress: (done, total) => progress.update(done, total, 'reading the project'),
    top: options.top ?? 8,
    yieldEvery: 0,
  });

  progress.done();

  const render = {
    pretty: () => renderPretty(report, resolved),
    json: () => JSON.stringify(report, null, 2),
    html: () => renderHtml(report, path.basename(resolved)),
  }[options.format];

  return { report, output: render() };
}

/** The first target that is a directory, else the directory the file is in. */
function inferRoot(targets: string[]): string | undefined {
  const first = targets.find((target) => target !== '.');
  if (!first) return undefined;
  const resolved = path.resolve(first);
  try {
    return statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------- pretty */

const number = (value: number) => value.toLocaleString('en-US');

/** Enough for the words this actually prints: entity, weapon, effect. */
const plural = (word: string, count: number) =>
  count === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`;

function renderPretty(report: ProjectReport, root: string): string {
  const lines: string[] = [];
  const name = path.basename(root);

  lines.push('');
  lines.push(
    `  ${bold(c.highlight(name))}   ` +
      c.faint(
        `${number(report.files)} files · ${number(report.lines)} lines` +
          (report.libraryFiles ? ` · ${number(report.libraryFiles)} from libraries` : ''),
      ),
  );

  const row = (label: string, value: string, note?: string) => {
    lines.push(`  ${c.muted(pad(label, 12))} ${value}${note ? `  ${c.faint(note)}` : ''}`);
  };

  /* -- realms -- */
  lines.push(heading('Layout'));
  lines.push('');
  const realms = Object.entries(report.realms).filter(([, n]) => n > 0);
  row('realms', realms.map(([r, n]) => `${c.text(String(n))} ${c.faint(r)}`).join(c.faint('  ·  ')));
  if (report.entities.total) {
    const kinds = Object.entries(report.entities.byKind)
      .map(([kind, n]) => `${c.text(String(n))} ${c.faint(plural(kind, n))}`)
      .join(c.faint('  ·  '));
    row('classes', kinds);
  }

  /* -- what is wrong -- */
  lines.push(heading('Health'));
  lines.push('');

  const problems: [string, number, string][] = [
    ['net messages', report.net.unhandled.length + report.net.unsent.length + report.net.unregistered.length,
      describeNet(report)],
    ['hook clashes', report.hooks.collisions.length, 'same event and identifier, overlapping realms'],
    ['timer clashes', report.timers.collisions.length, 'same name, one silently replaces the other'],
    ['unknown names', report.undefinedGlobals.reduce((sum, g) => sum + g.count, 0),
      'globals defined nowhere we can see'],
  ];

  for (const [label, count, note] of problems) {
    const value = count
      ? `${c.warning(symbols.warning)} ${c.text(bold(number(count)))}`
      : `${c.success(symbols.pass)} ${c.faint('none')}`;
    row(label, value, count ? note : undefined);
  }

  row(
    'findings',
    report.diagnostics.total
      ? c.text(bold(number(report.diagnostics.total)))
      : `${c.success(symbols.pass)} ${c.faint('none')}`,
    report.diagnostics.byCode
      .slice(0, 3)
      .map((r) => `${r.count} ${r.name}`)
      .join(', '),
  );

  /* -- detail -- */
  if (report.diagnostics.byCode.length) {
    lines.push(heading('By rule'));
    lines.push('');
    const width = Math.max(...report.diagnostics.byCode.map((r) => r.name.length));
    for (const rule of report.diagnostics.byCode) {
      lines.push(`  ${c.accent(pad(rule.name, width))}  ${c.text(pad(number(rule.count), 6))}`);
    }
  }

  if (report.hooks.collisions.length || report.timers.collisions.length) {
    lines.push(heading('Collisions'));
    lines.push('');
    const width = Math.max(
      8,
      ...report.hooks.collisions.slice(0, 8).map((clash) => clash.event.length),
    );
    for (const clash of report.hooks.collisions.slice(0, 8)) {
      lines.push(
        `  ${c.warning(symbols.warning)} ${c.text(pad(clash.event, width))}  ` +
          `${c.accent(clash.identifier)} ${c.faint(`×${clash.count}`)}`,
      );
    }
    for (const clash of report.timers.collisions.slice(0, 8)) {
      lines.push(
        `  ${c.warning(symbols.warning)} ${c.muted(pad('timer', width))}  ` +
          `${c.accent(clash.name)} ${c.faint(`×${clash.count}`)}`,
      );
    }
  }

  if (report.undefinedGlobals.length) {
    lines.push(heading('Unknown globals'));
    lines.push('');
    lines.push(`  ${c.faint('A framework this project does not contain, or a typo.')}`);
    lines.push(`  ${c.faint('Point at its source with workspace.libraries to resolve them.')}`);
    lines.push('');
    const width = Math.max(...report.undefinedGlobals.map((g) => g.name.length));
    for (const global of report.undefinedGlobals) {
      lines.push(`  ${c.text(pad(global.name, width))}  ${c.faint(`${global.count} uses`)}`);
    }
  }

  if (report.entities.largest.length) {
    lines.push(heading('Largest classes'));
    lines.push('');
    const width = Math.max(...report.entities.largest.map((e) => e.name.length));
    for (const entity of report.entities.largest) {
      lines.push(
        `  ${c.text(pad(entity.name, width))}  ${c.faint(pad(entity.kind, 7))}  ` +
          `${c.text(pad(String(entity.members), 4))} ${c.faint('members')}  ` +
          `${c.faint(`${entity.files} file${entity.files === 1 ? '' : 's'}`)}`,
      );
    }
  }

  if (report.worstFiles.length) {
    lines.push(heading('Files to look at'));
    lines.push('');
    for (const file of report.worstFiles) {
      const relative = path.relative(root, file.file).replace(/\\/g, '/');
      lines.push(
        `  ${c.text(pad(relative, 54))}  ${c.faint(pad(`${number(file.lines)} lines`, 12))}  ` +
          `${c.warning(String(file.findings))} ${c.faint('findings')}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function describeNet(report: ProjectReport): string {
  const parts: string[] = [];
  if (report.net.unregistered.length) parts.push(`${report.net.unregistered.length} unregistered`);
  if (report.net.unhandled.length) parts.push(`${report.net.unhandled.length} with no handler`);
  if (report.net.unsent.length) parts.push(`${report.net.unsent.length} nothing sends`);
  return parts.join(', ');
}
