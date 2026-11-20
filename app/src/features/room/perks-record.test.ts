// Saving perks must change the `perks` tag and nothing else: a project record that lost its chain key, its team or its listing
// would break the project. Every other tag and the content come through as they were, and the new record is later than the one
// it replaces.
import { describe, expect, it } from "vitest";
import { parseProject } from "../project/project-record";
import { recordWithPerks } from "./perks-record";

const FOUNDER = "f".repeat(64);
const TAGS = [
  ["d", "lantern"],
  ["name", "Lantern"],
  ["t", "dao-launchpad"],
  ["t", "lamps"],
  ["admission", "curated"],
  ["chain-key", `0x${"cd".repeat(32)}`],
  ["team", "e".repeat(64), "designer", "invite-1"],
  ["team-left", "d".repeat(64), "100", "invite-0"],
  ["p", "e".repeat(64)],
  ["a", "30023:x:y"],
  ["listing-extra", "kept"],
];
const project = (tags: string[][]) => {
  const parsed = parseProject({
    id: "9".repeat(64),
    pubkey: FOUNDER,
    kind: 37001,
    created_at: 1000,
    content: '{"pitch":"Lamps","started":900,"stage":"draft"}',
    tags,
  });
  if (!parsed) throw new Error("not a project");
  return parsed;
};

describe("the record with its perks changed", () => {
  it("sets the perks and keeps every other tag, in order, and the content", () => {
    const before = project(TAGS);
    const next = recordWithPerks(
      before,
      "  Early looks at what we make.  ",
      5000,
    );
    expect(next.tags.slice(0, TAGS.length)).toEqual(TAGS);
    expect(next.tags.at(-1)).toEqual(["perks", "Early looks at what we make."]);
    expect(next.tags).toHaveLength(TAGS.length + 1);
    expect(next.content).toBe(before.event.content);
    expect(next.kind).toBe(37001);
  });

  it("replaces old perks, and clearing them removes only that tag", () => {
    const before = project([...TAGS, ["perks", "Old words"]]);
    expect(before.perks).toBe("Old words");
    const set = recordWithPerks(before, "New words", 5000);
    expect(set.tags.filter((t) => t[0] === "perks")).toEqual([
      ["perks", "New words"],
    ]);
    const cleared = recordWithPerks(before, "   ", 5000);
    expect(cleared.tags).toEqual(TAGS);
  });

  it("is later than the record it replaces, even in the same second", () => {
    const before = project(TAGS);
    expect(recordWithPerks(before, "x", 500).created_at).toBe(1001);
    expect(recordWithPerks(before, "x", 5000).created_at).toBe(5000);
  });

  it("refuses perks over 600 characters", () => {
    expect(() => recordWithPerks(project(TAGS), "x".repeat(601))).toThrow(
      /600/,
    );
    expect(
      recordWithPerks(project(TAGS), "x".repeat(600)).tags.at(-1)?.[1],
    ).toHaveLength(600);
  });

  it("is read back from a record, cut to its bound", () => {
    expect(project([...TAGS, ["perks", "x".repeat(900)]]).perks).toHaveLength(
      600,
    );
    expect(project(TAGS).perks).toBeNull();
  });
});
