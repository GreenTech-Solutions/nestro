import { describe, expect, it } from 'vitest';
import { compareCodeUnits, uniqueStrings } from '../shared';

describe('compareCodeUnits()', () => {
  it('orders by UTF-16 code unit, so uppercase sorts before lowercase', () => {
    expect(['b', 'B', 'a', 'A'].sort(compareCodeUnits)).toEqual(['A', 'B', 'a', 'b']);
  });

  it('returns 0 only for identical strings and signs the order otherwise', () => {
    expect(compareCodeUnits('a', 'a')).toBe(0);
    expect(compareCodeUnits('a', 'b')).toBe(-1);
    expect(compareCodeUnits('b', 'a')).toBe(1);
    expect(compareCodeUnits('', 'a')).toBe(-1);
  });
});

describe('uniqueStrings()', () => {
  it('drops repeats and keeps first-seen order', () => {
    expect(uniqueStrings(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('returns a new array for an empty input', () => {
    const input: string[] = [];
    expect(uniqueStrings(input)).toEqual([]);
    expect(uniqueStrings(input)).not.toBe(input);
  });
});