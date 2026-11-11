import * as assert from 'assert';
import * as vscode from 'vscode';
import { isAbsolute, relative, sep } from 'node:path';
import { canonicalizeForComparison } from './pathComparison';
import type { OpenedFixtureWorkspace } from './workspaceScope';
import { waitUntil } from './wait';

export const EXTENSION_ID = 'greentech-solutions.nestro';

export function requireExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'Extension should be registered');
  return extension;
}

interface ManifestCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
  readonly enablement?: string;
}

interface ManifestMenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface WorkspaceCapability {
  readonly supported: boolean;
  readonly description: string;
}

interface ExtensionManifest {
  readonly activationEvents: readonly string[];
  readonly capabilities: {
    readonly untrustedWorkspaces: WorkspaceCapability;
    readonly virtualWorkspaces: WorkspaceCapability;
  };
  readonly contributes: {
    readonly commands: readonly ManifestCommand[];
    readonly menus: {
      readonly commandPalette: readonly ManifestMenuEntry[];
      readonly 'view/title': readonly ManifestMenuEntry[];
      readonly 'view/item/context': readonly ManifestMenuEntry[];
    };
  };
  readonly extensionKind: readonly string[];
}

export function getManifest(): ExtensionManifest {
  return requireExtension().packageJSON as ExtensionManifest;
}

export function compileViewItemPattern(when: string): RegExp {
  const match = /viewItem\s*=~\s*\/(.*)\/([a-z]*)$/.exec(when);
  assert.ok(match, `Manifest entry does not contain a viewItem regex: ${when}`);
  return new RegExp(match[1] ?? '', match[2] ?? '');
}

export function isInside(parent: string, candidate: string): boolean {
  const relativePath = relative(canonicalizeForComparison(parent), canonicalizeForComparison(candidate));
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

export function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

export function requireOpen(opened: OpenedFixtureWorkspace | undefined): OpenedFixtureWorkspace {
  assert.ok(opened, 'Fixture workspace should have been opened in suiteSetup');
  return opened;
}

export async function findManifests(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/package.json'),
    '**/node_modules/**',
  );
  return uris
    .map(uri => toPosixRelative(folder.uri.fsPath, uri.fsPath))
    .sort((left, right) => left.localeCompare(right));
}

export async function waitForManifests(
  folder: vscode.WorkspaceFolder,
  expected: readonly string[],
): Promise<string[]> {
  let found: string[] = [];
  await waitUntil(
    async () => {
      found = await findManifests(folder);
      return found.length === expected.length;
    },
    `${expected.length} manifest(s) under workspace folder ${folder.uri.fsPath}`,
  );
  return found;
}