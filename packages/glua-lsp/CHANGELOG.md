# Changelog

Notable changes to the GLua for Garry's Mod extension. Release notes on each
[GitHub release](https://github.com/Bluejutzu/glua-lsp/releases) list every
commit; this file covers what actually changed for you.

## Unreleased

### Changed

- Now published under the `blight` publisher on the VS Code Marketplace and
  Open VSX. The old `bluejutzu.glua-lsp` listing is deprecated — install
  `blight.glua-lsp` instead.

## 0.5.1

_Nothing yet._

## 0.5.0

### Added

- **`unused-suppression`**, reporting a `-- glua-ignore` or `-- glua-disable`
  that never silenced anything. A suppression outlives the finding it was
  written for — the code gets fixed, the comment stays, and from then on it
  quietly covers whatever appears on that line next. Reported as a hint by
  default, and only for files that parse, since a parse error stops most rules
  from running and every directive in the file would read as dead.

### Fixed

- **A suppression naming something that is not a rule silenced every rule on the
  line.** `-- glua-ignore` followed by `unusedLocal` — the settings key where the code
  belonged — parsed as naming no rules at all, and a directive naming no rules
  means "all of them". A mistake that looked specific was the broadest
  suppression available. It now names a rule nothing reports, so it silences
  nothing and `unused-suppression` points at it. The same bug hid the two rule
  codes that have no hyphen in them, `deprecated` and `syntax`; both work now.

  A bare `-- glua-ignore` followed by prose still means the whole line.

- **A fact cache for the CLI.** Every run indexes the whole project, because
  cross-file rules are only correct once the index has seen everything — so
  linting one file means parsing the addon around it, and almost none of that
  work needed doing again. What each file contributes is now written to
  `.glua-cache`, keyed by a hash of its contents, and read back instead of
  reparsed. On a 300-file addon, `glua lint .` goes from 917ms to 622ms and
  `glua lint one-file.lua` from 385ms to 124ms.

  Facts are cached; findings never are. `net-never-received` depends on every
  other file in the project, so a cached finding would be wrong as soon as an
  unrelated file gained a `net.Receive`. Everything is recomputed from the whole
  set on every run.

  Keyed by content rather than modification time, so a checkout or a branch
  switch invalidates nothing. The directory gitignores itself, an upgrade
  discards it, and anything that goes wrong with it is a miss rather than an
  error. `--no-cache` opts out.

- **Code frames in `glua lint`.** Findings now come with the line they are about
  and the part they are about underlined. A line number is a lookup instruction,
  and in a CI log there is no file to open. `--no-code-frames` goes back to one
  line per finding; the machine formats are unchanged.

- **`--timing`**, reporting how long indexing the project took against how long
  checking the files took, and the five slowest files. Linting one file in a
  large addon still indexes everything, and this is what says so.

### Fixed

- A run reporting nothing but hints printed "✓ no problems" directly under the
  hints it had just listed. The summary now counts suggestions alongside errors
  and warnings. Exit codes are unchanged: a hint is still not a failure.

## 0.4.2

### Added

- **Every diagnostic links to its rule.** The code in the Problems panel is now
  a link to the section explaining what the rule catches and why it exists —
  `codeDescription`, so clicking through works in any editor that supports it.
  SARIF output carries the same links into GitHub code scanning, `--format json`
  gained a `url` field, and the rules page was restructured so each rule has its
  own section to land on rather than a row in a wide table. `missing-asset` was
  never documented at all; it is now.

- **`source.fixAll`**, one action that applies every safe fix in the file. Set
  `editor.codeActionsOnSave` to `source.fixAll` and saving does exactly what
  `glua lint --fix` does — no more, which is the point: hoisting a call out of a
  frame is offered from the lightbulb where you can see the result, not applied
  while you save.

- **`-- glua-format-ignore`**, which leaves the statement below it exactly as
  written. A hand-aligned lookup table reads worse after any formatter touches
  it. `-- glua-format-ignore-file` does the same for a whole file, usually a
  generated one. The directive has to be on its own line, so a trailing comment
  cannot silently protect whatever follows it.

### Changed

- Rewriting C-style operators (`!=`, `&&`, `||`, `!`) is now a refactor you
  invoke rather than a `source.fixAll` action. `!=` is valid GLua, so rewriting
  it is a preference, and preferences should not be applied to your file while
  you save. It is still offered from the lightbulb.

- The rule catalogue moved next to the analyser, so the codes on diagnostics,
  the links behind them, the SARIF `rules` array and `glua rules` all read from
  one list. A test fails if a code has no entry, or an entry has no section on
  the rules page.

## 0.4.1

### Added

- **Safe and unsafe fixes.** `glua lint --fix` now applies only the fixes that
  leave the code doing the same thing. Hoisting a `Material` call out of
  `HUDPaint` is almost always the right change, but it moves the lookup from
  every frame to the moment the file loads — not something to do to a file
  while nobody is watching, which is exactly how `--fix` runs in a hook or a CI
  job. Those fixes are counted and offered instead: `1 unsafe fix available —
  run with --unsafe-fixes to apply them`. Adding `util.AddNetworkString` counts
  as unsafe outside a server file, since the line goes to the top, above any
  realm guard. Every fix is still offered normally in the editor.

  `--fix` also counts fixes rather than the edits they are made of, so a hoist
  reads as one fix, not two.

- **A lint baseline**, so a project you inherited can adopt this without a wall
  of findings. `glua lint --suppress-all` writes `.glua-baseline.json` accepting
  everything that exists today; from then on the rules are enforced on new code
  only, and `--ignore-baseline` still shows the whole backlog. It counts findings
  per file and rule rather than recording line numbers, so ordinary edits do not
  invalidate it — a file with two unused locals accepts two, and a third is
  reported. When a covered finding is fixed the run says so, and
  `--prune-suppressions` rewrites the file to match.

- **Hot path analysis.** The workspace index now builds a call graph, walks it
  from everything the engine runs on a schedule — the per-frame and per-tick
  hooks, `ENT:Think`, `SWEP:DrawHUD`, `PANEL:Paint`, a `timer.Create` that
  repeats forever at 0.5s or less — and reports expensive work anywhere along
  it. About forty calls count:
  registration that should happen once, disk and database and HTTP,
  serialisation, map-wide entity sweeps, string lookups like `Material`, and
  `net.Start` / `SetNW*`. The message names the chain that reaches the call, so
  a finding four functions and two files away from its hook explains itself. A
  function that rate-limits itself — a `CurTime()` guard, a `nextThink` field, a
  one-time `if not x then` gate — is not a hot path, and neither is anything it
  reaches. Two things are deliberately not guards: one around a *registration*
  says nothing about the callback it registers, and a validity check like
  `if not IsValid(ent) then return end` skips a frame rather than limiting how
  often the rest runs. `Material("...")` with a
  literal argument gets a quick fix that hoists it out of the frame, placed
  inside whatever guard the call site was already under so a shared file's realm
  checks still hold. Rule `perf-hot-path`, keyed `perfHotPath`, on as a
  warning.
- **Call hierarchy**, over the same graph: who calls this function across the
  workspace, and what it calls. Callbacks are named after what registers them,
  so a chain ending in a render hook says so. Calls made through a value rather
  than a name are left out rather than guessed at.
- **Dead code detection.** `unused-function` reports functions this workspace
  defines and never calls, references or registers. Methods defined with a
  colon, scripted class hooks and anything extending an API library are exempt,
  since those are reached through a value. Off by default — an addon meant to be
  extended by other addons is full of them on purpose — but `glua doctor` lists
  them either way.
- **`glua lint --format sarif`**, writing SARIF 2.1.0 for GitHub code scanning.
  Findings get a history, somewhere to be dismissed, and a diff against the base
  branch, rather than an annotation that disappears with the workflow run.
- The project report gained **Hot paths** and **Never called** sections, in the
  editor, the HTML file and the terminal.

## 0.4.0

### Added

- **Project report.** `glua doctor`, or `GLua: Project Report` in the editor,
  answers what shape a codebase is in rather than what is wrong with one line:
  net message health, hook and timer collisions, unknown globals ranked by use,
  the largest scripted classes, and the files worth looking at first. Also
  `--format html` for a self-contained file to attach to a pull request, and
  `--format json` with `--max-findings` for CI. Nothing here is new analysis —
  it reads the indexes the editor already builds.
- **Framework support.** `glua.workspace.libraries` (or `workspace.libraries` in
  `.glua.json`) points at the source of frameworks your project uses but does
  not contain — ULib, DarkRP, Wiremod. They are indexed for what they define, so
  their globals resolve with real signatures instead of reading as undefined,
  and nothing in them is ever reported on. On a real gamemode this cleared every
  `ULib` finding.
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
