#!/usr/bin/env node
// Cuts a release: bumps the manifest, commits, tags, and tells you to push.
//
// The release workflow refuses to build when the tag and the manifest version
// disagree, so doing this by hand is easy to get wrong in a way you only find
// out about after pushing a tag.
//
//   pnpm run release 0.2.0
//   pnpm run release patch|minor|major
//   pnpm run release 0.2.0 --dry-run

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, c, heading, symbols } from '../packages/glua-lsp/tools/palette.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'packages', 'glua-lsp', 'package.json');
const CHANGELOG = path.join(ROOT, 'packages', 'glua-lsp', 'CHANGELOG.md');

/** The heading a new release's notes accumulate under between releases. */
const UNRELEASED = '## Unreleased';
const PLACEHOLDER = '_Nothing yet._';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipChangelog = args.includes('--no-changelog');
const requested = args.find((a) => !a.startsWith('-'));

const die = (message) => {
  console.error(`${c.failure(symbols.fail)} ${message}`);
  process.exit(1);
};

const git = (...cmd) => execFileSync('git', cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!requested) {
  die('Usage: pnpm run release <version|patch|minor|major> [--dry-run] [--no-changelog]');
}

/**
 * Moves the accumulated notes under `## Unreleased` to the new version and
 * opens a fresh Unreleased section.
 *
 * Doing this by hand is the step that gets forgotten, which is how a shipped
 * release ends up still described as unreleased.
 */
function rollChangelog(version) {
  if (!fs.existsSync(CHANGELOG)) {
    return { status: 'missing', message: 'no CHANGELOG.md' };
  }

  const original = fs.readFileSync(CHANGELOG, 'utf8');
  // Only horizontal whitespace: `\s*$` would eat the blank line after the
  // heading and leave the new version's title glued to its first entry.
  const heading = new RegExp(`^${UNRELEASED}[ \\t]*$`, 'm');
  const match = heading.exec(original);

  if (!match) {
    return {
      status: 'skipped',
      message: `no "${UNRELEASED}" heading — add one and the next release will pick it up`,
    };
  }

  // Everything between this heading and the next one is the release's notes.
  const bodyStart = match.index + match[0].length;
  const nextHeading = original.slice(bodyStart).search(/^## /m);
  const body = (nextHeading === -1 ? original.slice(bodyStart) : original.slice(bodyStart, bodyStart + nextHeading)).trim();

  const empty = body === '' || body === PLACEHOLDER;

  const updated =
    original.slice(0, match.index) +
    `${UNRELEASED}\n\n${PLACEHOLDER}\n\n## ${version}` +
    original.slice(match.index + match[0].length);

  const entries = body.split('\n').filter((line) => line.trim().startsWith('-')).length;

  return {
    status: empty ? 'empty' : 'rolled',
    contents: updated,
    message: empty
      ? `"${UNRELEASED}" had no entries, so ${version} will have none either`
      : `moved ${entries} ${entries === 1 ? 'entry' : 'entries'} under ${version}`,
  };
}

/* ------------------------------------------------------------ next version */

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const current = manifest.version;

function bump(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const next = ['patch', 'minor', 'major'].includes(requested)
  ? bump(current, requested)
  : requested;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  die(`'${next}' is not a valid semver version.`);
}
if (next === current) die(`Already at ${current}.`);

/* ------------------------------------------------------------ safety check */

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain');
const tag = `v${next}`;

if (git('tag', '--list', tag)) die(`Tag ${tag} already exists.`);
if (dirty && !dryRun) {
  die(`Working tree is not clean:\n${dirty}\n\nCommit or stash first.`);
}
if (branch !== 'main') {
  console.warn(`${c.warning('!')} On branch ${bold(branch)}, not main.`);
}

const changelog = skipChangelog
  ? { status: 'off', message: 'skipped with --no-changelog' }
  : rollChangelog(next);

const changelogColour = {
  rolled: c.success,
  empty: c.warning,
  skipped: c.warning,
  missing: c.warning,
  off: c.faint,
}[changelog.status];

console.log(heading('Release'));
console.log(`  ${c.muted('version')}    ${c.text(current)} ${c.faint('→')} ${c.highlight(bold(next))}`);
console.log(`  ${c.muted('tag')}        ${c.highlight(tag)}`);
console.log(`  ${c.muted('branch')}     ${c.text(branch)}`);
console.log(`  ${c.muted('changelog')}  ${changelogColour(changelog.message)}`);

if (dryRun) {
  console.log(`\n  ${c.warning('dry run')} ${c.faint('— nothing written')}\n`);
  process.exit(0);
}

/* ----------------------------------------------------------------- perform */

manifest.version = next;
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

const staged = [path.relative(ROOT, MANIFEST)];
if (changelog.contents) {
  fs.writeFileSync(CHANGELOG, changelog.contents);
  staged.push(path.relative(ROOT, CHANGELOG));
}

git('add', ...staged);
git('commit', '-m', `release ${tag}`);
git('tag', '-a', tag, '-m', tag);

console.log(`\n  ${c.success(symbols.pass)} committed and tagged`);
console.log(`\n  ${c.muted('push it with')}\n`);
console.log(`    ${c.accent(`git push origin ${branch} --follow-tags`)}\n`);
console.log(
  `  ${c.faint('That triggers the release workflow, which builds the VSIX and')}\n` +
    `  ${c.faint('attaches it to a new GitHub release.')}\n`,
);
