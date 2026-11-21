// A picture is made ready on the phone before it is sent: drawn again, shrunk, rebuilt from only the parts that draw it, and
// checked against the server's own rule. These drive the production `cleanPicture` with a browser that keeps a photo's location
// (the worst case: an encoder that copies the file's hidden details into what it writes).
import { MAX_PICTURE_BYTES } from "@creaton/core/social/pictures.ts";
import { describe, expect, it, vi } from "vitest";
import {
  cleanPicture,
  PICTURE_TOO_BIG,
  PICTURE_UNREADABLE,
  type PictureDeps,
  type Rendered,
} from "./clean-picture";
import { contains, LOCATION_TEXT, photoWithLocation } from "./photo-fixture";

const file = (type = "image/jpeg", size = 1000) =>
  new File([new Uint8Array(size)], "photo.jpg", { type });

/** A browser whose encoder writes the original's hidden details into what it produces. */
function keepsDetails(over: Partial<Rendered> = {}): PictureDeps {
  return {
    render: async () => ({
      width: 800,
      height: 600,
      hasAlpha: false,
      encode: async () => photoWithLocation(),
      ...over,
    }),
  };
}

describe("a picture made ready to send", () => {
  it("carries no location, camera, colour profile or comment, even when the browser's encoder kept them", async () => {
    const raw = photoWithLocation();
    expect(contains(raw, LOCATION_TEXT)).toBe(true);
    const clean = await cleanPicture(file(), keepsDetails());
    for (const text of [
      "GPS",
      "Exif",
      "xmpmeta",
      "SomePhone",
      "ICC_PROFILE",
      "taken by someone",
    ])
      expect(contains(clean.bytes, text)).toBe(false);
    expect(clean.mime).toBe("image/jpeg");
    expect([clean.width, clean.height]).toEqual([800, 600]);
    // What draws the picture is kept: the end marker, and the scan.
    expect([...clean.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("a see-through picture is sent as a PNG, and a PNG with text in it is cleaned too", async () => {
    const chunk = (kind: string, data: number[]) => [
      0,
      0,
      0,
      data.length,
      ...[...kind].map((c) => c.charCodeAt(0)),
      ...data,
      0,
      0,
      0,
      0,
    ];
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk(
        "tEXt",
        [...`Author\0${LOCATION_TEXT}`].map((c) => c.charCodeAt(0)),
      ),
      ...chunk("IDAT", [1, 2, 3]),
      ...chunk("IEND", []),
    ]);
    const clean = await cleanPicture(
      file("image/png"),
      keepsDetails({ hasAlpha: true, encode: async () => png }),
    );
    expect(clean.mime).toBe("image/png");
    expect(contains(clean.bytes, "GPS")).toBe(false);
    expect(contains(clean.bytes, "Author")).toBe(false);
    expect(contains(clean.bytes, "IDAT")).toBe(true);
  });

  it("is refused before anything is drawn when it is not a picture or is far too big", async () => {
    const render = vi.fn();
    await expect(
      cleanPicture(file("application/pdf"), { render }),
    ).rejects.toThrow(/not a picture/);
    await expect(
      cleanPicture(file("image/jpeg", 26 * 1024 * 1024), { render }),
    ).rejects.toThrow(/26 MB/);
    expect(render).not.toHaveBeenCalled();
  });

  it("says so in plain words when the file cannot be opened as a picture", async () => {
    const render = vi.fn().mockRejectedValue(new Error("decode"));
    await expect(cleanPicture(file(), { render })).rejects.toThrow(
      PICTURE_UNREADABLE,
    );
  });

  it("shrinks in at most three tries, then gives up in words", async () => {
    const edges: number[] = [];
    const photo = photoWithLocation();
    // A JPEG whose scan data is large enough to stay over the limit on every try.
    const oversize = Uint8Array.from([
      ...photo.subarray(0, photo.length - 2),
      ...new Uint8Array(MAX_PICTURE_BYTES).fill(1),
      0xff,
      0xd9,
    ]);
    const deps: PictureDeps = {
      render: async (_file, edge) => {
        edges.push(edge);
        return {
          width: 10,
          height: 10,
          hasAlpha: false,
          encode: async () => oversize,
        };
      },
    };
    await expect(cleanPicture(file(), deps)).rejects.toThrow(PICTURE_TOO_BIG);
    expect(edges).toEqual([2048, 1600, 1200]);
  });

  it("is never returned when the cleaning could not make it clean", async () => {
    // Not a JPEG at all: there is nothing to rebuild, so nothing is sent.
    await expect(
      cleanPicture(
        file(),
        keepsDetails({ encode: async () => Uint8Array.of(1, 2, 3) }),
      ),
    ).rejects.toThrow(/hidden details/);
  });
});
