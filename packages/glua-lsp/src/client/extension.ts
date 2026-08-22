import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node.js';

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;

const OVERRIDE_KEY = 'glua.fileOverrides';

/** Per-file user overrides: uri -> true (force GLua) / false (force plain Lua). */
let overrides: Record<string, boolean> = {};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  overrides = context.workspaceState.get<Record<string, boolean>>(OVERRIDE_KEY, {});

  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6019'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'glua' }],
    synchronize: {
      configurationSection: 'glua',
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.{lua,glua}'),
        // Reload when the project's committed rules change.
        vscode.workspace.createFileSystemWatcher(
          '**/{.glua.json,glua.json,.gluarc.json,.gluafmtrc.json,.gluafmtrc,gluafmt.json,.editorconfig,.prettierrc,.prettierrc.json}',
        ),
      ],
    },
    outputChannelName: 'GLua Language Server',
  };

  client = new LanguageClient('glua', 'GLua Language Server', serverOptions, clientOptions);
  await client.start();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'glua.deactivateForFile';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(maybeAdoptDocument),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('glua.activation')) {
        for (const document of vscode.workspace.textDocuments) void maybeAdoptDocument(document);
      }
    }),

    vscode.commands.registerCommand('glua.activateForFile', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return;
      overrides[document.uri.toString()] = true;
      await context.workspaceState.update(OVERRIDE_KEY, overrides);
      await vscode.languages.setTextDocumentLanguage(document, 'glua');
      updateStatus();
    }),

    vscode.commands.registerCommand('glua.deactivateForFile', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return;
      overrides[document.uri.toString()] = false;
      await context.workspaceState.update(OVERRIDE_KEY, overrides);
      await vscode.languages.setTextDocumentLanguage(document, 'lua');
      updateStatus();
    }),

    vscode.commands.registerCommand('glua.restartServer', async () => {
      await client?.restart();
      vscode.window.showInformationMessage('GLua language server restarted.');
    }),

    vscode.commands.registerCommand('glua.reindexWorkspace', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'GLua: re-indexing workspace' },
        () => client!.sendRequest<{ indexed: number }>('glua/reindex'),
      );
      vscode.window.showInformationMessage(`GLua: indexed ${result.indexed} files.`);
    }),

    vscode.commands.registerCommand('glua.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bluejutzu.glua-lsp'),
    ),

    vscode.commands.registerCommand('glua.createFormatterConfig', () =>
      createConfigFile('.gluafmtrc.json', formatterConfigTemplate()),
    ),

    vscode.commands.registerCommand('glua.createLinterConfig', () =>
      createConfigFile('.glua.json', linterConfigTemplate()),
    ),

    // Code lenses hand us the locations; VS Code owns the peek UI.
    vscode.commands.registerCommand(
      'glua.showReferences',
      (uri: string, position: { line: number; character: number }, locations: vscode.Location[]) => {
        void vscode.commands.executeCommand(
          'editor.action.showReferences',
          vscode.Uri.parse(uri),
          new vscode.Position(position.line, position.character),
          locations.map(
            (location) =>
              new vscode.Location(
                vscode.Uri.parse(String((location as unknown as { uri: string }).uri)),
                new vscode.Range(
                  location.range.start.line,
                  location.range.start.character,
                  location.range.end.line,
                  location.range.end.character,
                ),
              ),
          ),
        );
      },
    ),

    vscode.commands.registerCommand('glua.checkWorkspace', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GLua: checking the workspace' },
        () => client!.sendRequest<{ files: number; problems: number }>('glua/checkWorkspace'),
      );

      if (!result.problems) {
        vscode.window.showInformationMessage(
          `GLua: no problems found across ${result.files} files.`,
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `GLua: ${result.problems} problems across ${result.files} files.`,
        'Show',
      );
      if (choice === 'Show') {
        await vscode.commands.executeCommand('workbench.actions.view.problems');
      }
    }),

    vscode.commands.registerCommand('glua.clearWorkspaceDiagnostics', async () => {
      await client!.sendRequest('glua/clearWorkspaceDiagnostics');
      vscode.window.showInformationMessage('GLua: cleared problems for unopened files.');
    }),

    vscode.commands.registerCommand('glua.showNetGraph', async () => {
      const markdown = await client!.sendRequest<string>('glua/netGraph');
      const document = await vscode.workspace.openTextDocument({
        content: markdown,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand('markdown.showPreviewToSide');
    }),
  );

  for (const document of vscode.workspace.textDocuments) void maybeAdoptDocument(document);
  updateStatus();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

/* ----------------------------------------------------------- config files */

/**
 * Writes a config file seeded from the settings currently in the UI, so the
 * settings editor and the committed file are two views of the same thing rather
 * than two places to keep in sync by hand.
 */
async function createConfigFile(name: string, contents: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('GLua: open a folder first.');
    return;
  }

  const target = vscode.Uri.joinPath(folder.uri, name);
  try {
    await vscode.workspace.fs.stat(target);
    const choice = await vscode.window.showWarningMessage(
      `${name} already exists. Overwrite it?`,
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
      return;
    }
  } catch {
    /* does not exist yet, which is the normal case */
  }

  await vscode.workspace.fs.writeFile(target, Buffer.from(contents, 'utf8'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
}

function formatterConfigTemplate(): string {
  const config = vscode.workspace.getConfiguration('glua.format');
  const editor = vscode.workspace.getConfiguration('editor', { languageId: 'glua' });

  return `${JSON.stringify(
    {
      $schema: './node_modules/glua-lsp/schemas/gluafmtrc.schema.json',
      useTabs: !editor.get<boolean>('insertSpaces', true),
      indentSize: editor.get<number>('tabSize', 4),
      maxLineWidth: config.get('maxLineWidth', 120),
      quoteStyle: config.get('quoteStyle', 'preserve'),
      operatorStyle: config.get('operatorStyle', 'preserve'),
      commentStyle: config.get('commentStyle', 'preserve'),
      spaceInsideParens: config.get('spaceInsideParens', false),
      keepSingleLineBlocks: config.get('keepSingleLineBlocks', true),
      maxBlankLines: config.get('maxBlankLines', 2),
      semicolons: config.get('semicolons', 'remove'),
    },
    null,
    2,
  )}\n`;
}

function linterConfigTemplate(): string {
  const config = vscode.workspace.getConfiguration('glua.diagnostics');
  const rules = [
    'undefinedGlobal', 'realmViolation', 'unusedLocal', 'deprecated',
    'argumentCount', 'argumentType', 'unknownHook', 'netMessage',
    'netReadWriteMismatch', 'missingAddCSLuaFile', 'globalWrite',
  ];

  const diagnostics: Record<string, string> = {};
  for (const rule of rules) diagnostics[rule] = config.get(rule, 'warning');

  return `${JSON.stringify(
    {
      $schema: './node_modules/glua-lsp/schemas/glua.schema.json',
      // Globals from addons outside this workspace, so they are not reported
      // as undefined. For example: ["ULib", "ulx", "pac"]
      globals: [],
      diagnostics,
      overrides: [
        {
          files: ['lua/vendor/**', 'lua/thirdparty/**'],
          diagnostics: { undefinedGlobal: 'off', unusedLocal: 'off' },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/* ------------------------------------------------------------- activation */

/**
 * Decides whether a `.lua` file should be treated as GLua.
 *
 * The extension deliberately does NOT claim `.lua` in package.json. Claiming it
 * globally is what makes other Lua extensions fight over Love2D, Luau and
 * Neovim projects. Instead we adopt files only where GMod is actually in play.
 */
async function maybeAdoptDocument(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== 'file') return;
  if (document.languageId === 'glua') return;
  if (document.languageId !== 'lua') return;

  const override = overrides[document.uri.toString()];
  if (override === false) return;

  if (override === true || shouldAdopt(document)) {
    await vscode.languages.setTextDocumentLanguage(document, 'glua');
    updateStatus();
  }
}

function shouldAdopt(document: vscode.TextDocument): boolean {
  const mode = vscode.workspace
    .getConfiguration('glua')
    .get<'auto' | 'always' | 'never'>('activation', 'auto');

  if (mode === 'never') return false;
  if (mode === 'always') return true;

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder && looksLikeGmodWorkspace(folder.uri.fsPath)) return true;

  // A file inside a recognisable GMod tree, even outside an addon root.
  const p = document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
  if (/\/(garrysmod|gamemodes)\//.test(p)) return true;
  if (/\/lua\/(autorun|entities|weapons|effects|vgui)\//.test(p)) return true;

  // Last resort: the file itself uses APIs that only exist in Garry's Mod.
  const head = document.getText(
    new vscode.Range(0, 0, Math.min(document.lineCount, 120), 0),
  );
  return /\b(AddCSLuaFile|util\.AddNetworkString|hook\.Add|net\.Receive|SWEP|ENT\.|surface\.SetDrawColor)\b/.test(
    head,
  );
}

const workspaceProbeCache = new Map<string, boolean>();

function looksLikeGmodWorkspace(root: string): boolean {
  const cached = workspaceProbeCache.get(root);
  if (cached !== undefined) return cached;

  const probes = [
    'lua/autorun',
    'lua/entities',
    'lua/weapons',
    'lua/effects',
    'gamemodes',
    'addon.json',
    'garrysmod',
  ];
  const result = probes.some((probe) => fs.existsSync(path.join(root, ...probe.split('/'))));
  workspaceProbeCache.set(root, result);
  return result;
}

/* ----------------------------------------------------------- status bar */

function updateStatus(): void {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || (document.languageId !== 'glua' && document.languageId !== 'lua')) {
    statusItem.hide();
    return;
  }

  if (document.languageId === 'glua') {
    const realm = realmOf(document.uri.fsPath);
    statusItem.text = `$(server-process) GLua · ${realm}`;
    statusItem.tooltip = new vscode.MarkdownString(
      `This file is analysed as **Garry's Mod Lua**, realm **${realm}**.\n\n` +
        'Click to switch it back to plain Lua.',
    );
    statusItem.command = 'glua.deactivateForFile';
  } else {
    statusItem.text = '$(circle-slash) Plain Lua';
    statusItem.tooltip = new vscode.MarkdownString(
      'GLua analysis is off for this file. Click to enable it.',
    );
    statusItem.command = 'glua.activateForFile';
  }
  statusItem.show();
}

/** Mirrors the server's path-based realm rules, just for the status bar label. */
function realmOf(fsPath: string): string {
  const p = fsPath.replace(/\\/g, '/').toLowerCase();
  const file = p.slice(p.lastIndexOf('/') + 1);

  if (file === 'cl_init.lua') return 'Client';
  if (file === 'init.lua' && /\/lua\/(entities|weapons|effects)\//.test(p)) return 'Server';
  if (file === 'shared.lua') return 'Shared';
  if (/\/lua\/autorun\/client\//.test(p) || /\/(client|cl)\//.test(p)) return 'Client';
  if (/\/lua\/autorun\/server\//.test(p) || /\/(server|sv)\//.test(p)) return 'Server';
  if (/\/lua\/menu\//.test(p)) return 'Menu';
  if (/\/lua\/(effects|vgui|postprocess|matproxy)\//.test(p)) return 'Client';
  if (file.startsWith('cl_')) return 'Client';
  if (file.startsWith('sv_')) return 'Server';
  return 'Shared';
}
