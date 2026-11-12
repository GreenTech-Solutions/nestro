import { parseVersionString, rangeBaseVersion, unwrapNpmAlias } from '../shared';
import type { ParsedSemver } from '../shared';

export type UpdateType = 'none' | 'patch' | 'minor' | 'breaking';

export function getUpdateType(current: string, latest: string): UpdateType {
  const currentSpec = unwrapNpmAlias(current);
  const currentVersion = parseVersionString(currentSpec) ?? rangeBaseVersion(currentSpec);
  const latestVersion = parseVersionString(latest);

  if (currentVersion === undefined || latestVersion === undefined) {
    return 'none';
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return 'none';
  }

  if (latestVersion.major > currentVersion.major) { return 'breaking'; }
  if (latestVersion.minor > currentVersion.minor) { return 'minor'; }
  return 'patch';
}

export function compareRawVersions(left: string, right: string): number {
  const leftVersion = parseVersionString(left);
  const rightVersion = parseVersionString(right);

  if (leftVersion === undefined && rightVersion === undefined) {
    return left.localeCompare(right);
  }
  if (leftVersion === undefined) {
    return -1;
  }
  if (rightVersion === undefined) {
    return 1;
  }

  return compareVersions(leftVersion, rightVersion);
}

export function isPreReleaseVersion(raw: string): boolean {
  return (parseVersionString(raw)?.preRelease.length ?? 0) > 0;
}

function compareVersions(a: ParsedSemver, b: ParsedSemver): number {
  const major = compareNumbers(a.major, b.major);
  if (major !== 0) { return major; }

  const minor = compareNumbers(a.minor, b.minor);
  if (minor !== 0) { return minor; }

  const patch = compareNumbers(a.patch, b.patch);
  if (patch !== 0) { return patch; }

  return comparePreRelease(a.preRelease, b.preRelease);
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function comparePreRelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) { return 0; }
  if (a.length === 0) { return 1; }
  if (b.length === 0) { return -1; }

  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = a[index];
    const right = b[index];

    if (left === undefined) { return -1; }
    if (right === undefined) { return 1; }
    if (left === right) { continue; }

    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === left;
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === right;

    if (leftIsNumber && rightIsNumber) {
      return compareNumbers(leftNumber, rightNumber);
    }
    if (leftIsNumber) { return -1; }
    if (rightIsNumber) { return 1; }
    return left > right ? 1 : -1;
  }

  return 0;
}