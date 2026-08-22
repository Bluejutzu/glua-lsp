// Exercises the built CLI end to end, since the parts that break in a CLI are
// argument handling, exit codes and output shape — none of which the library
// tests touch.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'glua.js');

const built = fs.existsSync(CLI);

/** Runs the CLI and returns stdout plus the exit code, never throwing. */
function run(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      ...options,
    });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: String(error.stdout ?? ''), code: error.status ?? 1 };
  }
}

/** A throwaway addon directory. */
function addon(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glua-cli-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

test('the CLI is built', () => {
  assert.ok(built, 'run `pnpm run build` in packages/glua-cli first');
});

test('reports a version and a usage summary', { skip: !built }, () => {
  assert.match(run(['--version']).stdout, /\d+\.\d+\.\d+/);
  assert.match(run(['--help']).stdout, /Lint and format/);
});

test('lint exits 0 on clean code', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/sh_ok.lua': 'local function greet(name)\n\treturn "hi " .. name\nend\n\nprint(greet("world"))\n',
  });
  const result = run(['lint', root, '--root', root]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /no problems/);
});

test('lint exits 1 when there is an error', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const result = run(['lint', root, '--root', root]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /compound-assignment/);
});

test('--quiet hides warnings but still fails on errors', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_mixed.lua': 'local unused = 1\nlocal y = 2\ny += 1\nprint(y)\n' });
  const noisy = run(['lint', root, '--root', root]);
  const quiet = run(['lint', root, '--root', root, '--quiet']);
  assert.match(noisy.stdout, /unused-local/);
  assert.doesNotMatch(quiet.stdout, /unused-local/);
  assert.equal(quiet.code, 1);
});

test('--max-warnings fails once the limit is passed', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/server/sv_net.lua': 'net.Start("nope")\nnet.Broadcast()\n',
  });
  assert.equal(run(['lint', root, '--root', root, '--max-warnings', '99']).code, 0);
  assert.equal(run(['lint', root, '--root', root, '--max-warnings', '0']).code, 1);
});

test('json output is machine readable', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const result = run(['lint', root, '--root', root, '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length > 0);
  for (const finding of parsed) {
    assert.ok(typeof finding.file === 'string');
    assert.ok(Number.isInteger(finding.line));
    assert.ok(typeof finding.code === 'string');
    assert.ok(typeof finding.message === 'string');
  }
});

test('github output uses annotation syntax and never wraps lines', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const result = run(['lint', root, '--root', root, '--format', 'github']);
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^::(error|warning|notice) file=[^,]+,line=\d+,col=\d+,title=glua\([a-z-]+\)::/);
  }
});

test('a config file changes what is reported', { skip: !built }, () => {
  const files = { 'lua/autorun/sh_unused.lua': 'local unused = 1\nprint("hi")\n' };
  const withRule = addon(files);
  assert.match(run(['lint', withRule, '--root', withRule]).stdout, /unused-local/);

  const withoutRule = addon({
    ...files,
    '.glua.json': JSON.stringify({ diagnostics: { unusedLocal: 'off' } }),
  });
  assert.doesNotMatch(run(['lint', withoutRule, '--root', withoutRule]).stdout, /unused-local/);
});

test('declared globals suppress undefined-global', { skip: !built }, () => {
  const source = { 'lua/autorun/sh_ext.lua': 'ULib.doThing()\n' };
  const bare = addon(source);
  assert.match(run(['lint', bare, '--root', bare]).stdout, /undefined-global/);

  const declared = addon({ ...source, '.glua.json': JSON.stringify({ globals: ['ULib'] }) });
  assert.doesNotMatch(run(['lint', declared, '--root', declared]).stdout, /undefined-global/);
});

/* ------------------------------------------------------------------- fmt */

test('fmt reports what would change without writing', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ugly.lua': 'local   x=1\nprint( x )\n' });
  const file = path.join(root, 'lua/autorun/sh_ugly.lua');
  const before = fs.readFileSync(file, 'utf8');

  const result = run(['fmt', root, '--root', root]);
  assert.equal(result.code, 1, 'should fail when something would change');
  assert.match(result.stdout, /would reformat/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'must not have written');
});

test('fmt --write applies the changes and is then a no-op', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ugly.lua': 'local   x=1\nprint( x )\n' });
  const file = path.join(root, 'lua/autorun/sh_ugly.lua');

  const first = run(['fmt', root, '--root', root, '--write']);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(fs.readFileSync(file, 'utf8'), 'local x = 1\nprint(x)\n');

  const second = run(['fmt', root, '--root', root]);
  assert.equal(second.code, 0, 'already formatted, so nothing to do');
});

test('fmt refuses to touch a file that does not parse', { skip: !built }, () => {
  const source = 'local x = \n';
  const root = addon({ 'lua/autorun/sh_broken.lua': source });
  const file = path.join(root, 'lua/autorun/sh_broken.lua');

  const result = run(['fmt', root, '--root', root, '--write']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /does not parse/);
  assert.equal(fs.readFileSync(file, 'utf8'), source, 'broken file must be left alone');
});

test('a formatter config file is honoured', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/sh_indent.lua': 'if true then\nprint(1)\nend\n',
    '.gluafmtrc.json': JSON.stringify({ useTabs: false, indentSize: 2 }),
  });
  run(['fmt', root, '--root', root, '--write']);
  const output = fs.readFileSync(path.join(root, 'lua/autorun/sh_indent.lua'), 'utf8');
  assert.match(output, /\n {2}print\(1\)\n/);
});

test('--write and --check together is an error', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_x.lua': 'print(1)\n' });
  assert.equal(run(['fmt', root, '--write', '--check']).code, 1);
});

/* ----------------------------------------------------------------- rules */

test('rules lists codes alongside their settings keys', { skip: !built }, () => {
  const result = run(['rules']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /net-payload-mismatch\s+netReadWriteMismatch/);
  assert.match(result.stdout, /unused-local\s+unusedLocal/);
});
