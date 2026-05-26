import { describe, expect, it } from 'vitest';
import { getGreatestVersion, getUpdateType, isVersionOutdated } from '../utils';

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
});