import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_DATA, OUT, file, uriOf } from './fixtures.mjs';

const { GmodApi } = await import(OUT('api/index.js'));
const { Workspace } = await import(OUT('analyze/workspace.js'));
const { typeToString } = await import(OUT('analyze/types.js'));
const { scriptedClassOf } = await import(OUT('analyze/entities.js'));
const { completion } = await import(OUT('server/features/completion.js'));
const { hover } = await import(OUT('server/features/hover.js'));
const { signatureHelp } = await import(OUT('server/features/signature.js'));
const { diagnose } = await import(OUT('server/features/diagnostics.js'));
const { definition } = await import(OUT('server/features/navigation.js'));
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

void file;
