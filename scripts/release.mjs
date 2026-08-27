#!/usr/bin/env node
// Cuts a release: applies pending changesets, regenerates the docs
// changelogs, commits, and tags each publishable package that actually
// changed version.
//
// Versioning and per-package changelogs come from Changesets — this script
// turns that into a commit plus the tags the release workflow acts on.
// `glua-core` is private and never tagged/published; it can still bump
// alongside the others (or on its own) without triggering a release.
//
//   pnpm changeset             # author a changeset for your change
//   pnpm run release           # apply pending changesets, commit, tag
//   pnpm run release --dry-run

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, c, heading, symbols } from '../packages/glua-core/tools/palette.mjs';
import { renderChangelogDocs } from './lib/changelog-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The publishable packages this script tags and releases. glua-core is
// deliberately not here — it never gets its own tag (see
// .changeset/config.json's privatePackages.tag: false).
const PACKAGES = {
  'glua-gmod': {
    dir: path.join(ROOT, 'packages', 'glua-lsp'),
    changelogDocsOut: path.join(ROOT, 'docs', 'changelog.mdx'),
  },
  'glua-cli': {
    dir: path.join(ROOT, 'packages', 'glua-cli'),
    changelogDocsOut: path.join(ROOT, 'docs', 'cli-changelog.mdx'),
  },
};

/**
 * Generated configs point `$schema` at glua.bluejutzu.dev, which Mintlify
 * serves straight from here. Copied on every release so the hosted schema
 * never drifts from the one glua-lsp actually ships.
 */
const SCHEMAS_SRC = path.join(ROOT, 'packages', 'glua-lsp', 'schemas');
const SCHEMAS_DOCS = path.join(ROOT, 'docs', 'schemas');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const die = (message) => {
  console.error(`${c.failure(symbols.fail)} ${message}`);
  process.exit(1);
};

const git = (...cmd) => execFileSync('git', cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const tagExists = (tag) => git('tag', '--list', tag) !== '';

function readVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

/* ------------------------------------------------------------- safety check */

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain');

if (dirty && !dryRun) {
  die(`Working tree is not clean:\n${dirty}\n\nCommit or stash first.`);
}
if (branch !== 'main') {
  console.warn(`${c.warning('!')} On branch ${bold(branch)}, not main.`);
}

console.log(heading('Release'));
console.log(`  ${c.muted('branch')}  ${c.text(branch)}`);

if (dryRun) {
  try {
    execFileSync('pnpm', ['exec', 'changeset', 'status', '--verbose'], { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    // `changeset status` exits non-zero when there are unreleased changes to
    // report, which is exactly what a dry run wants to show — not a failure.
  }
  console.log(`\n  ${c.warning('dry run')} ${c.faint('— nothing written')}\n`);
  process.exit(0);
}

/* ----------------------------------------------------------------- perform */

const before = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, { dir }]) => [name, readVersion(dir)]),
);

execFileSync('pnpm', ['exec', 'changeset', 'version'], { cwd: ROOT, stdio: 'inherit', shell: true });

const after = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, { dir }]) => [name, readVersion(dir)]),
);
const bumped = Object.keys(PACKAGES).filter((name) => after[name] !== before[name]);

if (bumped.length === 0) {
  console.log(`\n  ${c.faint('no pending changesets touched a publishable package — nothing to tag')}\n`);
  process.exit(0);
}

for (const name of bumped) {
  console.log(`  ${c.muted(name)}  ${c.text(before[name])} ${c.faint('→')} ${c.highlight(bold(after[name]))}`);
}

const staged = [];
for (const name of Object.keys(PACKAGES)) {
  staged.push(path.relative(ROOT, path.join(PACKAGES[name].dir, 'package.json')));
  const changelog = path.join(PACKAGES[name].dir, 'CHANGELOG.md');
  if (fs.existsSync(changelog)) staged.push(path.relative(ROOT, changelog));
}
// glua-core has no tag of its own, but `changeset version` may still have
// bumped its manifest/changelog — stage it too whenever that happened.
const coreDir = path.join(ROOT, 'packages', 'glua-core');
staged.push(path.relative(ROOT, path.join(coreDir, 'package.json')));
staged.push(path.relative(ROOT, path.join(coreDir, 'CHANGELOG.md')));

fs.mkdirSync(SCHEMAS_DOCS, { recursive: true });
for (const name of fs.readdirSync(SCHEMAS_SRC)) {
  fs.copyFileSync(path.join(SCHEMAS_SRC, name), path.join(SCHEMAS_DOCS, name));
  staged.push(path.relative(ROOT, path.join(SCHEMAS_DOCS, name)));
}

function resolveTagFor(newPrefix) {
  return (version) => (tagExists(`v${version}`) ? `v${version}` : `${newPrefix}${version}`);
}

for (const name of bumped) {
  const { dir, changelogDocsOut } = PACKAGES[name];
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const repoUrl = manifest.repository.url.replace(/\.git$/, '');
  const markdown = fs.readFileSync(changelogPath, 'utf8');
  fs.writeFileSync(
    changelogDocsOut,
    renderChangelogDocs(markdown, { repoUrl, resolveTag: resolveTagFor(`${name}@`) }),
  );
  staged.push(path.relative(ROOT, changelogDocsOut));
}

git('add', ...staged);
const summary = bumped.map((name) => `${name}@${after[name]}`).join(', ');
git('commit', '-m', `release ${summary}`);

const tags = bumped.map((name) => `${name}@${after[name]}`);
for (const tag of tags) {
  git('tag', '-a', tag, '-m', tag);
}

console.log(`\n  ${c.success(symbols.pass)} committed and tagged ${tags.join(', ')}`);
console.log(`\n  ${c.muted('push it with')}\n`);
console.log(`    ${c.accent(`git push origin ${branch} --follow-tags`)}\n`);
console.log(
  `  ${c.faint('That triggers the release workflow for each tagged package.')}\n`,
);
