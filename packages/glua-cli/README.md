# glua-cli

Lint and format Garry's Mod Lua from the command line, using the same parser,
analyser and formatter as the
[GLua language server](https://docs.bluejutzu.dev/glua) — so a finding in CI is the
same finding you saw in the editor.

```bash
glua lint lua/
glua fmt lua/ --write
```

## Commands

### `glua lint [paths...]`

Reports problems. Defaults to the current directory.

| Flag | |
| --- | --- |
| `-f, --format <format>` | `pretty` (default), `compact`, `github`, `json` |
| `--root <dir>` | Project root for config files and relative paths |
| `--max-warnings <n>` | Exit non-zero above this many warnings |
| `-q, --quiet` | Only report errors |

Exit code is `1` when there are errors, or when `--max-warnings` is exceeded.

<!-- prettier-ignore -->
> The whole project is indexed even when you lint one file, because cross-file
> rules — an unhandled net message, a duplicate hook identifier — are only
> correct once the index has seen everything.

### `glua fmt [paths...]`

| Flag | |
| --- | --- |
| `-w, --write` | Rewrite files in place |
| `-c, --check` | Exit non-zero if anything would change, write nothing |
| `--root <dir>` | Project root for config files |

With no flag it reports what would change and exits `1` if anything would.
Files that do not parse are skipped and reported, never rewritten.

### `glua rules`

Lists every diagnostic code with its settings key, since the two differ:
`net-payload-mismatch` is the code you suppress inline, `netReadWriteMismatch`
is the key you set in `.glua.json`.

## Configuration

Reads the same files as the editor: `.glua.json`, `.gluafmtrc.json`,
`.editorconfig` and `.prettierrc`, resolved from `--root` or the working
directory. See the
[configuration guide](https://docs.bluejutzu.dev/glua/configuration/overview).

## In CI

The `github` format emits workflow annotations, so findings appear on the diff:

```yaml
- run: glua lint lua/ --format github
```

## Colour

Honours `NO_COLOR` and disables itself when piped. `--no-color` turns it off
explicitly; `FORCE_COLOR=1` turns it on even through a pipe.

## Licence

MIT.
