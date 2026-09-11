import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const npmrcPath = resolve(import.meta.dirname, '../../.npmrc');
const npmrc = readFileSync(npmrcPath, 'utf8');
const credentialKeys = new Set([
  '_authtoken',
  '_auth',
  'username',
  '_password',
  'password',
  'email',
  'certfile',
  'keyfile',
  'always-auth',
]);

function isCredentialAssignment(line: string): boolean {
  const equalsIndex = line.indexOf('=');
  if (equalsIndex < 0) {
    return false;
  }

  const key = line.slice(0, equalsIndex).trim().toLowerCase();
  const keyName = key.slice(key.lastIndexOf(':') + 1);
  return credentialKeys.has(keyName);
}

describe('.npmrc registry policy', () => {
  it('pins the project to the public npm registry without credentials', () => {
    const lines = npmrc.split(/\r?\n/).filter(line => line.trim().length > 0);

    expect(lines.some(isCredentialAssignment)).toBe(false);
    expect(npmrc.trim()).toBe('registry=https://registry.npmjs.org/');
  });
});