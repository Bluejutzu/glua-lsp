// Terminal colours, sharing the project's palette with the editor tooling.
//
// The hex values come from palette.json in the extension package, so the CLI,
// the test reporter and the benchmark cannot drift apart.

import PALETTE from '../../glua-lsp/tools/palette.json';

export { PALETTE };

/**
 * Colour is off when output is piped, when NO_COLOR is set, or when the
 * terminal says it is dumb. FORCE_COLOR overrides all of it.
 * See https://no-color.org.
 */
function supportsColour(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

let enabled = supportsColour();

/** Lets `--no-color` / `--color` win over the environment. */
export function setColourEnabled(value: boolean): void {
  enabled = value;
}

export function colourEnabled(): boolean {
  return enabled;
}

function rgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
}

export function paint(hex: string, text: string | number): string {
  if (!enabled) return String(text);
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

const wrap =
  (open: number, close: number) =>
  (text: string | number): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const underline = wrap(4, 24);

/** Semantic helpers. Prefer these over reaching for a hex directly. */
export const c = {
  accent: (t: string | number) => paint(PALETTE.accent, t),
  success: (t: string | number) => paint(PALETTE.success, t),
  failure: (t: string | number) => paint(PALETTE.failure, t),
  warning: (t: string | number) => paint(PALETTE.warning, t),
  highlight: (t: string | number) => paint(PALETTE.highlight, t),
  text: (t: string | number) => paint(PALETTE.text, t),
  muted: (t: string | number) => paint(PALETTE.muted, t),
  faint: (t: string | number) => paint(PALETTE.faint, t),
};

export const symbols = {
  error: '✗',
  warning: '!',
  info: 'i',
  hint: '·',
  pass: '✓',
  arrow: '→',
  bullet: '•',
  line: '─',
};

/** Strips ANSI so widths can be measured for alignment. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const filler = ' '.repeat(Math.max(0, width - plain(text).length));
  return align === 'right' ? filler + text : text + filler;
}

export function heading(text: string): string {
  return `\n${bold(c.accent(text))}\n${c.faint(symbols.line.repeat(Math.min(60, plain(text).length + 12)))}`;
}
