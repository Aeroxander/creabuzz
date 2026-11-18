/**
 * Turning a `/query` reply into records, or into the failure the screen shows.
 *
 * Pure (no aliases), so the node test runner binds the same code `queryEventsHttp` runs.
 */

import { friendlyRelayError } from "./relay-errors.ts";
import { relayAnswered } from "./relay-failure.ts";
import {
  isSignedRecordList,
  type SignedRecordShape,
  type TimedReply,
} from "./timed-fetch.ts";

/** What the screen says when the server answered 200 with something that is not a list of records. */
export const UNREADABLE_QUERY_REPLY =
  "The server's reply could not be read. Try again; if it keeps happening, tell the site's organiser.";

/**
 * The records in a `/query` reply.
 *
 * Throws a tagged answered refusal for an error status (with the server's own words when it gave them, so `missing
 * Nostr auth` classifies as sign-in-needed and anything else as a refusal, never as "did not answer") and for a 200
 * whose body is not a list of signed records.
 */
export function queryReplyEvents(
  reply: Pick<TimedReply, "json"> & {
    response: { ok: boolean; status: number };
  },
): SignedRecordShape[] {
  const { response, json } = reply;
  if (!response.ok) {
    const stated =
      json && typeof json === "object" && !Array.isArray(json)
        ? (json as { error?: unknown }).error
        : undefined;
    throw relayAnswered(
      typeof stated === "string" && stated.length > 0
        ? friendlyRelayError(stated)
        : `server responded ${response.status}`,
    );
  }
  if (!isSignedRecordList(json)) throw relayAnswered(UNREADABLE_QUERY_REPLY);
  return json;
}
