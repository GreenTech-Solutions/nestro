import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parsePrepareReleaseConfig, parseTagVersion, runReleasePrepare } from '../tools';
import type { RawCommit, ReleasePrepareIo } from '../tools';

const TAG = 'v0.4.2';
const repositoryRoot = resolve(import.meta.dirname, '../..');
const releaseConfig = parsePrepareReleaseConfig(
  JSON.parse(readFileSync(resolve(repositoryRoot, '.releaserc.json'), 'utf8')) as unknown,
);

function makeIo(overrides: Partial<ReleasePrepareIo> = {}): ReleasePrepareIo & {
  readonly outputs: Map<string, string>;
  readonly writes: { readonly packageVersions: string[]; readonly changelog: string[]; readonly notes: string[] };
} {
  const outputs = new Map<string, string>();
  const writes: { packageVersions: string[]; changelog: string[]; notes: string[] } = {
    packageVersions: [],
    changelog: [],
    notes: [],
  };
  const io: ReleasePrepareIo = {
    latestReleaseTag: vi.fn(() => Promise.resolve(TAG)),
    listCommitsSince: vi.fn((_tag: string | undefined): Promise<readonly RawCommit[]> => Promise.resolve([])),
    readPackageVersion: vi.fn(() => Promise.resolve('0.4.2')),
    writePackageVersion: vi.fn((version: string) => {
      writes.packageVersions.push(version);
      return Promise.resolve();
    }),
    prependChangelog: vi.fn((entry: string) => {
      writes.changelog.push(entry);
      return Promise.resolve();
    }),
    writeNotes: vi.fn((notes: string) => {
      writes.notes.push(notes);
      return Promise.resolve();
    }),
    writeOutput: vi.fn((key: string, value: string) => {
      outputs.set(key, value);
      return Promise.resolve();
    }),
    ...overrides,
  };
  return { ...io, outputs, writes };
}

describe('release preparation', () => {
  it('does not write anything for a no-release commit set', async () => {
    const io = makeIo({
      listCommitsSince: vi.fn(() => Promise.resolve([
        { hash: 'a', subject: 'docs: clarify release process', body: '' },
        { hash: 'b', subject: 'ci: run policy', body: '' },
      ])),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig)).resolves.toEqual({
      releaseNeeded: false,
      version: undefined,
      previousVersion: undefined,
    });
    expect(io.writes.packageVersions).toEqual([]);
    expect(io.writes.changelog).toEqual([]);
    expect(io.writes.notes).toEqual([]);
    expect(io.outputs.get('release-needed')).toBe('false');
  });

  it.each([
    ['patch', 'fix: close a race', '0.4.3'],
    ['minor', 'feat: add release preview', '0.5.0'],
    ['breaking', 'feat!: change the package contract', '1.0.0'],
  ])('prepares a %s version and notes', async (_label, subject, version) => {
    const io = makeIo({
      listCommitsSince: vi.fn(() => Promise.resolve([{ hash: 'abcdef1234567', subject, body: '' }])),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig))
      .resolves.toMatchObject({ releaseNeeded: true, version, previousVersion: '0.4.2' });
    expect(io.writes.packageVersions).toEqual([version]);
    expect(io.writes.changelog[0]).toContain(`## [${version}]`);
    expect(io.writes.notes[0]).toContain(subject.startsWith('feat') ? '### Features' : '### Bug Fixes');
    expect(io.outputs.get('release-needed')).toBe('true');
    expect(io.outputs.get('version')).toBe(version);
  });

  it('uses package.json when the repository has no release tag', async () => {
    const io = makeIo({
      latestReleaseTag: vi.fn(() => Promise.resolve(undefined)),
      readPackageVersion: vi.fn(() => Promise.resolve('2.3.4')),
      listCommitsSince: vi.fn((tag) => {
        expect(tag).toBeUndefined();
        return Promise.resolve([{ hash: 'abc', subject: 'fix: patch from the initial version', body: '' }]);
      }),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig)).resolves.toMatchObject({
      releaseNeeded: true,
      previousVersion: '2.3.4',
      version: '2.3.5',
    });
  });

  it('rejects a malformed latest release tag before writing', async () => {
    const io = makeIo({
      latestReleaseTag: vi.fn(() => Promise.resolve('release-0.4.2')),
      listCommitsSince: vi.fn(() => Promise.resolve([{ hash: 'abc', subject: 'fix: patch', body: '' }])),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig)).rejects.toThrow('must match');
    expect(io.writes.packageVersions).toEqual([]);
    expect(io.writes.changelog).toEqual([]);
  });

  it('rejects a package version that is not the latest released version', async () => {
    const io = makeIo({
      readPackageVersion: vi.fn(() => Promise.resolve('0.4.1')),
      listCommitsSince: vi.fn(() => Promise.resolve([{ hash: 'abc', subject: 'fix: patch', body: '' }])),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig))
      .rejects.toThrow('does not match the latest release tag');
    expect(io.writes.packageVersions).toEqual([]);
    expect(io.writes.changelog).toEqual([]);
  });

  it('does not prepare a second release after the version pull request is merged', async () => {
    const io = makeIo({
      readPackageVersion: vi.fn(() => Promise.resolve('0.4.3')),
      listCommitsSince: vi.fn(() => Promise.resolve([
        { hash: 'a', subject: 'fix: close release race', body: '' },
        { hash: 'b', subject: 'ci(release): prepare v0.4.3', body: '' },
      ])),
    });

    await expect(runReleasePrepare(io, 'https://github.com/acme/nestro', '2026-09-11', releaseConfig)).resolves.toEqual({
      releaseNeeded: false,
      version: undefined,
      previousVersion: undefined,
    });
    expect(io.writes.packageVersions).toEqual([]);
    expect(io.writes.changelog).toEqual([]);
    expect(io.writes.notes).toEqual([]);
    expect(io.outputs.get('release-needed')).toBe('false');
  });

  it.each([
    ['v0.4.2', '0.4.2'],
    ['v10.20.30', '10.20.30'],
  ])('parses a release tag %s', (tag, version) => {
    expect(parseTagVersion(tag)).toBe(version);
  });

  it.each(['0.4.2', 'v1.2', 'v1.2.3-beta.1'])('rejects an invalid release tag %s', (tag) => {
    expect(() => parseTagVersion(tag)).toThrow('v<major>.<minor>.<patch>');
  });
});