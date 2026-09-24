import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLEAN_EXTENSION_IDENTITY } from './fixtures';
import { VSIX_STATIC_ALLOWLIST } from '../tools/vsixPolicy';

interface ExtensionManifest {
  readonly name: string;
  readonly publisher: string;
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly repository: { readonly type: string; readonly url: string };
  readonly categories: readonly string[];
  readonly license: string;
  readonly keywords: readonly string[];
}

/**
 * Marketplace category values from the VS Code extension manifest reference; vsce does
 * not validate categories itself, so this list is the policy's only source of truth.
 */
const MARKETPLACE_CATEGORIES: readonly string[] = [
  'Programming Languages', 'Snippets', 'Linters', 'Themes', 'Debuggers', 'Formatters',
  'Keymaps', 'SCM Providers', 'Extension Packs', 'Language Packs', 'Data Science',
  'Machine Learning', 'Visualization', 'Notebooks', 'Education', 'Testing', 'Other',
];

/** The Marketplace publish-time cap on package.json keywords/tags. */
const MARKETPLACE_KEYWORD_LIMIT = 30;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as ExtensionManifest;
const licenseFirstLine = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8').split('\n')[0];

/** Extracts the `owner/repo` segment from a GitHub URL, https or git-protocol form. */
function githubOwnerRepo(url: string): string {
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  if (!match) {
    throw new Error(`not a GitHub repository URL: ${url}`);
  }
  return match[1];
}

describe('extension marketplace metadata', () => {
  it('points homepage, bugs, and repository at the same GitHub repository', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/GreenTech-Solutions/nestro.git',
    });
    expect(manifest.homepage).toBe('https://github.com/GreenTech-Solutions/nestro');
    expect(manifest.bugs).toEqual({ url: 'https://github.com/GreenTech-Solutions/nestro/issues' });

    const owner = githubOwnerRepo(manifest.repository.url);
    expect(owner).toBe('GreenTech-Solutions/nestro');
    expect(githubOwnerRepo(manifest.homepage)).toBe(owner);
    expect(githubOwnerRepo(manifest.bugs.url)).toBe(owner);
    expect(manifest.bugs.url.endsWith('/issues')).toBe(true);
    expect(manifest.repository.url.endsWith('.git')).toBe(true);
  });

  it('declares only the Other category, with no speculative language-feature claim', () => {
    expect(manifest.categories).toEqual(['Other']);
    for (const category of manifest.categories) {
      expect(MARKETPLACE_CATEGORIES).toContain(category);
    }
  });

  it('keeps the SPDX MIT identifier backed by a packaged root LICENSE file', () => {
    expect(manifest.license).toBe('MIT');
    expect(licenseFirstLine).toBe('MIT License');
    expect(VSIX_STATIC_ALLOWLIST).toContainEqual({ packagePath: 'LICENSE.txt', sourcePath: 'LICENSE' });
  });

  it('matches the Marketplace publisher and extension identity used elsewhere', () => {
    expect(manifest.publisher).toBe(CLEAN_EXTENSION_IDENTITY.publisher);
    expect(manifest.name).toBe(CLEAN_EXTENSION_IDENTITY.name);
  });

  it('keeps keywords non-empty, unique, lowercase, and within the Marketplace limit', () => {
    expect(manifest.keywords.length).toBeGreaterThan(0);
    expect(manifest.keywords.length).toBeLessThanOrEqual(MARKETPLACE_KEYWORD_LIMIT);
    expect(new Set(manifest.keywords).size).toBe(manifest.keywords.length);
    for (const keyword of manifest.keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
    }
  });
});