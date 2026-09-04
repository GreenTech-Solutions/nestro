import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BunClient, ClientManager, NpmClient, PnpmClient, YarnClient } from '../clients';
import { AUDIT_PROCESS_MAX_BUFFER_BYTES, AUDIT_PROCESS_TIMEOUT_MS } from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/processRunner', () => ({
  runBoundedProcess: runBoundedProcessMock,
}));

function mockExecSuccess(stdout: string): void {
  runBoundedProcessMock.mockImplementationOnce(() => {
    return Promise.resolve({ kind: 'exit', stdout, stderr: '', exitCode: 0 });
  });
}

function mockExecFailure(error: Error & { code?: unknown; stdout?: string; stderr?: string }): void {
  runBoundedProcessMock.mockImplementationOnce(() => {
    if (typeof error.code === 'number') {
      return Promise.resolve({
        kind: 'exit',
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        exitCode: error.code,
      });
    }
    return Promise.resolve({
      kind: 'spawn-error',
      reason: error.code === 'ENOENT' ? 'command-not-found' : 'process-failed',
      detail: `command could not run: ${error.message}`,
      message: error.message,
      cause: error,
    });
  });
}

/** Minimal npm v2 audit report: the report-version marker plus one advisory. */
function npmAuditReport(packageName: string, severity: string): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: { [packageName]: { name: packageName, severity } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 } },
  });
}

function yarnClassicAdvisory(packageName: string, severity: string, id: number): string {
  return JSON.stringify({
    type: 'auditAdvisory',
    data: {
      resolution: { id, path: packageName, dev: false, optional: false, bundled: false },
      advisory: { id, module_name: packageName, severity },
    },
  });
}

function yarnClassicSummary(overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    type: 'auditSummary',
    data: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        ...overrides,
      },
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  });
}

describe('package manager clients', () => {
  it('builds npm update commands', () => {
    expectCommand(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'npm', ['install', '--', quoted('react@18.0.0')]);
  });

  it('builds pnpm update commands', () => {
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'pnpm', ['add', '--', quoted('react@18.0.0')]);
  });

  it('builds yarn update commands', () => {
    expectCommand(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'yarn', ['add', '--', quoted('react@18.0.0')]);
  });

  it('builds bun update commands', () => {
    expectCommand(new BunClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '18.0.0', section: 'dependencies' },
    ]), 'bun', ['add', '--', quoted('react@18.0.0')]);
  });

  it('includes multiple packages in one command', () => {
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version: '19.0.0', section: 'dependencies' },
      { name: 'typescript', version: '5.9.3', section: 'dependencies' },
    ]), 'pnpm', ['add', '--', quoted('react@19.0.0'), quoted('typescript@5.9.3')]);
  });

  it('keeps the section flag before the operand separator for dev dependency updates', () => {
    expectCommand(new NpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'npm', ['install', '--save-dev', '--', quoted('vitest@4.0.0')]);
    expectCommand(new PnpmClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'pnpm', ['add', '--save-dev', '--', quoted('vitest@4.0.0')]);
    expectCommand(new YarnClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'yarn', ['add', '--dev', '--', quoted('vitest@4.0.0')]);
    expectCommand(new BunClient('/workspace').buildUpdateCommand([
      { name: 'vitest', version: '4.0.0', section: 'devDependencies' },
    ]), 'bun', ['add', '--dev', '--', quoted('vitest@4.0.0')]);
  });

  it('builds npm remove commands', () => {
    expectCommand(
      new NpmClient('/workspace').buildRemoveCommand(['lodash', 'moment']),
      'npm',
      ['uninstall', '--', quoted('lodash'), quoted('moment')],
    );
  });

  it.each([
    ['pnpm', PnpmClient],
    ['yarn', YarnClient],
    ['bun', BunClient],
  ] as const)('builds %s remove commands', (packageManager, ClientCtor) => {
    expectCommand(
      new ClientCtor('/workspace').buildRemoveCommand(['lodash', 'moment']),
      packageManager,
      ['remove', '--', quoted('lodash'), quoted('moment')],
    );
  });

  it('strongly quotes a valid package name that still contains shell metacharacters', () => {
    // Apostrophe and asterisk are real, registry-valid name characters that would
    // still break out of naive shell interpolation without Strong quoting.
    const command = new NpmClient('/workspace').buildUpdateCommand([
      { name: 'o\'brien-toolkit*', version: '1.0.0', section: 'dependencies' },
    ]);

    expectCommand(command, 'npm', ['install', '--', quoted('o\'brien-toolkit*@1.0.0')]);
  });

  it.each([
    ['npm', NpmClient],
    ['pnpm', PnpmClient],
    ['yarn', YarnClient],
    ['bun', BunClient],
  ] as const)('rejects an option-shaped package name before building an %s update command', (_packageManager, ClientCtor) => {
    expect(() => new ClientCtor('/workspace').buildUpdateCommand([
      { name: '--global', version: '1.0.0', section: 'dependencies' },
    ])).toThrow(/cannot start with a hyphen/);
  });

  it.each([
    ['npm', NpmClient],
    ['pnpm', PnpmClient],
    ['yarn', YarnClient],
    ['bun', BunClient],
  ] as const)('rejects an option-shaped package name before building an %s remove command', (_packageManager, ClientCtor) => {
    expect(() => new ClientCtor('/workspace').buildRemoveCommand(['--global']))
      .toThrow(/cannot start with a hyphen/);
  });

  it('rejects a package name that starts with a registry flag', () => {
    expect(() => new NpmClient('/workspace').buildUpdateCommand([
      { name: '--registry=http://evil.test', version: '1.0.0', section: 'dependencies' },
    ])).toThrow(/cannot start with a hyphen/);
  });

  it.each([
    ['empty name', ''],
    ['leading hyphen', '-leading-hyphen'],
    ['embedded space', 'left pad'],
    ['embedded control character', 'left\npad'],
    ['bare scope marker', '@'],
    ['empty scope', '@/pkg'],
    ['empty scoped package name', '@scope/'],
    ['scope with more than one slash', '@scope/name/extra'],
    ['unscoped name with a slash', 'unscoped/name'],
    ['URL-unsafe character', 'left$pad'],
  ] as const)('rejects an invalid unscoped or scoped name: %s', (_label, name) => {
    expect(() => new NpmClient('/workspace').buildRemoveCommand([name])).toThrow();
  });

  it.each([
    ['plain name', 'react'],
    ['scoped name', '@scope/react'],
    ['hyphens and digits', 'is-number2'],
    ['dot-separated name', 'lodash.debounce'],
    ['legacy mixed case', 'JSONStream'],
    ['legacy leading dot', '.hidden-legacy-pkg'],
    ['legacy leading underscore', '_legacy-pkg'],
    ['legacy special characters', 'left-pad\'!(~)*'],
    ['legacy length over 214 characters', `a${'b'.repeat(220)}`],
  ] as const)('accepts a valid or legacy-real name: %s', (_label, name) => {
    expect(() => new NpmClient('/workspace').buildRemoveCommand([name])).not.toThrow();
  });

  it.each([
    ['exact semver', '18.0.0'],
    ['prerelease with build metadata', '18.0.0-beta.1+build.5'],
    ['workspace spec', 'workspace:^1.0.0'],
    ['dist-tag', 'latest'],
  ] as const)('accepts a valid update version: %s', (_label, version) => {
    expect(() => new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version, section: 'dependencies' },
    ])).not.toThrow();
  });

  it.each([
    ['empty version', ''],
    ['leading hyphen', '--registry=http://evil.test'],
    ['embedded control character', '1.0.0\n--global'],
  ] as const)('rejects an invalid update version: %s', (_label, version) => {
    expect(() => new NpmClient('/workspace').buildUpdateCommand([
      { name: 'react', version, section: 'dependencies' },
    ])).toThrow();
  });
});

describe('runAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
      if (uri.fsPath === '/workspace/package.json') {
        return Promise.resolve(Buffer.from(JSON.stringify({ packageManager: 'yarn@1.22.19' })));
      }
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    });
  });

  it('runs npm audit through the base Client implementation', async () => {
    mockExecSuccess(npmAuditReport('react', 'high'));

    const vulnerabilities = await new NpmClient('/workspace').runAudit();

    expect(vulnerabilities.get('react')).toBe('high');
    expect(runBoundedProcessMock.mock.calls[0][0]).toBe('npm');
  });

  it('delegates pnpm audit to the package audit runner', async () => {
    mockExecSuccess(npmAuditReport('lodash', 'critical'));

    const vulnerabilities = await new PnpmClient('/workspace').runAudit();

    expect(vulnerabilities.get('lodash')).toBe('critical');
    expect(runBoundedProcessMock.mock.calls[0][0]).toBe('pnpm');
  });

  it('delegates bun audit to the Bun bulk advisory adapter', async () => {
    mockExecFailure(Object.assign(new Error('bun audit found vulnerabilities'), {
      code: 1,
      stdout: JSON.stringify({
        lodash: [{
          id: 1106913,
          url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
          title: 'Command Injection in lodash',
          severity: 'critical',
          vulnerable_versions: '<4.17.21',
        }],
      }),
    }));

    const vulnerabilities = await new BunClient('/workspace').runAudit();

    expect(vulnerabilities.get('lodash')).toBe('critical');
    expect(runBoundedProcessMock.mock.calls[0][0]).toBe('bun');
  });

  it('parses strict Yarn Classic NDJSON and merges duplicate package advisories', async () => {
    mockExecFailure(Object.assign(new Error('Yarn Classic audit found vulnerabilities'), {
      code: 24,
      stdout: [
        yarnClassicAdvisory('lodash', 'high', 1),
        yarnClassicAdvisory('lodash', 'critical', 2),
        yarnClassicSummary({ high: 1, critical: 1 }),
      ].join('\n'),
    }));

    const vulnerabilities = await new YarnClient('/workspace').runAudit();

    expect(vulnerabilities.get('lodash')).toBe('critical');
    expect(vulnerabilities.size).toBe(1);
  });

  it('fails closed on malformed or irrelevant Yarn Classic NDJSON lines', async () => {
    mockExecSuccess([
      'not json',
      yarnClassicSummary(),
    ].join('\n'));

    await expect(new YarnClient('/workspace').runAudit()).rejects.toMatchObject({
      outcome: { kind: 'incomplete', reason: 'malformed-json' },
    });
  });

  it('recovers Yarn Classic data from stdout when the process exits with its severity mask', async () => {
    const error = Object.assign(new Error('yarn audit found vulnerabilities'), {
      code: 16,
      stdout: `${yarnClassicAdvisory('vite', 'critical', 1)}\n${yarnClassicSummary({ critical: 1 })}`,
    });
    mockExecFailure(error);

    const vulnerabilities = await new YarnClient('/workspace').runAudit();

    expect(vulnerabilities.get('vite')).toBe('critical');
  });

  it('throws a typed error when Yarn Classic fails before producing inspectable output', async () => {
    mockExecFailure(new Error('yarn not found'));

    await expect(new YarnClient('/workspace').runAudit()).rejects.toThrow('yarn not found');
  });
});

describe('ClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(candidate => uri.fsPath.startsWith(candidate.uri.fsPath));
    });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
  });

  it.each([
    ['npm', NpmClient],
    ['pnpm', PnpmClient],
    ['yarn', YarnClient],
    ['bun', BunClient],
  ] as const)('returns a %s client from packageManager metadata', async (packageManager, expectedClient) => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(
      Buffer.from(JSON.stringify({ packageManager: `${packageManager}@1.0.0` })),
    );

    await expect(new ClientManager().getClient('/workspace')).resolves.toBeInstanceOf(expectedClient);
  });

  it('detects a root pnpm lockfile from a nested workspace package', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('pnpm');
  });

  it('detects ancestor packageManager metadata from a nested workspace package', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'yarn@4.12.0' }),
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('yarn');
  });

  it('runs Yarn audit from the ancestor directory that supplied the winning Yarn signal', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'yarn@4.6.0' }),
      '/workspace/packages/app/package.json': '{}',
    });
    mockExecSuccess('');

    const client = await new ClientManager().getClient('/workspace/packages/app');
    await client.runAudit();

    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'yarn',
      ['npm', 'audit', '--all', '--recursive', '--json'],
      {
        cwd: '/workspace',
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });

  it('retains the caller cwd for non-Yarn clients while resolving an ancestor manager', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'npm@11.0.0' }),
      '/workspace/packages/app/package.json': '{}',
    });
    mockExecSuccess(JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { total: 0 } },
    }));

    const client = await new ClientManager().getClient('/workspace/packages/app');
    await client.runAudit();

    expect(runBoundedProcessMock).toHaveBeenCalledWith(
      'npm',
      ['audit', '--json'],
      {
        cwd: '/workspace/packages/app',
        timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
        maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
        signal: undefined,
      },
    );
  });

  it('prefers a child lockfile over parent packageManager metadata', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@10.24.0' }),
      '/workspace/packages/app/package.json': '{}',
      '/workspace/packages/app/yarn.lock': '',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('yarn');
  });

  it('prefers packageManager metadata over lockfiles in the same directory', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@10.24.0' }),
      '/workspace/yarn.lock': '',
    });

    await expect(new ClientManager().detectPackageManager('/workspace')).resolves.toBe('pnpm');
  });

  it('does not read above the owning workspace folder when walking ancestors', async () => {
    mockWorkspaceFiles({
      '/pnpm-lock.yaml': '',
      '/workspace/package.json': '{}',
      '/workspace/packages/app/package.json': '{}',
    });

    await expect(new ClientManager().detectPackageManager('/workspace/packages/app')).resolves.toBe('npm');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/pnpm-lock.yaml' }),
    );
  });

  it('checks only the requested directory when it has no owning workspace folder', async () => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    mockWorkspaceFiles({
      '/outside/package.json': '{}',
      '/outside/yarn.lock': '# yarn lockfile v1\n',
    });

    await expect(new ClientManager().detectPackageManager('/outside')).resolves.toBe('yarn');
  });

  it.each([
    ['getClient', (manager: ClientManager) => manager.getClient('/workspace')],
    ['detectPackageManager', (manager: ClientManager) => manager.detectPackageManager('/workspace')],
  ] as const)('logs and propagates workspace lookup failures from %s', async (_label, operation) => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation(() => {
      throw new Error('workspace lookup failed');
    });

    await expect(operation(new ClientManager())).rejects.toThrow('workspace lookup failed');
  });
});

function mockWorkspaceFiles(files: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
    const value = files[uri.fsPath];
    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }

    return Promise.resolve(Buffer.from(value));
  });
}

function quoted(value: string): vscode.ShellQuotedString {
  return { value, quoting: vscode.ShellQuoting.Strong };
}

function expectCommand(
  command: { command: string | vscode.ShellQuotedString; args: (string | vscode.ShellQuotedString)[] },
  expectedCommand: string,
  expectedArgs: (string | vscode.ShellQuotedString)[],
): void {
  expect(command.command).toBe(expectedCommand);
  expect(command.args).toEqual(expectedArgs);
}