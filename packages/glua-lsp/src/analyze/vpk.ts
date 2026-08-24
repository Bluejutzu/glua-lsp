import fs from 'node:fs';

/**
 * File listing from a Source VPK directory archive.
 *
 * Almost nothing in a Garry's Mod install is a loose file — the base game and
 * Half-Life 2 content live in VPK archives, so scanning directories finds a few
 * hundred files out of hundreds of thousands. The `_dir.vpk` half holds only the
 * tree, which is what we want and is small enough to read outright.
 *
 * Format: https://developer.valvesoftware.com/wiki/VPK_(file_format)
 */

const SIGNATURE = 0x55aa1234;

/** Header is 12 bytes in v1, 28 in v2 — the extra fields are checksum sections. */
const HEADER_V1 = 12;
const HEADER_V2 = 28;

/** crc + preloadBytes + archiveIndex + entryOffset + entryLength + terminator */
const ENTRY_SIZE = 18;

/**
 * Every path inside a VPK directory file, lowercase, `materials/foo/bar.vmt`
 * style. Returns nothing rather than throwing — a malformed or truncated
 * archive should cost us that archive, not the feature.
 */
export function readVpkDirectory(file: string): string[] {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return [];
  }

  if (buffer.length < HEADER_V1 || buffer.readUInt32LE(0) !== SIGNATURE) return [];

  const version = buffer.readUInt32LE(4);
  if (version !== 1 && version !== 2) return [];

  let offset = version === 1 ? HEADER_V1 : HEADER_V2;
  const treeEnd = Math.min(offset + buffer.readUInt32LE(8), buffer.length);
  const out: string[] = [];

  /** Reads a null-terminated string, or null at the end of the tree. */
  const readString = (): string | null => {
    const end = buffer.indexOf(0, offset);
    if (end === -1 || end >= treeEnd) return null;
    const value = buffer.toString('utf8', offset, end);
    offset = end + 1;
    return value;
  };

  try {
    // extension -> directory -> filename, each level ending on an empty string.
    for (;;) {
      const extension = readString();
      if (extension === null || extension === '') break;

      for (;;) {
        const directory = readString();
        if (directory === null || directory === '') break;

        for (;;) {
          const name = readString();
          if (name === null || name === '') break;

          if (offset + ENTRY_SIZE > treeEnd) return out;
          const preload = buffer.readUInt16LE(offset + 4);
          offset += ENTRY_SIZE + preload;

          // A space means the archive root, and ` ` as an extension means none.
          const dir = directory === ' ' ? '' : `${directory}/`;
          const ext = extension === ' ' ? '' : `.${extension}`;
          out.push(`${dir}${name}${ext}`.toLowerCase());
        }
      }
    }
  } catch {
    // Truncated tree; keep whatever was read before it went wrong.
  }

  return out;
}
