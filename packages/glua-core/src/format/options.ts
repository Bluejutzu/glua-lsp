export interface FormatOptions {
  useTabs: boolean;
  indentSize: number;
  maxLineWidth: number;
  /** Rewrite string quotes when doing so needs no extra escaping. */
  quoteStyle: 'double' | 'single' | 'preserve';
  /** Rewrite GLua's C-style operators (`!=`, `&&`, `||`, `!`) to Lua ones. */
  operatorStyle: 'preserve' | 'lua';
  /** Rewrite `//` and `/* *​/` comments to `--` and `--[[ ]]`. */
  commentStyle: 'preserve' | 'lua';
  /** Garry's own style is `func( a, b )`; most addon code is not. */
  spaceInsideParens: boolean;
  /**
   * Keep a block that the author wrote on one line on one line.
   *
   * `if not IsValid(ent) then return end` is idiomatic GLua and expanding it to
   * three lines is the fastest way to make a formatter unwelcome.
   */
  keepSingleLineBlocks: boolean;
  /** Consecutive blank lines to keep between statements. */
  maxBlankLines: number;
  semicolons: 'remove' | 'preserve';
  endOfLine: '\n' | '\r\n';
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  useTabs: true,
  indentSize: 4,
  maxLineWidth: 120,
  quoteStyle: 'preserve',
  operatorStyle: 'preserve',
  commentStyle: 'preserve',
  spaceInsideParens: false,
  keepSingleLineBlocks: true,
  maxBlankLines: 2,
  semicolons: 'remove',
  endOfLine: '\n',
};
