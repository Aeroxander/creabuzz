/**
 * Direct-message event shapes shared by the Creaton web and desktop apps.
 *
 * DMs are relay-managed private channels: a signed open command asks the
 * relay to derive (or surface) the canonical conversation channel, and the
 * relay confirms it with a signed "created" notice. Messages inside the
 * conversation then flow over the normal channel message path — this module
 * owns only the command/notice tag shapes and their parsing.
 *
 * Tag shapes follow the SDK builders in `crates/buzz-sdk/src/builders.rs`
 * (`build_dm_open`, `build_dm_add_member`) and the CLI flows in
 * `crates/buzz-cli/src/commands/dms.rs`.
 */

/** Relay-signed notice: a DM conversation exists for these participants. */
export const KIND_DM_CREATED = 41001;
/** Open (or surface) a DM conversation; `p` tags name the participants. */
export const KIND_DM_OPEN = 41010;
/** Relay-signed per-viewer snapshot of hidden DM conversations. */
export const KIND_DM_VISIBILITY = 30622;

/** The open command accepts 1–8 participants (excluding the sender). */
const DM_MAX_PARTICIPANTS = 8;

/** The minimal event shape this module reads. */
export interface DmTaggedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  /** Who signed it, where it matters (a direct thread's metadata record). */
  pubkey?: string;
}

const HEX_64 = /^[0-9a-f]{64}$/i;

function normalizePubkey(pubkey: string, index: number): string {
  const trimmed = pubkey.trim().toLowerCase();
  if (!HEX_64.test(trimmed)) {
    throw new Error(
      `participant ${index + 1} is not a 64-character public key`,
    );
  }
  return trimmed;
}

/**
 * Tags for a DM open command (kind 41010): one `p` tag per participant.
 *
 * Participants must be 1–8 hex public keys; duplicates are collapsed and
 * values are normalized to lowercase.
 */
export function buildDmOpenTags(pubkeys: string[]): string[][] {
  const unique = new Map<string, string>();
  pubkeys.forEach((pubkey, index) => {
    const normalized = normalizePubkey(pubkey, index);
    if (!unique.has(normalized)) unique.set(normalized, normalized);
  });
  if (unique.size === 0) {
    throw new Error("a conversation needs at least one participant");
  }
  if (unique.size > DM_MAX_PARTICIPANTS) {
    throw new Error(
      `a conversation supports up to ${DM_MAX_PARTICIPANTS} participants`,
    );
  }
  return [...unique.keys()].map((pubkey) => ["p", pubkey]);
}

/** The relay's confirmation of a DM open command. */
export interface DmOpenAck {
  channelId: string;
  created: boolean;
}

/**
 * Parse the relay's OK-message payload for a DM open command.
 *
 * The payload is `response:<json>` where the JSON carries the canonical
 * `channel_id` (and whether the conversation was newly created). A payload
 * without a usable channel id throws — the caller must not treat an
 * unconfirmed conversation as open.
 */
export function parseDmOpenAck(message: string | undefined | null): DmOpenAck {
  const raw = (message ?? "").trim();
  const json = raw.startsWith("response:")
    ? raw.slice("response:".length)
    : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("the server did not confirm the conversation");
  }
  const channelId =
    typeof parsed === "object" && parsed !== null && "channel_id" in parsed
      ? (parsed as { channel_id?: unknown }).channel_id
      : undefined;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("the server did not confirm the conversation");
  }
  const created =
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { created?: unknown }).created === true;
  return { channelId, created };
}

/** A parsed relay-signed DM conversation notice (kind 41001). */
export interface DmCreatedNotice {
  dmId: string;
  participants: string[];
  createdAt: number;
}

/**
 * Parse a kind 41001 notice into its conversation id and participants.
 * Returns null when the event is not a usable notice (missing `d` or `p`).
 */
export function parseDmCreated(event: DmTaggedEvent): DmCreatedNotice | null {
  if (event.kind !== KIND_DM_CREATED) return null;
  const dmId = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!dmId) return null;
  const participants = event.tags
    .filter(
      (tag) =>
        tag[0] === "p" && typeof tag[1] === "string" && tag[1].length > 0,
    )
    .map((tag) => (tag[1] as string).toLowerCase());
  if (participants.length === 0) return null;
  return { dmId, participants, createdAt: event.created_at };
}

/**
 * Hidden conversation ids from a kind 30622 visibility snapshot: the `h`
 * tags name the DMs the viewer currently has hidden. The latest snapshot is
 * authoritative — no delta merge is needed.
 */
export function hiddenDmIds(event: DmTaggedEvent): string[] {
  if (event.kind !== KIND_DM_VISIBILITY) return [];
  return event.tags
    .filter(
      (tag) =>
        tag[0] === "h" && typeof tag[1] === "string" && tag[1].length > 0,
    )
    .map((tag) => tag[1] as string);
}

/**
 * Whether a kind 39000 channel-metadata event describes a DM conversation.
 * Prefers the explicit `t` type tag, falling back to the `hidden` marker.
 */
export function isDmChannelMetadata(event: DmTaggedEvent): boolean {
  const type = event.tags.find((tag) => tag[0] === "t")?.[1];
  if (type !== undefined) return type === "dm";
  return event.tags.some((tag) => tag[0] === "hidden");
}

/** A group's metadata record (NIP-29 kind 39000). */
const GROUP_METADATA = 39000;

/**
 * A conversation from a direct thread's own metadata record (kind 39000, marked as a DM), for threads the server opened
 * itself (a moderation notice) and so never announced with a creation notice. Null for anything else.
 */
export function parseDmMetadata(event: DmTaggedEvent): DmCreatedNotice | null {
  if (event.kind !== GROUP_METADATA || !isDmChannelMetadata(event)) return null;
  const dmId = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!dmId) return null;
  const participants = event.tags
    .filter(
      (tag) =>
        tag[0] === "p" && typeof tag[1] === "string" && tag[1].length > 0,
    )
    .map((tag) => (tag[1] as string).toLowerCase());
  if (participants.length === 0) return null;
  // The record names the thread's members. A thread the server opened with one person lists only them: the other side
  // is the server's own account, which signs the record (and the notices in it).
  const signer = event.pubkey?.toLowerCase();
  if (participants.length === 1 && signer && signer !== participants[0])
    participants.push(signer);
  return { dmId, participants, createdAt: event.created_at };
}

/**
 * Display label for a conversation: the other participants' resolved names
 * when available, otherwise shortened keys. `nameOf` resolves a pubkey.
 */
export function dmConversationLabel(
  participants: string[],
  nameOf: (pubkey: string) => string | undefined,
  selfPubkey?: string,
): string {
  const others = participants.filter(
    (pubkey) => pubkey !== (selfPubkey ?? "").toLowerCase(),
  );
  const names = others.map(
    (pubkey, index) =>
      nameOf(pubkey) ??
      `unknown (${pubkey.slice(0, 8)}${index === 0 ? "" : ""})`,
  );
  if (names.length === 0) return "conversation";
  return names.join(", ");
}
