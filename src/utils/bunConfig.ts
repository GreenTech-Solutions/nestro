import { parseInlineTable, parseTomlString } from './bunTomlValues';

export interface BunRegistryConfiguration {
  registryUrl: string;
  authToken: string | undefined;
  authIdent: string | undefined;
}

export interface ParsedBunConfig {
  registry: BunRegistryConfiguration | undefined;
  scopes: ReadonlyMap<string, BunRegistryConfiguration>;
}

type BunSection = 'install' | 'install.scopes' | 'other';

interface BunConfigState {
  section: BunSection | undefined;
  registry: BunRegistryConfiguration | undefined;
  registrySeen: boolean;
  scopes: Map<string, BunRegistryConfiguration>;
  seenScopes: Set<string>;
  seenSections: Set<string>;
}

const BUN_REGISTRY_KEYS = new Set(['registry']);

export function parseBunConfig(contents: string): ParsedBunConfig | undefined {
  if (contents.startsWith('\uFEFF')) {
    return undefined;
  }

  const state: BunConfigState = {
    section: undefined,
    registry: undefined,
    registrySeen: false,
    scopes: new Map(),
    seenScopes: new Set(),
    seenSections: new Set(),
  };
  for (const rawLine of contents.split(/\r?\n/)) {
    if (!processBunConfigLine(rawLine, state)) {
      return undefined;
    }
  }

  return { registry: state.registry, scopes: state.scopes };
}

function processBunConfigLine(rawLine: string, state: BunConfigState): boolean {
  const line = stripTomlComment(rawLine).trim();
  if (line === '') {
    return true;
  }
  if (line.startsWith('[')) {
    const nextSection = parseBunSection(line);
    if (nextSection === undefined || (nextSection !== 'other' && state.seenSections.has(nextSection))) {
      return false;
    }
    if (nextSection !== 'other') {
      state.seenSections.add(nextSection);
    }
    state.section = nextSection;
    return true;
  }
  if (state.section !== 'install' && state.section !== 'install.scopes') {
    return true;
  }

  const assignment = parseBunAssignment(line, state.section === 'install.scopes');
  if (assignment === undefined) {
    return false;
  }
  if (state.section === 'install') {
    if (!BUN_REGISTRY_KEYS.has(assignment.key)) {
      return true;
    }
    if (state.registrySeen) {
      return false;
    }
    state.registrySeen = true;
    const parsed = parseRegistryValue(assignment.value);
    if (parsed === undefined) {
      return false;
    }
    if (parsed !== null) {
      state.registry = parsed;
    }
    return true;
  }

  const scope = assignment.key.slice(1);
  if (!isValidScope(assignment.key) || state.seenScopes.has(scope)) {
    return false;
  }
  state.seenScopes.add(scope);
  const parsed = parseRegistryValue(assignment.value);
  if (parsed === undefined) {
    return false;
  }
  if (parsed !== null) {
    state.scopes.set(scope, parsed);
  }
  return true;
}

function parseBunSection(line: string): BunSection | undefined {
  if (line === '[install]') {
    return 'install';
  }
  if (line === '[install.scopes]') {
    return 'install.scopes';
  }
  return /^\[[^\[\]]+\]$/.test(line) ? 'other' : undefined;
}

function parseBunAssignment(
  line: string,
  scopeAssignment: boolean,
): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf('=');
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  if (value === '') {
    return undefined;
  }
  if (scopeAssignment) {
    const parsedKey = parseTomlString(key);
    return parsedKey === undefined || parsedKey.value === null || parsedKey.nextIndex !== key.length
      ? undefined
      : { key: parsedKey.value, value };
  }
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(key) ? { key, value } : undefined;
}

function parseRegistryValue(value: string): BunRegistryConfiguration | null | undefined {
  if (value.startsWith('{')) {
    const fields = parseInlineTable(value);
    if (fields === undefined) {
      return undefined;
    }
    const url = fields.get('url');
    const hasUsername = fields.has('username');
    const hasPassword = fields.has('password');
    if (url === undefined || (fields.has('token') && (hasUsername || hasPassword))) {
      return undefined;
    }
    if (hasUsername !== hasPassword) {
      return undefined;
    }
    return normalizeRegistryConfiguration(
      url,
      fields.get('token'),
      fields.get('username'),
      fields.get('password'),
    );
  }

  const parsed = parseTomlString(value);
  if (parsed === undefined || parsed.nextIndex !== value.length) {
    return undefined;
  }
  return parsed.value === null ? null : normalizeRegistryConfiguration(parsed.value);
}

function normalizeRegistryConfiguration(
  rawUrl: string,
  authToken?: string,
  username?: string,
  password?: string,
): BunRegistryConfiguration | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  }
  catch {
    return undefined;
  }

  const embeddedUsername = url.username;
  const embeddedPassword = url.password;
  if ((embeddedUsername === '') !== (embeddedPassword === '')
    || (authToken !== undefined && (username !== undefined || password !== undefined))
    || (authToken !== undefined && (embeddedUsername !== '' || embeddedPassword !== ''))
    || (username !== undefined && (embeddedUsername !== '' || embeddedPassword !== ''))) {
    return undefined;
  }

  let authIdent: string | undefined;
  if (username !== undefined && password !== undefined) {
    authIdent = `${username}:${password}`;
  }
  else if (embeddedUsername !== '' && embeddedPassword !== '') {
    try {
      authIdent = `${decodeURIComponent(embeddedUsername)}:${decodeURIComponent(embeddedPassword)}`;
    }
    catch {
      return undefined;
    }
  }

  url.username = '';
  url.password = '';
  return { registryUrl: url.toString(), authToken, authIdent };
}

function stripTomlComment(value: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    }
    else if (character === '\\' && quoted) {
      escaped = true;
    }
    else if (character === '"') {
      quoted = !quoted;
    }
    else if (character === '#' && !quoted) {
      return value.slice(0, index);
    }
  }
  return value;
}

function isValidScope(value: string): boolean {
  return /^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}