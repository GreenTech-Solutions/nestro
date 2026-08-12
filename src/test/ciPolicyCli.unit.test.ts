import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CI_WORKFLOW_PATH,
  createNodeCiPolicyCliDependencies,
  runCiPolicyCli,
  type WorkflowPolicySource,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const releaseWorkflowPath = '.github/workflows/release.yml';

function readCanonicalWorkflows(): Promise<WorkflowPolicySource[]> {
  return Promise.all([CI_WORKFLOW_PATH, releaseWorkflowPath].map(async path => ({
    path,
    source: await readFile(resolve(repositoryRoot, path), 'utf8'),
  })));
}

describe('CI policy CLI', () => {
  it('reports acceptance only after reading and evaluating the canonical workflow', async () => {
    const writeOut = vi.fn();
    const writeError = vi.fn();

    await expect(runCiPolicyCli({
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
    ['an Error', new Error('read denied'), 'read denied'],
    ['a non-Error reason', 'filesystem vanished', 'filesystem vanished'],
  ])('reports %s from the workflow reader', async (_label, failure, expected) => {
    const writeError = vi.fn();

    await expect(runCiPolicyCli({
      readWorkflows: () => Promise.reject(failure),
      writeOut: vi.fn(),
      writeError,
    })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledExactlyOnceWith(`CI workflow policy failed: ${expected}`);
  });

  it('wires the Node dependencies to the repository workflow and process streams', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const dependencies = createNodeCiPolicyCliDependencies(repositoryRoot);
      const workflows = await dependencies.readWorkflows();
      expect(workflows.map(workflow => workflow.path)).toEqual([CI_WORKFLOW_PATH, releaseWorkflowPath]);
      expect(workflows[0].source).toContain('name: Verify');
      expect(workflows[1].source).toContain('name: Release');
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

  it.each([
    ['mutable tag', 'actions/checkout@v6', 'immutable-action'],
    ['arbitrary SHA', `actions/checkout@${'f'.repeat(40)}`, 'reviewed-action'],
    ['substituted locator', 'attacker/checkout@d23441a48e516b6c34aea4fa41551a30e30af803', 'reviewed-action'],
  ])('rejects a %s in release.yml with a path-qualified error', async (_label, replacement, rule) => {
    const workflows = await readCanonicalWorkflows();
    const release = workflows.find(workflow => workflow.path === releaseWorkflowPath);
    if (release === undefined) {
      throw new Error('release workflow fixture is missing');
    }
    const writeError = vi.fn();
    await expect(runCiPolicyCli({
      readWorkflows: () => Promise.resolve(workflows.map(workflow => workflow === release
        ? {
            ...workflow,
            source: workflow.source.replace(
              'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
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
      readWorkflows: () => Promise.resolve([...canonical, mutableExtra]),
      writeOut: vi.fn(),
      writeError: extraError,
    })).resolves.toBe(1);
    expect(extraError).toHaveBeenCalledWith(expect.stringContaining(
      '[immutable-action] .github/workflows/extra.yaml:',
    ));

    const missingCiError = vi.fn();
    await expect(runCiPolicyCli({
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
        writeFile(resolve(workflowsDirectory, 'release.yml'), await readFile(resolve(repositoryRoot, releaseWorkflowPath))),
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

  it('preserves the exact AUD-14 ci.yml contract while scanning every workflow', async () => {
    const workflows = await readCanonicalWorkflows();
    const writeError = vi.fn();
    await expect(runCiPolicyCli({
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