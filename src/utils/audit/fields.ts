import { isRecord, readRequiredString } from '../../shared';
import type { AuditFixAvailability } from '../auditReport';

/** An advisory id: a finite number or a non-blank string. */
export function isAdvisoryId(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : readRequiredString(value) !== undefined;
}

/** Reads a `fixAvailable` field: a boolean, or an object carrying at least one known fix property. */
export function parseFixAvailable(value: unknown): AuditFixAvailability | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const name = readRequiredString(value.name);
  const version = readRequiredString(value.version);
  const isSemVerMajor = typeof value.isSemVerMajor === 'boolean' ? value.isSemVerMajor : undefined;
  return name === undefined && version === undefined && isSemVerMajor === undefined
    ? undefined
    : { name, version, isSemVerMajor };
}