import { describe, expect, it } from "vitest";
import {
  goalRecordTemplate,
  pitchFromGoal,
  projectId,
  projectRecordTemplate,
  startProblems,
  startReady,
} from "./start-record";

const FOUNDER = "f".repeat(64);
const draft = {
  name: "Night Sky Maps",
  goal: "Ship a map of the night sky that ten people use.",
  how: "Ten people use it weekly.",
};

describe("Start's records", () => {
  it("needs the three answers", () => {
    expect(startReady(draft)).toBe(true);
    expect(startReady({ ...draft, how: " " })).toBe(false);
    expect(startProblems({ ...draft, name: "x".repeat(81) }).name).toBeTruthy();
  });

  it("writes the project record as web/'s Start does", () => {
    const record = projectRecordTemplate("night-sky-maps", draft, 1000);
    expect(record.kind).toBe(37001);
    expect(record.tags).toEqual([
      ["d", "night-sky-maps"],
      ["name", "Night Sky Maps"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ]);
    expect(JSON.parse(record.content)).toEqual({
      pitch: draft.goal,
      stage: "draft",
      started: 1000,
    });
  });

  it("names the project from its goal record", () => {
    const goal = goalRecordTemplate(
      FOUNDER,
      "night-sky-maps",
      draft,
      () => 0.5,
    );
    expect(goal.kind).toBe(47003);
    expect(goal.tags[0]).toEqual(["a", `37001:${FOUNDER}:night-sky-maps`]);
    expect(goal.tags).toContainEqual(["goal-level", "primary"]);
    expect(goal.tags).toContainEqual(["goal-how", draft.how]);
  });

  it("gives a new id when the founder already has one by that name", () => {
    expect(projectId("Night Sky", () => false)).toBe("night-sky");
    const taken = new Set(["night-sky"]);
    expect(
      projectId(
        "Night Sky",
        (id) => taken.has(id),
        () => 0,
      ),
    ).toBe("night-sky-0000");
  });

  it("cuts a long goal at a word for the line under the name", () => {
    const pitch = pitchFromGoal(`${"word ".repeat(60)}end`);
    expect(pitch.length).toBeLessThanOrEqual(140);
    expect(pitch.endsWith("…")).toBe(true);
  });
});
