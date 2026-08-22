// Benchmarks the indexer against a real Garry's Mod codebase.
//   node test/bench-real.mjs <path-to-addon-or-gamemode>

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_DATA, OUT } from './fixtures.mjs';

const { GmodApi } = await import(OUT('api/index.js'));
const { Workspace } = await import(OUT('analyze/workspace.js'));
const { completion } = await import(OUT('server/features/completion.js'));
const { diagnose } = await import(OUT('server/features/diagnostics.js'));
const { DEFAULT_SETTINGS } = await import(OUT('server/settings.js'));

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('Usage: node test/bench-real.mjs <path-to-lua-project>');
  process.exit(1);
}

const api = GmodApi.load(API_DATA);
const workspace = new Workspace(api, { maxFiles: 20000, exclude: [] });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rss = () => process.memoryUsage().rss;

console.log(`Project: ${root}`);

const files = workspace.scanFolder(root);
let bytes = 0;
let lines = 0;
const sources = new Map();
for (const file of files) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    sources.set(file, text);
    bytes += text.length;
    lines += text.split('\n').length;
  } catch {
    /* unreadable */
  }
}
console.log(`Found ${sources.size} files, ${lines.toLocaleString()} lines, ${mb(bytes)}\n`);

/* ------------------------------------------------------------ cold index */

const beforeRss = rss();
const indexStart = performance.now();
for (const [file, text] of sources) {
  // Background files: facts only, matching what the server does on startup.
  workspace.analyse(pathToFileURL(file).href, text, 1, false);
}
const indexMs = performance.now() - indexStart;
// Several passes: one collection leaves plenty of the young generation behind.
for (let i = 0; i < 4 && global.gc; i++) global.gc();
const afterRss = rss();

console.log('Cold index');
console.log(`  total     ${indexMs.toFixed(0)} ms`);
console.log(`  per file  ${(indexMs / sources.size).toFixed(2)} ms`);
console.log(`  throughput ${(lines / (indexMs / 1000) / 1000).toFixed(0)}k lines/sec`);
console.log(`  memory    +${mb(afterRss - beforeRss)} rss, heap ${mb(process.memoryUsage().heapUsed)}\n`);

/* --------------------------------------------------------- cross-file index */

const queryStart = performance.now();
workspace.netRegistered();
workspace.customHookNames();
workspace.isKnownGlobalPath('does_not_exist');
workspace.clientReachableFiles();
console.log(`Cross-file index build: ${(performance.now() - queryStart).toFixed(1)} ms\n`);

/* ------------------------------------------------ interactive edit cycle */

const biggest = [...sources.entries()].sort((a, b) => b[1].length - a[1].length)[0];
const [bigFile, bigText] = biggest;
const bigLines = bigText.split('\n').length;
console.log(`Largest file: ${path.basename(bigFile)} (${bigLines.toLocaleString()} lines, ${mb(bigText.length)})`);

const uri = pathToFileURL(bigFile).href;
const timeIt = (label, iterations, fn) => {
  fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const each = (performance.now() - started) / iterations;
  console.log(`  ${label.padEnd(26)} ${each.toFixed(1)} ms`);
  return each;
};

timeIt('re-analyse on keystroke', 10, (i) => {
  workspace.analyse(uri, `${bigText}\nlocal _bench_${i ?? 0} = ${i ?? 0}\n`, (i ?? 0) + 2);
});

const analysis = workspace.analyse(uri, bigText, 999);
timeIt('diagnostics', 10, () => diagnose(analysis, api, workspace, DEFAULT_SETTINGS));

const deps = { api, workspace, settings: DEFAULT_SETTINGS };
const memberOffset = bigText.length;
const memberAnalysis = workspace.analyse(uri, `${bigText}\nlocal _e = Entity(1)\n_e:`, 1000);
const memberPos = memberAnalysis.lines.positionAt(memberAnalysis.text.length);
timeIt('completion (member)', 20, () => completion(memberAnalysis, memberPos, deps));

const identAnalysis = workspace.analyse(uri, `${bigText}\nlocal _x = Ent`, 1001);
const identPos = identAnalysis.lines.positionAt(identAnalysis.text.length);
timeIt('completion (global scope)', 20, () => completion(identAnalysis, identPos, deps));

void memberOffset;

/* ------------------------------------------------------- what was found */

let defs = 0;
let hooks = 0;
let errors = 0;
let diagnostics = 0;
for (const file of workspace.all()) {
  defs += file.globalDefs.length;
  hooks += file.hookAdds.length;
  errors += file.parseErrors.length;
}
let refs = 0;
let symbolCount = 0;
for (const file of workspace.all()) {
  refs += file.globalRefs.length;
  symbolCount += file.symbols.length;
}
console.log(`  global references   ${refs.toLocaleString()}`);
console.log(`  symbol entries      ${symbolCount.toLocaleString()}`);

// Diagnostics need a syntax tree, so ask for the full analysis explicitly.
const sample = [...workspace.uris()].slice(0, 200).map((uri) => workspace.full(uri));
const byCode = new Map();
const examples = new Map();
for (const file of sample) {
  for (const item of diagnose(file, api, workspace, DEFAULT_SETTINGS)) {
    diagnostics++;
    byCode.set(item.code, (byCode.get(item.code) ?? 0) + 1);
    if (!examples.has(item.code)) {
      examples.set(item.code, `${path.relative(root, file.fsPath)}:${item.range.start.line + 1} ${item.message}`);
    }
  }
}

console.log('\nWhat the index found');
console.log(`  global definitions  ${defs.toLocaleString()}`);
console.log(`  hook.Add sites      ${hooks.toLocaleString()}`);
console.log(`  net messages        ${workspace.netRegistered().size} registered, ${workspace.netStarts().size} sent, ${workspace.netReceives().size} received`);
console.log(`  parse errors        ${errors.toLocaleString()} (across ${workspace.size} files)`);
console.log(`  diagnostics         ${diagnostics.toLocaleString()} in the first ${sample.length} files`);

console.log('\nDiagnostics by rule');
for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(code).padEnd(22)} ${String(count).padStart(5)}`);
  console.log(`      e.g. ${examples.get(code).slice(0, 150)}`);
}

if (errors > 0) {
  console.log('\nFiles with parse errors (first 10):');
  let shown = 0;
  for (const file of workspace.all()) {
    if (!file.parseErrors.length || shown >= 10) continue;
    shown++;
    const first = file.parseErrors[0];
    const pos = file.lines.positionAt(first.start);
    console.log(`  ${path.relative(root, file.fsPath)}:${pos.line + 1}:${pos.character + 1} — ${first.message}`);
  }
}
