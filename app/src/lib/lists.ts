/**
 * Every change to the person's saved-and-followed list (kind 10003) goes through one queue: the list replaces itself on
 * each write, so two changes built from the same copy would lose one (following a project a moment after saving a post
 * used to be able to drop the post). Changes run one at a time, each from the newest copy of the list (the server's, or
 * the one this tab last wrote if that is newer). Lists are scoped by server and person, so nothing written for one
 * account is read back for another.
 */
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import {
  createListWriter,
  type ListWrite,
} from "@creaton/core/social/feed/follow-queue.ts";
import { latestList } from "@creaton/core/social/feed/lists.ts";
import { publishAsUser, read } from "./relay";

export const listWriter = createListWriter({
  readLatest: async (write: ListWrite) =>
    latestList(
      await read({
        kinds: [write.kind],
        authors: [write.author],
        limit: 5,
      }),
      write.kind,
      write.author,
    ),
  publish: (template) =>
    publishAsUser(template, "That was not saved. Try again."),
});

/** The queue's scope for one person on this server. */
export const listScope = (me: string) => `${relayWsUrl()}|${me}`;
