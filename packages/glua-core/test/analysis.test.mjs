import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { API_DATA, OUT, file, uriOf } from './fixtures.mjs';

const { GmodApi } = await import(OUT('api/index.js'));
const { Workspace } = await import(OUT('analyze/workspace.js'));
const { typeToString } = await import(OUT('analyze/types.js'));
const { scriptedClassOf } = await import(OUT('analyze/entities.js'));
const { AssetIndex } = await import(OUT('analyze/assets.js'));
const { readVpkDirectory } = await import(OUT('analyze/vpk.js'));
const { buildReport } = await import(OUT('server/features/report.js'));
const { renderHtml } = await import(OUT('server/features/reportHtml.js'));
const { completion } = await import(OUT('server/features/completion.js'));
const { hover } = await import(OUT('server/features/hover.js'));
const { signatureHelp } = await import(OUT('server/features/signature.js'));
const { diagnose } = await import(OUT('server/features/diagnostics.js'));
const { definition } = await import(OUT('server/features/navigation.js'));
const { codeActions } = await import(OUT('server/features/codeActions.js'));
const {
  prepareCallHierarchy,
  incomingCalls,
  outgoingCalls,
} = await import(OUT('server/features/callHierarchy.js'));
const { DEFAULT_SETTINGS } = await import(OUT('server/settings.js'));

const api = GmodApi.load(API_DATA);

function makeWorkspace(files) {
  const workspace = new Workspace(api, { maxFiles: 1000, exclude: [] });
  const analyses = {};
  for (const [relative, text] of Object.entries(files)) {
    const segments = relative.split('/');
    analyses[relative] = workspace.analyse(uriOf(...segments), text, 1);
  }
  // Re-analyse so cross-file facts are visible to every file, not just later ones.
  for (const [relative, text] of Object.entries(files)) {
    const segments = relative.split('/');
    analyses[relative] = workspace.analyse(uriOf(...segments), text, 2);
  }
  return { workspace, analyses };
}

/** Position of the `|` marker in a fixture, with the marker stripped. */
function withCursor(text) {
  const index = text.indexOf('|');
  assert.notEqual(index, -1, 'fixture needs a | cursor marker');
  return { text: text.slice(0, index) + text.slice(index + 1), offset: index };
}

const deps = (workspace) => ({ api, workspace, settings: DEFAULT_SETTINGS });

const labels = (list) => list.items.map((item) => item.label);

/* ------------------------------------------------------------- inference */

test('infers a class from an API return type and completes its methods', () => {
  const { text, offset } = withCursor(`
local ply = player.GetByID(1)
ply:|
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/server/sv_test.lua': text });
  const analysis = analyses['lua/autorun/server/sv_test.lua'];
  const position = analysis.lines.positionAt(offset);

  const names = labels(completion(analysis, position, deps(workspace)));
  assert.ok(names.includes('SetHealth'), 'Player should expose Entity:SetHealth by inheritance');
  assert.ok(names.includes('Kick'), 'Player should expose its own Player:Kick');
  assert.ok(!names.includes('GetAll'), 'player library functions are not Player methods');
});

test('types hook.Add callback parameters from the wiki hook signature', () => {
  const { text, offset } = withCursor(`
hook.Add("PlayerSay", "test", function(sender, textInput)
  sender:|
end)
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/server/sv_hook.lua': text });
  const analysis = analyses['lua/autorun/server/sv_hook.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Nick'), 'the first PlayerSay argument should be typed as a Player');
  assert.ok(names.includes('SetHealth'));
});

test('types self inside an entity hook table', () => {
  const { text, offset } = withCursor(`
ENT.Type = "anim"
function ENT:Initialize()
  self:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/entities/my_ent/init.lua': text });
  const analysis = analyses['lua/entities/my_ent/init.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('SetModel'), 'self in an ENT method should be an Entity');
});

test('resolves the element type of ipairs over a known array-returning call', () => {
  const { text, offset } = withCursor(`
for _, ply in ipairs(player.GetAll()) do
  ply:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/server/sv_loop.lua': text });
  const analysis = analyses['lua/autorun/server/sv_loop.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Nick'), 'ipairs(player.GetAll()) should yield Players');
});

test('resolves the panel class from the vgui.Create string argument', () => {
  const { text, offset } = withCursor(`
local frame = vgui.Create("DFrame")
frame:|
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/client/cl_ui.lua': text });
  const analysis = analyses['lua/autorun/client/cl_ui.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('SetTitle'), 'DFrame:SetTitle should be offered');
  assert.ok(names.includes('SetSize'), 'inherited Panel:SetSize should be offered');
});

test('function Handler:Method() on a local table is visible via both : and . access', () => {
  const dotFixture = withCursor(`
local Handler = {}

function Handler:DoSomething(x)
  return x
end

function Handler.Static()
end

Handler.Version = 1

Handler.|
`);
  {
    const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_handler_dot.lua': dotFixture.text });
    const analysis = analyses['lua/autorun/sh_handler_dot.lua'];
    const names = labels(
      completion(analysis, analysis.lines.positionAt(dotFixture.offset), deps(workspace)),
    );
    assert.ok(names.includes('DoSomething'), 'colon-defined method should complete on Handler.');
    assert.ok(names.includes('Static'), 'dot-defined function should complete on Handler.');
    assert.ok(names.includes('Version'), 'plain field assignment should complete on Handler.');
  }

  const colonFixture = withCursor(`
local Handler = {}

function Handler:DoSomething(x)
  return x
end

Handler:|
`);
  {
    const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_handler_colon.lua': colonFixture.text });
    const analysis = analyses['lua/autorun/sh_handler_colon.lua'];
    const names = labels(
      completion(analysis, analysis.lines.positionAt(colonFixture.offset), deps(workspace)),
    );
    assert.ok(names.includes('DoSomething'), 'colon-defined method should complete on Handler:');
  }
});

test('self inside a local module method sees sibling methods defined later in the file', () => {
  const { text, offset } = withCursor(`
local Handler = {}

function Handler:First()
  self:|
end

function Handler:Second()
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_handler_self.lua': text });
  const analysis = analyses['lua/autorun/sh_handler_self.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Second'), 'self should see a sibling method defined later in the same file');
  assert.ok(names.includes('First'), 'self should see its own method');
});

test('control-structure snippets carry tab stops for their editable parts', () => {
  const { text, offset } = withCursor('|');
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_snippets.lua': text });
  const analysis = analyses['lua/autorun/sh_snippets.lua'];

  const items = completion(analysis, analysis.lines.positionAt(offset), deps(workspace)).items;
  // Several plain keywords (e.g. "function") share a label with their snippet
  // counterpart; the snippet is the one carrying an insertTextFormat.
  const byLabel = (label) => items.find((item) => item.label === label && item.insertTextFormat === 2);

  const fn = byLabel('function');
  assert.ok(fn, 'a plain function snippet should be offered');
  assert.equal(fn.insertTextFormat, 2, 'InsertTextFormat.Snippet');
  assert.match(fn.insertText, /^function \$\{1:name\}\(\$\{2:args\}\)\n\t\$0\nend$/);

  const method = byLabel('function (method)');
  assert.ok(method, 'a Table:Method() stub should be offered for OOP-style definitions');
  assert.match(method.insertText, /function \$\{1:Table\}:\$\{2:MethodName\}\(\$\{3:args\}\)\n\t\$0\nend/);

  const ifSnippet = byLabel('if');
  assert.ok(ifSnippet);
  assert.match(ifSnippet.insertText, /if \$\{1:condition\} then\n\t\$0\nend/);

  const forPairs = byLabel('for in pairs');
  assert.ok(forPairs);
  assert.match(forPairs.insertText, /for \$\{1:key\}, \$\{2:value\} in pairs\(\$\{3:tbl\}\) do/);

  const cls = byLabel('class (module table)');
  assert.ok(cls, 'the module/class boilerplate snippet should be offered');
  // Same tabstop repeated across the class name, __index and constructor lines
  // so editing it once renames every occurrence together.
  assert.equal((cls.insertText.match(/\$\{1:ClassName\}/g) ?? []).length, 6);
});

test('completion still works on the line being typed, mid-expression', () => {
  // No closing paren, no `end` — exactly the state the old extension chokes on.
  const { text, offset } = withCursor(`
hook.Add("Think", "x", function()
  local e = ents.GetByIndex(1)
  if IsValid(e) and e:|
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_partial.lua': text });
  const analysis = analyses['lua/autorun/sh_partial.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('GetPos'), 'the Entity type must survive an unfinished expression');
});

/* ------------------------------------------------------------ workspace */

test('completes globals defined in another file', () => {
  const { text, offset } = withCursor(`
MyAddon.|
`);
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_config.lua': 'MyAddon = MyAddon or {}\nMyAddon.Version = "1.0"\nfunction MyAddon.Reload() end\n',
    'lua/myaddon/sv_main.lua': text,
  });
  const analysis = analyses['lua/myaddon/sv_main.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Version'));
  assert.ok(names.includes('Reload'));
});

test('go to definition crosses files for a workspace global', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_config.lua': 'MyAddon = {}\nfunction MyAddon.Reload() end\n',
    'lua/myaddon/sv_main.lua': 'MyAddon.Reload()\n',
  });
  const analysis = analyses['lua/myaddon/sv_main.lua'];
  const offset = analysis.text.indexOf('Reload');

  const locations = definition(analysis, analysis.lines.positionAt(offset), api, workspace);
  assert.equal(locations.length, 1);
  assert.ok(locations[0].uri.endsWith('sh_config.lua'));
});

/* ----------------------------------------------------------------- realm */

test('infers realm from the file path and reports a cross-realm call', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/client/cl_bad.lua': 'local ply = player.GetByID(1)\nply:Kick("nope")\n',
  });
  const analysis = analyses['lua/autorun/client/cl_bad.lua'];
  assert.equal(analysis.realm.file, 'client');

  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS);
  const realmIssue = found.find((d) => d.code === 'realm-violation');
  assert.ok(realmIssue, 'Player:Kick is server-only and must be flagged in a cl_ file');
  assert.match(realmIssue.message, /Server-side/);
});

test('narrows realm inside an if SERVER block within a shared file', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_mixed.lua': `
if SERVER then
  local ply = player.GetByID(1)
  ply:Kick("bye")
end
`,
  });
  const analysis = analyses['lua/autorun/sh_mixed.lua'];
  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS);
  assert.equal(
    found.filter((d) => d.code === 'realm-violation').length,
    0,
    'a server-only call inside if SERVER is correct',
  );
});

test('every diagnostic carries a link to the rule that produced it', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_mixed.lua':
      'net.Start("my_msg")\nnet.Broadcast()\nlocal unused = 1\nUnknownThing()\n',
  });
  const found = diagnose(
    analyses['lua/autorun/server/sv_mixed.lua'],
    api,
    workspace,
    DEFAULT_SETTINGS,
  );

  assert.ok(found.length > 2, 'the fixture should produce several findings');
  for (const diagnostic of found) {
    assert.equal(
      diagnostic.codeDescription?.href,
      `https://docs.bluejutzu.dev/glua/reference/rules#${diagnostic.code}`,
      `no rule link on ${diagnostic.code}`,
    );
  }
});

/* ------------------------------------------------------------------- net */

test('flags a net message that is never registered or received', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_net.lua': 'net.Start("my_msg")\nnet.Broadcast()\n',
  });
  const analysis = analyses['lua/autorun/server/sv_net.lua'];
  const codes = diagnose(analysis, api, workspace, DEFAULT_SETTINGS).map((d) => d.code);

  assert.ok(codes.includes('net-unregistered'));
  assert.ok(codes.includes('net-never-received'));
});

test('flags a net.Start that is never dispatched', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_forgot.lua':
      'util.AddNetworkString("m")\nnet.Start("m")\nnet.WriteString("hi")\n',
    'lua/autorun/client/cl_forgot.lua': 'net.Receive("m", function() net.ReadString() end)\n',
  });
  const codes = diagnose(
    analyses['lua/autorun/server/sv_forgot.lua'],
    api,
    workspace,
    DEFAULT_SETTINGS,
  ).map((d) => d.code);
  assert.ok(codes.includes('net-never-dispatched'));
});

test('detects a net payload read/write mismatch across files', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_pay.lua': `
util.AddNetworkString("payload")
net.Start("payload")
  net.WriteString("a")
  net.WriteEntity(Entity(1))
net.Broadcast()
`,
    'lua/autorun/client/cl_pay.lua': `
net.Receive("payload", function()
  local s = net.ReadString()
  local n = net.ReadUInt(8)
end)
`,
  });
  const found = diagnose(analyses['lua/autorun/client/cl_pay.lua'], api, workspace, DEFAULT_SETTINGS);
  const mismatch = found.find((d) => d.code === 'net-payload-mismatch');
  assert.ok(mismatch, 'reading a UInt where an Entity was written must be flagged');
  assert.match(mismatch.message, /String, Entity/);
  assert.match(mismatch.message, /String, UInt/);
});

test('accepts a matching net payload without complaint', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_ok.lua': `
util.AddNetworkString("ok")
net.Start("ok")
  net.WriteString("a")
  net.WriteEntity(Entity(1))
net.Broadcast()
`,
    'lua/autorun/client/cl_ok.lua': `
net.Receive("ok", function()
  local s = net.ReadString()
  local e = net.ReadEntity()
end)
`,
  });
  const found = diagnose(analyses['lua/autorun/client/cl_ok.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.equal(found.filter((d) => d.code === 'net-payload-mismatch').length, 0);
});

/* ----------------------------------------------------------------- hooks */

test('flags a typo in a hook name and suggests nothing for a real one', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_hooks.lua': `
hook.Add("PlayerSpawned", "typo", function(ply) end)
hook.Add("PlayerSpawn", "fine", function(ply) end)
`,
  });
  const found = diagnose(analyses['lua/autorun/sh_hooks.lua'], api, workspace, DEFAULT_SETTINGS);
  const unknown = found.filter((d) => d.code === 'unknown-hook');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /PlayerSpawned/);
});

test('accepts a custom hook that the workspace fires itself', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_custom_a.lua': 'hook.Add("MyAddon.Ready", "x", function() end)\n',
    'lua/autorun/sh_custom_b.lua': 'hook.Run("MyAddon.Ready")\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_custom_a.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.equal(found.filter((d) => d.code === 'unknown-hook').length, 0);
});

/* ----------------------------------------------------------- call checks */

test('reports a wrong argument type against the documented signature', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_args.lua': 'local e = Entity(1)\ne:SetHealth("lots")\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_args.lua'], api, workspace, DEFAULT_SETTINGS);
  // A string where a number is expected is coercible in Lua, so this must NOT fire.
  assert.equal(found.filter((d) => d.code === 'argument-type').length, 0);

  const second = makeWorkspace({
    'lua/autorun/sh_args2.lua': 'local e = Entity(1)\ne:SetHealth(e)\n',
  });
  const found2 = diagnose(
    second.analyses['lua/autorun/sh_args2.lua'],
    api,
    second.workspace,
    DEFAULT_SETTINGS,
  );
  assert.ok(
    found2.some((d) => d.code === 'argument-type'),
    'passing an Entity where a number is documented must be flagged',
  );
});

test('reports a missing required argument', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_count.lua': 'local e = Entity(1)\ne:SetHealth()\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_count.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.ok(found.some((d) => d.code === 'argument-count'));
});

test('signature help reports the active parameter', () => {
  const source = 'local e = Entity(1)\ne:SetPos(Vector(0, 0, ';
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_sig.lua': source });
  const analysis = analyses['lua/autorun/sh_sig.lua'];

  const help = signatureHelp(analysis, analysis.lines.positionAt(source.length), api);
  assert.ok(help, 'signature help should resolve inside an unfinished call');
  assert.match(help.signatures[0].label, /^Vector\(/);
  assert.equal(help.activeParameter, 2);
});

/* ----------------------------------------------------------------- hover */

test('hover on an API call shows the realm and warns when it is wrong', () => {
  const source = 'local ply = player.GetByID(1)\nply:Kick("no")\n';
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/client/cl_hover.lua': source });
  const analysis = analyses['lua/autorun/client/cl_hover.lua'];

  const result = hover(analysis, analysis.lines.positionAt(source.indexOf('Kick')), deps(workspace));
  assert.ok(result);
  assert.match(result.contents.value, /Server/);
  assert.match(result.contents.value, /will be nil here/);
});

test('hover on a local reports its inferred type', () => {
  const source = 'local frame = vgui.Create("DFrame")\nprint(frame)\n';
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/client/cl_h2.lua': source });
  const analysis = analyses['lua/autorun/client/cl_h2.lua'];

  const result = hover(
    analysis,
    analysis.lines.positionAt(source.lastIndexOf('frame')),
    deps(workspace),
  );
  assert.ok(result);
  assert.match(result.contents.value, /DFrame/);
});

/* ------------------------------------------------------- string contexts */

test('completes hook names inside the hook.Add string argument', () => {
  const { text, offset } = withCursor('hook.Add("|", "id", function() end)\n');
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_str.lua': text });
  const analysis = analyses['lua/autorun/sh_str.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('PlayerSpawn'));
  assert.ok(names.includes('PlayerSay'));
});

test('completes known net message names inside net.Start', () => {
  const { text, offset } = withCursor('net.Start("|")\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_reg.lua': 'util.AddNetworkString("known_message")\n',
    'lua/autorun/server/sv_use.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_use.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('known_message'));
});

test('completes VGUI panel classes inside vgui.Create', () => {
  const { text, offset } = withCursor('local p = vgui.Create("|")\n');
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/client/cl_str.lua': text });
  const analysis = analyses['lua/autorun/client/cl_str.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('DFrame'));
  assert.ok(names.includes('DLabel'));
});

test('completes ENTITY hooks after "function ENT:"', () => {
  const { text, offset } = withCursor('function ENT:|\n');
  const { workspace, analyses } = makeWorkspace({ 'lua/entities/thing/init.lua': text });
  const analysis = analyses['lua/entities/thing/init.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Initialize'));
  assert.ok(names.includes('Think'));
});

/* ------------------------------------------------------------- AddCSLua */

test('flags a clientside include that is never AddCSLuaFile-d', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/init.lua': 'include("myaddon/cl_ui.lua")\n',
    'lua/myaddon/cl_ui.lua': 'local x = 1\nprint(x)\n',
  });
  const found = diagnose(analyses['lua/myaddon/init.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.ok(found.some((d) => d.code === 'missing-addcsluafile'));
});

test('accepts an include that is properly AddCSLuaFile-d', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/init.lua': 'AddCSLuaFile("myaddon/cl_ui.lua")\ninclude("myaddon/cl_ui.lua")\n',
    'lua/myaddon/cl_ui.lua': 'local x = 1\nprint(x)\n',
  });
  const found = diagnose(analyses['lua/myaddon/init.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.equal(found.filter((d) => d.code === 'missing-addcsluafile').length, 0);
});

/* ----------------------------------------------------------- annotations */

test('---@param gives an untyped parameter a real type', () => {
  const { text, offset } = withCursor(`
---@param ply Player
---@param reason string
local function punish(ply, reason)
  ply:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_doc.lua': text });
  const analysis = analyses['lua/autorun/sh_doc.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Kick'), 'the annotation should make ply a Player');
  assert.ok(names.includes('SetHealth'), 'inherited Entity methods too');
});

test('---@param is ignored when no type is given', () => {
  const source = '--- @param ply the player who did it\nlocal function f(ply)\n  return ply\nend\nf(nil)\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_doc2.lua': source });
  const analysis = analyses['lua/autorun/sh_doc2.lua'];

  // "the" must not be treated as a type name.
  const offset = source.indexOf('return ply') + 7;
  const symbol = analysis.scopeAt(offset).lookup('ply', offset);
  assert.ok(symbol);
  assert.notEqual(typeToString(symbol.type), 'the');
});

test('---@type overrides the inferred type of a local', () => {
  const source = '---@type Player\nlocal target = nil\nprint(target)\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_doc3.lua': source });
  const analysis = analyses['lua/autorun/sh_doc3.lua'];

  const offset = source.lastIndexOf('target');
  const symbol = analysis.scopeAt(offset).lookup('target', offset);
  assert.equal(typeToString(symbol.type), 'Player');
});

test('---@param supports optional and union types', () => {
  const source = '---@param ent Entity|nil\n---@param count? number\nlocal function f(ent, count)\n  return ent, count\nend\nf()\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_doc4.lua': source });
  const analysis = analyses['lua/autorun/sh_doc4.lua'];

  const offset = source.indexOf('return ent') + 7;
  const ent = analysis.scopeAt(offset).lookup('ent', offset);
  assert.match(typeToString(ent.type), /Entity/);
  const count = analysis.scopeAt(offset).lookup('count', offset);
  assert.equal(typeToString(count.type), 'number');
});

test('annotation prose stays in hover but the tags do not', () => {
  const source = '--- Punishes a player.\n---@param ply Player\nlocal function punish(ply) return ply end\npunish(nil)\n';
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_doc5.lua': source });
  const analysis = analyses['lua/autorun/sh_doc5.lua'];

  const result = hover(
    analysis,
    analysis.lines.positionAt(source.lastIndexOf('punish')),
    deps(workspace),
  );
  assert.ok(result);
  assert.match(result.contents.value, /Punishes a player/);
  assert.doesNotMatch(result.contents.value, /@param/);
});

/* ------------------------------------------------------- usage inference */

test('infers a parameter type from the methods called on it', () => {
  const { text, offset } = withCursor(`
local function canPlace(ply)
  if not ply:IsAdmin() then return false end
  return ply:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_duck.lua': text });
  const analysis = analyses['lua/autorun/sh_duck.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('SteamID'), 'IsAdmin only exists on Player, so ply is a Player');
});

test('falls back to the shared base class when methods are ambiguous', () => {
  const source = 'local function move(ent)\n  ent:SetPos(ent:GetPos())\nend\nmove(nil)\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_duck2.lua': source });
  const analysis = analyses['lua/autorun/sh_duck2.lua'];

  const offset = source.indexOf('ent:SetPos');
  const symbol = analysis.scopeAt(offset).lookup('ent', offset);
  assert.equal(typeToString(symbol.type), 'Entity');
});

test('does not guess when the methods match nothing', () => {
  const source = 'local function f(thing)\n  thing:TotallyMadeUpMethod()\nend\nf(nil)\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_duck3.lua': source });
  const analysis = analyses['lua/autorun/sh_duck3.lua'];

  const offset = source.indexOf('thing:Totally');
  const symbol = analysis.scopeAt(offset).lookup('thing', offset);
  assert.equal(typeToString(symbol.type), 'any');
});

test('an explicit annotation wins over usage inference', () => {
  const source = '---@param ent Weapon\nlocal function f(ent)\n  ent:SetPos(ent:GetPos())\nend\nf(nil)\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_duck4.lua': source });
  const analysis = analyses['lua/autorun/sh_duck4.lua'];

  const offset = source.indexOf('ent:SetPos');
  const symbol = analysis.scopeAt(offset).lookup('ent', offset);
  assert.equal(typeToString(symbol.type), 'Weapon');
});

/* ------------------------------------------------------------ hook tables */

test('ENT hovers as an entity definition table, not an undefined global', () => {
  const source = 'ENT.Type = "anim"\nENT.Base = "base_gmodentity"\n';
  const { workspace, analyses } = makeWorkspace({ 'lua/entities/thing/shared.lua': source });
  const analysis = analyses['lua/entities/thing/shared.lua'];

  const result = hover(analysis, analysis.lines.positionAt(source.lastIndexOf('ENT')), deps(workspace));
  assert.ok(result);
  assert.match(result.contents.value, /entity definition table/);
  assert.doesNotMatch(result.contents.value, /no definition found/);
});

test('hook tables are never reported as undefined globals', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/thing/shared.lua': 'ENT.Type = "anim"\nfunction ENT:Think() end\n',
    'lua/weapons/gun/shared.lua': 'SWEP.Base = "weapon_base"\nfunction SWEP:PrimaryAttack() end\n',
  });
  for (const key of Object.keys(analyses)) {
    const found = diagnose(analyses[key], api, workspace, DEFAULT_SETTINGS);
    assert.equal(
      found.filter((d) => d.code === 'undefined-global').length,
      0,
      `${key} should not report a hook table as undefined`,
    );
  }
});

/* ------------------------------------------------ generated accessors */

test('NetworkVar generates Get and Set completions on self', () => {
  const { text, offset } = withCursor(`
function ENT:SetupDataTables()
  self:NetworkVar("Int", 0, "Ammo")
  self:NetworkVar("Entity", 0, "Owner")
end

function ENT:Think()
  self:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/entities/turret/shared.lua': text });
  const analysis = analyses['lua/entities/turret/shared.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('GetAmmo'), 'NetworkVar("Int", 0, "Ammo") should give GetAmmo');
  assert.ok(names.includes('SetAmmo'));
  assert.ok(names.includes('GetOwner'));
  assert.ok(names.includes('SetModel'), 'real Entity methods are still there');
});

test('NetworkVars carry across the files of one entity', () => {
  const { text, offset } = withCursor('function ENT:Think()\n  self:|\nend\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/turret/shared.lua':
      'function ENT:SetupDataTables()\n  self:NetworkVar("Bool", 0, "Active")\nend\n',
    'lua/entities/turret/init.lua': text,
  });
  const analysis = analyses['lua/entities/turret/init.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('GetActive'), 'declared in shared.lua, used from init.lua');
});

test('AccessorFunc generates accessors too', () => {
  const { text, offset } = withCursor(`
AccessorFunc(ENT, "m_Speed", "Speed", FORCE_NUMBER)

function ENT:Think()
  self:|
end
`);
  const { workspace, analyses } = makeWorkspace({ 'lua/entities/car/shared.lua': text });
  const analysis = analyses['lua/entities/car/shared.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('GetSpeed'));
  assert.ok(names.includes('SetSpeed'));
});

test('accessors from an unrelated entity do not leak in', () => {
  const { text, offset } = withCursor('function ENT:Think()\n  self:|\nend\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/turret/shared.lua':
      'function ENT:SetupDataTables()\n  self:NetworkVar("Int", 0, "Ammo")\nend\n',
    'lua/entities/door/shared.lua': text,
  });
  const analysis = analyses['lua/entities/door/shared.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(!names.includes('GetAmmo'), 'the turret is a different entity');
});

test('array returns resolve on methods, not just library functions', () => {
  // These are keyed on the wiki address because a method is written on the
  // receiver — `ply:GetWeapons()`, never `Player:GetWeapons()`.
  const cases = [
    ['local ply = player.GetByID(1)\nfor _, w in ipairs(ply:GetWeapons()) do w:| end', 'Clip1'],
    ['local ent = ents.GetAll()[1]\nfor _, c in ipairs(ent:GetChildren()) do c:| end', 'SetModel'],
    ['for _, p in ipairs(player.GetAll()) do p:| end', 'Nick'],
  ];

  for (const [source, expected] of cases) {
    const { text, offset } = withCursor(source);
    const { workspace, analyses } = makeWorkspace({ 'lua/autorun/server/sv_arr.lua': text });
    const analysis = analyses['lua/autorun/server/sv_arr.lua'];
    const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
    assert.ok(names.includes(expected), `${source.split('\n').pop()} should offer ${expected}`);
  }
});

/* --------------------------------------------------------------- report */

test('the report counts what is actually there', async () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/server/sv_net.lua':
      'util.AddNetworkString("used")\nnet.Start("used")\nnet.Send(ply)\nnet.Start("orphan")\nnet.Send(ply)\n',
    'lua/autorun/client/cl_net.lua': 'net.Receive("used", function() end)\n',
    'lua/entities/my_turret/shared.lua': 'function ENT:Explode()\nend\n',
  });

  const report = await buildReport(api, workspace, { settingsFor: () => DEFAULT_SETTINGS, top: 5 });

  assert.equal(report.files, 3);
  assert.ok(report.lines > 5);
  assert.equal(report.realms.server, 1);
  assert.equal(report.realms.client, 1);

  assert.equal(report.net.registered, 1);
  assert.deepEqual(report.net.unhandled, ['orphan'], 'sent with nothing listening');
  assert.deepEqual(report.net.unregistered, ['orphan']);

  assert.equal(report.entities.total, 1);
  assert.equal(report.entities.byKind.entity, 1);
  assert.ok(report.diagnostics.byCode.some((r) => r.name === 'net-unregistered'));
});

test('a collision keeps its event and identifier apart', async () => {
  // The index joins them with a NUL because hook names contain spaces of their
  // own, so a report that printed the raw key would run them together.
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_a.lua': 'hook.Add("Org Clear", "RemovePoison2", function() end)\n',
    'lua/autorun/sh_b.lua': 'hook.Add("Org Clear", "RemovePoison2", function() end)\n',
  });

  const report = await buildReport(api, workspace, { settingsFor: () => DEFAULT_SETTINGS });

  assert.equal(report.hooks.collisions.length, 1);
  assert.deepEqual(report.hooks.collisions[0], {
    event: 'Org Clear',
    identifier: 'RemovePoison2',
    count: 2,
  });
  for (const clash of report.hooks.collisions) {
    assert.ok(!clash.event.includes('\0') && !clash.identifier.includes('\0'));
  }
});

test('library files are counted separately and never reported on', async () => {
  const library = makeLibrary({ 'lua/ulib/shared.lua': 'ULib = {}\nlocal unused = 1\n' });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);
  workspace.analyse(uriOf('lua', 'autorun', 'sh_mine.lua'), 'print(1)\n', 1);

  const report = await buildReport(api, workspace, { settingsFor: () => DEFAULT_SETTINGS });

  assert.equal(report.files, 1, 'only what this project wrote');
  assert.equal(report.libraryFiles, 1);
  assert.ok(
    !report.worstFiles.some((f) => f.file.includes('ulib')),
    "a dependency's own problems are not ours",
  );

  fs.rmSync(library, { recursive: true, force: true });
});

test('a dependency does not contribute to the project totals', async () => {
  // The cross-file indexes cover libraries on purpose, so a message you send
  // and ULib handles still resolves. But a hook, timer or entity living wholly
  // inside a dependency is not something this project has, and a clash between
  // two of its own registrations is not this project's clash.
  const library = makeLibrary({
    'lua/ulib/a.lua':
      'hook.Add("Think", "ulib.tick", function() end)\n' +
      'timer.Create("ulib.timer", 1, 0, function() end)\n' +
      'hook.Run("ULib.Custom", 1)\n',
    'lua/ulib/b.lua':
      'hook.Add("Think", "ulib.tick", function() end)\n' +
      'timer.Create("ulib.timer", 1, 0, function() end)\n',
    'lua/entities/ulib_marker/shared.lua': 'function ENT:Ping()\nend\n',
  });

  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);
  workspace.analyse(uriOf('lua', 'autorun', 'sh_mine.lua'), 'print(1)\n', 1);

  const report = await buildReport(api, workspace, { settingsFor: () => DEFAULT_SETTINGS });

  assert.deepEqual(report.hooks.collisions, [], "the dependency's own clash is its own");
  assert.deepEqual(report.timers.collisions, []);
  assert.equal(report.hooks.custom, 0, 'a hook only ULib fires is not ours');
  assert.equal(report.entities.total, 0, 'nor is an entity only ULib ships');

  fs.rmSync(library, { recursive: true, force: true });
});

test('the html report escapes what it prints', async () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_x.lua': 'hook.Run("<img src=x>", 1)\n',
  });
  const report = await buildReport(api, workspace, { settingsFor: () => DEFAULT_SETTINGS });
  report.undefinedGlobals.push({ name: '<script>alert(1)</script>', count: 1 });

  const html = renderHtml(report, '<b>proj</b>');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;b&gt;proj'));
});

/* ---------------------------------------------------------- libraries */

/** A framework checkout living outside the project, the way ULib does. */
function makeLibrary(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glua-lib-'));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

test('a framework outside the project stops reading as undefined', () => {
  const library = makeLibrary({
    'lua/ulib/shared.lua': 'ULib = ULib or {}\nfunction ULib.tsayError(ply, msg) end\n',
  });

  const source = 'local ply = player.GetByID(1)\nULib.tsayError(ply, "no")\n';
  const before = new Workspace(api, { maxFiles: 50, exclude: [] });
  const withoutLibrary = before.analyse(uriOf('lua', 'autorun', 'sv_a.lua'), source, 1);
  assert.ok(
    diagnose(withoutLibrary, api, before, DEFAULT_SETTINGS).some((d) => d.code === 'undefined-global'),
    'ULib is not a GMod global, so on its own it is undefined',
  );

  const after = new Workspace(api, { maxFiles: 50, exclude: [] });
  assert.equal(after.indexLibrary(library), 1);
  const withLibrary = after.analyse(uriOf('lua', 'autorun', 'sv_a.lua'), source, 1);
  assert.equal(
    diagnose(withLibrary, api, after, DEFAULT_SETTINGS).filter((d) => d.code === 'undefined-global').length,
    0,
  );

  fs.rmSync(library, { recursive: true, force: true });
});

test('a library gains real signatures, not just a silenced name', () => {
  const library = makeLibrary({
    'lua/ulib/shared.lua': 'ULib = ULib or {}\nfunction ULib.getUsers(target, ply) end\n',
  });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);

  const { text, offset } = withCursor('ULib.|\n');
  const analysis = workspace.analyse(uriOf('lua', 'autorun', 'sv_b.lua'), text, 1);
  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('getUsers'), 'the function is completed, not merely tolerated');

  fs.rmSync(library, { recursive: true, force: true });
});

test('library files are never reported on themselves', () => {
  const library = makeLibrary({
    // Wrong on purpose: it is not ours to fix.
    'lua/ulib/bad.lua': 'local unused = 1\nnet.Start("never_registered")\n',
  });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);

  const uris = [...workspace.uris()];
  assert.equal(uris.length, 1);
  assert.ok(workspace.isLibrary(uris[0]), 'so callers know to skip it');
  assert.equal(workspace.libraryCount, 1);

  fs.rmSync(library, { recursive: true, force: true });
});

test('library content does not join the asset index', () => {
  const library = makeLibrary({
    'lua/ulib/shared.lua': 'ULib = {}\n',
    'materials/ulib/icon.png': '',
  });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);

  assert.ok(!workspace.assets().has('material', 'ulib/icon'), 'a dependency ships its own content');

  fs.rmSync(library, { recursive: true, force: true });
});

/* ------------------------------------------------------------- assets */

const withAssetCheck = (severity) => ({
  ...DEFAULT_SETTINGS,
  diagnostics: { ...DEFAULT_SETTINGS.diagnostics, missingAsset: severity },
});

/** A throwaway content tree, since the asset index reads real directories. */
function makeAssetTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glua-assets-'));
  for (const relative of files) {
    const full = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

test('an asset path resolves with or without its extension', () => {
  const game = makeAssetTree([
    'garrysmod/materials/vgui/logo.vmt',
    'garrysmod/models/props/crate.mdl',
    'garrysmod/sound/ui/click.wav',
  ]);
  const assets = new AssetIndex([], game);

  assert.ok(assets.has('material', 'vgui/logo'), 'Material omits the extension');
  assert.ok(assets.has('material', 'vgui/logo.vmt'));
  assert.ok(assets.has('model', 'models/props/crate.mdl'), 'models are written in full');
  assert.ok(assets.has('sound', 'ui/click.wav'));
  assert.ok(!assets.has('material', 'vgui/nope'));
  assert.ok(assets.canValidate, 'a game directory was supplied');

  fs.rmSync(game, { recursive: true, force: true });
});

test('workspace content alone never enables the missing-asset check', () => {
  const addon = makeAssetTree(['materials/myaddon/icon.png']);
  const assets = new AssetIndex([addon], undefined);

  assert.ok(assets.has('material', 'myaddon/icon'), 'still resolves for completion');
  assert.equal(assets.canValidate, false, 'but cannot tell a typo from base game content');

  fs.rmSync(addon, { recursive: true, force: true });
});

test('a missing material is reported once a game directory is set', () => {
  const game = makeAssetTree(['garrysmod/materials/vgui/logo.vmt']);
  const workspace = new Workspace(api, { maxFiles: 10, exclude: [], gamePath: game });
  const uri = uriOf('lua', 'autorun', 'client', 'cl_ui.lua');
  const analysis = workspace.analyse(
    uri,
    'local a = Material("vgui/logo")\nlocal b = Material("vgui/typo")\n',
    1,
  );

  assert.equal(
    diagnose(analysis, api, workspace, DEFAULT_SETTINGS).filter((x) => x.code === 'missing-asset').length,
    0,
    'off by default, because Workshop content is invisible from here',
  );

  const on = withAssetCheck('warning');
  const found = diagnose(analysis, api, workspace, on);
  const missing = found.filter((x) => x.code === 'missing-asset');
  assert.equal(missing.length, 1, JSON.stringify(found.map((f) => f.message)));
  assert.match(missing[0].message, /vgui\/typo/);
  assert.match(missing[0].message, /checkerboard/);

  fs.rmSync(game, { recursive: true, force: true });
});

test('a path built at runtime is not checked', () => {
  const game = makeAssetTree(['garrysmod/materials/vgui/logo.vmt']);
  const workspace = new Workspace(api, { maxFiles: 10, exclude: [], gamePath: game });
  const analysis = workspace.analyse(
    uriOf('lua', 'autorun', 'client', 'cl_dyn.lua'),
    'local m = Material("vgui/icons/%s")\n',
    1,
  );

  const found = diagnose(analysis, api, workspace, withAssetCheck('warning'));
  assert.equal(found.filter((x) => x.code === 'missing-asset').length, 0);

  fs.rmSync(game, { recursive: true, force: true });
});

test('a file that is not a VPK costs that archive, not the feature', () => {
  const dir = makeAssetTree(['garrysmod/notreally_dir.vpk']);
  const junk = path.join(dir, 'garrysmod', 'notreally_dir.vpk');
  fs.writeFileSync(junk, Buffer.from('this is not a vpk at all'));

  assert.deepEqual(readVpkDirectory(junk), []);
  assert.deepEqual(readVpkDirectory(path.join(dir, 'missing_dir.vpk')), []);
  // And the index still builds around it.
  assert.equal(new AssetIndex([], dir).size, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('asset completion narrows by what is typed before it truncates', () => {
  // A game directory holds far more paths than are worth sending, so the list
  // is cut — but cutting before filtering means later keystrokes can never
  // reach anything outside that first arbitrary slice.
  const many = [];
  for (let i = 0; i < 900; i++) many.push(`garrysmod/materials/bulk/pad${i}.vmt`);
  many.push('garrysmod/materials/hud/needle.vmt');
  const game = makeAssetTree(many);

  const workspace = new Workspace(api, { maxFiles: 10, exclude: [], gamePath: game });
  const { text, offset } = withCursor('local m = Material("hud/nee|")\n');
  const analysis = workspace.analyse(uriOf('lua', 'autorun', 'client', 'cl_m.lua'), text, 1);

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('hud/needle'), 'the one match must survive the cut');
  assert.ok(names.length < 900, 'and the list is still bounded');

  fs.rmSync(game, { recursive: true, force: true });
});

test('a library file open in the editor is still not reported on', () => {
  const library = makeLibrary({ 'lua/ulib/bad.lua': 'local unused = 1\nx += 1\n' });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);

  const uri = [...workspace.uris()][0];
  assert.ok(workspace.isLibrary(uri), 'and it stays a library once opened');

  // Re-analysing it the way opening a document does must not change that.
  const onDisk = fs.readFileSync(path.join(library, 'lua', 'ulib', 'bad.lua'), 'utf8');
  workspace.analyse(uri, onDisk, 2, true);
  assert.ok(workspace.isLibrary(uri));

  fs.rmSync(library, { recursive: true, force: true });
});

test('clearing libraries drops their globals again', () => {
  const library = makeLibrary({ 'lua/ulib/shared.lua': 'ULib = {}\nfunction ULib.go() end\n' });
  const workspace = new Workspace(api, { maxFiles: 50, exclude: [] });
  workspace.indexLibrary(library);
  assert.ok(workspace.isKnownGlobalPath('ULib'));

  workspace.clearLibraries();
  assert.equal(workspace.libraryCount, 0);
  assert.ok(!workspace.isKnownGlobalPath('ULib'), 'removing it from the config must mean something');

  fs.rmSync(library, { recursive: true, force: true });
});

test('asset references are recorded for every call form', () => {
  const { analyses } = makeWorkspace({
    'lua/autorun/sh_assets.lua':
      'Material("a/b")\n' +
      'ent:SetModel("models/c.mdl")\n' +
      'ent:EmitSound("d/e.wav")\n' +
      'surface.PlaySound("f.wav")\n' +
      'util.PrecacheModel("models/g.mdl")\n',
  });

  const kinds = analyses['lua/autorun/sh_assets.lua'].assets.map((a) => `${a.kind}:${a.path}`);
  assert.deepEqual(kinds, [
    'material:a/b',
    'model:models/c.mdl',
    'sound:d/e.wav',
    'sound:f.wav',
    'model:models/g.mdl',
  ]);
});

/* ------------------------------------------------------- custom hooks */

test('a custom hook callback is typed from the hook.Run call sites', () => {
  const { text, offset } = withCursor(`
hook.Add("MyAddon.TurretPlaced", "x", function(ply, turret)
  ply:|
end)
`);
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/server/sv_fire.lua':
      'local ply = player.GetByID(1)\nhook.Run("MyAddon.TurretPlaced", ply, ents.GetAll()[1])\n',
    'lua/autorun/server/sv_handle.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_handle.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Nick'), 'the first argument was a Player at the call site');
  assert.ok(names.includes('SetHealth'), 'and Player inherits Entity');
});

test('call sites that disagree about a position leave it untyped', () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_a.lua': 'local ply = player.GetByID(1)\nhook.Run("Amb.Thing", ply)\n',
    'lua/autorun/sh_b.lua': 'hook.Run("Amb.Thing", "a string")\n',
  });

  const signature = workspace.customHookSignature('Amb.Thing');
  assert.equal(signature.params[0], 'any', 'a Player in one place and a string in another');
  assert.equal(signature.sites, 2);
});

test('a call site passing nil does not type the parameter as nil', () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_nil.lua':
      'local ply = player.GetByID(1)\nhook.Run("N.Hurt", nil, 1)\nhook.Run("N.Hurt", ply, 2)\n',
  });

  const signature = workspace.customHookSignature('N.Hurt');
  assert.match(signature.params[0], /Player/, 'the informative call site wins over the nil one');
  assert.equal(signature.params[1], 'number');
});

test('hook.Call skips the gamemode table when reading the payload', () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_call.lua':
      'local ply = player.GetByID(1)\nhook.Call("Cm.Fired", GAMEMODE, ply)\n',
  });

  const signature = workspace.customHookSignature('Cm.Fired');
  assert.equal(signature.params.length, 1, 'the gamemode table is not part of the payload');
  assert.match(signature.params[0], /Player/);
});

test('gameevent.Listen does not claim the hook takes no arguments', () => {
  const { workspace } = makeWorkspace({
    'lua/autorun/sh_ev.lua':
      'gameevent.Listen("player_hurt")\nhook.Run("player_hurt", 1, 2)\n',
  });

  const signature = workspace.customHookSignature('player_hurt');
  assert.equal(signature.maxArity, 2, 'the Listen call registers a name, it does not fire one');
  assert.equal(signature.sites, 1);
});

test('a callback taking more than any call site passes is flagged', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_run.lua': 'hook.Run("MyAddon.Ping", 1)\n',
    'lua/autorun/sh_add.lua': 'hook.Add("MyAddon.Ping", "x", function(a, b, c) end)\n',
  });

  const found = diagnose(analyses['lua/autorun/sh_add.lua'], api, workspace, DEFAULT_SETTINGS);
  const arity = found.filter((x) => x.code === 'argument-count');
  assert.equal(arity.length, 1, JSON.stringify(found.map((f) => f.message)));
  assert.match(arity[0].message, /Nothing passes this many arguments/);
});

test('a hook nothing fires is left alone by the arity check', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_only.lua': 'hook.Add("PlayerSay", "x", function(a, b) end)\n',
  });

  const found = diagnose(analyses['lua/autorun/sh_only.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.equal(found.filter((x) => x.code === 'argument-count').length, 0);
});

/* --------------------------------------------------- scripted classes */

test('a class name comes from the directory, or the file for a single-file class', () => {
  assert.deepEqual(scriptedClassOf(file('lua', 'entities', 'my_turret', 'shared.lua')), {
    name: 'my_turret', kind: 'entity', base: 'Entity', table: 'ENT',
  });
  assert.deepEqual(scriptedClassOf(file('lua', 'entities', 'my_turret.lua')), {
    name: 'my_turret', kind: 'entity', base: 'Entity', table: 'ENT',
  });
  assert.equal(scriptedClassOf(file('lua', 'weapons', 'my_gun', 'shared.lua')).base, 'Weapon');
  assert.equal(scriptedClassOf(file('lua', 'effects', 'sparks', 'init.lua')).kind, 'effect');
  assert.equal(
    scriptedClassOf(file('lua', 'weapons', 'gmod_tool', 'stools', 'welder.lua')),
    null,
    'toolgun tools all share the gmod_tool weapon',
  );
  assert.equal(scriptedClassOf(file('lua', 'autorun', 'sh_init.lua')), null);
});

test('ents.Create types the result as that entity, with its own methods', () => {
  const { text, offset } = withCursor(`
local turret = ents.Create("my_turret")
turret:|
`);
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua':
      'function ENT:SetupDataTables()\n  self:NetworkVar("Int", 0, "Ammo")\nend\n' +
      'function ENT:Explode(force)\nend\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Explode'), 'methods the entity defines on ENT');
  assert.ok(names.includes('GetAmmo'), 'accessors the entity generates');
  assert.ok(names.includes('SetModel'), 'and the real Entity API underneath');
});

test('another entity\'s methods do not leak into an unrelated ents.Create', () => {
  const { text, offset } = withCursor('local d = ents.Create("door")\nd:|\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'function ENT:Explode()\nend\n',
    'lua/entities/door/shared.lua': 'function ENT:Open()\nend\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Open'));
  assert.ok(!names.includes('Explode'), 'Explode belongs to my_turret');
});

test('ents.FindByClass yields an array of the scripted class', () => {
  const { text, offset } = withCursor(`
for _, turret in ipairs(ents.FindByClass("my_turret")) do
  turret:|
end
`);
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'function ENT:Explode()\nend\n',
    'lua/autorun/server/sv_sweep.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_sweep.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('Explode'));
});

test('the class argument completes with workspace classes of the right kind', () => {
  const { text, offset } = withCursor('local e = ents.Create("|")\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'ENT.Base = "base_gmodentity"\n',
    'lua/weapons/my_gun/shared.lua': 'SWEP.Base = "weapon_base"\n',
    'lua/effects/sparks/init.lua': 'function EFFECT:Init()\nend\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const names = labels(completion(analysis, analysis.lines.positionAt(offset), deps(workspace)));
  assert.ok(names.includes('my_turret'));
  assert.ok(names.includes('my_gun'), 'ents.Create takes weapons too');
  assert.ok(!names.includes('sparks'), 'effects are not spawned with ents.Create');
});

test('go to definition on a class string opens the class, preferring shared.lua', () => {
  const { text, offset } = withCursor('local e = ents.Create("my_|turret")\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/init.lua': 'AddCSLuaFile()\n',
    'lua/entities/my_turret/shared.lua': 'ENT.Type = "anim"\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const targets = definition(analysis, analysis.lines.positionAt(offset), api, workspace);
  assert.equal(targets.length, 1);
  assert.ok(targets[0].uri.endsWith('/my_turret/shared.lua'), targets[0].uri);
});

test('an unknown class string resolves to nothing rather than guessing', () => {
  const { text, offset } = withCursor('local e = ents.Create("prop_phy|sics")\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'ENT.Type = "anim"\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  assert.deepEqual(definition(analysis, analysis.lines.positionAt(offset), api, workspace), []);
});

test('an engine class keeps the documented Entity return type', () => {
  const { text, offset } = withCursor('local ent = ents.Create("prop_physics")\ne|nt:Spawn()\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'function ENT:Explode()\nend\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const info = hover(analysis, analysis.lines.positionAt(offset), deps(workspace));
  assert.match(info.contents.value, /local ent: Entity\b/, info.contents.value);
});

test('a scripted class shows both names, so the base API is still obvious', () => {
  const { text, offset } = withCursor('local turret = ents.Create("my_turret")\nt|urret:Spawn()\n');
  const { workspace, analyses } = makeWorkspace({
    'lua/entities/my_turret/shared.lua': 'function ENT:Explode()\nend\n',
    'lua/autorun/server/sv_spawn.lua': text,
  });
  const analysis = analyses['lua/autorun/server/sv_spawn.lua'];

  const info = hover(analysis, analysis.lines.positionAt(offset), deps(workspace));
  assert.match(info.contents.value, /local turret: Entity \(my_turret\)/, info.contents.value);
});

/* ------------------------------------------------ duplicate registrations */

test('two hook.Add calls with the same event and identifier are flagged', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_a.lua': 'hook.Add("Think", "myaddon.tick", function() end)\n',
    'lua/autorun/sh_b.lua': 'hook.Add("Think", "myaddon.tick", function() end)\n',
  });

  for (const key of Object.keys(analyses)) {
    const found = diagnose(analyses[key], api, workspace, DEFAULT_SETTINGS);
    const duplicate = found.find((d) => d.code === 'duplicate-hook-identifier');
    assert.ok(duplicate, `${key} should report the clash`);
    assert.match(duplicate.message, /myaddon\.tick/);
  }
});

test('the same identifier for different events is fine', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_a.lua':
      'hook.Add("Think", "shared.id", function() end)\nhook.Add("Tick", "shared.id", function() end)\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_a.lua'], api, workspace, DEFAULT_SETTINGS);
  assert.equal(found.filter((d) => d.code === 'duplicate-hook-identifier').length, 0);
});

test('registrations in different realms do not clash', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/client/cl_a.lua': 'hook.Add("Think", "myaddon.tick", function() end)\n',
    'lua/autorun/server/sv_a.lua': 'hook.Add("Think", "myaddon.tick", function() end)\n',
  });
  for (const key of Object.keys(analyses)) {
    const found = diagnose(analyses[key], api, workspace, DEFAULT_SETTINGS);
    assert.equal(
      found.filter((d) => d.code === 'duplicate-hook-identifier').length,
      0,
      `${key}: client and server hooks never collide`,
    );
  }
});

test('duplicate timer names are flagged', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_t.lua':
      'timer.Create("myaddon.loop", 1, 0, function() end)\ntimer.Create("myaddon.loop", 5, 0, function() end)\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_t.lua'], api, workspace, DEFAULT_SETTINGS);
  const duplicates = found.filter((d) => d.code === 'duplicate-timer-name');
  assert.equal(duplicates.length, 2, 'both sites are reported');
  assert.match(duplicates[0].message, /myaddon\.loop/);
});

test('duplicate detection can be turned off', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_a.lua': 'hook.Add("Think", "dup", function() end)\n',
    'lua/autorun/sh_b.lua': 'hook.Add("Think", "dup", function() end)\n',
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, duplicateIdentifier: 'off' },
  };
  const found = diagnose(analyses['lua/autorun/sh_a.lua'], api, workspace, settings);
  assert.equal(found.filter((d) => d.code === 'duplicate-hook-identifier').length, 0);
});

/* ---------------------------------------------------------------- scopes */

test('shadowing and declaration order follow Lua scoping', () => {
  const source = `
local x = 1
do
  local x = "two"
  print(x)
end
print(x)
`;
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_scope.lua': source });
  const analysis = analyses['lua/autorun/sh_scope.lua'];

  const innerOffset = source.indexOf('print(x)') + 6;
  const inner = analysis.scopeAt(innerOffset).lookup('x', innerOffset);
  assert.equal(typeToString(inner.type), 'string');

  const outerOffset = source.lastIndexOf('print(x)') + 6;
  const outer = analysis.scopeAt(outerOffset).lookup('x', outerOffset);
  assert.equal(typeToString(outer.type), 'number');
});

test('the right-hand side of local x = x sees the outer x', () => {
  const source = 'local n = 5\nlocal n = n\n';
  const { analyses } = makeWorkspace({ 'lua/autorun/sh_shadow.lua': source });
  const analysis = analyses['lua/autorun/sh_shadow.lua'];

  const rhs = source.lastIndexOf('n');
  const symbol = analysis.scopeAt(rhs).lookup('n', rhs);
  assert.equal(typeToString(symbol.type), 'number');
});

test('undefined globals are reported but known API and workspace names are not', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_undef.lua': 'print(SomeTypo)\nprint(CurTime())\nprint(MOVETYPE_WALK)\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_undef.lua'], api, workspace, DEFAULT_SETTINGS);
  const undef = found.filter((d) => d.code === 'undefined-global');
  assert.equal(undef.length, 1);
  assert.match(undef[0].message, /SomeTypo/);
});

test('unused locals are reported, underscore-prefixed ones are not', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/sh_unused.lua': 'local used = 1\nlocal unused = 2\nlocal _ = 3\nprint(used)\n',
  });
  const found = diagnose(analyses['lua/autorun/sh_unused.lua'], api, workspace, DEFAULT_SETTINGS);
  const unused = found.filter((d) => d.code === 'unused-local');
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /unused/);
});

/* ------------------------------------------------------------- hot paths */

/** Just the perf findings for one file of a fixture workspace. */
function hotFindings(files, target) {
  const { workspace, analyses } = makeWorkspace(files);
  return diagnose(analyses[target], api, workspace, DEFAULT_SETTINGS, {}).filter(
    (d) => d.code === 'perf-hot-path',
  );
}

test('reports expensive calls written directly in a render hook', () => {
  const found = hotFindings(
    {
      'lua/autorun/client/cl_hot.lua': `
hook.Add("HUDPaint", "x", function()
  surface.SetMaterial(Material("icon16/cog.png"))
end)
`,
    },
    'lua/autorun/client/cl_hot.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Material/);
  assert.match(found[0].message, /every frame/);
  assert.match(found[0].message, /HUDPaint/);
});

test('follows the call graph across files and names the chain', () => {
  const found = hotFindings(
    {
      'lua/myaddon/sh_lib.lua': `
MyAddon = MyAddon or {}
function MyAddon.Sweep()
  return ents.FindByClass("prop_physics")
end
`,
      'lua/autorun/server/sv_hot.lua': `
hook.Add("Think", "x", function()
  MyAddon.Sweep()
end)
`,
    },
    'lua/myaddon/sh_lib.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /ents\.FindByClass/);
  assert.match(found[0].message, /every tick/);
  assert.match(found[0].message, /Think hook via MyAddon\.Sweep/);
});

test('a hook that does not run every frame is not a hot path', () => {
  const found = hotFindings(
    {
      'lua/autorun/server/sv_cold.lua': `
hook.Add("PlayerSay", "x", function()
  ents.FindByClass("prop_physics")
end)
`,
    },
    'lua/autorun/server/sv_cold.lua',
  );
  assert.deepEqual(found, []);
});

test('an ENT:Think that rate-limits itself is left alone', () => {
  const found = hotFindings(
    {
      'lua/entities/my_turret/init.lua': `
function ENT:Think()
  if CurTime() < (self.NextScan or 0) then return end
  self.NextScan = CurTime() + 1
  ents.FindInSphere(self:GetPos(), 256)
end
`,
    },
    'lua/entities/my_turret/init.lua',
  );
  assert.deepEqual(found, []);
});

test('an ENT:Think without a guard reports, and reaches its own methods', () => {
  const found = hotFindings(
    {
      'lua/entities/my_turret/init.lua': `
function ENT:Think()
  self:Scan()
end

function ENT:Scan()
  util.TableToJSON({})
end
`,
    },
    'lua/entities/my_turret/init.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /ENT:Think via ENT:Scan/);
});

test('a function registered by name is a hot entry too', () => {
  const found = hotFindings(
    {
      'lua/autorun/client/cl_named.lua': `
MyAddon = MyAddon or {}
function MyAddon.Paint()
  surface.CreateFont("MyFont", {})
end

hook.Add("HUDPaint", "x", MyAddon.Paint)
`,
    },
    'lua/autorun/client/cl_named.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /surface\.CreateFont/);
});

test('a short timer counts as hot and says how often it runs', () => {
  const found = hotFindings(
    {
      'lua/autorun/server/sv_timer.lua': `
timer.Create("myaddon.tick", 0.1, 0, function()
  file.Read("data/x.txt")
end)
`,
    },
    'lua/autorun/server/sv_timer.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /every 0\.1s/);
});

test('a guard around a registration does not excuse the callback', () => {
  // The condition decides whether the hook is added, not how often it runs.
  const found = hotFindings(
    {
      'lua/autorun/client/cl_guarded.lua': `
if not MyAddon.Registered then
  MyAddon.Registered = true
  hook.Add("HUDPaint", "x", function()
    surface.SetMaterial(Material("a.png"))
  end)
end
`,
    },
    'lua/autorun/client/cl_guarded.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Material/);
});

test('an IsValid early return does not exempt the rest of the callback', () => {
  // A validity guard skips a frame where the object is gone. It says nothing
  // about how often the rest runs.
  const found = hotFindings(
    {
      'lua/autorun/client/cl_valid.lua': `
hook.Add("HUDPaint", "x", function()
  if not IsValid(LocalPlayer()) then return end
  surface.SetMaterial(Material("a.png"))
end)
`,
    },
    'lua/autorun/client/cl_valid.lua',
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Material/);
});

test('two single-file entities in one directory stay separate classes', () => {
  const found = hotFindings(
    {
      // Both are single-file classes sitting in lua/entities/.
      'lua/entities/turret_a.lua': `
function ENT:Think()
  self:Scan()
end
`,
      'lua/entities/turret_b.lua': `
function ENT:Scan()
  util.TableToJSON({})
end
`,
    },
    'lua/entities/turret_b.lua',
  );
  assert.deepEqual(found, [], 'b:Scan is not reachable from a:Think');
});

test('a client hot path does not walk into a serverside definition', () => {
  const found = hotFindings(
    {
      'lua/autorun/server/sv_impl.lua': `
MyAddon = MyAddon or {}
function MyAddon.Refresh()
  ents.FindByClass("prop_physics")
end
`,
      'lua/autorun/client/cl_hud.lua': `
hook.Add("HUDPaint", "x", function()
  MyAddon.Refresh()
end)
`,
    },
    'lua/autorun/server/sv_impl.lua',
  );
  assert.deepEqual(found, [], 'the client cannot reach the serverside body');
});

test('a timer that fires a fixed number of times is not a hot path', () => {
  const found = hotFindings(
    {
      'lua/autorun/server/sv_once.lua': `
timer.Create("myaddon.once", 0.1, 1, function()
  file.Read("data/x.txt")
end)
`,
    },
    'lua/autorun/server/sv_once.lua',
  );
  assert.deepEqual(found, []);
});

test('a timer slow enough not to matter is not a hot path', () => {
  const found = hotFindings(
    {
      'lua/autorun/server/sv_slow.lua': `
timer.Create("myaddon.slow", 60, 0, function()
  file.Read("data/x.txt")
end)
`,
    },
    'lua/autorun/server/sv_slow.lua',
  );
  assert.deepEqual(found, []);
});

test('the hot path rule can be switched off', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/autorun/client/cl_off.lua': `hook.Add("HUDPaint", "x", function() Material("a.png") end)`,
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, perfHotPath: 'off' },
  };
  const found = diagnose(analyses['lua/autorun/client/cl_off.lua'], api, workspace, settings, {});
  assert.deepEqual(found.filter((d) => d.code === 'perf-hot-path'), []);
});

/** The hoist quick fix for the first perf finding in a single-file fixture. */
function hoistFix(source, name = 'lua/autorun/client/cl_fix.lua') {
  const { workspace, analyses } = makeWorkspace({ [name]: source });
  const analysis = analyses[name];
  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS, {}).filter(
    (d) => d.code === 'perf-hot-path',
  );
  if (!found.length) return { analysis, found, action: undefined };
  const actions = codeActions(analysis, found[0].range, found, { api, workspace });
  return { analysis, found, action: actions.find((a) => a.title.startsWith('Hoist')) };
}

/** A range covering the whole file, the way `glua lint --fix` asks. */
function wholeFile(analysis) {
  return {
    start: { line: 0, character: 0 },
    end: analysis.lines.positionAt(analysis.text.length),
  };
}

/** Applies a code action's edits to the source it came from. */
function applyEdits(source, edits) {
  const lines = source.split('\n');
  const at = (position) =>
    lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) +
    position.character;
  return [...edits]
    .sort((a, b) => at(b.range.start) - at(a.range.start))
    .reduce(
      (text, edit) => text.slice(0, at(edit.range.start)) + edit.newText + text.slice(at(edit.range.end)),
      source,
    );
}

test('a hoistable hot path call offers to move it out of the frame', () => {
  const source = `-- header
local a = 1

hook.Add("HUDPaint", "x", function()
  surface.SetMaterial(Material("materials/icons/cog.png"))
end)
`;
  const { analysis, action } = hoistFix(source);

  assert.ok(action, 'expected a hoist action');
  const edits = action.edit.changes[analysis.uri];
  assert.equal(edits.length, 2);
  assert.match(edits[0].newText, /^local mat_cog = Material\("materials\/icons\/cog\.png"\)\n$/);
  assert.equal(edits[1].newText, 'mat_cog');
  // The declaration has to land above the use for the closure to capture it.
  assert.ok(edits[0].range.start.line < edits[1].range.start.line);
});

test('a hoist stays below a realm guard and inside its own block', () => {
  const source = `if SERVER then return end

if CLIENT then
  hook.Add("HUDPaint", "x", function()
    surface.SetTexture(surface.GetTextureID("icon"))
  end)
end
`;
  const { analysis, action } = hoistFix(source, 'lua/autorun/sh_guarded.lua');
  assert.ok(action, 'expected a hoist action');

  const applied = applyEdits(source, action.edit.changes[analysis.uri]);
  const lines = applied.split('\n');
  const declaration = lines.findIndex((line) => line.includes('local tex_icon ='));

  assert.ok(declaration > lines.indexOf('if SERVER then return end'), 'must stay below the guard');
  assert.ok(declaration > lines.indexOf('if CLIENT then'), 'must stay inside the CLIENT branch');
  assert.match(lines[declaration], /^ {2}local tex_icon = surface\.GetTextureID\("icon"\)$/);
  assert.match(applied, /surface\.SetTexture\(tex_icon\)/);
});

test('two hoists in one batch get names that do not collide', () => {
  // `glua lint --fix` applies every preferred action from one call together.
  const source = `hook.Add("HUDPaint", "x", function()
  surface.SetMaterial(Material("foo/icon.png"))
  surface.SetMaterial(Material("bar/icon.png"))
end)
`;
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/client/cl_two.lua': source });
  const analysis = analyses['lua/autorun/client/cl_two.lua'];
  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS, {}).filter(
    (d) => d.code === 'perf-hot-path',
  );
  assert.equal(found.length, 2);

  const hoists = codeActions(analysis, wholeFile(analysis), found, { api, workspace }).filter(
    (action) => action.title.startsWith('Hoist'),
  );
  assert.equal(hoists.length, 2);

  const names = hoists.map((action) => action.edit.changes[analysis.uri][1].newText);
  assert.equal(new Set(names).size, 2, `both hoists picked ${names[0]}`);

  // And applying both together keeps each call site pointed at its own material.
  const applied = applyEdits(source, hoists.flatMap((a) => a.edit.changes[analysis.uri]));
  assert.match(applied, new RegExp(`local ${names[0]} = Material\\("foo/icon\\.png"\\)`));
  assert.match(applied, new RegExp(`local ${names[1]} = Material\\("bar/icon\\.png"\\)`));
});

test('a hoist is not offered when there is nothing to hoist out of', () => {
  // The call is already at file scope, so a "hoist" would move nothing.
  const { found } = hoistFix('local mat = Material("a.png")\n', 'lua/autorun/client/cl_top.lua');
  assert.deepEqual(found, []);
});

/* ------------------------------------------------------------- dead code */

test('a function nothing calls is reported once the rule is on', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_dead.lua': `
MyAddon = MyAddon or {}
function MyAddon.Used() end
function MyAddon.Never() end
MyAddon.Used()
`,
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, unusedFunction: 'hint' },
  };
  const found = diagnose(analyses['lua/myaddon/sh_dead.lua'], api, workspace, settings, {})
    .filter((d) => d.code === 'unused-function');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /MyAddon\.Never/);
});

test('a table reached through an alias is not called dead', () => {
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_alias.lua': `
MyAddon = MyAddon or {}
MyAddon.Config = MyAddon.Config or {}
function MyAddon.Config.Reload() end
`,
    'lua/autorun/server/sv_alias.lua': `
local cfg = MyAddon.Config
cfg.Reload()
`,
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, unusedFunction: 'hint' },
  };
  const found = diagnose(analyses['lua/myaddon/sh_alias.lua'], api, workspace, settings, {})
    .filter((d) => d.code === 'unused-function');
  assert.deepEqual(found, []);
});

test('dead code says nothing about methods, class hooks or off-by-default', () => {
  const files = {
    'lua/entities/my_turret/init.lua': `
function ENT:Think() end
function ENT:Helper() end
`,
    'lua/myaddon/sh_meta.lua': `
MyAddon = MyAddon or {}
function MyAddon:Method() end
`,
  };
  const { workspace, analyses } = makeWorkspace(files);
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, unusedFunction: 'hint' },
  };
  for (const name of Object.keys(files)) {
    const found = diagnose(analyses[name], api, workspace, settings, {})
      .filter((d) => d.code === 'unused-function');
    assert.deepEqual(found, [], name);
  }
  // And nothing at all with the default settings.
  assert.deepEqual(
    diagnose(analyses['lua/myaddon/sh_meta.lua'], api, workspace, DEFAULT_SETTINGS, {})
      .filter((d) => d.code === 'unused-function'),
    [],
  );
});

/* -------------------------------------------------------- call hierarchy */

test('call hierarchy answers who calls a function and what it calls', () => {
  const lib = `MyAddon = MyAddon or {}
function MyAddon.Draw()
  MyAddon.Inner()
end
function MyAddon.Inner() end
`;
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_lib.lua': lib,
    'lua/autorun/client/cl_use.lua': `hook.Add("HUDPaint", "x", function()
  MyAddon.Draw()
end)
`,
  });
  const analysis = analyses['lua/myaddon/sh_lib.lua'];
  const position = analysis.lines.positionAt(lib.indexOf('MyAddon.Draw()') + 3);

  const items = prepareCallHierarchy(analysis, position, workspace);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'MyAddon.Draw');

  const incoming = incomingCalls(items[0], workspace);
  assert.deepEqual(incoming.map((call) => call.from.name), ['HUDPaint']);
  assert.equal(incoming[0].from.detail, 'the HUDPaint hook');
  assert.equal(incoming[0].fromRanges.length, 1);

  const outgoing = outgoingCalls(items[0], workspace);
  assert.deepEqual(outgoing.map((call) => call.to.name), ['MyAddon.Inner']);
});

test('call hierarchy on a call site starts at the function it reaches', () => {
  const use = `hook.Add("Think", "x", function()
  MyAddon.Work()
end)
`;
  const { workspace, analyses } = makeWorkspace({
    'lua/myaddon/sh_work.lua': 'MyAddon = MyAddon or {}\nfunction MyAddon.Work() end\n',
    'lua/autorun/server/sv_use.lua': use,
  });
  const analysis = analyses['lua/autorun/server/sv_use.lua'];
  const position = analysis.lines.positionAt(use.indexOf('MyAddon.Work()') + 3);

  const items = prepareCallHierarchy(analysis, position, workspace);
  assert.deepEqual(items.map((item) => item.name), ['MyAddon.Work']);
});

void file;

/* --------------------------------------------------------------- fix all */

test('source.fixAll batches every safe fix and leaves the unsafe ones out', () => {
  const source = [
    'net.Start("msg")',
    'net.Send(ply)',
    '',
    'local n = 0',
    'n += 1',
    '',
    'hook.Add("HUDPaint", "demo", function()',
    '\tsurface.SetMaterial(Material("icon16/heart.png"))',
    'end)',
    '',
  ].join('\n');

  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/server/sv_all.lua': source });
  const analysis = analyses['lua/autorun/server/sv_all.lua'];
  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS, {});
  const actions = codeActions(analysis, wholeFile(analysis), found, { api, workspace });

  const fixAll = actions.filter((action) => action.kind === 'source.fixAll');
  assert.equal(fixAll.length, 1, 'exactly one action may claim the whole document on save');

  const applied = applyEdits(source, fixAll[0].edit.changes[analysis.uri]);
  assert.match(applied, /util\.AddNetworkString\("msg"\)/, 'the registration is safe');
  assert.match(applied, /n = n \+ 1/, 'the compound assignment is safe');
  assert.doesNotMatch(applied, /^local mat_/m, 'hoisting changes when the call runs');
});

test('the C-style rewrite is offered, but never applied on save', () => {
  const source = 'local n = 1\nif n != 0 && true then print(n) end\n';
  const { workspace, analyses } = makeWorkspace({ 'lua/autorun/sh_c.lua': source });
  const analysis = analyses['lua/autorun/sh_c.lua'];
  const found = diagnose(analysis, api, workspace, DEFAULT_SETTINGS, {});
  const actions = codeActions(analysis, wholeFile(analysis), found, { api, workspace });

  // `!=` is valid GLua. Rewriting it is a preference, so it stays a refactor
  // someone asks for rather than something save-on-format does to their file.
  const rewrite = actions.find((action) => action.title.includes('C-style'));
  assert.ok(rewrite, 'the rewrite should still be offered');
  assert.equal(rewrite.kind, 'refactor.rewrite');
  assert.equal(
    actions.filter((action) => action.kind === 'source.fixAll').length,
    0,
    'nothing here is a fix, so there is nothing to fix on save',
  );
});

/* ------------------------------------------------------- suppressions */

/** Codes reported for a single-file fixture. */
function codesFor(source, name = 'lua/autorun/sh_sup.lua') {
  const { workspace, analyses } = makeWorkspace({ [name]: source });
  return diagnose(analyses[name], api, workspace, DEFAULT_SETTINGS, {}).map((d) => d.code);
}

test('a suppression that silenced nothing is reported', () => {
  const codes = codesFor('-- glua-ignore unused-local\nlocal count = 1\nprint(count)\n');
  assert.ok(codes.includes('unused-suppression'), codes.join(', '));
});

test('a suppression that silenced something is not reported', () => {
  const codes = codesFor('-- glua-ignore unused-local\nlocal spare = 1\n');
  assert.ok(!codes.includes('unused-local'), 'it should still be silenced');
  assert.ok(!codes.includes('unused-suppression'), codes.join(', '));
});

test('a settings key where a code belongs silences nothing, and says so', () => {
  // This used to fall through to "no rules named", which means *every* rule on
  // the line — so a mistake that looks specific silenced everything.
  const codes = codesFor('-- glua-ignore unusedLocal\nlocal spare = 1\n');
  assert.ok(codes.includes('unused-local'), `the finding must come back: ${codes.join(', ')}`);
  assert.ok(codes.includes('unused-suppression'), codes.join(', '));
});

test('prose after a bare glua-ignore still silences the line', () => {
  const codes = codesFor('-- glua-ignore because this is a deliberate stub\nlocal spare = 1\n');
  assert.deepEqual(codes, [], `nothing should be reported: ${codes.join(', ')}`);
});

test('a rule code with no hyphen in it works like any other', () => {
  const source = 'hook.Add("PlayerInitialSpawn", "x", function(ply)\n\t-- glua-ignore deprecated\n\tprint(ply:Name())\nend)\n';
  assert.ok(codesFor(source).length === 0, 'deprecated should be silenced and the directive used');

  const without = codesFor(
    'hook.Add("PlayerInitialSpawn", "x", function(ply)\n\tprint(ply:Name())\nend)\n',
  );
  assert.ok(without.includes('deprecated'), 'the fixture has to produce one to silence');
});

test('a file that does not parse reports no dead suppressions', () => {
  // A parse error stops most rules from running, so every directive in the file
  // would look dead when the truth is that nothing got to fire.
  const codes = codesFor('-- glua-ignore unused-local\nlocal spare = \n');
  assert.ok(codes.includes('syntax'), codes.join(', '));
  assert.ok(!codes.includes('unused-suppression'), codes.join(', '));
});

test('the unused-suppression rule can be switched off', () => {
  const name = 'lua/autorun/sh_off.lua';
  const { workspace, analyses } = makeWorkspace({
    [name]: '-- glua-ignore unused-local\nlocal count = 1\nprint(count)\n',
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, unusedSuppression: 'off' },
  };
  const codes = diagnose(analyses[name], api, workspace, settings, {}).map((d) => d.code);
  assert.deepEqual(codes, []);
});
