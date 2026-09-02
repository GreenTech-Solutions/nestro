import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  readonly contributes: {
    readonly configuration: {
      readonly properties: {
        readonly 'nestro.includePreReleases': {
          readonly default: boolean;
        };
      };
    };
  };
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

describe('extension configuration manifest', () => {
  it('keeps prerelease updates opt-in by default', () => {
    expect(manifest.contributes.configuration.properties['nestro.includePreReleases'].default).toBe(false);
  });
});