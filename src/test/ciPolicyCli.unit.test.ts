import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CI_WORKFLOW_PATH,
  createNodeCiPolicyCliDependencies,
  runCiPolicyCli,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('CI policy CLI', () => {
  it('reports acceptance only after reading and evaluating the canonical workflow', async () => {
    const writeOut = vi.fn();
    const writeError = vi.fn();

    await expect(runCiPolicyCli({
      readWorkflow: () => readFile(resolve(repositoryRoot, CI_WORKFLOW_PATH), 'utf8'),
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
      readWorkflow: () => Promise.resolve('name: Forged\non: pull_request\npermissions: {}\njobs: {}\n'),
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
      readWorkflow: () => Promise.reject(failure),
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
      await expect(dependencies.readWorkflow()).resolves.toContain('name: Verify');
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
});