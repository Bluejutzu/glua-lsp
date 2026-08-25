// The `glua` command: lint and format Garry's Mod Lua outside an editor.
//
// The shebang is added by esbuild, not written here, so the bundle does not end
// up with two of them.
//
// Same parser, analyser and formatter the language server uses, so a finding in
// CI is the same finding you saw in the editor.

import { Command, Option } from 'commander';

import type { DoctorFormat } from './doctor.js';
import { format } from './format.js';
import { lint, type LintFormat } from './lint.js';
import { bold, c, heading, setColourEnabled, symbols } from './palette.js';
import { supportsProgress } from './progress.js';
import { checkForUpdate, renderUpdateNotice, type UpdateNotice } from './update-check.js';

declare const __GLUA_VERSION__: string | undefined;

// Substituted by esbuild from package.json, so it cannot drift from what ships.
const VERSION = typeof __GLUA_VERSION__ === 'string' ? __GLUA_VERSION__ : '0.0.0-dev';

const program = new Command();

// Kicked off in `preAction` so the registry request overlaps with whatever
// the command itself is doing, and awaited in `postAction` so it never
// delays a result that is already known.
let updateCheck: Promise<UpdateNotice | null> = Promise.resolve(null);

program
  .name('glua')
  .description("Lint and format Garry's Mod Lua.")
  .version(VERSION, '-v, --version')
  .option('--no-color', 'disable coloured output (or set NO_COLOR; FORCE_COLOR=1 forces it on)')
  .option('--no-update-check', 'skip the npm registry check for a newer glua-cli')
  .hook('preAction', (command) => {
    // `--no-color` gives commander a `color` option that defaults to true, so
    // the value alone cannot tell us whether the user actually passed it.
    if (command.getOptionValueSource('color') === 'cli') {
      setColourEnabled(command.opts<{ color: boolean }>().color);
    }
    if (command.opts<{ updateCheck: boolean }>().updateCheck) {
      updateCheck = checkForUpdate(VERSION);
    }
  })
  .hook('postAction', async () => {
    const notice = await updateCheck;
    if (notice) process.stderr.write(renderUpdateNotice(notice));
  });

/* ------------------------------------------------------------------ lint */

program
  .command('lint', { isDefault: false })
  .description('Report problems in Lua files')
  .argument('[paths...]', 'files or directories to check', ['.'])
  .addOption(
    new Option('-f, --format <format>', 'output format')
      .choices(['pretty', 'compact', 'github', 'json', 'sarif'])
      .default('pretty'),
  )
  .option('--root <dir>', 'project root for config files and relative paths')
  .option(
    '--max-warnings <n>',
    'exit non-zero when there are more than this many warnings',
    (value) => Number.parseInt(value, 10),
    -1,
  )
  .option('-q, --quiet', 'only report errors', false)
  .option(
    '--suppress-all',
    'accept every current finding into .glua-baseline.json and report nothing; new findings are reported from then on',
    false,
  )
  .option('--prune-suppressions', 'rewrite the baseline so it claims no more than still happens', false)
  .option('--ignore-baseline', 'report everything, as though the project had no baseline', false)
  .option('--fix', 'apply the fixes that have one sensible outcome, then report the rest', false)
  .option('--fix-dry-run', 'show what --fix would change without writing', false)
  .option('--no-progress', 'do not print progress while linting')
  .action(
    async (
      paths: string[],
      options: {
        format: LintFormat;
        maxWarnings: number;
        quiet: boolean;
        fix: boolean;
        fixDryRun: boolean;
        root?: string;
        progress: boolean;
        suppressAll: boolean;
        pruneSuppressions: boolean;
        ignoreBaseline: boolean;
      },
    ) => {
      // In GitHub Actions the annotations are the output; colour would corrupt them.
      if (options.format !== 'pretty' && options.format !== 'compact') setColourEnabled(false);

      if ((options.suppressAll || options.pruneSuppressions) && (options.fix || options.fixDryRun)) {
        process.stderr.write(
          `${c.failure(symbols.error)} --fix cannot be combined with --suppress-all or --prune-suppressions: ` +
            `fix the code, or accept it, not both in one pass.\n`,
        );
        process.exitCode = 2;
        return;
      }

      if (options.fix || options.fixDryRun) {
        const { fix } = await import('./fix.js');
        const result = fix(paths, {
          dryRun: options.fixDryRun,
          progress: options.progress && supportsProgress(),
          ...(options.root ? { root: options.root } : {}),
        });
        if (result.output.trim()) process.stdout.write(`${result.output}\n`);

        // Fixing must not turn a failing build green. These are the same
        // semantics the plain lint branch below uses.
        if (result.remainingErrors > 0) {
          process.exitCode = 1;
        } else if (options.maxWarnings >= 0 && result.remainingWarnings > options.maxWarnings) {
          process.stderr.write(
            `${c.failure(symbols.error)} ${result.remainingWarnings} warnings exceeds the limit of ${options.maxWarnings}.\n`,
          );
          process.exitCode = 1;
        }
        return;
      }

      const result = lint(paths, {
        format: options.format,
        maxWarnings: options.maxWarnings,
        quiet: options.quiet,
        progress: options.progress && supportsProgress(),
        suppressAll: options.suppressAll,
        prune: options.pruneSuppressions,
        ignoreBaseline: options.ignoreBaseline,
        ...(options.root ? { root: options.root } : {}),
      });

      if (result.output.trim()) process.stdout.write(`${result.output}\n`);

      // Writing a baseline is a bookkeeping action, not a verdict on the code.
      if (result.wrote) return;

      if (result.errors > 0) process.exitCode = 1;
      else if (options.maxWarnings >= 0 && result.warnings > options.maxWarnings) {
        process.stderr.write(
          `${c.failure(symbols.error)} ${result.warnings} warnings exceeds the limit of ${options.maxWarnings}.\n`,
        );
        process.exitCode = 1;
      }
    },
  );

/* ------------------------------------------------------------------- fmt */

program
  .command('fmt')
  .alias('format')
  .description('Format Lua files')
  .argument('[paths...]', 'files or directories to format', ['.'])
  .option('-w, --write', 'rewrite files in place', false)
  .option('-c, --check', 'exit non-zero if anything would change, and write nothing', false)
  .option('--root <dir>', 'project root for config files and relative paths')
  .option('--no-progress', 'do not print progress while formatting')
  .action(
    (paths: string[], options: { write: boolean; check: boolean; root?: string; progress: boolean }) => {
      if (options.write && options.check) {
        program.error('--write and --check cannot be used together.');
      }
      // Neither flag given: report what would change without touching anything.
      const result = format(paths, {
        write: options.write,
        check: options.check,
        progress: options.progress && supportsProgress(),
        ...(options.root ? { root: options.root } : {}),
      });

      if (result.output.trim()) process.stdout.write(`${result.output}\n`);

      if (!options.write && result.changed.length) process.exitCode = 1;
      if (result.skipped.length) process.exitCode = 1;
    },
  );

/* ---------------------------------------------------------------- doctor */

program
  .command('doctor')
  .description('Report on the whole project rather than one file at a time')
  .argument('[paths...]', 'the project to look at', ['.'])
  .addOption(
    new Option('-f, --format <format>', 'output format').choices(['pretty', 'json', 'html']).default('pretty'),
  )
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .option('--root <dir>', 'project root for config files and relative paths')
  .option('--game-path <dir>', 'a Garry\'s Mod directory, so base game content counts as existing')
  .option('--top <n>', 'how many entries to list per section', (v) => Number.parseInt(v, 10), 8)
  .option('--max-findings <n>', 'exit non-zero above this many findings', (v) => Number.parseInt(v, 10), -1)
  .option('--no-progress', 'do not print progress')
  .action(
    async (
      paths: string[],
      options: {
        format: DoctorFormat;
        out?: string;
        root?: string;
        gamePath?: string;
        top: number;
        maxFindings: number;
        progress: boolean;
      },
    ) => {
      if (options.format !== 'pretty' || options.out) setColourEnabled(false);

      const { doctor } = await import('./doctor.js');
      const result = await doctor(paths, {
        format: options.format,
        top: options.top,
        progress: options.progress && !options.out && supportsProgress(),
        ...(options.root ? { root: options.root } : {}),
        ...(options.gamePath ? { gamePath: options.gamePath } : {}),
      });

      if (options.out) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(options.out, result.output);
        process.stdout.write(
          `${c.success(symbols.pass)} wrote ${bold(options.out)} ${c.faint(
            `(${result.report.files} files, ${result.report.diagnostics.total} findings)`,
          )}\n`,
        );
      } else {
        process.stdout.write(`${result.output}\n`);
      }

      if (options.maxFindings >= 0 && result.report.diagnostics.total > options.maxFindings) {
        process.stderr.write(
          `${c.failure(symbols.error)} ${result.report.diagnostics.total} findings exceeds the limit of ${options.maxFindings}.\n`,
        );
        process.exitCode = 1;
      }
    },
  );

/* ------------------------------------------------------------------ init */

program
  .command('init')
  .description('Write .glua.json and .gluafmtrc.json, seeded from the defaults')
  .option('--lint-only', 'write only .glua.json', false)
  .option('--format-only', 'write only .gluafmtrc.json', false)
  .option('--root <dir>', 'directory to write them in', '.')
  .option('-f, --force', 'overwrite a config that already exists', false)
  .action(async (options: { lintOnly: boolean; formatOnly: boolean; root: string; force: boolean }) => {
    if (options.lintOnly && options.formatOnly) {
      program.error('--lint-only and --format-only cannot be used together.');
    }

    const { init } = await import('./init.js');
    const result = init({
      kinds: options.lintOnly ? ['lint'] : options.formatOnly ? ['format'] : ['lint', 'format'],
      root: options.root,
      force: options.force,
    });

    process.stdout.write(`${result.output}\n`);
    if (!result.written.length) process.exitCode = 1;
  });

/* ----------------------------------------------------------------- extra */

program
  .command('rules')
  .description('List every diagnostic rule and its settings key')
  .action(async () => {
    const { RULES } = await import('./rules.js');
    process.stdout.write(`${heading('Diagnostic rules')}\n\n`);
    const width = Math.max(...RULES.map((r) => r.code.length));
    for (const rule of RULES) {
      process.stdout.write(
        `  ${c.accent(rule.code.padEnd(width))}  ${c.muted(rule.settingsKey)}\n` +
          `  ${' '.repeat(width)}  ${c.faint(rule.summary)}\n`,
      );
    }
    process.stdout.write(
      `\n  ${c.faint(`suppress one inline with ${bold('-- glua-ignore <code>')}`)}\n\n`,
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `${c.failure(symbols.error)} ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
});
