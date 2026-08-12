import * as assert from 'node:assert';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'greentech-solutions.nestro';

function isStrictlyInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

/** Entry point loaded by the dedicated smoke-driver extension. */
export async function run(): Promise<void> {
  const isolatedExtensionsDir = process.env.NESTRO_PACKAGED_EXTENSIONS_DIR;
  assert.ok(isolatedExtensionsDir, 'NESTRO_PACKAGED_EXTENSIONS_DIR is required');
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Installed extension ${EXTENSION_ID} must be registered`);
  const canonicalRoot = realpathSync(isolatedExtensionsDir);
  const canonicalExtensionPath = realpathSync(extension.extensionPath);
  assert.ok(
    isStrictlyInside(canonicalRoot, canonicalExtensionPath),
    `Packaged extension path ${canonicalExtensionPath} must be inside isolated install root ${canonicalRoot}`,
  );
  assert.strictEqual(extension.extensionPath.includes('node_modules'), false, 'Packaged extension must not load from dependencies');
  await extension.activate();
  assert.strictEqual(extension.isActive, true, 'Packaged extension must activate successfully');
}