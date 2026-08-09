import { describe, expect, it } from 'vitest';
import { buildZipFixture, findZipFixtureEntryOffsets, SYMLINK_FILE_MODE, toBytes } from './fixtures';
import { readVsixArchive } from '../tools';

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46;

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * A single stored entry has a layout that can be addressed without parsing,
 * which is what lets the corruption cases below patch one field at a time.
 */
function storedEntryArchive(path: string, content: string): {
  archive: Uint8Array;
  localHeaderOffset: number;
  dataOffset: number;
  centralOffset: number;
  endOffset: number;
} {
  const archive = buildZipFixture([{ path, content, method: 'stored' }]);
  const dataOffset = LOCAL_FILE_HEADER_FIXED_SIZE + path.length;
  const centralOffset = dataOffset + toBytes(content).length;
  return {
    archive,
    localHeaderOffset: 0,
    dataOffset,
    centralOffset,
    endOffset: centralOffset + CENTRAL_DIRECTORY_FIXED_SIZE + path.length,
  };
}

describe('readVsixArchive()', () => {
  it('reads deflated and stored entries with their decompressed bytes', () => {
    const archive = buildZipFixture([
      { path: 'extension/out/extension.cjs', content: 'require("./chunk.cjs");', method: 'deflated' },
      { path: '[Content_Types].xml', content: '<Types />', method: 'stored' },
    ]);

    const entries = readVsixArchive(archive);

    expect(entries.map(entry => entry.path)).toEqual(['extension/out/extension.cjs', '[Content_Types].xml']);
    expect(decode(entries[0].bytes)).toBe('require("./chunk.cjs");');
    expect(entries[0].uncompressedSize).toBe(23);
    expect(entries[0].compressedSize).toBeGreaterThan(0);
    expect(decode(entries[1].bytes)).toBe('<Types />');
    expect(entries.every(entry => !entry.isSymlink)).toBe(true);
  });

  it.each([
    ['an empty directory marker', '', 'stored'],
    ['a directory-like entry with hidden bytes', 'npm_secret_token', 'deflated'],
  ] as const)('rejects %s instead of hiding its bytes', (_label, content, method) => {
    const archive = buildZipFixture([{ path: 'extension/hidden/', content, method }]);

    expect(() => readVsixArchive(archive)).toThrow('explicit directory entry is not allowed');
  });

  it.each([
    ['extension metadata', 'extension.vsixmanifest'],
    ['packaged content', 'extension/package.json'],
  ])('rejects a duplicate %s archive path', (_label, duplicatePath) => {
    const archive = buildZipFixture([
      { path: duplicatePath, content: 'first' },
      { path: duplicatePath, content: 'second' },
    ]);

    expect(() => readVsixArchive(archive))
      .toThrow(`Corrupt archive: duplicate archive entry path "${duplicatePath}"`);
  });

  it('accepts a real data-descriptor layout with zero local CRC and sizes', () => {
    const archive = buildZipFixture([
      { path: 'extension/readme.md', content: '# Descriptor\n', useDataDescriptor: true },
      { path: 'extension/package.json', content: '{}', useDataDescriptor: true },
    ]);

    expect(readVsixArchive(archive).map(entry => decode(entry.bytes)))
      .toEqual(['# Descriptor\n', '{}']);
  });

  it.each([
    [
      'a local filename that differs from the central filename',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        archive.set(toBytes('extension/secret.md'), offsets.localNameOffset);
      },
      'local filename does not match central filename',
    ],
    [
      'invalid UTF-8 in the central filename',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        archive[offsets.centralNameOffset] = 0xff;
      },
      'central filename is not valid UTF-8',
    ],
    [
      'invalid UTF-8 in the local filename',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        archive[offsets.localNameOffset] = 0xff;
      },
      'local filename is not valid UTF-8',
    ],
    [
      'different local and central flags',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
        view.setUint16(offsets.localHeaderOffset + 6, 0x0801, true);
      },
      'local flags do not match central flags',
    ],
    [
      'different local and central compression methods',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
        view.setUint16(offsets.localHeaderOffset + 8, 0, true);
      },
      'local compression method does not match central',
    ],
    [
      'a different local CRC without a data descriptor',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
        view.setUint32(offsets.localHeaderOffset + 14, 1, true);
      },
      'local CRC or sizes do not match central metadata',
    ],
    [
      'a different local compressed size without a data descriptor',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
        view.setUint32(offsets.localHeaderOffset + 18, 1, true);
      },
      'local CRC or sizes do not match central metadata',
    ],
    [
      'a different local uncompressed size without a data descriptor',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
        view.setUint32(offsets.localHeaderOffset + 22, 1, true);
      },
      'local CRC or sizes do not match central metadata',
    ],
  ])('rejects an archive with %s', (_label, mutate, message) => {
    const archive = buildZipFixture([{ path: 'extension/readme.md', content: '# Readme\n' }]);
    mutate(archive);

    expect(() => readVsixArchive(archive)).toThrow(message);
  });

  it.each([
    ['signature', 0],
    ['CRC', 4],
    ['compressed size', 8],
    ['uncompressed size', 12],
  ])('rejects a data descriptor with a different %s', (_field, fieldOffset) => {
    const archive = buildZipFixture([
      { path: 'extension/readme.md', content: '# Descriptor\n', useDataDescriptor: true },
    ]);
    const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const centralCompressedSize = view.getUint32(offsets.centralHeaderOffset + 20, true);
    const descriptorOffset = offsets.localNameOffset + offsets.localNameLength + centralCompressedSize;
    view.setUint32(descriptorOffset + fieldOffset, 1, true);

    expect(() => readVsixArchive(archive)).toThrow('data descriptor does not match central metadata');
  });

  it('rejects non-zero local metadata when the data-descriptor flag is set', () => {
    const archive = buildZipFixture([
      { path: 'extension/readme.md', content: '# Descriptor\n', useDataDescriptor: true },
    ]);
    const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
      .setUint32(offsets.localHeaderOffset + 14, 1, true);

    expect(() => readVsixArchive(archive)).toThrow('local data-descriptor CRC and sizes must be zero');
  });

  it('bounds inflation by the uncompressed size claimed in both headers', () => {
    const archive = buildZipFixture([{ path: 'extension/readme.md', content: '# Much larger than one byte\n' }]);
    const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint32(offsets.localHeaderOffset + 22, 1, true);
    view.setUint32(offsets.centralHeaderOffset + 24, 1, true);

    expect(() => readVsixArchive(archive)).toThrow('failed to inflate "extension/readme.md"');
  });

  it.each([
    [
      'a central directory outside the archive',
      (archive: Uint8Array): void => {
        new DataView(archive.buffer).setUint32(archive.length - END_OF_CENTRAL_DIRECTORY_SIZE + 16, archive.length, true);
      },
    ],
    [
      'a central filename extending past its directory',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint16(offsets.centralHeaderOffset + 28, 0xffff, true);
      },
    ],
    [
      'a local header outside the archive',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint32(offsets.centralHeaderOffset + 42, archive.length - 2, true);
      },
    ],
    [
      'a local filename extending past the archive',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint16(offsets.localHeaderOffset + 26, 0xffff, true);
      },
    ],
    [
      'compressed payload extending into the central directory',
      (archive: Uint8Array): void => {
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer);
        view.setUint32(offsets.centralHeaderOffset + 20, archive.length, true);
        view.setUint32(offsets.localHeaderOffset + 18, archive.length, true);
      },
    ],
  ])('rejects %s with a bounds diagnostic', (_label, mutate) => {
    const archive = buildZipFixture([{ path: 'extension/readme.md', content: '# Readme\n' }]);
    mutate(archive);

    expect(() => readVsixArchive(archive)).toThrow(/outside|bounds|extends|truncated/i);
  });

  it('reports an entry stored with a symlink mode', () => {
    const archive = buildZipFixture([
      { path: 'extension/images/evil.png', content: '../../../etc/passwd', unixMode: SYMLINK_FILE_MODE },
    ]);

    const [entry] = readVsixArchive(archive);

    expect(entry.isSymlink).toBe(true);
    expect(entry.unixMode).toBe(SYMLINK_FILE_MODE);
  });

  it('reads an archive that carries a trailing comment', () => {
    const base = buildZipFixture([{ path: 'extension/package.json', content: '{}' }]);
    const withComment = new Uint8Array(base.length + 4);
    withComment.set(base, 0);
    new DataView(withComment.buffer).setUint16(base.length - 2, 4, true);
    withComment.set(toBytes('note'), base.length);

    expect(readVsixArchive(withComment).map(entry => entry.path)).toEqual(['extension/package.json']);
  });

  it.each([
    ['the buffer is shorter than an end-of-central-directory record', 'too small'],
    ['no end-of-central-directory record is present', 'end of central directory'],
  ])('throws when %s', (_label, message) => {
    const archive = message === 'too small'
      ? new Uint8Array(4)
      : new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE + 8);

    expect(() => readVsixArchive(archive)).toThrow(message);
  });

  it.each([
    [
      'the central directory signature is wrong',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.centralOffset, 0x11111111, true);
      },
      'bad signature',
    ],
    [
      'the local file header is missing',
      (archive: Uint8Array, offsets: { localHeaderOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.localHeaderOffset, 0x11111111, true);
      },
      'local file header',
    ],
    [
      'the content does not match the recorded CRC-32',
      (archive: Uint8Array, offsets: { dataOffset: number }): void => {
        archive[offsets.dataOffset] = archive[offsets.dataOffset] ^ 0xff;
      },
      'CRC-32 mismatch',
    ],
    [
      'the entry inflates to an unexpected length',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        const view = new DataView(archive.buffer);
        view.setUint32(offsets.centralOffset + 24, 999, true);
        view.setUint32(22, 999, true);
      },
      'expected 999',
    ],
    [
      'the compression method is unsupported',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        const view = new DataView(archive.buffer);
        view.setUint16(offsets.centralOffset + 10, 99, true);
        view.setUint16(8, 99, true);
      },
      'Unsupported compression method 99',
    ],
    [
      'the archive announces ZIP64 offsets',
      (archive: Uint8Array, offsets: { endOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.endOffset + 16, 0xffffffff, true);
      },
      'ZIP64',
    ],
    [
      'a central entry announces a ZIP64 compressed size',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.centralOffset + 20, 0xffffffff, true);
      },
      'ZIP64',
    ],
    [
      'a central entry announces a ZIP64 uncompressed size',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.centralOffset + 24, 0xffffffff, true);
      },
      'ZIP64',
    ],
    [
      'a central entry announces a ZIP64 local offset',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        new DataView(archive.buffer).setUint32(offsets.centralOffset + 42, 0xffffffff, true);
      },
      'ZIP64',
    ],
    [
      'a central entry points to another disk',
      (archive: Uint8Array, offsets: { centralOffset: number }): void => {
        new DataView(archive.buffer).setUint16(offsets.centralOffset + 34, 1, true);
      },
      'Multi-disk ZIP entry',
    ],
    [
      'the end record points to another disk',
      (archive: Uint8Array, offsets: { endOffset: number }): void => {
        new DataView(archive.buffer).setUint16(offsets.endOffset + 4, 1, true);
      },
      'Multi-disk ZIP archives',
    ],
    [
      'the end record claims a missing comment byte',
      (archive: Uint8Array, offsets: { endOffset: number }): void => {
        new DataView(archive.buffer).setUint16(offsets.endOffset + 20, 1, true);
      },
      'comment extends outside ZIP bounds',
    ],
    [
      'the central directory size stops before the end record',
      (archive: Uint8Array, offsets: { endOffset: number }): void => {
        const view = new DataView(archive.buffer);
        view.setUint32(offsets.endOffset + 12, view.getUint32(offsets.endOffset + 12, true) - 1, true);
      },
      'do not end at the end-of-central-directory record',
    ],
    [
      'the central entry count is smaller than the directory contents',
      (archive: Uint8Array, offsets: { endOffset: number }): void => {
        const view = new DataView(archive.buffer);
        view.setUint16(offsets.endOffset + 8, 0, true);
        view.setUint16(offsets.endOffset + 10, 0, true);
      },
      'entry count does not match its bounds',
    ],
  ])('rejects an archive where %s', (_label, corrupt, message) => {
    const { archive, ...offsets } = storedEntryArchive('extension/package.json', '{"main":"./out/x.cjs"}');

    corrupt(archive, offsets);

    expect(() => readVsixArchive(archive)).toThrow(message);
  });
});