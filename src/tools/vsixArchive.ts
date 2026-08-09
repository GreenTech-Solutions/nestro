import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Minimal reader for the ZIP container a `.vsix` is. It is deliberately
 * hand-written instead of pulling in an unzip dependency: the verifier must be
 * able to inspect the exact bytes that ship, and every packaging dependency it
 * adds is another thing that could put bytes into that package.
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

function readEntryContent(
  archive: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
  localHeaderOffset: number,
  centralFlags: number,
  compressionMethod: number,
  compressedSize: number,
  uncompressedSize: number,
  expectedCrc: number,
  centralNameBytes: Uint8Array,
  path: string,
): Uint8Array {
  assertRange(localHeaderOffset, LOCAL_FILE_HEADER_FIXED_SIZE, centralDirectoryOffset, `local header for "${path}"`);
  if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Corrupt archive: local file header for "${path}" is missing`);
  }
  const localFlags = view.getUint16(localHeaderOffset + 6, true);
  const localCompressionMethod = view.getUint16(localHeaderOffset + 8, true);
  const localCrc = view.getUint32(localHeaderOffset + 14, true);
  const localCompressedSize = view.getUint32(localHeaderOffset + 18, true);
  const localUncompressedSize = view.getUint32(localHeaderOffset + 22, true);
  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const nameOffset = localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE;
  assertRange(nameOffset, nameLength + extraLength, centralDirectoryOffset, `local filename and extra data for "${path}"`);
  const localNameBytes = archive.subarray(nameOffset, nameOffset + nameLength);
  decodeUtf8(localNameBytes, 'local filename');
  if (!bytesEqual(localNameBytes, centralNameBytes)) {
    throw new Error(`Corrupt archive: local filename does not match central filename for "${path}"`);
  }
  if (localFlags !== centralFlags) {
    throw new Error(`Corrupt archive: local flags do not match central flags for "${path}"`);
  }
  if (localCompressionMethod !== compressionMethod) {
    throw new Error(`Corrupt archive: local compression method does not match central method for "${path}"`);
  }

  const usesDataDescriptor = (centralFlags & DATA_DESCRIPTOR_FLAG) !== 0;
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
  const rawBytes = archive.subarray(dataOffset, dataOffset + compressedSize);
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

  let content: Uint8Array;
  if (compressionMethod === COMPRESSION_STORED) {
    content = rawBytes;
  }
  else if (compressionMethod === COMPRESSION_DEFLATED) {
    try {
      content = inflateRawSync(rawBytes, { maxOutputLength: Math.max(1, uncompressedSize) });
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
  if (archive.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw new Error('Not a ZIP archive: file is too small');
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
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

  const entries: VsixArchiveEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    assertRange(offset, CENTRAL_DIRECTORY_FIXED_SIZE, centralDirectoryEnd, `central directory entry ${index}`);
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Corrupt archive: central directory entry ${index} has a bad signature`);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
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
    const centralNameBytes = archive.subarray(nameStart, nameStart + nameLength);
    const path = decodeUtf8(centralNameBytes, 'central filename');
    offset = nameStart + nameLength + extraLength + commentLength;

    if (seenPaths.has(path)) {
      throw new Error(`Corrupt archive: duplicate archive entry path "${path}"`);
    }
    seenPaths.add(path);

    if (path.endsWith('/')) {
      throw new Error(`Corrupt archive: explicit directory entry is not allowed: "${path}"`);
    }
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    entries.push({
      path,
      compressedSize,
      uncompressedSize,
      unixMode,
      isSymlink: (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE,
      bytes: readEntryContent(
        archive,
        view,
        centralDirectoryOffset,
        localHeaderOffset,
        flags,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        expectedCrc,
        centralNameBytes,
        path,
      ),
    });
  }
  if (offset !== centralDirectoryEnd) {
    throw new Error('Corrupt archive: central directory entry count does not match its bounds');
  }
  return entries;
}