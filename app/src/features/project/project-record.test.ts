import { describe, expect, it } from "vitest";
import {
  latestProjects,
  parseProject,
  parseProjectRef,
  projectPath,
  recordWithTeam,
  slugFromName,
} from "./project-record";

const FOUNDER = "a".repeat(64);
const MATE = "b".repeat(64);

function record(at: number, tags: string[][] = [], content: object = {}) {
  return {
    id: `id${at}`,
    pubkey: FOUNDER,
    kind: 37001,
    created_at: at,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ["chain", "11155111"],
      ...tags,
    ],
    content: JSON.stringify({
      pitch: "Maps for night skies",
      stage: "draft",
      ...content,
    }),
  };
}

describe("project record", () => {
  it("reads the fields the app shows", () => {
    const project = parseProject(record(200, [], { started: 100 }));
    expect(project?.name).toBe("Nebula");
    expect(project?.pitch).toBe("Maps for night skies");
    expect(project?.startedAt).toBe(100);
    expect(project?.coordinate).toBe(`37001:${FOUNDER}:nebula`);
    expect(project?.topics).toEqual([]);
  });

  it("refuses a record with no name", () => {
    const bad = record(1);
    bad.tags = bad.tags.filter((t) => t[0] !== "name");
    expect(parseProject(bad)).toBeNull();
  });

  it("keeps the newest version of each project", () => {
    const list = latestProjects([record(1), record(5), record(3)]);
    expect(list).toHaveLength(1);
    expect(list[0].updatedAt).toBe(5);
  });

  it("makes and reads web/'s project links", () => {
    const project = parseProject(record(1));
    if (!project) throw new Error("no project");
    const path = projectPath(project);
    expect(path).toBe(`/p/nebula-${FOUNDER.slice(0, 16)}`);
    expect(parseProjectRef(path.slice(3))).toEqual({
      id: "nebula",
      founderPrefix: FOUNDER.slice(0, 16),
    });
    expect(parseProjectRef("no-prefix")).toBeNull();
  });

  it("changes only the team when the founder accepts someone, and signs later than before", () => {
    const project = parseProject(record(500));
    if (!project) throw new Error("no project");
    const next = recordWithTeam(
      project,
      [{ pubkey: MATE, role: "member", invite: "inv1" }],
      [],
      400,
    );
    expect(next.created_at).toBe(501);
    expect(next.content).toBe(project.event.content);
    expect(next.tags).toContainEqual(["chain", "11155111"]);
    expect(next.tags).toContainEqual(["team", MATE, "member"]);
    expect(next.tags).toContainEqual(["team-invite", MATE, "inv1"]);
    expect(next.tags).toContainEqual(["p", MATE]);
  });

  it("makes an id from a name", () => {
    expect(slugFromName("  Night Sky Maps! ")).toBe("night-sky-maps");
  });
});
