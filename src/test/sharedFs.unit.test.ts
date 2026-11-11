import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasErrorCode, isPathWithin, readOptionalFile } from '../shared';

describe('hasErrorCode()', () => {
  it('matches only an object carrying the same code', () => {
    expect(hasErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
    expect(hasErrorCode(Object.assign(new Error('x'), { code: 'EACCES' }), 'ENOENT')).toBe(false);
    expect(hasErrorCode(new Error('x'), 'ENOENT')).toBe(false);
    expect(hasErrorCode(null, 'ENOENT')).toBe(false);
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
  });
});

describe('readOptionalFile()', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nestro-shared-fs-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns the UTF-8 contents of an existing file', async () => {
    const file = path.join(directory, 'a.txt');
    await writeFile(file, 'héllo\n', 'utf8');

    await expect(readOptionalFile(file)).resolves.toBe('héllo\n');
  });

  it('returns undefined when the file does not exist', async () => {
    await expect(readOptionalFile(path.join(directory, 'missing.txt'))).resolves.toBeUndefined();
  });

  it('rethrows every failure other than a missing file', async () => {
    const folder = path.join(directory, 'folder');
    await mkdir(folder);

    await expect(readOptionalFile(folder)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('isPathWithin()', () => {
  const root = path.resolve('/workspace/app');

  it('accepts the root itself and anything beneath it', () => {
    expect(isPathWithin(root, root)).toBe(true);
    expect(isPathWithin(root, path.join(root, 'packages', 'a'))).toBe(true);
  });

  it('rejects siblings, parents and lookalike prefixes', () => {
    expect(isPathWithin(root, path.resolve('/workspace'))).toBe(false);
    expect(isPathWithin(root, path.resolve('/workspace/app-mobile'))).toBe(false);
    expect(isPathWithin(root, path.join(root, '..', 'other'))).toBe(false);
  });

  it('accepts a name that merely starts with two dots', () => {
    expect(isPathWithin(root, path.join(root, '..hidden'))).toBe(true);
  });

  it('resolves relative inputs before comparing', () => {
    expect(isPathWithin(path.join(root, 'sub', '..'), path.join(root, 'x'))).toBe(true);
  });
});