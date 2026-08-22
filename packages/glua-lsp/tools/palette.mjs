// The project's colour scheme, in one place.
//
// Used by the test reporter, the API generator and the benchmark. The hex
// values are the source of truth so a docs site or a VS Code theme can pull the
// same numbers instead of re-inventing them.

import { readFileSync } from 'node:fs';

/**
 * The hex values live in palette.json so the TypeScript CLI and these plain
 * Node scripts share one source of truth instead of drifting apart.
 *
 * - `accent`     Claude's coral; headings and names, what you look at first
 * - `highlight`  counts and measurements, anything numeric worth noticing
 * - `text`       standard body text
 * - `muted`      units, labels, context
 * - `faint`      separators, skipped items, things you can ignore
 */
export const PALETTE = JSON.parse(
  readFileSync(new URL('./palette.json', import.meta.url), 'utf8'),
);

/**
 * Colour is disabled when output is piped, when NO_COLOR is set, or when TERM
 * says the terminal is dumb. FORCE_COLOR overrides all of that.
 * See https://no-color.org.
 */
function supportsColour() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

const enabled = supportsColour();

const toRgb = (hex) => {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
};

/** Wraps text in a 24-bit foreground colour. */
export function paint(hex, text) {
  if (!enabled) return String(text);
  const [r, g, b] = toRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);

/** Semantic helpers. Prefer these over reaching for a hex directly. */
export const c = {
  accent: (text) => paint(PALETTE.accent, text),
  success: (text) => paint(PALETTE.success, text),
  failure: (text) => paint(PALETTE.failure, text),
  warning: (text) => paint(PALETTE.warning, text),
  highlight: (text) => paint(PALETTE.highlight, text),
  text: (text) => paint(PALETTE.text, text),
  muted: (text) => paint(PALETTE.muted, text),
  faint: (text) => paint(PALETTE.faint, text),
};

export const symbols = {
  pass: '✓',
  fail: '✗',
  skip: '○',
  todo: '◌',
  arrow: '›',
  bullet: '•',
  // A colour-blind-safe cue that does not rely on green vs red alone.
  line: '─',
};

export const colourEnabled = enabled;

/** Strips ANSI so widths can be measured for alignment. */
export function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pads to a visible width, ignoring escape codes. */
export function pad(text, width, align = 'left') {
  const visible = plain(text).length;
  const filler = ' '.repeat(Math.max(0, width - visible));
  return align === 'right' ? filler + text : text + filler;
}

/** A duration, coloured by how slow it is. */
export function duration(ms) {
  const rendered = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
  if (ms >= 1000) return c.warning(rendered);
  if (ms >= 100) return c.muted(rendered);
  return c.faint(rendered);
}

export function heading(text) {
  return `\n${bold(c.accent(text))}\n${c.faint(symbols.line.repeat(Math.min(60, plain(text).length + 12)))}`;
}
