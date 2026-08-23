# Changelog

Notable changes to the GLua for Garry's Mod extension. Release notes on each
[GitHub release](https://github.com/Bluejutzu/glua-lsp/releases) list every
commit; this file covers what actually changed for you.

## Unreleased

_Nothing yet._

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
