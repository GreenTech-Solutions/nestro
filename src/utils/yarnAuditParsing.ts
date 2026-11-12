import { describeError, isRecord } from '../shared';

export interface ParsedLineFailure {
  reason: 'malformed-json' | 'unrecognized-schema';
  detail: string;
}

export function parseJsonLine(line: string, familyLabel: string): unknown | ParsedLineFailure {
  try {
    return JSON.parse(line) as unknown;
  }
  catch (err) {
    return {
      reason: 'malformed-json',
      detail: `${familyLabel} audit contains malformed JSON: ${firstErrorLine(err)}`,
    };
  }
}

export function isLineFailure(value: unknown): value is ParsedLineFailure {
  return isRecord(value)
    && (value.reason === 'malformed-json' || value.reason === 'unrecognized-schema')
    && typeof value.detail === 'string';
}

export function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.trim() !== '');
}

export function firstErrorLine(err: unknown): string {
  return describeError(err).split(/\r?\n/, 1)[0];
}