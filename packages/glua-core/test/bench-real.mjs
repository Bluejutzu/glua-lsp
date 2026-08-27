// Benchmarks the indexer against a real Garry's Mod codebase.
//   node test/bench-real.mjs <path-to-addon-or-gamemode>

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_DATA, OUT } from './fixtures.mjs';
import { bold, c, heading, pad, symbols } from '../tools/palette.mjs';

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

/** `  label   value` with the label muted and the number highlighted. */
const row = (label, value, note = '') =>
  console.log(`  ${pad(c.muted(label), 26)}${c.highlight(value)}${note ? ` ${c.faint(note)}` : ''}`);

console.log(heading('GLua benchmark'));
console.log(`  ${c.muted('project')}  ${c.text(root)}`);

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
console.log(
  `  ${c.muted('found')}    ${c.highlight(sources.size.toLocaleString())} ${c.muted('files')}, ` +
    `${c.highlight(lines.toLocaleString())} ${c.muted('lines')}, ${c.highlight(mb(bytes))}`,
);

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

console.log(heading('Cold index'));
row('total', `${indexMs.toFixed(0)} ms`);
row('per file', `${(indexMs / sources.size).toFixed(2)} ms`);
row('throughput', `${(lines / (indexMs / 1000) / 1000).toFixed(0)}k`, 'lines/sec');
row('retained heap', mb(process.memoryUsage().heapUsed), `(+${mb(afterRss - beforeRss)} rss)`);

/* --------------------------------------------------------- cross-file index */

const queryStart = performance.now();
workspace.netRegistered();
workspace.customHookNames();
workspace.isKnownGlobalPath('does_not_exist');
workspace.clientReachableFiles();
row('cross-file index', `${(performance.now() - queryStart).toFixed(1)} ms`);

/* ------------------------------------------------ interactive edit cycle */

const biggest = [...sources.entries()].sort((a, b) => b[1].length - a[1].length)[0];
const [bigFile, bigText] = biggest;
const bigLines = bigText.split('\n').length;
console.log(heading('Interactive latency'));
console.log(
  `  ${c.muted('largest file')} ${c.text(path.basename(bigFile))} ` +
    `${c.faint(`(${bigLines.toLocaleString()} lines, ${mb(bigText.length)})`)}\n`,
);

const uri = pathToFileURL(bigFile).href;
const timeIt = (label, iterations, fn) => {
  fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const each = (performance.now() - started) / iterations;
  // Anything past a frame budget is worth noticing.
  const value = `${each.toFixed(1)} ms`;
  const coloured = each > 100 ? c.failure(value) : each > 50 ? c.warning(value) : c.highlight(value);
  console.log(`  ${pad(c.muted(label), 26)}${coloured}`);
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
console.log(heading('What the index found'));
row('global references', refs.toLocaleString());
row('symbol entries', symbolCount.toLocaleString());

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

row('global definitions', defs.toLocaleString());
row('hook.Add sites', hooks.toLocaleString());
row(
  'net messages',
  `${workspace.netRegistered().size}`,
  `registered · ${workspace.netStarts().size} sent · ${workspace.netReceives().size} received`,
);
console.log(
  `  ${pad(c.muted('parse errors'), 26)}${
    errors ? c.failure(errors.toLocaleString()) : c.success('0')
  } ${c.faint(`across ${workspace.size} files`)}`,
);
row('diagnostics', diagnostics.toLocaleString(), `in the first ${sample.length} files`);

console.log(heading('Diagnostics by rule'));
const ranked = [...byCode].sort((a, b) => b[1] - a[1]);
const widest = Math.max(...ranked.map(([code]) => String(code).length), 10);
for (const [code, count] of ranked) {
  console.log(
    `  ${pad(c.accent(String(code)), widest + 2)}${c.highlight(String(count).padStart(5))}`,
  );
  console.log(`  ${' '.repeat(widest + 2)}${c.faint(examples.get(code).slice(0, 140))}`);
}
console.log(`\n  ${c.faint(`${symbols.bullet} run with a different project path to compare`)}\n`);
void bold;

if (errors > 0) {
  console.log(heading('Files with parse errors'));
  let shown = 0;
  for (const file of workspace.all()) {
    if (!file.parseErrors.length || shown >= 10) continue;
    shown++;
    const first = file.parseErrors[0];
    const pos = file.lines.positionAt(first.start);
    console.log(
      `  ${c.failure(symbols.fail)} ${c.text(path.relative(root, file.fsPath))}` +
        `${c.faint(`:${pos.line + 1}:${pos.character + 1}`)} ${c.muted(first.message)}`,
    );
  }
}
