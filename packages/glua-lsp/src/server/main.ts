import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type FormattingOptions,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import path from 'node:path';
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
import {
  incomingCalls,
  outgoingCalls,
  prepareCallHierarchy,
} from './features/callHierarchy.js';
import { formatting, rangeFormatting } from './features/formatting.js';
import { codeLenses } from './features/codeLens.js';
import { detectEndOfLine } from '../format/printer.js';
import { ConfigResolver } from '../config/index.js';
import { VERSION } from '../util/version.js';
import { buildNetGraph } from './features/netGraph.js';
import { buildReport } from './features/report.js';
import { renderHtml } from './features/reportHtml.js';

/**
 * An editor launches this with a transport flag. Anything else is a person
 * running the binary by hand, who would otherwise get a stack trace out of the
 * connection layer.
 */
const TRANSPORTS = ['--stdio', '--node-ipc', '--socket', '--pipe'];
const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (
  argv.includes('--help') ||
  argv.includes('-h') ||
  !argv.some((arg) => TRANSPORTS.some((transport) => arg.startsWith(transport)))
) {
  const help = argv.includes('--help') || argv.includes('-h');
  process.stdout.write(
    `glua-lsp ${VERSION} — language server for Garry's Mod Lua\n\n` +
      `Your editor starts this, not you. Point an LSP client at:\n\n` +
      `  glua-lsp --stdio\n\n` +
      `Setting that up in Neovim, Helix, Zed and others:\n` +
      `  https://glua.bluejutzu.dev/reference/editors\n\n` +
      `To lint or format from a terminal, use \`glua\` instead.\n`,
  );
  process.exit(help ? 0 : 1);
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: Settings = DEFAULT_SETTINGS;
let api: GmodApi;
let workspace: Workspace;
let config = new ConfigResolver(DEFAULT_SETTINGS);
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
      codeLensProvider: { resolveProvider: false },
      callHierarchyProvider: true,
      semanticTokensProvider: {
        legend: LEGEND,
        full: true,
      },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
    serverInfo: { name: 'GLua Language Server', version: VERSION },
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
/**
 * A library path may be relative, since a framework usually sits beside the
 * project. Relative to the config file if there is one, else the workspace.
 */
function resolveLibraryPath(library: string, folders: { uri: string }[]): string {
  if (path.isAbsolute(library)) return library;
  const base = config.root ?? (folders[0] ? URI.parse(folders[0].uri).fsPath : undefined);
  return base ? path.resolve(base, library) : path.resolve(library);
}

/** Library roots from editor settings and the project config combined. */
function configuredLibraries(): string[] {
  return [
    ...new Set([...settings.workspace.libraries, ...config.projectSettings().workspace.libraries]),
  ].sort();
}

/** What was indexed last time, so a change to the list can be noticed. */
let indexedLibraries: string[] = [];

/**
 * Re-indexes when the library list changes.
 *
 * Adding a framework mid-session should not need a restart, and removing one
 * has to drop its files — otherwise its globals keep resolving after you have
 * said they are not there.
 */
async function reindexedForLibraryChange(): Promise<boolean> {
  const wanted = configuredLibraries();
  if (wanted.join('\0') === indexedLibraries.join('\0')) return false;

  connection.console.log(
    `GLua: library list changed (${indexedLibraries.length} → ${wanted.length}), re-indexing.`,
  );
  await indexWorkspace();
  return true;
}

async function indexWorkspace(): Promise<number> {
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  const started = Date.now();
  let indexed = 0;

  // Frameworks first, so the project's own files see what they define on the
  // very first pass rather than only after a re-analysis.
  workspace.clearLibraries();
  indexedLibraries = configuredLibraries();
  for (const library of indexedLibraries) {
    const count = workspace.indexLibrary(resolveLibraryPath(library, folders));
    if (count) connection.console.log(`GLua: indexed ${count} files from library ${library}.`);
    else connection.console.warn(`GLua: library path '${library}' has no Lua files.`);
    await new Promise((resolve) => setImmediate(resolve));
  }

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
  if (settings.diagnostics.scope === 'workspace') await publishWorkspaceDiagnostics();
  return indexed;
}

/**
 * Reports every indexed file, not just the open ones.
 *
 * Without this you only learn a file is broken by opening it, which is the
 * wrong way round for problems that span files — a handler whose sender was
 * deleted lives in a file you have no reason to open.
 */
async function publishWorkspaceDiagnostics(): Promise<number> {
  const started = Date.now();
  let reported = 0;
  let scanned = 0;

  for (const uri of [...workspace.uris()]) {
    if (documents.get(uri)) continue; // open documents publish on their own
    if (workspace.isLibrary(uri)) continue; // somebody else's code
    const analysis = workspace.full(uri);
    if (!analysis) continue;

    try {
      const found = diagnose(analysis, api, workspace, config.settingsFor(analysis.fsPath), {
        extraGlobals: config.globalsFor(analysis.fsPath),
      });
      reported += found.length;
      connection.sendDiagnostics({ uri, diagnostics: found });
    } catch (error) {
      connection.console.error(`GLua: diagnostics failed for ${uri}: ${String(error)}`);
    }

    // Release the tree again and yield, so a big workspace neither blocks the
    // server nor holds every syntax tree in memory at once.
    workspace.releaseAst(uri);
    if (++scanned % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  connection.console.log(
    `GLua: workspace scan reported ${reported} problem${reported === 1 ? '' : 's'} ` +
      `across ${scanned} files in ${Date.now() - started}ms.`,
  );
  return reported;
}

/** Clears reported problems for files that are not open. */
function clearWorkspaceDiagnostics(): void {
  for (const uri of workspace.uris()) {
    if (documents.get(uri)) continue;
    connection.sendDiagnostics({ uri, diagnostics: [] });
  }
}

async function refreshSettings(): Promise<void> {
  if (hasConfigurationCapability) {
    const raw = await connection.workspace.getConfiguration('glua');
    settings = mergeSettings(raw);
  }
  config.setEditorSettings(settings);
  await reloadProjectConfig();
  workspace.setOptions({
    maxFiles: settings.workspace.maxFiles,
    exclude: settings.workspace.exclude,
    gamePath: settings.workspace.gamePath || undefined,
  });
}

/** Picks up `.glua.json`, `.gluafmtrc.json`, `.editorconfig` and `.prettierrc`. */
async function reloadProjectConfig(): Promise<void> {
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  const roots = folders.map((folder) => URI.parse(folder.uri).fsPath);
  const loaded = config.reload(roots);

  for (const error of config.errors) {
    connection.window.showWarningMessage(`GLua: ${error}`);
  }
  if (loaded) {
    const used = [
      ...config.files,
      ...(loaded.editorConfig ? ['.editorconfig'] : []),
      ...(loaded.prettier ? ['.prettierrc'] : []),
    ];
    if (used.length) connection.console.log(`GLua: config from ${used.join(', ')}`);
  }
}

connection.onDidChangeConfiguration(async () => {
  const wasWorkspaceScope = settings.diagnostics.scope === 'workspace';
  await refreshSettings();

  // Reindexing republishes everything itself, so do not do it twice.
  const reindexed = await reindexedForLibraryChange();
  if (reindexed) return;

  for (const document of documents.all()) scheduleDiagnostics(document.uri, 0);
  if (settings.diagnostics.scope === 'workspace') await publishWorkspaceDiagnostics();
  else if (wasWorkspaceScope) clearWorkspaceDiagnostics();
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
  // Opening a framework file must not fill the panel with its problems. The
  // promise is that library code is never reported on, wherever you found it.
  if (workspace.isLibrary(uri)) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const analysis = analysisFor(uri);
  if (!analysis) return;
  try {
    connection.sendDiagnostics({
      uri,
      diagnostics: diagnose(analysis, api, workspace, config.settingsFor(analysis.fsPath), {
        extraGlobals: config.globalsFor(analysis.fsPath),
      }),
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

const CONFIG_FILE = /[/\\](\.glua\.json|glua\.json|\.gluarc\.json|\.gluafmtrc(\.json)?|gluafmt\.json|\.editorconfig|\.prettierrc(\.json)?)$/;

connection.onDidChangeWatchedFiles(async (event) => {
  let configChanged = false;

  for (const change of event.changes) {
    if (CONFIG_FILE.test(change.uri)) {
      configChanged = true;
      continue;
    }
    if (documents.get(change.uri)) continue; // the editor is the source of truth
    if (change.type === 3 /* Deleted */) {
      workspace.remove(change.uri);
    } else {
      workspace.loadFromDisk(URI.parse(change.uri).fsPath);
    }
  }

  if (configChanged) {
    await reloadProjectConfig();
    // Editing workspace.libraries in .glua.json takes effect here, rather than
    // waiting for a restart.
    if (await reindexedForLibraryChange()) return;
    for (const document of documents.all()) scheduleDiagnostics(document.uri, 0);
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

/** Resolves formatting options for a document through the config precedence. */
function formatOptionsFor(analysis: FileAnalysis, editor: FormattingOptions) {
  return config.formatOptionsFor(
    analysis.fsPath,
    { useTabs: !editor.insertSpaces, indentSize: editor.tabSize || 4 },
    detectEndOfLine(analysis.text),
  );
}

connection.onDocumentFormatting(
  guarded('formatting', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    if (!analysis) return [];
    const enabled = config.settingsFor(analysis.fsPath).format.enable;
    return formatting(analysis, formatOptionsFor(analysis, params.options), enabled);
  }),
);

connection.onDocumentRangeFormatting(
  guarded('rangeFormatting', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    if (!analysis) return [];
    const enabled = config.settingsFor(analysis.fsPath).format.enable;
    return rangeFormatting(
      analysis,
      params.range,
      formatOptionsFor(analysis, params.options),
      enabled,
    );
  }),
);

connection.onCodeLens(
  guarded('codeLens', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? codeLenses(analysis, workspace) : [];
  }),
);

connection.languages.inlayHint.on(
  guarded('inlayHint', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? inlayHints(analysis, params.range, settings) : [];
  }),
);

connection.languages.callHierarchy.onPrepare(
  guarded('callHierarchy/prepare', [], (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? prepareCallHierarchy(analysis, params.position, workspace) : [];
  }),
);

connection.languages.callHierarchy.onIncomingCalls(
  guarded('callHierarchy/incoming', [], (params) => incomingCalls(params.item, workspace)),
);

connection.languages.callHierarchy.onOutgoingCalls(
  guarded('callHierarchy/outgoing', [], (params) => outgoingCalls(params.item, workspace)),
);

connection.languages.semanticTokens.on(
  guarded('semanticTokens', { data: [] }, (params) => {
    const analysis = analysisFor(params.textDocument.uri);
    return analysis ? semanticTokens(analysis, api) : { data: [] };
  }),
);

/* ---------------------------------------------------------- custom requests */

connection.onRequest('glua/netGraph', () => buildNetGraph(workspace));

connection.onRequest('glua/report', async () => {
  const report = await buildReport(api, workspace, {
    settingsFor: (fsPath) => config.settingsFor(fsPath),
    globalsFor: (fsPath) => config.globalsFor(fsPath),
    top: 10,
  });
  const folder = await workspaceName();
  return { html: renderHtml(report, folder), name: folder, report };
});

/** Best label for the project, for a report title. */
async function workspaceName(): Promise<string> {
  // The client knows the answer; ask it before guessing from a path.
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  const first = folders[0];
  if (first) return path.basename(URI.parse(first.uri).fsPath);

  for (const uri of workspace.uris()) {
    // Libraries are indexed first, so without this the title becomes `ulib`.
    if (workspace.isLibrary(uri)) continue;
    const root = URI.parse(uri).fsPath.replace(/\\/g, '/');
    const lua = root.toLowerCase().lastIndexOf('/lua/');
    if (lua > 0) return path.basename(root.slice(0, lua));
  }
  return 'Project';
}

connection.onRequest('glua/reindex', async () => ({ indexed: await indexWorkspace() }));

connection.onRequest('glua/checkWorkspace', async () => ({
  files: workspace.size,
  problems: await publishWorkspaceDiagnostics(),
}));

connection.onRequest('glua/clearWorkspaceDiagnostics', () => {
  clearWorkspaceDiagnostics();
  return { cleared: true };
});

connection.onRequest('glua/status', () => ({
  files: workspace.size,
  globals: Object.keys(api.data.globals).length,
  classes: api.classNames().length,
  generatedAt: api.data.generatedAt,
}));

documents.listen(connection);
connection.listen();
