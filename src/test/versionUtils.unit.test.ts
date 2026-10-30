import { describe, expect, it } from 'vitest';
import {
  compareRawVersions,
  getGreatestVersion,
  getUpdateType,
  isPreReleaseVersion,
  isVersionOutdated,
} from '../utils';

describe('version utils', () => {
  it('does not mark an older latest version as an update', () => {
    expect(getUpdateType('8.23.8', '8.23.7')).toBe('none');
    expect(isVersionOutdated('8.23.8', '8.23.7')).toBe(false);
  });

  it('detects normal semver update levels', () => {
    expect(getUpdateType('^1.2.3', '1.2.4')).toBe('patch');
    expect(getUpdateType('^1.2.3', '1.3.0')).toBe('minor');
    expect(getUpdateType('^1.2.3', '2.0.0')).toBe('breaking');
  });

  it('compares pre-release versions using semver precedence', () => {
    expect(getUpdateType('1.0.0-beta.1', '1.0.0-beta.2')).toBe('patch');
    expect(getUpdateType('1.0.0-beta.2', '1.0.0')).toBe('patch');
    expect(getUpdateType('1.0.0', '1.0.1-alpha.0')).toBe('patch');
  });

  it('can include pre-release versions when selecting the greatest version', () => {
    expect(getGreatestVersion(['1.0.0', '1.1.0-beta.1'], true)).toBe('1.1.0-beta.1');
  });

  it('can exclude pre-release versions when selecting the greatest version', () => {
    expect(getGreatestVersion(['1.0.0', '1.1.0-beta.1'], false)).toBe('1.0.0');
  });

  it('sorts versions using semantic precedence instead of string order', () => {
    expect(compareRawVersions('10.0.0', '9.999.999')).toBeGreaterThan(0);
    expect(compareRawVersions('2.0.0', '2.0.0-beta.1')).toBeGreaterThan(0);
  });

  it('detects pre-release versions', () => {
    expect(isPreReleaseVersion('1.2.3-beta.1')).toBe(true);
    expect(isPreReleaseVersion('1.2.3')).toBe(false);
  });

  it('does not classify an npm alias as a version', () => {
    expect(getUpdateType('1.2.3', 'npm:x@1.2.4')).toBe('none');
    expect(isPreReleaseVersion('npm:x@1.2.3-beta.1')).toBe(false);
    expect(getGreatestVersion(['1.0.0', 'npm:x@9.9.9'], true)).toBe('1.0.0');
    expect(isPreReleaseVersion('>=1.2.3-beta.1 <2.0.0')).toBe(false);
    expect(getGreatestVersion(['1.0.0', '>=9.0.0 <10.0.0'], true)).toBe('1.0.0');
    expect(compareRawVersions('>=9.0.0 <10.0.0', '1.0.0')).toBeLessThan(0);
    expect(compareRawVersions('npm:x@9.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('classifies an alias dependency through the range it points at', () => {
    expect(getUpdateType('npm:x@1.2.3', '1.2.4')).toBe('patch');
    expect(isVersionOutdated('npm:real-pkg@^1.2.3', '2.0.0')).toBe(true);
    expect(getUpdateType('npm:@scope/real@~1.2.3', '1.3.0')).toBe('minor');
    expect(getUpdateType('npm:real-pkg@latest', '2.0.0')).toBe('none');
  });

  it.each([
    ['1.2.3', '1.2.4', 'patch'],
    ['^1.2.3', '1.3.0', 'minor'],
    ['~1.2.3', '2.0.0', 'breaking'],
    ['>=1.2.3', '1.2.4', 'patch'],
    ['>1.2.3', '1.2.4', 'patch'],
    ['>=1.2.3 <2.0.0', '1.2.4', 'patch'],
    ['>=1.2.3 <2.0.0', '1.3.0', 'minor'],
    ['>=1.2.3 <2.0.0', '2.0.0', 'breaking'],
    ['1.2.3 || 2.0.0', '1.2.4', 'patch'],
    ['~1.2.3 || ^2.0.0', '1.3.0', 'minor'],
    ['1.2.3 - 2.0.0', '3.0.0', 'breaking'],
    ['>=1.2.3 <2.0.0', 'latest', 'none'],
    ['>=1.2.3 <2.0.0', '>=1.2.4 <2.0.0', 'none'],
    ['1.x || 2.0.0', '3.0.0', 'none'],
    ['npm:real-pkg@>=1.2.3 <2.0.0', '1.3.0', 'minor'],
    ['<=1.2.3', '1.2.4', 'patch'],
    ['<1.2.3', '1.2.4', 'patch'],
    ['=1.2.3', '1.2.4', 'patch'],
    ['  ^1.2.3  ', '1.2.4', 'patch'],
    ['workspace:1.2.3', '1.2.4', 'patch'],
    ['workspace:^1.2.3', '1.3.0', 'minor'],
    ['1.2.3-beta.1+build.5', '1.2.3', 'patch'],
    ['1.2.3', 'latest', 'none'],
    ['latest', '1.2.3', 'none'],
    ['1.x', '2.0.0', 'none'],
    ['*', '2.0.0', 'none'],
    ['github:user/repo', '2.0.0', 'none'],
    ['file:../pkg', '2.0.0', 'none'],
    ['https://example.com/pkg-1.2.3.tgz', '2.0.0', 'none'],
    ['01.2.3', '2.0.0', 'none'],
  ] as const)('classifies %j -> %j as %s', (current, latest, expected) => {
    expect(getUpdateType(current, latest)).toBe(expected);
  });
});