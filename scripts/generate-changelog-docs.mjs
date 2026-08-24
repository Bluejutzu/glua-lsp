#!/usr/bin/env node
// Regenerates docs/changelog.mdx from packages/glua-lsp/CHANGELOG.md. Run
// standalone with `pnpm run docs:changelog`, or via `pnpm run release`,
// which calls this automatically so the two files can't drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChangelogDocs } from './lib/changelog-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'packages', 'glua-lsp', 'package.json');
const CHANGELOG = path.join(ROOT, 'packages', 'glua-lsp', 'CHANGELOG.md');
const OUT = path.join(ROOT, 'docs', 'changelog.mdx');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const repoUrl = manifest.repository.url.replace(/\.git$/, '');
const markdown = fs.readFileSync(CHANGELOG, 'utf8');

fs.writeFileSync(OUT, renderChangelogDocs(markdown, { repoUrl }));
console.log(`wrote ${path.relative(ROOT, OUT)}`);
