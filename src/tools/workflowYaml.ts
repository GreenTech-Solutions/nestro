import { parseDocument, visit } from 'yaml';
import type { Document } from 'yaml';
import { describeError, isRecord } from '../shared';

export interface WorkflowViolation {
  readonly rule: string;
  readonly message: string;
}

export type UnknownRecord = Record<string, unknown>;

export interface StrictYamlOptions {
  /** Rule reported for every load failure. */
  readonly rule: string;
  /** Noun phrase that starts each message, for example `Workflow`. */
  readonly subject: string;
}

export type StrictYamlResult
  = | { readonly loaded: true; readonly document: Document; readonly value: unknown }
    | { readonly loaded: false; readonly violations: WorkflowViolation[] };

function usesAnchorOrAlias(document: Document): boolean {
  let found = false;
  visit(document, {
    Alias: () => {
      found = true;
    },
    Node: (_key, node) => {
      if (isRecord(node) && typeof node.anchor === 'string') {
        found = true;
      }
    },
  });
  return found;
}

/** Parses policy YAML with unique keys and without anchors or aliases; failures come back as violations. */
export function loadStrictYaml(source: string, options: StrictYamlOptions): StrictYamlResult {
  const { rule, subject } = options;
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return { loaded: false, violations: document.errors.map(error => ({ rule, message: error.message })) };
  }
  if (usesAnchorOrAlias(document)) {
    return { loaded: false, violations: [{ rule, message: `${subject} must not use YAML anchors or aliases` }] };
  }
  try {
    return { loaded: true, document, value: document.toJS() };
  }
  catch (error) {
    return {
      loaded: false,
      violations: [{ rule, message: `${subject} could not be resolved: ${describeError(error)}` }],
    };
  }
}