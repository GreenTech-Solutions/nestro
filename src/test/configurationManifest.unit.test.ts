import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ConfigurationSetting {
  readonly default: boolean | number | string;
  readonly description: string;
  readonly enum?: readonly string[];
  readonly enumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

interface ExtensionManifest {
  readonly capabilities: {
    readonly untrustedWorkspaces: WorkspaceCapability;
    readonly virtualWorkspaces: WorkspaceCapability;
  };
  readonly contributes: {
    readonly configuration: {
      readonly properties: Readonly<Record<string, ConfigurationSetting>>;
    };
  };
  readonly extensionKind: readonly string[];
}

interface WorkspaceCapability {
  readonly supported: boolean;
  readonly description: string;
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

describe('extension configuration manifest', () => {
  it('keeps prerelease updates opt-in by default', () => {
    expect(manifest.contributes.configuration.properties['nestro.includePreReleases'].default).toBe(false);
  });

  it('uses seven days by default and allows zero to disable release-age checks', () => {
    const setting = manifest.contributes.configuration.properties['nestro.minimumReleaseAgeDays'];
    expect(setting.default).toBe(7);
    expect(setting.minimum).toBe(0);
    expect(setting.maximum).toBe(99_000_000);
  });

  it('declares unsupported workspace modes and workspace-side execution', () => {
    expect(manifest.capabilities.untrustedWorkspaces).toEqual({
      supported: false,
      description: 'Nestro reads local package files and runs package-manager processes.',
    });
    expect(manifest.capabilities.virtualWorkspaces).toEqual({
      supported: false,
      description: 'Nestro requires local package files and package-manager processes.',
    });
    expect(manifest.extensionKind).toEqual(['workspace']);
  });

  it('describes update target choices in enum order', () => {
    const setting = manifest.contributes.configuration.properties['nestro.updateTarget'];

    expect(setting).toMatchObject({
      default: 'latest',
      enum: ['latest', 'greatest', 'minor', 'patch'],
      description: 'Select the version target used by update checks. The chosen target controls how far a dependency may move; prerelease inclusion and the release-age cooldown still apply.',
      enumDescriptions: [
        'Use the package\'s latest dist-tag version, accepting a new major version when it is published under that tag, subject to the prerelease and minimum release age settings.',
        'Choose the highest available version, independent of dist-tags, subject to the prerelease and minimum release age settings.',
        'Allow patch and minor upgrades while staying on the current major version, subject to the prerelease and minimum release age settings.',
        'Allow only patch upgrades within the current major and minor version, subject to the prerelease and minimum release age settings.',
      ],
    });
    expect(setting.enumDescriptions).toHaveLength(setting.enum?.length ?? 0);
  });

  it('describes default filter choices and their effect on Update All and in-progress rows', () => {
    const setting = manifest.contributes.configuration.properties['nestro.defaultFilter'];

    expect(setting).toMatchObject({
      default: 'all',
      enum: ['all', 'hasUpdates', 'patch', 'minor', 'breaking'],
      description: 'Choose the package rows shown by the sidebar when Nestro starts. The Update All command acts only on the rows currently visible; the filter does not change which updates are checked. Every filter except All also hides a package while its update is in progress.',
      enumDescriptions: [
        'Show every discovered dependency, including packages without updates.',
        'Show packages with an available update of any update type.',
        'Show only packages with patch updates.',
        'Show only packages with minor updates.',
        'Show only packages whose update raises the major version.',
      ],
    });
    expect(setting.enumDescriptions).toHaveLength(setting.enum?.length ?? 0);
  });

  it('documents update-check precedence, release risk, deferred install, and audit startup', () => {
    const settings = manifest.contributes.configuration.properties;

    expect(settings['nestro.checkUpdatesOnStartup']).toMatchObject({
      default: false,
      description: 'After the initial package scan completes, run one update check on each extension activation.',
    });
    expect(settings['nestro.includePreReleases']).toMatchObject({
      default: false,
      description: 'Include alpha, beta, and release-candidate versions in update checks and in the Pick Version version list. Disabled by default because prereleases can be less stable; enable it only when that risk is acceptable.',
    });
    expect(settings['nestro.minimumReleaseAgeDays']).toMatchObject({
      default: 7,
      description: 'Minimum age in days before Nestro accepts a release for an update check; the value must be a whole number of days, or the default is used. For Nestro checks, this value overrides native package-manager release-age settings; newer releases may be deferred to an older eligible version, missing publish times are reported as unknown, and applying an update inside the window prompts for confirmation. The default 7-day cooldown reduces newly published release risk but delays updates; set to 0 to disable this Nestro policy. It does not change package-manager install behavior.',
    });
    expect(settings['nestro.checkUpdatesDebounce']).toMatchObject({
      default: 60,
      description: 'Minimum seconds between update checks when the package files and update policy are unchanged. A click inside this window is ignored; after it, a valid cached result is reused without a network fetch. Set to 0 to disable this debounce. checkUpdatesForceAlways overrides this setting.',
    });
    expect(settings['nestro.checkUpdatesForceAlways']).toMatchObject({
      default: false,
      description: 'When no update check is already running, start every Check for Updates click immediately, bypassing checkUpdatesDebounce and the update cache. This can make a network request on every click; changes to update policy or package files already invalidate the cache and bypass the debounce.',
    });
    expect(settings['nestro.deferInstallAfterUpdate']).toMatchObject({
      default: false,
      description: 'Write selected update versions to package.json without running the package manager. Run Nestro: Run Install separately to update installed packages and lockfiles; when disabled, each update runs the package manager immediately.',
    });
    expect(settings['nestro.runAuditOnStartup']).toMatchObject({
      default: false,
      description: 'After the initial package scan completes, run one detected-package-manager security audit for each resolved project on every extension activation. This is independent of update checks and is disabled by default.',
    });
  });
});