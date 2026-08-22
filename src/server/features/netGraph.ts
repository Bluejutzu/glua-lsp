import type { Workspace } from '../../analyze/workspace.js';

/**
 * A markdown report of every net message in the workspace: who registers it,
 * who sends it, who handles it, and whether the payload lines up.
 *
 * The two halves of a message usually sit in different files and different
 * realms, so this is the only view that shows both at once.
 */
export function buildNetGraph(workspace: Workspace): string {
  const registered = workspace.netRegistered();
  const starts = workspace.netStarts();
  const receives = workspace.netReceives();

  const names = [...new Set([...registered.keys(), ...starts.keys(), ...receives.keys()])].sort();

  if (!names.length) {
    return '# Net messages\n\nNo `net` usage found in the indexed workspace.\n';
  }

  const shortPath = (uri: string): string => {
    const file = workspace.get(uri);
    if (!file) return uri;
    const parts = file.fsPath.replace(/\\/g, '/').split('/');
    const luaAt = parts.findIndex((p) => p.toLowerCase() === 'lua');
    return luaAt >= 0 ? parts.slice(luaAt + 1).join('/') : parts.slice(-2).join('/');
  };

  const lines: string[] = [
    '# Net messages',
    '',
    `${names.length} message${names.length === 1 ? '' : 's'} across ${workspace.size} indexed files.`,
    '',
    '| Message | Registered | Sent from | Received in | Payload |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const name of names) {
    const reg = registered.get(name)?.length ?? 0;
    const sent = starts.get(name)?.length ?? 0;
    const got = receives.get(name)?.length ?? 0;

    let payload = '';
    for (const uri of workspace.uris()) {
      const start = workspace.get(uri)?.netStarts.find((s) => s.name === name && s.writes.length);
      if (start) {
        payload = start.writes.map((w) => w.payload).join(' → ');
        break;
      }
    }

    const flag = (ok: boolean, text: string) => (ok ? text : `⚠ ${text}`);
    lines.push(
      `| \`${name}\` | ${flag(reg > 0, String(reg))} | ${flag(sent > 0, String(sent))} | ` +
        `${flag(got > 0, String(got))} | ${payload || '—'} |`,
    );
  }

  lines.push('', '## Details', '');

  for (const name of names) {
    lines.push(`### \`${name}\``, '');

    const section = (title: string, entries: { uri: string; value: { start: number } }[] | undefined) => {
      if (!entries?.length) {
        lines.push(`- **${title}:** none`);
        return;
      }
      const rendered = entries.map((entry) => {
        const file = workspace.get(entry.uri);
        const line = file ? file.lines.positionAt(entry.value.start).line + 1 : 0;
        return `\`${shortPath(entry.uri)}:${line}\``;
      });
      lines.push(`- **${title}:** ${rendered.join(', ')}`);
    };

    section('util.AddNetworkString', registered.get(name));
    section('net.Start', starts.get(name));
    section('net.Receive', receives.get(name));

    // Payload comparison between the first sender and every receiver.
    let writes: string[] | null = null;
    for (const uri of workspace.uris()) {
      const start = workspace.get(uri)?.netStarts.find((s) => s.name === name && s.writes.length);
      if (start) {
        writes = start.writes.map((w) => w.payload);
        break;
      }
    }
    if (writes) {
      for (const uri of workspace.uris()) {
        for (const receive of workspace.get(uri)?.netReceives ?? []) {
          if (receive.name !== name || !receive.reads.length) continue;
          const reads = receive.reads.map((r) => r.payload);
          const ok = writes.length === reads.length && writes.every((w, i) => w === reads[i]);
          lines.push(
            `- **Payload ${ok ? 'matches' : 'MISMATCH'}** in \`${shortPath(uri)}\`: ` +
              `writes [${writes.join(', ')}] vs reads [${reads.join(', ')}]`,
          );
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
