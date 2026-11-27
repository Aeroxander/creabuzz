/**
 * The record a report is sent as. Pure. The server checks it against its own rules
 * (`docs/next-version/ROOM-AND-SEASON-RECORDS.md`, section 4); the shape here is exactly what it accepts.
 */
import { KIND_REPORT } from "@creaton/core/kinds.ts";
import type { SignedEvent } from "../posts/use-posts";
import type { ReportChoice } from "./room-words";

/** Tell the people who run the server about a post: it goes to their queue and nowhere else. */
export function reportRecord(post: SignedEvent, type: ReportChoice) {
  return {
    kind: KIND_REPORT,
    tags: [
      ["e", post.id, type],
      ["p", post.pubkey],
    ],
    content: "",
  };
}
