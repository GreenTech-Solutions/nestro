import { describe, expect, it } from 'vitest';
import { INLINE_TEXT_MAX_LENGTH, redactCredentials, sanitizeInlineText, sanitizeMultilineText } from '../shared';

const ESC = '\u001b';
const BEL = '\u0007';

describe('sanitizeMultilineText()', () => {
  it('strips 7-bit CSI, 8-bit CSI, and OSC sequences ended by BEL or ST', () => {
    expect(sanitizeMultilineText(`a${ESC}[31mred${ESC}[0m b${ESC}[1;32;4mgreen${ESC}[m`)).toBe('ared bgreen');
    expect(sanitizeMultilineText('a\u009b31mred\u009b0m')).toBe('ared');
    expect(sanitizeMultilineText(`a${ESC}]0;title${BEL}b${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\c`)).toBe('ablinkc');
  });

  it('normalizes line breaks to LF, turns tabs and form feeds into spaces, and drops other controls', () => {
    expect(sanitizeMultilineText('a\r\nb\rc d e\nf')).toBe('a\nb\nc\nd\ne\nf');
    expect(sanitizeMultilineText('a\tb\u000bc\u000cd')).toBe('a b c d');
    expect(sanitizeMultilineText('a\u0000b\u0008c\u007fd\u0085e\u009ff')).toBe('abcdef');
  });

  it('leaves an unterminated OSC prefix without hanging on a long run of them', () => {
    const input = `${`${ESC}]`.repeat(20_000)}tail`;

    const started = performance.now();
    const sanitized = sanitizeMultilineText(input);
    const elapsed = performance.now() - started;

    expect(sanitized).toBe(']'.repeat(20_000) + 'tail');
    expect(elapsed).toBeLessThan(500);
  });
});

describe('sanitizeInlineText()', () => {
  it('collapses each run of line breaks into one space', () => {
    expect(sanitizeInlineText('a\n\r\nb c')).toBe('a b c');
  });

  it('cuts to 240 characters by default and to an explicit length on request', () => {
    expect(INLINE_TEXT_MAX_LENGTH).toBe(240);
    expect(sanitizeInlineText('x'.repeat(500))).toHaveLength(240);
    expect(sanitizeInlineText('x'.repeat(500), 10)).toBe('x'.repeat(10));
    expect(sanitizeInlineText('x'.repeat(500), Number.POSITIVE_INFINITY)).toHaveLength(500);
  });
});

describe('redactCredentials()', () => {
  it('drops HTTP URL user info and keeps git SSH users', () => {
    expect(redactCredentials('https://ci:s3cr3t@registry.internal/npm')).toBe('https://registry.internal/npm');
    expect(redactCredentials('git+ssh://git@github.com/acme/lib.git#v1')).toBe('git+ssh://git@github.com/acme/lib.git#v1');
    expect(redactCredentials('1abc://u:p@host/x')).toBe('1abc://u:p@host/x');
    expect(redactCredentials('(see https://u:p@a@host)')).toBe('(see https://host)');
  });

  it('drops any HTTP-family URL user info and preserves non-HTTP usernames', () => {
    const githubToken = `ghp_${'a'.repeat(36)}`;

    expect(redactCredentials(`https://${githubToken}@github.com/o/r.git`)).toBe('https://github.com/o/r.git');
    expect(redactCredentials('git+https://token@host/x.tgz')).toBe('git+https://host/x.tgz');
    expect(redactCredentials('HTTPS://tok@host/x')).toBe('HTTPS://host/x');
    expect(redactCredentials('git+http://token@host/x.tgz')).toBe('git+http://host/x.tgz');
    expect(redactCredentials('ssh://user@host/repo')).toBe('ssh://user@host/repo');
  });

  it('masks Authorization values without eating a closing bracket', () => {
    expect(redactCredentials('(Authorization: Bearer abc.def)')).toBe('(Authorization: Bearer [REDACTED])');
    expect(redactCredentials('Authorization: Basic abc,rest')).toBe('Authorization: Basic [REDACTED],rest');
  });

  it('masks plain, quoted, and JSON credential forms and npm tokens', () => {
    const npmToken = `npm_${'a'.repeat(36)}`;
    const input = `_authToken=abc password="two words" passwd='x y' {"password":"p","_auth":"q"} ${npmToken}`;

    expect(redactCredentials(input)).toBe(
      '_authToken=[REDACTED] password="[REDACTED]" passwd=\'[REDACTED]\' {"password":"[REDACTED]","_auth":"[REDACTED]"} [REDACTED]',
    );
  });

  it('masks generic keys only from the minimum value length', () => {
    const shortValue = 'token=abc api-key: k1';

    expect(redactCredentials(shortValue)).toBe(shortValue);
    expect(redactCredentials(shortValue, 1)).toBe('token=[REDACTED] api-key: [REDACTED]');
    expect(redactCredentials('{"token":"abc"}', 1)).toBe('{"token":"[REDACTED]"}');
    expect(redactCredentials('token=abcdefghijklmnop')).toBe('token=[REDACTED]');
    expect(redactCredentials('token=abcdefghijklmno')).toBe('token=abcdefghijklmno');
  });

  it('keeps closers outside the masked value but masks them inside it', () => {
    expect(redactCredentials('(password=hunter2) [token=abcdefghijklmnopq]')).toBe('(password=[REDACTED]) [token=[REDACTED]]');
    expect(redactCredentials('password=ab)cd')).toBe('password=[REDACTED]');
    expect(redactCredentials('password=))')).toBe('password=[REDACTED]');
  });

  it('keeps words that merely contain a credential key', () => {
    const ordinary = 'my-password-utils passwords-list @acme/api-key token@1.2.3';

    expect(redactCredentials(ordinary)).toBe(ordinary);
  });

  it('runs in linear time on a long run of URL separators and credential keys', () => {
    const urls = `${`https://a:b ${'x'.repeat(100)} `.repeat(10_000)}`;
    const keys = 'password='.repeat(20_000);

    const started = performance.now();
    const redactedUrls = redactCredentials(urls);
    const redactedKeys = redactCredentials(keys);
    const elapsed = performance.now() - started;

    expect(redactedUrls).toContain('https://a:b ');
    expect(redactedKeys).toBe('password=[REDACTED]');
    expect(elapsed).toBeLessThan(500);
  });
});