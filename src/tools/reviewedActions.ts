import { describeError, hasExactKeys, isPlainNumericSemver, isRecord } from '../shared';

export const REVIEWED_ACTIONS_PATH = '.github/reviewed-actions.json';
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const ACTION_LOCATOR_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ReviewedAction {
  readonly sha: string;
  readonly tag: string;
}

export interface ReviewedActionsRegistry {
  readonly actionlint: { readonly sha256: string; readonly version: string };
  readonly actions: Readonly<Record<string, ReviewedAction>>;
}

type UnknownRecord = Record<string, unknown>;

function registryError(detail: string): Error {
  return new Error(`${REVIEWED_ACTIONS_PATH}: ${detail}`);
}

export function parseReviewedActionsRegistry(source: string): ReviewedActionsRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source);
  }
  catch (error) {
    throw registryError(`invalid JSON: ${describeError(error)}`);
  }
  if (!isRecord(value) || !hasExactKeys(value, ['actionlint', 'actions'])) {
    throw registryError('must contain exactly the actionlint and actions entries');
  }
  const { actionlint, actions } = value;
  if (!isRecord(actionlint)
    || !hasExactKeys(actionlint, ['sha256', 'version'])
    || typeof actionlint.sha256 !== 'string'
    || !SHA256_PATTERN.test(actionlint.sha256)
    || typeof actionlint.version !== 'string'
    || !isPlainNumericSemver(actionlint.version)) {
    throw registryError('actionlint must be { sha256: lowercase SHA-256, version: x.y.z }');
  }
  if (!isRecord(actions) || Object.keys(actions).length === 0) {
    throw registryError('actions must be a non-empty mapping');
  }
  const parsed: Record<string, ReviewedAction> = {};
  for (const [locator, entry] of Object.entries(actions)) {
    if (!ACTION_LOCATOR_PATTERN.test(locator)
      || !isRecord(entry)
      || !hasExactKeys(entry, ['sha', 'tag'])
      || typeof entry.sha !== 'string'
      || !FULL_SHA_PATTERN.test(entry.sha)
      || typeof entry.tag !== 'string'
      || !entry.tag.startsWith('v')
      || !isPlainNumericSemver(entry.tag.slice(1))) {
      throw registryError(`${locator} must be an <owner>/<repo> key with { sha: lowercase 40-hex commit, tag: vX.Y.Z }`);
    }
    parsed[locator] = { sha: entry.sha, tag: entry.tag };
  }
  return { actionlint: { sha256: actionlint.sha256, version: actionlint.version }, actions: parsed };
}