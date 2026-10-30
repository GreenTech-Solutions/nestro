export const PACKAGE_MANAGER_NAMES = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGER_NAMES)[number];

/** Fallback when no manifest field or lock file names a manager. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm';

/** Managers whose lock file is checked first win when one directory holds several. */
export const LOCKFILE_PRIORITY: readonly PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];

/** Glob excluding installed packages from workspace searches. */
export const NODE_MODULES_EXCLUDE_GLOB = '**/node_modules/**';

/** The command-line and config surface that differs between a manager's major command shapes. */
export interface CommandDialect {
  /** Complete argv of the JSON audit. */
  readonly audit: readonly string[];
  /** Metadata argv up to and including `--`; the package name follows. Absent without a native command. */
  readonly metadata: readonly string[] | undefined;
  /** Registry configuration file name. */
  readonly configFile: string;
}

export const YARN_DIALECTS = {
  classic: { audit: ['audit', '--json'], metadata: ['info', '--json', '--'], configFile: '.yarnrc' },
  modern: { audit: ['npm', 'audit', '--all', '--recursive', '--json'], metadata: ['npm', 'info', '--json', '--'], configFile: '.yarnrc.yml' },
} as const satisfies Record<string, CommandDialect>;

/** The command table row of one package manager. */
export interface PackageManagerSpec {
  readonly bin: string;
  readonly lockfiles: readonly [string, ...string[]];
  readonly installVerb: string;
  readonly addVerb: string;
  readonly removeVerb: string;
  readonly devFlag: string;
  /** Lets `add` target a workspace root, where the manager otherwise refuses; absent when it never refuses. Yarn Modern rejects it. */
  readonly workspaceRootFlag?: string;
  /** True when `remove` at a workspace root also needs `workspaceRootFlag`. */
  readonly removeNeedsWorkspaceRootFlag?: boolean;
  readonly dialect: CommandDialect;
}

/** One entry per supported package manager; Yarn's `dialect` is Classic, Modern is `YARN_DIALECTS.modern`. */
export const PACKAGE_MANAGERS = {
  npm: {
    bin: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    installVerb: 'install',
    addVerb: 'install',
    removeVerb: 'uninstall',
    devFlag: '--save-dev',
    dialect: { audit: ['audit', '--json'], metadata: ['view', '--json', '--'], configFile: '.npmrc' },
  },
  pnpm: {
    bin: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    installVerb: 'install',
    addVerb: 'add',
    removeVerb: 'remove',
    devFlag: '--save-dev',
    workspaceRootFlag: '--ignore-workspace-root-check',
    dialect: { audit: ['audit', '--json'], metadata: ['view', '--json', '--'], configFile: '.npmrc' },
  },
  yarn: {
    bin: 'yarn',
    lockfiles: ['yarn.lock'],
    installVerb: 'install',
    addVerb: 'add',
    removeVerb: 'remove',
    devFlag: '--dev',
    workspaceRootFlag: '--ignore-workspace-root-check',
    removeNeedsWorkspaceRootFlag: true,
    dialect: YARN_DIALECTS.classic,
  },
  bun: {
    bin: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    installVerb: 'install',
    addVerb: 'add',
    removeVerb: 'remove',
    devFlag: '--dev',
    dialect: { audit: ['audit', '--json'], metadata: undefined, configFile: 'bunfig.toml' },
  },
} as const satisfies Record<PackageManager, PackageManagerSpec>;

export function isPackageManager(value: unknown): value is PackageManager {
  return PACKAGE_MANAGER_NAMES.some(name => name === value);
}

export interface LockfileDescriptor {
  readonly fileName: string;
  readonly packageManager: PackageManager;
}

/** Every lock file in detection order: managers by `LOCKFILE_PRIORITY`, then each manager's own order. */
export const LOCKFILES: readonly LockfileDescriptor[] = LOCKFILE_PRIORITY.flatMap(packageManager =>
  PACKAGE_MANAGERS[packageManager].lockfiles.map(fileName => ({ fileName, packageManager })));

export interface PackageManagerField {
  readonly packageManager: PackageManager;
  /** Text after the first `@`, or undefined when the field names only the manager. */
  readonly version: string | undefined;
}

/** Reads a manifest `packageManager` field (`<name>` or `<name>@<version>`); an unsupported name yields undefined. */
export function parsePackageManagerField(value: string | undefined): PackageManagerField | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf('@');
  const name = separator < 0 ? value : value.slice(0, separator);
  if (!isPackageManager(name)) {
    return undefined;
  }
  return { packageManager: name, version: separator < 0 ? undefined : value.slice(separator + 1) };
}