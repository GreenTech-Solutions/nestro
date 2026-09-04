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
        readonly 'nestro.minimumReleaseAgeDays': {
          readonly default: number;
          readonly minimum: number;
          readonly maximum: number;
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

  it('uses seven days by default and allows zero to disable release-age checks', () => {
    const setting = manifest.contributes.configuration.properties['nestro.minimumReleaseAgeDays'];
    expect(setting.default).toBe(7);
    expect(setting.minimum).toBe(0);
    expect(setting.maximum).toBe(99_000_000);
  });
});