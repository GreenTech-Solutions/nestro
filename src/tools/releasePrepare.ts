import {
  analyzeReleaseBump,
  computeNextVersion,
  generateReleaseNotes,
  releaseNotesBody,
  renderChangelogEntry,
} from './releaseAnalyzer';
import type { PrepareReleaseConfig, RawCommit } from './releaseAnalyzer';

export interface ReleasePrepareIo {
  readonly cwd?: string;
  readonly latestReleaseTag: () => Promise<string | undefined>;
  readonly listCommitsSince: (tag: string | undefined) => Promise<readonly RawCommit[]>;
  readonly readPackageVersion: () => Promise<string>;
  readonly writePackageVersion: (version: string) => Promise<void>;
  readonly prependChangelog: (entry: string) => Promise<void>;
  readonly writeNotes: (notes: string) => Promise<void>;
  readonly writeOutput: (key: string, value: string) => Promise<void>;
}

export interface ReleasePrepareOutcome {
  readonly releaseNeeded: boolean;
  readonly version: string | undefined;
  readonly previousVersion: string | undefined;
}

const TAG_VERSION_PATTERN = /^v(\d+\.\d+\.\d+)$/u;

export function parseTagVersion(tag: string): string {
  const match = TAG_VERSION_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(`release tag must match v<major>.<minor>.<patch>, got "${tag}"`);
  }
  return match[1];
}

export async function runReleasePrepare(
  io: ReleasePrepareIo,
  repositoryUrl: string,
  isoDate: string,
  releaseConfig: PrepareReleaseConfig,
): Promise<ReleasePrepareOutcome> {
  const latestTag = await io.latestReleaseTag();
  const commits = await io.listCommitsSince(latestTag);
  const bump = await analyzeReleaseBump(commits, releaseConfig, io.cwd ?? process.cwd());
  if (bump === undefined) {
    await io.writeOutput('release-needed', 'false');
    return { releaseNeeded: false, version: undefined, previousVersion: undefined };
  }
  const packageVersion = await io.readPackageVersion();
  const previousVersion = latestTag === undefined ? packageVersion : parseTagVersion(latestTag);
  if (latestTag !== undefined && packageVersion !== previousVersion) {
    const expectedVersion = computeNextVersion(previousVersion, bump);
    if (packageVersion === expectedVersion) {
      await io.writeOutput('release-needed', 'false');
      return { releaseNeeded: false, version: undefined, previousVersion: undefined };
    }
    throw new Error(
      `package.json version ${packageVersion} does not match the latest release tag ${latestTag}`,
    );
  }
  const version = computeNextVersion(previousVersion, bump);
  const generatedNotes = await generateReleaseNotes(
    commits,
    releaseConfig,
    previousVersion,
    version,
    bump,
    latestTag ?? `v${previousVersion}`,
    isoDate,
    repositoryUrl,
    io.cwd ?? process.cwd(),
  );
  const notes = releaseNotesBody(generatedNotes);
  await io.writePackageVersion(version);
  await io.prependChangelog(renderChangelogEntry(version, previousVersion, notes, isoDate, repositoryUrl));
  await io.writeNotes(notes);
  await io.writeOutput('release-needed', 'true');
  await io.writeOutput('version', version);
  return { releaseNeeded: true, version, previousVersion };
}