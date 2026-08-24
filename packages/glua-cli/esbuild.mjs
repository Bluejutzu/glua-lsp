import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** The API dataset ships next to the bundle so the CLI has no runtime deps on it. */
const copyApiData = {
  name: 'copy-api-data',
  setup(build) {
    build.onEnd(async () => {
      const from = path.resolve('../glua-lsp/src/api/data/gmod-api.json');
      const to = path.resolve('dist/gmod-api.json');
      try {
        await fs.mkdir('dist', { recursive: true });
        await fs.copyFile(from, to);
      } catch (error) {
        console.error(`Could not copy the API dataset: ${error.message}`);
        console.error('Run `pnpm run generate-api` in packages/glua-lsp first.');
        process.exitCode = 1;
      }
    });
  },
};

// Baked in rather than written out in a constant, which only ever goes stale.
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));

const shared = {
  define: { __GLUA_VERSION__: JSON.stringify(version) },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  // Resolved through tsconfig `paths`, which esbuild reads, so the CLI bundles
  // the analyser straight from the extension package's source.
  tsconfig: 'tsconfig.json',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/glua.ts'],
    outfile: 'dist/glua.js',
    plugins: [copyApiData],
  }),
  // The same language server the VS Code extension runs, exposed as its own
  // binary so any editor with an LSP client can drive it.
  esbuild.context({
    ...shared,
    entryPoints: ['../glua-lsp/src/server/main.ts'],
    outfile: 'dist/glua-lsp.js',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
