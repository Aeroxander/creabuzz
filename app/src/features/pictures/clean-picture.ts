/**
 * A picture made ready to send: drawn again in the browser, so only its pixels are kept, shrunk to a size a phone can
 * send quickly, rebuilt from the parts that draw it (`scrubPicture`) and checked against the server's own rule for a
 * picture with nothing hidden in it (`assertMetadataFree`) as the last step. Where it was taken, which phone took it and
 * who made it are not in what is sent, whatever the file said and whatever the browser's encoder writes.
 *
 * The drawing and encoding are the browser's (`browserRender`); tests give their own, so the removal and the check are
 * proved on bytes that carry a location.
 */
import {
  assertMetadataFree,
  scrubPicture,
} from "@creaton/core/social/picture-bytes.ts";
import {
  MAX_PICTURE_BYTES,
  MAX_PICTURE_EDGE,
  sourcePictureProblem,
} from "@creaton/core/social/pictures.ts";

type SentKind = "image/jpeg" | "image/png";

/** A picture as drawn on a canvas: its size and how to write it out. */
export interface Rendered {
  width: number;
  height: number;
  /** Any pixel is see-through (such a picture is sent as a PNG so the see-through stays). */
  hasAlpha: boolean;
  /** The picture as encoded by the browser: bytes that may still carry whatever the encoder adds. */
  encode: (mime: SentKind, quality: number) => Promise<Uint8Array>;
}

export interface PictureDeps {
  /** Draw `file` no larger than `edge` pixels on its longest side, turned the way it was held. */
  render: (file: Blob, edge: number) => Promise<Rendered>;
}

/** What is sent for a picture. */
export interface CleanPicture {
  bytes: Uint8Array;
  mime: SentKind;
  width: number;
  height: number;
}

/** A picture that could not be opened at all (not a picture, or damaged). */
export const PICTURE_UNREADABLE =
  "That file could not be opened as a picture. Try another one.";
/** A picture that stays over the limit after being shrunk as far as it goes. */
export const PICTURE_TOO_BIG = `That picture is still over ${MAX_PICTURE_BYTES / (1024 * 1024)} MB after shrinking. Try another one.`;

/** The tries, from the best to the smallest: longest side and JPEG quality. Bounded: three tries and no more. */
const TRIES = [
  { edge: MAX_PICTURE_EDGE, quality: 0.86 },
  { edge: 1600, quality: 0.8 },
  { edge: 1200, quality: 0.7 },
] as const;

/** Make `file` ready to send, or throw the words a person is shown. */
export async function cleanPicture(
  file: File,
  deps: PictureDeps = { render: browserRender },
): Promise<CleanPicture> {
  const problem = sourcePictureProblem(file);
  if (problem) throw new Error(problem);
  for (const { edge, quality } of TRIES) {
    let drawn: Rendered;
    try {
      drawn = await deps.render(file, edge);
    } catch {
      throw new Error(PICTURE_UNREADABLE);
    }
    const mime: SentKind = drawn.hasAlpha ? "image/png" : "image/jpeg";
    const bytes = scrubPicture(await drawn.encode(mime, quality), mime);
    // The last check before anything is sent: a picture that is not clean is never uploaded.
    assertMetadataFree(bytes, mime);
    if (bytes.length <= MAX_PICTURE_BYTES)
      return { bytes, mime, width: drawn.width, height: drawn.height };
  }
  throw new Error(PICTURE_TOO_BIG);
}

/** The browser's drawing: decode (turned as held), shrink, draw, and encode from the canvas. */
async function browserRender(file: Blob, edge: number): Promise<Rendered> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("No canvas");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  let hasAlpha = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      hasAlpha = true;
      break;
    }
  }
  return {
    width,
    height,
    hasAlpha,
    encode: (mime, quality) =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob
              ? blob
                  .arrayBuffer()
                  .then((b) => resolve(new Uint8Array(b)), reject)
              : reject(new Error("No picture")),
          mime,
          quality,
        ),
      ),
  };
}
