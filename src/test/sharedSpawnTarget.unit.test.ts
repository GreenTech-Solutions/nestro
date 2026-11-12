import { describe, expect, it } from 'vitest';
import { resolveSpawnTarget } from '../shared';

const windowsEnv = {
  PATH: 'C:\\Program Files\\nodejs;C:\\tools',
  SystemRoot: 'C:\\Windows',
};

function filesOnDisk(...files: string[]): (filePath: string) => boolean {
  return filePath => files.includes(filePath);
}

describe('resolveSpawnTarget()', () => {
  it('returns the command unchanged outside Windows', () => {
    expect(resolveSpawnTarget('npm', ['audit', '--json'], { platform: 'linux' })).toEqual({
      kind: 'resolved',
      command: 'npm',
      args: ['audit', '--json'],
    });
  });

  it('hosts a .cmd shim found on PATH in the system cmd.exe with one pre-quoted command line', () => {
    const target = resolveSpawnTarget('npm', ['view', '@scope/left-pad', '--json'], {
      platform: 'win32',
      env: windowsEnv,
      isFile: filesOnDisk('C:\\Program Files\\nodejs\\npm.cmd'),
    });

    expect(target).toEqual({
      kind: 'resolved',
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" view @scope/left-pad --json"'],
      windowsVerbatimArguments: true,
    });
  });

  it('spawns a real .exe directly, with no shell and unmodified arguments', () => {
    expect(resolveSpawnTarget('bun', ['audit', '--json'], {
      platform: 'win32',
      env: windowsEnv,
      isFile: filesOnDisk('C:\\tools\\bun.exe'),
    })).toEqual({ kind: 'resolved', command: 'C:\\tools\\bun.exe', args: ['audit', '--json'] });
  });

  it('prefers .exe over .cmd in one directory and earlier PATH directories over later ones', () => {
    const isFile = filesOnDisk('C:\\tools\\pnpm.exe', 'C:\\tools\\pnpm.cmd', 'C:\\Program Files\\nodejs\\pnpm.cmd');
    expect(resolveSpawnTarget('pnpm', ['-v'], { platform: 'win32', env: windowsEnv, isFile })).toMatchObject({
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\pnpm.cmd" -v"'],
    });
    expect(resolveSpawnTarget('pnpm', [], {
      platform: 'win32',
      env: { PATH: 'C:\\tools', SystemRoot: 'C:\\Windows' },
      isFile,
    })).toMatchObject({ command: 'C:\\tools\\pnpm.exe' });
  });

  it('reads PATH and SystemRoot regardless of key case', () => {
    expect(resolveSpawnTarget('yarn', ['--version'], {
      platform: 'win32',
      env: { Path: 'C:\\yarn', systemroot: 'D:\\Win' },
      isFile: filesOnDisk('C:\\yarn\\yarn.cmd'),
    })).toMatchObject({ command: 'D:\\Win\\System32\\cmd.exe' });
  });

  it('falls back to the standard Windows root when SystemRoot is missing or not a local absolute path', () => {
    for (const env of [{ PATH: 'C:\\yarn' }, { PATH: 'C:\\yarn', SystemRoot: 'relative' }]) {
      expect(resolveSpawnTarget('yarn', [], {
        platform: 'win32',
        env,
        isFile: filesOnDisk('C:\\yarn\\yarn.cmd'),
      })).toMatchObject({ command: 'C:\\Windows\\System32\\cmd.exe' });
    }
  });

  it('never looks for the command in the working directory or any relative PATH entry', () => {
    const probed: string[] = [];
    const target = resolveSpawnTarget('npm', [], {
      platform: 'win32',
      env: { PATH: ';.;node_modules\\.bin;"C:\\quoted dir";C:\\tools' },
      isFile: (filePath) => {
        probed.push(filePath);
        return false;
      },
    });

    expect(target).toMatchObject({ kind: 'unresolved', reason: 'command-not-found' });
    expect(probed).toEqual([
      'C:\\quoted dir\\npm.exe',
      'C:\\quoted dir\\npm.cmd',
      'C:\\tools\\npm.exe',
      'C:\\tools\\npm.cmd',
    ]);
  });

  it('reports a command missing from PATH as not found', () => {
    expect(resolveSpawnTarget('npm', [], { platform: 'win32', env: {}, isFile: () => false })).toEqual({
      kind: 'unresolved',
      reason: 'command-not-found',
      message: 'npm was not found on PATH.',
    });
  });

  it('refuses a relative command with a path separator but accepts an absolute launcher path', () => {
    const isFile = filesOnDisk('C:\\bin\\npm.cmd');
    expect(resolveSpawnTarget('.\\npm', [], { platform: 'win32', env: windowsEnv, isFile }))
      .toMatchObject({ kind: 'unresolved', reason: 'command-not-found' });
    expect(resolveSpawnTarget('C:\\bin\\npm.cmd', ['ci'], { platform: 'win32', env: windowsEnv, isFile }))
      .toMatchObject({ kind: 'resolved', args: ['/d', '/s', '/c', '""C:\\bin\\npm.cmd" ci"'] });
  });

  it.each([
    'two words',
    'a&b',
    'a|b',
    'a>b',
    'say "hi"',
    '%PATH%',
    '!VAR!',
    'a^b',
    'a,b',
    'a=b',
    'a\\b',
    '$(x)',
    '',
  ])('refuses the argument %j for a .cmd shim instead of escaping it', (argument) => {
    const target = resolveSpawnTarget('npm', ['view', argument], {
      platform: 'win32',
      env: windowsEnv,
      isFile: filesOnDisk('C:\\Program Files\\nodejs\\npm.cmd'),
    });

    expect(target).toEqual({
      kind: 'unresolved',
      reason: 'process-failed',
      message: 'Argument 2 contains characters cmd.exe cannot receive safely.',
    });
  });

  it('still passes any argument to a real .exe, which never goes through cmd.exe', () => {
    expect(resolveSpawnTarget('bun', ['say "hi" & more'], {
      platform: 'win32',
      env: windowsEnv,
      isFile: filesOnDisk('C:\\tools\\bun.exe'),
    })).toMatchObject({ kind: 'resolved', args: ['say "hi" & more'] });
  });

  it.each(['C:\\100%\\bin', 'C:\\wow!\\bin', 'C:\\a"b\\bin'])('refuses a .cmd shim in %s, where quoting cannot protect it', (directory) => {
    expect(resolveSpawnTarget('npm', [], {
      platform: 'win32',
      env: { PATH: directory },
      isFile: filesOnDisk(`${directory}\\npm.cmd`),
    })).toEqual({
      kind: 'unresolved',
      reason: 'process-failed',
      message: 'npm resolves to a path that cmd.exe cannot start safely.',
    });
  });

  it('uses the real process platform and environment by default', () => {
    expect(resolveSpawnTarget('node', ['-v'])).toEqual(
      process.platform === 'win32'
        ? expect.objectContaining({ kind: 'resolved' })
        : { kind: 'resolved', command: 'node', args: ['-v'] },
    );
  });
});