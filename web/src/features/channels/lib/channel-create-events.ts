/**
 * Pure event builders for web-side channel creation and membership.
 *
 * These mirror `crates/buzz-sdk/src/builders.rs` exactly:
 * - `build_create_channel` → kind 9007 (NIP-29 create-group)
 * - `build_add_member` → kind 9000 (NIP-29 add-member)
 *
 * The relay materializes kind:39000 metadata and kind:39002 membership as a
 * side effect of these writes (same path the desktop app and the e2e bridge
 * use), so the existing web channel-list read path picks new channels up
 * without any extra work.
 */

export type ChannelVisibilityChoice = "open" | "private";
export type ChannelTypeChoice = "stream" | "forum";
export type MemberRoleChoice = "owner" | "admin" | "member" | "guest" | "bot";

/** NIP-29 create-group. The relay derives kind:39000 metadata from it. */
export const KIND_CREATE_CHANNEL = 9007;
/** NIP-29 add-member. The relay folds it into kind:39002 membership. */
export const KIND_ADD_MEMBER = 9000;

export type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

export type CreateChannelEventInput = {
  /** Channel uuid (emitted as the `h` tag). */
  id: string;
  name: string;
  visibility: ChannelVisibilityChoice;
  channelType?: ChannelTypeChoice;
  /** Free-text topic, published as the `about` tag. */
  about?: string;
  /** Ephemeral lifetime in seconds; omitted for permanent channels. */
  ttlSeconds?: number;
};

/**
 * Canonical channel name: trim and strip leading `#` characters (matching
 * `buzz_core::channel::canonical_channel_name`). A name that is empty after
 * canonicalization is rejected.
 */
export function canonicalChannelName(name: string): string {
  return name.trim().replace(/^#+/, "").trim();
}

function checkHexPubkey(pubkey: string): void {
  if (pubkey.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkey)) {
    throw new Error("member pubkey must be 64 hex characters");
  }
}

/** Build the signed-event template for a new channel (kind 9007). */
export function buildCreateChannelEvent(
  input: CreateChannelEventInput,
): EventTemplate {
  const name = canonicalChannelName(input.name);
  if (!name) {
    throw new Error("channel name is required");
  }
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0)
  ) {
    throw new Error("ttl must be a positive whole number of seconds");
  }
  const tags: string[][] = [
    ["h", input.id],
    ["name", name],
  ];
  if (input.visibility === "open" || input.visibility === "private") {
    tags.push(["visibility", input.visibility]);
  } else {
    throw new Error('visibility must be "open" or "private"');
  }
  if (input.channelType) {
    tags.push(["channel_type", input.channelType]);
  }
  const about = input.about?.trim();
  if (about) {
    tags.push(["about", about]);
  }
  if (input.ttlSeconds !== undefined) {
    tags.push(["ttl", String(input.ttlSeconds)]);
  }
  return { kind: KIND_CREATE_CHANNEL, content: "", tags };
}

export type AddMemberEventInput = {
  /** Channel uuid. */
  channelId: string;
  /** 64-hex pubkey of the member (agent) being added. */
  pubkey: string;
  role?: MemberRoleChoice;
};

/** Build the signed-event template for adding a member (kind 9000). */
export function buildAddMemberEvent(input: AddMemberEventInput): EventTemplate {
  checkHexPubkey(input.pubkey);
  const tags: string[][] = [
    ["h", input.channelId],
    ["p", input.pubkey.toLowerCase()],
  ];
  if (input.role) {
    tags.push(["role", input.role]);
  }
  return { kind: KIND_ADD_MEMBER, content: "", tags };
}
