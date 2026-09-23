import * as vscode from 'vscode';

const ESCAPE_CHARACTER = String.fromCharCode(0x1b);
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`(?:${ESCAPE_CHARACTER}\][^${String.fromCharCode(0x07)}]*(?:${String.fromCharCode(0x07)}|${ESCAPE_CHARACTER}\\)|${ESCAPE_CHARACTER}\[[0-?]*[ -/]*[@-~]|${String.fromCharCode(0x9b)}[0-?]*[ -/]*[@-~])`, 'g');
const URL_SEPARATOR = '://';
const AUTHORIZATION_PATTERN = /(\bAuthorization\s*:\s*)(Bearer|Basic)(\s+)([^\s,;]+)/gi;
const UNCONDITIONAL_CREDENTIAL_KEYS = '_authToken|_auth|_password';
const GENERIC_CREDENTIAL_KEYS = 'token|api-key|api_key|apikey';
const CREDENTIAL_VALUE = `("[^"]*"|'[^']*'|[^\\s&;,}]+)`;
const SECRET_CREDENTIAL_VALUE = `("[^"\\s]{16,}"|'[^'\\s]{16,}'|[^\\s&;,}]{16,})`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(`(?<![A-Za-z0-9])(${UNCONDITIONAL_CREDENTIAL_KEYS})(\\s*[:=]\\s*)${CREDENTIAL_VALUE}`, 'gi');
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(`(?<![A-Za-z0-9])(${GENERIC_CREDENTIAL_KEYS})(\\s*[:=]\\s*)${SECRET_CREDENTIAL_VALUE}`, 'gi');
const QUOTED_CREDENTIAL_KEY_PATTERN = new RegExp(`(["\\'])(${UNCONDITIONAL_CREDENTIAL_KEYS})\\1(\\s*[:=]\\s*)${CREDENTIAL_VALUE}`, 'gi');
const QUOTED_GENERIC_CREDENTIAL_KEY_PATTERN = new RegExp(`(["\\'])(${GENERIC_CREDENTIAL_KEYS})\\1(\\s*[:=]\\s*)${SECRET_CREDENTIAL_VALUE}`, 'gi');
const NPM_TOKEN_PATTERN = new RegExp('\\bnpm_[A-Za-z0-9_-]{36}(?![A-Za-z0-9_-])', 'g');
const CONTINUATION_PREFIX = '↳ ';

class Logger implements vscode.Disposable {
  private readonly outputChannel = vscode.window.createOutputChannel('Nestro', { log: true });

  info(message: string): void {
    this.outputChannel.info(sanitizeLogText(message));
  }

  warn(message: string): void {
    this.outputChannel.warn(sanitizeLogText(message));
  }

  debug(message: string): void {
    this.outputChannel.debug(sanitizeLogText(message));
  }

  error(message: string, err?: unknown): void {
    this.outputChannel.error(sanitizeLogText(message));
    if (err !== undefined) {
      this.outputChannel.error(sanitizeLogText(formatError(err)));
    }
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export const logger = new Logger();

export function sanitizeLogText(message: string): string {
  const withoutControls = Array.from(message
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(ANSI_ESCAPE_PATTERN, ''))
    .filter((character) => {
      const codePoint = character.charCodeAt(0);
      return (codePoint > 0x1f || codePoint === 0x0a)
        && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join('');
  const redacted = redactUrlUserInfo(withoutControls)
    .replace(AUTHORIZATION_PATTERN, '$1$2$3[REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, (_match, key: string, separator: string, value: string) => {
      return `${key}${separator}${redactCredentialValue(value)}`;
    })
    .replace(GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, (_match, key: string, separator: string, value: string) => {
      return `${key}${separator}${redactCredentialValue(value)}`;
    })
    .replace(QUOTED_CREDENTIAL_KEY_PATTERN, (_match, quote: string, key: string, separator: string, value: string) => {
      return `${quote}${key}${quote}${separator}${redactCredentialValue(value)}`;
    })
    .replace(QUOTED_GENERIC_CREDENTIAL_KEY_PATTERN, (_match, quote: string, key: string, separator: string, value: string) => {
      return `${quote}${key}${quote}${separator}${redactCredentialValue(value)}`;
    })
    .replace(NPM_TOKEN_PATTERN, '[REDACTED]');

  return redacted
    .split('\n')
    .map((line, index) => index === 0 ? line : `${CONTINUATION_PREFIX}${line}`)
    .join('\n');
}

function redactUrlUserInfo(message: string): string {
  let sanitized = '';
  let cursor = 0;
  let separatorIndex = message.indexOf(URL_SEPARATOR);
  while (separatorIndex !== -1) {
    let schemeStart = separatorIndex - 1;
    while (schemeStart >= 0 && /[A-Za-z0-9+.-]/.test(message[schemeStart] ?? '')) {
      schemeStart -= 1;
    }
    const scheme = message.slice(schemeStart + 1, separatorIndex);
    const hasValidScheme = scheme.length > 0 && /[A-Za-z]/.test(scheme[0] ?? '');
    const authorityStart = separatorIndex + URL_SEPARATOR.length;
    if (hasValidScheme) {
      const authorityEndMatch = /[\/\s]/.exec(message.slice(authorityStart));
      const authorityEnd = authorityEndMatch === null
        ? message.length
        : authorityStart + authorityEndMatch.index;
      const atIndex = message.lastIndexOf('@', authorityEnd);
      const userInfo = message.slice(authorityStart, atIndex);
      if (atIndex >= authorityStart && userInfo.includes(':')) {
        sanitized += message.slice(cursor, authorityStart);
        sanitized += message.slice(atIndex + 1, authorityEnd);
        cursor = authorityEnd;
      }
    }
    separatorIndex = message.indexOf(URL_SEPARATOR, separatorIndex + URL_SEPARATOR.length);
  }
  return sanitized + message.slice(cursor);
}

function redactCredentialValue(value: string): string {
  const quote = value[0] === '"' || value[0] === '\'' ? value[0] : '';
  return `${quote}[REDACTED]${quote}`;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}