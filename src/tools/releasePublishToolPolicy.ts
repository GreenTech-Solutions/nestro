import { isDeepStrictEqual } from 'node:util';
import { MARKETPLACE_STEP_NAMES, PUBLISH_TOOL_INSTALL_COMMAND, scriptRun } from './releaseWorkflowParts';
import type { WorkflowViolation } from './workflowYaml';
import { describeError, hasExactKeys, isRecord } from '../shared';

export const PUBLISH_TOOL_MANIFEST_PATH = '.github/publish-tool/package.json';
export const PUBLISH_TOOL_LOCKFILE_PATH = '.github/publish-tool/package-lock.json';
export const ROOT_MANIFEST_PATH = 'package.json';

export interface PublishToolFiles {
  readonly rootManifest: string;
  readonly toolLockfile: string;
  readonly toolManifest: string;
}

const VSCE_PACKAGE = '@vscode/vsce';
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const NPM_RESOLVED_PATTERN = /^https:\/\/registry\.npmjs\.org\/[^\s?#]+$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const MARKETPLACE_CREDENTIAL_PATTERN = /secrets\.|--pat\b|\bpat\b|_PAT\b/iu;

function violation(rule: string, message: string): WorkflowViolation {
  return { rule, message };
}

function grantsIdToken(permissions: unknown): boolean {
  if (permissions === 'write-all') {
    return true;
  }
  return isRecord(permissions) && Object.hasOwn(permissions, 'id-token') && permissions['id-token'] !== 'none';
}

/** The OIDC token may be requested only by the named jobs, never at workflow level. */
export function idTokenViolations(workflow: unknown, allowedJobs: ReadonlySet<string>): WorkflowViolation[] {
  if (!isRecord(workflow)) {
    return [];
  }
  const violations = grantsIdToken(workflow.permissions) ? [violation('id-token-boundary', 'workflow must not grant id-token')] : [];
  for (const [jobId, job] of Object.entries(isRecord(workflow.jobs) ? workflow.jobs : {})) {
    if (isRecord(job) && grantsIdToken(job.permissions) && !allowedJobs.has(jobId)) {
      violations.push(violation('id-token-boundary', `${jobId} must not grant id-token`));
    }
  }
  return violations;
}

function publishSteps(workflow: unknown): Record<string, unknown>[] {
  const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
  const steps = isRecord(jobs.publish) && Array.isArray(jobs.publish.steps) ? jobs.publish.steps : [];
  return steps.filter(isRecord);
}

function normalizedRun(step: Record<string, unknown>): string | undefined {
  return typeof step.run === 'string' ? step.run.trim().replaceAll('\r\n', '\n') : undefined;
}

function installViolations(step: Record<string, unknown> | undefined): WorkflowViolation[] {
  if (step !== undefined && hasExactKeys(step, ['name', 'run']) && normalizedRun(step) === PUBLISH_TOOL_INSTALL_COMMAND) {
    return [];
  }
  return [violation('publish-tool-install', `"${MARKETPLACE_STEP_NAMES.install}" must run exactly: ${PUBLISH_TOOL_INSTALL_COMMAND}`)];
}

function marketplaceViolations(step: Record<string, unknown> | undefined): WorkflowViolation[] {
  const reviewed = step !== undefined
    && step.shell === 'bash'
    && !Object.hasOwn(step, 'uses')
    && normalizedRun(step) === scriptRun('publish-marketplace')
    && isDeepStrictEqual(step.env, { VSIX_PATH: '${{ steps.manifest.outputs.vsix-path }}' })
    && !MARKETPLACE_CREDENTIAL_PATTERN.test(JSON.stringify(step));
  return reviewed ? [] : [violation('marketplace-publish', `"${MARKETPLACE_STEP_NAMES.publish}" must run the reviewed script with the VSIX path only and no credentials`)];
}

function nodeCacheViolations(step: Record<string, unknown> | undefined): WorkflowViolation[] {
  const inputs = step !== undefined && isRecord(step.with) ? step.with : undefined;
  const reviewed = inputs !== undefined
    && typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@')
    && inputs['package-manager-cache'] === false
    && !Object.hasOwn(inputs, 'cache')
    && !Object.hasOwn(inputs, 'cache-dependency-path');
  return reviewed ? [] : [violation('publish-node-cache', `"${MARKETPLACE_STEP_NAMES.setupNode}" must disable package manager caching and set no cache input`)];
}

/** Marketplace publishing steps of the release `publish` job: tool install, Node.js cache, OIDC script. */
export function marketplaceStepViolations(workflow: unknown): WorkflowViolation[] {
  const steps = publishSteps(workflow);
  const named = (name: string): Record<string, unknown> | undefined => steps.find(step => step.name === name);
  return [
    ...nodeCacheViolations(named(MARKETPLACE_STEP_NAMES.setupNode)),
    ...installViolations(named(MARKETPLACE_STEP_NAMES.install)),
    ...marketplaceViolations(named(MARKETPLACE_STEP_NAMES.publish)),
  ];
}

function parseJsonRecord(source: string, label: string): { value?: Record<string, unknown>; violations: WorkflowViolation[] } {
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? { value, violations: [] } : { violations: [violation('publish-tool', `${label} must be a JSON object`)] };
  }
  catch (error) {
    return { violations: [violation('publish-tool', `${label} is not valid JSON: ${describeError(error)}`)] };
  }
}

function toolManifestViolations(manifest: Record<string, unknown>, rootVersion: unknown): WorkflowViolation[] {
  const { dependencies } = manifest;
  const shapeValid = hasExactKeys(manifest, ['dependencies', 'name', 'private'])
    && manifest.name === 'nestro-publish-tool'
    && manifest.private === true
    && isRecord(dependencies)
    && hasExactKeys(dependencies, [VSCE_PACKAGE]);
  if (!shapeValid) {
    return [violation('publish-tool', `${PUBLISH_TOOL_MANIFEST_PATH} must be a private manifest with the single dependency ${VSCE_PACKAGE}`)];
  }
  const pinned = dependencies[VSCE_PACKAGE];
  if (typeof pinned !== 'string' || !EXACT_VERSION_PATTERN.test(pinned) || pinned !== rootVersion) {
    return [violation('publish-tool', `${VSCE_PACKAGE} in ${PUBLISH_TOOL_MANIFEST_PATH} must be an exact version equal to the root devDependency`)];
  }
  return [];
}

function lockedPackageProblem(path: string, entry: unknown): string | undefined {
  if (!path.startsWith('node_modules/') || !isRecord(entry)) {
    return `${path} is not an installed registry package`;
  }
  if (typeof entry.resolved !== 'string' || !NPM_RESOLVED_PATTERN.test(entry.resolved)) {
    return `${path} must be resolved from https://registry.npmjs.org/`;
  }
  return typeof entry.integrity === 'string' && SHA512_INTEGRITY_PATTERN.test(entry.integrity) ? undefined : `${path} must carry a sha512 integrity`;
}

function toolLockfileViolations(lockfile: Record<string, unknown>, manifest: Record<string, unknown>): WorkflowViolation[] {
  const packages = isRecord(lockfile.packages) ? lockfile.packages : {};
  const { '': root, ...locked } = packages;
  const problems = Object.entries(locked).map(([path, entry]) => lockedPackageProblem(path, entry));
  if (lockfile.lockfileVersion !== 3) {
    problems.push('lockfileVersion must be 3');
  }
  if (!isRecord(root) || root.name !== manifest.name || !isDeepStrictEqual(root.dependencies, manifest.dependencies)) {
    problems.push('the root package must match the manifest');
  }
  const vsce = isRecord(locked[`node_modules/${VSCE_PACKAGE}`]) ? locked[`node_modules/${VSCE_PACKAGE}`] : undefined;
  if (!isRecord(vsce) || vsce.version !== (isRecord(manifest.dependencies) ? manifest.dependencies[VSCE_PACKAGE] : undefined)) {
    problems.push(`${VSCE_PACKAGE} must be locked at the manifest version`);
  }
  return problems.filter((problem): problem is string => problem !== undefined).map(problem => violation('publish-tool', `${PUBLISH_TOOL_LOCKFILE_PATH}: ${problem}`));
}

/** The publishing tool manifest pins the root vsce version and its lockfile covers every package by registry and integrity. */
export function evaluatePublishToolPolicy(files: PublishToolFiles): WorkflowViolation[] {
  const root = parseJsonRecord(files.rootManifest, ROOT_MANIFEST_PATH);
  const manifest = parseJsonRecord(files.toolManifest, PUBLISH_TOOL_MANIFEST_PATH);
  const lockfile = parseJsonRecord(files.toolLockfile, PUBLISH_TOOL_LOCKFILE_PATH);
  const parseViolations = [...root.violations, ...manifest.violations, ...lockfile.violations];
  if (root.value === undefined || manifest.value === undefined || lockfile.value === undefined) {
    return parseViolations;
  }
  const rootVersion = isRecord(root.value.devDependencies) ? root.value.devDependencies[VSCE_PACKAGE] : undefined;
  return [...toolManifestViolations(manifest.value, rootVersion), ...toolLockfileViolations(lockfile.value, manifest.value)];
}