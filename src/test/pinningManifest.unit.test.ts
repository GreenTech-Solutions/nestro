import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ContextMenuContribution {
  readonly command: string;
  readonly when: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly menus: {
      readonly 'view/item/context': readonly ContextMenuContribution[];
    };
  };
}

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

describe('pin command manifest capability', () => {
  it('shows pin actions only for rows carrying the pinnable capability', () => {
    const pinEntries = manifest.contributes.menus['view/item/context']
      .filter(entry => entry.command === 'nestro.pinVersion');

    expect(pinEntries).toHaveLength(2);
    for (const entry of pinEntries) {
      expect(entry.when).toContain('viewItem =~ /(^|-)pinnable($|-)/');
      expect(entry.when).not.toContain('viewItem =~ /^(package|outdated)/');
    }
  });

  it('keeps update actions visible when outdated rows carry capability suffixes', () => {
    const updateEntries = manifest.contributes.menus['view/item/context']
      .filter(entry => entry.command === 'nestro.installUpdate');

    expect(updateEntries).toHaveLength(1);
    expect(updateEntries[0]?.when).toContain('viewItem =~ /(^|-)outdated($|-)/');
    expect(updateEntries[0]?.when).not.toContain('viewItem == outdated');
  });
});