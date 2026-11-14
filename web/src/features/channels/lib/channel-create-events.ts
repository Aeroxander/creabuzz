/**
 * Pure event builders for web-side channel creation and membership.
 *
 * These mirror `crates/buzz-sdk/src/builders.rs` exactly:
 * - `build_create_channel` → kind 9007 (NIP-29 create-group)
 * - `build_add_member` → kind 9000 (NIP-29 add-member)
 * - `build_update_channel` → kind 9002 (NIP-29 edit-metadata)
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
/** NIP-29 edit-metadata: change a room's or board's name, description or who can read it. */
export const KIND_EDIT_CHANNEL = 9002;
/** NIP-29 remove-user: take someone off a room or board. The server lets only its owners and admins remove others. */
const KIND_REMOVE_MEMBER = 9001;

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

/** Build the signed-event template for removing someone from a room or board (kind 9001). */
export function buildRemoveMemberEvent(input: {
  channelId: string;
  pubkey: string;
}): EventTemplate {
  checkHexPubkey(input.pubkey);
  return {
    kind: KIND_REMOVE_MEMBER,
    content: "",
    tags: [
      ["h", input.channelId],
      ["p", input.pubkey.toLowerCase()],
    ],
  };
}

export type EditChannelEventInput = {
  /** Channel uuid (emitted as the `h` tag). */
  channelId: string;
  /** A new name; left out to keep it. */
  name?: string;
  /** A new description, published as the `about` tag; an empty one clears it. Left out to keep it. */
  about?: string;
  /** Who can read it from now on; left out to keep it. */
  visibility?: ChannelVisibilityChoice;
};

/**
 * Build the signed-event template for changing a room or board (kind 9002), with a tag for each thing that changes.
 * The server lets only its owners and admins send it. At least one change is required.
 */
export function buildEditChannelEvent(
  input: EditChannelEventInput,
): EventTemplate {
  const tags: string[][] = [["h", input.channelId]];
  if (input.name !== undefined) {
    const name = canonicalChannelName(input.name);
    if (!name) throw new Error("channel name is required");
    tags.push(["name", name]);
  }
  if (input.about !== undefined) tags.push(["about", input.about.trim()]);
  if (input.visibility !== undefined) {
    if (input.visibility !== "open" && input.visibility !== "private") {
      throw new Error('visibility must be "open" or "private"');
    }
    tags.push(["visibility", input.visibility]);
  }
  if (tags.length === 1) throw new Error("nothing to change");
  return { kind: KIND_EDIT_CHANNEL, content: "", tags };
}

/**
 * What changed between a room or board as it is and the form's values, as an edit: only the fields that differ, so a
 * description left alone is not rewritten. Null when nothing changed.
 */
export function channelEdits(
  current: {
    name: string;
    description: string;
    visibility: "public" | "private";
  },
  wanted: {
    name: string;
    description: string;
    visibility: ChannelVisibilityChoice;
  },
): Omit<EditChannelEventInput, "channelId"> | null {
  const edits: Omit<EditChannelEventInput, "channelId"> = {};
  const name = canonicalChannelName(wanted.name);
  if (name !== current.name) edits.name = name;
  if (wanted.description.trim() !== current.description.trim())
    edits.about = wanted.description.trim();
  const now: ChannelVisibilityChoice =
    current.visibility === "private" ? "private" : "open";
  if (wanted.visibility !== now) edits.visibility = wanted.visibility;
  return Object.keys(edits).length === 0 ? null : edits;
}
