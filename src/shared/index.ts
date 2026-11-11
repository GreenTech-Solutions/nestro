export { compareCodeUnits, uniqueStrings } from './compare';
export { sha256Hex } from './crypto';
export { describeError, describeStderr } from './errors';
export { hasErrorCode, isPathWithin, readOptionalFile } from './fs';
export { asString, hasExactKeys, isRecord, readRequiredString } from './guards';
export { COMMAND_IDS, CONTEXT_KEYS, CONTEXT_VALUE_TOKENS, VIEW_IDS } from './ids';
export { classifyPackageName, isValidPackageName } from './packageName';
export { PACKAGE_PRESENTATION } from './packagePresentation';
export { INLINE_TEXT_MAX_LENGTH, redactCredentials, sanitizeInlineText, sanitizeMultilineText } from './text';
export { DEFAULT_MINIMUM_RELEASE_AGE_DAYS, FILTER_TYPES, isFilterType, isUpdateTarget, readMinimumReleaseAgeDays } from './settingValues';
export type { FilterType, UpdateTarget } from './settingValues';
export {
  compareNumericSemvers,
  WORKSPACE_PROTOCOL,
  extractRangePrefix,
  isAuditInstalledVersionCandidate,
  isConcreteSemver,
  isPlainNumericSemver,
  isVersionOperand,
  parseNumericSemverComparator,
  parseConcreteSemver,
  parsePlainNumericSemver,
  parseVersionString,
  parseYarnSemverMajor,
  rangeBaseVersion,
  stripVersionDecorations,
  unwrapNpmAlias,
} from './versionGrammar';
export type { ParsedSemver } from './versionGrammar';
export { DEFAULT_PACKAGE_MANAGER, isPackageManager, LOCKFILES, NODE_MODULES_EXCLUDE_GLOB, PACKAGE_MANAGER_NAMES, PACKAGE_MANAGERS, parsePackageManagerField, YARN_DIALECTS } from './packageManagers';
export type { LockfileDescriptor, PackageManager, PackageManagerSpec } from './packageManagers';
export { getWindowsSystemExecutablePath, resolveSpawnTarget } from './spawnTarget';
export type { SpawnTargetEnvironment } from './spawnTarget';