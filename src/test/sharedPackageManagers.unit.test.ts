import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACKAGE_MANAGER,
  isPackageManager,
  LOCKFILES,
  PACKAGE_MANAGER_NAMES,
  PACKAGE_MANAGERS,
  parsePackageManagerField,
  YARN_DIALECTS,
} from '../shared';
import { LOCKFILE_PRIORITY } from '../shared/packageManagers';

describe('PACKAGE_MANAGERS', () => {
  it('has one entry per supported manager', () => {
    expect(Object.keys(PACKAGE_MANAGERS)).toEqual([...PACKAGE_MANAGER_NAMES]);
    expect(PACKAGE_MANAGER_NAMES.map(name => PACKAGE_MANAGERS[name].bin)).toEqual(['npm', 'pnpm', 'yarn', 'bun']);
    expect(DEFAULT_PACKAGE_MANAGER).toBe('npm');
  });

  it('describes the JSON audit argv of every manager and Yarn family', () => {
    expect(PACKAGE_MANAGERS.npm.dialect.audit).toEqual(['audit', '--json']);
    expect(PACKAGE_MANAGERS.pnpm.dialect.audit).toEqual(['audit', '--json']);
    expect(PACKAGE_MANAGERS.bun.dialect.audit).toEqual(['audit', '--json']);
    expect(YARN_DIALECTS.classic.audit).toEqual(['audit', '--json']);
    expect(YARN_DIALECTS.modern.audit).toEqual(['npm', 'audit', '--all', '--recursive', '--json']);
  });

  it('ends every metadata argv with the operand separator and leaves Bun without one', () => {
    expect(PACKAGE_MANAGERS.npm.dialect.metadata).toEqual(['view', '--json', '--']);
    expect(PACKAGE_MANAGERS.pnpm.dialect.metadata).toEqual(['view', '--json', '--']);
    expect(YARN_DIALECTS.classic.metadata).toEqual(['info', '--json', '--']);
    expect(YARN_DIALECTS.modern.metadata).toEqual(['npm', 'info', '--json', '--']);
    expect(PACKAGE_MANAGERS.bun.dialect.metadata).toBeUndefined();
  });

  it('describes the add, remove, install and dev-flag spelling of every manager', () => {
    expect(PACKAGE_MANAGER_NAMES.map(name => [
      PACKAGE_MANAGERS[name].installVerb,
      PACKAGE_MANAGERS[name].addVerb,
      PACKAGE_MANAGERS[name].removeVerb,
      PACKAGE_MANAGERS[name].devFlag,
    ])).toEqual([
      ['install', 'install', 'uninstall', '--save-dev'],
      ['install', 'add', 'remove', '--save-dev'],
      ['install', 'add', 'remove', '--dev'],
      ['install', 'add', 'remove', '--dev'],
    ]);
  });

  it('names each registry configuration file', () => {
    expect([
      PACKAGE_MANAGERS.npm.dialect.configFile,
      PACKAGE_MANAGERS.pnpm.dialect.configFile,
      YARN_DIALECTS.classic.configFile,
      YARN_DIALECTS.modern.configFile,
      PACKAGE_MANAGERS.bun.dialect.configFile,
    ]).toEqual(['.npmrc', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml']);
  });
});

describe('LOCKFILES', () => {
  it('lists lock files in detection order: pnpm, Yarn, Bun, then npm', () => {
    expect(LOCKFILE_PRIORITY).toEqual(['pnpm', 'yarn', 'bun', 'npm']);
    expect(LOCKFILES).toEqual([
      { fileName: 'pnpm-lock.yaml', packageManager: 'pnpm' },
      { fileName: 'yarn.lock', packageManager: 'yarn' },
      { fileName: 'bun.lock', packageManager: 'bun' },
      { fileName: 'bun.lockb', packageManager: 'bun' },
      { fileName: 'package-lock.json', packageManager: 'npm' },
      { fileName: 'npm-shrinkwrap.json', packageManager: 'npm' },
    ]);
  });
});

describe('isPackageManager()', () => {
  it.each(['npm', 'pnpm', 'yarn', 'bun'])('accepts %s', (name) => {
    expect(isPackageManager(name)).toBe(true);
  });

  it.each(['', 'NPM', 'deno', 'yarn@4', undefined, 1])('rejects %j', (value) => {
    expect(isPackageManager(value)).toBe(false);
  });
});

describe('parsePackageManagerField()', () => {
  it.each([
    ['pnpm@9.15.0', 'pnpm', '9.15.0'],
    ['yarn@4.5.0+sha512.abc', 'yarn', '4.5.0+sha512.abc'],
    ['npm@10', 'npm', '10'],
    ['bun@1.3.0', 'bun', '1.3.0'],
    ['yarn@', 'yarn', ''],
    ['bun', 'bun', undefined],
  ])('reads %s', (value, packageManager, version) => {
    expect(parsePackageManagerField(value)).toEqual({ packageManager, version });
  });

  it.each([undefined, '', 'deno@2', '@pnpm', ' pnpm@9', 'Yarn@4'])('rejects %j', (value) => {
    expect(parsePackageManagerField(value)).toBeUndefined();
  });
});