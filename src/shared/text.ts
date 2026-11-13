const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_8BIT = String.fromCharCode(0x9b);
// OSC (ESC ] ... BEL or ESC \), 7-bit CSI (ESC [ ...) and 8-bit CSI.
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ESC}(?:\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|\\[[0-?]*[ -/]*[@-~])|${CSI_8BIT}[0-?]*[ -/]*[@-~]`,
  'g',
);
const LINE_BREAK_PATTERN = /\r\n?|\u2028|\u2029/g;
const LINE_BREAK_RUN_PATTERN = /[\r\n\u2028\u2029]+/g;
const SPACING_CONTROL_PATTERN = /[\t\v\f]/g;
// C0 controls except tab, line feed, vertical tab and form feed; DEL and C1 controls.
const CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);

/** Longest inline text shown in a label, tooltip or message. */
export const INLINE_TEXT_MAX_LENGTH = 240;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

/** Strips ANSI escapes and control characters; line breaks become `\n` and tabs become spaces. */
export function sanitizeMultilineText(value: string): string {
  return stripAnsi(value)
    .replace(LINE_BREAK_PATTERN, '\n')
    .replace(SPACING_CONTROL_PATTERN, ' ')
    .replace(CONTROL_PATTERN, '');
}

/** Sanitizes text for a single-line surface: controls and each run of line breaks become spaces, then the text is cut to `maxLength`. */
export function sanitizeInlineText(value: string, maxLength = INLINE_TEXT_MAX_LENGTH): string {
  return stripAnsi(value)
    .replace(LINE_BREAK_RUN_PATTERN, ' ')
    .replace(SPACING_CONTROL_PATTERN, ' ')
    .replace(CONTROL_PATTERN, ' ')
    .slice(0, maxLength);
}

const REDACTED = '[REDACTED]';
const DEFAULT_GENERIC_VALUE_MIN_LENGTH = 16;
const UNCONDITIONAL_CREDENTIAL_KEYS = '_authToken|_auth|_password|password|passwd';
const GENERIC_CREDENTIAL_KEYS = 'token|api-key|api_key|apikey';
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9_-]{36}(?![A-Za-z0-9_-])/g;
const URL_AUTHORITY_PATTERN = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/]*)/g;

interface CredentialPatterns {
  readonly authorization: RegExp;
  readonly plain: readonly RegExp[];
  readonly quotedKey: readonly RegExp[];
}

const credentialPatternCache = new Map<number, CredentialPatterns>();

/** Unquoted value of at least `minLength` characters; trailing `)` and `]` stay outside the match. */
function unquotedValue(excluded: string, minLength: number): string {
  const character = `[^\\s${excluded}]`;
  return `${character}{${minLength - 1},}[^\\s${excluded})\\]]|${character}{${minLength},}`;
}

function credentialPatterns(genericMinLength: number): CredentialPatterns {
  const cached = credentialPatternCache.get(genericMinLength);
  if (cached !== undefined) {
    return cached;
  }
  const unconditionalValue = `("[^"]*"|'[^']*'|${unquotedValue('&;,}', 1)})`;
  const genericValue = `("[^"\\s]{${genericMinLength},}"|'[^'\\s]{${genericMinLength},}'|${unquotedValue('&;,}', genericMinLength)})`;
  const plain = (keys: string, value: string): RegExp => new RegExp(`(?<![A-Za-z0-9])(${keys})(\\s*[:=]\\s*)${value}`, 'gi');
  const quotedKey = (keys: string, value: string): RegExp => new RegExp(`(["'])(${keys})\\1(\\s*[:=]\\s*)${value}`, 'gi');
  const patterns: CredentialPatterns = {
    authorization: new RegExp(`(\\bAuthorization\\s*:\\s*)(Bearer|Basic)(\\s+)(${unquotedValue(',;', 1)})`, 'gi'),
    plain: [plain(UNCONDITIONAL_CREDENTIAL_KEYS, unconditionalValue), plain(GENERIC_CREDENTIAL_KEYS, genericValue)],
    quotedKey: [quotedKey(UNCONDITIONAL_CREDENTIAL_KEYS, unconditionalValue), quotedKey(GENERIC_CREDENTIAL_KEYS, genericValue)],
  };
  credentialPatternCache.set(genericMinLength, patterns);
  return patterns;
}

function maskValue(value: string): string {
  const quote = value[0] === '"' || value[0] === '\'' ? value[0] : '';
  return `${quote}${REDACTED}${quote}`;
}

function redactUrlUserInfo(text: string): string {
  return text.replace(URL_AUTHORITY_PATTERN, (match, prefix: string, authority: string) => {
    const atIndex = authority.lastIndexOf('@');
    const scheme = prefix.slice(0, -3).toLowerCase();
    const redactAnyUserInfo = scheme === 'http'
      || scheme === 'https'
      || scheme.endsWith('+http')
      || scheme.endsWith('+https');
    return atIndex !== -1 && (redactAnyUserInfo || authority.slice(0, atIndex).includes(':'))
      ? `${prefix}${authority.slice(atIndex + 1)}`
      : match;
  });
}

/**
 * Masks URL user info (any for http(s) URLs, `user:password` otherwise), Authorization values, credential assignments and npm tokens.
 * Generic keys (`token`, `api-key`) are masked only when the value has `genericMinLength` characters or more.
 */
export function redactCredentials(text: string, genericMinLength = DEFAULT_GENERIC_VALUE_MIN_LENGTH): string {
  const patterns = credentialPatterns(genericMinLength);
  let redacted = redactUrlUserInfo(text)
    .replace(patterns.authorization, (_match, label: string, scheme: string, space: string) => `${label}${scheme}${space}${REDACTED}`);
  for (const pattern of patterns.plain) {
    redacted = redacted.replace(pattern, (_match, key: string, separator: string, value: string) => `${key}${separator}${maskValue(value)}`);
  }
  for (const pattern of patterns.quotedKey) {
    redacted = redacted.replace(pattern, (_match, quote: string, key: string, separator: string, value: string) => `${quote}${key}${quote}${separator}${maskValue(value)}`);
  }
  return redacted.replace(NPM_TOKEN_PATTERN, REDACTED);
}