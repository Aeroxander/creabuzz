/**
 * Bytes shaped like a phone photo, for tests: a JPEG that carries a location (an EXIF block with a GPS entry), a camera
 * block, a colour profile and a comment around a few bytes of picture data. Not a picture a screen could draw, but the
 * structure the server checks.
 */
const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 255,
  ...payload,
];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The text of the location the photo carries: tests look for it in what is sent. */
export const LOCATION_TEXT = "GPSLatitude=51.5074 GPSLongitude=-0.1278";

export function photoWithLocation(): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [
      ...ascii("Exif\0\0"),
      ...ascii("II"),
      42,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x25,
      0x88,
      4,
      0,
      1,
      0,
      0,
      0,
      26,
      0,
      0,
      0,
      ...ascii(LOCATION_TEXT),
    ]),
    ...seg(
      0xe1,
      ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta Make=SomePhone/>"),
    ),
    ...seg(0xe2, ascii("ICC_PROFILE\0sRGB")),
    ...seg(0xfe, ascii("taken by someone")),
    ...seg(0xdb, [0, 1, 2, 3]),
    ...seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0, 1, 2]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0xff,
    0x00,
    0x34,
    0x56,
    0xff,
    0xd9,
  ]);
}

/** Whether `bytes` contain `text` anywhere. */
export function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
}
