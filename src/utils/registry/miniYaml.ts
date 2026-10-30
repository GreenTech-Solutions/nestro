import { substituteEnvironmentVariables, unwrapQuotes } from './configValues';

export interface RawYamlLine {
  indent: number;
  content: string;
}

/** The content lines of a YAML document with comments and blank lines removed; undefined when indentation uses tabs. */
export function readYamlLines(contents: string): RawYamlLine[] | undefined {
  const lines: RawYamlLine[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^( *)\S/.exec(rawLine);
    if (match === null || rawLine.slice(0, match[1].length).includes('\t')) {
      return undefined;
    }
    const content = stripYamlComment(rawLine.slice(match[1].length));
    if (content.trim() !== '') {
      lines.push({ indent: match[1].length, content });
    }
  }
  return lines;
}

/** Splits a `key: value` line; undefined when the key is not a plain identifier. */
export function parseYamlEntry(content: string): { key: string; value: string } | undefined {
  const separatorIndex = content.indexOf(':');
  if (separatorIndex <= 0) {
    return undefined;
  }
  const key = content.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    return undefined;
  }
  return { key, value: content.slice(separatorIndex + 1).trim() };
}

/** The index of the first line after `startIndex` that is not nested deeper than `parentIndent`. */
export function skipYamlBlock(lines: readonly RawYamlLine[], startIndex: number, parentIndent: number): number {
  let index = startIndex;
  while (index < lines.length && lines[index].indent > parentIndent) {
    index += 1;
  }
  return index;
}

/** A boolean or an environment-expanded string; undefined for null, collections, anchors and block scalars. */
export function parseYamlScalar(value: string): string | boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === '' || trimmed === 'null' || trimmed === '~'
    || trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('&')
    || trimmed.startsWith('*') || trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return undefined;
  }
  const unwrapped = unwrapQuotes(trimmed);
  if (unwrapped !== undefined) {
    return substituteEnvironmentVariables(unwrapped);
  }
  if (trimmed.startsWith('"') || trimmed.startsWith('\'') || trimmed.includes(' {')) {
    return undefined;
  }
  return substituteEnvironmentVariables(trimmed);
}

/** A single-line flow mapping (`{ a: b, c: { d: e } }`); undefined when it is malformed or has trailing text. */
export function parseYamlFlowMap(value: string): Record<string, unknown> | undefined {
  const parsed = readYamlFlowMap(value, 0);
  if (parsed === undefined) {
    return undefined;
  }
  return skipYamlWhitespace(value, parsed.nextIndex) === value.length ? parsed.value : undefined;
}

function stripYamlComment(value: string): string {
  let quote: '"' | '\'' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      quote = undefined;
    }
    else if ((character === '"' || character === '\'') && quote === undefined) {
      quote = character;
    }
    else if (character === '#' && quote === undefined
      && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function readYamlFlowMap(
  value: string,
  startIndex: number,
): { value: Record<string, unknown>; nextIndex: number } | undefined {
  let index = skipYamlWhitespace(value, startIndex);
  if (value[index] !== '{') {
    return undefined;
  }
  index = skipYamlWhitespace(value, index + 1);
  const result: Record<string, unknown> = {};
  if (value[index] === '}') {
    return { value: result, nextIndex: index + 1 };
  }
  while (index < value.length) {
    const keyStart = index;
    while (index < value.length && /[A-Za-z0-9_@.-]/.test(value[index] ?? '')) {
      index += 1;
    }
    const key = value.slice(keyStart, index);
    if (key === '' || Object.hasOwn(result, key)) {
      return undefined;
    }
    index = skipYamlWhitespace(value, index);
    if (value[index] !== ':') {
      return undefined;
    }
    const parsedValue = readYamlFlowValue(value, index + 1);
    if (parsedValue === undefined) {
      return undefined;
    }
    result[key] = parsedValue.value;
    index = skipYamlWhitespace(value, parsedValue.nextIndex);
    if (value[index] === '}') {
      return { value: result, nextIndex: index + 1 };
    }
    if (value[index] !== ',') {
      return undefined;
    }
    index = skipYamlWhitespace(value, index + 1);
  }
  return undefined;
}

function readYamlFlowValue(
  value: string,
  startIndex: number,
): { value: unknown; nextIndex: number } | undefined {
  const index = skipYamlWhitespace(value, startIndex);
  if (value[index] === '{') {
    return readYamlFlowMap(value, index);
  }
  const first = value[index];
  if (first === '"' || first === '\'') {
    let end = index + 1;
    while (end < value.length && value[end] !== first) {
      end += 1;
    }
    if (end >= value.length) {
      return undefined;
    }
    return {
      value: substituteEnvironmentVariables(value.slice(index + 1, end)),
      nextIndex: end + 1,
    };
  }
  let end = index;
  while (end < value.length && value[end] !== ',' && value[end] !== '}') {
    end += 1;
  }
  const scalar = parseYamlScalar(value.slice(index, end));
  return scalar === undefined ? undefined : { value: scalar, nextIndex: end };
}

function skipYamlWhitespace(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}