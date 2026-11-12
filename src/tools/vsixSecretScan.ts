import { decodeLatin1 } from './vsixArchive';
import type { VsixArchiveEntry } from './vsixArchive';
import type { PolicyViolation } from './vsixPolicyTypes';

export interface SecretPattern {
  readonly id: string;
  readonly pattern: RegExp;
  /** Optional second-stage check applied to the matched text, kept separate from the regex for readability. */
  readonly confirm?: (match: string) => boolean;
}

/**
 * Decides whether a credential-shaped assignment carries a credential-shaped value: real
 * tokens mix in a digit or a base64 character, so a plain identifier assignment does not
 * match — a letters-only token is still caught by the `publishing-token-assignment` rule.
 */
export function looksLikeSecretValue(match: string): boolean {
  const separatorIndex = match.search(/[:=]/);
  const value = match.slice(separatorIndex + 1).replace(/^[ \t]*["']?/, '');
  return /[\d+/=]/.test(value);
}

/**
 * Credential shapes scanned over the packaged bytes of every entry (including images and
 * vsce-generated metadata) rather than repository files, since packaging rewrites README and
 * CHANGELOG. Misses opaque blobs with no recognizable prefix and any re-encoded or obfuscated token.
 */
export const VSIX_SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { id: 'private-key-block', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { id: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { id: 'publishing-token-assignment', pattern: /\b(?:VSCE_PAT|OVSX_PAT|AZURE_DEVOPS_EXT_PAT|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\b[ \t]*[:=][ \t]*["']?[A-Za-z0-9+/=_-]{20,}/ },
  // Not anchored on a word boundary so a prefixed key still matches (`client_secret`,
  // `MARKETPLACE_TOKEN`); quotes around the value are optional. The value excludes `.` to
  // avoid matching dotted member-expression assignments in bundled dependencies.
  { id: 'credential-assignment', pattern: /(?:secret|token|passw(?:or)?d|credential)s?["']?[ \t]*[:=][ \t]*["']?[\w+/=-]{16,}/i, confirm: looksLikeSecretValue },
  { id: 'api-key-assignment', pattern: /api[_-]?keys?["']?[ \t]*[:=][ \t]*["']?[\w+/=-]{16,}/i, confirm: looksLikeSecretValue },
];

function hasConfirmedSecretMatch(secret: SecretPattern, content: string): boolean {
  const flags = `${secret.pattern.flags.replace('g', '')}g`;
  const pattern = new RegExp(secret.pattern.source, flags);
  for (const match of content.matchAll(pattern)) {
    if (secret.confirm === undefined || secret.confirm(match[0])) {
      return true;
    }
  }
  return false;
}

/** Scans every archive entry, including binaries; a short read is reported instead of silently skipped. */
export function checkSecrets(entries: readonly VsixArchiveEntry[], violations: PolicyViolation[]): void {
  for (const entry of entries) {
    if (entry.bytes.length !== entry.uncompressedSize) {
      violations.push({
        kind: 'unscanned-file',
        path: entry.path,
        detail: `secret scan saw ${entry.bytes.length} of ${entry.uncompressedSize} bytes`,
      });
    }
    const content = decodeLatin1(entry.bytes);
    for (const secret of VSIX_SECRET_PATTERNS) {
      if (!hasConfirmedSecretMatch(secret, content)) {
        continue;
      }
      violations.push({ kind: 'secret', path: entry.path, detail: `matched secret pattern "${secret.id}"` });
    }
  }
}