import { createHash } from 'node:crypto';

/** The lowercase hex SHA-256 digest of the bytes, or of the UTF-8 encoding of a string. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}