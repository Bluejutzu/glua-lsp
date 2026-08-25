# GLua for Garry's Mod

Language support for Garry's Mod Lua: IntelliSense that follows your values,
diagnostics that catch realm and net message bugs before you launch the game,
and a formatter.

[Documentation](https://glua.bluejutzu.dev) ·
[Installation](https://glua.bluejutzu.dev/installation) ·
[Quick start](https://glua.bluejutzu.dev/quickstart) ·
[Source](https://github.com/Bluejutzu/glua-lsp) ·
[Releases](https://github.com/Bluejutzu/glua-lsp/releases/latest)

---

## What it does

**IntelliSense that tracks types.** Completion follows values through calls,
loops, callbacks and metatables — `vgui.Create("DFrame")` resolves to `DFrame`,
`player.GetAll()` iterates as `Player`, and `self` inside `function ENT:Think()`
is an `Entity`. It keeps working mid-keystroke, because the parser always
returns a tree.

**Realm awareness.** Every file gets a realm from its path, narrowed by
`if SERVER then` blocks. Calling `Player:Kick` from a clientside file is flagged
before you run the game, and out-of-realm functions are hidden from completion.

**Net message analysis.** The sender and the handler live in different files, so
nothing normally connects them. Unregistered messages, messages never sent,
handlers that never run, and **payload mismatches between the writes and the
reads** are all reported across files.

**Your own classes.** `ents.Create("my_turret")` is typed as that entity, so the
methods it defines on `ENT` and the accessors its `NetworkVar`s generate complete
on the result — not only on `self`.

**Hook intelligence.** Name completion, typo detection with suggestions, and
callback parameters typed from the hook's documented signature. `function ENT:`
completes the ENTITY hook table and inserts a full stub.

**A formatter.** Reprints from the syntax tree. Refuses to touch a file that
does not parse, never drops a comment, and leaves idiomatic one-liners like
`if not IsValid(ent) then return end` alone.

Backed by 5,586 API entries scraped from the Garry's Mod wiki, plus an index of
your own workspace.

## Setup

Open a `.lua` file in a Garry's Mod addon. The status bar shows the file's
realm:

```
GLua · Server
```

To use the formatter:

```json
"[glua]": {
  "editor.defaultFormatter": "blight.glua",
  "editor.formatOnSave": true
}
```

## It leaves other Lua projects alone

This extension does **not** claim `.lua` in its manifest. It only adopts a file
when the workspace actually looks like Garry's Mod — a `lua/` tree, an
`addon.json`, a `gamemodes/` directory, or GMod-only API use in the file itself.
So it will not fight your Love2D, Luau or Neovim setups.

`glua.activation` switches that to `always` or `never`, and clicking the status
bar item toggles it per file.

## Configuration

Every option is a VS Code setting, and can also live in a committed
`.glua.json` or `.gluafmtrc.json` so a whole team shares the same rules.
`.editorconfig` and `.prettierrc` are read too.

Individual findings can be suppressed inline:

```lua
-- glua-ignore unused-local
local placeholder = nil
```

[Configuration guide →](https://glua.bluejutzu.dev/configuration/overview)
· [Rule reference →](https://glua.bluejutzu.dev/reference/rules)

## Prior art

Heavily inspired by
[vscode-glua-enhanced](https://github.com/WilliamVenner/vscode-glua-enhanced),
which is where a lot of these ideas come from. This is another attempt at the
same problem as a language server, with a parser and a type model underneath.

## Licence

MIT. The API documentation content belongs to Facepunch and the wiki
contributors.
