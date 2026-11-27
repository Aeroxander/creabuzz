// The report record is exactly what the server accepts.
import { describe, expect, it } from "vitest";
import type { SignedEvent } from "../posts/use-posts";
import { reportRecord } from "./room-records";

const ANA = "2".repeat(64);

describe("the report record", () => {
  it("names the post and its author with one of the server's types", () => {
    const post = {
      id: "1".repeat(64),
      pubkey: ANA,
      kind: 1,
      created_at: 1,
      tags: [],
      content: "",
      sig: "",
    } as SignedEvent;
    expect(reportRecord(post, "spam")).toEqual({
      kind: 1984,
      tags: [
        ["e", post.id, "spam"],
        ["p", ANA],
      ],
      content: "",
    });
  });
});
