import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { GmodApi } from '../api/index.js';
import type { FileAnalysis } from '../analyze/binder.js';
import { Workspace } from '../analyze/workspace.js';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from './settings.js';
import { completion } from './features/completion.js';
import { hover } from './features/hover.js';
import { signatureHelp } from './features/signature.js';
import {
  definition,
  documentHighlights,
  prepareRename,
  references,
  rename,
} from './features/navigation.js';
import { documentSymbols, workspaceSymbols } from './features/symbols.js';
import { diagnose } from './features/diagnostics.js';
import { LEGEND, semanticTokens } from './features/semanticTokens.js';
import { inlayHints } from './features/inlayHints.js';
import { codeActions } from './features/codeActions.js';
import { formatting, rangeFormatting } from './features/formatting.js';
import { buildNetGraph } from './features/netGraph.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: Settings = DEFAULT_SETTINGS;
let api: GmodApi;
let workspace: Workspace;
let hasConfigurationCapability = false;

/** Debounce timers per document, so typing does not trigger a diagnostic storm. */
const pending = new Map<string, NodeJS.Timeout>();

connection.onInitialize((params): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);

  api = GmodApi.load();
  workspace = new Workspace(api, { maxFiles: 6000, exclude: [] });

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', ':', '"', "'", '/'],
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      codeActionProvider: true,
      inlayHintProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      semanticTokensProvider: {
        legend: LEGEND,
        full: true,
      },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
    serverInfo: { name: 'GLua Language Server', version: '0.1.0' },
  };
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  await refreshSettings();

  await indexWorkspace();
});

/**
 * Indexes every Lua file in the workspace, yielding to the event loop between
 * batches so requests from the editor are still answered while it runs.
 */
async function indexWorkspace(): Promise<number> {
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  const started = Date.now();
  let indexed = 0;

  for (const folder of folders) {
    const files = workspace.scanFolder(URI.parse(folder.uri).fsPath);
    for (let i = 0; i < files.length; i++) {
      if (workspace.loadFromDisk(files[i]!)) indexed++;
      if (i % 25 === 24) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  connection.console.log(
    `GLua: indexed ${indexed} file${indexed === 1 ? '' : 's'} in ${Date.now() - started}ms ` +
      `(API: ${Object.keys(api.data.globals).length} globals, ${api.classNames().length} classes).`,
  );

  // Diagnostics for already-open documents now that cross-file facts exist.
  for (const document of documents.all()) scheduleDiagnostics(document.uri, 0);
  return indexed;
}

async function refreshSettings(): Promise<void> {
  if (hasConfigurationCapability) {
    const raw = await connection.workspace.getConfiguration('glua');
    settings = mergeSettings(raw);
  }
  workspace.setOptions({
    maxFiles: settings.workspace.maxFiles,
    exclude: settings.workspace.exclude,
  });
}

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  for (const document of documents.all()) scheduleDiagnostics(document.uri, 0);
});

/* --------------------------------------------------------------- analysis */

/**
 * The analysis for a request, parsed on demand. Open documents keep their
 * syntax tree; anything else is re-parsed only if a feature actually needs one.
 */
function analysisFor(uri: string): FileAnalysis | undefined {
  const document = documents.get(uri);
  if (!document) return workspace.full(uri);

  const cached = workspace.get(uri);
  if (cached && cached.version === document.version && cached.hasAst) return cached;
  return workspace.analyse(uri, document.getText(), document.version, true);
}

function scheduleDiagnostics(uri: string, delay = 250): void {
  const existing = pending.get(uri);
  if (existing) clearTimeout(existing);
  pending.set(
    uri,
    setTimeout(() => {
      pending.delete(uri);
      publishDiagnostics(uri);
    }, delay),
  );
}

function publishDiagnostics(uri: string): void {
  const analysis = analysisFor(uri);
  if (!analysis) return;
  try {
    connection.sendDiagnostics({
      uri,
      diagnostics: diagnose(analysis, api, workspace, settings),
    });
  } catch (error) {
    connection.console.error(`GLua: diagnostics failed for ${uri}: ${String(error)}`);
  }
}

documents.onDidOpen((event) => {
  workspace.analyse(event.document.uri, event.document.getText(), event.document.version, true);
  scheduleDiagnostics(event.document.uri, 0);
});

documents.onDidChangeContent((event) => {
  // Deliberately not analysing here: analysisFor() parses on demand, so a burst
  // of keystrokes costs one parse when diagnostics fire, not one per keystroke.
  scheduleDiagnostics(event.document.uri);
});

documents.onDidClose((event) => {
  const timer = pending.get(event.document.uri);
  if (timer) clearTimeout(timer);
  pending.delete(event.document.uri);
  // Re-read from disk so cross-file facts survive closing the tab, and so the
  // syntax tree we were holding for this document is released.
  workspace.loadFromDisk(URI.parse(event.document.uri).fsPath);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles((event) => {
  for (const change of event.changes) {
    if (documents.get(change.uri)) continue; // the editor is the source of truth
    if (change.type === 3 /* Deleted */) {
      workspace.remove(change.uri);
    } else {
      workspace.loadFromDisk(URI.parse(change.uri).fsPath);
    }
  }
});

/* --------------------------------------------------------------- features */

/** Every handler runs through this so one bad node can never kill the server. */
function guarded<T, R>(name: string, fallback: R, handler: (params: T) => R): (params: T) => R {
  return (params) => {
    try {
      return handler(params);
    } catch (error) {
      connection.console.error(`GLua: ${name} failed: ${String(error)}`);
      return fallback;
    }
  };
}

connection.onCompletion(
  guarded('completion', { isIncomplete: false, items: [] }, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    if (!analysis) return { isIncomplete: false, items: [] };
    return completion(analysis, params.position, { api, workspace, settings });
  }),
);

connection.onHover(
  guarded('hover', null, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? hover(analysis, params.position, { api, workspace, settings }) : null;
  }),
);

connection.onSignatureHelp(
  guarded('signatureHelp', null, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? signatureHelp(analysis, params.position, api) : null;
  }),
);

connection.onDefinition(
  guarded('definition', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? definition(analysis, params.position, api, workspace) : [];
  }),
);

connection.onReferences(
  guarded('references', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis
      ? references(analysis, params.position, api, workspace, params.context.includeDeclaration)
      : [];
  }),
);

connection.onDocumentHighlight(
  guarded('documentHighlight', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? documentHighlights(analysis, params.position, api, workspace) : [];
  }),
);

connection.onPrepareRename(
  guarded('prepareRename', null, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    if (!analysis) return null;
    const result = prepareRename(analysis, params.position, api);
    return result ? { range: result.range, placeholder: result.placeholder } : null;
  }),
);

connection.onRenameRequest(
  guarded('rename', null, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? rename(analysis, params.position, params.newName, api, workspace) : null;
  }),
);

connection.onDocumentSymbol(
  guarded('documentSymbol', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? documentSymbols(analysis) : [];
  }),
);

connection.onWorkspaceSymbol(
  guarded('workspaceSymbol', [], (params) => workspaceSymbols(workspace, params.query)),
);

connection.onCodeAction(
  guarded('codeAction', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    if (!analysis) return [];
    return codeActions(analysis, params.range, params.context.diagnostics, { api, workspace });
  }),
);

connection.onDocumentFormatting(
  guarded('formatting', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? formatting(analysis, params.options, settings) : [];
  }),
);

connection.onDocumentRangeFormatting(
  guarded('rangeFormatting', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? rangeFormatting(analysis, params.range, params.options, settings) : [];
  }),
);

connection.languages.inlayHint.on(
  guarded('inlayHint', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? inlayHints(analysis, params.range, settings) : [];
  }),
);

connection.languages.semanticTokens.on(
  guarded('semanticTokens', { data: [] }, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? semanticTokens(analysis, api) : { data: [] };
  }),
);

/* ---------------------------------------------------------- custom requests */

connection.onRequest('glua/netGraph', () => buildNetGraph(workspace));

connection.onRequest('glua/reindex', async () => ({ indexed: await indexWorkspace() }));

connection.onRequest('glua/status', () => ({
  files: workspace.size,
  globals: Object.keys(api.data.globals).length,
  classes: api.classNames().length,
  generatedAt: api.data.generatedAt,
}));

documents.listen(connection);
connection.listen();
