#!/usr/bin/env node
// Regenerates docs/glua/changelog.mdx and docs/glua/cli-changelog.mdx from each
// package's own CHANGELOG.md. Run standalone with `pnpm run docs:changelog`,
// or via `pnpm run release`, which calls this automatically so the docs
// can't drift from what actually shipped.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChangelogDocs } from './lib/changelog-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tagExists = (tag) => {
  try {
    return execFileSync('git', ['tag', '--list', tag], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
};

const PAGES = [
  {
    manifest: path.join(ROOT, 'packages', 'glua-lsp', 'package.json'),
    changelog: path.join(ROOT, 'packages', 'glua-lsp', 'CHANGELOG.md'),
    out: path.join(ROOT, 'docs', 'glua', 'changelog.mdx'),
    newTagPrefix: 'glua-gmod@',
    title: 'glua-gmod',
    description: "Notable changes to the GLua for Garry's Mod extension, release by release.",
    crossLink: { path: '/glua/cli-changelog', label: 'glua-cli' },
  },
  {
    manifest: path.join(ROOT, 'packages', 'glua-cli', 'package.json'),
    changelog: path.join(ROOT, 'packages', 'glua-cli', 'CHANGELOG.md'),
    out: path.join(ROOT, 'docs', 'glua', 'cli-changelog.mdx'),
    newTagPrefix: 'glua-cli@',
    title: 'glua-cli',
    description: 'Notable changes to the glua-cli command-line tool, release by release.',
    crossLink: { path: '/glua/changelog', label: 'glua-gmod' },
  },
];

// Releases before the independent-versioning split were tagged `vX.Y.Z`
// (one tag for both packages). Only fall back to the new `<name>@X.Y.Z`
// scheme for a version that was never tagged the old way, so historical
// entries keep linking to the tag that actually exists.
function resolveTagFor(newPrefix) {
  return (version) => (tagExists(`v${version}`) ? `v${version}` : `${newPrefix}${version}`);
}

for (const { manifest, changelog, out, newTagPrefix, title, description, crossLink } of PAGES) {
  const repoUrl = JSON.parse(fs.readFileSync(manifest, 'utf8')).repository.url.replace(/\.git$/, '');
  const markdown = fs.readFileSync(changelog, 'utf8');
  fs.writeFileSync(
    out,
    renderChangelogDocs(markdown, {
      repoUrl,
      resolveTag: resolveTagFor(newTagPrefix),
      title,
      description,
      crossLink,
    }),
  );
  console.log(`wrote ${path.relative(ROOT, out)}`);
}
