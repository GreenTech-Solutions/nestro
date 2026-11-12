import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const firstExisting = (...candidates: string[]): string | undefined => candidates.find(candidate => existsSync(candidate));
const bash = firstExisting('/bin/bash', '/usr/bin/bash') ?? 'bash';
const hasShellTools = existsSync(bash) && firstExisting('/usr/bin/jq', '/usr/local/bin/jq', '/opt/homebrew/bin/jq') !== undefined;
const OIDC_ENVIRONMENT = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.invalid/request', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token-value' };

interface Outcome {
  readonly calls: string;
  readonly rejected: boolean;
  readonly stderr: string;
  readonly stdout: string;
}

interface Options {
  readonly environment?: Record<string, string>;
  readonly installedVersion?: string;
  readonly pinnedVersion?: string;
  readonly vsixName?: string;
  readonly vsixKind?: 'file' | 'missing' | 'symlink';
}

function runScript(options: Options = {}): Outcome {
  const { environment = OIDC_ENVIRONMENT, installedVersion = '4.1.0', pinnedVersion = '4.1.0', vsixName = 'nestro-1.0.0.vsix', vsixKind = 'file' } = options;
  const root = mkdtempSync(join(tmpdir(), 'nestro-publish-marketplace-'));
  try {
    const scripts = join(root, 'reviewed-source/.github/scripts/release');
    const tool = join(root, 'reviewed-source/.github/publish-tool');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(tool, 'node_modules/@vscode/vsce'), { recursive: true });
    mkdirSync(join(tool, 'node_modules/.bin'));
    for (const name of ['publish-marketplace.sh', 'candidate-lib.sh']) {
      cpSync(join(repositoryRoot, '.github/scripts/release', name), join(scripts, name));
    }
    cpSync(join(repositoryRoot, '.github/release-contract.json'), join(root, 'reviewed-source/.github/release-contract.json'));
    writeFileSync(join(tool, 'package.json'), JSON.stringify({ name: 'nestro-publish-tool', private: true, dependencies: { '@vscode/vsce': pinnedVersion } }));
    writeFileSync(join(tool, 'node_modules/@vscode/vsce/package.json'), JSON.stringify({ name: '@vscode/vsce', version: installedVersion }));
    const calls = join(root, 'vsce-calls.log');
    const fakeVsce = join(tool, 'node_modules/.bin/vsce');
    writeFileSync(fakeVsce, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${calls}'\n`);
    chmodSync(fakeVsce, 0o755);
    const vsix = join(root, vsixName);
    if (vsixKind === 'file') {
      writeFileSync(vsix, 'vsix');
    }
    else if (vsixKind === 'symlink') {
      writeFileSync(join(root, 'target.vsix'), 'vsix');
      symlinkSync(join(root, 'target.vsix'), vsix);
    }
    const result = spawnSync(bash, [join(scripts, 'publish-marketplace.sh')], {
      cwd: root,
      encoding: 'utf8',
      input: '',
      env: { PATH: process.env.PATH ?? '', ...environment, VSIX_PATH: vsix },
    });
    return {
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      rejected: result.status !== 0,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!hasShellTools)('Marketplace publishing script', () => {
  it('runs the pinned vsce once, with OIDC, the exact package and duplicate skipping, and nothing else', () => {
    const outcome = runScript();

    expect(outcome.rejected, outcome.stderr).toBe(false);
    const lines = outcome.calls.trim().split('\n');
    expect(lines.slice(0, 2)).toEqual(['publish', '--oidc']);
    expect(lines[2]).toBe('--packagePath');
    expect(lines[3]).toMatch(/nestro-1\.0\.0\.vsix$/u);
    expect(lines.slice(4)).toEqual(['--skip-duplicate']);
    expect(outcome.calls).not.toContain('--pat');
  });

  it('never forwards a long-lived token from the environment', () => {
    const outcome = runScript({ environment: { ...OIDC_ENVIRONMENT, VSCE_PAT: 'legacy-token-value' } });

    expect(outcome.rejected, outcome.stderr).toBe(false);
    expect(outcome.calls).not.toContain('legacy-token-value');
    expect(outcome.calls).not.toContain('--pat');
  });

  it.each(['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])('fails closed before vsce runs when %s is missing', (name) => {
    const environment = Object.fromEntries(Object.entries(OIDC_ENVIRONMENT).filter(([key]) => key !== name));
    const outcome = runScript({ environment });

    expect(outcome.rejected).toBe(true);
    expect(outcome.calls).toBe('');
    expect(outcome.stderr).toContain(name);
    expect(outcome.stderr).not.toContain('request-token-value');
  });

  it.each([
    ['an installed version that differs from the pin', { installedVersion: '4.0.0' }],
    ['a non-exact pin', { pinnedVersion: '^4.1.0', installedVersion: '4.1.0' }],
    ['a name that is not a VSIX file', { vsixName: 'nestro-1.0.0.zip' }],
    ['a name with a shell metacharacter', { vsixName: 'nestro;1.0.0.vsix' }],
    ['a missing package file', { vsixKind: 'missing' as const }],
    ['a symbolic link in place of the package', { vsixKind: 'symlink' as const }],
  ])('refuses %s without running vsce', (_label, options) => {
    const outcome = runScript(options);

    expect(outcome.rejected).toBe(true);
    expect(outcome.calls).toBe('');
  });
});