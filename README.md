# GLua Language Server

A language server for Garry's Mod Lua — parser, scope tracking, type inference,
workspace index, the usual LSP stack.

It's backed by 5,586 API entries scraped from the GMod wiki (331 globals, 1,257
library functions, 2,376 class methods, 551 hooks, 1,069 panel methods, 100
enums, 72 structures), plus an index of your own workspace so it knows what your
addon defines too.

## Where this came from

[`vscode-glua-enhanced`](https://github.com/WilliamVenner/vscode-glua-enhanced)
is where most of these ideas come from — wiki-backed completion, realm flags, net
message discovery, the whole shape of what GMod tooling should do. Go use it.

This is another go at the same problem from a different angle: a language server
with a parser and a type model under it, instead of providers running in the
extension host. That's really the only structural difference, but a lot follows
from it. Resolving `ply:` means knowing `ply` came from `player.GetByID(1)` a few
lines up. Resolving `frame:` means following `vgui.Create("DFrame")` to the
`DFrame` class. Both have to work while you're mid-keystroke and the code isn't
valid Lua yet.

None of that is a Lua problem, for the record. It just needs the standard
language server plumbing, which is what this repo is.

## How it's put together

```
lexer  ->  error-tolerant parser  ->  binder (scopes + types + facts)  ->  workspace index
```

The parser always returns a tree, no matter how broken the input. Half-typed code
gets real nodes with `missing` holes instead of an exception:

```lua
local ply = player.GetByID(1)
ply:            -- MemberExpression, missing identifier, base still resolves to Player
```

That one property is what lets completion, hover and signature help keep working
on the line you're editing. There are tests for it in `test/parser.test.mjs`.

## What it does

### Types follow values

```lua
local ply = player.GetByID(1)        -- Player|NULL -> Player methods + inherited Entity ones
local frame = vgui.Create("DFrame")  -- DFrame, read out of the string literal
for _, p in ipairs(player.GetAll()) do
  p:Nick()                           -- Player, through ipairs
end

hook.Add("PlayerSay", "x", function(sender, text)
  sender:Nick()                      -- typed from the wiki's PlayerSay signature
end)

function ENT:Initialize()
  self:SetModel(...)                 -- Entity here; Weapon in a SWEP, Panel in a PANEL
end
```

### Typing your own function parameters

Lua has no type syntax, so a parameter in one of your own functions has nothing
to go on. Two ways around that.

**Annotations.** Same `---@param` dialect the Lua Language Server uses, so
anything already annotated for LuaLS works here, and anything you write here
keeps working there:

```lua
---@param ply Player
---@param reason string
---@return boolean
local function punish(ply, reason)
  ply:Kick(reason)   -- ply: completes Player methods
end

---@type Player
local target = nil   -- overrides whatever the initialiser looked like
```

`@param`, `@return`, `@type`, `@class`, `@field` and `@deprecated` are read.
Unions (`Entity|nil`), optionals (`count?`, `Player?`), arrays (`Entity[]`) and
`table<string, Player>` all parse. A `@param` with no type — `--- @param ply the
player who did it` — is left alone as documentation rather than being read as a
type called `the`.

**Or don't annotate anything.** Parameters with no annotation get typed from the
methods called on them:

```lua
local function canPlace(ply)
  return ply:IsAdmin()   -- IsAdmin only exists on Player, so ply is a Player
end

local function move(ent)
  ent:SetPos(ent:GetPos())   -- shared by lots of classes, so: Entity
end
```

When the method set matches several classes it picks the one the others inherit
from, and when it matches nothing recognisable it stays `any` rather than
guessing. An explicit `---@param` always wins over this.

### Realms

Every file gets a realm from its path (`lua/autorun/client/`, `cl_init.lua`,
`sv_` prefixes, entity/effect/vgui directories), and `if SERVER then` blocks
narrow it further. That gets used for:

- Diagnostics — calling `Player:Kick` from a clientside file gets flagged before
  you launch the game.
- Completion filtering — serverside-only functions don't show up in clientside
  files.
- Hover — a note when the thing you're hovering can't exist where you are.

Path-based realms (`cl_init.lua`, `lua/autorun/server/`) are treated as certain.
Filename prefixes (`cl_`, `sv_`) are a convention people break all the time, so
those get reported as information instead of warnings.

### Net messages

The two halves of a net message live in different files and usually different
realms, so the editor normally has nothing tying them together. The workspace
index does:

- `net.Start` on a message never passed to `util.AddNetworkString`
- `net.Start` never followed by `net.Send` / `Broadcast` / `SendToServer`
- `net.Receive` for a message nothing sends, and the reverse
- payload mismatches — the `net.Write*` sequence checked against the `net.Read*`
  calls in the matching handler, across files
- completion of known message names inside `net.Start` / `net.Receive`
- rename a message, and every `AddNetworkString`, `Start` and `Receive` follows
- `GLua: Show Net Message Graph` dumps the whole picture as a table

### Hooks

- hook name completion inside `hook.Add`, from the wiki plus any custom hook your
  workspace fires with `hook.Run`
- typo detection with edit-distance quick fixes — `"PlayerSpawned"` isn't a hook
- callback parameters typed from the hook's documented signature
- callbacks that declare more parameters than the hook actually passes
- `gameevent.Listen` registrations count as valid hook names
- `function ENT:` / `function SWEP:` / `function PANEL:` complete the right hook
  table and drop in a full stub

### Cross-file

`MyAddon.Config` completes, resolves and renames across files. `include()` and
`AddCSLuaFile()` paths resolve to real files, so go-to-definition works on them.
A clientside file that gets `include`d but never `AddCSLuaFile`d gets flagged,
with a quick fix that adds the call.

### Other diagnostics

Undefined globals (with `if someAddon and ...` guards respected, since that's how
you depend on an optional addon), unused locals, deprecated API use, argument
counts and types against documented signatures — including overloads like
`surface.SetDrawColor(r, g, b, a)` vs `surface.SetDrawColor(color)`.

Every rule has its own severity setting, and any of them can be turned off.

### It leaves other Lua projects alone

This doesn't claim `.lua` in `package.json`. Anything that claims `.lua` globally
ends up fighting over Love2D, Luau and Neovim workspaces, so instead it only
adopts a file when the workspace actually looks like GMod — a `lua/` tree,
`addon.json`, a `gamemodes/` directory, or GMod-only API use in the file itself.
`glua.activation` switches that to `always` or `never`, and the status bar item
toggles it per file.

Same reasoning behind registering a `glua` language id rather than redefining
`lua`: it should sit next to your other Lua extensions, not replace them.

### Editor features

Completion, hover, signature help (with overloads), go-to-definition, find
references, rename, document highlights, document and workspace symbols, semantic
highlighting, inlay parameter hints, folding, and code actions:

- rewrite `x += 1` as `x = x + 1` (GLua has no compound assignment)
- convert C-style operators (`!=`, `&&`, `||`, `!`) to Lua, whole document
- hoist a repeated `math.floor` into `local math_floor = math.floor`
- add a missing `util.AddNetworkString`, `net.Receive` stub, or `AddCSLuaFile`
- wrap a cross-realm call in `if SERVER then ... end`

## Numbers

Run against a 932-file, 232,000-line gamemode:

| | |
| --- | --- |
| Cold index | 6.4 s (~36k lines/sec), batched so it doesn't block the server |
| Retained heap | 58 MB — syntax trees get dropped for files you don't have open |
| Re-analyse a 3,200-line file on edit | 33 ms |
| Completion | 1.3 ms (member), 5.9 ms (global scope) |
| Diagnostics | 4.7 ms |
| Cross-file index rebuild | 26 ms |

Parse errors on that codebase: 0.

Running it on real code changed a bunch of things. It turned up a
left-associativity bug in the precedence table, a BOM at the start of 100 files,
Vector arithmetic being inferred as `number`, and the wiki's nested `<callback>`
blocks getting flattened into the parent function's parameters — which made
`concommand.Add` look like it took eight arguments. Diagnostics on a 200-file
sample went from 1,547 (mostly noise) to 688 (mostly real) once those were fixed.

If you point it at your own addon and it says something dumb, that's a bug — the
bench script below prints a breakdown of every rule that fired so it's easy to
tell noise from real findings.

## Running it

```bash
pnpm install
pnpm run build
```

Then hit <kbd>F5</kbd>. That opens a new window on `examples/my_addon`, a small
addon that exercises most of this. `lua/autorun/sh_mistakes.lua` in there is
wrong on purpose — one mistake per diagnostic, so you can see what each looks
like.

## Refreshing the API data

The dataset is checked in, so nothing hits the network at install or run time.
After a GMod update:

```bash
pnpm run generate-api
```

It reads `wiki.facepunch.com/gmod/~pagelist?format=json`, fetches every API page
as JSON, and parses the structured `markup` field. Responses get cached in
`.cache/wiki/`, so re-runs are quick; `--fresh` forces a refetch.

## Development

```bash
pnpm test                                   # 47 tests: parser, analysis, features, performance
pnpm run typecheck                          # TypeScript 7
pnpm run watch                              # rebuild on change
pnpm run bench -- path/to/some/gmod/addon   # run it against a real codebase
```

`pnpm run bench` prints index time, memory, per-feature latency, and every
diagnostic it produced grouped by rule with an example of each. It's the quickest
way to tell whether a change made the output noisier.

### Layout

```
src/parser/     lexer, AST, error-tolerant parser
src/analyze/    scopes, type inference, realm rules, workspace index
src/api/        the wiki dataset and lookups over it
src/server/     LSP handlers, one file per feature
src/client/     the VS Code extension (activation, status bar)
tools/          the wiki scraper
```

## Known limits

- Type inference is shallow and unsound on purpose. It answers "what can follow
  this dot" and "is this argument obviously wrong", and shuts up when it isn't
  sure. Metatable tricks, `setmetatable` chains and dynamic dispatch aren't
  followed.
- Reanalysis is whole-file. Incremental reparsing would help past a few thousand
  lines, but at 33 ms behind a 250 ms debounce it hasn't been worth it yet.
- The wiki is the source of truth for the API, so gaps in the wiki are gaps here.
  Argument checks are skipped for the Lua standard library, because its
  documented signatures aren't precise enough to check against (`table.insert` is
  only documented in its three-argument form, `math.atan` only in its
  one-argument form, and both omitted forms are everywhere in real code).
- Realm inference can't know that a `cl_` file also gets included serverside,
  which is why prefix-based findings are informational rather than warnings.

## Licence

MIT. The API documentation content belongs to Facepunch and the wiki
contributors.
