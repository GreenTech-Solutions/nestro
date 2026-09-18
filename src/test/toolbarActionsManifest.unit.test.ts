import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ViewTitleMenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group: string;
}

interface ManifestCommand {
  readonly command: string;
  readonly enablement?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly commands: readonly ManifestCommand[];
    readonly menus: {
      readonly 'view/title': readonly ViewTitleMenuEntry[];
    };
  };
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
const toolbarEntries = manifest.contributes.menus['view/title'];
const commandsById = new Map(manifest.contributes.commands.map(entry => [entry.command, entry]));

function isNavigationGroup(group: string): boolean {
  return group === 'navigation' || group.startsWith('navigation@');
}

describe('toolbar action manifest', () => {
  it('keeps the exact ordered list of view/title entries', () => {
    const view = 'view == nestro.packagesView';
    expect(toolbarEntries.map(entry => [entry.command, entry.group, entry.when])).toEqual([
      ['nestro.refresh', 'navigation@1', view],
      ['nestro.checkUpdates', 'navigation@2', view],
      ['nestro.updateAllVisible', 'navigation@3', `${view} && nestro.canUpdateVisiblePackages`],
      ['nestro.searchPackages', '1_find@1', `${view} && nestro.canSearchPackages`],
      ['nestro.showFilterPicker', '1_find@2', `${view} && nestro.canFilterPackages`],
      ['nestro.clearSearchQuery', '1_find@3', `${view} && nestro.hasSearchQuery`],
      ['nestro.runInstall', '2_operations@1', `${view} && nestro.canRunInstall`],
      ['nestro.runAudit', '2_operations@2', `${view} && nestro.canRunAudit`],
      ['nestro.pinAllVersions', '2_operations@3', `${view} && nestro.canPinAllVersions`],
      ['nestro.openSettings', '9_settings@1', view],
    ]);
  });

  it('keeps exactly three primary navigation entries, in the required order', () => {
    const navigationEntries = toolbarEntries.filter(entry => isNavigationGroup(entry.group));
    expect(navigationEntries.map(entry => entry.command)).toEqual([
      'nestro.refresh',
      'nestro.checkUpdates',
      'nestro.updateAllVisible',
    ]);
  });

  it('keeps every non-navigation entry in an overflow group', () => {
    const overflowEntries = toolbarEntries.filter(entry => !isNavigationGroup(entry.group));
    expect(overflowEntries).toHaveLength(toolbarEntries.length - 3);
    for (const entry of overflowEntries) {
      expect(entry.group).not.toBe('navigation');
      expect(entry.group.startsWith('navigation')).toBe(false);
    }
  });

  it('gives every entry a when clause scoped to the packages view', () => {
    for (const entry of toolbarEntries) {
      expect(entry.when.startsWith('view == nestro.packagesView')).toBe(true);
    }
  });

  it('never contributes the same command twice', () => {
    const commandIds = toolbarEntries.map(entry => entry.command);
    expect(new Set(commandIds).size).toBe(commandIds.length);
  });

  it('only contributes commands that exist in contributes.commands', () => {
    for (const entry of toolbarEntries) {
      expect(commandsById.has(entry.command)).toBe(true);
    }
  });

  it('matches each capability-gated entry\'s when clause to its command enablement', () => {
    for (const entry of toolbarEntries) {
      const command = commandsById.get(entry.command);
      if (command?.enablement === undefined) {
        continue;
      }
      expect(entry.when).toBe(`view == nestro.packagesView && ${command.enablement}`);
    }
  });

  // VS Code checks a command's enablement precondition on a TreeItem.command click too, so a
  // row bound to a command with enablement can render clickable while the click itself no-ops.
  // StatusItem is the only tree item that sets this.command, for exactly these three commands.
  it('carries no enablement on any command a status row binds through TreeItem.command', () => {
    const rowBoundCommandIds = ['nestro.openStatusReport', 'nestro.showFilterPicker', 'nestro.searchPackages'];
    for (const commandId of rowBoundCommandIds) {
      const command = commandsById.get(commandId);
      expect(command, `${commandId} should be a contributed command`).toBeDefined();
      expect(
        command?.enablement,
        `${commandId} must carry no enablement — a status row binds it through TreeItem.command`,
      ).toBeUndefined();
    }
  });
});