import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveYarnFamily } from '../utils/yarnFamily';
import { isRecord } from '../shared';
import type { PackageManager } from '../shared';

const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

/** True when `directory` is a workspace root where its manager refuses `add` without the root flag. */
export async function isWorkspaceRoot(packageManager: PackageManager, directory: string): Promise<boolean> {
  if (packageManager === 'pnpm') {
    const contents = await readFileOrUndefined(path.join(directory, PNPM_WORKSPACE_FILE));
    return contents !== undefined && countWorkspacePatterns(contents) > 1;
  }
  if (packageManager === 'yarn') {
    return await declaresWorkspaces(directory) && (await resolveYarnFamily(directory)).family === 'classic';
  }
  return false;
}

async function declaresWorkspaces(directory: string): Promise<boolean> {
  const contents = await readFileOrUndefined(path.join(directory, 'package.json'));
  if (contents === undefined) {
    return false;
  }
  try {
    const manifest = JSON.parse(contents) as unknown;
    if (!isRecord(manifest)) {
      return false;
    }
    const { workspaces } = manifest;
    return Array.isArray(workspaces) || (isRecord(workspaces) && Array.isArray(workspaces.packages));
  }
  catch {
    return false;
  }
}

/** Counts the `packages` globs of a `pnpm-workspace.yaml`; pnpm refuses a root `add` only past one. */
function countWorkspacePatterns(yaml: string): number {
  const lines = yaml.split(/\r?\n/).map(line => line.split('#')[0]);
  const start = lines.findIndex(line => /^packages\s*:/.test(line));
  if (start < 0) {
    return 0;
  }
  const flow = lines.slice(start).join('\n').split(':').slice(1).join(':').trimStart();
  if (flow.startsWith('[')) {
    return countFlowItems(flow.slice(1, flow.indexOf(']')));
  }
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s-]/.test(line)) {
      break;
    }
    if (/^\s*-\s+\S/.test(line)) {
      count++;
    }
  }
  return count;
}

function countFlowItems(list: string): number {
  let depth = 0;
  let count = 0;
  let hasItem = false;
  for (const char of list) {
    if (char === '{') {
      depth++;
    }
    else if (char === '}') {
      depth--;
    }
    if (char === ',' && depth === 0) {
      count += hasItem ? 1 : 0;
      hasItem = false;
    }
    else if (char.trim() !== '') {
      hasItem = true;
    }
  }
  return count + (hasItem ? 1 : 0);
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString('utf8');
  }
  catch {
    return undefined;
  }
}