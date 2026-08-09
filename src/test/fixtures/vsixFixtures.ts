import { crc32, deflateRawSync } from 'node:zlib';
import type { VsixArchiveEntry } from '../../tools';

/**
 * Fixtures for the VSIX package boundary suite.
 *
 * `buildZipFixture()` writes a real ZIP container byte by byte so the archive
 * reader is exercised against actual headers rather than a stub, and so the
 * verifier can be driven end to end without invoking vsce. `cleanVsix*()`
 * describes a package that satisfies every policy layer; each negative case in
 * the suite starts from it and changes exactly one thing.
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const VERSION_MADE_BY_UNIX = 0x031e;
const REGULAR_FILE_MODE = 0o100644;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
export const SYMLINK_FILE_MODE = 0o120777;

export type ZipCompression = 'stored' | 'deflated';

export interface ZipFixtureEntry {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly method?: ZipCompression;
  readonly unixMode?: number;
  readonly useDataDescriptor?: boolean;
}

export interface ZipFixtureEntryOffsets {
  readonly centralHeaderOffset: number;
  readonly centralNameOffset: number;
  readonly centralNameLength: number;
  readonly localHeaderOffset: number;
  readonly localNameOffset: number;
  readonly localNameLength: number;
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Builds a ZIP container with the given entries; deflated by default. */
export function buildZipFixture(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const raw = toBytes(entry.content);
    const method = entry.method ?? 'deflated';
    const stored = method === 'stored' ? raw : deflateRawSync(raw);
    const checksum = crc32(raw) >>> 0;
    const flags = UTF8_FLAG | (entry.useDataDescriptor === true ? DATA_DESCRIPTOR_FLAG : 0);

    const local = new Uint8Array(LOCAL_FILE_HEADER_FIXED_SIZE + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method === 'stored' ? 0 : 8, true);
    if (entry.useDataDescriptor !== true) {
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, stored.length, true);
      localView.setUint32(22, raw.length, true);
    }
    localView.setUint16(26, name.length, true);
    local.set(name, LOCAL_FILE_HEADER_FIXED_SIZE);
    const descriptor = new Uint8Array(entry.useDataDescriptor === true ? 16 : 0);
    if (entry.useDataDescriptor === true) {
      const descriptorView = new DataView(descriptor.buffer);
      descriptorView.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
      descriptorView.setUint32(4, checksum, true);
      descriptorView.setUint32(8, stored.length, true);
      descriptorView.setUint32(12, raw.length, true);
    }
    localParts.push(local, stored, descriptor);

    const central = new Uint8Array(CENTRAL_DIRECTORY_FIXED_SIZE + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    centralView.setUint16(4, VERSION_MADE_BY_UNIX, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method === 'stored' ? 0 : 8, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, (entry.unixMode ?? REGULAR_FILE_MODE) * 0x10000, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, CENTRAL_DIRECTORY_FIXED_SIZE);
    centralParts.push(central);

    localOffset += local.length + stored.length + descriptor.length;
  }

  const centralDirectory = concat(centralParts);
  const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  return concat([...localParts, centralDirectory, end]);
}

export function findZipFixtureEntryOffsets(archive: Uint8Array, expectedPath: string): ZipFixtureEntryOffsets {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE;
  const entryCount = view.getUint16(endOffset + 10, true);
  let centralHeaderOffset = view.getUint32(endOffset + 16, true);
  for (let index = 0; index < entryCount; index++) {
    const centralNameLength = view.getUint16(centralHeaderOffset + 28, true);
    const extraLength = view.getUint16(centralHeaderOffset + 30, true);
    const commentLength = view.getUint16(centralHeaderOffset + 32, true);
    const centralNameOffset = centralHeaderOffset + CENTRAL_DIRECTORY_FIXED_SIZE;
    const path = new TextDecoder().decode(archive.subarray(centralNameOffset, centralNameOffset + centralNameLength));
    const localHeaderOffset = view.getUint32(centralHeaderOffset + 42, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    if (path === expectedPath) {
      return {
        centralHeaderOffset,
        centralNameOffset,
        centralNameLength,
        localHeaderOffset,
        localNameOffset: localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE,
        localNameLength,
      };
    }
    centralHeaderOffset = centralNameOffset + centralNameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP fixture entry not found: ${expectedPath}`);
}

/** Builds a policy input entry directly, skipping the ZIP round trip. */
export function archiveEntry(
  path: string,
  content: string | Uint8Array = '',
  overrides: Partial<VsixArchiveEntry> = {},
): VsixArchiveEntry {
  const bytes = toBytes(content);
  return {
    path,
    compressedSize: bytes.length,
    uncompressedSize: bytes.length,
    unixMode: REGULAR_FILE_MODE,
    isSymlink: false,
    bytes,
    ...overrides,
  };
}

export const CLEAN_ENTRYPOINT_SOURCE = 'require("./chunk-AbCdEf12.cjs");\nmodule.exports = {};';
export const CLEAN_CHUNK_SOURCE = 'module.exports = { chunk: true };';
export const CLEAN_EXTENSION_IDENTITY = {
  name: 'nestro',
  version: '9.9.9',
  publisher: 'greentech-solutions',
} as const;

export const CLEAN_PACKAGE_MANIFEST = JSON.stringify({
  ...CLEAN_EXTENSION_IDENTITY,
  main: './out/extension.cjs',
  icon: 'resources/icon.png',
});

export const CLEAN_VSIX_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="${CLEAN_EXTENSION_IDENTITY.name}" Version="${CLEAN_EXTENSION_IDENTITY.version}" Publisher="${CLEAN_EXTENSION_IDENTITY.publisher}" />
  </Metadata>
</PackageManifest>`;

/** A package that passes every layer of the policy. */
export function cleanVsixFixtureEntries(): ZipFixtureEntry[] {
  return [
    { path: 'extension.vsixmanifest', content: CLEAN_VSIX_MANIFEST },
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types />' },
    { path: 'extension/package.json', content: CLEAN_PACKAGE_MANIFEST },
    { path: 'extension/readme.md', content: '# Nestro\n' },
    { path: 'extension/changelog.md', content: '# Changelog\n' },
    { path: 'extension/LICENSE.txt', content: 'MIT\n' },
    { path: 'extension/resources/icon.png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
    { path: 'extension/resources/icon.svg', content: '<svg />' },
    { path: 'extension/images/pick-version.png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]) },
    { path: 'extension/out/extension.cjs', content: CLEAN_ENTRYPOINT_SOURCE },
    { path: 'extension/out/chunk-AbCdEf12.cjs', content: CLEAN_CHUNK_SOURCE },
  ];
}

export function cleanVsixArchiveEntries(): VsixArchiveEntry[] {
  return cleanVsixFixtureEntries().map(entry => archiveEntry(entry.path, entry.content));
}

export function buildCleanVsixFixture(): Uint8Array {
  return buildZipFixture(cleanVsixFixtureEntries());
}

/** Repository paths behind the clean fixture, as `git ls-files` would report them. */
export const CLEAN_TRACKED_SOURCE_PATHS: readonly string[] = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'images/pick-version.png',
  'package.json',
  'resources/icon.png',
  'resources/icon.svg',
];