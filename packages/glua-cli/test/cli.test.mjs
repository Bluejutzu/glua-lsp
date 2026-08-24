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

test('sarif output is valid enough for code scanning to ingest', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/client/cl_hot.lua':
      'hook.Add("HUDPaint", "x", function()\n\tsurface.SetMaterial(Material("a.png"))\nend)\n',
  });
  const result = run(['lint', root, '--root', root, '--format', 'sarif']);
  const sarif = JSON.parse(result.stdout);

  assert.equal(sarif.version, '2.1.0');
  const [runResult] = sarif.runs;
  assert.equal(runResult.tool.driver.name, 'glua');
  assert.ok(runResult.tool.driver.rules.length > 0);
  assert.ok(runResult.results.length > 0);

  const finding = runResult.results.find((r) => r.ruleId === 'perf-hot-path');
  assert.ok(finding, 'the hot path finding should be reported');
  assert.equal(runResult.tool.driver.rules[finding.ruleIndex].id, 'perf-hot-path');
  assert.equal(finding.level, 'warning');

  const location = finding.locations[0].physicalLocation;
  assert.equal(location.artifactLocation.uri, 'lua/autorun/client/cl_hot.lua');
  assert.ok(location.region.startLine >= 1);
  assert.ok(location.region.startColumn >= 1);
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

/* ------------------------------------------------------------------ init */

test('init writes both configs, and the schema it points at exists', { skip: !built }, () => {
  const root = addon({});
  const result = run(['init', '--root', root]);

  assert.equal(result.code, 0);
  const linter = JSON.parse(fs.readFileSync(path.join(root, '.glua.json'), 'utf8'));
  const formatter = JSON.parse(fs.readFileSync(path.join(root, '.gluafmtrc.json'), 'utf8'));

  assert.equal(linter.diagnostics.unusedLocal, 'hint');
  assert.ok(!('scope' in linter.diagnostics), 'scope is about your editor, not the team');
  assert.ok(!('enable' in linter.diagnostics));
  assert.equal(formatter.maxLineWidth, 120);

  // The $schema path is relative to a consumer's project, so check the file it
  // names is actually one we ship.
  for (const config of [linter, formatter]) {
    const shipped = path.join(ROOT, config.$schema.replace('./node_modules/glua-cli/', ''));
    assert.ok(fs.existsSync(shipped), `${config.$schema} is not shipped`);
  }
});

test('init refuses to clobber an existing config unless forced', { skip: !built }, () => {
  const root = addon({ '.glua.json': '{"globals":["ULib"]}\n' });

  const refused = run(['init', '--lint-only', '--root', root]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /already exists/);
  assert.match(fs.readFileSync(path.join(root, '.glua.json'), 'utf8'), /ULib/);

  assert.equal(run(['init', '--lint-only', '--root', root, '--force']).code, 0);
  assert.ok(!fs.readFileSync(path.join(root, '.glua.json'), 'utf8').includes('ULib'));
});

/* ------------------------------------------------------------------- fix */

test('lint --fix applies the unambiguous fixes and leaves the rest', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/server/sv_a.lua': 'net.Start("msg")\nnet.Send(ply)\n\nlocal n = 0\nn += 1\nprint(n)\n',
  });

  const result = run(['lint', root, '--fix', '--no-progress']);
  const after = fs.readFileSync(path.join(root, 'lua/autorun/server/sv_a.lua'), 'utf8');

  assert.match(after, /util\.AddNetworkString\("msg"\)/, 'added the registration');
  assert.match(after, /n = n \+ 1/, 'rewrote the compound assignment');
  assert.doesNotMatch(after, /net\.Receive/, 'a handler stub is not an unambiguous fix');
  assert.match(result.stdout, /fixed 2/);
});

test('lint --fix still fails when something unfixable is left', { skip: !built }, () => {
  // Fixing must not turn a failing build green: the parse error survives, so
  // the command has to keep saying so.
  const root = addon({ 'lua/autorun/sh_broken.lua': 'local n = 0\nn += 1\nlocal x = \n' });

  const result = run(['lint', root, '--fix', '--no-progress']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(
    fs.readFileSync(path.join(root, 'lua/autorun/sh_broken.lua'), 'utf8'),
    /n = n \+ 1/,
    'the fixable part is still applied',
  );
});

test('lint --fix exits 0 when only warnings are left, unless capped', { skip: !built }, () => {
  // UnknownThing is a warning that no fix can settle; the += is fixed.
  const root = addon({ 'lua/autorun/sh_warn.lua': 'local n = 0\nn += 1\nUnknownThing(n)\n' });

  assert.equal(run(['lint', root, '--fix', '--no-progress']).code, 0, 'warnings alone do not fail');
  assert.equal(run(['lint', root, '--fix', '--no-progress', '--max-warnings', '0']).code, 1);
});

test('lint --fix does not write a fix twice', { skip: !built }, () => {
  // Two unregistered sends of the same message each ask for the same insertion
  // at the top of the file.
  const root = addon({
    'lua/autorun/server/sv_dup.lua':
      'net.Start("msg")\nnet.Send(ply)\nnet.Start("msg")\nnet.Send(ply)\n',
  });

  run(['lint', root, '--fix', '--no-progress']);
  const after = fs.readFileSync(path.join(root, 'lua/autorun/server/sv_dup.lua'), 'utf8');
  const added = [...after.matchAll(/util\.AddNetworkString\("msg"\)/g)];
  assert.equal(added.length, 1, `wrote it ${added.length} times:\n${after}`);
});

test('lint --fix-dry-run changes nothing on disk', { skip: !built }, () => {
  const before = 'local n = 0\nn += 1\nprint(n)\n';
  const root = addon({ 'lua/autorun/sh_b.lua': before });

  const result = run(['lint', root, '--fix-dry-run', '--no-progress']);
  assert.match(result.stdout, /would fix 1/);
  assert.equal(fs.readFileSync(path.join(root, 'lua/autorun/sh_b.lua'), 'utf8'), before);
});

/* ---------------------------------------------------------------- doctor */

test('doctor reports on the project named, not the working directory', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/server/sv_a.lua': 'util.AddNetworkString("m")\nnet.Start("m")\nnet.Send(ply)\n',
    'lua/entities/turret/shared.lua': 'function ENT:Boom()\nend\n',
  });

  const result = run(['doctor', root, '--format', 'json', '--no-progress']);
  assert.equal(result.code, 0);

  const report = JSON.parse(result.stdout);
  assert.equal(report.files, 2, 'the two files in the addon, not this repo');
  assert.equal(report.entities.total, 1);
  assert.equal(report.net.registered, 1);
  assert.deepEqual(report.net.unhandled, ['m'], 'nothing receives it');
});

test('doctor writes html to a file', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_a.lua': 'print(1)\n' });
  const out = path.join(root, 'report.html');

  const result = run(['doctor', root, '--format', 'html', '--out', out]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /wrote/);

  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<title>/);
  assert.match(html, /findings/);
  assert.doesNotMatch(html, /<script/, 'the page runs nothing');
});

test('doctor can fail a build on too many findings', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_a.lua': 'net.Start("never_registered")\n' });

  assert.equal(run(['doctor', root, '--no-progress']).code, 0, 'no limit, no failure');
  assert.equal(run(['doctor', root, '--max-findings', '0', '--no-progress']).code, 1);
});

/* ----------------------------------------------------------------- rules */

test('rules lists codes alongside their settings keys', { skip: !built }, () => {
  const result = run(['rules']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /net-payload-mismatch\s+netReadWriteMismatch/);
  assert.match(result.stdout, /unused-local\s+unusedLocal/);
});
