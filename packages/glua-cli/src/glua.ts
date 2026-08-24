// The `glua` command: lint and format Garry's Mod Lua outside an editor.
//
// The shebang is added by esbuild, not written here, so the bundle does not end
// up with two of them.
//
// Same parser, analyser and formatter the language server uses, so a finding in
// CI is the same finding you saw in the editor.

import { Command, Option } from 'commander';

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
      .choices(['pretty', 'compact', 'github', 'json'])
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
      },
    ) => {
      // In GitHub Actions the annotations are the output; colour would corrupt them.
      if (options.format === 'github' || options.format === 'json') setColourEnabled(false);

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
        ...(options.root ? { root: options.root } : {}),
      });

      if (result.output.trim()) process.stdout.write(`${result.output}\n`);

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
