import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { API_DATA, OUT } from './fixtures.mjs';

const { GmodApi } = await import(OUT('api/index.js'));
const { Workspace } = await import(OUT('analyze/workspace.js'));
const { ConfigResolver, matchesGlob } = await import(OUT('config/index.js'));
const { diagnose } = await import(OUT('server/features/diagnostics.js'));
const { DEFAULT_SETTINGS } = await import(OUT('server/settings.js'));

const api = GmodApi.load(API_DATA);

/** A throwaway project directory with the given files written into it. */
function scratch(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glua-config-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

/* ---------------------------------------------------------------- globs */

test('glob matching handles **, *, ? and braces', () => {
  assert.ok(matchesGlob('lua/vendor/**', 'lua/vendor/a/b.lua'));
  assert.ok(matchesGlob('lua/vendor/**', 'lua/vendor/b.lua'), '** may match zero directories');
  assert.ok(!matchesGlob('lua/vendor/**', 'lua/mine/b.lua'));
  assert.ok(matchesGlob('*.lua', 'thing.lua'));
  assert.ok(!matchesGlob('*.lua', 'sub/thing.lua'), '* must not cross a slash');
  assert.ok(matchesGlob('{*.lua,*.glua}', 'thing.glua'));
  assert.ok(matchesGlob('sh_?.lua', 'sh_a.lua'));
});

/* ------------------------------------------------------------ lint config */

test('.glua.json changes rule severities', () => {
  const root = scratch({
    '.glua.json': JSON.stringify({ diagnostics: { unusedLocal: 'off', realmViolation: 'error' } }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const settings = config.settingsFor(path.join(root, 'lua', 'a.lua'));
  assert.equal(settings.diagnostics.unusedLocal, 'off');
  assert.equal(settings.diagnostics.realmViolation, 'error');
  // Untouched rules keep their defaults.
  assert.equal(settings.diagnostics.deprecated, DEFAULT_SETTINGS.diagnostics.deprecated);
});

test('declared globals stop the undefined-global rule firing', () => {
  const root = scratch({ '.glua.json': JSON.stringify({ globals: ['ULib', 'ulx'] }) });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const file = path.join(root, 'lua', 'autorun', 'sh_x.lua');
  const workspace = new Workspace(api, { maxFiles: 10, exclude: [] });
  const analysis = workspace.analyse(
    pathToFileURL(file).href,
    'ULib.doThing()\nSomethingElse.doThing()\n',
    1,
  );

  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS, {
    extraGlobals: config.globalsFor(file),
  }).filter((d) => d.code === 'undefined-global');

  assert.equal(found.length, 1);
  assert.match(found[0].message, /SomethingElse/);
});

test('overrides apply by path', () => {
  const root = scratch({
    '.glua.json': JSON.stringify({
      diagnostics: { unusedLocal: 'warning' },
      overrides: [{ files: ['lua/vendor/**'], diagnostics: { unusedLocal: 'off' } }],
    }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  assert.equal(config.settingsFor(path.join(root, 'lua/mine/a.lua')).diagnostics.unusedLocal, 'warning');
  assert.equal(config.settingsFor(path.join(root, 'lua/vendor/b.lua')).diagnostics.unusedLocal, 'off');
});

test('a malformed config file is reported, not thrown', () => {
  const root = scratch({ '.glua.json': '{ this is not json' });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);
  assert.equal(config.errors.length, 1);
  // Still usable, just falling back to defaults.
  assert.equal(config.settingsFor(path.join(root, 'a.lua')).diagnostics.enable, true);
});

test('config files may contain comments and trailing commas', () => {
  const root = scratch({
    '.glua.json': '{\n  // a comment\n  "globals": ["ULib",],\n}',
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);
  assert.equal(config.errors.length, 0);
  assert.ok(config.globalsFor(path.join(root, 'a.lua')).has('ULib'));
});

/* ---------------------------------------------------------- format config */

test('.gluafmtrc.json overrides editor settings', () => {
  const root = scratch({
    '.gluafmtrc.json': JSON.stringify({ useTabs: false, indentSize: 2, quoteStyle: 'single' }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const options = config.formatOptionsFor(path.join(root, 'a.lua'), {
    useTabs: true,
    indentSize: 8,
  });
  assert.equal(options.useTabs, false);
  assert.equal(options.indentSize, 2);
  assert.equal(options.quoteStyle, 'single');
});

test('.editorconfig is read when nothing more specific applies', () => {
  const root = scratch({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 2\nmax_line_length = 80\n',
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const options = config.formatOptionsFor(path.join(root, 'a.lua'));
  assert.equal(options.useTabs, false);
  assert.equal(options.indentSize, 2);
  assert.equal(options.maxLineWidth, 80);
});

test('.prettierrc maps onto the options that have a Lua equivalent', () => {
  const root = scratch({
    '.prettierrc': JSON.stringify({ useTabs: false, tabWidth: 2, printWidth: 100, singleQuote: true }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const options = config.formatOptionsFor(path.join(root, 'a.lua'));
  assert.equal(options.useTabs, false);
  assert.equal(options.indentSize, 2);
  assert.equal(options.maxLineWidth, 100);
  assert.equal(options.quoteStyle, 'single');
});

test('.gluafmtrc.json wins over .prettierrc and .editorconfig', () => {
  const root = scratch({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 2\n',
    '.prettierrc': JSON.stringify({ printWidth: 100, singleQuote: true }),
    '.gluafmtrc.json': JSON.stringify({ useTabs: true, maxLineWidth: 140, quoteStyle: 'double' }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  const options = config.formatOptionsFor(path.join(root, 'a.lua'));
  assert.equal(options.useTabs, true, 'GLua config beats .editorconfig');
  assert.equal(options.maxLineWidth, 140, 'GLua config beats .prettierrc');
  assert.equal(options.quoteStyle, 'double');
  // Anything the GLua config did not set still comes from the generic ones.
  assert.equal(options.indentSize, 2);
});

test('format overrides apply by path', () => {
  const root = scratch({
    '.gluafmtrc.json': JSON.stringify({
      maxLineWidth: 100,
      overrides: [{ files: ['lua/vendor/**'], options: { maxLineWidth: 200 } }],
    }),
  });
  const config = new ConfigResolver(DEFAULT_SETTINGS);
  config.reload([root]);

  assert.equal(config.formatOptionsFor(path.join(root, 'lua/mine/a.lua')).maxLineWidth, 100);
  assert.equal(config.formatOptionsFor(path.join(root, 'lua/vendor/b.lua')).maxLineWidth, 200);
});

/* ----------------------------------------------------------- suppressions */

function diagnoseSource(source, name = 'sh_sup.lua') {
  const workspace = new Workspace(api, { maxFiles: 10, exclude: [] });
  const file = path.join(os.tmpdir(), 'glua-sup', 'lua', 'autorun', name);
  const analysis = workspace.analyse(pathToFileURL(file).href, source, 1);
  return diagnose(analysis, api, workspace, DEFAULT_SETTINGS);
}

test('glua-ignore on its own line suppresses the next line', () => {
  const before = diagnoseSource('local unusedThing = 1\n');
  assert.ok(before.some((d) => d.code === 'unused-local'));

  const after = diagnoseSource('-- glua-ignore unused-local\nlocal unusedThing = 1\n');
  assert.equal(after.filter((d) => d.code === 'unused-local').length, 0);
});

test('a trailing glua-ignore suppresses its own line', () => {
  const found = diagnoseSource('local unusedThing = 1 -- glua-ignore unused-local\n');
  assert.equal(found.filter((d) => d.code === 'unused-local').length, 0);
});

test('glua-ignore without a rule suppresses everything on the line', () => {
  const found = diagnoseSource('-- glua-ignore\nlocal unusedThing = 1\n');
  assert.equal(found.filter((d) => d.code === 'unused-local').length, 0);
});

test('an unrelated rule is still reported', () => {
  const found = diagnoseSource('-- glua-ignore realm-violation\nlocal unusedThing = 1\n');
  assert.ok(found.some((d) => d.code === 'unused-local'));
});

test('glua-disable and glua-enable bound a region', () => {
  const found = diagnoseSource(
    [
      '-- glua-disable unused-local',
      'local a = 1',
      '-- glua-enable unused-local',
      'local b = 2',
    ].join('\n'),
  );
  const unused = found.filter((d) => d.code === 'unused-local');
  assert.equal(unused.length, 1);
  assert.equal(unused[0].range.start.line, 3);
});

test('glua-disable-file suppresses the whole file', () => {
  const found = diagnoseSource('-- glua-disable-file\nlocal a = 1\nlocal b = 2\n');
  assert.equal(found.length, 0);
});

test('prose after a rule name is ignored', () => {
  const found = diagnoseSource(
    '-- glua-ignore unused-local it is a placeholder for later\nlocal unusedThing = 1\n',
  );
  assert.equal(found.filter((d) => d.code === 'unused-local').length, 0);
});
