import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCiEvidence, mainCiEvidence, parseCiEvidenceArgs, writeCiEvidence } from '../tools';

const SOURCE_SHA = 'a'.repeat(40);
const PR_HEAD_SHA = 'b'.repeat(40);
const VSIX_FILE = 'nestro-0.4.2.vsix';
const roots: string[] = [];

async function createArtifactDir(): Promise<{ dir: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'nestro-ci-evidence-'));
  roots.push(dir);
  const bytes = Buffer.from('verified-vsix-bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(dir, VSIX_FILE), bytes);
  await writeFile(join(dir, `${VSIX_FILE}.sha256`), `${digest}  ${VSIX_FILE}\n`, 'utf8');
  await writeFile(join(dir, `${VSIX_FILE}.manifest.txt`), `${digest}  extension/package.json\n`, 'utf8');
  return { dir, digest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CI evidence identity', () => {
  it('binds exact PR merge/head identity and verified bytes while forbidding release eligibility', async () => {
    const { dir, digest } = await createArtifactDir();

    await expect(createCiEvidence(dir, {
      sourceSha: SOURCE_SHA,
      runId: '42',
      runAttempt: '3',
      eventName: 'pull_request',
      pullRequestHeadSha: PR_HEAD_SHA,
    })).resolves.toEqual({
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      runId: '42',
      runAttempt: '3',
      eventName: 'pull_request',
      pullRequestHeadSha: PR_HEAD_SHA,
      vsixFile: VSIX_FILE,
      vsixSha256: digest,
      releaseEligible: false,
    });
  });

  it('records push evidence without pretending it is a release candidate', async () => {
    const { dir } = await createArtifactDir();

    const evidence = await createCiEvidence(dir, {
      sourceSha: SOURCE_SHA,
      runId: '1',
      runAttempt: '1',
      eventName: 'push',
      pullRequestHeadSha: undefined,
    });

    expect(evidence).toMatchObject({ pullRequestHeadSha: null, releaseEligible: false });
  });

  it('records manually dispatched PR evidence with the exact requested head', async () => {
    const { dir } = await createArtifactDir();

    const evidence = await createCiEvidence(dir, {
      sourceSha: SOURCE_SHA,
      runId: '2',
      runAttempt: '1',
      eventName: 'workflow_dispatch',
      pullRequestHeadSha: PR_HEAD_SHA,
    });

    expect(evidence).toMatchObject({
      eventName: 'workflow_dispatch',
      pullRequestHeadSha: PR_HEAD_SHA,
      releaseEligible: false,
    });
  });

  it.each([
    ['wrong VSIX digest', (dir: string) => writeFile(join(dir, VSIX_FILE), 'substituted')],
    ['wrong sidecar file name', (dir: string) => writeFile(join(dir, `${VSIX_FILE}.sha256`), `${'a'.repeat(64)}  forged.vsix\n`)],
    ['ambiguous second VSIX', (dir: string) => writeFile(join(dir, 'second.vsix'), 'bytes')],
    ['missing normalized manifest', (dir: string) => rm(join(dir, `${VSIX_FILE}.manifest.txt`))],
  ])('fails closed for %s', async (_label, inject) => {
    const { dir } = await createArtifactDir();
    await inject(dir);

    await expect(createCiEvidence(dir, {
      sourceSha: SOURCE_SHA,
      runId: '1',
      runAttempt: '1',
      eventName: 'push',
      pullRequestHeadSha: undefined,
    })).rejects.toThrow();
  });

  it.each([
    ['short source SHA', { sourceSha: 'abc' }],
    ['zero run ID', { runId: '0' }],
    ['non-numeric attempt', { runAttempt: 'first' }],
    ['unsupported event', { eventName: 'workflow_run' }],
    ['missing PR head identity', { eventName: 'pull_request', pullRequestHeadSha: undefined }],
  ])('rejects %s', async (_label, override) => {
    const { dir } = await createArtifactDir();
    const environment = {
      sourceSha: SOURCE_SHA,
      runId: '1',
      runAttempt: '1',
      eventName: 'push',
      pullRequestHeadSha: undefined,
      ...override,
    };

    await expect(createCiEvidence(dir, environment)).rejects.toThrow();
  });

  it('writes one stable JSON identity into the verified artifact directory', async () => {
    const { dir } = await createArtifactDir();
    const parent = join(dir, '..');
    const leaf = dir.slice(parent.length + 1);

    const evidence = await writeCiEvidence(parent, leaf, {
      sourceSha: SOURCE_SHA,
      runId: '8',
      runAttempt: '1',
      eventName: 'push',
      pullRequestHeadSha: undefined,
    });

    expect(JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'))).toEqual(evidence);
  });

  it('accepts only the explicit safe output-directory CLI form', () => {
    expect(parseCiEvidenceArgs(['--out-dir', 'dist/ci'])).toBe('dist/ci');
    expect(() => parseCiEvidenceArgs([])).toThrow('usage');
    expect(() => parseCiEvidenceArgs(['--out-dir', '../outside'])).toThrow('safe relative');
  });

  it('runs the evidence CLI and reports the exact evidence-only identity', async () => {
    const { dir } = await createArtifactDir();
    const parent = join(dir, '..');
    const leaf = dir.slice(parent.length + 1);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(mainCiEvidence(['--out-dir', leaf], parent, {
        CI_SOURCE_SHA: SOURCE_SHA,
        CI_RUN_ID: '12',
        CI_RUN_ATTEMPT: '1',
        CI_EVENT_NAME: 'push',
      })).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(`Evidence recorded for ${SOURCE_SHA}: releaseEligible=false\n`);
    }
    finally {
      output.mockRestore();
    }
  });

  it.each([
    ['an Error', ['--out-dir', '../outside']],
    ['a missing argument', []],
  ])('makes CLI failure explicit for %s', async (_label, argv) => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainCiEvidence(argv, '/repo', {})).resolves.toBe(1);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('CI evidence failed:'));
    }
    finally {
      output.mockRestore();
    }
  });
});