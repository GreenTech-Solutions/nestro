import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_IDS, CONTEXT_KEYS, CONTEXT_VALUE_TOKENS, VIEW_IDS } from '../shared';

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly enablement?: string }[];
    readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
    readonly views: Readonly<Record<string, readonly { readonly id: string; readonly when?: string }[]>>;
    readonly viewsContainers: { readonly activitybar: readonly { readonly id: string }[] };
    readonly viewsWelcome: readonly { readonly view: string; readonly when?: string }[];
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as ExtensionManifest;

const commandIds: readonly string[] = Object.values(COMMAND_IDS);
const contextKeys: readonly string[] = Object.values(CONTEXT_KEYS);
const viewIds: readonly string[] = Object.values(VIEW_IDS);
const tokens: readonly string[] = Object.values(CONTEXT_VALUE_TOKENS);

// Commands the Command Palette lists with no override entry in `menus.commandPalette`.
const PALETTE_VISIBLE_BY_DEFAULT: readonly string[] = [
  COMMAND_IDS.refresh,
  COMMAND_IDS.checkUpdates,
  COMMAND_IDS.openAuditReport,
  COMMAND_IDS.openStatusReport,
  COMMAND_IDS.openSettings,
];

// Published through `setContext` for users' `when` clauses; no manifest entry reads them.
const CONTEXT_KEYS_WITHOUT_MANIFEST_READER: readonly string[] = [
  CONTEXT_KEYS.hasPackageFiles,
  CONTEXT_KEYS.hasReadablePackageFiles,
  CONTEXT_KEYS.hasDependencyEntries,
  CONTEXT_KEYS.hasAuditableProjects,
];

// Row-state tokens the manifest does not match through a `viewItem` regex.
const TOKENS_WITHOUT_MANIFEST_MATCHER: readonly string[] = [
  CONTEXT_VALUE_TOKENS.pinUnsupported,
  CONTEXT_VALUE_TOKENS.vulnerable,
  CONTEXT_VALUE_TOKENS.group,
  CONTEXT_VALUE_TOKENS.detail,
  CONTEXT_VALUE_TOKENS.status,
  CONTEXT_VALUE_TOKENS.statusSearchActive,
  CONTEXT_VALUE_TOKENS.workspaceFolder,
];

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  return left.filter(value => !right.includes(value)).sort((a, b) => a.localeCompare(b));
}

function collectWhenClauses(): string[] {
  const { commands, menus, views, viewsWelcome } = manifest.contributes;
  return [
    ...commands.flatMap(entry => entry.enablement ?? []),
    ...Object.values(menus).flatMap(entries => entries.flatMap(entry => entry.when ?? [])),
    ...Object.values(views).flatMap(entries => entries.flatMap(entry => entry.when ?? [])),
    ...viewsWelcome.flatMap(entry => entry.when ?? []),
  ];
}

function collectNestroNames(clauses: readonly string[]): string[] {
  return unique(clauses.flatMap(clause => clause.match(/\bnestro\.[A-Za-z]+/g) ?? []));
}

function collectViewItemWords(clauses: readonly string[]): string[] {
  const patterns = clauses.flatMap(clause => [...clause.matchAll(/viewItem\s*=~\s*\/(.*?)\/[a-z]*(?:\s*(?:&&|\|\|)|$)/g)].map(match => match[1]));
  return unique(patterns.flatMap(pattern => pattern.match(/[A-Za-z][A-Za-z-]*/g) ?? []));
}

describe('id registry shape', () => {
  it('keeps every id value unique within its registry and under the nestro namespace', () => {
    for (const registry of [commandIds, contextKeys, tokens]) {
      expect(unique(registry)).toHaveLength(registry.length);
    }
    for (const id of [...commandIds, ...contextKeys, VIEW_IDS.packages]) {
      expect(id.startsWith('nestro.')).toBe(true);
    }
  });
});

describe('command ids against the manifest', () => {
  const contributed = manifest.contributes.commands.map(entry => entry.command);

  it('has a contributes.commands entry for every COMMAND_IDS value', () => {
    expect(difference(commandIds, contributed), 'declared in src/shared/ids.ts but missing from package.json contributes.commands').toEqual([]);
  });

  it('has a COMMAND_IDS value for every contributes.commands entry', () => {
    expect(difference(contributed, commandIds), 'contributed in package.json but missing from COMMAND_IDS in src/shared/ids.ts').toEqual([]);
  });

  it('only references known commands from menus', () => {
    const referenced = unique(Object.values(manifest.contributes.menus).flatMap(entries => entries.map(entry => entry.command)));
    expect(difference(referenced, commandIds), 'menu entries naming a command that is not in COMMAND_IDS').toEqual([]);
  });

  it('gives every command a commandPalette override or lists it as palette-visible', () => {
    const overridden = manifest.contributes.menus.commandPalette.map(entry => entry.command);
    const unclassified = difference(commandIds, [...overridden, ...PALETTE_VISIBLE_BY_DEFAULT]);
    expect(unclassified, 'add a commandPalette entry (when "false" hides it) or list the command in PALETTE_VISIBLE_BY_DEFAULT').toEqual([]);
    expect(PALETTE_VISIBLE_BY_DEFAULT.filter(id => overridden.includes(id)), 'listed as palette-visible but also overridden').toEqual([]);
  });

  it('registers every command id in activate()', () => {
    const source = readFileSync(join(root, 'src/extension.ts'), 'utf8');
    const registered = [...source.matchAll(/registerCommand\(COMMAND_IDS\.(\w+)/g)].map(match => match[1]);
    expect(difference(Object.keys(COMMAND_IDS), registered), 'in COMMAND_IDS but not registered in src/extension.ts').toEqual([]);
    expect(difference(registered, Object.keys(COMMAND_IDS))).toEqual([]);
  });
});

describe('view ids against the manifest', () => {
  it('contributes the packages view under the view container', () => {
    expect(manifest.contributes.viewsContainers.activitybar.map(entry => entry.id)).toContain(VIEW_IDS.container);
    expect(manifest.contributes.views[VIEW_IDS.container]?.map(entry => entry.id)).toEqual([VIEW_IDS.packages]);
  });

  it('points every welcome entry at the packages view', () => {
    expect(unique(manifest.contributes.viewsWelcome.map(entry => entry.view))).toEqual([VIEW_IDS.packages]);
  });
});

describe('context keys against the manifest', () => {
  const referenced = difference(collectNestroNames(collectWhenClauses()), viewIds);

  it('reads only declared context keys in when and enablement clauses', () => {
    expect(difference(referenced, contextKeys), 'manifest clause reads a context key missing from CONTEXT_KEYS').toEqual([]);
  });

  it('reads every declared context key, except the listed ones', () => {
    expect(difference(contextKeys, [...referenced, ...CONTEXT_KEYS_WITHOUT_MANIFEST_READER]), 'published key no clause reads: use it or remove it').toEqual([]);
    expect(CONTEXT_KEYS_WITHOUT_MANIFEST_READER.filter(key => referenced.includes(key)), 'listed as unread but a clause reads it').toEqual([]);
  });
});

describe('context value tokens against the manifest', () => {
  const words = collectViewItemWords(collectWhenClauses());

  it('matches only declared tokens in viewItem patterns', () => {
    expect(difference(words, tokens), 'viewItem pattern names a token missing from CONTEXT_VALUE_TOKENS').toEqual([]);
  });

  it('matches every declared token, except the listed ones', () => {
    expect(difference(tokens, [...words, ...TOKENS_WITHOUT_MANIFEST_MATCHER]), 'token no viewItem pattern matches: use it or remove it').toEqual([]);
    expect(TOKENS_WITHOUT_MANIFEST_MATCHER.filter(token => words.includes(token)), 'listed as unmatched but a pattern matches it').toEqual([]);
  });
});

describe('screenshot driver', () => {
  it('names no nestro id literally; it reads them from the manifest', () => {
    const driver = readFileSync(join(root, 'scripts/screenshots/driver.cjs'), 'utf8');
    expect(driver).not.toMatch(/['"`]nestro[.'"`]/);
  });
});