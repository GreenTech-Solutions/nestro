import * as vscode from 'vscode';
import { DEFAULT_MINIMUM_RELEASE_AGE_DAYS, isFilterType, isUpdateTarget, readMinimumReleaseAgeDays } from '../shared';
import type { FilterType, UpdateTarget } from '../shared';

const SECTION = 'nestro';

export interface SettingValues {
  readonly checkUpdatesOnStartup: boolean;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
  readonly updateTarget: UpdateTarget;
  readonly defaultFilter: FilterType;
  readonly deferInstallAfterUpdate: boolean;
  readonly confirmBulkUpdate: boolean;
  readonly runAuditOnStartup: boolean;
  readonly monorepoGlob: string;
  readonly checkUpdatesDebounce: number;
  readonly checkUpdatesForceAlways: boolean;
}

/** Default of every `nestro.*` setting; kept equal to `contributes.configuration` in `package.json`. */
export const SETTING_DEFAULTS: SettingValues = {
  checkUpdatesOnStartup: false,
  includePreReleases: false,
  minimumReleaseAgeDays: DEFAULT_MINIMUM_RELEASE_AGE_DAYS,
  updateTarget: 'latest',
  defaultFilter: 'all',
  deferInstallAfterUpdate: false,
  confirmBulkUpdate: true,
  runAuditOnStartup: false,
  monorepoGlob: '**/package.json',
  checkUpdatesDebounce: 60,
  checkUpdatesForceAlways: false,
};

export interface UpdatePolicySettings {
  readonly target: UpdateTarget;
  readonly includePreReleases: boolean;
  readonly minimumReleaseAgeDays: number;
}

function readRaw(key: keyof SettingValues): unknown {
  return vscode.workspace.getConfiguration(SECTION).get<unknown>(key, SETTING_DEFAULTS[key]);
}

function readTyped<K extends keyof SettingValues>(key: K): SettingValues[K] {
  return vscode.workspace.getConfiguration(SECTION).get<SettingValues[K]>(key, SETTING_DEFAULTS[key]);
}

export function getCheckUpdatesOnStartup(): boolean {
  return readTyped('checkUpdatesOnStartup');
}

export function getRunAuditOnStartup(): boolean {
  return readTyped('runAuditOnStartup');
}

export function getIncludePreReleases(): boolean {
  return readTyped('includePreReleases');
}

export function getDeferInstallAfterUpdate(): boolean {
  return readTyped('deferInstallAfterUpdate');
}

export function getConfirmBulkUpdate(): boolean {
  return readTyped('confirmBulkUpdate');
}

export function getCheckUpdatesForceAlways(): boolean {
  return readTyped('checkUpdatesForceAlways');
}

export function getCheckUpdatesDebounce(): number {
  return readTyped('checkUpdatesDebounce');
}

export function getMonorepoGlob(): string {
  return readTyped('monorepoGlob');
}

/** An out-of-enum value falls back to the default. */
export function getUpdateTarget(): UpdateTarget {
  const value = readRaw('updateTarget');
  return isUpdateTarget(value) ? value : SETTING_DEFAULTS.updateTarget;
}

/** An out-of-enum value falls back to the default. */
export function getDefaultFilter(): FilterType {
  const value = readRaw('defaultFilter');
  return isFilterType(value) ? value : SETTING_DEFAULTS.defaultFilter;
}

/** An invalid value falls back to the default. */
export function getMinimumReleaseAgeDays(): number {
  return readMinimumReleaseAgeDays(readRaw('minimumReleaseAgeDays'));
}

export function getUpdatePolicySettings(): UpdatePolicySettings {
  return {
    target: getUpdateTarget(),
    includePreReleases: getIncludePreReleases(),
    minimumReleaseAgeDays: getMinimumReleaseAgeDays(),
  };
}