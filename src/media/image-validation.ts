import type { AllowedImageMime } from './media.constants';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** AVIF is an ISO-BMFF file: an `ftyp` box carrying an `avif` or `avis` brand. */
function isAvif(buf: Buffer): boolean {
  if (buf.length < 16 || buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = Math.min(buf.readUInt32BE(0), buf.length, 256);
  // 8-12 major brand, 12-16 minor version (skipped), 16+ compatible brands
  for (let i = 8; i + 4 <= boxSize; i += 4) {
    if (i === 12) continue;
    const brand = buf.toString('ascii', i, i + 4);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

/** Detects the real image type from magic bytes (the client-sent mimetype is not trusted). */
export function detectImageType(buf: Buffer): AllowedImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (isAvif(buf)) return 'image/avif';
  return null;
}
