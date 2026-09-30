/**
 * Community moderation command builders. Shapes are pinned to the canonical
 * SDK builders (crates/buzz-sdk/src/builders.rs `build_moderation_*` and
 * `build_delete_message`), which the desktop moderation surface publishes
 * verbatim (desktop/src/shared/api/moderation.ts); unit tests bind them so a
 * drifted tag fails the suite.
 *
 * Kinds come from the canonical table in `@creaton/core`.
 */

import {
  KIND_MODERATION_BAN,
  KIND_MODERATION_RESOLVE_REPORT,
  KIND_MODERATION_TIMEOUT,
  KIND_NIP29_DELETE_EVENT,
} from "@creaton/core/kinds.ts";

export type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

export type ResolutionStatus = "resolved" | "dismissed";

const HEX_64 = /^[0-9a-f]{64}$/;

function requireHex64(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_64.test(normalized)) {
    throw new Error(`${label} must be a 64-character hex id`);
  }
  return normalized;
}

/**
 * Resolve-report command (kind:9044). `dismiss` pairs with `dismissed`;
 * every other action pairs with `resolved` (the server enforces the
 * pairing). `reason` is reporter-readable — it must be safe for the
 * reporter to see.
 */
export function buildResolveReport(input: {
  reportEventId: string;
  action: "delete" | "timeout" | "ban" | "dismiss" | "escalate";
  reason?: string;
}): EventTemplate {
  const reportEventId = requireHex64(input.reportEventId, "report id");
  const status: ResolutionStatus =
    input.action === "dismiss" ? "dismissed" : "resolved";
  const tags: string[][] = [
    ["report", reportEventId],
    ["status", status],
    ["action", input.action],
  ];
  if (input.reason?.trim()) tags.push(["reason", input.reason.trim()]);
  return {
    kind: KIND_MODERATION_RESOLVE_REPORT,
    content: "",
    tags,
  };
}

/** Ban command (kind:9040). `expiresAt` unix-secs ⇒ temporary; omit ⇒ permanent. */
export function buildBan(input: {
  pubkey: string;
  expiresAt?: number;
  reason?: string;
}): EventTemplate {
  const pubkey = requireHex64(input.pubkey, "member id");
  const tags: string[][] = [["p", pubkey]];
  if (input.expiresAt != null) {
    tags.push(["expiration", String(input.expiresAt)]);
  }
  if (input.reason?.trim()) tags.push(["reason", input.reason.trim()]);
  return { kind: KIND_MODERATION_BAN, content: "", tags };
}

/** Timeout (write-block) command (kind:9042). `expiresAt` is required. */
export function buildTimeout(input: {
  pubkey: string;
  expiresAt: number;
  reason?: string;
}): EventTemplate {
  const pubkey = requireHex64(input.pubkey, "member id");
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("timeout needs an expiry time");
  }
  const tags: string[][] = [
    ["p", pubkey],
    ["expiration", String(input.expiresAt)],
  ];
  if (input.reason?.trim()) tags.push(["reason", input.reason.trim()]);
  return { kind: KIND_MODERATION_TIMEOUT, content: "", tags };
}

/**
 * Content-delete command (kind:9005). The server soft-deletes the target;
 * the `h` tag scopes the delete to the channel the message lives in.
 */
export function buildDeleteContent(input: {
  channelId: string;
  eventId: string;
}): EventTemplate {
  const channelId = input.channelId.trim();
  if (!channelId) throw new Error("channel id is required");
  const eventId = requireHex64(input.eventId, "message id");
  return {
    kind: KIND_NIP29_DELETE_EVENT,
    content: "",
    tags: [
      ["h", channelId],
      ["e", eventId],
    ],
  };
}
