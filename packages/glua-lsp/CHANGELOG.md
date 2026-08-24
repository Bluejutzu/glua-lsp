# Changelog

Notable changes to the GLua for Garry's Mod extension. Release notes on each
[GitHub release](https://github.com/Bluejutzu/glua-lsp/releases) list every
commit; this file covers what actually changed for you.

## Unreleased

### Added

- **`glua init`**, which writes `.glua.json` and `.gluafmtrc.json` from the
  defaults. Previously those could only be created from the VS Code command
  palette, so anyone adopting the CLI in CI had to write them by hand.
- **`glua lint --fix`**, applying the quick fixes that have one correct outcome
  — a missing `util.AddNetworkString` or `AddCSLuaFile`, a C-style compound
  assignment — and reporting the rest. `--fix-dry-run` shows the same without
  writing.
- **Asset path completion.** Material, model and sound paths complete from your
  own content and, with `glua.workspace.gamePath` set, from the game install —
  including everything packed inside VPK archives, which is nearly all of it.
  There is a matching `missingAsset` rule for paths that do not resolve, off by
  default because Workshop and content-pack assets cannot be seen from an
  editor.
- **Hooks of your own are typed.** A hook you invented has no documentation, so
  its `hook.Run` call sites are read as its signature and callbacks registered
  for it are typed from them. Positions the call sites disagree about stay
  `any`. A callback declaring more parameters than anything passes is reported,
  since the extras are always `nil`.
- **Support for editors other than VS Code.** The language server now ships as
  its own `glua-lsp` binary in the `glua-cli` npm package, so Neovim, Helix,
  Zed, Sublime Text and anything else with an LSP client get the same
  completion, diagnostics, navigation and formatting. Setup for each is on the
  [Other Editors](https://glua.bluejutzu.dev/reference/editors) page.

## 0.3.0

### Fixed

- Iterating a method that returns a list gave no completions at all —
  `for _, w in ipairs(ply:GetWeapons())` left `w` untyped, as did
  `Entity:GetChildren`, `Entity:GetMaterials` and `Panel:GetChildren`. The
  library forms like `player.GetAll()` were unaffected.
- `glua --version` reported `0.1.0` whatever version it was. Both the CLI and
  the language server now take their version from the manifest at build time.

## 0.2.4

### Changed

- `glua-cli` is now published on npm, with the formatter and linter available
  directly in the terminal.

## 0.2.3

### Added

- **Entity and weapon class awareness.** `ents.Create("my_turret")` is typed as
  that class, so its own `ENT` methods and generated accessors complete on the
  result instead of only on `self`. Class names complete inside the string, and
  go-to-definition on one opens the class. Also covers `ents.FindByClass`,
  `ents.CreateClientside`, `weapons.Get` and `Player:Give`. Engine classes like
  `prop_physics` stay a plain `Entity`.

### Changed

- The extension is listed as **GLua for Garry's Mod**. The old name was too
  close to other language servers already on the Marketplace. The extension id
  is unchanged, so existing installs and settings keep working.
- A failed Marketplace publish no longer fails the release workflow. The
  GitHub release is already out by the time that step runs, so the job summary
  reports the failure instead of leaving a half-finished release behind.

## 0.2.2

### Changed

- `pnpm run release` now rolls the `Unreleased` section into the new version
  and opens a fresh one, so a shipped release is never still described as
  unreleased.

## 0.2.1

### Fixed

- CI ran the tests before the build, so the CLI's tests failed on a clean
  checkout. Both workflows now build first.
- The light-mode code block theme was set to a dark Catppuccin variant.

### Changed

- Release notes list each change as `subject by @author in #PR`, and open with
  an install command for every supported editor.

## 0.2.0

### Added

- **Formatter.** Reprints from the syntax tree. Refuses to touch a file that
  does not parse, never drops a comment, and leaves idiomatic one-liners like
  `if not IsValid(ent) then return end` alone. Set it with
  `"[glua]": { "editor.defaultFormatter": "bluejutzu.glua-lsp" }`.
- **Config files.** `.glua.json` for rules and declared globals,
  `.gluafmtrc.json` for formatting, both with JSON schemas so they get
  completion and validation while you edit them. `.editorconfig` and
  `.prettierrc` are read too.
- **Inline suppressions.** `-- glua-ignore <rule>`, `-- glua-disable` /
  `-- glua-enable`, `-- glua-disable-file`.
- **Generated accessors.** `self:NetworkVar("Int", 0, "Ammo")` and
  `AccessorFunc` now produce working `GetAmmo`/`SetAmmo` completions, carried
  across an entity's directory.
- **Duplicate registrations.** Two `hook.Add` calls sharing an event and
  identifier, or two `timer.Create` calls sharing a name, are reported. Realms
  are taken into account, so a client and a server hook never clash.
- **Code lens.** Sender and handler counts above net messages, call sites above
  custom hooks, reference counts above globals.
- **Workspace-wide diagnostics.** `glua.diagnostics.scope: workspace` reports
  every indexed file, not only the ones you have open.
- **Annotations.** `---@param`, `---@return`, `---@type`, `---@class`,
  `---@field`, `---@deprecated`, in the Lua Language Server dialect. Parameters
  without annotations are typed from the methods called on them.
- **A command line interface**, published separately as `glua-cli`, for running
  the same linter and formatter in CI.

### Fixed

- Parentheses are recorded rather than discarded, so reprinting cannot change
  `(a + b) * c` into `a + b * c`.
- Operator precedence for left-associative operators.
- A UTF-8 BOM no longer produces a syntax error.
- Vector and Angle arithmetic infers as the class, not `number`.
- Function overloads (`surface.SetDrawColor(r, g, b, a)` and
  `surface.SetDrawColor(color)`) are both recognised.
- Argument checks are skipped for the Lua standard library, whose documented
  signatures are not precise enough to check against.

## 0.1.0

First release.

- IntelliSense driven by an error-tolerant parser and a type model, so
  completion keeps working mid-keystroke
- 5,586 API entries scraped from the Garry's Mod wiki
- Realm awareness from file paths and `if SERVER then` blocks
- Net message analysis across files, including payload mismatches
- Hook name completion, typo detection, and typed callback parameters
- Cross-file go-to-definition, find references and rename
