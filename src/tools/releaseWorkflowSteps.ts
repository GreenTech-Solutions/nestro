export interface ReleaseWorkflowPolicyViolation {
  readonly rule: string;
  readonly message: string;
}

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function add(violations: ReleaseWorkflowPolicyViolation[], rule: string, message: string): void {
  violations.push({ rule, message });
}

export function keys(value: UnknownRecord | undefined): string[] {
  return value === undefined ? [] : Object.keys(value).sort((left, right) => left.localeCompare(right));
}

export function exactKeys(value: UnknownRecord | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(keys(value)) === JSON.stringify([...expected].sort((left, right) => left.localeCompare(right)));
}

export function normalizedRun(step: UnknownRecord): string {
  return asString(step.run)?.trim().replaceAll('\r\n', '\n') ?? '';
}

export function executableRun(step: UnknownRecord): string {
  return normalizedRun(step)
    .split('\n')
    .filter(line => !/^\s*#/u.test(line))
    .join('\n');
}

export function steps(job: UnknownRecord | undefined): UnknownRecord[] {
  return Array.isArray(job?.steps) ? job.steps.filter(isRecord) : [];
}

export function findStep(job: UnknownRecord | undefined, name: string): UnknownRecord | undefined {
  return steps(job).find(step => step.name === name);
}

export function hasRun(job: UnknownRecord | undefined, predicate: (run: string, step: UnknownRecord) => boolean): boolean {
  return steps(job).some(step => predicate(executableRun(step), step));
}

export function hasAction(job: UnknownRecord | undefined, reference: string): UnknownRecord | undefined {
  return steps(job).find(step => step.uses === reference);
}