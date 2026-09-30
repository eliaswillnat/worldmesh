/**
 * Upload checks. A file is accepted only when its declared type, its
 * extension and its actual leading bytes all agree, it is within the size
 * limit, and (for images) its pixel size can be read from the header and is
 * sensible. Nothing is decoded or transcoded here.
 */
import { AD_CONFIG, limitsFor, mimeForExtension, type AdMediaType } from '../../../apps/hub/src/ads/config';
import { HttpError } from './http';

export interface CheckedFile {
  bytes: Uint8Array;
  mime: string;
  ext: string;
}

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** Validate an uploaded advertisement file against every rule for its type. */
export async function checkMedia(file: unknown, type: AdMediaType): Promise<CheckedFile> {
  if (!isFile(file)) throw new HttpError(400, 'Attach the advertisement file.');
  const limits = limitsFor(type);
  if (file.size <= 0) throw new HttpError(400, 'The file is empty.');
  if (file.size > limits.maxBytes) throw new HttpError(413, `The file is too large (limit ${Math.round(limits.maxBytes / 1024 / 1024)} MB).`);

  const byExtension = mimeForExtension(type, file.name || '');
  if (!byExtension) {
    throw new HttpError(415, type === 'image' ? 'Images must be .png, .jpg, .jpeg or .webp.' : 'Videos must be .mp4 or .webm.');
  }
  const declared = normalizeDeclared(file.type);
  if (declared && declared !== byExtension) throw new HttpError(415, 'The file type does not match its extension.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniff(bytes);
  if (sniffed !== byExtension) throw new HttpError(415, 'The file content does not match its type.');

  if (type === 'image') {
    const size = imageSize(bytes, sniffed);
    if (!size) throw new HttpError(415, 'The image could not be read.');
    if (Math.max(size.width, size.height) > AD_CONFIG.image.maxDimension) {
      throw new HttpError(413, `Images can be at most ${AD_CONFIG.image.maxDimension} px on their longest side.`);
    }
    if (Math.min(size.width, size.height) < 64) throw new HttpError(415, 'The image is too small to show on a billboard.');
  }
  return { bytes, mime: sniffed, ext: EXTENSION[sniffed] };
}

/** The optional JPEG still frame of a video advertisement. */
export async function checkPoster(file: unknown): Promise<CheckedFile | null> {
  if (file === null || file === undefined || file === '') return null;
  if (!isFile(file) || file.size <= 0) return null;
  const { maxBytes, maxDimension } = AD_CONFIG.poster;
  if (file.size > maxBytes) throw new HttpError(413, 'The video still frame is too large.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniff(bytes) !== 'image/jpeg') throw new HttpError(415, 'The video still frame must be a JPEG.');
  const size = imageSize(bytes, 'image/jpeg');
  if (!size || Math.max(size.width, size.height) > maxDimension) throw new HttpError(415, 'The video still frame could not be read.');
  return { bytes, mime: 'image/jpeg', ext: 'jpg' };
}

function isFile(value: unknown): value is File {
  return typeof value === 'object' && value !== null && typeof (value as File).arrayBuffer === 'function' && typeof (value as File).size === 'number';
}

function normalizeDeclared(type: string): string {
  const mime = type.split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg';
  // Some platforms send no type, or a generic one, for perfectly good files.
  if (!mime || mime === 'application/octet-stream') return '';
  return mime;
}

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

/** What the file really is, from its leading bytes. Only the allowed types are recognised. */
export function sniff(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  // ISO base media (MP4): a leading 'ftyp' box. QuickTime (.mov) is refused:
  // browsers outside Safari cannot rely on playing it.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    return brand === 'qt  ' ? null : 'video/mp4';
  }
  // Matroska/EBML with a "webm" DocType near the start.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes('webm') ? 'video/webm' : null;
  }
  return null;
}

/** Pixel size from the file header, without decoding. Null if it cannot be found. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === 'image/png') {
      if (ascii(bytes, 12, 4) !== 'IHDR') return null;
      return positive(view.getUint32(16), view.getUint32(20));
    }
    if (mime === 'image/webp') {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === 'VP8 ') return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === 'VP8L') {
        const b1 = bytes[22];
        const b2 = bytes[23];
        const b3 = bytes[24];
        return positive(1 + (((b1 & 0x3f) << 8) | bytes[21]), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (chunk === 'VP8X') {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return positive(width, height);
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        // Fill bytes and markers without a length.
        if (marker === 0xff) {
          offset++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = view.getUint16(offset + 2);
        // Start of frame (baseline, progressive, ...), not DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return positive(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        if (length < 2) return null;
        offset += 2 + length;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function positive(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
