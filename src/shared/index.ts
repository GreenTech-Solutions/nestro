export { compareCodeUnits, uniqueStrings } from './compare';
export { sha256Hex } from './crypto';
export { describeError, describeStderr } from './errors';
export { hasErrorCode, isPathWithin, readOptionalFile } from './fs';
export { asString, hasExactKeys, isRecord, readRequiredString } from './guards';
export { INLINE_TEXT_MAX_LENGTH, redactCredentials, sanitizeInlineText, sanitizeMultilineText } from './text';
export { DEFAULT_MINIMUM_RELEASE_AGE_DAYS, FILTER_TYPES, isFilterType, isUpdateTarget, MAX_MINIMUM_RELEASE_AGE_DAYS, readMinimumReleaseAgeDays, UPDATE_TARGETS } from './settingValues';
export type { FilterType, UpdateTarget } from './settingValues';
export {
  WORKSPACE_PROTOCOL,
  extractRangePrefix,
  isConcreteSemver,
  isVersionOperand,
  parseConcreteSemver,
  parseVersionString,
  rangeBaseVersion,
  stripVersionDecorations,
  unwrapNpmAlias,
} from './versionGrammar';
export type { ParsedSemver } from './versionGrammar';
export {
  DEFAULT_PACKAGE_MANAGER,
  isPackageManager,
  LOCKFILE_PRIORITY,
  LOCKFILES,
  NODE_MODULES_EXCLUDE_GLOB,
  PACKAGE_MANAGER_NAMES,
  PACKAGE_MANAGERS,
  parsePackageManagerField,
  YARN_DIALECTS,
} from './packageManagers';
export type { CommandDialect, LockfileDescriptor, PackageManager, PackageManagerField } from './packageManagers';
export { getWindowsSystemExecutablePath, resolveSpawnTarget } from './spawnTarget';
export type { ResolvedSpawnTarget, SpawnTarget, SpawnTargetEnvironment, UnresolvedSpawnTarget } from './spawnTarget';