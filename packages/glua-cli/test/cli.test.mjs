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

/** Runs the CLI and returns stdout, stderr and the exit code, never throwing. */
function run(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      ...options,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (error) {
    return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.status ?? 1 };
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

test('pretty output shows the offending line with the span underlined', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const stdout = run(['lint', root, '--root', root]).stdout;

  assert.match(stdout, /2 \u2502 x \+= 1/, `no source line in:\n${stdout}`);
  assert.match(stdout, /\u2502\s+\u2500+/, 'the span should be underlined');
  assert.match(stdout, /1 \u2502 local x = 1/, 'one line of context above');
});

test('--no-code-frames goes back to one line per finding', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const stdout = run(['lint', root, '--root', root, '--no-code-frames']).stdout;

  assert.match(stdout, /compound-assignment/);
  assert.doesNotMatch(stdout, /\u2502/, `a frame slipped through:\n${stdout}`);
});

test('a run of nothing but hints does not claim there are no problems', { skip: !built }, () => {
  // unused-local is a hint by default. Reporting it and then saying "no
  // problems" in the same breath is the summary contradicting the findings.
  const root = addon({ 'lua/autorun/sh_hint.lua': 'local unused = 1\nprint("hi")\n' });
  const result = run(['lint', root, '--root', root]);

  assert.match(result.stdout, /unused-local/);
  assert.doesNotMatch(result.stdout, /no problems/, result.stdout);
  assert.match(result.stdout, /1 suggestion\b/);
  assert.equal(result.code, 0, 'a hint is still not a failure');
});

test('--timing reports the phases and the slowest files', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ok.lua': 'print("hi")\n' });
  const stdout = run(['lint', root, '--root', root, '--timing']).stdout;

  assert.match(stdout, /Timing/);
  assert.match(stdout, /index\s+\d+ms/);
  assert.match(stdout, /check\s+\d+ms/);
  assert.match(stdout, /total\s+\d+ms/);
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
    assert.equal(finding.url, `https://glua.bluejutzu.dev/reference/rules#${finding.code}`);
  }
});

test('sarif points every rule at its own section', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const parsed = JSON.parse(run(['lint', root, '--root', root, '--format', 'sarif']).stdout);
  const rules = parsed.runs[0].tool.driver.rules;

  assert.ok(rules.length > 10, 'the catalogue should carry every rule');
  for (const rule of rules) {
    assert.equal(rule.helpUri, `https://glua.bluejutzu.dev/reference/rules#${rule.id}`);
  }
});

test('a baseline accepts today\'s findings and still reports new ones', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/sh_legacy.lua': 'local a = 1\nlocal b = 2\nprint("hi")\n',
  });

  // Before: two unused locals.
  assert.match(run(['lint', root, '--root', root]).stdout, /unused-local/);

  const wrote = run(['lint', root, '--root', root, '--suppress-all']);
  assert.equal(wrote.code, 0, 'writing a baseline is bookkeeping, not a verdict');
  assert.match(wrote.stdout, /\.glua-baseline\.json/);

  const baseline = JSON.parse(fs.readFileSync(path.join(root, '.glua-baseline.json'), 'utf8'));
  assert.equal(baseline.files['lua/autorun/sh_legacy.lua']['unused-local'], 2);

  // After: silence.
  const quiet = run(['lint', root, '--root', root]);
  assert.doesNotMatch(quiet.stdout, /unused-local/);
  assert.match(quiet.stdout, /accepted by \.glua-baseline\.json/);

  // A third one is new code, and is reported.
  fs.appendFileSync(path.join(root, 'lua/autorun/sh_legacy.lua'), 'local c = 3\n');
  assert.match(run(['lint', root, '--root', root]).stdout, /'c' is never read/);

  // And the backlog is still visible on demand.
  assert.match(run(['lint', root, '--root', root, '--ignore-baseline']).stdout, /'a' is never read/);
});

test('a baseline that has drifted is reported and pruned', { skip: !built }, () => {
  const file = 'lua/autorun/sh_drift.lua';
  const root = addon({ [file]: 'local a = 1\nlocal b = 2\nprint("hi")\n' });
  run(['lint', root, '--root', root, '--suppress-all']);

  // Fix one of the two.
  fs.writeFileSync(path.join(root, file), 'local a = 1\nprint("hi")\n');
  assert.match(run(['lint', root, '--root', root]).stdout, /--prune-suppressions/);

  assert.equal(run(['lint', root, '--root', root, '--prune-suppressions']).code, 0);
  const pruned = JSON.parse(fs.readFileSync(path.join(root, '.glua-baseline.json'), 'utf8'));
  assert.equal(pruned.files[file]['unused-local'], 1);
  assert.doesNotMatch(run(['lint', root, '--root', root]).stdout, /--prune-suppressions/);
});

test('a baseline cannot be written and applied in the same pass', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_x.lua': 'local x = 1\nx += 1\nprint(x)\n' });
  const result = run(['lint', root, '--root', root, '--suppress-all', '--fix']);
  assert.equal(result.code, 2);
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

test('workspace.exclude in .glua.json keeps matching files out of lint', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/sh_ok.lua': 'print("hi")\n',
    'lua/vendor/sh_bad.lua': 'local x = 1\nx += 1\nprint(x)\n',
    '.glua.json': JSON.stringify({ workspace: { exclude: ['vendor'] } }),
  });
  const result = run(['lint', root, '--root', root]);
  assert.equal(result.code, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /compound-assignment/);
});

test('workspace.exclude supports glob patterns, not just bare names', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/sh_ok.lua': 'print("hi")\n',
    'lua/generated/sh_bad.generated.lua': 'local x = 1\nx += 1\nprint(x)\n',
    '.glua.json': JSON.stringify({ workspace: { exclude: ['**/*.generated.lua'] } }),
  });
  const result = run(['lint', root, '--root', root]);
  assert.equal(result.code, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /compound-assignment/);
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

  // $schema points at the copy Mintlify serves from docs/schemas, so check
  // that copy is actually the one we ship.
  const DOCS_SCHEMAS = path.join(ROOT, '..', '..', 'docs', 'schemas');
  for (const config of [linter, formatter]) {
    assert.match(config.$schema, /^https:\/\/glua\.bluejutzu\.dev\/schemas\/[\w.-]+\.json$/);
    const shipped = path.join(DOCS_SCHEMAS, path.basename(config.$schema));
    assert.ok(fs.existsSync(shipped), `${config.$schema} is not shipped in docs/schemas`);
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

/* ----------------------------------------------------------------- cache */

/** A project big enough that indexing it is the bulk of a run. */
function cacheAddon() {
  const files = {
    'lua/autorun/server/sv_net.lua':
      'util.AddNetworkString("sync")\nnet.Start("sync")\nnet.Send(ply)\n',
    'lua/autorun/client/cl_net.lua': 'net.Receive("sync", function() end)\n',
    'lua/autorun/sh_lib.lua': 'MyAddon = MyAddon or {}\n\nfunction MyAddon.Go()\n\tprint("go")\nend\n',
    'lua/autorun/sh_use.lua': 'MyAddon.Go()\nUnknownThing()\n',
  };
  return { root: addon(files), files };
}

test('a second run reads the facts back instead of parsing again', { skip: !built }, () => {
  const { root } = cacheAddon();

  const cold = run(['lint', root, '--root', root, '--timing', '--no-code-frames']);
  assert.match(cold.stdout, /cache\s+0\/\d+/, cold.stdout);
  assert.ok(fs.existsSync(path.join(root, '.glua-cache', 'facts.json')), 'nothing was written');

  const warm = run(['lint', root, '--root', root, '--timing', '--no-code-frames']);
  assert.match(warm.stdout, /cache\s+(\d+)\/\1\b/, `not every file hit:\n${warm.stdout}`);
});

test('a warm run reports exactly what a cold run reported', { skip: !built }, () => {
  // The whole idea rests on this. Facts are cached; findings are recomputed
  // from all of them, including the cross-file ones that depend on files other
  // than the one they are reported against.
  const { root } = cacheAddon();

  const cold = run(['lint', root, '--root', root, '--format', 'json']);
  const warm = run(['lint', root, '--root', root, '--format', 'json']);

  assert.deepEqual(JSON.parse(warm.stdout), JSON.parse(cold.stdout));
  assert.ok(JSON.parse(cold.stdout).length > 0, 'the fixture should find something');
});

test('editing a file invalidates that file and nothing else', { skip: !built }, () => {
  const { root } = cacheAddon();
  run(['lint', root, '--root', root]);

  // Removing the registration is a change one file makes and another file's
  // finding depends on, so a stale cache would keep reporting the old answer.
  fs.writeFileSync(path.join(root, 'lua/autorun/server/sv_net.lua'),
    'net.Start("sync")\nnet.Send(ply)\n');

  const after = run(['lint', root, '--root', root, '--timing', '--no-code-frames']);
  assert.match(after.stdout, /net-unregistered/, 'the new finding must appear');
  assert.match(after.stdout, /cache\s+3\/4/, `wrong files were reused:\n${after.stdout}`);
});

test('--no-cache neither reads nor writes', { skip: !built }, () => {
  const { root } = cacheAddon();
  const result = run(['lint', root, '--root', root, '--no-cache', '--timing', '--no-code-frames']);

  assert.doesNotMatch(result.stdout, /cache\s+[1-9]/, result.stdout);
  assert.ok(!fs.existsSync(path.join(root, '.glua-cache')), 'it wrote a cache anyway');
});

test('the cache directory keeps itself out of the repository', { skip: !built }, () => {
  const { root } = cacheAddon();
  run(['lint', root, '--root', root]);
  assert.equal(fs.readFileSync(path.join(root, '.glua-cache', '.gitignore'), 'utf8'), '*\n');
});

test('formatting does not empty the cache linting filled', { skip: !built }, () => {
  // `glua fmt` indexes nothing, and saving prunes what a run did not look at.
  const { root } = cacheAddon();
  run(['lint', root, '--root', root]);
  const before = fs.readFileSync(path.join(root, '.glua-cache', 'facts.json'), 'utf8');

  run(['fmt', root, '--root', root]);

  assert.equal(fs.readFileSync(path.join(root, '.glua-cache', 'facts.json'), 'utf8'), before);
  assert.match(
    run(['lint', root, '--root', root, '--timing', '--no-code-frames']).stdout,
    /cache\s+(\d+)\/\1\b/,
  );
});

test('a corrupt cache is a miss, not a failure', { skip: !built }, () => {
  const { root } = cacheAddon();
  run(['lint', root, '--root', root]);
  fs.writeFileSync(path.join(root, '.glua-cache', 'facts.json'), '{ not json');

  const result = run(['lint', root, '--root', root, '--timing', '--no-code-frames']);
  assert.match(result.stdout, /cache\s+0\/\d+/, 'it should have started over');
  assert.match(result.stdout, /Summary/, result.stdout);
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

test('lint --fix leaves the fixes that change behaviour alone', { skip: !built }, () => {
  // Hoisting the Material call out of HUDPaint is almost certainly right, but it
  // moves when the call runs, and --fix writes files nobody is watching.
  const before =
    'hook.Add("HUDPaint", "demo", function()\n\tlocal mat = Material("icon16/heart.png")\n\tsurface.SetMaterial(mat)\nend)\n';
  const root = addon({ 'lua/autorun/client/cl_hud.lua': before });

  const result = run(['lint', root, '--fix', '--no-progress']);
  assert.equal(fs.readFileSync(path.join(root, 'lua/autorun/client/cl_hud.lua'), 'utf8'), before);
  assert.match(result.stdout, /1 unsafe fix available/);
});

test('lint --fix --unsafe-fixes applies them', { skip: !built }, () => {
  const root = addon({
    'lua/autorun/client/cl_hud.lua':
      'hook.Add("HUDPaint", "demo", function()\n\tlocal mat = Material("icon16/heart.png")\n\tsurface.SetMaterial(mat)\nend)\n',
  });

  const result = run(['lint', root, '--fix', '--unsafe-fixes', '--no-progress']);
  const after = fs.readFileSync(path.join(root, 'lua/autorun/client/cl_hud.lua'), 'utf8');

  assert.match(after.split('\n')[0], /^local \w+ = Material\("icon16\/heart\.png"\)$/, after);
  assert.match(result.stdout, /fixed 1/);
  assert.doesNotMatch(result.stdout, /unsafe fix/, 'nothing is being held back any more');
});

test('lint --unsafe-fixes without --fix says so rather than doing nothing', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ok.lua': 'print("hi")\n' });
  assert.equal(run(['lint', root, '--root', root, '--unsafe-fixes']).code, 2);
});

test('lint --fix-dry-run changes nothing on disk', { skip: !built }, () => {
  const before = 'local n = 0\nn += 1\nprint(n)\n';
  const root = addon({ 'lua/autorun/sh_b.lua': before });

  const result = run(['lint', root, '--fix-dry-run', '--no-progress']);
  assert.match(result.stdout, /would fix 1/);
  assert.equal(fs.readFileSync(path.join(root, 'lua/autorun/sh_b.lua'), 'utf8'), before);
});

/* ----------------------------------------------------------------- stdin */

test('--stdin-filepath lints text from stdin at a virtual path', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ok.lua': 'print("hi")\n' });

  const result = run(
    ['lint', '--root', root, '--stdin-filepath', 'lua/autorun/sh_virtual.lua', '--no-progress'],
    { input: 'local x = 1\nx += 1\nprint(x)\n' },
  );

  assert.match(result.stdout, /sh_virtual\.lua/);
  assert.match(result.stdout, /compound-assignment/);
  assert.equal(result.code, 1);
  assert.ok(
    !fs.existsSync(path.join(root, 'lua/autorun/sh_virtual.lua')),
    'nothing should have been written to disk',
  );
});

test('--stdin-filepath quotes the buffer, not whatever is saved on disk', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_a.lua': 'local n = 0\nn += 1\nprint(n)\n' });

  const result = run(
    ['lint', '--root', root, '--stdin-filepath', path.join(root, 'lua/autorun/sh_a.lua'), '--no-progress'],
    { input: 'local n = 0\nn += 2\nprint(n)\n' },
  );

  assert.match(result.stdout, /n \+= 2/, `expected the stdin content quoted:\n${result.stdout}`);
});

test('--stdin-filepath cannot be combined with --fix', { skip: !built }, () => {
  const root = addon({ 'lua/autorun/sh_ok.lua': 'print("hi")\n' });
  const result = run(
    ['lint', '--root', root, '--stdin-filepath', 'lua/autorun/sh_virtual.lua', '--fix'],
    { input: 'print("hi")\n' },
  );
  assert.equal(result.code, 2);
});

/* --------------------------------------------------------------- explain */

test('explain describes a rule by its diagnostic code', { skip: !built }, () => {
  const result = run(['explain', 'perf-hot-path']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /perf-hot-path/);
  assert.match(result.stdout, /perfHotPath/);
  assert.match(result.stdout, /reference\/rules#perf-hot-path/);
});

test('explain given a settings key points at the code instead', { skip: !built }, () => {
  const result = run(['explain', 'unusedLocal']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unused-local/);
});

test('explain given a settings key shared by several codes lists all of them', { skip: !built }, () => {
  // netMessage alone controls four diagnostics; naming just one would be as
  // misleading as the settings-key mistake this is meant to correct.
  const result = run(['explain', 'netMessage']);
  assert.equal(result.code, 2);
  for (const code of ['net-unregistered', 'net-never-dispatched', 'net-never-received', 'net-never-sent']) {
    assert.match(result.stderr, new RegExp(code), `expected ${code} in:\n${result.stderr}`);
  }
});

test('explain given nonsense fails without a settings-key match', { skip: !built }, () => {
  const result = run(['explain', 'not-a-real-rule']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No rule called/);
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
