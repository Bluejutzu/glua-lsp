// Checks npm for a newer glua-cli release and prints an update hint.
//
// Runs at most once a day (cached to disk) and never blocks or fails a
// command — an offline machine or a slow registry just means no notice.

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { detectInstall } from './detect-install.js';
import { c, symbols } from './palette.js';

const REGISTRY_URL = 'https://registry.npmjs.org/glua-cli/latest';
// Under the home directory rather than the shared temp directory, so another
// account on the same machine can't plant a file here for us to trust.
const CACHE_DIR = path.join(os.homedir(), '.glua-cli');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

function isValidCache(value: unknown): value is Cache {
  if (typeof value !== 'object' || value === null) return false;
  const cache = value as Record<string, unknown>;
  return typeof cache.checkedAt === 'number' && /^\d+\.\d+\.\d+/.test(String(cache.latest));
}

function readCache(): Cache | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return isValidCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: Cache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Best effort; a missing cache just means checking again next run.
  }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const request = https.get(
      REGISTRY_URL,
      { headers: { accept: 'application/json' }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    // Never keep the process alive just for this.
    request.on('socket', (socket) => socket.unref());
  });
}

/** Loose numeric compare; good enough for the plain major.minor.patch this project ships. */
function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [la, lb, lc] = parts(latest);
  const [ca, cb, cc] = parts(current);
  if (la !== ca) return (la ?? 0) > (ca ?? 0);
  if (lb !== cb) return (lb ?? 0) > (cb ?? 0);
  return (lc ?? 0) > (cc ?? 0);
}

export interface UpdateNotice {
  current: string;
  latest: string;
}

export async function checkForUpdate(current: string): Promise<UpdateNotice | null> {
  if (process.env.GLUA_NO_UPDATE_CHECK || process.env.CI) return null;
  if (!process.stderr.isTTY) return null;

  const cached = readCache();
  let latest: string | null;
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatestVersion();
    if (latest) writeCache({ checkedAt: Date.now(), latest });
  }

  if (!latest || !isNewer(latest, current)) return null;
  return { current, latest };
}

export function renderUpdateNotice(notice: UpdateNotice): string {
  const install = detectInstall();
  const scope = install.scope === 'workspace' ? 'in this project' : 'globally';
  return (
    `\n${c.highlight(symbols.info)} glua-cli ${c.faint(notice.current)} ${symbols.arrow} ${c.success(notice.latest)}` +
    ` is available (installed ${scope}).\n` +
    `  Run ${c.accent(install.command)} to update.\n`
  );
}
