/** The text between a matching pair of single or double quotes, or undefined when `value` is not wrapped in one. */
export function unwrapQuotes(value: string): string | undefined {
  const first = value[0];
  if ((first === '"' || first === '\'') && value.at(-1) === first) {
    return value.slice(1, -1);
  }
  return undefined;
}