// What a file contributes to the rest of the workspace, without its syntax tree.
//
// The workspace already draws this line: `releaseAst` drops the tree and the
// closures that close over it, and everything left is plain data — spans,
// names, paths. Those are the facts the cross-file indexes are built from, and
// they are what makes a global defined in one file visible from another.
//
// Being plain data means they can be written down. Reading a file's facts back
// off disk costs a JSON parse; recomputing them costs a full parse and bind,
// which on measurement is around fifty times more. That is the whole idea
// behind the CLI's cache.
//
// The line to hold: facts are what a file *says*, never what we *think about*
// what it says. A finding is not a fact — `net-never-received` depends on every
// other file in the project, so caching one would go stale the moment an
// unrelated file gained a `net.Receive`. Caching facts and recomputing findings
// from them is correct by construction.

import type { Chunk } from '../parser/ast.js';
import { LineIndex } from '../util/lines.js';
import type { FileAnalysis } from './binder.js';
import { Scope } from './scope.js';
import { UNKNOWN } from './types.js';

/**
 * Bumped when the shape of the facts changes, so a cache written by an older
 * build is discarded rather than misread. Anything that changes what the binder
 * produces needs this, not just a change to the interface below.
 */
export const FACTS_VERSION = 1;

/** Every field of an analysis that outlives its syntax tree. */
export interface FileFacts {
  realm: FileAnalysis['realm'];
  globalDefs: FileAnalysis['globalDefs'];
  globalRefs: FileAnalysis['globalRefs'];
  hookAdds: FileAnalysis['hookAdds'];
  hookRuns: FileAnalysis['hookRuns'];
  netRegisters: FileAnalysis['netRegisters'];
  netStarts: FileAnalysis['netStarts'];
  netReceives: FileAnalysis['netReceives'];
  includes: FileAnalysis['includes'];
  addCSLuaFiles: FileAnalysis['addCSLuaFiles'];
  concommands: FileAnalysis['concommands'];
  convars: FileAnalysis['convars'];
  timers: FileAnalysis['timers'];
  assets: FileAnalysis['assets'];
  accessors: FileAnalysis['accessors'];
  symbols: FileAnalysis['symbols'];
  callGraph: FileAnalysis['callGraph'];
  /** A Set on the analysis; an array here, because JSON has no sets. */
  aliasedGlobals: string[];
}

export function factsOf(analysis: FileAnalysis): FileFacts {
  return {
    realm: analysis.realm,
    globalDefs: analysis.globalDefs,
    globalRefs: analysis.globalRefs,
    hookAdds: analysis.hookAdds,
    hookRuns: analysis.hookRuns,
    netRegisters: analysis.netRegisters,
    netStarts: analysis.netStarts,
    netReceives: analysis.netReceives,
    includes: analysis.includes,
    addCSLuaFiles: analysis.addCSLuaFiles,
    concommands: analysis.concommands,
    convars: analysis.convars,
    timers: analysis.timers,
    assets: analysis.assets,
    accessors: analysis.accessors,
    symbols: analysis.symbols,
    callGraph: analysis.callGraph,
    aliasedGlobals: [...analysis.aliasedGlobals],
  };
}

const EMPTY_CHUNK: Chunk = { type: 'Chunk', body: [], start: 0, end: 0 };

/**
 * An analysis carrying facts and no tree, indistinguishable from one whose tree
 * has been released.
 *
 * Anything wanting the tree calls `Workspace.full`, which re-parses on demand —
 * so a file restored from a cache behaves exactly like one indexed and then
 * released, which is the state the whole project sits in during a lint run
 * anyway.
 */
export function analysisFromFacts(
  uri: string,
  fsPath: string,
  text: string,
  version: number,
  facts: FileFacts,
): FileAnalysis {
  return {
    uri,
    fsPath,
    version,
    text,
    lines: new LineIndex(text),
    hasAst: false,
    chunk: EMPTY_CHUNK,
    comments: [],
    parseErrors: [],
    root: new Scope(null, 0, 0, true),
    unusedLocals: [],
    guardedGlobals: new Set(),
    typeOf: () => UNKNOWN,
    scopeAt: () => new Scope(null, 0, 0, true),
    docFor: () => undefined,
    ...facts,
    aliasedGlobals: new Set(facts.aliasedGlobals),
  };
}
