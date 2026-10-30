import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** The certificate authorities from npm's `ca` setting, else the contents of its `cafile`. */
export async function resolveCa(config: ReadonlyMap<string, string>): Promise<string | undefined> {
  const configuredCa = config.get('ca');
  if (configuredCa !== undefined && configuredCa !== '') {
    return normalizeCa(configuredCa);
  }

  const cafile = config.get('cafile');
  if (cafile === undefined || cafile === '') {
    return undefined;
  }
  return normalizeCa(await readFile(cafile, 'utf8'));
}

/** A `cafile` setting as an absolute path: `~/` against the home directory, anything else against `baseDirectory`. */
export function resolveCaFilePath(cafile: string, baseDirectory: string): string {
  if (cafile === '') {
    return cafile;
  }
  const homePattern = process.platform === 'win32' ? /^~[/\\]/ : /^~\//;
  return homePattern.test(cafile)
    ? path.resolve(homedir(), cafile.slice(2))
    : path.resolve(baseDirectory, cafile);
}

/** The certificate authorities in the `caFilePath` of a Yarn Modern config, resolved against the file's directory. */
export async function resolveYarnCa(config: { caFilePath: string; caFileBasePath: string }): Promise<string> {
  return normalizeCa(await readFile(path.resolve(config.caFileBasePath, config.caFilePath), 'utf8'));
}

/** The `strict-ssl` setting as a flag; undefined when it is unset or not a boolean spelling. */
export function parseStrictSsl(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.toLowerCase() === 'false' || value === '0') {
    return false;
  }
  if (value.toLowerCase() === 'true' || value === '1') {
    return true;
  }
  return undefined;
}

function normalizeCa(value: string): string {
  return value.replaceAll('\\n', '\n');
}