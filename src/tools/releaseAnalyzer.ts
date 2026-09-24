export type ReleaseBump = 'major' | 'minor' | 'patch';

export interface RawCommit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

export type PrepareReleasePluginName = '@semantic-release/commit-analyzer'
  | '@semantic-release/release-notes-generator';

export interface PrepareReleaseConfig {
  readonly branches: readonly string[];
  readonly tagFormat: string;
  readonly plugins: readonly [
    readonly [
      '@semantic-release/commit-analyzer',
      Record<string, unknown>,
    ],
    readonly [
      '@semantic-release/release-notes-generator',
      Record<string, unknown>,
    ],
  ];
}

interface SemanticReleaseCommit {
  readonly hash: string;
  readonly message: string;
}

interface SemanticReleaseLogger {
  readonly log: (...args: readonly unknown[]) => void;
}

interface AnalyzeCommitsContext {
  readonly commits: SemanticReleaseCommit[];
  readonly cwd: string;
  readonly logger: SemanticReleaseLogger;
}

interface ReleaseNotesContext {
  readonly commits: SemanticReleaseCommit[];
  readonly cwd: string;
  readonly date: string;
  readonly lastRelease: {
    readonly version: string;
    readonly gitTag: string;
    readonly gitHead: string;
  };
  readonly nextRelease: {
    readonly type: ReleaseBump;
    readonly version: string;
    readonly gitTag: string;
    readonly gitHead: string;
  };
  readonly options: {
    readonly repositoryUrl: string;
  };
}

interface CommitAnalyzerModule {
  readonly analyzeCommits: (
    pluginConfig: Record<string, unknown>,
    context: AnalyzeCommitsContext,
  ) => Promise<string | null | undefined>;
}

interface ReleaseNotesGeneratorModule {
  readonly generateNotes: (
    pluginConfig: Record<string, unknown>,
    context: ReleaseNotesContext,
  ) => Promise<string | undefined>;
}

const PREPARE_PLUGIN_NAMES = [
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
] as const;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const RELEASE_BUMPS: readonly ReleaseBump[] = ['major', 'minor', 'patch'];

const NOOP_LOGGER: SemanticReleaseLogger = {
  log: () => undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findPrepareReleaseConfigViolations(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['release config must be an object'];
  }
  if (!Array.isArray(value.branches)
    || value.branches.length !== 1
    || value.branches[0] !== 'master') {
    return ['release config must target only master'];
  }
  if (value.tagFormat !== 'v${version}') {
    return ['release config must use the v${version} tag format'];
  }
  if (!Array.isArray(value.plugins) || value.plugins.length !== PREPARE_PLUGIN_NAMES.length) {
    return ['release config must contain only analyze and notes plugins'];
  }
  for (const [index, plugin] of value.plugins.entries()) {
    if (!Array.isArray(plugin)
      || plugin.length !== 2
      || plugin[0] !== PREPARE_PLUGIN_NAMES[index]
      || !isRecord(plugin[1])) {
      return ['release config must contain only analyze and notes plugins'];
    }
  }
  return [];
}

export function validatePrepareReleaseConfig(value: unknown): string[] {
  return findPrepareReleaseConfigViolations(value);
}

export function parsePrepareReleaseConfig(value: unknown): PrepareReleaseConfig {
  const violations = findPrepareReleaseConfigViolations(value);
  if (violations.length > 0) {
    throw new Error(violations.join('; '));
  }
  return value as PrepareReleaseConfig;
}

function getPluginOptions(config: PrepareReleaseConfig, index: 0 | 1): Record<string, unknown> {
  return config.plugins[index][1];
}

function toSemanticReleaseCommit(commit: RawCommit): SemanticReleaseCommit {
  const body = commit.body.trim();
  return {
    hash: commit.hash,
    message: body.length === 0 ? commit.subject : `${commit.subject}\n\n${body}`,
  };
}

async function loadCommitAnalyzer(): Promise<CommitAnalyzerModule> {
  // The plugin ships JavaScript only; its named runtime export is typed locally above.
  // @ts-expect-error @semantic-release/commit-analyzer has no bundled declaration file.
  const moduleValue: unknown = await import('@semantic-release/commit-analyzer');
  if (!isRecord(moduleValue) || typeof moduleValue.analyzeCommits !== 'function') {
    throw new Error('commit-analyzer plugin does not export analyzeCommits');
  }
  return {
    analyzeCommits: moduleValue.analyzeCommits as CommitAnalyzerModule['analyzeCommits'],
  };
}

async function loadReleaseNotesGenerator(): Promise<ReleaseNotesGeneratorModule> {
  // The plugin ships JavaScript only; its named runtime export is typed locally above.
  // @ts-expect-error @semantic-release/release-notes-generator has no bundled declaration file.
  const moduleValue: unknown = await import('@semantic-release/release-notes-generator');
  if (!isRecord(moduleValue) || typeof moduleValue.generateNotes !== 'function') {
    throw new Error('release-notes-generator plugin does not export generateNotes');
  }
  return {
    generateNotes: moduleValue.generateNotes as ReleaseNotesGeneratorModule['generateNotes'],
  };
}

export async function analyzeReleaseBump(
  commits: readonly RawCommit[],
  config: PrepareReleaseConfig,
  cwd: string = process.cwd(),
): Promise<ReleaseBump | undefined> {
  const plugin = await loadCommitAnalyzer();
  const releaseType = await plugin.analyzeCommits(
    getPluginOptions(config, 0),
    {
      commits: commits.map(toSemanticReleaseCommit),
      cwd,
      logger: NOOP_LOGGER,
    },
  );
  if (releaseType === null || releaseType === undefined) {
    return undefined;
  }
  if (!RELEASE_BUMPS.includes(releaseType as ReleaseBump)) {
    throw new Error(`commit-analyzer returned unsupported release type "${releaseType}"`);
  }
  return releaseType as ReleaseBump;
}

export async function generateReleaseNotes(
  commits: readonly RawCommit[],
  config: PrepareReleaseConfig,
  previousVersion: string,
  version: string,
  bump: ReleaseBump,
  previousTag: string,
  date: string,
  repositoryUrl: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const plugin = await loadReleaseNotesGenerator();
  const notes = await plugin.generateNotes(
    getPluginOptions(config, 1),
    {
      commits: commits.map(toSemanticReleaseCommit),
      cwd,
      date,
      lastRelease: {
        version: previousVersion,
        gitTag: previousTag,
        gitHead: '',
      },
      nextRelease: {
        type: bump,
        version,
        gitTag: `v${version}`,
        gitHead: '',
      },
      options: { repositoryUrl },
    },
  );
  if (notes === undefined) {
    return '';
  }
  if (typeof notes !== 'string') {
    throw new Error('release-notes-generator returned a non-string result');
  }
  const normalized = notes.replaceAll('\r\n', '\n').trim();
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1 || !normalized.startsWith('## ')) {
    return normalized;
  }
  const repository = repositoryUrl.replace(/\.git$/iu, '');
  const heading = `## [${version}](${repository}/compare/v${previousVersion}...v${version}) (${date})`;
  return `${heading}${normalized.slice(firstLineEnd)}`;
}

export function computeNextVersion(previousVersion: string, bump: ReleaseBump): string {
  const match = VERSION_PATTERN.exec(previousVersion);
  if (match === null) {
    throw new Error(`previous version must be a plain major.minor.patch semver, got "${previousVersion}"`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseNotesBody(notes: string): string {
  const normalized = notes.replaceAll('\r\n', '\n').trim();
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1 || !/^## \[[^\n]+\]\([^\n]+\)(?: \([^\n]+\))?$/u.test(normalized.slice(0, firstLineEnd))) {
    return normalized;
  }
  return normalized.slice(firstLineEnd + 1).trim();
}

export function renderChangelogEntry(
  version: string,
  previousVersion: string,
  notes: string,
  date: string,
  repositoryUrl: string,
): string {
  const repository = repositoryUrl.replace(/\.git$/iu, '');
  const heading = `## [${version}](${repository}/compare/v${previousVersion}...v${version}) (${date})`;
  return `${heading}\n\n\n${releaseNotesBody(notes)}\n\n`;
}