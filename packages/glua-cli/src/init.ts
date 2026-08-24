import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SETTINGS } from '@glua/server/settings.js';
import { bold, c, heading, symbols } from './palette.js';

export type ConfigKind = 'lint' | 'format';

interface Template {
  file: string;
  build(): unknown;
}

/**
 * Seeded from the same defaults the server starts with, so a fresh config
 * describes what you already have rather than changing behaviour the moment it
 * is written. The VS Code commands seed from your editor settings instead;
 * there is no editor here to ask.
 */
const TEMPLATES: Record<ConfigKind, Template> = {
  lint: {
    file: '.glua.json',
    build: () => ({
      $schema: './node_modules/glua-cli/dist/schemas/glua.schema.json',
      globals: [],
      // Every rule at its current severity, which is a more useful starting
      // point than an empty object — the schema describes each on hover, and
      // the list is what `glua rules` prints. `enable` and `scope` are left
      // out: they are about how your editor runs, not what the team agrees on.
      diagnostics: Object.fromEntries(
        Object.entries(DEFAULT_SETTINGS.diagnostics).filter(
          ([key]) => key !== 'enable' && key !== 'scope',
        ),
      ),
    }),
  },
  format: {
    file: '.gluafmtrc.json',
    build: () => ({
      $schema: './node_modules/glua-cli/dist/schemas/gluafmtrc.schema.json',
      useTabs: true,
      indentSize: 4,
      maxLineWidth: DEFAULT_SETTINGS.format.maxLineWidth,
      quoteStyle: DEFAULT_SETTINGS.format.quoteStyle,
      operatorStyle: DEFAULT_SETTINGS.format.operatorStyle,
      commentStyle: DEFAULT_SETTINGS.format.commentStyle,
      spaceInsideParens: DEFAULT_SETTINGS.format.spaceInsideParens,
      keepSingleLineBlocks: DEFAULT_SETTINGS.format.keepSingleLineBlocks,
      maxBlankLines: DEFAULT_SETTINGS.format.maxBlankLines,
      semicolons: DEFAULT_SETTINGS.format.semicolons,
    }),
  },
};

export interface InitOptions {
  kinds: ConfigKind[];
  root: string;
  force: boolean;
}

export interface InitResult {
  written: string[];
  skipped: string[];
  output: string;
}

export function init(options: InitOptions): InitResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const kind of options.kinds) {
    const template = TEMPLATES[kind];
    const target = path.join(options.root, template.file);

    if (fs.existsSync(target) && !options.force) {
      skipped.push(template.file);
      continue;
    }

    fs.writeFileSync(target, `${JSON.stringify(template.build(), null, 2)}\n`);
    written.push(template.file);
  }

  const lines: string[] = [heading('Init'), ''];
  for (const file of written) {
    lines.push(`  ${c.success(symbols.pass)} ${c.text(bold(file))} ${c.faint('written')}`);
  }
  for (const file of skipped) {
    lines.push(
      `  ${c.warning('!')} ${c.text(file)} ${c.faint('already exists, left alone — pass --force to replace it')}`,
    );
  }
  if (written.length) {
    lines.push('');
    lines.push(`  ${c.faint('Both files have a JSON schema, so an editor will complete and validate them.')}`);
  }
  lines.push('');

  return { written, skipped, output: lines.join('\n') };
}
