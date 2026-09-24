import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parsePrepareReleaseConfig } from './releaseAnalyzer';
import type { RawCommit } from './releaseAnalyzer';
import { runReleasePrepare } from './releasePrepare';
import type { ReleasePrepareIo } from './releasePrepare';
import { normalizeArtifactOutDir } from './verifyVsix';

const execFileAsync = promisify(execFile);
const RECORD_SEPARATOR = '';
const FIELD_SEPARATOR = '';
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function parsePackageJson(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  }
  catch (error) {
    throw new Error(
      'package.json is not valid JSON: '
      + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('package.json must contain an object');
  }
  return value as Record<string, unknown>;
}

function readPlainPackageVersion(source: string): string {
  const value = parsePackageJson(source).version;
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error('package.json must declare a plain major.minor.patch version');
  }
  return value;
}

export function parseReleasePrepareArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--out-dir') {
    throw new Error('usage: release:prepare --out-dir <relative-directory>');
  }
  return normalizeArtifactOutDir(argv[1]);
}

export function parseCommitLog(stdout: string): RawCommit[] {
  return stdout
    .split(RECORD_SEPARATOR)
    .map(record => record.trim())
    .filter(record => record.length > 0)
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split(FIELD_SEPARATOR);
      return { hash, subject, body };
    });
}

export interface NodeReleasePrepareDependencies {
  readonly io: ReleasePrepareIo;
  readonly repositoryUrl: string;
  readonly isoDate: string;
}

export function createNodeReleasePrepareDependencies(
  cwd: string,
  outDir: string,
  repositoryUrl: string,
  isoDate: string,
  githubOutputPath: string | undefined,
): NodeReleasePrepareDependencies {
  const packageJsonPath = resolve(cwd, 'package.json');
  const changelogPath = resolve(cwd, 'CHANGELOG.md');
  const notesPath = resolve(cwd, outDir, 'notes.md');
  const io: ReleasePrepareIo = {
    cwd,
    async latestReleaseTag() {
      const { stdout } = await execFileAsync('git', ['tag', '-l', 'v*'], { cwd });
      const tags = stdout.split('\n').map(line => line.trim()).filter(line => /^v\d+\.\d+\.\d+$/u.test(line));
      if (tags.length === 0) {
        return undefined;
      }
      tags.sort((left, right) => compareVersions(left, right) * -1);
      return tags[0];
    },
    async listCommitsSince(tag) {
      const range = tag === undefined ? 'HEAD' : `${tag}..HEAD`;
      const { stdout } = await execFileAsync(
        'git',
        ['log', range, `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`],
        { cwd, maxBuffer: 1024 * 1024 * 16 },
      );
      return parseCommitLog(stdout);
    },
    async readPackageVersion() {
      const source = await readFile(packageJsonPath, 'utf8');
      return readPlainPackageVersion(source);
    },
    async writePackageVersion(version) {
      const source = await readFile(packageJsonPath, 'utf8');
      if (!VERSION_PATTERN.test(version)) {
        throw new Error('package.json version update must be a plain major.minor.patch version');
      }
      const packageJson = parsePackageJson(source);
      packageJson.version = version;
      await writeFile(packageJsonPath, JSON.stringify(packageJson, undefined, 2) + '\n', 'utf8');
    },
    async prependChangelog(entry) {
      const existing = await readFile(changelogPath, 'utf8').catch(() => '');
      await writeFile(changelogPath, `${entry}${existing}`, 'utf8');
    },
    async writeNotes(notes) {
      await mkdir(resolve(cwd, outDir), { recursive: true });
      await writeFile(notesPath, `${notes}\n`, 'utf8');
    },
    async writeOutput(key, value) {
      if (githubOutputPath === undefined) {
        return;
      }
      await appendFile(githubOutputPath, `${key}=${value}\n`, 'utf8');
    },
  };
  return { io, repositoryUrl, isoDate };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => value.slice(1).split('.').map(Number);
  const [leftMajor, leftMinor, leftPatch] = parse(left);
  const [rightMajor, rightMinor, rightPatch] = parse(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

export async function mainReleasePrepare(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const outDir = parseReleasePrepareArgs(argv);
    const releaseConfigPath = env.RELEASE_CONFIG ?? '.releaserc.json';
    const releaseConfig = JSON.parse(await readFile(resolve(cwd, releaseConfigPath), 'utf8')) as unknown;
    const parsedReleaseConfig = parsePrepareReleaseConfig(releaseConfig);
    const repositoryUrl = env.RELEASE_REPOSITORY_URL;
    if (repositoryUrl === undefined || repositoryUrl.length === 0) {
      throw new Error('RELEASE_REPOSITORY_URL must be set');
    }
    await mkdir(resolve(cwd, outDir), { recursive: true });
    const isoDate = new Date().toISOString().slice(0, 10);
    const dependencies = createNodeReleasePrepareDependencies(cwd, outDir, repositoryUrl, isoDate, env.GITHUB_OUTPUT);
    const outcome = await runReleasePrepare(
      dependencies.io,
      dependencies.repositoryUrl,
      dependencies.isoDate,
      parsedReleaseConfig,
    );
    if (outcome.releaseNeeded) {
      process.stdout.write(`Prepared release v${outcome.version}\n`);
    }
    else {
      process.stdout.write('No release necessary\n');
    }
    return 0;
  }
  catch (error) {
    process.stderr.write(`Release preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainReleasePrepare(process.argv.slice(2), process.cwd(), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */