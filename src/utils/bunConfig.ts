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

const BUN_ENVIRONMENT_VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const BUN_REGISTRY_KEYS = new Set(['registry']);
const BUN_REGISTRY_ENTRY_KEYS = new Set(['password', 'token', 'url', 'username']);

export function parseBunConfig(contents: string): ParsedBunConfig | undefined {
  if (contents.startsWith('\uFEFF')) {
    return undefined;
  }

  let section: BunSection | undefined;
  let registry: BunRegistryConfiguration | undefined;
  const scopes = new Map<string, BunRegistryConfiguration>();
  const seenSections = new Set<string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('[')) {
      const nextSection = parseBunSection(line);
      if (nextSection === undefined) {
        return undefined;
      }
      if (nextSection !== 'other') {
        if (seenSections.has(nextSection)) {
          return undefined;
        }
        seenSections.add(nextSection);
      }
      section = nextSection;
      continue;
    }
    if (section !== 'install' && section !== 'install.scopes') {
      continue;
    }

    const assignment = parseBunAssignment(line, section === 'install.scopes');
    if (assignment === undefined) {
      return undefined;
    }
    if (section === 'install') {
      if (!BUN_REGISTRY_KEYS.has(assignment.key)) {
        continue;
      }
      if (registry !== undefined) {
        return undefined;
      }
      const parsed = parseRegistryValue(assignment.value);
      if (parsed === undefined) {
        return undefined;
      }
      registry = parsed;
    }
    else {
      const scope = assignment.key.slice(1);
      if (!isValidScope(assignment.key) || scopes.has(scope)) {
        return undefined;
      }
      const parsed = parseRegistryValue(assignment.value);
      if (parsed === undefined) {
        return undefined;
      }
      scopes.set(scope, parsed);
    }
  }

  return { registry, scopes };
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
    return parsedKey === undefined || parsedKey.nextIndex !== key.length
      ? undefined
      : { key: parsedKey.value, value };
  }
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(key) ? { key, value } : undefined;
}

function parseRegistryValue(value: string): BunRegistryConfiguration | undefined {
  if (value.startsWith('{')) {
    const fields = parseInlineTable(value);
    if (fields === undefined) {
      return undefined;
    }
    const url = fields.get('url');
    if (url === undefined || fields.has('token') === (fields.has('username') || fields.has('password'))) {
      return undefined;
    }
    if (fields.has('username') !== fields.has('password')) {
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
  return parsed === undefined || parsed.nextIndex !== value.length
    ? undefined
    : normalizeRegistryConfiguration(parsed.value);
}

function parseInlineTable(value: string): Map<string, string> | undefined {
  if (!value.endsWith('}') || value.length < 2) {
    return undefined;
  }

  const fields = new Map<string, string>();
  let index = skipWhitespace(value, 1);
  if (value[index] === '}') {
    return undefined;
  }
  while (index < value.length - 1) {
    const keyStart = index;
    while (index < value.length && /[A-Za-z]/.test(value[index] ?? '')) {
      index += 1;
    }
    const key = value.slice(keyStart, index);
    if (!BUN_REGISTRY_ENTRY_KEYS.has(key) || fields.has(key)) {
      return undefined;
    }
    index = skipWhitespace(value, index);
    if (value[index] !== '=') {
      return undefined;
    }
    const parsed = parseTomlString(value.slice(index + 1).trimStart());
    if (parsed === undefined) {
      return undefined;
    }
    fields.set(key, parsed.value);
    index += 1 + value.slice(index + 1).length - value.slice(index + 1).trimStart().length + parsed.nextIndex;
    index = skipWhitespace(value, index);
    if (value[index] === '}') {
      return index === value.length - 1 ? fields : undefined;
    }
    if (value[index] !== ',') {
      return undefined;
    }
    index = skipWhitespace(value, index + 1);
  }
  return undefined;
}

function parseTomlString(value: string): { value: string; nextIndex: number } | undefined {
  if (!value.startsWith('"')) {
    return undefined;
  }

  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      const expanded = expandEnvironmentVariables(result);
      return expanded === undefined ? undefined : { value: expanded, nextIndex: index + 1 };
    }
    if (character === '\\') {
      const escaped = value[index + 1];
      const replacement = getTomlEscape(escaped);
      if (replacement === undefined) {
        return undefined;
      }
      result += replacement;
      index += 1;
    }
    else if (character === '\n' || character === '\r' || character.charCodeAt(0) < 0x20) {
      return undefined;
    }
    else {
      result += character;
    }
  }
  return undefined;
}

function getTomlEscape(value: string | undefined): string | undefined {
  switch (value) {
    case '"':
      return '"';
    case '\\':
      return '\\';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return undefined;
  }
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

function expandEnvironmentVariables(value: string): string | undefined {
  let unresolved = false;
  const expanded = value.replace(BUN_ENVIRONMENT_VARIABLE, (match, bracedName: string | undefined, plainName: string | undefined) => {
    const variable = bracedName ?? plainName;
    if (variable === undefined) {
      unresolved = true;
      return match;
    }
    const environmentValue = process.env[variable];
    if (environmentValue === undefined) {
      unresolved = true;
      return match;
    }
    return environmentValue;
  });
  return unresolved ? undefined : expanded;
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

function skipWhitespace(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}

function isValidScope(value: string): boolean {
  return /^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}