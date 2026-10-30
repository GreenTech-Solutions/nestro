import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REVIEWED_ACTIONS_PATH = '.github/reviewed-actions.json';
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const ACTION_LOCATOR_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ACTION_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const ACTIONLINT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_ROOT = resolve(__dirname, '../..');

export interface ReviewedAction {
  readonly sha: string;
  readonly tag: string;
}

export interface ReviewedActionsRegistry {
  readonly actionlint: { readonly sha256: string; readonly version: string };
  readonly actions: Readonly<Record<string, ReviewedAction>>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function registryError(detail: string): Error {
  return new Error(`${REVIEWED_ACTIONS_PATH}: ${detail}`);
}

export function parseReviewedActionsRegistry(source: string): ReviewedActionsRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source);
  }
  catch (error) {
    throw registryError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
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
    || !ACTIONLINT_VERSION_PATTERN.test(actionlint.version)) {
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
      || !ACTION_TAG_PATTERN.test(entry.tag)) {
      throw registryError(`${locator} must be an <owner>/<repo> key with { sha: lowercase 40-hex commit, tag: vX.Y.Z }`);
    }
    parsed[locator] = { sha: entry.sha, tag: entry.tag };
  }
  return { actionlint: { sha256: actionlint.sha256, version: actionlint.version }, actions: parsed };
}

export function loadReviewedActionsRegistry(rootDirectory: string = REPOSITORY_ROOT): ReviewedActionsRegistry {
  return parseReviewedActionsRegistry(readFileSync(resolve(rootDirectory, REVIEWED_ACTIONS_PATH), 'utf8'));
}

export const REVIEWED_REGISTRY = loadReviewedActionsRegistry();

export function reviewedActionReference(locator: string): string {
  const action = Object.hasOwn(REVIEWED_REGISTRY.actions, locator) ? REVIEWED_REGISTRY.actions[locator] : undefined;
  if (action === undefined) {
    throw registryError(`${locator} is not a reviewed action`);
  }
  return `${locator}@${action.sha}`;
}