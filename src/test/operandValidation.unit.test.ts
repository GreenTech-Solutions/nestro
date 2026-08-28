import { describe, expect, it } from 'vitest';
import { validatePackageName, validatePackageVersionSpec } from '../clients';

describe('validatePackageName()', () => {
  it.each([
    ['plain name', 'react'],
    ['scoped name', '@scope/react'],
    ['hyphens and digits', 'is-number2'],
    ['dot-separated name', 'lodash.debounce'],
    ['single-character name', 'a'],
    ['legacy mixed case', 'JSONStream'],
    ['legacy leading dot', '.hidden-legacy-pkg'],
    ['legacy leading underscore', '_legacy-pkg'],
    ['legacy tilde, bang, quote, parens, star', 'left-pad\'!(~)*'],
    ['legacy length over 214 characters', `a${'b'.repeat(220)}`],
    ['scoped legacy mixed case', '@Scope/Name'],
  ] as const)('accepts %s', (_label, name) => {
    expect(() => validatePackageName(name)).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['leading hyphen', '-leading-hyphen'],
    ['double leading hyphen', '--global'],
    ['leading hyphen with value', '--registry=http://evil.test'],
    ['leading space', ' left-pad'],
    ['trailing space', 'left-pad '],
    ['embedded space', 'left pad'],
    ['embedded newline', 'left\npad'],
    ['embedded null byte', 'left\u0000pad'],
    ['embedded dollar sign', 'left$pad'],
    ['embedded semicolon', 'left;pad'],
    ['embedded backtick', 'left`pad'],
    ['bare scope marker', '@'],
    ['scope marker only, no package', '@scope'],
    ['empty scope', '@/pkg'],
    ['empty scoped package name', '@scope/'],
    ['scope with more than one slash', '@scope/name/extra'],
    ['unscoped name with a slash', 'unscoped/name'],
    ['literal @ outside a scope prefix', 'left@pad'],
    ['unpaired surrogate', '\ud800bad'],
  ] as const)('rejects %s', (_label, name) => {
    expect(() => validatePackageName(name)).toThrow();
  });

  it('names the offending value in the error message for a leading hyphen', () => {
    expect(() => validatePackageName('--global')).toThrow('"--global"');
  });

  it('names the offending value in the error message for an invalid scoped form', () => {
    expect(() => validatePackageName('@scope/name/extra')).toThrow('"@scope/name/extra"');
  });

  it('names the offending scope in the error message for an unsafe scope segment', () => {
    expect(() => validatePackageName('@left pad/pkg')).toThrow('"left pad"');
  });

  it('names the offending package segment in the error message for an unsafe name', () => {
    expect(() => validatePackageName('@scope/left pad')).toThrow('"left pad"');
  });

  it('rejects an unpaired surrogate with a normal named-operand message, not a raw URIError', () => {
    expect(() => validatePackageName('\ud800bad')).toThrow(/contains characters a registry URL can't carry/);
    expect(() => validatePackageName('\ud800bad')).not.toThrow(/URI malformed/);
  });
});

describe('validatePackageVersionSpec()', () => {
  it.each([
    ['exact semver', '18.0.0'],
    ['prerelease', '18.0.0-beta.1'],
    ['prerelease with build metadata', '18.0.0-beta.1+build.5'],
    ['workspace spec', 'workspace:^1.0.0'],
    ['dist-tag', 'latest'],
    ['caret range', '^18.0.0'],
  ] as const)('accepts %s', (_label, version) => {
    expect(() => validatePackageVersionSpec(version)).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['leading hyphen', '-1.0.0'],
    ['flag-shaped value', '--registry=http://evil.test'],
    ['embedded newline', '1.0.0\n--global'],
    ['embedded null byte', '1.0.0\u0000'],
  ] as const)('rejects %s', (_label, version) => {
    expect(() => validatePackageVersionSpec(version)).toThrow();
  });

  it('names the offending value in the error message', () => {
    expect(() => validatePackageVersionSpec('--registry=http://evil.test'))
      .toThrow('"--registry=http://evil.test"');
  });
});