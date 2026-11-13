import { expandBunValue } from './envExpansion';

const BUN_REGISTRY_ENTRY_KEYS = new Set(['password', 'token', 'url', 'username']);

export function parseInlineTable(value: string): Map<string, string> | undefined {
  if (!value.endsWith('}') || value.length < 2) {
    return undefined;
  }

  const fields = new Map<string, string>();
  const seenKeys = new Set<string>();
  let unsetAuthField = false;
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
    if (!BUN_REGISTRY_ENTRY_KEYS.has(key) || seenKeys.has(key)) {
      return undefined;
    }
    seenKeys.add(key);
    index = skipWhitespace(value, index);
    if (value[index] !== '=') {
      return undefined;
    }
    const parsed = parseTomlString(value.slice(index + 1).trimStart());
    if (parsed === undefined) {
      return undefined;
    }
    if (parsed.value !== null) {
      fields.set(key, parsed.value);
    }
    else if (key === 'username' || key === 'password') {
      unsetAuthField = true;
    }
    index += 1 + value.slice(index + 1).length - value.slice(index + 1).trimStart().length + parsed.nextIndex;
    index = skipWhitespace(value, index);
    if (value[index] === '}') {
      if (index !== value.length - 1) {
        return undefined;
      }
      if (unsetAuthField) {
        fields.delete('username');
        fields.delete('password');
      }
      return fields;
    }
    if (value[index] !== ',') {
      return undefined;
    }
    index = skipWhitespace(value, index + 1);
  }
  return undefined;
}

export function parseTomlString(value: string): { value: string | null; nextIndex: number } | undefined {
  if (!value.startsWith('"')) {
    return undefined;
  }

  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      return { value: expandBunValue(result), nextIndex: index + 1 };
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

function skipWhitespace(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}