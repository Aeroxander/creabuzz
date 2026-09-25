import type { Channel, FeedItem } from "@/shared/api/types";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_PROGRESS,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";

/**
 * Getting-started checklist model (home + Settings surfaces).
 *
 * DONE-state detection is deliberately conservative (Review-Proven Rule 1):
 * a step may only render as done when the evidence is sound — `done` always
 * means the user really completed the step. Steps with no cheap, sound
 * detector render as plain action links (`"undetected"`), never as a fake
 * checkbox that could drift from reality.
 */

export type GettingStartedStepId =
  | "open-channel"
  | "say-hello"
  | "mention-agent"
  | "add-agent"
  | "run-workflow";

/**
 * - `"done"`: cheap, sound detection says the step is complete.
 * - `"todo"`: detection is available and says the step is not complete.
 * - `"undetected"`: no sound detector exists — render as an action link,
 *   never a checkbox (Rule 1).
 */
export type GettingStartedStepState = "done" | "todo" | "undetected";

export type GettingStartedAction =
  | { kind: "browse-channels" }
  | { kind: "create-channel" }
  | { kind: "open-channel"; channelId: string }
  | { kind: "open-agents" }
  | { kind: "open-workflows" };

export type GettingStartedStep = {
  id: GettingStartedStepId;
  title: string;
  description: string;
  state: GettingStartedStepState;
  actionLabel: string;
  action: GettingStartedAction;
};

export type GettingStartedInput = {
  /** Channels currently in the store (any type). */
  channels: readonly Channel[];
  /** Feed items across all home-feed buckets. */
  feedItems: readonly FeedItem[];
  /** Number of agents the user manages. */
  managedAgentCount: number;
  /** Normalized pubkey of the signed-in user, if known. */
  currentPubkey?: string | null;
};

const MESSAGE_KINDS: ReadonlySet<number> = new Set([
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
]);

const JOB_KINDS: ReadonlySet<number> = new Set([
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
]);

function isOwnItem(item: FeedItem, currentPubkey: string | null | undefined) {
  if (!currentPubkey) return false;
  return (
    item.pubkey.trim().toLowerCase() === currentPubkey.trim().toLowerCase()
  );
}

/**
 * Sound one-directional detector: a feed item we authored that is a real
 * message proves the user has posted. Feed items we authored that are not
 * messages (reminders, approval requests, job events) must not count.
 */
export function hasPostedMessage(
  feedItems: readonly FeedItem[],
  currentPubkey: string | null | undefined,
): boolean {
  return feedItems.some(
    (item) => isOwnItem(item, currentPubkey) && MESSAGE_KINDS.has(item.kind),
  );
}

/**
 * Sound one-directional detector: a job/workflow event we authored proves the
 * user ran a workflow. Job events about someone else's run (e.g. a request
 * targeting one of the user's agents) must not count as the user's own run.
 */
export function hasRunWorkflow(
  feedItems: readonly FeedItem[],
  currentPubkey: string | null | undefined,
): boolean {
  return feedItems.some(
    (item) => isOwnItem(item, currentPubkey) && JOB_KINDS.has(item.kind),
  );
}

/** First channel to open for "go talk in a channel" affordances. */
export function pickFirstConversationalChannel(
  channels: readonly Channel[],
): Channel | null {
  return channels.find((channel) => channel.channelType !== "dm") ?? null;
}

export function evaluateGettingStarted(
  input: GettingStartedInput,
): GettingStartedStep[] {
  const { channels, currentPubkey, feedItems, managedAgentCount } = input;
  const channelCount = channels.length;
  const firstChannel = pickFirstConversationalChannel(channels);
  const openChannelAction: GettingStartedAction = firstChannel
    ? { kind: "open-channel", channelId: firstChannel.id }
    : { kind: "browse-channels" };

  return [
    {
      id: "open-channel",
      title: "Create or open a channel",
      description: "Channels are where conversations, people, and agents meet.",
      state: channelCount > 0 ? "done" : "todo",
      actionLabel: channelCount > 0 ? "Browse channels" : "Create a channel",
      action:
        channelCount > 0
          ? { kind: "browse-channels" }
          : { kind: "create-channel" },
    },
    {
      id: "say-hello",
      title: "Say hello",
      description: "Post your first message in any channel.",
      state: hasPostedMessage(feedItems, currentPubkey) ? "done" : "todo",
      actionLabel: firstChannel ? "Open a channel" : "Browse channels",
      action: openChannelAction,
    },
    {
      id: "mention-agent",
      title: "Mention an agent",
      description:
        "Type @ in a message to bring an agent into the conversation.",
      // Message history is not visible from Home, so this step has no sound
      // detector — it renders as an action link, not a checkbox (Rule 1).
      state: "undetected",
      actionLabel: firstChannel ? "Open a channel" : "Browse channels",
      action: openChannelAction,
    },
    {
      id: "add-agent",
      title: "Add an agent to your team",
      description: "Agents answer questions and run work for you.",
      state: managedAgentCount > 0 ? "done" : "todo",
      actionLabel: "Open Agents",
      action: { kind: "open-agents" },
    },
    {
      id: "run-workflow",
      title: "Run a workflow",
      description: "Turn something you do repeatedly into one click.",
      state: hasRunWorkflow(feedItems, currentPubkey) ? "done" : "todo",
      actionLabel: "Open workflows",
      action: { kind: "open-workflows" },
    },
  ];
}

// ── Dismissal persistence ────────────────────────────────────────────────────

const DISMISS_STORAGE_KEY_PREFIX = "buzz-getting-started-dismissed.v1";

export function gettingStartedDismissedKey(pubkey: string | null | undefined) {
  return `${DISMISS_STORAGE_KEY_PREFIX}:${(pubkey ?? "").trim().toLowerCase()}`;
}

export function readGettingStartedDismissed(
  pubkey: string | null | undefined,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(gettingStartedDismissedKey(pubkey)) === "1"
    );
  } catch {
    return false;
  }
}

export function writeGettingStartedDismissed(
  pubkey: string | null | undefined,
  dismissed: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = gettingStartedDismissedKey(pubkey);
    if (dismissed) {
      window.localStorage.setItem(key, "1");
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage can throw on quota/full-disk; dismissal is cosmetic and
    // must never break the home surface.
  }
}
