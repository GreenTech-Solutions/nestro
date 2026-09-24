import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** These files define the comment rule and quote identifiers as examples of what it forbids. */
const RULE_DEFINITION_FILES = new Set(['CODESTYLE.md', 'AGENTS.md', 'CLAUDE.md']);

/** Build output, caches and the gitignored local bookkeeping directory never ship. */
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.pnpm-store', '.vscode-test', 'coverage', 'dist', 'node_modules', 'out', 'workflow',
]);

const TRACKER_ID = /\b(?:AUD|ARC|SEC|SUP|UX|DOC|CI)-\d/;

function shippedFiles(directory = repoRoot, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name)
        ? []
        : shippedFiles(path.join(directory, entry.name), relativePath);
    }
    return RULE_DEFINITION_FILES.has(relativePath) ? [] : [relativePath];
  });
}

function offendingLines(files: readonly string[], matches: (line: string) => boolean): string[] {
  return files.flatMap((file) => {
    let contents: string;
    try {
      contents = readFileSync(path.join(repoRoot, file), 'utf8');
    }
    catch {
      return [];
    }
    return contents
      .split('\n')
      .map((line, index) => ({ line, location: `${file}:${index + 1}` }))
      .filter(entry => matches(entry.line))
      .map(entry => entry.location);
  });
}

describe('shipped file hygiene', () => {
  it('keeps tracker identifiers out of everything that ships', () => {
    expect(offendingLines(shippedFiles(), line => TRACKER_ID.test(line))).toEqual([]);
  });

  /** Documentation only: a badge URL contains the word, and packaging tests name the excluded path. */
  it('keeps the local bookkeeping directory out of shipped documentation', () => {
    const files = [...shippedFiles(), 'CODESTYLE.md'].filter(file => file.endsWith('.md'));
    expect(offendingLines(files, line => line.includes('workflow/') && !line.includes('://')))
      .toEqual([]);
  });
});