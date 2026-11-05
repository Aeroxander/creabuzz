/**
 * What the wiki tells the user about live co-editing.
 *
 * Live co-editing runs peer-to-peer and applies a peer's update only if the
 * peer proves it is a community member (the relay + `live-members.ts`). That makes three
 * honest states, and the editor must say which one it is in:
 *
 * - unavailable: it cannot run here (no identity to prove membership, no
 *   member list to check peers against, no peer-to-peer room, …). Edits reach
 *   others only when a page is saved.
 * - verified: it runs, and only verified members can take part.
 * - connecting: still deciding.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */

type LiveUnavailableReason =
  | "no-identity"
  | "no-member-list"
  | "member-list-error"
  | "not-member"
  | "room-failed"
  | "cannot-sign"
  | "too-large";

export type LiveStatus =
  | { state: "connecting" }
  | { state: "verified" }
  | { state: "unavailable"; reason: LiveUnavailableReason };

const SAVE_FALLBACK = "Edits reach others when a page is saved.";

const UNAVAILABLE_DETAIL: Record<LiveUnavailableReason, string> = {
  "no-identity": `Live co-editing is unavailable: you need to be signed in with an account so the page can tell you are a community member. ${SAVE_FALLBACK}`,
  "no-member-list": `Live co-editing is unavailable: this server publishes no member list, so we cannot tell who is a member. ${SAVE_FALLBACK}`,
  "member-list-error": `Live co-editing is unavailable: the community member list could not be loaded. Reopen the page to try again. ${SAVE_FALLBACK}`,
  "not-member": `Live co-editing is unavailable: it is limited to verified community members and this account is not one. ${SAVE_FALLBACK}`,
  "room-failed": `Live co-editing is unavailable: the shared editing session could not be started. Reopen the page to try again. ${SAVE_FALLBACK}`,
  "cannot-sign": `Live co-editing is unavailable: your changes could not be confirmed with your account. Unlock your passkey or approve the request, then reopen the page. ${SAVE_FALLBACK}`,
  "too-large": `Live co-editing is unavailable: this page is too large to sync live. ${SAVE_FALLBACK}`,
};

export interface LiveDescription {
  /** Short visible chip text. */
  chip: string;
  /** Full sentence(s) for the tooltip / assistive text. */
  detail: string;
  /** Who is editing: "Editing alone" or "N editing" (verified peers + you). */
  editors: string;
}

/**
 * Copy for the editor's live-editing indicator. `peers` counts VERIFIED other
 * editors; `strangers` are peers in the room that have not proved membership;
 * `rejected` is how many received updates were dropped.
 */
export function describeLive(
  status: LiveStatus,
  counts: { peers: number; strangers?: number; rejected?: number },
): LiveDescription {
  const editors =
    counts.peers === 0 ? "Editing alone" : `${counts.peers + 1} editing`;
  const notes: string[] = [];
  if ((counts.strangers ?? 0) > 0) {
    notes.push(
      `${counts.strangers} ${counts.strangers === 1 ? "person who is not a confirmed member is" : "people who are not confirmed members are"} connected to this page and ${counts.strangers === 1 ? "gets" : "get"} none of your changes.`,
    );
  }
  if ((counts.rejected ?? 0) > 0) {
    notes.push(
      `${counts.rejected} ${counts.rejected === 1 ? "change" : "changes"} from others ${counts.rejected === 1 ? "was" : "were"} ignored (not confirmed, not valid, or not from a member).`,
    );
  }
  const suffix = notes.length > 0 ? ` ${notes.join(" ")}` : "";

  switch (status.state) {
    case "connecting":
      return {
        chip: "Live: connecting",
        detail: "Checking who may co-edit this page live.",
        editors,
      };
    case "unavailable":
      return {
        chip: "Live co-editing unavailable",
        detail: UNAVAILABLE_DETAIL[status.reason] + suffix,
        editors,
      };
    case "verified":
      return {
        chip: "Live: verified members only",
        detail:
          counts.peers === 0
            ? `Live co-editing is on for verified community members only. Nobody else is connected; ${SAVE_FALLBACK.toLowerCase()}${suffix}`
            : `${counts.peers} other verified ${counts.peers === 1 ? "member is" : "members are"} connected. Only changes confirmed as coming from community members are applied.${suffix}`,
        editors,
      };
  }
}
