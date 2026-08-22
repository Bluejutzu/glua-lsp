import {
  MarkupKind,
  type ParameterInformation,
  type Position,
  type SignatureHelp,
  type SignatureInformation,
} from 'vscode-languageserver';
import type { GmodApi } from '../../api/index.js';
import type { ApiFunction, ApiParam } from '../../api/types.js';
import { exprToPath, type FileAnalysis } from '../../analyze/binder.js';
import { enclosingCall } from '../context.js';
import { signatureLine } from '../render.js';

export function signatureHelp(
  analysis: FileAnalysis,
  position: Position,
  api: GmodApi,
): SignatureHelp | null {
  const offset = analysis.lines.offsetAt(position);
  const enclosing = enclosingCall(analysis, offset);
  if (!enclosing) return null;

  const { call, argIndex } = enclosing;
  const calleeType = analysis.typeOf(call.base);

  // A documented API function gives us parameter docs; a local function at
  // least gives us its parameter names.
  if (calleeType.kind === 'function' && calleeType.api) {
    return apiSignature(calleeType.api, argIndex);
  }

  if (calleeType.kind === 'function' && calleeType.node) {
    const params = calleeType.node.params.map<ParameterInformation>((p) => ({
      label: p.type === 'VarargLiteral' ? '...' : p.name,
    }));
    const name = exprToPath(call.base) ?? 'function';
    return {
      signatures: [
        {
          label: `${name}(${params.map((p) => p.label).join(', ')})`,
          parameters: params,
        },
      ],
      activeSignature: 0,
      activeParameter: Math.min(argIndex, Math.max(0, params.length - 1)),
    };
  }

  return null;
}

function apiSignature(fn: ApiFunction, argIndex: number): SignatureHelp {
  const forms = [
    { params: fn.params, returns: fn.returns, description: fn.description },
    ...(fn.overloads ?? []),
  ];

  const signatures = forms.map((form) => buildSignature(fn, form.params, form.returns, form.description));

  // Prefer the overload that can actually accept this many arguments.
  const best = forms.findIndex((form) => argIndex < Math.max(form.params.length, 1));

  return {
    signatures,
    activeSignature: best === -1 ? 0 : best,
    activeParameter: clampParameter(forms[best === -1 ? 0 : best]!.params, argIndex),
  };
}

function clampParameter(params: ApiParam[], argIndex: number): number {
  const last = params[params.length - 1];
  const isVararg = Boolean(last && (last.type === 'vararg' || last.name === '...'));
  const limit = Math.max(0, params.length - 1);
  return isVararg ? Math.min(argIndex, limit) : Math.max(0, Math.min(argIndex, limit));
}

function buildSignature(
  fn: ApiFunction,
  params: ApiParam[],
  returns: ApiParam[],
  description: string | undefined,
): SignatureInformation {
  const parameters: ParameterInformation[] = params.map((param) => {
    const optional = param.optional || param.default !== undefined;
    const label = `${param.name || param.type}${optional ? '?' : ''}: ${param.type}`;
    const docs: string[] = [];
    if (param.description) docs.push(param.description);
    if (param.default !== undefined) docs.push(`*Defaults to \`${param.default}\`.*`);
    return {
      label,
      ...(docs.length
        ? { documentation: { kind: MarkupKind.Markdown, value: docs.join('\n\n') } }
        : {}),
    };
  });

  const returnLabel = returns.length
    ? ` -> ${returns.map((r) => `${r.name || r.type}: ${r.type}`).join(', ')}`
    : '';

  const signature: SignatureInformation = {
    label: `${signatureLine(fn).split('(')[0]}(${parameters.map((p) => p.label).join(', ')})${returnLabel}`,
    parameters,
  };

  if (description) {
    signature.documentation = { kind: MarkupKind.Markdown, value: description };
  }

  return signature;
}
