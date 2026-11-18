import { parseLaunchCoordinate } from "../../feed/lib/feed-events.ts";

/** References only. Completing a task neither approves this claim nor sends money. */
export interface TaskDelivery {
  project: string;
  output: string | null;
  claim: { id: string; mandate: string } | null;
}

/** Only browser-safe links can be opened from a task's output. */
export function outputUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Ignore malformed references instead of querying an arbitrary address as a project. */
export function readDelivery(value: unknown): TaskDelivery | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.project !== "string" || !parseLaunchCoordinate(v.project))
    return null;
  const c = v.claim as Record<string, unknown> | null;
  const claim =
    c &&
    typeof c.id === "string" &&
    /^0x[0-9a-f]{64}$/i.test(c.id) &&
    typeof c.mandate === "string" &&
    /^0x[0-9a-f]{40}$/i.test(c.mandate)
      ? { id: c.id.toLowerCase(), mandate: c.mandate.toLowerCase() }
      : null;
  return { project: v.project, output: outputUrl(v.output), claim };
}

/** Index the reference without changing the task's channel or granting project authority. */
export function taskDeliveryTags(tags: string[][], value: unknown): string[][] {
  const delivery = readDelivery(value);
  return delivery &&
    !tags.some((t) => t[0] === "a" && t[1] === delivery.project)
    ? [...tags, ["a", delivery.project]]
    : tags;
}
