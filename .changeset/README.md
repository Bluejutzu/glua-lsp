# Changesets

Run `pnpm changeset` for any user-facing change, picking which of
`glua-core`, `glua-gmod` and `glua-cli` it touches and how big the bump is.
`glua-core` is private and never published — it still gets versioned and
changelogged (see `.changeset/config.json`'s `privatePackages`) so
`glua-gmod`/`glua-cli` can note when they pick up an engine change.

See https://github.com/changesets/changesets for the full docs.
