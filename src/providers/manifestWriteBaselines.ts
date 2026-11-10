import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

export class ManifestWriteBaselines {
  private readonly digests = new Map<string, string>();

  async capture(packageFilePaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const digests = await Promise.all(packageFilePaths.map(async (packageFilePath) => {
      const filePath = path.resolve(packageFilePath);
      try {
        return [filePath, digestManifest(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)))] as const;
      }
      catch {
        return [filePath, undefined] as const;
      }
    }));

    return new Map(digests.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  }

  async recordChanges(
    packageFilePaths: readonly string[],
    before: ReadonlyMap<string, string>,
  ): Promise<void> {
    await Promise.all(packageFilePaths.map(async (packageFilePath) => {
      const filePath = path.resolve(packageFilePath);
      try {
        const digest = digestManifest(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)));
        if (before.get(filePath) !== digest) {
          this.digests.set(filePath, digest);
        }
      }
      catch {
        this.digests.delete(filePath);
      }
    }));
  }

  async isOwnWrite(uri: vscode.Uri): Promise<boolean> {
    const filePath = path.resolve(uri.fsPath);
    const expectedDigest = this.digests.get(filePath);
    if (expectedDigest === undefined) {
      return false;
    }

    try {
      const actualDigest = digestManifest(await vscode.workspace.fs.readFile(uri));
      if (actualDigest === expectedDigest) {
        return true;
      }
    }
    catch {
      if (this.digests.get(filePath) === expectedDigest) {
        this.digests.delete(filePath);
      }
      return false;
    }

    if (this.digests.get(filePath) === expectedDigest) {
      this.digests.delete(filePath);
    }
    return false;
  }

  clear(): void {
    this.digests.clear();
  }
}

function digestManifest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}