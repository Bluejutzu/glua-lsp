// Call hierarchy: who calls this, and what does it call.
//
// The workspace call graph already knows both, so this is mostly a matter of
// turning unit references into protocol items. What it cannot answer it leaves
// out rather than guessing: a call through a value — `handler()` where handler
// was passed in — has no name to resolve, and inventing an edge there would put
// a wrong answer in a tree people use to reason about control flow.

import {
  SymbolKind,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type Position,
  type Range,
} from 'vscode-languageserver';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { FileAnalysis } from '../../analyze/binder.js';
import type { CallUnit } from '../../analyze/callgraph.js';
import { entryLabel, type UnitRef } from '../../analyze/hotpath.js';
import type { Workspace } from '../../analyze/workspace.js';

/** What we put in `data` so a follow-up request finds the same unit again. */
interface ItemData {
  uri: string;
  index: number;
}

const KINDS: Record<CallUnit['kind'], SymbolKind> = {
  chunk: SymbolKind.File,
  global: SymbolKind.Function,
  method: SymbolKind.Method,
  local: SymbolKind.Function,
  anonymous: SymbolKind.Function,
};

function itemFor(workspace: Workspace, ref: UnitRef): CallHierarchyItem | null {
  const unit = workspace.calls().unitAt(ref);
  const file = workspace.get(ref.uri);
  if (!unit || !file) return null;

  const range = file.lines.rangeAt(unit.span.start, unit.span.end);
  const selection = unit.nameSpan.end > unit.nameSpan.start
    ? file.lines.rangeAt(unit.nameSpan.start, unit.nameSpan.end)
    : { start: range.start, end: range.start };

  return {
    name: unit.name,
    kind: KINDS[unit.kind],
    uri: ref.uri,
    range,
    selectionRange: selection,
    detail: unit.entry
      ? entryLabel(unit.entry)
      : path.basename(URI.parse(ref.uri).fsPath),
    data: { uri: ref.uri, index: ref.index } satisfies ItemData,
  };
}

const refOf = (item: CallHierarchyItem): UnitRef | null => {
  const data = item.data as ItemData | undefined;
  if (!data || typeof data.index !== 'number' || typeof data.uri !== 'string') return null;
  return { uri: data.uri, index: data.index };
};

/**
 * The function the cursor is on. A name is the obvious anchor; a call is
 * treated as its target, so opening the tree on `MyAddon.Draw()` starts at the
 * definition rather than at whatever contains the call.
 */
export function prepareCallHierarchy(
  analysis: FileAnalysis,
  position: Position,
  workspace: Workspace,
): CallHierarchyItem[] {
  const calls = workspace.calls();
  const offset = analysis.lines.offsetAt(position);

  const named = calls.unitNamedAt(analysis.uri, offset);
  if (named) {
    const item = itemFor(workspace, named);
    return item ? [item] : [];
  }

  const containing = calls.unitContaining(analysis.uri, offset);
  if (!containing) return [];

  const unit = calls.unitAt(containing);
  const site = unit?.calls.find((call) => offset >= call.span.start && offset <= call.span.end);
  if (site) {
    const targets = calls
      .resolve(analysis.uri, site.callee)
      .map((ref) => itemFor(workspace, ref))
      .filter((item): item is CallHierarchyItem => item !== null);
    if (targets.length) return targets;
  }

  const item = itemFor(workspace, containing);
  return item ? [item] : [];
}

export function incomingCalls(
  item: CallHierarchyItem,
  workspace: Workspace,
): CallHierarchyIncomingCall[] {
  const ref = refOf(item);
  if (!ref) return [];

  const byCaller = new Map<string, { from: CallHierarchyItem; ranges: Range[] }>();
  for (const edge of workspace.calls().callsTo(ref)) {
    const file = workspace.get(edge.from.uri);
    if (!file) continue;
    const key = `${edge.from.uri} ${edge.from.index}`;
    let entry = byCaller.get(key);
    if (!entry) {
      const from = itemFor(workspace, edge.from);
      if (!from) continue;
      entry = { from, ranges: [] };
      byCaller.set(key, entry);
    }
    entry.ranges.push(file.lines.rangeAt(edge.site.span.start, edge.site.span.end));
  }

  return [...byCaller.values()].map(({ from, ranges }) => ({ from, fromRanges: ranges }));
}

export function outgoingCalls(
  item: CallHierarchyItem,
  workspace: Workspace,
): CallHierarchyOutgoingCall[] {
  const ref = refOf(item);
  if (!ref) return [];
  const file = workspace.get(ref.uri);
  if (!file) return [];

  const byTarget = new Map<string, { to: CallHierarchyItem; ranges: Range[] }>();
  for (const { site, targets } of workspace.calls().callsFrom(ref)) {
    for (const target of targets) {
      const key = `${target.uri} ${target.index}`;
      let entry = byTarget.get(key);
      if (!entry) {
        const to = itemFor(workspace, target);
        if (!to) continue;
        entry = { to, ranges: [] };
        byTarget.set(key, entry);
      }
      entry.ranges.push(file.lines.rangeAt(site.span.start, site.span.end));
    }
  }

  return [...byTarget.values()].map(({ to, ranges }) => ({ to, fromRanges: ranges }));
}
