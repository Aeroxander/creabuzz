/**
 * An idea: the first, commitment-free step of a launch.
 *
 * It is the same launch record the sale uses, with every economic field left
 * empty — no token, split, price or chain. Founders get a public page, a team
 * room and a supporters room in under a minute; the sale is prepared later
 * (`PrepareSaleCard`), once enough people have said they want it.
 *
 * Alias-free on purpose: `idea.test.mjs` drives it under `node --test`.
 */

import type { CreateLaunchInput } from "../use-launches.ts";
import {
  LAUNCH_DEFAULTS,
  type LaunchChat,
  type LaunchRecord,
} from "../models.ts";
import { slugFromName } from "./wizard.ts";

/**
 * Supporters a founder is nudged to gather before setting up a sale. The count
 * is free to produce, so this guides the founder; it is not a defence.
 */
export const SUPPORTER_GATE = 10;

export const IDEA_NAME_MAX = 60;
export const IDEA_PITCH_MAX = 140;

/** True while a launch has no sale terms at all: just a name, a pitch and people. */
export function isIdea(
  record: Pick<
    LaunchRecord,
    "stage" | "auction" | "token" | "requiredRaised" | "floorPrice"
  >,
): boolean {
  return (
    record.stage === "draft" &&
    !record.auction &&
    !record.token &&
    !record.requiredRaised &&
    !record.floorPrice
  );
}

/** Why an idea cannot be published yet, or null when it can. */
export function ideaIssue(input: {
  name: string;
  pitch: string;
}): string | null {
  const name = input.name.trim();
  if (name.length < 2) return "Give your idea a name.";
  if (name.length > IDEA_NAME_MAX) {
    return `Keep the name under ${IDEA_NAME_MAX} characters.`;
  }
  if (slugFromName(name) === "") {
    return "Use at least one letter or number in the name.";
  }
  const pitch = input.pitch.trim();
  if (pitch.length < 10) return "Say what it is in a sentence.";
  if (pitch.length > IDEA_PITCH_MAX) {
    return `Keep the one-liner under ${IDEA_PITCH_MAX} characters.`;
  }
  return null;
}

/**
 * The launch id for a new idea: the name's slug, with a short suffix when the
 * founder already has that id (publishing it again would silently replace the
 * other launch).
 */
export function ideaId(
  name: string,
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const base = slugFromName(name) || "idea";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = Math.floor(random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0");
    const candidate = `${base.slice(0, 59)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** The record an idea publishes: no chain, no money, nothing to undo. */
export function ideaToInput(idea: {
  id: string;
  name: string;
  pitch: string;
  image?: string;
  category?: string;
  chat: LaunchChat;
}): CreateLaunchInput {
  return {
    id: idea.id,
    name: idea.name.trim(),
    pitch: idea.pitch.trim(),
    ...(idea.image?.trim() ? { image: idea.image.trim() } : {}),
    ...(idea.category?.trim() ? { category: idea.category.trim() } : {}),
    stage: "draft",
    chainId: "",
    currency: "",
    floorPrice: "",
    tickSpacing: "",
    requiredRaised: "",
    auction: "",
    token: "",
    treasury: "",
    admission: LAUNCH_DEFAULTS.admission,
    channels: [],
    chat: idea.chat,
  };
}

export interface GateProgress {
  count: number;
  needed: number;
  open: boolean;
  /** 0–100, for the bar. */
  percent: number;
}

/** How far the supporter count is toward the nudge. */
export function gateProgress(supporters: number): GateProgress {
  const count = Math.max(0, Math.floor(supporters));
  return {
    count,
    needed: SUPPORTER_GATE,
    open: count >= SUPPORTER_GATE,
    percent: Math.min(100, Math.round((count / SUPPORTER_GATE) * 100)),
  };
}
