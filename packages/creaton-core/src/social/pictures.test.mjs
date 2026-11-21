import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMetadataFree,
  PictureNotCleanError,
  scrubPicture,
} from "./picture-bytes.ts";
import {
  cleanAlt,
  MAX_ALT_CHARS,
  MAX_PICTURES,
  picturesOf,
  pictureTags,
  sourcePictureProblem,
  textWithoutPictures,
  withPictures,
} from "./pictures.ts";

const seg = (marker, payload) =>
  Uint8Array.of(
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 255,
    ...payload,
  );
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const has = (bytes, text) =>
  Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

// A TIFF block with a GPS entry: byte order, magic, offset, one entry (tag 0x8825 = GPS info), then the GPS block.
const GPS_TIFF = [
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
  0,
  0,
  0,
  0,
  ...ascii("GPSLatitude=51.5"),
];
const EXIF = seg(0xe1, [...ascii("Exif\0\0"), ...GPS_TIFF]);
const JFIF = seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78];

/** A file shaped like a phone photo: header, location block, camera block, colour profile, comment, then the picture. */
const photo = () =>
  cat(
    Uint8Array.of(0xff, 0xd8),
    JFIF,
    EXIF,
    seg(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta Camera=Phone/>")),
    seg(0xe2, ascii("ICC_PROFILE\0sRGB")),
    seg(0xfe, ascii("made by someone")),
    seg(0xdb, [0, 1, 2, 3]),
    seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    seg(0xc4, [0, 1, 2]),
    seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    Uint8Array.from(SCAN),
    Uint8Array.of(0xff, 0xd9),
  );

test("a phone photo with a location is refused as it is and accepted once scrubbed", () => {
  const raw = photo();
  assert.ok(has(raw, "GPSLatitude"), "the fixture really carries a location");
  assert.throws(
    () => assertMetadataFree(raw, "image/jpeg"),
    PictureNotCleanError,
  );
  const clean = scrubPicture(raw, "image/jpeg");
  for (const text of [
    "GPS",
    "Exif",
    "xmpmeta",
    "ICC_PROFILE",
    "made by someone",
    "Camera",
  ])
    assert.equal(has(clean, text), false, `${text} is gone`);
  assertMetadataFree(clean, "image/jpeg");
  // What draws the picture is untouched, byte for byte.
  for (const kept of [
    seg(0xdb, [0, 1, 2, 3]),
    seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    Uint8Array.from(SCAN),
  ])
    assert.ok(Buffer.from(clean).includes(Buffer.from(kept)));
  assert.deepEqual([...clean.subarray(-2)], [0xff, 0xd9]);
});

test("a file with no header of its own gets the plain one, and scrubbing twice changes nothing", () => {
  const bare = cat(
    Uint8Array.of(0xff, 0xd8),
    seg(0xdb, [0, 1]),
    seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    Uint8Array.from(SCAN),
    Uint8Array.of(0xff, 0xd9),
  );
  const once = scrubPicture(bare, "image/jpeg");
  assertMetadataFree(once, "image/jpeg");
  assert.deepEqual(scrubPicture(once, "image/jpeg"), once);
});

test("the check refuses each way a JPEG can hold a detail", () => {
  for (const block of [
    EXIF,
    seg(0xe2, ascii("ICC")),
    seg(0xed, ascii("Photoshop 3.0")),
    seg(0xfe, ascii("note")),
    seg(0xe0, ascii("JFXX\0..")),
    seg(0xee, ascii("Adobe-too-long-x")),
  ]) {
    const file = cat(
      Uint8Array.of(0xff, 0xd8),
      block,
      seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
      Uint8Array.from(SCAN),
      Uint8Array.of(0xff, 0xd9),
    );
    assert.throws(
      () => assertMetadataFree(file, "image/jpeg"),
      PictureNotCleanError,
    );
  }
  // Bytes after the end of the picture are a hidden channel too.
  const trailing = cat(
    scrubPicture(photo(), "image/jpeg"),
    Uint8Array.of(1, 2, 3),
  );
  assert.throws(
    () => assertMetadataFree(trailing, "image/jpeg"),
    PictureNotCleanError,
  );
  assert.throws(
    () => assertMetadataFree(Uint8Array.of(1, 2, 3), "image/jpeg"),
    PictureNotCleanError,
  );
});

const chunk = (kind, data) => {
  const body = [...ascii(kind), ...data];
  return Uint8Array.of(0, 0, 0, data.length, ...body, 0, 0, 0, 0);
};
const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

test("a PNG's text, location, profile and private blocks are dropped and the picture's own blocks stay", () => {
  const raw = cat(
    PNG_SIG,
    chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    chunk("eXIf", GPS_TIFF),
    chunk("tEXt", ascii("Author\0someone")),
    chunk("iCCP", ascii("sRGB\0\0")),
    chunk("pHYs", [0, 0, 0, 1, 0, 0, 0, 1, 1]),
    chunk("prVt", ascii("private")),
    chunk("IDAT", [1, 2, 3]),
    chunk("IEND", []),
  );
  assert.throws(
    () => assertMetadataFree(raw, "image/png"),
    PictureNotCleanError,
  );
  const clean = scrubPicture(raw, "image/png");
  for (const text of ["GPS", "eXIf", "tEXt", "someone", "iCCP", "pHYs", "prVt"])
    assert.equal(has(clean, text), false);
  for (const text of ["IHDR", "IDAT", "IEND"]) assert.ok(has(clean, text));
  assertMetadataFree(clean, "image/png");
});

test("only a JPEG or a PNG is ever sent", () => {
  assert.throws(
    () => scrubPicture(photo(), "image/webp"),
    PictureNotCleanError,
  );
  assert.throws(
    () => assertMetadataFree(photo(), "image/gif"),
    PictureNotCleanError,
  );
});

test("what may be picked: the kinds and the size", () => {
  assert.equal(
    sourcePictureProblem({ size: 3_000_000, type: "image/jpeg" }),
    null,
  );
  assert.equal(
    sourcePictureProblem({ size: 3_000_000, type: "IMAGE/PNG" }),
    null,
  );
  assert.match(
    sourcePictureProblem({ size: 10, type: "application/pdf" }),
    /not a picture/,
  );
  assert.match(
    sourcePictureProblem({ size: 26 * 1024 * 1024, type: "image/jpeg" }),
    /26 MB/,
  );
});

test("descriptions are one short line", () => {
  assert.equal(cleanAlt("  a  red\n lamp  "), "a red lamp");
  assert.equal([...cleanAlt("x".repeat(500))].length, MAX_ALT_CHARS);
});

test("a post's pictures: described in imeta tags, their addresses after the words, and read back", () => {
  const url = `https://host.test/media/${"a".repeat(64)}.jpg`;
  const picture = {
    url,
    alt: "A red lamp on a desk",
    mime: "image/jpeg",
    sha256: "a".repeat(64),
    width: 800,
    height: 600,
  };
  assert.deepEqual(pictureTags([picture]), [
    [
      "imeta",
      `url ${url}`,
      "m image/jpeg",
      "alt A red lamp on a desk",
      `x ${"a".repeat(64)}`,
      "dim 800x600",
    ],
  ]);
  const made = withPictures(
    { kind: 1, tags: [["t", "lamps"]], content: "My lamp #lamps" },
    [picture],
  );
  assert.equal(made.content, `My lamp #lamps\n${url}`);
  assert.equal(made.tags.length, 2);
  const keep = (u) => u.startsWith("https://host.test/media/");
  const back = picturesOf(made, keep);
  assert.deepEqual(back, [{ url, alt: "A red lamp on a desk" }]);
  assert.equal(textWithoutPictures(made.content, back), "My lamp #lamps");
});

test("only addresses the reader allows are pictures; a bare address on its own line is one with no description", () => {
  const mine = `https://host.test/media/${"b".repeat(64)}.png`;
  const other = "https://elsewhere.test/pic.png";
  const content = `Look\n${mine}\n${other}\nand ${mine} inline`;
  const found = picturesOf(
    { content, tags: [["imeta", `url ${other}`, "alt tracker"]] },
    (u) => u.startsWith("https://host.test/"),
  );
  assert.deepEqual(found, [{ url: mine, alt: "" }]);
  assert.equal(
    textWithoutPictures(content, found),
    `Look\n${other}\nand ${mine} inline`,
  );
});

test("too many pictures, and a post that is too long with its pictures, are refused", () => {
  const many = Array.from({ length: MAX_PICTURES + 1 }, (_, i) => ({
    url: `https://h.test/media/${String(i).repeat(64)}.jpg`,
    alt: "",
  }));
  assert.throws(
    () => withPictures({ kind: 1, tags: [], content: "x" }, many),
    /up to 4 pictures/,
  );
  assert.throws(
    () =>
      withPictures({ kind: 1, tags: [], content: "x".repeat(1990) }, [many[0]]),
    /Keep it under 2000/,
  );
});
