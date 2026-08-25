import path from 'node:path';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types';

import { diagnose } from '@glua/server/features/diagnostics.js';
import { bold, c, heading, pad, plain, symbols } from './palette.js';
import {
  applyBaseline,
  BASELINE_NAME,
  countsOf,
  readBaseline,
  staleEntries,
  tally,
  writeBaseline,
} from './baseline.js';
import { loadProject, uriOf } from './project.js';
import { RULES } from './rules.js';
import { createProgress } from './progress.js';

export type LintFormat = 'pretty' | 'json' | 'github' | 'compact' | 'sarif';

export interface LintOptions {
  format: LintFormat;
  maxWarnings: number;
  quiet: boolean;
  root?: string;
  progress?: boolean;
  /** Record every current finding as accepted, and report nothing. */
  suppressAll?: boolean;
  /** Rewrite the baseline so it claims no more than actually happens. */
  prune?: boolean;
  /** Report everything, as though the project had no baseline. */
  ignoreBaseline?: boolean;
}

interface Finding {
  file: string;
  diagnostic: Diagnostic;
}

/** Baseline keys: a path the file can be recognised by, and a rule code. */
const keyed = (finding: Finding, root: string) => ({
  ...finding,
  rule: String(finding.diagnostic.code ?? 'unknown'),
  relative: path.relative(root, finding.file).replace(/\\/g, '/'),
});

/** The protocol allows a MarkupContent message; the server only ever sends strings. */
const messageOf = (diagnostic: Diagnostic): string =>
  typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;

const severityName = (s: DiagnosticSeverity | undefined): string => {
  switch (s) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
};

const paintSeverity = (s: DiagnosticSeverity | undefined, text: string): string => {
  switch (s) {
    case DiagnosticSeverity.Error:
      return c.failure(text);
    case DiagnosticSeverity.Warning:
      return c.warning(text);
    case DiagnosticSeverity.Information:
      return c.highlight(text);
    default:
      return c.faint(text);
  }
};

export interface LintResult {
  findings: Finding[];
  errors: number;
  warnings: number;
  filesChecked: number;
  output: string;
  /** Findings a baseline accepted, and so are absent from `findings`. */
  suppressed: number;
  /** Set when the run wrote or rewrote the baseline instead of reporting. */
  wrote?: { path: string; entries: number; findings: number };
}

export function lint(targets: string[], options: LintOptions): LintResult {
  const progress = createProgress(options.progress ?? false);

  const { api, workspace, config, files, root } = loadProject(targets, {
    root: options.root,
    onIndex: (done, total, file) => progress.update(done, total, `indexing ${path.basename(file)}`),
  });

  const findings: Finding[] = [];
  files.forEach((file, i) => {
    progress.update(i + 1, files.length, `linting ${path.relative(root, file).replace(/\\/g, '/')}`);
    const analysis = workspace.full(uriOf(file));
    if (!analysis || workspace.isLibrary(analysis.uri)) return;
    const diagnostics = diagnose(
      analysis,
      api,
      workspace,
      config.settingsFor(analysis.fsPath),
      { extraGlobals: config.globalsFor(analysis.fsPath) },
    );
    for (const diagnostic of diagnostics) findings.push({ file, diagnostic });
    workspace.releaseAst(analysis.uri);
  });
  progress.done();

  /* ------------------------------------------------------------ baseline */

  const all = findings.map((finding) => keyed(finding, root));

  if (options.suppressAll || options.prune) {
    const counts = tally(all.map((f) => ({ file: f.relative, rule: f.rule })));
    writeBaseline(root, counts);
    const entries = [...counts.values()].reduce((sum, rules) => sum + rules.size, 0);
    return {
      findings: [],
      errors: 0,
      warnings: 0,
      suppressed: all.length,
      filesChecked: files.length,
      wrote: { path: BASELINE_NAME, entries, findings: all.length },
      output: renderWrote(options.prune ? 'prune' : 'suppress', entries, all.length, files.length),
    };
  }

  let kept = findings;
  let suppressed = 0;
  let stale = 0;

  if (!options.ignoreBaseline) {
    const baseline = readBaseline(root);
    if (baseline) {
      const counts = countsOf(baseline);
      const split = applyBaseline(
        all.map((f) => ({ ...f, file: f.relative })),
        counts,
      );
      const accepted = new Set(split.suppressed.map((f) => f.diagnostic));
      kept = findings.filter((finding) => !accepted.has(finding.diagnostic));
      suppressed = split.suppressed.length;
      stale = staleEntries(
        all.map((f) => ({ file: f.relative, rule: f.rule })),
        counts,
      ).length;
    }
  }

  const visible = options.quiet
    ? kept.filter((f) => f.diagnostic.severity === DiagnosticSeverity.Error)
    : kept;

  const errors = kept.filter((f) => f.diagnostic.severity === DiagnosticSeverity.Error).length;
  const warnings = kept.filter(
    (f) => f.diagnostic.severity === DiagnosticSeverity.Warning,
  ).length;

  const render = {
    pretty: () => renderPretty(visible, files.length, root, errors, warnings, suppressed, stale),
    compact: () => renderCompact(visible, root),
    github: () => renderGithub(visible, root),
    json: () => renderJson(visible, root),
    sarif: () => renderSarif(visible, root),
  }[options.format];

  return {
    findings: kept,
    errors,
    warnings,
    suppressed,
    filesChecked: files.length,
    output: render(),
  };
}

/** What `--suppress-all` and `--prune-suppressions` print instead of findings. */
function renderWrote(kind: 'suppress' | 'prune', entries: number, count: number, files: number): string {
  const lines = ['', `  ${c.success(symbols.pass)} ${bold(c.text(BASELINE_NAME))} ${
    kind === 'prune' ? c.faint('rewritten') : c.faint('written')
  }`, ''];
  lines.push(
    `  ${c.text(String(count))} ${c.faint(`findings accepted across ${entries} file/rule entries, in ${files} files.`)}`,
  );
  lines.push('');
  lines.push(`  ${c.faint('Commit it. New findings are reported from here on;')}`);
  lines.push(`  ${c.faint('run with --ignore-baseline to see the whole backlog again.')}`);
  lines.push('');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- pretty */

function renderPretty(
  findings: Finding[],
  filesChecked: number,
  root: string,
  errors: number,
  warnings: number,
  suppressed = 0,
  stale = 0,
): string {
  const lines: string[] = [];

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file);
    if (list) list.push(finding);
    else byFile.set(finding.file, [finding]);
  }

  for (const [file, group] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('');
    lines.push(bold(c.text(path.relative(root, file).replace(/\\/g, '/'))));

    const width = Math.max(
      ...group.map((f) => `${f.diagnostic.range.start.line + 1}:${f.diagnostic.range.start.character + 1}`.length),
    );

    for (const { diagnostic } of group.sort(
      (a, b) => a.diagnostic.range.start.line - b.diagnostic.range.start.line,
    )) {
      const at = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
      const level = severityName(diagnostic.severity);
      lines.push(
        `  ${c.faint(pad(at, width))}  ${paintSeverity(diagnostic.severity, pad(level, 7))}  ` +
          `${c.text(messageOf(diagnostic))}  ${c.faint(String(diagnostic.code ?? ''))}`,
      );
    }
  }

  lines.push(heading('Summary'));
  lines.push('');

  const parts = [
    errors ? c.failure(bold(`${errors} error${errors === 1 ? '' : 's'}`)) : null,
    warnings ? c.warning(`${warnings} warning${warnings === 1 ? '' : 's'}`) : null,
  ].filter(Boolean) as string[];

  if (!parts.length) {
    lines.push(`  ${c.success(symbols.pass)} ${c.success('no problems')} ${c.faint(`in ${filesChecked} files`)}`);
  } else {
    lines.push(`  ${parts.join(c.faint('  ' + symbols.bullet + '  '))}  ${c.faint(`in ${filesChecked} files`)}`);
  }

  if (suppressed) {
    lines.push(`  ${c.faint(`${suppressed} accepted by ${BASELINE_NAME}`)}`);
  }
  if (stale) {
    lines.push(
      `  ${c.faint(`${stale} baseline ${stale === 1 ? 'entry claims' : 'entries claim'} findings that no longer happen — run --prune-suppressions`)}`,
    );
  }

  lines.push('');
  void plain;
  return lines.join('\n');
}

/* --------------------------------------------------------------- compact */

function renderCompact(findings: Finding[], root: string): string {
  return findings
    .map(({ file, diagnostic }) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const at = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
      return `${rel}:${at}: ${severityName(diagnostic.severity)}: ${messageOf(diagnostic)} [${diagnostic.code}]`;
    })
    .join('\n');
}

/* ---------------------------------------------------------------- github */

/** GitHub Actions annotation syntax, so findings land on the diff in a PR. */
function renderGithub(findings: Finding[], root: string): string {
  return findings
    .map(({ file, diagnostic }) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const level =
        diagnostic.severity === DiagnosticSeverity.Error
          ? 'error'
          : diagnostic.severity === DiagnosticSeverity.Warning
            ? 'warning'
            : 'notice';
      // Newlines would end the annotation early.
      const message = messageOf(diagnostic).replace(/\r?\n/g, ' ');
      return (
        `::${level} file=${rel},` +
        `line=${diagnostic.range.start.line + 1},` +
        `col=${diagnostic.range.start.character + 1},` +
        `title=glua(${diagnostic.code})::${message}`
      );
    })
    .join('\n');
}

/* ----------------------------------------------------------------- sarif */

declare const __GLUA_VERSION__: string | undefined;

const DOCS = 'https://glua.bluejutzu.dev';

/**
 * SARIF 2.1.0, which is what GitHub code scanning ingests.
 *
 * Worth having over `--format github`: annotations live and die with one
 * workflow run, whereas an uploaded SARIF file gives findings a history, a
 * place to be dismissed, and a diff between the pull request and the base
 * branch. Paths are relative to the project root, which is what the upload
 * action expects.
 */
function renderSarif(findings: Finding[], root: string): string {
  const index = new Map(RULES.map((rule, i) => [rule.code, i]));

  const level = (severity: DiagnosticSeverity | undefined): string => {
    switch (severity) {
      case DiagnosticSeverity.Error:
        return 'error';
      case DiagnosticSeverity.Warning:
        return 'warning';
      default:
        return 'note';
    }
  };

  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'glua',
              informationUri: DOCS,
              version: typeof __GLUA_VERSION__ === 'string' ? __GLUA_VERSION__ : '0.0.0-dev',
              rules: RULES.map((rule) => ({
                id: rule.code,
                name: rule.code,
                shortDescription: { text: rule.summary },
                helpUri: `${DOCS}/reference/rules`,
                properties: { settingsKey: rule.settingsKey },
              })),
            },
          },
          results: findings.map(({ file, diagnostic }) => {
            const code = String(diagnostic.code ?? 'unknown');
            const ruleIndex = index.get(code);
            return {
              ruleId: code,
              ...(ruleIndex === undefined ? {} : { ruleIndex }),
              level: level(diagnostic.severity),
              message: { text: messageOf(diagnostic) },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: {
                      uri: path.relative(root, file).replace(/\\/g, '/'),
                    },
                    // SARIF counts lines and columns from one; LSP from zero.
                    region: {
                      startLine: diagnostic.range.start.line + 1,
                      startColumn: diagnostic.range.start.character + 1,
                      endLine: diagnostic.range.end.line + 1,
                      endColumn: diagnostic.range.end.character + 1,
                    },
                  },
                },
              ],
            };
          }),
        },
      ],
    },
    null,
    2,
  )}`;
}

/* ------------------------------------------------------------------ json */

function renderJson(findings: Finding[], root: string): string {
  return JSON.stringify(
    findings.map(({ file, diagnostic }) => ({
      file: path.relative(root, file).replace(/\\/g, '/'),
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      severity: severityName(diagnostic.severity),
      code: diagnostic.code,
      message: messageOf(diagnostic),
    })),
    null,
    2,
  );
}
