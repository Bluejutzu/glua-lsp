import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUT } from './fixtures.mjs';

const { parse } = await import(OUT('parser/parser.js'));
const { formatDocument } = await import(OUT('format/printer.js'));
const { DEFAULT_FORMAT_OPTIONS } = await import(OUT('format/options.js'));

const format = (source, overrides = {}) =>
  formatDocument(source, parse(source), { ...DEFAULT_FORMAT_OPTIONS, ...overrides });

/** AST with positions stripped, for comparing meaning rather than layout. */
function shape(node) {
  if (Array.isArray(node)) return node.map(shape);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'argsStart') continue;
    out[key] = shape(value);
  }
  return out;
}

/** The three properties that make a formatter safe to run on someone's code. */
function assertSafe(source, overrides = {}) {
  const once = format(source, overrides);
  assert.ok(once !== null, 'expected the source to format');

  const twice = format(once, overrides);
  assert.equal(twice, once, 'formatting is not idempotent');

  assert.deepEqual(
    shape(parse(once).chunk),
    shape(parse(source).chunk),
    'formatting changed the meaning of the code',
  );

  const before = parse(source).comments.map((c) => c.text.trim());
  const after = parse(once).comments.map((c) => c.text.trim());
  for (const comment of before) {
    assert.ok(after.includes(comment), `comment was lost: ${JSON.stringify(comment)}`);
  }

  return once;
}

/* -------------------------------------------------------------- basics */

test('normalises indentation and spacing', () => {
  const out = assertSafe(`
local   x=1
if x>0    then
print(   x )
end
`);
  assert.equal(
    out,
    'local x = 1\n' +
      'if x > 0 then\n' +
      '\tprint(x)\n' +
      'end\n',
  );
});

test('respects the editor asking for spaces', () => {
  const out = assertSafe('if true then\nprint(1)\nend\n', { useTabs: false, indentSize: 2 });
  assert.match(out, /\n {2}print\(1\)\n/);
});

test('keeps parentheses that change meaning', () => {
  const out = assertSafe('local y = (1 + 2) * 3\nlocal a, b = (f())\n');
  assert.match(out, /\(1 \+ 2\) \* 3/);
  assert.match(out, /local a, b = \(f\(\)\)/);
});

test('does not reformat a file that fails to parse', () => {
  assert.equal(format('if true then\nlocal x = \n'), null);
  assert.equal(format('local = = ='), null);
});

/* ------------------------------------------------------------ comments */

test('keeps leading, trailing and standalone comments', () => {
  const out = assertSafe(`
-- a header comment

-- describes the local
local x = 1 -- trailing
-- dangling at the end
`);
  assert.match(out, /^-- a header comment/);
  assert.match(out, /local x = 1 -- trailing/);
  assert.match(out, /-- dangling at the end/);
});

test('keeps comments inside a table', () => {
  const out = assertSafe(`
local config = {
    -- whether the thing is on
    enabled = true, -- default
    speed = 5,
}
`);
  assert.match(out, /-- whether the thing is on/);
  assert.match(out, /enabled = true, -- default/);
});

test('keeps comments inside a callback body', () => {
  assertSafe(`
hook.Add("Think", "x", function()
    -- inside the callback
    doThing() -- and trailing
end)
`);
});

test('falls back to the original text rather than dropping an awkward comment', () => {
  const source = 'local x = f(--[[ inline ]] 1, 2)\n';
  const out = assertSafe(source);
  assert.match(out, /inline/);
});

test('preserves GLua comment styles by default', () => {
  const out = assertSafe('// c style\nlocal x = 1\n/* block */\nlocal y = 2\n');
  assert.match(out, /\/\/ c style/);
  assert.match(out, /\/\* block \*\//);
});

test('converts comment styles when asked', () => {
  const out = format('// c style\nlocal x = 1\n', { commentStyle: 'lua' });
  assert.match(out, /^-- c style/);
});

/* ----------------------------------------------------------- blank lines */

test('collapses runs of blank lines but keeps the separation', () => {
  const out = assertSafe('local a = 1\n\n\n\n\n\nlocal b = 2\n');
  assert.equal(out, 'local a = 1\n\n\nlocal b = 2\n');
});

test('respects a lower blank line limit', () => {
  const out = format('local a = 1\n\n\n\nlocal b = 2\n', { maxBlankLines: 1 });
  assert.equal(out, 'local a = 1\n\nlocal b = 2\n');
});

/* -------------------------------------------------------------- layout */

test('breaks a long table across lines', () => {
  const out = assertSafe(
    `local t = { alpha = 1, bravo = 2, charlie = 3, delta = 4, echo = 5, foxtrot = 6, golf = 7, hotel = 8 }\n`,
    { maxLineWidth: 60 },
  );
  assert.match(out, /\{\n/);
  assert.match(out, /\n\talpha = 1,/);
  assert.match(out, /\n\}/);
});

test('keeps a short table on one line', () => {
  const out = assertSafe('local t = {a = 1, b = 2}\n');
  assert.equal(out, 'local t = { a = 1, b = 2 }\n');
});

test('lets a trailing callback expand without breaking the call', () => {
  const out = assertSafe(`
hook.Add("PlayerSpawn", "some.identifier", function(ply)
    ply:SetHealth(100)
end)
`);
  assert.match(out, /hook\.Add\("PlayerSpawn", "some\.identifier", function\(ply\)\n/);
  assert.match(out, /\n\tply:SetHealth\(100\)\n/);
  assert.match(out, /\nend\)\n/);
});

test('formats every statement kind without changing meaning', () => {
  assertSafe(`
local a, b = 1, 2
a = a + 1
do local c = 3 print(c) end
while a < 10 do a = a + 1 end
repeat a = a - 1 until a == 0
for i = 1, 10, 2 do print(i) end
for k, v in pairs({}) do print(k, v) end
if a then print(1) elseif b then print(2) else print(3) end
function foo.bar:baz(x, ...) return x end
local function qux() return end
while true do break end
for i = 1, 3 do if i == 2 then continue end end
::top::
goto top
`);
});

/* -------------------------------------------------------------- options */

test('rewrites C-style operators when asked, and not otherwise', () => {
  const source = 'if a != b && c || !d then print(1) end\n';
  assert.match(assertSafe(source), /a != b && c \|\| !d/);

  const converted = format(source, { operatorStyle: 'lua' });
  assert.match(converted, /a ~= b and c or not d/);
  // The rewrite must mean the same thing. `operatorText` is expected to differ
  // — that is the whole point — so compare on the resolved operator only.
  const withoutSpelling = (node) =>
    JSON.parse(JSON.stringify(shape(node), (key, value) => (key === 'operatorText' ? undefined : value)));
  assert.deepEqual(withoutSpelling(parse(converted).chunk), withoutSpelling(parse(source).chunk));
});

test('normalises quotes only when no new escaping is needed', () => {
  const out = format(`local a = 'plain'\nlocal b = 'has "quotes"'\n`, { quoteStyle: 'double' });
  assert.match(out, /local a = "plain"/);
  assert.match(out, /local b = 'has "quotes"'/, 'must not force extra escapes');
});

test('supports the wiki spacing style', () => {
  const out = assertSafe('print(1, 2)\n', { spaceInsideParens: true });
  assert.equal(out, 'print( 1, 2 )\n');
});

test('drops optional semicolons by default and keeps them when asked', () => {
  assert.equal(assertSafe('local x = 1;\n'), 'local x = 1\n');
  assert.equal(format('local x = 1;\n', { semicolons: 'preserve' }), 'local x = 1;\n');
});

test('uses the line endings the file already had', () => {
  const out = format('local a = 1\r\nlocal b = 2\r\n', { endOfLine: '\r\n' });
  assert.ok(out.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
});

/* ------------------------------------------------------------- realism */

test('leaves already-formatted realistic code untouched', () => {
  const source = [
    'local PLUGIN = {}',
    '',
    '--- Gives a player their loadout.',
    '---@param ply Player',
    'function PLUGIN:GiveLoadout(ply)',
    '\tif not IsValid(ply) then return end',
    '',
    '\tfor _, class in ipairs(self.Weapons) do',
    '\t\tply:Give(class)',
    '\tend',
    'end',
    '',
    'hook.Add("PlayerSpawn", "PLUGIN.Loadout", function(ply)',
    '\tPLUGIN:GiveLoadout(ply)',
    'end)',
    '',
  ].join('\n');

  assert.equal(assertSafe(source), source);
});
