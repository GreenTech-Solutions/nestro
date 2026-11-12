import { describe, expect, it } from 'vitest';
import {
  extractRangePrefix,
  isConcreteSemver,
  isVersionOperand,
  parseConcreteSemver,
  parseVersionString,
  rangeBaseVersion,
  stripVersionDecorations,
  unwrapNpmAlias,
} from '../shared';

describe('parseConcreteSemver()', () => {
  it('splits core, pre-release and ignores build metadata', () => {
    expect(parseConcreteSemver('1.2.3-beta.1+build.5')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      preRelease: ['beta', '1'],
    });
    expect(parseConcreteSemver('10.0.0')).toEqual({ major: 10, minor: 0, patch: 0, preRelease: [] });
  });

  it.each([
    '', '1.2', '01.2.3', '1.2.3-', '1.2.3-01', 'v1.2.3', '^1.2.3', ' 1.2.3', 'npm:x@1.2.3',
    'x1.2.3', '1.2.3 ', '1.2.3-beta..1',
  ])('rejects %j', (raw) => {
    expect(parseConcreteSemver(raw)).toBeUndefined();
    expect(isConcreteSemver(raw)).toBe(false);
  });
});

describe('parseVersionString()', () => {
  it.each([
    ['1.2.3', 1],
    ['^1.2.3', 1],
    ['~1.2.3', 1],
    ['>=1.2.3', 1],
    ['>1.2.3', 1],
    ['<=1.2.3', 1],
    ['<1.2.3', 1],
    ['=1.2.3', 1],
    ['workspace:^1.2.3', 1],
    ['workspace:1.2.3', 1],
    ['  1.2.3  ', 1],
  ])('parses %j', (raw, major) => {
    expect(parseVersionString(raw)?.major).toBe(major);
  });

  it.each([
    'npm:x@1.2.3', 'npm:@scope/x@^1.2.3', 'latest', '*', '1.x', '>=1.2.3 <2.0.0', '1.2.3 || 2.0.0',
    'github:user/repo', 'file:../pkg', 'https://example.com/pkg-1.2.3.tgz', 'workspace:*', '',
  ])('does not classify %j as a version', (raw) => {
    expect(parseVersionString(raw)).toBeUndefined();
  });
});

describe('extractRangePrefix() / stripVersionDecorations()', () => {
  it.each([
    ['1.2.3', '', '1.2.3'],
    ['^1.2.3', '^', '1.2.3'],
    ['~1.2.3', '~', '1.2.3'],
    ['>=1.2.3', '>=', '1.2.3'],
    ['>1.2.3', '>', '1.2.3'],
    ['<=1.2.3', '<=', '1.2.3'],
    ['<1.2.3', '<', '1.2.3'],
    ['workspace:^1.2.3', '', '1.2.3'],
    ['workspace:1.2.3', '', '1.2.3'],
    ['npm:x@^1.2.3', '', 'npm:x@^1.2.3'],
  ])('%j -> prefix %j, bare %j', (spec, prefix, bare) => {
    expect(extractRangePrefix(spec)).toBe(prefix);
    expect(stripVersionDecorations(spec)).toBe(bare);
  });
});

describe('isVersionOperand()', () => {
  it.each([
    '1.2.3', '^1.2.3', '~1.2.3-rc.1', '1.2.3+build.5', 'latest', 'next', 'beta-1.x',
    'workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.2.3', 'workspace:1.2.3',
  ])('accepts %j', (spec) => {
    expect(isVersionOperand(spec)).toBe(true);
  });

  it.each([
    '', '-1.2.3', '1.2', '01.2.3', '>=1.2.3', '1.2.3 || 2.0.0', 'npm:x@1.2.3', '1.2.3; rm -rf /',
    '$(whoami)', 'workspace:', 'workspace:>=1.0.0', 'file:../x', '1.2.3\n',
  ])('rejects %j', (spec) => {
    expect(isVersionOperand(spec)).toBe(false);
  });
});

describe('unwrapNpmAlias()', () => {
  it.each([
    ['npm:real-pkg@^1.2.3', '^1.2.3'],
    ['npm:@scope/real@1.2.3', '1.2.3'],
    ['npm:real-pkg@latest', 'latest'],
    ['^1.2.3', '^1.2.3'],
    ['npm:real-pkg', 'npm:real-pkg'],
    ['github:user/repo', 'github:user/repo'],
  ])('%j -> %j', (spec, expected) => {
    expect(unwrapNpmAlias(spec)).toBe(expected);
  });
});

describe('rangeBaseVersion()', () => {
  it.each([
    ['>=1.2.3 <2.0.0', 1, 2, 3],
    ['>=1.2.3', 1, 2, 3],
    ['<2.0.0 >=1.2.3', 2, 0, 0],
    ['1.2.3 || 2.0.0', 1, 2, 3],
    ['~1.2.3 || ^2.0.0', 1, 2, 3],
    ['^2.0.0', 2, 0, 0],
    ['=v1.2.3', 1, 2, 3],
    ['v1.2.3', 1, 2, 3],
    ['1.2.3 - 2.0.0', 1, 2, 3],
    ['workspace:>=1.2.3 <2.0.0', 1, 2, 3],
    ['  >= 1.2.3', undefined, undefined, undefined],
  ])('%j -> %j.%j.%j', (spec, major, minor, patch) => {
    const parsed = rangeBaseVersion(spec);
    expect(parsed?.major).toBe(major);
    expect(parsed?.minor).toBe(minor);
    expect(parsed?.patch).toBe(patch);
  });

  it.each([
    '', '*', '1.x', '1.x || 2.0.0', '>=1.2 <2.0.0', 'latest', 'npm:x@1.2.3', 'github:user/repo',
    'https://example.com/pkg-1.2.3.tgz', '01.2.3', '|| 1.2.3',
  ])('has no base version for %j', (spec) => {
    expect(rangeBaseVersion(spec)).toBeUndefined();
  });
});