import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Copies the API dataset next to the bundle so the server can read it at runtime. */
const copyApiData = {
  name: 'copy-api-data',
  setup(build) {
    build.onEnd(async () => {
      const from = path.resolve('src/api/data/gmod-api.json');
      const to = path.resolve('dist/gmod-api.json');
      try {
        await fs.mkdir('dist', { recursive: true });
        await fs.copyFile(from, to);
      } catch (error) {
        console.error(`Could not copy the API dataset: ${error.message}`);
        console.error('Run `npm run generate-api` to build it.');
      }
    });
  },
};

// Baked in rather than written out in a constant, which only ever goes stale.
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: { __GLUA_VERSION__: JSON.stringify(version) },
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/client/extension.ts'],
    outfile: 'dist/client.js',
    external: ['vscode'],
    plugins: [copyApiData],
  }),
  esbuild.context({
    ...shared,
    entryPoints: ['src/server/main.ts'],
    outfile: 'dist/server.js',
    external: ['vscode'],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
