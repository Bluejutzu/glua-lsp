import { DiagnosticSeverity } from 'vscode-languageserver';

export type SeveritySetting = 'error' | 'warning' | 'information' | 'hint' | 'off';

export interface Settings {
  activation: 'auto' | 'always' | 'never';
  workspace: {
    maxFiles: number;
    exclude: string[];
  };
  diagnostics: {
    enable: boolean;
    undefinedGlobal: SeveritySetting;
    realmViolation: SeveritySetting;
    unusedLocal: SeveritySetting;
    deprecated: SeveritySetting;
    argumentCount: SeveritySetting;
    argumentType: SeveritySetting;
    unknownHook: SeveritySetting;
    netMessage: SeveritySetting;
    netReadWriteMismatch: SeveritySetting;
    missingAddCSLuaFile: SeveritySetting;
    globalWrite: SeveritySetting;
    duplicateIdentifier: SeveritySetting;
    /** `open` reports only files you have open; `workspace` reports everything. */
    scope: 'open' | 'workspace';
  };
  inlayHints: {
    parameterNames: boolean;
    realm: boolean;
  };
  completion: {
    callSnippets: boolean;
    filterByRealm: boolean;
  };
  hover: {
    wikiLinks: boolean;
  };
  format: {
    enable: boolean;
    maxLineWidth: number;
    quoteStyle: 'double' | 'single' | 'preserve';
    operatorStyle: 'preserve' | 'lua';
    commentStyle: 'preserve' | 'lua';
    spaceInsideParens: boolean;
    keepSingleLineBlocks: boolean;
    maxBlankLines: number;
    semicolons: 'remove' | 'preserve';
  };
}

export const DEFAULT_SETTINGS: Settings = {
  activation: 'auto',
  workspace: {
    maxFiles: 6000,
    exclude: [],
  },
  diagnostics: {
    enable: true,
    undefinedGlobal: 'warning',
    realmViolation: 'warning',
    unusedLocal: 'hint',
    deprecated: 'warning',
    argumentCount: 'warning',
    argumentType: 'warning',
    unknownHook: 'information',
    netMessage: 'warning',
    netReadWriteMismatch: 'warning',
    missingAddCSLuaFile: 'warning',
    globalWrite: 'off',
    duplicateIdentifier: 'warning',
    scope: 'open',
  },
  inlayHints: {
    parameterNames: true,
    realm: false,
  },
  completion: {
    callSnippets: true,
    filterByRealm: true,
  },
  hover: {
    wikiLinks: true,
  },
  format: {
    enable: true,
    maxLineWidth: 120,
    quoteStyle: 'preserve',
    operatorStyle: 'preserve',
    commentStyle: 'preserve',
    spaceInsideParens: false,
    keepSingleLineBlocks: true,
    maxBlankLines: 2,
    semicolons: 'remove',
  },
};

export function severityOf(setting: SeveritySetting): DiagnosticSeverity | null {
  switch (setting) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'information':
      return DiagnosticSeverity.Information;
    case 'hint':
      return DiagnosticSeverity.Hint;
    default:
      return null;
  }
}

/** Deep-merges the client's configuration object over the defaults. */
export function mergeSettings(raw: unknown): Settings {
  const incoming = (raw ?? {}) as Record<string, unknown>;
  const merge = <T extends object>(base: T, patch: unknown): T => {
    if (!patch || typeof patch !== 'object') return base;
    const out = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      const current = out[key];
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        out[key] = merge(current as object, value);
      } else {
        out[key] = value;
      }
    }
    return out as T;
  };
  return merge(DEFAULT_SETTINGS, incoming);
}
