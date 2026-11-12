import { describe, expect, it } from 'vitest';
import { asString, describeError, describeStderr, hasExactKeys, isRecord, readRequiredString } from '../shared';

describe('isRecord()', () => {
  it('accepts plain objects, including empty ones and class instances', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(new Map())).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    for (const value of [null, undefined, [], [1], 'text', 1, true, () => undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('asString()', () => {
  it('returns strings unchanged, including the empty string', () => {
    expect(asString('x')).toBe('x');
    expect(asString('')).toBe('');
  });

  it('returns undefined for non-strings', () => {
    for (const value of [1, null, undefined, {}, ['x']]) {
      expect(asString(value)).toBeUndefined();
    }
  });
});

describe('readRequiredString()', () => {
  it('returns the original string when it has non-whitespace content', () => {
    expect(readRequiredString(' a ')).toBe(' a ');
  });

  it('returns undefined for blank strings and non-strings', () => {
    for (const value of ['', '  \t', 1, null, undefined, {}]) {
      expect(readRequiredString(value)).toBeUndefined();
    }
  });
});

describe('hasExactKeys()', () => {
  it('matches the same key set in any order', () => {
    expect(hasExactKeys({ b: 1, a: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({}, [])).toBe(true);
  });

  it('rejects missing, extra and differently named keys', () => {
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2 }, ['a'])).toBe(false);
    expect(hasExactKeys({ a: 1 }, ['b'])).toBe(false);
  });

  it('orders keys by code unit, so mixed-case names compare equal regardless of input order', () => {
    expect(hasExactKeys({ b: 1, B: 2, a: 3 }, ['a', 'B', 'b'])).toBe(true);
  });
});

describe('describeError()', () => {
  it('returns the message of an Error, unmodified and multi-line included', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(new TypeError('first\nsecond'))).toBe('first\nsecond');
  });

  it('stringifies anything else', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError(42)).toBe('42');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError({ message: 'not an Error' })).toBe('[object Object]');
  });
});

describe('describeStderr()', () => {
  it('appends trimmed stderr as a failure-message suffix', () => {
    expect(describeStderr('  denied\n')).toBe('; stderr: denied');
  });

  it('is empty when stderr has no content', () => {
    expect(describeStderr('')).toBe('');
    expect(describeStderr(' \n\t')).toBe('');
  });
});