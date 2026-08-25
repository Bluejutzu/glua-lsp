# GLua for Garry's Mod

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/blight.glua.svg)](https://marketplace.visualstudio.com/items?itemName=blight.glua)
[![Open VSX](https://img.shields.io/open-vsx/v/blight/glua?label=open%20vsx)](https://open-vsx.org/extension/blight/glua)
[![npm](https://img.shields.io/npm/v/glua-cli?label=npm%20glua-cli)](https://www.npmjs.com/package/glua-cli)
[![CI](https://github.com/Bluejutzu/glua-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/Bluejutzu/glua-lsp/actions/workflows/ci.yml)

Unofficial language support for Garry's Mod Lua in VS Code, Cursor and VSCodium.
IntelliSense that follows your values, diagnostics that catch realm and net
message bugs before you launch the game, and a formatter.

Backed by 5,586 API entries scraped from the Garry's Mod wiki, plus an index of
your own workspace. Nothing is fetched at runtime.

[Install](#install) · [Quick start](#quick-start) ·
[Documentation](https://glua.bluejutzu.dev) ·
[Releases](https://github.com/Bluejutzu/glua-lsp/releases/latest)

## Install

```bash
code --install-extension blight.glua
```

```bash
cursor --install-extension blight.glua
```

VSCodium, Gitpod, Theia and Windsurf pull from
[Open VSX](https://open-vsx.org/extension/blight/glua), which carries the
same build. For anything else, grab `glua-<version>.vsix` from the
[latest release](https://github.com/Bluejutzu/glua-lsp/releases/latest) and
install the file directly:

```bash
code --install-extension glua-<version>.vsix
```

Every push to `main` also attaches a build to its
[CI run](https://github.com/Bluejutzu/glua-lsp/actions/workflows/ci.yml), if you
want a fix before it is tagged.

Full instructions, including building from source:
**[glua.bluejutzu.dev/installation](https://glua.bluejutzu.dev/installation)**

## Quick start

Open a `.lua` file inside a Garry's Mod addon. The status bar shows the realm it
worked out — `GLua · Server` — and that is the whole setup.

From there, completion follows your values rather than matching words:

```lua
local ply = player.GetByID(1)
ply:Nick()                        -- Player, so Player and Entity methods

local turret = ents.Create("my_turret")
turret:GetAmmo()                  -- your entity's own NetworkVar accessor

hook.Add("PlayerSay", "greet", function(sender, text)
    sender:Kick("bye")            -- typed from the wiki's PlayerSay signature
end)                              -- and flagged, because Kick is serverside only
```

Two things worth turning on straight away. Format on save, in `settings.json`:

```json
{
  "[glua]": {
    "editor.defaultFormatter": "blight.glua",
    "editor.formatOnSave": true
  }
}
```

And a committed config, so your team shares one set of rules — run
`GLua: Create Linter Config File` from the command palette to seed a `.glua.json`
from whatever you already have set.

A longer tour, with the net message and realm checks in context:
**[glua.bluejutzu.dev/quickstart](https://glua.bluejutzu.dev/quickstart)**

## Features

### IntelliSense that tracks types

Completion follows values through calls, loops, callbacks and metatables.

```lua
local ply = player.GetByID(1)        -- Player: Player methods + inherited Entity ones
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

It keeps working while you type. The parser always returns a tree, so a
half-written `ply:` still resolves instead of falling back to a word list.

### Typing your own functions

Lua has no type syntax, so a parameter in your own code has nothing to go on.
Two ways round that, and you can use either.

**Annotations** — the same `---@param` dialect as the Lua Language Server, so
anything you already have works, and anything you write here works there:

```lua
---@param ply Player
---@param reason string
---@return boolean
local function punish(ply, reason)
  ply:Kick(reason)
end

---@type Player
local target = nil
```

`@param`, `@return`, `@type`, `@class`, `@field`, `@deprecated`. Unions
(`Entity|nil`), optionals (`count?`), arrays (`Entity[]`), `table<string, Player>`.

**Or nothing at all** — unannotated parameters get typed from how they're used:

```lua
local function canPlace(ply)
  return ply:IsAdmin()       -- IsAdmin only exists on Player, so ply is a Player
end

local function move(ent)
  ent:SetPos(ent:GetPos())   -- shared by many classes, so: Entity
end
```

Ambiguous method sets fall back to the common base class; unrecognisable ones
stay `any` rather than guessing. An explicit `---@param` always wins.

### Your own entity and weapon classes

A scripted class is named by where its files sit, so `lua/entities/my_turret/`
defines `my_turret`. Spawning one gives you that class rather than a bare entity.

```lua
local turret = ents.Create("my_turret")

turret:Explode()   -- a method the entity defines on ENT
turret:GetAmmo()   -- an accessor from its NetworkVar
turret:SetModel()  -- and the whole Entity API underneath
```

The class name completes inside the string, and go-to-definition on it opens the
class. Same for weapons, `ents.FindByClass`, `weapons.Get` and `Player:Give`.
Engine classes like `prop_physics` stay a plain `Entity`.

### Realm awareness

Files get a realm from their path (`lua/autorun/client/`, `cl_init.lua`, `sv_`
prefixes, entity and vgui directories), and `if SERVER then` narrows it further.

- Calling `Player:Kick` from a clientside file is flagged before you run it
- Serverside-only functions don't appear in completion in clientside files
- Hover tells you when what you're looking at can't exist where you are

Path-based realms are treated as certain. Filename prefixes are a convention
people break, so those findings are informational rather than warnings.

### Net message analysis

Both halves of a net message live in different files and usually different
realms. The workspace index connects them.

- `net.Start` on a message never passed to `util.AddNetworkString`
- `net.Start` never followed by `net.Send` / `Broadcast` / `SendToServer`
- `net.Receive` for a message nothing sends, and the reverse
- **Payload mismatches** — the `net.Write*` sequence checked against the
  `net.Read*` calls in the matching handler, across files
- Completion of known message names inside `net.Start` / `net.Receive`
- Rename a message and every `AddNetworkString`, `Start` and `Receive` follows
- `GLua: Show Net Message Graph` lays the whole thing out as a table

### Hooks

- Hook name completion in `hook.Add`, from the wiki plus custom hooks your
  workspace fires with `hook.Run`
- Typo detection with edit-distance quick fixes — `"PlayerSpawned"` isn't a hook
- Callback parameters typed from the hook's documented signature
- Callbacks declaring more parameters than the hook passes
- `gameevent.Listen` registrations count as valid hook names
- `function ENT:` / `function SWEP:` / `function PANEL:` complete the right hook
  table and insert a full stub

### Hot path analysis

The mistakes that cost a server its tick rate are structural: a `Material`
lookup or an entity sweep is fine on its own and ruinous four calls below
`HUDPaint`. The workspace index builds a call graph, walks it from everything
the engine runs on a schedule, and reports what it finds on the way.

```lua
hook.Add("HUDPaint", "myaddon.hud", function()
  MyAddon.DrawBars()
end)

function MyAddon.DrawBars()
  surface.SetMaterial(Material("myaddon/bar.png"))  -- reported, with the chain
  for _, ply in ipairs(player.GetAll()) do          -- that reaches it
```

- Entry points are the per-frame and per-tick hooks, `ENT:Think`, `SWEP:DrawHUD`,
  `PANEL:Paint` and friends, and any `timer.Create` that repeats forever at 0.5s
  or less
- About forty calls count as expensive: registration that should happen once,
  disk and database and HTTP, serialisation, map-wide entity sweeps, string
  lookups like `Material`, and `net.Start` / `SetNW*`
- A function that rate-limits itself — a `CurTime()` guard, a `nextThink` field,
  a one-time `if not x then` gate — is not a hot path, and neither is anything it
  reaches
- `Material("...")` with a literal argument gets a quick fix that hoists it out
  of the frame, without moving it past a realm guard
- `glua doctor` lists the findings furthest from their entry point, which are
  the ones nobody spots by reading one file

### Cross-file navigation

`MyAddon.Config` completes, resolves and renames across files. `include()` and
`AddCSLuaFile()` paths resolve to real files, so go-to-definition works on them.
A clientside file that's `include`d but never `AddCSLuaFile`d gets flagged, with
a quick fix.

### Formatter

Reprints from the syntax tree, with two rules that make it safe on other
people's code: it refuses to touch a file that doesn't parse, and it never drops
a comment — anything it can't place makes that one statement fall back to its
original text.

Idiomatic one-liners stay one-liners:

```lua
if not IsValid(ent) then return end   -- not expanded to three lines
```

Set it as your formatter for GLua files:

```json
"[glua]": { "editor.defaultFormatter": "blight.glua" }
```

### Other diagnostics

Undefined globals (respecting `if someAddon and ...` guards, since that's how
you depend on an optional addon), unused locals, functions nothing in the
workspace ever calls (off by default — a library is full of those on purpose),
deprecated API use, argument counts and types against documented signatures — including overloads like
`surface.SetDrawColor(r, g, b, a)` vs `surface.SetDrawColor(color)`.

### Everything else

Hover, signature help with overloads, go-to-definition, find references, rename,
document highlights, document and workspace symbols, call hierarchy over the
whole workspace, semantic highlighting, inlay parameter hints, and code actions:

- rewrite `x += 1` as `x = x + 1` (GLua has no compound assignment)
- convert C-style operators (`!=`, `&&`, `||`, `!`) to Lua, whole document
- hoist a repeated `math.floor` into `local math_floor = math.floor`
- add a missing `util.AddNetworkString`, `net.Receive` stub, or `AddCSLuaFile`
- wrap a cross-realm call in `if SERVER then ... end`

### It leaves other Lua projects alone

This doesn't claim `.lua` in `package.json`. Anything that claims `.lua` globally
ends up fighting over Love2D, Luau and Neovim workspaces, so it only adopts a
file when the workspace actually looks like GMod — a `lua/` tree, `addon.json`, a
`gamemodes/` directory, or GMod-only API use in the file itself. `glua.activation`
switches that to `always` or `never`, and the status bar item toggles it per file.

## On the command line

The same parser, analyser and formatter run outside the editor as
[`glua-cli`](https://www.npmjs.com/package/glua-cli), so a finding in CI is the
finding you saw while writing it. It bundles everything, including the wiki
dataset, and pulls in no dependencies of its own.

```bash
pnpm add -D glua-cli
```

```bash
glua lint lua/ --format github
glua lint lua/ --format sarif > glua.sarif
glua fmt lua/ --check
```

`--format github` emits workflow annotations, so findings land on the diff of a
pull request. `--format sarif` writes SARIF 2.1.0 for GitHub code scanning,
which gives findings a history and somewhere to be dismissed rather than a log
line that disappears with the run.
[Full reference](https://glua.bluejutzu.dev/reference/cli).

## Configuration

Everything is configurable three ways, and they layer.

**In the UI.** Every option is a VS Code setting — `GLua: Open Settings`, or
search `@ext:blight.glua` in the settings editor.

**In a committed config file**, so the whole team gets the same rules. Two
commands seed one from whatever you've already set in the UI:

- `GLua: Create Linter Config File` → `.glua.json`
- `GLua: Create Formatter Config File` → `.gluafmtrc.json`

Both get full IntelliSense — completion, descriptions and validation come from
bundled JSON schemas.

```jsonc
// .glua.json
{
  // Addons outside this workspace, so they aren't reported as undefined.
  "globals": ["ULib", "ulx"],

  "diagnostics": {
    "unusedLocal": "off",
    "realmViolation": "error"
  },

  // Rules can vary by path.
  "overrides": [
    {
      "files": ["lua/vendor/**"],
      "diagnostics": { "undefinedGlobal": "off" }
    }
  ]
}
```

```jsonc
// .gluafmtrc.json
{
  "useTabs": true,
  "indentSize": 4,
  "maxLineWidth": 120,
  "quoteStyle": "double",
  "keepSingleLineBlocks": true,
  "overrides": [
    { "files": ["lua/vendor/**"], "options": { "maxLineWidth": 200 } }
  ]
}
```

**Inline**, when one finding is wrong and the rule isn't:

```lua
-- glua-ignore                          next line, every rule
-- glua-ignore realm-violation          next line, one rule
foo()  -- glua-ignore unused-local      this line
-- glua-disable net-unregistered        from here on
-- glua-enable net-unregistered         until here
-- glua-disable-file                    the whole file
```

### Existing config files

If your repo already pins formatting, it's read rather than ignored:

| Source | Read from |
| --- | --- |
| `.editorconfig` | `indent_style`, `indent_size`, `max_line_length`, `end_of_line` |
| `.prettierrc` | `useTabs`, `tabWidth`, `printWidth`, `singleQuote`, `endOfLine`, `semi` |

Precedence, lowest to highest: built-in defaults → editor settings →
`.editorconfig` → `.prettierrc` → `.glua.json` → `.gluafmtrc.json`. Generic tools
get read because you shouldn't have to say the same thing twice; anything written
specifically for GLua wins over them.

## Performance

Measured on a 932-file, 232,000-line gamemode:

| | |
| --- | --- |
| Cold index | 4.8 s (~48k lines/sec), batched so it doesn't block |
| Retained heap | 59 MB — syntax trees are dropped for files you don't have open |
| Re-analyse a 3,200-line file on edit | 31 ms |
| Completion | 1.2 ms (member), 4.1 ms (global scope) |
| Diagnostics | 3.5 ms |

Parse errors on that codebase: 0.

## Development

```bash
pnpm install
pnpm run build
```

Then <kbd>F5</kbd>. That opens a window on
`packages/glua-lsp/examples/my_addon`, which exercises most of this;
`lua/autorun/sh_mistakes.lua` in it is wrong on purpose, one mistake per
diagnostic.

```bash
pnpm test                                   # parser, analysis, features, formatter, performance
pnpm run typecheck                          # TypeScript 7
pnpm run watch                              # rebuild on change
pnpm run bench -- path/to/a/gmod/addon      # run it against a real codebase
pnpm run generate-api                       # rebuild the wiki dataset after a GMod update
pnpm run docs                               # serve the docs site locally
```

`pnpm run bench` prints index time, memory, per-feature latency, and every
diagnostic grouped by rule with an example of each. It's the quickest way to see
whether a change made the output noisier.

### Releasing

```bash
pnpm run release minor      # or patch, major, or an explicit 0.2.0
git push origin main --follow-tags
```

That bumps the manifest, commits, and tags. Pushing the tag runs the release
workflow: typecheck, test, build, package, then a GitHub release with the
`.vsix` attached and notes generated from the commits since the last tag. The
workflow refuses to build if the tag and the manifest version disagree.

### Layout

```
packages/glua-lsp/
  src/parser/     lexer, AST, error-tolerant parser
  src/analyze/    scopes, type inference, realm rules, workspace index, call graph
  src/format/     the formatter
  src/config/     config file loading and precedence
  src/api/        the wiki dataset and lookups over it
  src/server/     LSP handlers, one file per feature
  src/client/     the VS Code extension
  tools/          the wiki scraper, and the terminal colour palette
docs/             the Mintlify site
scripts/          the release helper
.github/          CI and release workflows
```

## Known limits

- Type inference is shallow and unsound on purpose. It answers "what can follow
  this dot" and "is this argument obviously wrong", and stays quiet otherwise.
  Metatable tricks and dynamic dispatch aren't followed.
- Reanalysis is whole-file. Incremental reparsing would help past a few thousand
  lines, but at 31 ms behind a 250 ms debounce it hasn't been worth it.
- The wiki is the source of truth for the API, so gaps there are gaps here.
  Argument checks are skipped for the Lua standard library, whose documented
  signatures aren't precise enough to check against — `table.insert` is only
  documented in its three-argument form, `math.atan` only in its one-argument
  form, and both omitted forms are everywhere in real code.
- Realm inference can't know a `cl_` file is also included serverside, which is
  why prefix-based findings are informational.

## Prior art

Heavily inspired by
[`vscode-glua-enhanced`](https://github.com/WilliamVenner/vscode-glua-enhanced),
which is where a lot of these ideas come from — wiki-backed completion, realm
flags, net message discovery. Go use it.

This is another go at the same problem from a different angle: a language server
with a parser and a type model under it, rather than providers in the extension
host. That's the structural difference, and most of what's above follows from it.

## Licence

MIT. The API documentation content belongs to Facepunch and the wiki
contributors.

## A note on how this was built

AI assistance was used throughout this project, from the parser to these docs.
It isn't meant to be a big, load-bearing tool — it's a project built to
understand how language servers and CLIs actually work, from the inside.
