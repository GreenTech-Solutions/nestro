import { describe, expect, it } from 'vitest';
import { matchesManifestVersion } from '../providers/auditVersionMatching';

describe('matchesManifestVersion()', () => {
  it('matches exact, caret, and tilde specs', () => {
    expect(matchesManifestVersion('1.2.3', '1.2.3')).toBe(true);
    expect(matchesManifestVersion('^1.2.0', '1.9.0')).toBe(true);
    expect(matchesManifestVersion('~1.2.0', '1.3.0')).toBe(false);
  });

  it('matches the target spec of an npm alias', () => {
    expect(matchesManifestVersion('npm:real-pkg@^1.0.0', '1.4.0')).toBe(true);
    expect(matchesManifestVersion('npm:@scope/real-pkg@1.0.0', '1.0.0')).toBe(true);
    expect(matchesManifestVersion('npm:real-pkg@^1.0.0', '2.0.0')).toBe(false);
  });
});