/**
 * What makes a picture's bytes carry nothing hidden: the removal of every hidden detail (where it was taken, which phone took
 * it, who made it, a colour profile, a comment) and the server's own rule for a picture with nothing hidden in it. The server
 * refuses a picture that carries any such detail (`crates/buzz-media/src/validation.rs`: a structural allowlist, not a list of
 * tag names), so `scrubPicture` rebuilds the file from only the parts that draw the picture and `assertMetadataFree` is the same
 * allowlist, run here as the last check before an upload. Pure and alias-free: `pictures.test.mjs` drives it under `node --test`.
 */


const JFIF_APP0 = Uint8Array.of(
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
);
const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((value, i) => bytes[i] === value)
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What a hidden detail was found in: a file that cannot be made clean is never sent. */
export class PictureNotCleanError extends Error {
  constructor() {
    super(
      "That picture could not be cleaned of hidden details, so it was not used.",
    );
    this.name = "PictureNotCleanError";
  }
}

function scrubJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new PictureNotCleanError();
  const kept: Uint8Array[] = [Uint8Array.of(0xff, 0xd8), JFIF_APP0];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new PictureNotCleanError();
    while (bytes[i] === 0xff) i += 1;
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9) return concat([...kept, Uint8Array.of(0xff, 0xd9)]);
    if (marker === undefined || marker === 0xd8 || i + 2 > bytes.length)
      throw new PictureNotCleanError();
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length)
      throw new PictureNotCleanError();
    const segment = bytes.subarray(i - 2, i + length);
    // Everything that is not part of drawing the picture is dropped: the file's own header (a canonical one is put back
    // above), every application block (location, camera, colour profile, text) and every comment.
    const drops = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!drops) kept.push(segment);
    i += length;
    if (marker === 0xda) {
      // The picture's data runs to the next real marker; the marker bytes that can occur inside it are 0xff00 and the
      // restart markers.
      const start = i;
      while (i + 1 < bytes.length) {
        if (
          bytes[i] === 0xff &&
          bytes[i + 1] !== 0x00 &&
          !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7) &&
          bytes[i + 1] !== 0xff
        )
          break;
        i += 1;
      }
      kept.push(bytes.subarray(start, i));
    }
  }
  throw new PictureNotCleanError();
}

function scrubPng(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new PictureNotCleanError();
  const kept: Uint8Array[] = [PNG_SIGNATURE];
  let i = PNG_SIGNATURE.length;
  while (i + 12 <= bytes.length) {
    const length =
      ((bytes[i] << 24) |
        (bytes[i + 1] << 16) |
        (bytes[i + 2] << 8) |
        bytes[i + 3]) >>>
      0;
    const kind = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const end = i + 12 + length;
    if (end > bytes.length) throw new PictureNotCleanError();
    // Only the chunks that draw the picture stay (header, palette, transparency, data, end).
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(kind))
      kept.push(bytes.subarray(i, end));
    i = end;
    if (kind === "IEND") return concat(kept);
  }
  throw new PictureNotCleanError();
}

/**
 * `bytes` rebuilt from only the parts that draw the picture, so no location, camera, author, colour-profile or text block
 * survives, whatever the browser's own encoder wrote. Only the two kinds the app sends (JPEG, PNG) are accepted.
 */
export function scrubPicture(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime === "image/jpeg") return scrubJpeg(bytes);
  if (mime === "image/png") return scrubPng(bytes);
  throw new PictureNotCleanError();
}

/**
 * The server's own rule for a picture with nothing hidden in it (`validate_jpeg_metadata_free` and
 * `validate_png_metadata_free`), run on the bytes about to be sent. Throws {@link PictureNotCleanError} for anything that
 * carries a hidden detail, and for a file that is not a JPEG or PNG.
 */
export function assertMetadataFree(bytes: Uint8Array, mime: string): void {
  if (mime === "image/jpeg") assertJpegFree(bytes);
  else if (mime === "image/png") assertPngFree(bytes);
  else throw new PictureNotCleanError();
}

function assertJpegFree(bytes: Uint8Array): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new PictureNotCleanError();
  let i = 2;
  let inScan = false;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      if (inScan) {
        i += 1;
        continue;
      }
      throw new PictureNotCleanError();
    }
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) throw new PictureNotCleanError();
    const marker = bytes[i];
    i += 1;
    if (inScan && marker === 0x00) continue;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) {
      if (i !== bytes.length) throw new PictureNotCleanError();
      return;
    }
    if (marker === 0xd8 || i + 2 > bytes.length)
      throw new PictureNotCleanError();
    const length = (bytes[i] << 8) | bytes[i + 1];
    const end = i + length;
    if (length < 2 || end > bytes.length) throw new PictureNotCleanError();
    const payload = bytes.subarray(i + 2, end);
    if (marker === 0xe0) {
      const jfif =
        payload.length >= 14 &&
        String.fromCharCode(...payload.subarray(0, 5)) === "JFIF\0" &&
        payload.length === 14 + 3 * payload[12] * payload[13];
      if (!jfif) throw new PictureNotCleanError();
    } else if (marker === 0xee) {
      if (
        payload.length !== 12 ||
        String.fromCharCode(...payload.subarray(0, 5)) !== "Adobe"
      )
        throw new PictureNotCleanError();
    } else if (
      (marker >= 0xe1 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe
    ) {
      throw new PictureNotCleanError();
    }
    i = end;
    inScan = marker === 0xda;
  }
  throw new PictureNotCleanError();
}

function assertPngFree(bytes: Uint8Array): void {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new PictureNotCleanError();
  let i = PNG_SIGNATURE.length;
  const known = [
    "cHRM",
    "gAMA",
    "sBIT",
    "sRGB",
    "bKGD",
    "hIST",
    "tRNS",
    "sPLT",
    "acTL",
    "fcTL",
    "fdAT",
  ];
  while (i < bytes.length) {
    if (i + 12 > bytes.length) throw new PictureNotCleanError();
    const length =
      ((bytes[i] << 24) |
        (bytes[i + 1] << 16) |
        (bytes[i + 2] << 8) |
        bytes[i + 3]) >>>
      0;
    const kindBytes = bytes.subarray(i + 4, i + 8);
    const kind = String.fromCharCode(...kindBytes);
    const end = i + 12 + length;
    if (end > bytes.length) throw new PictureNotCleanError();
    if (kind === "tEXt" || ["eXIf", "zTXt", "iTXt", "iCCP"].includes(kind))
      throw new PictureNotCleanError();
    const ancillary = (kindBytes[0] & 0x20) !== 0;
    if (ancillary && !known.includes(kind)) throw new PictureNotCleanError();
    i = end;
    if (kind === "IEND") {
      if (i !== bytes.length) throw new PictureNotCleanError();
      return;
    }
  }
  throw new PictureNotCleanError();
}
