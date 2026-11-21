import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../../lib/relay";
import {
  brainRepoId,
  findBrainRepo,
  KIND_REPO_ANNOUNCEMENT,
} from "./brain-repo";

const FOUNDER = "b".repeat(64);
const OTHER = "c".repeat(64);

function announcement(
  pubkey: string,
  d: string,
  extra: string[][] = [],
  createdAt = 100,
): NostrEvent {
  return {
    id: `${createdAt}`.padStart(64, "0"),
    pubkey,
    kind: KIND_REPO_ANNOUNCEMENT,
    created_at: createdAt,
    tags: [["d", d], ...extra],
    content: "",
    sig: "0".repeat(128),
  };
}

describe("the id of a project's brain repository", () => {
  it("is brain- and the project's id", () => {
    expect(brainRepoId("night-sky")).toBe("brain-night-sky");
  });
  it("is never over the 64 characters a repository id may have, and never holds a character it may not", () => {
    const id = brainRepoId(`${"a".repeat(80)}`);
    expect(id).toHaveLength(64);
    expect(brainRepoId("a b/c..d")).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(brainRepoId(".hidden")).toBe("brain-hidden");
  });
});

describe("finding the project's brain repository", () => {
  it("is the founder's own announcement of that id", () => {
    const found = findBrainRepo(
      [announcement(FOUNDER, "brain-lantern", [["buzz-channel", "x"]])],
      FOUNDER,
      "lantern",
    );
    expect(found).toEqual({ id: "brain-lantern", owner: FOUNDER, bound: true });
  });
  it("says when the repository is not attached to a room (nobody can read it then)", () => {
    expect(
      findBrainRepo(
        [announcement(FOUNDER, "brain-lantern")],
        FOUNDER,
        "lantern",
      )?.bound,
    ).toBe(false);
  });
  it("ignores another account's announcement of the same id, whatever the server returned", () => {
    expect(
      findBrainRepo(
        [announcement(OTHER, "brain-lantern", [["buzz-channel", "x"]])],
        FOUNDER,
        "lantern",
      ),
    ).toBeNull();
  });
  it("ignores another repository of the founder's", () => {
    expect(
      findBrainRepo([announcement(FOUNDER, "website")], FOUNDER, "lantern"),
    ).toBeNull();
  });
  it("reads the newest of several", () => {
    const old = announcement(FOUNDER, "brain-lantern", [], 10);
    const fresh = announcement(
      FOUNDER,
      "brain-lantern",
      [["buzz-channel", "x"]],
      20,
    );
    expect(findBrainRepo([fresh, old], FOUNDER, "lantern")?.bound).toBe(true);
    expect(findBrainRepo([old, fresh], FOUNDER, "lantern")?.bound).toBe(true);
  });
  it("finds nothing for a malformed founder key", () => {
    expect(
      findBrainRepo([announcement("zz", "brain-lantern")], "zz", "lantern"),
    ).toBeNull();
  });
});
