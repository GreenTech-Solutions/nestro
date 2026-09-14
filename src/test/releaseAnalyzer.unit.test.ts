import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeReleaseBump,
  computeNextVersion,
  generateReleaseNotes,
  parsePrepareReleaseConfig,
  releaseNotesBody,
  renderChangelogEntry,
  validatePrepareReleaseConfig,
} from '../tools';
import type { PrepareReleaseConfig, RawCommit } from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const releaseConfig = parsePrepareReleaseConfig(
  JSON.parse(readFileSync(resolve(repositoryRoot, '.releaserc.json'), 'utf8')) as unknown,
);

function commit(hash: string, subject: string, body = ''): RawCommit {
  return { hash, subject, body };
}

describe('release analyzer', () => {
  it('accepts the isolated analyze-and-notes configuration', () => {
    expect(validatePrepareReleaseConfig(releaseConfig)).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['a non-master branch', { branches: ['release'], tagFormat: 'v${version}', plugins: [] }],
    ['a mutable tag format', { branches: ['master'], tagFormat: '${version}', plugins: [] }],
    ['a missing plugin', { branches: ['master'], tagFormat: 'v${version}', plugins: [['only', {}]] }],
    ['a publish plugin', {
      branches: ['master'],
      tagFormat: 'v${version}',
      plugins: [
        ['@semantic-release/commit-analyzer', {}],
        ['@semantic-release/github', {}],
      ],
    }],
    ['a plugin with invalid options', {
      branches: ['master'],
      tagFormat: 'v${version}',
      plugins: [['@semantic-release/commit-analyzer']],
    }],
  ])('rejects %s', (_label, value) => {
    expect(validatePrepareReleaseConfig(value)).not.toEqual([]);
  });

  it('returns the validated config without changing plugin options', () => {
    const value = {
      branches: ['master'],
      tagFormat: 'v${version}',
      plugins: [
        ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits', releaseRules: [{ type: 'part', release: 'patch' }] }],
        ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits', presetConfig: { types: [] } }],
      ],
    };
    const parsed = parsePrepareReleaseConfig(value);
    expect(parsed.plugins[0][1]).toBe(value.plugins[0][1]);
    expect(parsed.plugins[1][1]).toBe(value.plugins[1][1]);
  });

  it.each([
    ['no release', [commit('a', 'docs: clarify release process')], undefined],
    ['patch', [commit('b', 'fix: close a race')], 'patch'],
    ['minor', [commit('c', 'feat: add a feature')], 'minor'],
    ['breaking', [commit('d', 'docs: rewrite docs', 'BREAKING CHANGE: migrate clients')], 'major'],
    ['custom patch type', [commit('e', 'part: close part of a race')], 'patch'],
    ['custom maintenance type', [commit('f', 'refactoring(core): extract code')], 'patch'],
  ] as const)('uses the commit-analyzer plugin for the %s bump', async (_label, commits, expected) => {
    await expect(analyzeReleaseBump(commits, releaseConfig, repositoryRoot)).resolves.toBe(expected);
  });

  it('uses the release-notes-generator plugin and the configured sections', async () => {
    const generated = await generateReleaseNotes(
      [
        commit('1234567890', 'spark: small change'),
        commit('abcdef1234', 'fix(provider): close race'),
        commit('7654321', 'feat: add preview'),
        commit('9876543', 'perf: avoid duplicate work'),
        commit('fedcba9', 'docs: update docs'),
      ],
      releaseConfig,
      '0.4.2',
      '0.4.3',
      'patch',
      'v0.4.2',
      '2026-09-11',
      'https://github.com/acme/nestro',
      repositoryRoot,
    );
    expect(generated).toContain('## [0.4.3](https://github.com/acme/nestro/compare/v0.4.2...v0.4.3) (2026-09-11)');
    expect(releaseNotesBody(generated)).toContain('### Features');
    expect(releaseNotesBody(generated)).toContain('### Bug Fixes');
    expect(releaseNotesBody(generated)).toContain('### Performance');
    expect(releaseNotesBody(generated)).toContain('### Small changes');
    expect(releaseNotesBody(generated)).not.toContain('update docs');
    expect(releaseNotesBody(generated)).toContain('[abcdef1](https://github.com/acme/nestro/commit/abcdef1234)');
  });

  it('passes changed release rules to the actual analyzer plugin', async () => {
    const config: PrepareReleaseConfig = {
      ...releaseConfig,
      plugins: [
        ['@semantic-release/commit-analyzer', {
          preset: 'conventionalcommits',
          releaseRules: [{ type: 'docs', release: 'patch' }],
        }],
        releaseConfig.plugins[1],
      ],
    };
    await expect(analyzeReleaseBump([commit('a', 'docs: publish docs')], config, repositoryRoot)).resolves.toBe('patch');
  });

  it('passes changed writer options to the actual notes plugin', async () => {
    const config: PrepareReleaseConfig = {
      ...releaseConfig,
      plugins: [
        releaseConfig.plugins[0],
        ['@semantic-release/release-notes-generator', {
          preset: 'conventionalcommits',
          presetConfig: { types: [{ type: 'fix', section: 'Repairs' }] },
        }],
      ],
    };
    const generated = await generateReleaseNotes(
      [commit('a', 'fix: repair a race')],
      config,
      '0.4.2',
      '0.4.3',
      'patch',
      'v0.4.2',
      '2026-09-11',
      'https://github.com/acme/nestro',
      repositoryRoot,
    );
    expect(releaseNotesBody(generated)).toContain('### Repairs');
  });

  it.each([
    ['major', '1.2.3', '2.0.0'],
    ['minor', '1.2.3', '1.3.0'],
    ['patch', '1.2.3', '1.2.4'],
  ] as const)('computes a %s next version', (bump, previous, expected) => {
    expect(computeNextVersion(previous, bump)).toBe(expected);
  });

  it('rejects a non-plain previous version', () => {
    expect(() => computeNextVersion('1.2.3-beta.1', 'patch')).toThrow('plain major.minor.patch');
  });

  it('renders a changelog entry with a compare link and release date', () => {
    expect(renderChangelogEntry(
      '0.4.3',
      '0.4.2',
      '### Bug Fixes\n\n* close a race',
      '2026-09-11',
      'https://github.com/GreenTech-Solutions/nestro',
    )).toBe(
      '## [0.4.3](https://github.com/GreenTech-Solutions/nestro/compare/v0.4.2...v0.4.3) (2026-09-11)\n\n\n'
      + '### Bug Fixes\n\n* close a race\n\n',
    );
  });
});