import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const changelogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
const changelogContent = readFileSync(changelogPath, 'utf8');
const changelogLines = changelogContent.split('\n');

// A top-level (# or ##) heading line, excluding deeper subsections such as "### Bug Fixes".
const HEADING_LINE = /^#{1,2}(?!#)\s.*$/;

// The exact heading format produced by @semantic-release/changelog: a version, a compare link, and a release date.
const GENERATED_HEADING = /^#{1,2} \[(\d+\.\d+\.\d+)\]\(https:\/\/github\.com\/GreenTech-Solutions\/nestro\/compare\/v\d+\.\d+\.\d+\.\.\.v\d+\.\d+\.\d+\) \(\d{4}-\d{2}-\d{2}\)$/;

// Keep a Changelog's dated heading format (`## [x.y.z] - YYYY-MM-DD`), which must not reappear.
const KEEP_A_CHANGELOG_HEADING = /^#{1,2} \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/;

function getHeadingLines(): string[] {
  return changelogLines.filter(line => HEADING_LINE.test(line));
}

function getHeadingVersions(): string[] {
  return getHeadingLines().map((line) => {
    const match = GENERATED_HEADING.exec(line);
    if (!match) {
      throw new Error(`Heading does not match the generated release format: ${line}`);
    }
    return match[1];
  });
}

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) {
      return partsA[i] - partsB[i];
    }
  }
  return 0;
}

describe('CHANGELOG.md structure', () => {
  it('has at least one release heading', () => {
    expect(getHeadingLines().length).toBeGreaterThan(0);
  });

  it('formats every level 1/2 heading as a generated release entry', () => {
    for (const line of getHeadingLines()) {
      expect(line).toMatch(GENERATED_HEADING);
    }
  });

  it('does not contain a manual [Unreleased] section', () => {
    expect(changelogContent).not.toContain('[Unreleased]');
  });

  it('does not contain an orphaned "# Change Log" heading', () => {
    expect(changelogContent).not.toMatch(/^# Change Log$/m);
  });

  it('does not contain any Keep a Changelog dated heading', () => {
    expect(changelogLines.some(line => KEEP_A_CHANGELOG_HEADING.test(line))).toBe(false);
  });

  it('has unique version numbers across all release headings', () => {
    const versions = getHeadingVersions();
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('lists release headings in strictly descending semver order', () => {
    const versions = getHeadingVersions();
    for (let i = 1; i < versions.length; i++) {
      expect(compareSemver(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });
});