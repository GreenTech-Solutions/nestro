import type { PackageManager } from '../../clients';

/**
 * Files materialized into a fixture root, keyed by a POSIX-style path relative
 * to that root. Contents are inline strings so a fixture never depends on any
 * file inside the repository working tree at run time.
 */
export type FixtureFiles = Readonly<Record<string, string>>;

export type FixtureKind = 'single-root' | 'multi-root';

/** One directory of a fixture that is opened as a VS Code workspace folder. */
export interface FixtureRoot {
  /** Directory relative to the fixture root. */
  readonly path: string;
  /** Package manager `ClientManager.detectPackageManager()` must report here. */
  readonly manager: PackageManager;
  /** Manifest paths relative to this root that the workspace search must find. */
  readonly manifests: readonly string[];
}

export interface WorkspaceFixture {
  /** Stable identifier, also used as the suite name. */
  readonly id: string;
  readonly kind: FixtureKind;
  /** Complete file tree of the fixture. */
  readonly files: FixtureFiles;
  /** Workspace folders contributed by the fixture, in the order they are added. */
  readonly roots: readonly FixtureRoot[];
}