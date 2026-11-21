// The posts a person reported are kept on this phone, per account, capped, and dropped on sign-out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetAllReported,
  forgetReportedPost,
  MAX_REPORTED,
  rememberReported,
  reportedBy,
} from "./reported";

const ME = "1".repeat(64);
const YOU = "2".repeat(64);
const id = (n: number) => n.toString(16).padStart(64, "0");

beforeEach(() => {
  forgetAllReported();
  localStorage.clear();
});

describe("the reported posts kept on this phone", () => {
  it("remembers a post for one account and not another", () => {
    rememberReported(ME, id(1));
    expect(reportedBy(ME).has(id(1))).toBe(true);
    expect(reportedBy(YOU).has(id(1))).toBe(false);
    expect(reportedBy(null).size).toBe(0);
  });

  it("is read back after the page is loaded again", () => {
    rememberReported(ME, id(1));
    // A fresh page has no memory of its own: only what the browser kept.
    forgetCacheOnly();
    expect(reportedBy(ME).has(id(1))).toBe(true);
  });

  it("shows a post again when asked", () => {
    rememberReported(ME, id(1));
    rememberReported(ME, id(2));
    forgetReportedPost(ME, id(1));
    expect([...reportedBy(ME)]).toEqual([id(2)]);
  });

  it("keeps no more than the limit and lets the oldest make way", () => {
    for (let n = 1; n <= MAX_REPORTED + 5; n += 1) rememberReported(ME, id(n));
    const kept = reportedBy(ME);
    expect(kept.size).toBe(MAX_REPORTED);
    expect(kept.has(id(1))).toBe(false);
    expect(kept.has(id(MAX_REPORTED + 5))).toBe(true);
  });

  it("is dropped for everyone on sign-out", () => {
    rememberReported(ME, id(1));
    rememberReported(YOU, id(2));
    forgetAllReported();
    expect(reportedBy(ME).size).toBe(0);
    expect(reportedBy(YOU).size).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("ignores what is not a post id in the stored list", () => {
    localStorage.setItem(
      `creaton.reported.${ME}`,
      JSON.stringify([id(1), "x", 5]),
    );
    forgetCacheOnly();
    expect([...reportedBy(ME)]).toEqual([id(1)]);
    localStorage.setItem(`creaton.reported.${ME}`, "not json");
    forgetCacheOnly();
    expect(reportedBy(ME).size).toBe(0);
  });

  it("still counts for this page when the browser refuses to keep it", () => {
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    expect(() => rememberReported(ME, id(1))).not.toThrow();
    expect(reportedBy(ME).has(id(1))).toBe(true);
    set.mockRestore();
  });
});

/** What a new page load starts with: the in-memory copy gone, the browser's storage as it is. */
function forgetCacheOnly() {
  const saved = Object.fromEntries(
    Object.keys(localStorage).map((k) => [
      k,
      localStorage.getItem(k) as string,
    ]),
  );
  forgetAllReported();
  for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
}
