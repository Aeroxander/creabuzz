// What a Pair's second signer reads as the reason for a draw ("the pay for the task X") comes from the page's own task
// records, which one team member can write end to end: post it, have a throwaway account take it for their own wallet, accept
// it. So the sentence carries who accepted the task and who took it, and is never the page vouching for a draw alone.
import { describe, expect, it } from "vitest";
import { owedTaskNames } from "./use-tasks";
import {
  acceptRecord,
  postTaskRecord,
  projectTasks,
  takeRecord,
  type TaskRecordEvent,
} from "./task-record";

const SIGNER = "f".repeat(64);
const PUPPET = "a".repeat(64);
const COORD = `37001:${SIGNER}:orbit`;
const MY_WALLET = "0x00000000000000000000000000000000000000cd";
let n = 0;
const sign = (
  pubkey: string,
  t: { tags: string[][]; content: string },
  at: number,
): TaskRecordEvent => {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    tags: t.tags,
    content: t.content,
  };
};

describe("a task named to a Pair's second signer", () => {
  it("carries who accepted it and who took it, so a draw the proposer made for their own task reads as that", () => {
    const post = sign(
      SIGNER,
      postTaskRecord(COORD, "Fix the website", 900),
      1_800_000_000,
    );
    const [open] = projectTasks([post], COORD, new Set([SIGNER]));
    const take = sign(
      PUPPET,
      takeRecord(COORD, open, MY_WALLET),
      1_800_000_100,
    );
    const evidence = sign(
      PUPPET,
      {
        tags: [
          ["a", COORD],
          ["l", "creaton-task"],
          ["task-part", "evidence"],
          ["task", post.id],
        ],
        content: JSON.stringify({ title: "done", body: "done" }),
      },
      1_800_000_200,
    );
    const [submitted] = projectTasks(
      [post, take, evidence],
      COORD,
      new Set([SIGNER]),
    );
    const accept = sign(
      SIGNER,
      acceptRecord(COORD, { ...submitted }, submitted.handIn?.id ?? "", null),
      1_800_000_300,
    );
    const tasks = projectTasks(
      [post, take, evidence, accept],
      COORD,
      new Set([SIGNER]),
    );
    expect(tasks[0].state).toBe("accepted");
    const who = (pubkey: string) =>
      pubkey === SIGNER ? "Sam" : "A new account";
    const names = owedTaskNames(tasks, MY_WALLET, 900_000_000n, who);
    expect(names).toEqual([
      { name: "Fix the website", acceptedBy: "Sam", takenBy: "A new account" },
    ]);
    // A wallet or an amount that is not the task's is not named.
    expect(owedTaskNames(tasks, MY_WALLET, 800_000_000n, who)).toEqual([]);
  });
});
