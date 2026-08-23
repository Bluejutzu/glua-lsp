// A single overwriting status line for long-running commands, so `lint` and
// `fmt` don't sit silent for the several seconds a big project can take.
//
// Always written to stderr, never stdout, so it can't corrupt `--format json`
// or `--format github` output, and a `\x1b[K` clear after `\r` means a short
// line never leaves stray characters from a longer previous one.

import { c } from './palette.js';

export interface Progress {
  update(current: number, total: number, label: string): void;
  done(): void;
}

const NULL_PROGRESS: Progress = { update() {}, done() {} };

export function createProgress(enabled: boolean): Progress {
  if (!enabled) return NULL_PROGRESS;

  let written = false;
  return {
    update(current, total, label) {
      written = true;
      const count = total ? `${current}/${total}` : String(current);
      process.stderr.write(`\r\x1b[K${c.faint(count)} ${c.muted(label)}`);
    },
    done() {
      if (written) process.stderr.write('\r\x1b[K');
    },
  };
}

/** Progress only makes sense on an interactive terminal that can move its own cursor. */
export function supportsProgress(): boolean {
  return Boolean(process.stderr.isTTY) && process.env.TERM !== 'dumb';
}
