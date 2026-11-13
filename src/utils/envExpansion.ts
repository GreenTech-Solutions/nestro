/** What a format does with a required `${NAME}` reference whose variable is unset. */
type UnsetReference = 'keep' | 'reject';

export interface EnvSyntax {
  /** Global pattern; named groups `name` or `bareName`, plus optional `optional`, `operator`, `fallback` and `invalid`. */
  reference: RegExp;
  unset: UnsetReference;
}

/** `.npmrc`: `${NAME}` stays as written when unset, `${NAME?}` becomes empty. */
export const NPM_ENV_SYNTAX: EnvSyntax = {
  reference: /\$\{(?<name>[^${}?]+)(?<optional>\?)?\}/g,
  unset: 'keep',
};

/** Yarn Classic `.yarnrc`: `${NAME}` must be set. */
export const YARN_CLASSIC_ENV_SYNTAX: EnvSyntax = {
  reference: /\$\{(?<name>[^}]+)\}/g,
  unset: 'reject',
};

/** Yarn Modern `.yarnrc.yml`: `${NAME}`, `${NAME-fallback}` and `${NAME:-fallback}`; any other `${` is rejected. */
export const YARN_MODERN_ENV_SYNTAX: EnvSyntax = {
  reference: /\$\{(?<name>[A-Za-z]\w*)(?:(?<operator>:-|-)(?<fallback>[^${}]*))?\}|(?<invalid>\$\{)/g,
  unset: 'reject',
};

/** `bunfig.toml`: only a whole value `$NAME` expands; `null` when that variable is unset, anything else stays literal. */
export function expandBunValue(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const match = /^\$([A-Za-z_]\w*)$/.exec(value);
  const name = match?.[1];
  return name === undefined ? value : env[name] ?? null;
}

/** Expands the references `syntax` recognizes in `value`; undefined when one cannot be resolved. */
export function expandEnvironmentReferences(
  value: string,
  syntax: EnvSyntax,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let expanded = '';
  let consumed = 0;
  for (const match of value.matchAll(syntax.reference)) {
    const replacement = resolveReference(match[0], match.groups ?? {}, syntax, env);
    if (replacement === undefined) {
      return undefined;
    }
    expanded += value.slice(consumed, match.index) + replacement;
    consumed = match.index + match[0].length;
  }
  return expanded + value.slice(consumed);
}

function resolveReference(
  text: string,
  groups: Readonly<Record<string, string | undefined>>,
  syntax: EnvSyntax,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const name = groups.name ?? groups.bareName;
  if (groups.invalid !== undefined || name === undefined) {
    return undefined;
  }
  const current = env[name];
  if (groups.operator === ':-') {
    return current === undefined || current === '' ? groups.fallback : current;
  }
  if (groups.operator === '-') {
    return current ?? groups.fallback;
  }
  if (current !== undefined) {
    return current;
  }
  if (groups.optional !== undefined) {
    return '';
  }
  return syntax.unset === 'keep' ? text : undefined;
}