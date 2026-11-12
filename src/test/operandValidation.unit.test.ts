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
    ['zero version', '0.0.0'],
    ['prerelease', '18.0.0-beta.1'],
    ['numeric prerelease', '1.0.0-0.3.7'],
    ['prerelease with build metadata', '18.0.0-beta.1+build.5'],
    ['build metadata only', '1.0.0+20130313144700'],
    ['caret range', '^18.0.0'],
    ['tilde range', '~18.2.1'],
    ['caret prerelease', '^1.0.0-rc.1'],
    ['dist-tag', 'latest'],
    ['dist-tag with hyphen', 'next-18'],
    ['dist-tag with dot and digits', 'canary.2'],
    ['workspace caret spec', 'workspace:^1.0.0'],
    ['workspace exact spec', 'workspace:1.0.0'],
    ['workspace tilde spec', 'workspace:~1.0.0'],
    ['workspace star', 'workspace:*'],
    ['workspace bare caret', 'workspace:^'],
    ['workspace bare tilde', 'workspace:~'],
  ] as const)('accepts %s', (_label, version) => {
    expect(() => validatePackageVersionSpec(version)).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['leading hyphen', '-1.0.0'],
    ['flag-shaped value', '--registry=http://evil.test'],
    ['embedded newline', '1.0.0\n--global'],
    ['embedded null byte', '1.0.0\u0000'],
    ['double quote', '1.0.0"'],
    ['dollar sign', '1.0.0$HOME'],
    ['command substitution', '$(id)'],
    ['backtick', '1.0.0`id`'],
    ['ampersand', '1.0.0&calc'],
    ['pipe', '1.0.0|calc'],
    ['percent expansion', '%PATH%'],
    ['semicolon', '1.0.0;id'],
    ['single quote', '1.0.0\''],
    ['redirect', '1.0.0>out'],
    ['backslash', '1.0.0\\x'],
    ['space', '1.0.0 --global'],
    ['tab', '1.0.0\t'],
    ['parenthesis', '(1.0.0)'],
    ['caret metacharacter', '1.0.0^'],
    ['leading zero', '01.0.0'],
    ['two-component version', '1.0'],
    ['comparator range', '>=1.0.0'],
    ['compound range', '^1.0.0 || ^2.0.0'],
    ['wildcard range', '1.x'],
    ['bare star', '*'],
    ['dist-tag with shell metacharacter', 'latest$x'],
    ['dist-tag starting with a digit', '2latest'],
    ['unknown protocol', 'file:../pkg'],
    ['npm alias', 'npm:other@1.0.0'],
    ['url', 'https://evil.test/pkg.tgz'],
    ['workspace with metacharacter', 'workspace:^1.0.0;id'],
    ['workspace with empty remainder', 'workspace:'],
    ['workspace with dist-tag', 'workspace:latest'],
    ['non-ASCII digit', '１.0.0'],
  ] as const)('rejects %s', (_label, version) => {
    expect(() => validatePackageVersionSpec(version)).toThrow();
  });

  it('names the offending value in the error message', () => {
    expect(() => validatePackageVersionSpec('--registry=http://evil.test'))
      .toThrow('"--registry=http://evil.test"');
  });

  it('names the offending value in the error message for a shell metacharacter', () => {
    expect(() => validatePackageVersionSpec('1.0.0&calc')).toThrow('"1.0.0&calc"');
  });
});