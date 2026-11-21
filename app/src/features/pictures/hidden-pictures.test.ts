// The pictures a person hid are kept on this phone per account, capped, found by the picture's hash wherever it appears, and
// dropped on sign-out.
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetAllHiddenPictures,
  MAX_HIDDEN_PICTURES,
  pictureKey,
} from "./hidden-pictures";
import { createLocalIdSet } from "../../lib/local-id-set";

beforeEach(() => {
  forgetAllHiddenPictures();
  localStorage.clear();
});

describe("a picture's key", () => {
  it("is its hash in a server address, with or without an extension, and nothing for any other address", () => {
    const sha = "ab".repeat(32);
    expect(pictureKey(`https://h.test/media/${sha}.jpg`)).toBe(sha);
    expect(pictureKey(`https://h.test/media/${sha}`)).toBe(sha);
    expect(pictureKey("https://h.test/pic.jpg")).toBeNull();
  });
});

describe("a short list kept for one person on this phone", () => {
  const set = createLocalIdSet({
    prefix: "test.list.",
    max: 3,
    valid: (id) => /^[a-f]+$/.test(id),
  });
  beforeEach(() => set.clearAll());

  it("keeps ids per account, newest last, never more than the cap, and ignores what is not valid", () => {
    for (const id of ["a", "b", "c", "d"]) set.add("me", id);
    expect([...set.of("me")]).toEqual(["b", "c", "d"]);
    expect(set.of("you").size).toBe(0);
    localStorage.setItem("test.list.me", JSON.stringify(["a", "zzz", 5, "b"]));
    set.clearAll();
    localStorage.setItem("test.list.me", JSON.stringify(["a", "zzz", 5, "b"]));
    expect([...set.of("me")]).toEqual(["a", "b"]);
  });

  it("is dropped for everyone on sign-out, from memory and from storage", () => {
    set.add("me", "a");
    set.add("you", "b");
    set.clearAll();
    expect(set.of("me").size).toBe(0);
    expect(localStorage.getItem("test.list.me")).toBeNull();
    expect(localStorage.getItem("test.list.you")).toBeNull();
  });

  it("still counts for this page when the browser refuses to keep it", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("full");
    };
    try {
      set.add("me", "a");
      expect(set.of("me").has("a")).toBe(true);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("keeps up to the real cap for hidden pictures", () => {
    expect(MAX_HIDDEN_PICTURES).toBe(500);
  });
});
