import { describe, expect, it } from 'vitest';
import { comparePublishedVsix } from '../tools';
import { buildZipFixture, cleanVsixFixtureEntries, SYMLINK_FILE_MODE } from './fixtures/vsixFixtures';

describe('published registry artifact comparison', () => {
  it('accepts exact bytes and reports exact mode', () => {
    const candidate = buildZipFixture(cleanVsixFixtureEntries());
    expect(comparePublishedVsix(candidate, candidate)).toMatchObject({ mode: 'exact' });
  });

  it('accepts only an explicit re-pack with identical paths and contents', () => {
    const entries = cleanVsixFixtureEntries();
    const candidate = buildZipFixture(entries);
    const repacked = buildZipFixture(entries.map(entry => ({ ...entry, method: 'stored' as const })));

    const comparison = comparePublishedVsix(candidate, repacked);
    expect(comparison.mode).toBe('repacked');
    expect(comparison.candidateSha256).not.toBe(comparison.publishedSha256);
  });

  it('rejects content, identity and unsafe-entry substitutions', () => {
    const entries = cleanVsixFixtureEntries();
    const candidate = buildZipFixture(entries);
    const contentMismatch = buildZipFixture(entries.map(entry => entry.path === 'extension/readme.md'
      ? { ...entry, content: '# forged\n' }
      : entry));
    expect(() => comparePublishedVsix(candidate, contentMismatch)).toThrow('normalized path/content');

    const identityMismatch = buildZipFixture(entries.map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: String(entry.content).replace('"name":"nestro"', '"name":"forged"') }
      : entry));
    expect(() => comparePublishedVsix(candidate, identityMismatch)).toThrow('package and outer manifest identities');

    const symlink = buildZipFixture(entries.map(entry => entry.path === 'extension/readme.md'
      ? { ...entry, unixMode: SYMLINK_FILE_MODE }
      : entry));
    expect(() => comparePublishedVsix(candidate, symlink)).toThrow('symlink');
  });
});