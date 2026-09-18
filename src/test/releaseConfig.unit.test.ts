import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CODESTYLE.md is the single source of truth for commit types (CODESTYLE.md:172);
// this suite asserts .releaserc.json stays aligned with it rather than drifting silently.

type ReleaseBump = 'minor' | 'patch' | false;

interface CanonicalType {
  type: string;
  bump: ReleaseBump;
  section: string | null;
}

interface ReleaseRule {
  type?: string;
  breaking?: boolean;
  release?: ReleaseBump | 'major';
}

interface PresetTypeEntry {
  type: string;
  section?: string;
  hidden?: boolean;
}

interface AnalyzerConfig {
  preset?: string;
  releaseRules?: ReleaseRule[];
}

interface NotesConfig {
  preset?: string;
  presetConfig?: {
    types?: PresetTypeEntry[];
  };
}

type PluginEntry = [string, Record<string, unknown>?];

interface ReleaseConfig {
  plugins: PluginEntry[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const codestyleContent = readFileSync(path.join(repoRoot, 'CODESTYLE.md'), 'utf8');
const releaserc = JSON.parse(readFileSync(path.join(repoRoot, '.releaserc.json'), 'utf8')) as ReleaseConfig;

// The commit type in the first cell of a canonical table row, e.g. "`feat`".
const TABLE_TYPE_CELL = /^`([a-z]+)`$/;

// A data row of the canonical commit-type table in CODESTYLE.md, e.g.:
// | `feat` | New user-facing feature | minor | Features |
function parseTableRow(line: string): CanonicalType | null {
  if (!line.startsWith('|') || !line.endsWith('|')) {
    return null;
  }
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
  if (cells.length !== 4) {
    return null;
  }
  const typeMatch = TABLE_TYPE_CELL.exec(cells[0]);
  if (!typeMatch) {
    return null;
  }
  const [, type] = typeMatch;
  const bump: ReleaseBump = cells[2] === '—' ? false : (cells[2] as 'minor' | 'patch');
  const section = cells[3] === '—' ? null : cells[3];
  return { type, bump, section };
}

function parseCanonicalTypes(content: string): CanonicalType[] {
  const headingIndex = content.indexOf('## Commit Message Format');
  if (headingIndex === -1) {
    throw new Error('CODESTYLE.md is missing the "## Commit Message Format" section');
  }

  const types: CanonicalType[] = [];
  for (const line of content.slice(headingIndex).split('\n')) {
    const row = parseTableRow(line);
    if (!row) {
      if (types.length > 0) {
        break;
      }
      continue;
    }
    types.push(row);
  }

  if (types.length === 0) {
    throw new Error('Failed to parse any commit types from the CODESTYLE.md commit type table');
  }
  return types;
}

const canonicalTypes = parseCanonicalTypes(codestyleContent);

function findPluginConfig<T>(name: string): T {
  const entry = releaserc.plugins.find(plugin => plugin[0] === name);
  if (!entry) {
    throw new Error(`.releaserc.json is missing the "${name}" plugin`);
  }
  return (entry[1] ?? {}) as T;
}

const analyzerConfig = findPluginConfig<AnalyzerConfig>('@semantic-release/commit-analyzer');
const notesConfig = findPluginConfig<NotesConfig>('@semantic-release/release-notes-generator');

const analyzerRulesByType = new Map(
  (analyzerConfig.releaseRules ?? [])
    .filter((rule): rule is ReleaseRule & { type: string } => typeof rule.type === 'string')
    .map(rule => [rule.type, rule]),
);

const notesTypesByType = new Map(
  (notesConfig.presetConfig?.types ?? []).map(entry => [entry.type, entry]),
);

function setDifference(from: Iterable<string>, subtract: Set<string>): string[] {
  return [...from].filter(value => !subtract.has(value));
}

describe('semantic-release type contract (.releaserc.json vs CODESTYLE.md)', () => {
  it('parses at least one canonical commit type from CODESTYLE.md', () => {
    expect(canonicalTypes.length).toBeGreaterThan(0);
  });

  it('uses the same preset in commit-analyzer and release-notes-generator', () => {
    expect(
      notesConfig.preset,
      `preset mismatch: commit-analyzer preset is "${String(analyzerConfig.preset)}", `
      + `release-notes-generator preset is "${String(notesConfig.preset)}" — both plugins must share one preset`,
    ).toBe(analyzerConfig.preset);
  });

  it('declares exactly the canonical type set in commit-analyzer releaseRules', () => {
    const canonicalSet = new Set(canonicalTypes.map(({ type }) => type));
    const analyzerSet = new Set(analyzerRulesByType.keys());
    const missing = setDifference(canonicalSet, analyzerSet);
    const extra = setDifference(analyzerSet, canonicalSet);

    expect(missing, `commit-analyzer releaseRules is missing types from CODESTYLE.md: ${missing.join(', ') || 'none'}`).toEqual([]);
    expect(extra, `commit-analyzer releaseRules declares types not in CODESTYLE.md: ${extra.join(', ') || 'none'}`).toEqual([]);
  });

  it('declares exactly the canonical type set in release-notes-generator presetConfig.types', () => {
    const canonicalSet = new Set(canonicalTypes.map(({ type }) => type));
    const notesSet = new Set(notesTypesByType.keys());
    const missing = setDifference(canonicalSet, notesSet);
    const extra = setDifference(notesSet, canonicalSet);

    expect(missing, `presetConfig.types is missing types from CODESTYLE.md: ${missing.join(', ') || 'none'}`).toEqual([]);
    expect(extra, `presetConfig.types declares types not in CODESTYLE.md: ${extra.join(', ') || 'none'}`).toEqual([]);
  });

  it.each(canonicalTypes.map(({ type, bump }): [string, ReleaseBump] => [type, bump]))(
    'commit-analyzer bump for `%s` matches CODESTYLE.md',
    (type, expectedBump) => {
      const rule = analyzerRulesByType.get(type);
      expect(rule, `commit-analyzer releaseRules has no entry for type "${type}"`).toBeDefined();
      expect(
        rule?.release,
        `type "${type}": CODESTYLE.md expects bump "${String(expectedBump)}", `
        + `.releaserc.json commit-analyzer has "${String(rule?.release)}"`,
      ).toBe(expectedBump);
    },
  );

  it.each(canonicalTypes.map(({ type, section }): [string, string | null] => [type, section]))(
    'release-notes-generator section/hidden for `%s` matches CODESTYLE.md',
    (type, expectedSection) => {
      const entry = notesTypesByType.get(type);
      expect(entry, `presetConfig.types has no entry for type "${type}"`).toBeDefined();

      if (expectedSection === null) {
        expect(
          entry?.hidden,
          `type "${type}" has no release notes section in CODESTYLE.md and must be "hidden: true" in presetConfig.types`,
        ).toBe(true);
        expect(
          entry?.section,
          `type "${type}" has no release notes section in CODESTYLE.md and must not declare "section" in presetConfig.types`,
        ).toBeUndefined();
      }
      else {
        expect(
          entry?.section,
          `type "${type}": CODESTYLE.md expects section "${expectedSection}", `
          + `.releaserc.json presetConfig.types has "${String(entry?.section)}"`,
        ).toBe(expectedSection);
        expect(
          entry?.hidden,
          `type "${type}" is release-producing in CODESTYLE.md and must not be "hidden: true" in presetConfig.types`,
        ).not.toBe(true);
      }
    },
  );
});