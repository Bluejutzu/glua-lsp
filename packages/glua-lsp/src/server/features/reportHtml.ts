import type { ProjectReport } from './report.js';

const number = (value: number) => value.toLocaleString('en-US');
/* ------------------------------------------------------------------ html */

/**
 * A single self-contained file, so it can be committed, attached to a pull
 * request, or opened by someone who does not have the extension.
 */
export function renderHtml(report: ProjectReport, name: string): string {
  const rows = (items: { name: string; count: number }[], empty: string) =>
    items.length
      ? items
          .map(
            (item) =>
              `<tr><td>${escapeHtml(item.name)}</td><td class="n">${number(item.count)}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="2" class="ok">${escapeHtml(empty)}</td></tr>`;

  const stat = (label: string, value: string, tone = '') =>
    `<div class="stat ${tone}"><span class="v">${value}</span><span class="l">${escapeHtml(label)}</span></div>`;

  const unknown = report.undefinedGlobals.reduce((sum, g) => sum + g.count, 0);
  const netProblems =
    report.net.unhandled.length + report.net.unsent.length + report.net.unregistered.length;

  return `<title>${escapeHtml(name)} · GLua report</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --faint: #9ca3af;
    --line: #e5e7eb; --card: #f9fafb; --accent: #D97757;
    --warn: #B45309; --ok: #15803D;
  }
  :root:not([data-theme="light"]) { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #191817; --fg: #F3F4F6; --muted: #9CA3AF; --faint: #6B7280;
      --line: #2E2C2A; --card: #211F1E; --accent: #D97757;
      --warn: #F59E0B; --ok: #4ADE80;
    }
  }
  :root[data-theme="dark"] {
    --bg: #191817; --fg: #F3F4F6; --muted: #9CA3AF; --faint: #6B7280;
    --line: #2E2C2A; --card: #211F1E; --accent: #D97757;
    --warn: #F59E0B; --ok: #4ADE80;
  }
  body {
    margin: 0; padding: 2.5rem 1.5rem; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 {
    font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 2.5rem 0 .75rem; font-weight: 600;
  }
  .sub { color: var(--muted); margin: 0 0 2rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .75rem; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: .6rem;
    padding: .9rem 1rem;
  }
  .stat .v { display: block; font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .l { display: block; font-size: .8rem; color: var(--muted); margin-top: .15rem; }
  .stat.warn .v { color: var(--warn); }
  .stat.ok .v { color: var(--ok); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.5rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); width: 5rem; }
  td.ok { color: var(--ok); }
  td.muted { color: var(--faint); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  .note { color: var(--faint); font-size: .85rem; margin: -.35rem 0 .75rem; }
  footer { color: var(--faint); font-size: .8rem; margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1rem; }
</style>
<main>
  <h1>${escapeHtml(name)}</h1>
  <p class="sub">${number(report.files)} files · ${number(report.lines)} lines${
    report.libraryFiles ? ` · ${number(report.libraryFiles)} indexed from libraries` : ''
  }</p>

  <div class="stats">
    ${stat('findings', number(report.diagnostics.total), report.diagnostics.total ? 'warn' : 'ok')}
    ${stat('net messages', number(report.net.registered))}
    ${stat('net problems', number(netProblems), netProblems ? 'warn' : 'ok')}
    ${stat('custom hooks', number(report.hooks.custom))}
    ${stat('clashes', number(report.hooks.collisions.length + report.timers.collisions.length),
      report.hooks.collisions.length + report.timers.collisions.length ? 'warn' : 'ok')}
    ${stat('classes', number(report.entities.total))}
    ${stat('unknown globals', number(unknown), unknown ? 'warn' : 'ok')}
    ${stat('asset refs', number(report.assets.references))}
    ${stat('hot paths', number(report.performance.findings), report.performance.findings ? 'warn' : 'ok')}
  </div>

  <div class="cols">
    <section>
      <h2>By rule</h2>
      <div class="scroll"><table><thead><tr><th>Rule</th><th class="n">Count</th></tr></thead>
      <tbody>${rows(report.diagnostics.byCode, 'nothing reported')}</tbody></table></div>
    </section>

    <section>
      <h2>Unknown globals</h2>
      <p class="note">A framework this project does not contain, or a typo.</p>
      <div class="scroll"><table><thead><tr><th>Name</th><th class="n">Uses</th></tr></thead>
      <tbody>${rows(report.undefinedGlobals, 'every global resolves')}</tbody></table></div>
    </section>

    <section>
      <h2>Collisions</h2>
      <p class="note">A second registration silently replaces the first.</p>
      <div class="scroll"><table>
        <thead><tr><th>Event</th><th>Identifier</th><th class="n">Sites</th></tr></thead>
        <tbody>${
          report.hooks.collisions.length || report.timers.collisions.length
            ? [
                ...report.hooks.collisions.map(
                  (clash) =>
                    `<tr><td><code>${escapeHtml(clash.event)}</code></td>` +
                    `<td><code>${escapeHtml(clash.identifier)}</code></td>` +
                    `<td class="n">${number(clash.count)}</td></tr>`,
                ),
                ...report.timers.collisions.map(
                  (clash) =>
                    `<tr><td class="muted">timer</td><td><code>${escapeHtml(clash.name)}</code></td>` +
                    `<td class="n">${number(clash.count)}</td></tr>`,
                ),
              ].join('')
            : '<tr><td colspan="3" class="ok">no clashes</td></tr>'
        }</tbody>
      </table></div>
    </section>

    <section>
      <h2>Largest classes</h2>
      <div class="scroll"><table><thead><tr><th>Class</th><th class="n">Members</th></tr></thead>
      <tbody>${rows(
        report.entities.largest.map((e) => ({ name: `${e.name} (${e.kind})`, count: e.members })),
        'no scripted classes',
      )}</tbody></table></div>
    </section>
  </div>

  <h2>Hot paths</h2>
  <p class="note">
    Expensive calls the engine reaches ${number(report.performance.entryPoints)} times over,
    from something it runs every frame or tick. Furthest from its entry point first.
  </p>
  <div class="scroll"><table>
    <thead><tr><th>Call</th><th>Reached from</th><th>Where</th></tr></thead>
    <tbody>${
      report.performance.worst.length
        ? report.performance.worst
            .map(
              (f) =>
                `<tr><td><code>${escapeHtml(f.callee)}</code></td>` +
                `<td>${escapeHtml(f.entry)}${
                  f.chain.length ? ` <span class="muted">→ ${escapeHtml(f.chain.join(' → '))}</span>` : ''
                }</td>` +
                `<td><code>${escapeHtml(shortPath(f.file))}:${f.line}</code></td></tr>`,
            )
            .join('')
        : '<tr><td colspan="3" class="ok">nothing expensive on a per-frame path</td></tr>'
    }</tbody>
  </table></div>

  <div class="cols">
    <section>
      <h2>Most repeated on hot paths</h2>
      <div class="scroll"><table><thead><tr><th>Call</th><th class="n">Sites</th></tr></thead>
      <tbody>${rows(report.performance.byCall, 'nothing repeated')}</tbody></table></div>
    </section>

    <section>
      <h2>Never called</h2>
      <p class="note">
        Nothing in this project names these${
          report.deadCode.total > report.deadCode.functions.length
            ? `; ${number(report.deadCode.total)} in total`
            : ''
        }. Fine if another addon calls them.
      </p>
      <div class="scroll"><table><thead><tr><th>Function</th><th>Where</th></tr></thead>
      <tbody>${
        report.deadCode.functions.length
          ? report.deadCode.functions
              .map(
                (fn) =>
                  `<tr><td><code>${escapeHtml(fn.path)}</code></td>` +
                  `<td><code>${escapeHtml(shortPath(fn.file))}:${fn.line}</code></td></tr>`,
              )
              .join('')
          : '<tr><td colspan="2" class="ok">everything is used</td></tr>'
      }</tbody></table></div>
    </section>
  </div>

  <h2>Files to look at</h2>
  <div class="scroll"><table>
    <thead><tr><th>File</th><th class="n">Lines</th><th class="n">Findings</th></tr></thead>
    <tbody>${
      report.worstFiles.length
        ? report.worstFiles
            .map(
              (f) =>
                `<tr><td><code>${escapeHtml(shortPath(f.file))}</code></td>` +
                `<td class="n">${number(f.lines)}</td><td class="n">${number(f.findings)}</td></tr>`,
            )
            .join('')
        : '<tr><td colspan="3" class="ok">nothing stands out</td></tr>'
    }</tbody>
  </table></div>

  <footer>Generated by <code>glua doctor</code>. Counts come from the same analysis the editor uses.</footer>
</main>
`;
}

/** Enough of a path to recognise the file, without the machine it came from. */
function shortPath(file: string): string {
  return file.replace(/\\/g, '/').split('/').slice(-3).join('/');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
