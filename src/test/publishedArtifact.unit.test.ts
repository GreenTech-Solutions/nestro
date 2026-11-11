import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveEntry, buildZipFixture, CLEAN_TRACKED_SOURCE_PATHS, cleanVsixFixtureEntries, SYMLINK_FILE_MODE } from './fixtures';
import type { ZipFixtureEntry } from './fixtures/vsixFixtures';
import { COMPRESSED_SIZE_BUDGET_BYTES, evaluateVsixPolicy, PACKAGED_FILE_COUNT_BUDGET, registryDownloadUrl } from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const scriptDirectory = resolve(repositoryRoot, '.github/scripts/release');
const compareScript = join(scriptDirectory, 'compare-published.py');
const firstExisting = (...candidates: string[]): string | undefined => candidates.find(candidate => existsSync(candidate));
const python3 = firstExisting('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3') ?? 'python3';
const bash = firstExisting('/bin/bash', '/usr/bin/bash') ?? 'bash';
const hasPython = existsSync(python3);
const hasShellTools = hasPython && existsSync(bash)
  && firstExisting('/usr/bin/jq', '/usr/local/bin/jq', '/opt/homebrew/bin/jq') !== undefined
  && firstExisting('/usr/bin/unzip', '/usr/local/bin/unzip', '/opt/homebrew/bin/unzip') !== undefined;

interface Archive {
  readonly bytes: Uint8Array;
  readonly entries: readonly ZipFixtureEntry[];
}

interface Outcome {
  readonly rejected: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function toArchive(entries: readonly ZipFixtureEntry[]): Archive {
  return { bytes: buildZipFixture(entries), entries };
}

function withEntry(entries: readonly ZipFixtureEntry[], path: string, change: (entry: ZipFixtureEntry) => ZipFixtureEntry): ZipFixtureEntry[] {
  return entries.map(entry => (entry.path === path ? change(entry) : entry));
}

function inTempDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'nestro-compare-published-'));
  try {
    return run(directory);
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function compare(candidate: Archive, published: readonly Archive[], script: string = compareScript): Outcome {
  return inTempDirectory((directory) => {
    const paths = [candidate, ...published].map((archive, index) => {
      const path = join(directory, `archive-${index}.vsix`);
      writeFileSync(path, archive.bytes);
      return path;
    });
    const result = spawnSync(python3, ['-I', script, 'compare', ...paths], { encoding: 'utf8', input: '' });
    return { rejected: result.status !== 0, stdout: result.stdout, stderr: result.stderr };
  });
}

function policyRejects(archive: Archive, kind: 'file-count-budget' | 'size-budget'): boolean {
  return evaluateVsixPolicy({
    entries: archive.entries.map(entry => archiveEntry(entry.path, entry.content)),
    compressedBytes: archive.bytes.length,
    trackedSourcePaths: CLEAN_TRACKED_SOURCE_PATHS,
    symlinkSourcePaths: [],
    modifiedTrackedPaths: [],
    untrackedWorktreePaths: [],
    requireCleanWorktree: false,
  }).violations.some(violation => violation.kind === kind);
}

function archiveWithExtensionFiles(count: number): Archive {
  const base = cleanVsixFixtureEntries();
  const baseCount = base.filter(entry => entry.path.startsWith('extension/')).length;
  const extras = Array.from(
    { length: count - baseCount },
    (_unused, index): ZipFixtureEntry => ({ path: `extension/images/shot-${index}.png`, content: 'png' }),
  );
  return toArchive([...base, ...extras]);
}

function archiveWithSize(bytes: number): Archive {
  const padded = (length: number): Archive => toArchive([
    ...cleanVsixFixtureEntries(),
    { path: 'extension/images/padding.bin', content: new Uint8Array(length).fill(0x41), method: 'stored' },
  ]);
  return padded(bytes - padded(1).bytes.length + 1);
}

describe.skipIf(!hasPython)('post-publish comparison script', () => {
  const entries = cleanVsixFixtureEntries();
  const candidate = toArchive(entries);

  it('accepts exact bytes and an explicit re-pack with identical paths and contents', () => {
    const repacked = toArchive(entries.map(entry => ({ ...entry, method: 'stored' as const })));
    const outcome = compare(candidate, [candidate, repacked]);

    expect(outcome.rejected).toBe(false);
    expect(outcome.stdout).toContain('exact candidate bytes');
    expect(outcome.stdout).toContain('accepted explicit registry re-pack');
  });

  it.each([
    ['an extra file', toArchive([...entries, { path: 'extension/extra.txt', content: 'extra' }])],
    ['a missing file', toArchive(entries.filter(entry => entry.path !== 'extension/readme.md'))],
    ['changed content', toArchive(withEntry(entries, 'extension/readme.md', entry => ({ ...entry, content: '# forged\n' })))],
    ['another version in both manifests', toArchive(entries.map(entry => (entry.path === 'extension/package.json' || entry.path === 'extension.vsixmanifest'
      ? { ...entry, content: String(entry.content).replaceAll('9.9.9', '9.9.8') }
      : entry)))],
  ])('rejects a registry copy with %s', (_label, published) => {
    const outcome = compare(candidate, [published]);

    expect(outcome.rejected).toBe(true);
    expect(outcome.stderr).toContain('does not match candidate identity and normalized manifest');
  });

  it('rejects a copy whose package and outer manifest identities differ', () => {
    const forged = toArchive(withEntry(entries, 'extension/package.json', entry => ({ ...entry, content: String(entry.content).replace('"name":"nestro"', '"name":"forged"') })));

    expect(compare(candidate, [forged]).stderr).toContain('package and outer identities differ');
  });

  it('rejects outer manifests that declare a DOCTYPE', () => {
    const doctype = toArchive(withEntry(entries, 'extension.vsixmanifest', entry => ({ ...entry, content: `<!DOCTYPE x>${String(entry.content)}` })));

    expect(compare(candidate, [doctype]).stderr).toContain('forbidden declarations');
  });

  it.each([
    ['a symlink', withEntry(entries, 'extension/readme.md', entry => ({ ...entry, unixMode: SYMLINK_FILE_MODE })), 'symlink'],
    ['a parent-directory path', [...entries, { path: 'extension/../escape.txt', content: 'x' }], 'unsafe published archive path'],
    ['an absolute path', [...entries, { path: '/escape.txt', content: 'x' }], 'unsafe published archive path'],
    ['a duplicate path', [...entries, { path: 'extension/readme.md', content: '# again\n' }], 'duplicate published archive path'],
  ])('rejects a registry copy with %s', (_label, unsafe, message) => {
    expect(compare(candidate, [toArchive(unsafe)]).stderr).toContain(message);
  });

  it.each([
    [PACKAGED_FILE_COUNT_BUDGET, false],
    [PACKAGED_FILE_COUNT_BUDGET + 1, true],
  ])('gives the VSIX policy verdict for %i extension files', (count, rejected) => {
    const archive = archiveWithExtensionFiles(count);
    const outcome = compare(archive, [archive]);

    expect(policyRejects(archive, 'file-count-budget')).toBe(rejected);
    expect(outcome.rejected).toBe(rejected);
    if (rejected) {
      expect(outcome.stderr).toContain('too many packaged files');
    }
  });

  it.each([
    [COMPRESSED_SIZE_BUDGET_BYTES, false],
    [COMPRESSED_SIZE_BUDGET_BYTES + 1, true],
  ])('gives the VSIX policy verdict for a %i byte package', (bytes, rejected) => {
    const archive = archiveWithSize(bytes);
    const outcome = compare(archive, [archive]);

    expect(archive.bytes).toHaveLength(bytes);
    expect(policyRejects(archive, 'size-budget')).toBe(rejected);
    expect(outcome.rejected).toBe(rejected);
    if (rejected) {
      expect(outcome.stderr).toContain('compressed');
    }
  });

  it('prints the compressed budget of the VSIX policy', () => {
    const result = spawnSync(python3, ['-I', compareScript, 'budget'], { encoding: 'utf8', input: '' });

    expect(result.stdout.trim()).toBe(String(COMPRESSED_SIZE_BUDGET_BYTES));
  });

  it('reads its budgets from the release contract next to it', () => {
    inTempDirectory((directory) => {
      const scripts = join(directory, '.github/scripts/release');
      mkdirSync(scripts, { recursive: true });
      cpSync(compareScript, join(scripts, 'compare-published.py'));
      const contract = JSON.parse(readFileSync(join(repositoryRoot, '.github/release-contract.json'), 'utf8')) as { vsixBudget: Record<string, number> };
      contract.vsixBudget.baselinePackagedFileCount = 1;
      contract.vsixBudget.packagedFileCountHeadroom = 0;
      writeFileSync(join(directory, '.github/release-contract.json'), JSON.stringify(contract));

      const outcome = compare(candidate, [candidate], join(scripts, 'compare-published.py'));

      expect(outcome.rejected).toBe(true);
      expect(outcome.stderr).toContain('too many packaged files');
    });
  });
});

describe.skipIf(!hasShellTools)('post-publish comparison download step', () => {
  const candidate = toArchive(cleanVsixFixtureEntries());
  const expectedUrls = (['marketplace', 'openVsx'] as const).map(registry => registryDownloadUrl(registry, { name: 'nestro', publisher: 'greentech-solutions', version: '9.9.9' }));

  function runStep(served: { readonly marketplace: Archive; readonly openVsx: Archive }, version = '9.9.9'): Outcome & { readonly curlLog: string } {
    return inTempDirectory((directory) => {
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      const fakeCurl = join(bin, 'curl');
      writeFileSync(fakeCurl, [
        '#!/usr/bin/env bash',
        'printf \'%s\\n\' "$@" >> "$FAKE_CURL_LOG"',
        'args=("$@")',
        'url="${args[$((${#args[@]} - 3))]}"',
        'if [[ "$url" == *marketplace* ]]; then cp "$FAKE_MARKETPLACE_VSIX" "${args[$((${#args[@]} - 1))]}"; else cp "$FAKE_OPENVSX_VSIX" "${args[$((${#args[@]} - 1))]}"; fi',
        '',
      ].join('\n'));
      chmodSync(fakeCurl, 0o755);
      const files = { candidate, marketplace: served.marketplace, openvsx: served.openVsx };
      const paths = Object.fromEntries(Object.entries(files).map(([name, archive]) => {
        const path = join(directory, `${name}.vsix`);
        writeFileSync(path, archive.bytes);
        return [name, path];
      }));
      const curlLog = join(directory, 'curl.log');
      const result = spawnSync(bash, [join(scriptDirectory, 'compare-published.sh')], {
        cwd: directory,
        encoding: 'utf8',
        input: '',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CANDIDATE_VSIX: paths.candidate,
          VERSION: version,
          FAKE_CURL_LOG: curlLog,
          FAKE_MARKETPLACE_VSIX: paths.marketplace,
          FAKE_OPENVSX_VSIX: paths.openvsx,
        },
      });
      return {
        rejected: result.status !== 0,
        stdout: result.stdout,
        stderr: result.stderr,
        curlLog: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '',
      };
    });
  }

  it('downloads both contract URLs decompressed, bounded and HTTPS-only, then accepts matching copies', () => {
    const outcome = runStep({ marketplace: candidate, openVsx: candidate });

    expect(outcome.rejected, outcome.stderr).toBe(false);
    const lines = outcome.curlLog.split('\n');
    expect(lines).toEqual(expect.arrayContaining(expectedUrls));
    expect(lines).toEqual(expect.arrayContaining(['--compressed', '--max-filesize', String(COMPRESSED_SIZE_BUDGET_BYTES), '--proto', '=https', '--proto-redir']));
    expect(outcome.stdout).toContain('exact candidate bytes');
  });

  it('fails the step when one registry serves different content', () => {
    const forged = toArchive(withEntry(cleanVsixFixtureEntries(), 'extension/readme.md', entry => ({ ...entry, content: '# forged\n' })));
    const outcome = runStep({ marketplace: candidate, openVsx: forged });

    expect(outcome.rejected).toBe(true);
    expect(outcome.stderr).toContain('does not match candidate identity and normalized manifest');
  });

  it('refuses a malformed version before any download', () => {
    const outcome = runStep({ marketplace: candidate, openVsx: candidate }, '9.9');

    expect(outcome.rejected).toBe(true);
    expect(outcome.curlLog).toBe('');
  });
});