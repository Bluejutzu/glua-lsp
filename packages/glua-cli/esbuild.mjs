import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * The API dataset and the config schemas ship next to the bundle, so the CLI
 * has no runtime dependencies and `glua init` can point $schema at a real file.
 */
const copyAssets = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(async () => {
      try {
        await fs.mkdir('dist/schemas', { recursive: true });
        await fs.copyFile(
          path.resolve('../glua-core/src/api/data/gmod-api.json'),
          path.resolve('dist/gmod-api.json'),
        );
        for (const schema of await fs.readdir(path.resolve('../glua-lsp/schemas'))) {
          await fs.copyFile(
            path.resolve('../glua-lsp/schemas', schema),
            path.resolve('dist/schemas', schema),
          );
        }
      } catch (error) {
        console.error(`Could not copy bundled data: ${error.message}`);
        console.error('Run `pnpm run generate-api` in packages/glua-core first.');
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
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/glua.ts'],
    outfile: 'dist/glua.js',
    plugins: [copyAssets],
  }),
  // The same language server the VS Code extension runs, exposed as its own
  // binary so any editor with an LSP client can drive it.
  esbuild.context({
    ...shared,
    entryPoints: ['../glua-core/src/server/main.ts'],
    outfile: 'dist/glua-lsp.js',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
