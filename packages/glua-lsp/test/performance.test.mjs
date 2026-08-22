import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_DATA, OUT, uriOf } from './fixtures.mjs';

const { GmodApi } = await import(OUT('api/index.js'));
const { Workspace } = await import(OUT('analyze/workspace.js'));
const { parse } = await import(OUT('parser/parser.js'));
const { completion } = await import(OUT('server/features/completion.js'));
const { diagnose } = await import(OUT('server/features/diagnostics.js'));
const { DEFAULT_SETTINGS } = await import(OUT('server/settings.js'));

const api = GmodApi.load(API_DATA);

/** A believable ~2000 line addon file. */
function bigSource(blocks) {
  const chunk = (i) => `
local cache_${i} = {}

--- Refreshes the cached entity list for bucket ${i}.
function MyAddon.Refresh${i}(force)
  if not force and cache_${i}.built then return cache_${i}.entities end

  local entities = {}
  for index, ent in ipairs(ents.FindByClass("prop_physics")) do
    if not IsValid(ent) then continue end
    if ent:GetPos():Distance(Vector(0, 0, 0)) > 4096 then continue end
    entities[#entities + 1] = {
      entity = ent,
      pos = ent:GetPos(),
      angles = ent:GetAngles(),
      model = ent:GetModel(),
    }
  end

  cache_${i}.entities = entities
  cache_${i}.built = true
  return entities
end

hook.Add("Think", "MyAddon.Tick${i}", function()
  if (CurTime() % 5) < 0.01 then
    MyAddon.Refresh${i}(true)
  end
end)
`;
  return (
    'MyAddon = MyAddon or {}\n' +
    Array.from({ length: blocks }, (_, i) => chunk(i)).join('\n')
  );
}

test('parses a large file quickly', () => {
  const source = bigSource(70);
  const lines = source.split('\n').length;

  // Warm up, then measure.
  parse(source);
  const started = performance.now();
  const iterations = 10;
  for (let i = 0; i < iterations; i++) parse(source);
  const each = (performance.now() - started) / iterations;

  console.log(`  parse: ${lines} lines in ${each.toFixed(1)}ms`);
  assert.ok(each < 80, `parsing ${lines} lines took ${each.toFixed(1)}ms, expected under 80ms`);
});

test('full analysis of a large file stays within a keystroke budget', () => {
  const source = bigSource(70);
  const workspace = new Workspace(api, { maxFiles: 100, exclude: [] });
  const uri = uriOf('lua', 'myaddon', 'sh_big.lua');

  workspace.analyse(uri, source, 1);
  const started = performance.now();
  const iterations = 10;
  for (let i = 0; i < iterations; i++) workspace.analyse(uri, source, i + 2);
  const each = (performance.now() - started) / iterations;

  console.log(`  analyse: ${each.toFixed(1)}ms`);
  assert.ok(each < 150, `analysis took ${each.toFixed(1)}ms, expected under 150ms`);
});

test('completion on a large file is fast enough to feel instant', () => {
  const source = bigSource(70) + '\nlocal e = Entity(1)\ne:';
  const workspace = new Workspace(api, { maxFiles: 100, exclude: [] });
  const uri = uriOf('lua', 'myaddon', 'sh_big2.lua');
  const analysis = workspace.analyse(uri, source, 1);
  const position = analysis.lines.positionAt(source.length);
  const deps = { api, workspace, settings: DEFAULT_SETTINGS };

  completion(analysis, position, deps);
  const started = performance.now();
  const iterations = 20;
  for (let i = 0; i < iterations; i++) completion(analysis, position, deps);
  const each = (performance.now() - started) / iterations;

  console.log(`  completion: ${each.toFixed(1)}ms`);
  assert.ok(each < 40, `completion took ${each.toFixed(1)}ms, expected under 40ms`);
});

test('diagnostics on a large file stay responsive', () => {
  const source = bigSource(70);
  const workspace = new Workspace(api, { maxFiles: 100, exclude: [] });
  const analysis = workspace.analyse(uriOf('lua', 'myaddon', 'sh_big3.lua'), source, 1);

  diagnose(analysis, api, workspace, DEFAULT_SETTINGS);
  const started = performance.now();
  const iterations = 10;
  for (let i = 0; i < iterations; i++) diagnose(analysis, api, workspace, DEFAULT_SETTINGS);
  const each = (performance.now() - started) / iterations;

  console.log(`  diagnostics: ${each.toFixed(1)}ms`);
  assert.ok(each < 100, `diagnostics took ${each.toFixed(1)}ms, expected under 100ms`);
});

test('a workspace of many files indexes in reasonable time', () => {
  const workspace = new Workspace(api, { maxFiles: 2000, exclude: [] });
  const source = bigSource(4);

  const started = performance.now();
  const files = 300;
  for (let i = 0; i < files; i++) {
    workspace.analyse(uriOf('lua', 'myaddon', `file_${i}.lua`), source, 1);
  }
  const total = performance.now() - started;

  console.log(`  index: ${files} files in ${total.toFixed(0)}ms (${(total / files).toFixed(1)}ms each)`);
  assert.equal(workspace.size, files);
  assert.ok(total < 12000, `indexing took ${total.toFixed(0)}ms`);
});

test('editing one file in a large workspace stays interactive', () => {
  // The worst case for cross-file work: every keystroke invalidates the indexes
  // that diagnostics then rebuild.
  const workspace = new Workspace(api, { maxFiles: 2000, exclude: [] });
  const source = bigSource(4);
  const files = 400;
  for (let i = 0; i < files; i++) {
    workspace.analyse(uriOf('lua', 'myaddon', `f_${i}.lua`), source, 1);
  }

  const target = uriOf('lua', 'myaddon', 'f_0.lua');
  let each = 0;
  const iterations = 20;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const edited = workspace.analyse(target, `${source}\nlocal edit_${i} = ${i}\nprint(edit_${i})\n`, i + 2);
    diagnose(edited, api, workspace, DEFAULT_SETTINGS);
  }
  each = (performance.now() - started) / iterations;

  console.log(`  edit+diagnose in ${files}-file workspace: ${each.toFixed(1)}ms`);
  assert.ok(each < 120, `edit cycle took ${each.toFixed(1)}ms, expected under 120ms`);
});
