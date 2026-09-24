import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CI_WORKFLOW_PATH,
  CODEOWNERS_PATH,
  createNodeCiPolicyCliDependencies,
  DEPENDABOT_CONFIG_PATH,
  RELEASE_CANDIDATE_WORKFLOW_PATH,
  RELEASE_CONFIG_PATH,
  RELEASE_DISPATCH_WORKFLOW_PATH,
  RELEASE_PREPARE_WORKFLOW_PATH,
  RELEASE_WORKFLOW_PATH,
  runCiPolicyCli,
} from '../tools';
import type { CiPolicyCliDependencies, WorkflowPolicySource } from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const releaseWorkflowPath = RELEASE_WORKFLOW_PATH;
const canonicalReleaseSource = readFile(resolve(repositoryRoot, releaseWorkflowPath), 'utf8');

const canonicalPolicyReaders: Pick<
  CiPolicyCliDependencies,
  'readCodeowners' | 'readDependabotConfigs' | 'readReleaseConfig'
> = {
  readCodeowners: () => readFile(resolve(repositoryRoot, CODEOWNERS_PATH), 'utf8'),
  readDependabotConfigs: async () => [{
    path: DEPENDABOT_CONFIG_PATH,
    source: await readFile(resolve(repositoryRoot, DEPENDABOT_CONFIG_PATH), 'utf8'),
  }],
  readReleaseConfig: () => readFile(resolve(repositoryRoot, RELEASE_CONFIG_PATH), 'utf8'),
};

async function readCanonicalWorkflows(): Promise<WorkflowPolicySource[]> {
  const releaseSource = await canonicalReleaseSource;
  return [
    { path: CI_WORKFLOW_PATH, source: await readFile(resolve(repositoryRoot, CI_WORKFLOW_PATH), 'utf8') },
    { path: RELEASE_PREPARE_WORKFLOW_PATH, source: await readFile(resolve(repositoryRoot, RELEASE_PREPARE_WORKFLOW_PATH), 'utf8') },
    { path: RELEASE_CANDIDATE_WORKFLOW_PATH, source: await readFile(resolve(repositoryRoot, RELEASE_CANDIDATE_WORKFLOW_PATH), 'utf8') },
    { path: RELEASE_DISPATCH_WORKFLOW_PATH, source: await readFile(resolve(repositoryRoot, RELEASE_DISPATCH_WORKFLOW_PATH), 'utf8') },
    { path: releaseWorkflowPath, source: releaseSource },
  ];
}

describe('CI policy CLI', () => {
  it('reports acceptance only after reading and evaluating the canonical workflow', async () => {
    const writeOut = vi.fn();
    const writeError = vi.fn();

    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: readCanonicalWorkflows,
      writeOut,
      writeError,
    })).resolves.toBe(0);
    expect(writeOut).toHaveBeenCalledExactlyOnceWith('CI workflow policy verified');
    expect(writeError).not.toHaveBeenCalled();
  });

  it('prints every semantic violation and returns failure', async () => {
    const writeOut = vi.fn();
    const writeError = vi.fn();

    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.resolve([{
        path: CI_WORKFLOW_PATH,
        source: 'name: Forged\non: pull_request\npermissions: {}\njobs: {}\n',
      }]),
      writeOut,
      writeError,
    })).resolves.toBe(1);
    expect(writeOut).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalled();
    expect(writeError.mock.calls.some(([message]) => String(message).includes('[least-permissions]'))).toBe(true);
  });

  it.each([
    ['the workflow reader', 'readWorkflows'],
    ['the CODEOWNERS reader', 'readCodeowners'],
    ['the Dependabot reader', 'readDependabotConfigs'],
    ['the release config reader', 'readReleaseConfig'],
  ] as const)('reports a failure from %s', async (_label, rejectedReader) => {
    const writeError = vi.fn();
    const rejected = () => Promise.reject(new Error('read denied'));

    await expect(runCiPolicyCli({
      readCodeowners: rejectedReader === 'readCodeowners'
        ? rejected
        : canonicalPolicyReaders.readCodeowners,
      readDependabotConfigs: rejectedReader === 'readDependabotConfigs'
        ? rejected
        : canonicalPolicyReaders.readDependabotConfigs,
      readReleaseConfig: rejectedReader === 'readReleaseConfig'
        ? rejected
        : canonicalPolicyReaders.readReleaseConfig,
      readWorkflows: rejectedReader === 'readWorkflows' ? rejected : readCanonicalWorkflows,
      writeOut: vi.fn(),
      writeError,
    })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledExactlyOnceWith('CI workflow policy failed: read denied');
  });

  it('reports a non-Error reader rejection without throwing', async () => {
    const writeError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.reject('filesystem vanished'),
      writeOut: vi.fn(),
      writeError,
    })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledExactlyOnceWith('CI workflow policy failed: filesystem vanished');
  });

  it('wires the Node dependencies to the repository workflow and process streams', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const dependencies = createNodeCiPolicyCliDependencies(repositoryRoot);
      const workflows = await dependencies.readWorkflows();
      const dependabotConfigs = await dependencies.readDependabotConfigs();
      const expectedWorkflowPaths = [
        CI_WORKFLOW_PATH,
        RELEASE_CANDIDATE_WORKFLOW_PATH,
        RELEASE_DISPATCH_WORKFLOW_PATH,
        RELEASE_PREPARE_WORKFLOW_PATH,
      ];
      expectedWorkflowPaths.push(releaseWorkflowPath);
      expect(workflows.map(workflow => workflow.path)).toEqual(expectedWorkflowPaths);
      expect(workflows[0].source).toContain('name: Verify');
      expect(workflows.find(workflow => workflow.path === RELEASE_CANDIDATE_WORKFLOW_PATH)?.source)
        .toContain('name: Release candidate');
      await expect(dependencies.readCodeowners()).resolves.toBe('/.github/ @GreenTech-Solutions\n');
      expect(dependabotConfigs.map(config => config.path)).toEqual([DEPENDABOT_CONFIG_PATH]);
      expect(dependabotConfigs[0].source).toContain('package-ecosystem: github-actions');
      await expect(dependencies.readReleaseConfig?.()).resolves.toContain('@semantic-release/commit-analyzer');
      dependencies.writeOut('accepted');
      dependencies.writeError('rejected');
      expect(output).toHaveBeenCalledWith('accepted\n');
      expect(error).toHaveBeenCalledWith('rejected\n');
    }
    finally {
      output.mockRestore();
      error.mockRestore();
    }
  });

  it('fails closed on a missing or alternate Dependabot configuration', async () => {
    const canonicalConfig = await canonicalPolicyReaders.readDependabotConfigs();
    for (const configs of [
      [],
      [{ ...canonicalConfig[0], path: '.github/dependabot.yaml' }],
      [...canonicalConfig, { ...canonicalConfig[0], path: '.github/dependabot.yaml' }],
    ]) {
      const writeError = vi.fn();
      await expect(runCiPolicyCli({
        ...canonicalPolicyReaders,
        readDependabotConfigs: () => Promise.resolve(configs),
        readWorkflows: readCanonicalWorkflows,
        writeOut: vi.fn(),
        writeError,
      })).resolves.toBe(1);
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(
        `[dependabot-config-set] ${DEPENDABOT_CONFIG_PATH}:`,
      ));
    }
  });

  it('path-qualifies rejected Dependabot and CODEOWNERS contracts', async () => {
    const canonicalConfig = await canonicalPolicyReaders.readDependabotConfigs();
    const dependabotError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readDependabotConfigs: () => Promise.resolve([{
        ...canonicalConfig[0],
        source: canonicalConfig[0].source.replace('interval: weekly', 'interval: daily'),
      }]),
      readWorkflows: readCanonicalWorkflows,
      writeOut: vi.fn(),
      writeError: dependabotError,
    })).resolves.toBe(1);
    expect(dependabotError).toHaveBeenCalledWith(expect.stringContaining(
      `[dependabot-contract] ${DEPENDABOT_CONFIG_PATH}:`,
    ));

    const codeownersError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readCodeowners: () => Promise.resolve('/.github/workflows/ @GreenTech-Solutions\n'),
      readWorkflows: readCanonicalWorkflows,
      writeOut: vi.fn(),
      writeError: codeownersError,
    })).resolves.toBe(1);
    expect(codeownersError).toHaveBeenCalledWith(expect.stringContaining(
      `[codeowners-contract] ${CODEOWNERS_PATH}:`,
    ));
  });

  it('discovers both supported Dependabot filename spellings so a second config cannot hide', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'nestro-dependabot-policy-'));
    try {
      await mkdir(resolve(temporaryRoot, '.github'), { recursive: true });
      const source = await readFile(resolve(repositoryRoot, DEPENDABOT_CONFIG_PATH));
      await Promise.all([
        writeFile(resolve(temporaryRoot, DEPENDABOT_CONFIG_PATH), source),
        writeFile(resolve(temporaryRoot, '.github/dependabot.yaml'), source),
      ]);
      const configs = await createNodeCiPolicyCliDependencies(temporaryRoot).readDependabotConfigs();
      expect(configs.map(config => config.path)).toEqual([
        '.github/dependabot.yaml',
        DEPENDABOT_CONFIG_PATH,
      ]);
    }
    finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['mutable tag', 'actions/download-artifact@v8', 'immutable-action'],
    ['arbitrary SHA', `actions/download-artifact@${'f'.repeat(40)}`, 'reviewed-action'],
    ['substituted locator', 'attacker/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', 'reviewed-action'],
  ])('rejects a %s in release.yml with a path-qualified error', async (_label, replacement, rule) => {
    const workflows = await readCanonicalWorkflows();
    const release = workflows.find(workflow => workflow.path === releaseWorkflowPath);
    if (release === undefined) {
      throw new Error('release workflow fixture is missing');
    }
    const writeError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.resolve(workflows.map(workflow => workflow === release
        ? {
            ...workflow,
            source: workflow.source.replace(
              'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
              replacement,
            ),
          }
        : workflow)),
      writeOut: vi.fn(),
      writeError,
    })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining(
      `[${rule}] ${releaseWorkflowPath}:`,
    ));
  });

  it('discovers violations in an additional yaml workflow and fails closed without ci.yml', async () => {
    const canonical = await readCanonicalWorkflows();
    const mutableExtra: WorkflowPolicySource = {
      path: '.github/workflows/extra.yaml',
      source: 'jobs:\n  test:\n    uses: owner/repo/.github/workflows/test.yml@main\n',
    };
    const extraError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.resolve([...canonical, mutableExtra]),
      writeOut: vi.fn(),
      writeError: extraError,
    })).resolves.toBe(1);
    expect(extraError).toHaveBeenCalledWith(expect.stringContaining(
      '[immutable-action] .github/workflows/extra.yaml:',
    ));

    const missingCiError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.resolve(canonical.filter(workflow => workflow.path !== CI_WORKFLOW_PATH)),
      writeOut: vi.fn(),
      writeError: missingCiError,
    })).resolves.toBe(1);
    expect(missingCiError).toHaveBeenCalledWith(
      `[workflow-set] ${CI_WORKFLOW_PATH}: required canonical workflow is missing`,
    );
  });

  it('discovers and sorts yml and yaml files from the workflows directory', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'nestro-ci-policy-'));
    const workflowsDirectory = resolve(temporaryRoot, '.github/workflows');
    try {
      await mkdir(workflowsDirectory, { recursive: true });
      await Promise.all([
        writeFile(resolve(temporaryRoot, CODEOWNERS_PATH), await readFile(resolve(repositoryRoot, CODEOWNERS_PATH))),
        writeFile(
          resolve(temporaryRoot, DEPENDABOT_CONFIG_PATH),
          await readFile(resolve(repositoryRoot, DEPENDABOT_CONFIG_PATH)),
        ),
        writeFile(resolve(temporaryRoot, RELEASE_CONFIG_PATH), await readFile(resolve(repositoryRoot, RELEASE_CONFIG_PATH))),
        writeFile(resolve(workflowsDirectory, 'release.yml'), await canonicalReleaseSource),
        writeFile(resolve(workflowsDirectory, 'release-candidate.yml'), await readFile(resolve(repositoryRoot, RELEASE_CANDIDATE_WORKFLOW_PATH))),
        writeFile(resolve(workflowsDirectory, 'release-dispatch.yml'), await readFile(resolve(repositoryRoot, RELEASE_DISPATCH_WORKFLOW_PATH))),
        writeFile(resolve(workflowsDirectory, 'release-prepare.yml'), await readFile(resolve(repositoryRoot, RELEASE_PREPARE_WORKFLOW_PATH))),
        writeFile(resolve(workflowsDirectory, 'ci.yml'), await readFile(resolve(repositoryRoot, CI_WORKFLOW_PATH))),
        writeFile(resolve(workflowsDirectory, 'extra.yaml'), 'jobs:\n  test:\n    uses: owner/repo/.github/workflows/test.yml@main\n'),
        writeFile(resolve(workflowsDirectory, 'README.md'), 'not a workflow'),
        mkdir(resolve(workflowsDirectory, 'fixtures')),
      ]);
      const dependencies = createNodeCiPolicyCliDependencies(temporaryRoot);
      const workflows = await dependencies.readWorkflows();
      expect(workflows.map(workflow => workflow.path)).toEqual([
        CI_WORKFLOW_PATH,
        '.github/workflows/extra.yaml',
        RELEASE_CANDIDATE_WORKFLOW_PATH,
        RELEASE_DISPATCH_WORKFLOW_PATH,
        RELEASE_PREPARE_WORKFLOW_PATH,
        releaseWorkflowPath,
      ]);
      const writeError = vi.fn();
      await expect(runCiPolicyCli({
        ...dependencies,
        writeOut: vi.fn(),
        writeError,
      })).resolves.toBe(1);
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(
        '[immutable-action] .github/workflows/extra.yaml:',
      ));
    }
    finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('preserves the exact ci.yml contract while scanning every workflow', async () => {
    const workflows = await readCanonicalWorkflows();
    const writeError = vi.fn();
    await expect(runCiPolicyCli({
      ...canonicalPolicyReaders,
      readWorkflows: () => Promise.resolve(workflows.map(workflow => workflow.path === CI_WORKFLOW_PATH
        ? {
            ...workflow,
            source: workflow.source.replace('run: pnpm run lint', 'run: echo pnpm run lint'),
          }
        : workflow)),
      writeOut: vi.fn(),
      writeError,
    })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining(
      `[quality-gate] ${CI_WORKFLOW_PATH}:`,
    ));
  });
});