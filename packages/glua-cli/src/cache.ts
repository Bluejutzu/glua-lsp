// Not re-reading files that have not changed.
//
// Every run indexes the whole project, because cross-file rules are only
// correct once the index has seen everything — linting one file still means
// parsing the addon around it. On measurement that is where nearly all the time
// goes, and almost none of it is work that needed doing again.
//
// So the facts each file contributes are written down, keyed by a hash of its
// contents. A warm run reads them back and skips the parse. What is cached is
// only what a file *says* about itself; every finding is recomputed from the
// whole set, because a finding depends on files other than the one it is
// reported against.
//
// Content hash rather than modification time: a checkout, a branch switch and a
// restored backup all rewrite mtimes without changing a byte, and `touch` is
// not a reason to do the work again. It also means a wrong answer is impossible
// rather than unlikely — if the bytes differ, the key differs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FACTS_VERSION, type FileFacts } from '@glua/analyze/facts.js';

declare const __GLUA_VERSION__: string | undefined;

const VERSION = typeof __GLUA_VERSION__ === 'string' ? __GLUA_VERSION__ : '0.0.0-dev';

/** Where the cache lives, relative to the project root. */
export const CACHE_DIR = '.glua-cache';
const CACHE_FILE = 'facts.json';

interface Entry {
  hash: string;
  facts: FileFacts;
}

interface CacheFile {
  /** What produced it. A different build may produce different facts. */
  version: string;
  facts: number;
  entries: Record<string, Entry>;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * The fact cache for one project root.
 *
 * Every failure mode here is a miss, never an error: a corrupt file, an
 * unwritable directory and a cache from another version all end up recomputing
 * exactly what would have been computed anyway. A caching layer that can fail a
 * lint run is worse than no caching layer.
 */
export class FactCache {
  private readonly entries = new Map<string, Entry>();
  private readonly used = new Set<string>();
  private dirty = false;
  readonly stats: CacheStats = { hits: 0, misses: 0 };

  private constructor(private readonly file: string) {}

  static open(root: string): FactCache {
    const cache = new FactCache(path.join(root, CACHE_DIR, CACHE_FILE));
    cache.read();
    return cache;
  }

  /** A cache that never hits and never writes, for `--no-cache`. */
  static disabled(): FactCache {
    return new FactCache('');
  }

  private read(): void {
    if (!this.file) return;
    let parsed: CacheFile;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
    } catch {
      return;
    }
    // Facts written by a different build of the analyser describe a different
    // shape of the same file. Throwing the lot away is the only safe read.
    if (parsed?.version !== VERSION || parsed.facts !== FACTS_VERSION) return;
    if (!parsed.entries || typeof parsed.entries !== 'object') return;

    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (entry && typeof entry.hash === 'string' && entry.facts) {
        this.entries.set(key, entry);
      }
    }
  }

  /** The facts for this exact content, or undefined. */
  get(key: string, hash: string): FileFacts | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.hash !== hash) {
      this.stats.misses++;
      return undefined;
    }
    this.used.add(key);
    this.stats.hits++;
    return entry.facts;
  }

  set(key: string, hash: string, facts: FileFacts): void {
    if (!this.file) return;
    const existing = this.entries.get(key);
    if (existing?.hash === hash) return;
    this.entries.set(key, { hash, facts });
    this.used.add(key);
    this.dirty = true;
  }

  /**
   * Writes the cache back, dropping entries for files this run never looked at.
   *
   * Without the drop a cache grows forever: every file ever deleted, moved or
   * renamed stays in it, and the read cost of a stale entry is paid on every
   * subsequent run.
   */
  save(): void {
    if (!this.file) return;
    const stale = this.entries.size - this.used.size;
    if (!this.dirty && !stale) return;

    const entries: CacheFile['entries'] = {};
    for (const key of this.used) {
      const entry = this.entries.get(key);
      if (entry) entries[key] = entry;
    }

    const contents: CacheFile = { version: VERSION, facts: FACTS_VERSION, entries };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Written whole and moved into place, so a run killed mid-write leaves
      // the previous cache rather than a truncated one.
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(contents), 'utf8');
      fs.renameSync(temporary, this.file);
      writeGitignore(path.dirname(this.file));
    } catch {
      // Read-only checkout, a full disk, a sandbox. Not worth a word.
    }
  }
}

/**
 * The cache directory ignores itself.
 *
 * Nobody wants a generated file in their diff, and expecting every project to
 * remember a .gitignore line for a directory the tool invented is how the line
 * gets forgotten.
 */
function writeGitignore(dir: string): void {
  const file = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '*\n', 'utf8');
  } catch {
    // Same reasoning as above.
  }
}
