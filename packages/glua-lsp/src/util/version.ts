/**
 * The package version, substituted by esbuild at build time.
 *
 * Falls back for the plain `tsc` output the tests run against, which is not
 * bundled and so never has the define applied.
 */
declare const __GLUA_VERSION__: string | undefined;

export const VERSION: string =
  typeof __GLUA_VERSION__ === 'string' ? __GLUA_VERSION__ : '0.0.0-dev';
