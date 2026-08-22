import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const OUT = (rel) => pathToFileURL(path.join(ROOT, 'out', rel)).href;
export const API_DATA = path.join(ROOT, 'src', 'api', 'data', 'gmod-api.json');

/** A pretend addon root so realm-from-path rules have something to chew on. */
export const ADDON = path.join(ROOT, '.test-addon');

export const file = (...segments) => path.join(ADDON, ...segments);
export const uriOf = (...segments) => pathToFileURL(file(...segments)).href;
