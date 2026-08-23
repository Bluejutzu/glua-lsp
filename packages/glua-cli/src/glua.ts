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

declare const __GLUA_VERSION__: string | undefined;

// Substituted by esbuild from package.json, so it cannot drift from what ships.
const VERSION = typeof __GLUA_VERSION__ === 'string' ? __GLUA_VERSION__ : '0.0.0-dev';

const program = new Command();

program
  .name('glua')
  .description("Lint and format Garry's Mod Lua.")
  .version(VERSION, '-v, --version')
  .option('--no-color', 'disable coloured output (or set NO_COLOR; FORCE_COLOR=1 forces it on)')
  .hook('preAction', (command) => {
    // `--no-color` gives commander a `color` option that defaults to true, so
    // the value alone cannot tell us whether the user actually passed it.
    if (command.getOptionValueSource('color') === 'cli') {
      setColourEnabled(command.opts<{ color: boolean }>().color);
    }
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
  .action(
    (
      paths: string[],
      options: { format: LintFormat; maxWarnings: number; quiet: boolean; root?: string },
    ) => {
      // In GitHub Actions the annotations are the output; colour would corrupt them.
      if (options.format === 'github' || options.format === 'json') setColourEnabled(false);

      const result = lint(paths, {
        format: options.format,
        maxWarnings: options.maxWarnings,
        quiet: options.quiet,
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
  .action((paths: string[], options: { write: boolean; check: boolean; root?: string }) => {
    if (options.write && options.check) {
      program.error('--write and --check cannot be used together.');
    }
    // Neither flag given: report what would change without touching anything.
    const result = format(paths, {
      write: options.write,
      check: options.check,
      ...(options.root ? { root: options.root } : {}),
    });

    if (result.output.trim()) process.stdout.write(`${result.output}\n`);

    if (!options.write && result.changed.length) process.exitCode = 1;
    if (result.skipped.length) process.exitCode = 1;
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
