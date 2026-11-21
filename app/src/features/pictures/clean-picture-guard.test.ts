// The last check before a picture is sent stands on its own: even if the rebuilding step let a hidden detail through (a bug, or
// a browser whose encoder writes something new), a picture that still carries one is refused and nothing is uploaded.
import { describe, expect, it, vi } from "vitest";

vi.mock("@creaton/core/social/picture-bytes.ts", async (importActual) => ({
  ...(await importActual<object>()),
  // A rebuilding step that removes nothing.
  scrubPicture: (bytes: Uint8Array) => bytes,
}));

import { cleanPicture } from "./clean-picture";
import { photoWithLocation } from "./photo-fixture";

describe("the last check", () => {
  it("refuses a picture that still carries a location when nothing was removed from it", async () => {
    await expect(
      cleanPicture(
        new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" }),
        {
          render: async () => ({
            width: 10,
            height: 10,
            hasAlpha: false,
            encode: async () => photoWithLocation(),
          }),
        },
      ),
    ).rejects.toThrow(/hidden details/);
  });
});
