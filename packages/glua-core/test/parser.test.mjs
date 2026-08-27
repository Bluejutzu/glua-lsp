import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUT } from './fixtures.mjs';

const { parse } = await import(OUT('parser/parser.js'));
const { nodePathAt } = await import(OUT('parser/ast.js'));

test('parses Lua 5.1 basics without errors', () => {
  const { errors } = parse(`
    local t = { a = 1, [2] = "x", 3 }
    local function f(a, b, ...) return a + b end
    for i = 1, 10, 2 do print(i) end
    for k, v in pairs(t) do print(k, v) end
    while true do break end
    repeat local x = 1 until x
    if a then elseif b then else end
    local s = [==[ long
    string ]==]
  `);
  assert.deepEqual(errors, []);
});

test('accepts GLua C-style operators, comments and continue', () => {
  const { errors, chunk } = parse(`
    // a C-style comment
    /* a block comment */
    local a = 1
    if a != 2 && a > 0 || !false then
      for i = 1, 3 do
        if i == 2 then continue end
      end
    end
  `);
  assert.deepEqual(errors, []);
  assert.equal(chunk.body.length, 2);
});

test('preserves how an operator was spelled, so it can be rewritten', () => {
  const { chunk } = parse('local x = a != b');
  const expr = chunk.body[0].init[0];
  assert.equal(expr.operator, '~=');
  assert.equal(expr.operatorText, '!=');
});

test('recovers from an unfinished member access and keeps the node', () => {
  const source = 'local ply = nil\nply:\n';
  const { chunk, errors } = parse(source);
  assert.ok(errors.length > 0, 'expected the incomplete access to be reported');

  const offset = source.indexOf('ply:') + 4;
  const path = nodePathAt(chunk, offset);
  const member = path.find((n) => n.type === 'MemberExpression');
  assert.ok(member, 'a MemberExpression should survive the recovery');
  assert.equal(member.indexer, ':');
  assert.equal(member.identifier.missing, true);
  assert.equal(member.base.name, 'ply');
});

test('recovers from an unfinished call and still records the arguments', () => {
  const source = 'net.Start("hello"\n';
  const { chunk } = parse(source);
  const statement = chunk.body[0];
  const call = statement.expression;
  assert.equal(call.type, 'CallExpression');
  assert.equal(call.unclosed, true);
  assert.equal(call.args.length, 1);
  assert.equal(call.args[0].value, 'hello');
});

test('an unterminated block does not swallow the rest of the file', () => {
  const { chunk, errors } = parse('if true then\n  local a = 1\n');
  assert.ok(errors.some((e) => e.message.includes("Missing 'end'")));
  assert.equal(chunk.body.length, 1);
});

test('never loops forever on garbage input', () => {
  const inputs = ['@@@@', 'local = = =', 'function ((((', ')))]]]', '"unterminated', '--[[ unclosed'];
  for (const input of inputs) {
    const { chunk } = parse(input);
    assert.ok(chunk, `parse should return a chunk for ${JSON.stringify(input)}`);
  }
});

test('operator precedence follows Lua, including right-associative ^ and ..', () => {
  const { chunk } = parse('local x = 1 + 2 * 3 ^ 2 ^ 3 .. "a"');
  const root = chunk.body[0].init[0];
  // `..` binds loosest here, so it must be the root.
  assert.equal(root.operator, '..');
  assert.equal(root.left.operator, '+');
  const power = root.left.right.right;
  assert.equal(power.operator, '^');
  assert.equal(power.right.operator, '^', '^ must be right-associative');
});

test('method calls and chained suffixes parse into the right shape', () => {
  const { chunk, errors } = parse('a.b.c:d(1)[2].e = 3');
  assert.deepEqual(errors, []);
  const target = chunk.body[0].targets[0];
  assert.equal(target.type, 'MemberExpression');
  assert.equal(target.identifier.name, 'e');
  assert.equal(target.base.type, 'IndexExpression');
});

test('flags compound assignment with a useful message', () => {
  const { errors, chunk } = parse('x += 1');
  assert.ok(errors.some((e) => e.message.includes('Compound assignment')));
  assert.equal(chunk.body[0].compoundOperator, '+');
});
