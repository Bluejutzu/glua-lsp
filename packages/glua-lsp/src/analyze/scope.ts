import type { GType } from './types.js';
import { UNKNOWN } from './types.js';

export type VarKind = 'local' | 'param' | 'self' | 'loop' | 'vararg';

export interface VarRef {
  start: number;
  end: number;
  write: boolean;
}

export interface VarSymbol {
  name: string;
  kind: VarKind;
  /** Offset from which the name is visible. Lua locals start *after* their statement. */
  visibleFrom: number;
  /** Range of the declaring identifier itself, for go-to-definition. */
  declStart: number;
  declEnd: number;
  scope: Scope;
  type: GType;
  refs: VarRef[];
  /** Documentation comment immediately above the declaration, if any. */
  doc?: string;
}

export class Scope {
  readonly children: Scope[] = [];
  /** Declarations per name, in source order — later ones shadow earlier ones. */
  private readonly decls = new Map<string, VarSymbol[]>();

  constructor(
    readonly parent: Scope | null,
    readonly start: number,
    public end: number,
    /** Function scopes stop `...` and `self` resolution from escaping outward. */
    readonly isFunction: boolean = false,
  ) {
    parent?.children.push(this);
  }

  declare(
    name: string,
    kind: VarKind,
    declStart: number,
    declEnd: number,
    visibleFrom = declEnd,
    type: GType = UNKNOWN,
  ): VarSymbol {
    const symbol: VarSymbol = {
      name,
      kind,
      visibleFrom,
      declStart,
      declEnd,
      scope: this,
      type,
      refs: [],
    };
    const list = this.decls.get(name);
    if (list) list.push(symbol);
    else this.decls.set(name, [symbol]);
    return symbol;
  }

  /**
   * Innermost visible declaration of `name` at `offset`.
   *
   * The offset check is what makes `local x = x` resolve the right-hand `x` to
   * the outer variable, exactly as Lua does.
   */
  lookup(name: string, offset: number): VarSymbol | undefined {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const list = scope.decls.get(name);
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          const sym = list[i]!;
          if (sym.visibleFrom <= offset) return sym;
        }
      }
      if (scope.isFunction && (name === '...' || name === 'self')) {
        // These never resolve past their own function boundary.
        return undefined;
      }
    }
    return undefined;
  }

  /** Every declaration visible at `offset`, nearest scope first, no shadowed dupes. */
  visibleAt(offset: number): VarSymbol[] {
    const out: VarSymbol[] = [];
    const seen = new Set<string>();
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      for (const [name, list] of scope.decls) {
        if (seen.has(name)) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          const sym = list[i]!;
          if (sym.visibleFrom <= offset) {
            out.push(sym);
            seen.add(name);
            break;
          }
        }
      }
    }
    return out;
  }

  ownDeclarations(): VarSymbol[] {
    return [...this.decls.values()].flat();
  }

  allDeclarations(): VarSymbol[] {
    const out = this.ownDeclarations();
    for (const child of this.children) out.push(...child.allDeclarations());
    return out;
  }

  /** Deepest scope containing `offset`. */
  scopeAt(offset: number): Scope {
    for (const child of this.children) {
      if (offset >= child.start && offset <= child.end) return child.scopeAt(offset);
    }
    return this;
  }
}
