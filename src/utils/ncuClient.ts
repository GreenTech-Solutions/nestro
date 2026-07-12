export type NcuUpdateTarget = 'latest' | 'greatest' | 'minor' | 'patch';

const NCU_TIMEOUT_MS = 60_000;

type Run = (options: {
  packageFile: string;
  target: NcuUpdateTarget;
  pre: boolean;
  jsonUpgraded: true;
  removeRange: true;
  silent: true;
  timeout: number;
}) => Promise<unknown>;

let cachedRun: Run | undefined;

export async function fetchAllLatestVersions(
  packageFilePath: string,
  target: NcuUpdateTarget,
  includePreReleases: boolean,
): Promise<Map<string, string>> {
  const run = await getRun();
  const result = await run({
    packageFile: packageFilePath,
    target,
    pre: includePreReleases,
    jsonUpgraded: true,
    removeRange: true,
    silent: true,
    timeout: NCU_TIMEOUT_MS,
  });

  if (!isStringRecord(result)) {
    return new Map();
  }

  return new Map(Object.entries(result));
}

async function getRun(): Promise<Run> {
  if (cachedRun !== undefined) {
    return cachedRun;
  }

  ({ run: cachedRun } = await import('npm-check-updates'));
  return cachedRun;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every(item => typeof item === 'string');
}
