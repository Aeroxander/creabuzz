// What the team and the manager said, as rows among the room's posts (plan 4.6): the team's own updates and the work handed in,
// labelled, never a post by anyone else, newest first.
import { describe, expect, it } from "vitest";
import type { ProjectUpdate } from "../project/use-project";
import type { ProjectTask } from "../tasks/task-record";
import { noticesOf } from "./room-notices";

const FOUNDER = "f".repeat(64);
const MANAGER = "e".repeat(64);
const update = (
  id: string,
  author: string,
  at: number,
  title: string,
  body: string,
  kind: ProjectUpdate["kind"] = "update",
): ProjectUpdate => ({ id, author, at, title, body, kind });
const task = (id: string, what: string, handAt: number | null): ProjectTask =>
  ({
    id,
    author: FOUNDER,
    worker: "d".repeat(64),
    what,
    handIn: handAt === null ? null : { id: `h${id}`, at: handAt, note: "done" },
  }) as ProjectTask;

describe("the notices", () => {
  const roles = new Map([
    [MANAGER, "Manager"],
    [FOUNDER, "Founder"],
  ]);

  it("labels the team's words and the manager's, and leaves out a post by anyone", () => {
    const notices = noticesOf({
      updates: [
        update(
          "u1",
          FOUNDER,
          100,
          "Week 3",
          "We shipped the lids.\nMore soon.",
        ),
        update("u2", MANAGER, 200, "", "Checked the lamps.\nAll fine."),
        update("u3", "9".repeat(64), 300, "", "A post by someone", "post"),
      ],
      tasks: [],
      roles,
    });
    expect(notices.map((n) => [n.id, n.label, n.title])).toEqual([
      ["u2", "From the manager", "Checked the lamps."],
      ["u1", "From the team", "Week 3"],
    ]);
    expect(notices[1].body).toBe("We shipped the lids.\nMore soon.");
  });

  it("shows work handed in with the task's words and the date of the hand-in, and nothing for a task with none", () => {
    const notices = noticesOf({
      updates: [],
      tasks: [
        task("t1", "Paint the lids", 500),
        task("t2", "Wire the lamps", null),
      ],
      roles,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      at: 500,
      title: "Work handed in: Paint the lids",
      label: "From the team",
    });
  });

  it("is newest first, cut to the limit, and long words are shortened", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      update(`u${i}`, FOUNDER, i, "T", "b"),
    );
    expect(
      noticesOf({ updates: many, tasks: [], roles, limit: 5 }).map((n) => n.id),
    ).toEqual(["u29", "u28", "u27", "u26", "u25"]);
    const long = noticesOf({
      updates: [update("x", FOUNDER, 1, "t".repeat(200), "b".repeat(500))],
      tasks: [],
      roles,
    });
    expect(long[0].title.length).toBeLessThanOrEqual(81);
    expect(long[0].body.length).toBeLessThanOrEqual(241);
  });
});
