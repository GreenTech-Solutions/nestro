import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  getCheckUpdatesDebounce,
  getConfirmBulkUpdate,
  getDefaultFilter,
  getMinimumReleaseAgeDays,
  getMonorepoGlob,
  getUpdatePolicySettings,
  getUpdateTarget,
  SETTING_DEFAULTS,
} from '../config';
import { FILTER_TYPES, isRecord, MAX_MINIMUM_RELEASE_AGE_DAYS, UPDATE_TARGETS } from '../shared';

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

type ManifestValue = null | boolean | number | string | ManifestValue[] | { readonly [key: string]: ManifestValue };

type MessageCatalog = Readonly<Record<string, string>>;

const LOCALIZATION_TOKEN = /%([A-Za-z0-9_.-]+)%/g;

function validateMessageCatalog(value: unknown): MessageCatalog {
  if (!isRecord(value)) {
    throw new Error('package.nls.json must contain an object');
  }

  const catalog: Record<string, string> = {};
  for (const [key, message] of Object.entries(value)) {
    if (key.trim().length === 0 || typeof message !== 'string' || message.trim().length === 0) {
      throw new Error(`package.nls.json entry "${key}" must have a non-empty string value`);
    }
    catalog[key] = message;
  }
  return catalog;
}

function resolveMessage(
  key: string,
  catalog: MessageCatalog,
  resolvingKeys: ReadonlySet<string>,
  location: string,
): string {
  if (!Object.hasOwn(catalog, key)) {
    throw new Error(`Missing localization key "${key}" at ${location}`);
  }
  if (resolvingKeys.has(key)) {
    throw new Error(`Circular localization reference "${key}" at ${location}`);
  }

  const nextResolvingKeys = new Set(resolvingKeys);
  nextResolvingKeys.add(key);
  return catalog[key].replace(LOCALIZATION_TOKEN, (_token, nestedKey: string) => (
    resolveMessage(nestedKey, catalog, nextResolvingKeys, location)
  ));
}

function resolveManifestValue(
  value: ManifestValue,
  catalog: MessageCatalog,
  location: string,
): ManifestValue {
  if (typeof value === 'string') {
    return value.replace(LOCALIZATION_TOKEN, (_token, key: string) => (
      resolveMessage(key, catalog, new Set(), location)
    ));
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveManifestValue(item, catalog, `${location}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveManifestValue(child as ManifestValue, catalog, `${location}.${key}`),
      ]),
    );
  }
  return value;
}

function resolveManifestLocalization(value: ManifestValue, catalogValue: unknown): ManifestValue {
  return resolveManifestValue(value, validateMessageCatalog(catalogValue), 'manifest');
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const nlsPath = path.resolve(path.dirname(manifestPath), 'package.nls.json');
const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestValue;
const messageCatalog = validateMessageCatalog(JSON.parse(readFileSync(nlsPath, 'utf8')));
const manifest = resolveManifestLocalization(
  rawManifest,
  messageCatalog,
) as unknown as ExtensionManifest;

function localizedMessage(key: string): string {
  return resolveMessage(key, messageCatalog, new Set(), `package.nls.json:${key}`);
}

describe('extension configuration manifest', () => {
  it('resolves every manifest token against a non-empty English catalog', () => {
    expect(JSON.stringify(manifest)).not.toMatch(LOCALIZATION_TOKEN);
  });

  it('recursively resolves nested manifest values and catalog references', () => {
    expect(resolveManifestLocalization(
      { contents: ['%outer%', { text: 'prefix %outer%' }] },
      { outer: 'English %inner%', inner: 'baseline' },
    )).toEqual({ contents: ['English baseline', { text: 'prefix English baseline' }] });
  });

  it.each([
    ['a missing key', { value: '%missing%' }, { known: 'Known' }, 'Missing localization key "missing"'],
    ['an empty message', { value: '%empty%' }, { empty: '   ' }, 'must have a non-empty string value'],
    ['an empty catalog key', { value: 'plain' }, { '': 'value' }, 'must have a non-empty string value'],
  ])('rejects %s in the manifest localization boundary', (_label, value, catalog, message) => {
    expect(() => resolveManifestLocalization(value, catalog)).toThrow(message);
  });

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
      description: localizedMessage('capabilities.untrustedWorkspaces.description'),
    });
    expect(manifest.capabilities.virtualWorkspaces).toEqual({
      supported: false,
      description: localizedMessage('capabilities.virtualWorkspaces.description'),
    });
    expect(manifest.extensionKind).toEqual(['workspace']);
  });

  it('describes update target choices in enum order', () => {
    const setting = manifest.contributes.configuration.properties['nestro.updateTarget'];

    expect(setting).toMatchObject({
      default: 'latest',
      enum: ['latest', 'greatest', 'minor', 'patch'],
    });
    expect(setting.description).toBe(localizedMessage('configuration.updateTarget.description'));
    expect(setting.enumDescriptions).toEqual([
      localizedMessage('configuration.updateTarget.enum.latest'),
      localizedMessage('configuration.updateTarget.enum.greatest'),
      localizedMessage('configuration.updateTarget.enum.minor'),
      localizedMessage('configuration.updateTarget.enum.patch'),
    ]);
    expect(setting.enumDescriptions).toHaveLength(setting.enum?.length ?? 0);
  });

  it('describes default filter choices and their effect on Update All and in-progress rows', () => {
    const setting = manifest.contributes.configuration.properties['nestro.defaultFilter'];

    expect(setting).toMatchObject({
      default: 'all',
      enum: ['all', 'hasUpdates', 'patch', 'minor', 'breaking'],
    });
    expect(setting.description).toBe(localizedMessage('configuration.defaultFilter.description'));
    expect(setting.enumDescriptions).toEqual([
      localizedMessage('configuration.defaultFilter.enum.all'),
      localizedMessage('configuration.defaultFilter.enum.hasUpdates'),
      localizedMessage('configuration.defaultFilter.enum.patch'),
      localizedMessage('configuration.defaultFilter.enum.minor'),
      localizedMessage('configuration.defaultFilter.enum.breaking'),
    ]);
    expect(setting.enumDescriptions).toHaveLength(setting.enum?.length ?? 0);
  });

  it('documents update-check precedence, release risk, deferred install, and audit startup', () => {
    const settings = manifest.contributes.configuration.properties;

    expect(settings['nestro.checkUpdatesOnStartup']).toMatchObject({
      default: false,
      description: localizedMessage('configuration.checkUpdatesOnStartup.description'),
    });
    expect(settings['nestro.includePreReleases']).toMatchObject({
      default: false,
      description: localizedMessage('configuration.includePreReleases.description'),
    });
    expect(settings['nestro.minimumReleaseAgeDays']).toMatchObject({
      default: 7,
      description: localizedMessage('configuration.minimumReleaseAgeDays.description'),
    });
    expect(settings['nestro.checkUpdatesDebounce']).toMatchObject({
      default: 60,
      description: localizedMessage('configuration.checkUpdatesDebounce.description'),
    });
    expect(settings['nestro.checkUpdatesForceAlways']).toMatchObject({
      default: false,
      description: localizedMessage('configuration.checkUpdatesForceAlways.description'),
    });
    expect(settings['nestro.deferInstallAfterUpdate']).toMatchObject({
      default: false,
      description: localizedMessage('configuration.deferInstallAfterUpdate.description'),
    });
    expect(settings['nestro.runAuditOnStartup']).toMatchObject({
      default: false,
      description: localizedMessage('configuration.runAuditOnStartup.description'),
    });
  });
});

/** Settings whose module default differs from the manifest default, or that exist on only one side. */
function findDefaultMismatches(
  properties: Readonly<Record<string, ConfigurationSetting>>,
  defaultValues: object,
): string[] {
  const defaults: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(defaultValues));
  const manifestKeys = Object.keys(properties).map(key => key.replace(/^nestro\./, ''));
  const mismatches = manifestKeys
    .filter(key => !Object.hasOwn(defaults, key) || defaults[key] !== properties[`nestro.${key}`].default)
    .map(key => `${key}: module ${String(defaults[key])} vs manifest ${String(properties[`nestro.${key}`].default)}`);
  const missingFromManifest = Object.keys(defaults).filter(key => !manifestKeys.includes(key));
  return [...mismatches, ...missingFromManifest.map(key => `${key}: not declared in the manifest`)];
}

function mockSettings(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) => (
      Object.hasOwn(values, key) ? values[key] : defaultValue
    )),
  } as unknown as vscode.WorkspaceConfiguration);
}

describe('typed settings module', () => {
  const properties = manifest.contributes.configuration.properties;

  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
    mockSettings({});
  });

  it('declares the same defaults as the manifest for every setting', () => {
    expect(findDefaultMismatches(properties, SETTING_DEFAULTS)).toEqual([]);
  });

  it('reports a default that diverges from the manifest, or a setting missing on either side', () => {
    expect(findDefaultMismatches(properties, { ...SETTING_DEFAULTS, confirmBulkUpdate: false }))
      .toEqual(['confirmBulkUpdate: module false vs manifest true']);
    expect(findDefaultMismatches(properties, { ...SETTING_DEFAULTS, extra: 1 }))
      .toEqual(['extra: not declared in the manifest']);
    const withoutGlob = Object.fromEntries(Object.entries(SETTING_DEFAULTS).filter(([key]) => key !== 'monorepoGlob'));
    expect(findDefaultMismatches(properties, withoutGlob))
      .toEqual(['monorepoGlob: module undefined vs manifest **/package.json']);
  });

  it('keeps the shared enum values and numeric bound equal to the manifest', () => {
    expect([...UPDATE_TARGETS]).toEqual(properties['nestro.updateTarget'].enum);
    expect([...FILTER_TYPES]).toEqual(properties['nestro.defaultFilter'].enum);
    expect(MAX_MINIMUM_RELEASE_AGE_DAYS).toBe(properties['nestro.minimumReleaseAgeDays'].maximum);
  });

  it('returns the manifest defaults when nothing is configured', () => {
    expect(getUpdatePolicySettings()).toEqual({
      target: 'latest',
      includePreReleases: false,
      minimumReleaseAgeDays: 7,
    });
    expect(getDefaultFilter()).toBe('all');
    expect(getConfirmBulkUpdate()).toBe(true);
    expect(getCheckUpdatesDebounce()).toBe(60);
    expect(getMonorepoGlob()).toBe('**/package.json');
  });

  it('reads the namespace live on every call', () => {
    mockSettings({ confirmBulkUpdate: false });
    expect(getConfirmBulkUpdate()).toBe(false);
    mockSettings({ confirmBulkUpdate: true });
    expect(getConfirmBulkUpdate()).toBe(true);
    expect(vscode.workspace.getConfiguration).toHaveBeenLastCalledWith('nestro');
  });

  it.each([
    ['patch', 'patch'],
    ['sideways', 'latest'],
    [42, 'latest'],
  ])('maps updateTarget %j to %j', (configured, expected) => {
    mockSettings({ updateTarget: configured });
    expect(getUpdateTarget()).toBe(expected);
  });

  it.each([
    ['hasUpdates', 'hasUpdates'],
    ['everything', 'all'],
    [undefined, 'all'],
  ])('maps defaultFilter %j to %j', (configured, expected) => {
    mockSettings({ defaultFilter: configured });
    expect(getDefaultFilter()).toBe(expected);
  });

  it.each([
    [30, 30],
    [0, 0],
    [-1, 7],
    ['30', 7],
  ])('reads minimumReleaseAgeDays %j as %j', (configured, expected) => {
    mockSettings({ minimumReleaseAgeDays: configured });
    expect(getMinimumReleaseAgeDays()).toBe(expected);
  });
});