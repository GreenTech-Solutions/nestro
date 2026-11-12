export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const SAFE_FILE_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function assertSafeFileName(file: string, label: string): void {
  if (!SAFE_FILE_PATTERN.test(file) || file.endsWith('.')) {
    throw new Error(`${label} must be a safe filename`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
}