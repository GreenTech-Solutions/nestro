import { crc32, inflateRawSync } from 'node:zlib';
import { describeError } from '../shared';

/**
 * Minimal ZIP reader for a `.vsix`, hand-written rather than using an unzip dependency: the
 * verifier must inspect the exact bytes that ship, and each added dependency is another thing
 * that could put bytes into the package.
 */

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const DATA_DESCRIPTOR_FIXED_SIZE = 16;
const MAX_ARCHIVE_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATED = 8;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMLINK_TYPE = 0xa000;
const LATIN1_CHUNK_SIZE = 8192;

export interface VsixArchiveEntry {
  /** Path exactly as stored in the archive, e.g. `extension/out/extension.cjs`. */
  readonly path: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Unix mode from the high 16 bits of the central directory external attributes. */
  readonly unixMode: number;
  readonly isSymlink: boolean;
  /** Decompressed content, so the verifier inspects shipped bytes, not sources. */
  readonly bytes: Uint8Array;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const lowestPossibleOffset = Math.max(0, length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT_SIZE);
  for (let offset = length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= lowestPossibleOffset; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Not a ZIP archive: end of central directory record was not found');
}

function assertRange(offset: number, length: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset > limit
    || length > limit - offset) {
    throw new Error(`Corrupt archive: ${label} is outside ZIP bounds`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  catch (error) {
    throw new Error(`Corrupt archive: ${label} is not valid UTF-8`, { cause: error });
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Byte-exact decoding, so pattern matching never depends on UTF-8 validity. */
export function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += LATIN1_CHUNK_SIZE) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + LATIN1_CHUNK_SIZE));
  }
  return text;
}

interface CentralRecord {
  readonly path: string;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly expectedCrc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
  /** Offset of the next central directory entry. */
  readonly nextOffset: number;
}

interface ZipLayout {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectoryEnd: number;
}

function readEndOfCentralDirectory(archive: Uint8Array, view: DataView): ZipLayout {
  if (archive.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw new Error('Not a ZIP archive: file is too small');
  }
  const endOffset = findEndOfCentralDirectory(view, archive.length);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  if (endOffset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength !== archive.length) {
    throw new Error('Corrupt archive: end-of-central-directory comment extends outside ZIP bounds');
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported by the VSIX verifier');
  }
  if (entryCount === ZIP64_MARKER_16
    || entriesOnDisk === ZIP64_MARKER_16
    || centralDirectorySize === ZIP64_MARKER_32
    || centralDirectoryOffset === ZIP64_MARKER_32) {
    throw new Error('ZIP64 archives are not supported by the VSIX verifier');
  }
  assertRange(centralDirectoryOffset, centralDirectorySize, endOffset, 'central directory');
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd !== endOffset) {
    throw new Error('Corrupt archive: central directory bounds do not end at the end-of-central-directory record');
  }
  return { entryCount, centralDirectoryOffset, centralDirectoryEnd };
}

function readCentralRecord(
  archive: Uint8Array,
  view: DataView,
  offset: number,
  index: number,
  centralDirectoryEnd: number,
): CentralRecord {
  assertRange(offset, CENTRAL_DIRECTORY_FIXED_SIZE, centralDirectoryEnd, `central directory entry ${index}`);
  if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error(`Corrupt archive: central directory entry ${index} has a bad signature`);
  }
  const compressedSize = view.getUint32(offset + 20, true);
  const uncompressedSize = view.getUint32(offset + 24, true);
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const diskStart = view.getUint16(offset + 34, true);
  const localHeaderOffset = view.getUint32(offset + 42, true);
  if (compressedSize === ZIP64_MARKER_32
    || uncompressedSize === ZIP64_MARKER_32
    || localHeaderOffset === ZIP64_MARKER_32) {
    throw new Error('ZIP64 archives are not supported by the VSIX verifier');
  }
  if (diskStart !== 0) {
    throw new Error(`Multi-disk ZIP entry "${index}" is not supported by the VSIX verifier`);
  }
  const nameStart = offset + CENTRAL_DIRECTORY_FIXED_SIZE;
  assertRange(nameStart, nameLength + extraLength + commentLength, centralDirectoryEnd, `central metadata for entry ${index}`);
  const nameBytes = archive.subarray(nameStart, nameStart + nameLength);
  return {
    path: decodeUtf8(nameBytes, 'central filename'),
    nameBytes,
    flags: view.getUint16(offset + 8, true),
    compressionMethod: view.getUint16(offset + 10, true),
    expectedCrc: view.getUint32(offset + 16, true),
    compressedSize,
    uncompressedSize,
    externalAttributes: view.getUint32(offset + 38, true),
    localHeaderOffset,
    nextOffset: nameStart + nameLength + extraLength + commentLength,
  };
}

/** Cross-checks the local header against the central record and returns the entry's stored payload. */
function readStoredPayload(
  archive: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
  record: CentralRecord,
): Uint8Array {
  const { path, localHeaderOffset, flags, compressionMethod, compressedSize, uncompressedSize, expectedCrc } = record;
  assertRange(localHeaderOffset, LOCAL_FILE_HEADER_FIXED_SIZE, centralDirectoryOffset, `local header for "${path}"`);
  if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Corrupt archive: local file header for "${path}" is missing`);
  }
  const localCrc = view.getUint32(localHeaderOffset + 14, true);
  const localCompressedSize = view.getUint32(localHeaderOffset + 18, true);
  const localUncompressedSize = view.getUint32(localHeaderOffset + 22, true);
  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const nameOffset = localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE;
  assertRange(nameOffset, nameLength + extraLength, centralDirectoryOffset, `local filename and extra data for "${path}"`);
  const localNameBytes = archive.subarray(nameOffset, nameOffset + nameLength);
  decodeUtf8(localNameBytes, 'local filename');
  if (!bytesEqual(localNameBytes, record.nameBytes)) {
    throw new Error(`Corrupt archive: local filename does not match central filename for "${path}"`);
  }
  if (view.getUint16(localHeaderOffset + 6, true) !== flags) {
    throw new Error(`Corrupt archive: local flags do not match central flags for "${path}"`);
  }
  if (view.getUint16(localHeaderOffset + 8, true) !== compressionMethod) {
    throw new Error(`Corrupt archive: local compression method does not match central method for "${path}"`);
  }

  const usesDataDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
  if (!usesDataDescriptor
    && (localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize)) {
    throw new Error(`Corrupt archive: local CRC or sizes do not match central metadata for "${path}"`);
  }
  if (usesDataDescriptor && (localCrc !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0)) {
    throw new Error(`Corrupt archive: local data-descriptor CRC and sizes must be zero for "${path}"`);
  }

  const dataOffset = nameOffset + nameLength + extraLength;
  assertRange(dataOffset, compressedSize, centralDirectoryOffset, `compressed payload for "${path}"`);
  if (usesDataDescriptor) {
    const descriptorOffset = dataOffset + compressedSize;
    assertRange(descriptorOffset, DATA_DESCRIPTOR_FIXED_SIZE, centralDirectoryOffset, `data descriptor for "${path}"`);
    if (view.getUint32(descriptorOffset, true) !== DATA_DESCRIPTOR_SIGNATURE
      || view.getUint32(descriptorOffset + 4, true) !== expectedCrc
      || view.getUint32(descriptorOffset + 8, true) !== compressedSize
      || view.getUint32(descriptorOffset + 12, true) !== uncompressedSize) {
      throw new Error(`Corrupt archive: data descriptor does not match central metadata for "${path}"`);
    }
  }
  return archive.subarray(dataOffset, dataOffset + compressedSize);
}

function decompressPayload(rawBytes: Uint8Array, record: CentralRecord): Uint8Array {
  const { path, compressionMethod, uncompressedSize, expectedCrc } = record;
  let content: Uint8Array;
  if (compressionMethod === COMPRESSION_STORED) {
    content = rawBytes;
  }
  else if (compressionMethod === COMPRESSION_DEFLATED) {
    try {
      content = inflateRawSync(rawBytes, { maxOutputLength: Math.max(1, uncompressedSize) });
    }
    catch (error) {
      const reason = describeError(error);
      throw new Error(`Corrupt archive: failed to inflate "${path}": ${reason}`, { cause: error });
    }
  }
  else {
    throw new Error(`Unsupported compression method ${compressionMethod} for "${path}"`);
  }

  if (content.length !== uncompressedSize) {
    throw new Error(`Corrupt archive: "${path}" inflated to ${content.length} bytes, expected ${uncompressedSize}`);
  }
  if ((crc32(content) >>> 0) !== expectedCrc) {
    throw new Error(`Corrupt archive: CRC-32 mismatch for "${path}"`);
  }
  return content;
}

/**
 * Reads every file entry of a `.vsix` from its central directory. Explicit
 * directory entries are rejected; symlinks are reported rather than resolved, because a
 * symlink inside a package is itself a finding.
 */
export function readVsixArchive(archive: Uint8Array): VsixArchiveEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const { entryCount, centralDirectoryOffset, centralDirectoryEnd } = readEndOfCentralDirectory(archive, view);

  const entries: VsixArchiveEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    const record = readCentralRecord(archive, view, offset, index, centralDirectoryEnd);
    offset = record.nextOffset;
    if (seenPaths.has(record.path)) {
      throw new Error(`Corrupt archive: duplicate archive entry path "${record.path}"`);
    }
    seenPaths.add(record.path);
    if (record.path.endsWith('/')) {
      throw new Error(`Corrupt archive: explicit directory entry is not allowed: "${record.path}"`);
    }
    const unixMode = (record.externalAttributes >>> 16) & 0xffff;
    entries.push({
      path: record.path,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      unixMode,
      isSymlink: (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE,
      bytes: decompressPayload(readStoredPayload(archive, view, centralDirectoryOffset, record), record),
    });
  }
  if (offset !== centralDirectoryEnd) {
    throw new Error('Corrupt archive: central directory entry count does not match its bounds');
  }
  return entries;
}