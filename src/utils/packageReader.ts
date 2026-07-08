import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from './logger';

export interface PackageEntry {
  name: string;
  current: string;
  dev: boolean;
  versionPrefix: string;
}

export interface PackageFileEntry extends PackageEntry {
  packageFilePath: string;
}

export type DependencySection = 'dependencies' | 'devDependencies';

export interface PackageVersionUpdate {
  name: string;
  version: string;
  section: DependencySection;
}

interface WorkspacePackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function getWorkspacePackageFilePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return undefined;
  }

  return vscode.Uri.joinPath(folder.uri, 'package.json').fsPath;
}

export function extractVersionPrefix(versionString: string): string {
  if (versionString.startsWith('workspace:')) {
    return '';
  }

  const match = /^([~^]|>=|>|<=|<)/.exec(versionString);
  return match?.[1] ?? '';
}

export async function updateWorkspaceDependencyVersions(updates: readonly PackageVersionUpdate[]): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error('No workspace folder found.');
  }

  await updateDependencyVersionsInFile(vscode.Uri.joinPath(folder.uri, 'package.json').fsPath, updates);
}

export async function updateDependencyVersionsInFile(
  packageFilePath: string,
  updates: readonly PackageVersionUpdate[],
): Promise<void> {
  const uri = vscode.Uri.file(packageFilePath);
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const json = JSON.parse(raw) as WorkspacePackageJson;
  const missing: string[] = [];

  for (const update of updates) {
    const dependencies = json[update.section];
    if (dependencies?.[update.name] !== undefined) {
      const current = dependencies[update.name];
      const prefix = extractVersionPrefix(current);
      dependencies[update.name] = `${prefix}${update.version}`;
      continue;
    }
    missing.push(`${update.name} (${update.section})`);
  }

  if (missing.length > 0) {
    throw new Error(`Package(s) not found in package.json: ${missing.join(', ')}`);
  }

  const indent = detectJsonIndent(raw);
  const newline = raw.endsWith('\n') ? '\n' : '';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(json, undefined, indent)}${newline}`));
}

export async function switchDependencyType(
  packageFilePath: string,
  packageName: string,
  currentlyDev: boolean,
): Promise<void> {
  const { json, raw, uri } = await readPackageJson(packageFilePath);
  const sourceKey = currentlyDev ? 'devDependencies' : 'dependencies';
  const targetKey = currentlyDev ? 'dependencies' : 'devDependencies';
  const source = json[sourceKey] ?? {};
  const version = source[packageName];
  if (version === undefined) {
    throw new Error(`Package ${packageName} not found in ${sourceKey}.`);
  }

  delete source[packageName];
  if (Object.keys(source).length === 0) {
    delete json[sourceKey];
  }
  else {
    json[sourceKey] = source;
  }

  json[targetKey] = sortDependencyMap({
    ...(json[targetKey] ?? {}),
    [packageName]: version,
  });

  const indent = detectJsonIndent(raw);
  const newline = raw.endsWith('\n') ? '\n' : '';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(json, undefined, indent)}${newline}`));
}

export async function setVersionPin(
  packageFilePath: string,
  packageName: string,
  pin: boolean,
): Promise<void> {
  const { json, raw, uri, location } = await readPackageJsonEntry(packageFilePath, packageName);
  json[location.section] = {
    ...(json[location.section] ?? {}),
    [packageName]: setPinnedVersion(location.version, pin),
  };
  await writePackageJson(uri, raw, json);
}

export async function pinAllWorkspaceDependencyVersions(): Promise<number> {
  const files = await findWorkspacePackageJsonFiles();
  let count = 0;
  for (const uri of files) {
    count += await pinAllVersionsInFile(uri.fsPath);
  }
  return count;
}

async function pinAllVersionsInFile(packageFilePath: string): Promise<number> {
  const { json, raw, uri } = await readPackageJson(packageFilePath);
  let count = 0;
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = json[section];
    if (deps === undefined) continue;
    for (const [name, version] of Object.entries(deps)) {
      const prefix = extractVersionPrefix(version);
      if (prefix === '^' || prefix === '~') {
        deps[name] = setPinnedVersion(version, true);
        count++;
      }
    }
  }
  if (count > 0) {
    await writePackageJson(uri, raw, json);
  }
  return count;
}

export async function readWorkspaceDependencies(): Promise<PackageEntry[]> {
  const entries = await readAllWorkspaceDependencies();
  return entries.map(({ name, current, dev, versionPrefix }) => ({ name, current, dev, versionPrefix }));
}

export async function readAllWorkspaceDependencies(glob?: string): Promise<PackageFileEntry[]> {
  const files = await findWorkspacePackageJsonFiles(glob);
  if (files.length === 0) {
    logger.info('No workspace package.json found.');
    return [];
  }

  const results: PackageFileEntry[] = [];
  for (const uri of files) {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(Buffer.from(raw).toString('utf8')) as WorkspacePackageJson;
      const packageFilePath = uri.fsPath;

      results.push(
        ...Object.entries(json.dependencies ?? {}).map(([name, current]) => ({
          name,
          current,
          dev: false,
          versionPrefix: extractVersionPrefix(current),
          packageFilePath,
        })),
        ...Object.entries(json.devDependencies ?? {}).map(([name, current]) => ({
          name,
          current,
          dev: true,
          versionPrefix: extractVersionPrefix(current),
          packageFilePath,
        })),
      );
    }
    catch (err) {
      logger.error(`Failed to read workspace package.json at ${uri.toString()}; skipping.`, err);
    }
  }
  return results;
}

export async function getWorkspacePackageFilePaths(glob?: string): Promise<string[]> {
  const files = await findWorkspacePackageJsonFiles(glob);
  return files.map(uri => uri.fsPath);
}

export function getPackageDirectory(packageFilePath: string): string {
  return path.dirname(packageFilePath);
}

async function findWorkspacePackageJsonFiles(glob?: string): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    logger.info('No workspace folder found.');
    return [];
  }

  const configuredGlob = glob ?? vscode.workspace
    .getConfiguration('nestro')
    .get<string>('monorepoGlob', '**/package.json');
  return await vscode.workspace.findFiles(configuredGlob, '**/node_modules/**');
}

function detectJsonIndent(raw: string): string {
  const match = raw.match(/^[ \t]+"[^"]+":/m);
  if (match === null) {
    return '  ';
  }
  return match[0].match(/^[ \t]+/)?.[0] ?? '  ';
}

async function readPackageJson(packageFilePath: string): Promise<{
  json: WorkspacePackageJson;
  raw: string;
  uri: vscode.Uri;
}> {
  const uri = vscode.Uri.file(packageFilePath);
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  return { json: JSON.parse(raw) as WorkspacePackageJson, raw, uri };
}

async function readPackageJsonEntry(
  packageFilePath: string,
  packageName: string,
): Promise<{
  json: WorkspacePackageJson;
  raw: string;
  uri: vscode.Uri;
  location: { section: DependencySection; version: string };
}> {
  const { json, raw, uri } = await readPackageJson(packageFilePath);
  const fromDependencies = json.dependencies?.[packageName];
  if (fromDependencies !== undefined) {
    return { json, raw, uri, location: { section: 'dependencies', version: fromDependencies } };
  }
  const fromDevDependencies = json.devDependencies?.[packageName];
  if (fromDevDependencies !== undefined) {
    return { json, raw, uri, location: { section: 'devDependencies', version: fromDevDependencies } };
  }
  throw new Error(`Package ${packageName} not found in package.json.`);
}

async function writePackageJson(uri: vscode.Uri, raw: string, json: WorkspacePackageJson): Promise<void> {
  const indent = detectJsonIndent(raw);
  const newline = raw.endsWith('\n') ? '\n' : '';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(json, undefined, indent)}${newline}`));
}

function setPinnedVersion(version: string, pin: boolean): string {
  const workspacePrefix = version.startsWith('workspace:') ? 'workspace:' : '';
  const remainder = workspacePrefix === '' ? version : version.slice(workspacePrefix.length);
  const versionPrefix = extractVersionPrefix(remainder);
  const normalized = remainder.slice(versionPrefix.length);
  return pin ? `${workspacePrefix}${normalized}` : `${workspacePrefix}^${normalized}`;
}

function sortDependencyMap(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
}
