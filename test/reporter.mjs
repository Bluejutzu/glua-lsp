// Custom node:test reporter.
//
// Groups results by file, keeps passing tests to one line each, and gives
// failures the room they need. Run with:
//   node --test --test-reporter=./test/reporter.mjs "test/*.test.mjs"

import path from 'node:path';
import { bold, c, duration, heading, pad, plain, symbols } from '../tools/palette.mjs';

/** Turns an absolute test file path into something short enough to scan. */
function shortFile(file) {
  if (!file) return 'unknown';
  return path.relative(process.cwd(), file).replace(/\\/g, '/');
}

export default async function* reporter(source) {
  /** @type {Map<string, {passed: number, failed: number, skipped: number, ms: number}>} */
  const files = new Map();
  const failures = [];
  const diagnostics = [];
  let currentFile = null;

  const fileStats = (file) => {
    let stats = files.get(file);
    if (!stats) {
      stats = { passed: 0, failed: 0, skipped: 0, ms: 0 };
      files.set(file, stats);
    }
    return stats;
  };

  for await (const event of source) {
    const file = shortFile(event.data?.file);

    switch (event.type) {
      case 'test:pass': {
        // Suites report as passes too; only count real tests.
        if (event.data.details?.type === 'suite') break;
        const stats = fileStats(file);
        if (event.data.skip) stats.skipped++;
        else stats.passed++;
        stats.ms += event.data.details?.duration_ms ?? 0;

        if (file !== currentFile) {
          currentFile = file;
          yield `\n${bold(c.text(file))}\n`;
        }
        const mark = event.data.skip ? c.faint(symbols.skip) : c.success(symbols.pass);
        const name = event.data.skip ? c.faint(event.data.name) : c.muted(event.data.name);
        yield `  ${mark} ${name} ${duration(event.data.details?.duration_ms ?? 0)}\n`;
        break;
      }

      case 'test:fail': {
        if (event.data.details?.type === 'suite') break;
        const stats = fileStats(file);
        stats.failed++;
        stats.ms += event.data.details?.duration_ms ?? 0;

        if (file !== currentFile) {
          currentFile = file;
          yield `\n${bold(c.text(file))}\n`;
        }
        yield `  ${c.failure(symbols.fail)} ${c.failure(event.data.name)} ${duration(
          event.data.details?.duration_ms ?? 0,
        )}\n`;

        failures.push({ file, name: event.data.name, error: event.data.details?.error });
        break;
      }

      case 'test:diagnostic':
        // The runner's own totals are re-printed in our summary.
        if (/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(event.data.message)) {
          break;
        }
        diagnostics.push(event.data.message);
        break;

      case 'test:stdout':
        // Benchmarks and console.log from tests.
        yield c.faint(`    ${event.data.message.replace(/\n$/, '').split('\n').join('\n    ')}\n`);
        break;

      case 'test:stderr':
        yield c.warning(`    ${event.data.message.replace(/\n$/, '')}\n`);
        break;

      default:
        break;
    }
  }

  /* ------------------------------------------------------------ failures */

  if (failures.length) {
    yield heading(`${failures.length} failing`);
    yield '\n';

    for (const [index, failure] of failures.entries()) {
      yield `\n${c.failure(bold(`${index + 1}) ${failure.name}`))}\n`;
      yield `   ${c.faint(failure.file)}\n\n`;

      const error = failure.error?.cause ?? failure.error;
      const message = error?.message ?? String(error ?? 'unknown error');

      for (const line of message.split('\n')) {
        // assert's +actual / -expected diff lines get their own colours.
        if (/^\s*\+/.test(line)) yield `   ${c.success(line)}\n`;
        else if (/^\s*-/.test(line)) yield `   ${c.failure(line)}\n`;
        else yield `   ${c.text(line)}\n`;
      }

      if (error?.stack) {
        const frame = error.stack
          .split('\n')
          .find((line) => line.includes('.test.mjs') || line.includes('.mjs:'));
        if (frame) yield `\n   ${c.faint(frame.trim())}\n`;
      }
    }
  }

  /* ------------------------------------------------------------- summary */

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;

  for (const stats of files.values()) {
    passed += stats.passed;
    failed += stats.failed;
    skipped += stats.skipped;
    total += stats.ms;
  }

  yield heading('Summary');
  yield '\n';

  const width = Math.max(...[...files.keys()].map((f) => f.length), 10);
  for (const [file, stats] of files) {
    const status = stats.failed ? c.failure(symbols.fail) : c.success(symbols.pass);
    const counts = [
      stats.passed ? c.success(`${stats.passed} passed`) : null,
      stats.failed ? c.failure(`${stats.failed} failed`) : null,
      stats.skipped ? c.faint(`${stats.skipped} skipped`) : null,
    ]
      .filter(Boolean)
      .join(c.faint(', '));
    yield `  ${status} ${pad(c.text(file), width)}  ${counts}\n`;
  }

  if (diagnostics.length) {
    yield '\n';
    for (const message of diagnostics) yield `  ${c.faint(message)}\n`;
  }

  const verdict = failed
    ? c.failure(bold(`${failed} failed`))
    : c.success(bold('all passed'));
  const parts = [
    `${c.highlight(bold(String(passed)))} ${c.muted('passed')}`,
    failed ? `${c.failure(bold(String(failed)))} ${c.muted('failed')}` : null,
    skipped ? `${c.faint(`${skipped} skipped`)}` : null,
  ].filter(Boolean);

  yield `\n  ${parts.join(c.faint('  ' + symbols.bullet + '  '))}  ${c.faint(
    symbols.bullet,
  )}  ${duration(total)}\n`;
  yield `  ${verdict}\n\n`;

  void plain;
}
