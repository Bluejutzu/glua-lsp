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

const context = await esbuild.context({
  entryPoints: ['src/glua.ts'],
  outfile: 'dist/glua.js',
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
  plugins: [copyApiData],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
