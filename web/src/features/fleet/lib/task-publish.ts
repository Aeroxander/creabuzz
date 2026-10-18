/**
 * Writing a task row: a new task, or the next version of an existing one.
 *
 * A task is a replaceable record keyed by its `d` tag, so every change is a
 * fresh row with the same `d` and the latest wins. The Agents page and the Work
 * board both write rows; this is the one place that signs them as the user,
 * sends them, and refuses loudly when the server does not take them.
 */

import { KIND_AGENT_TASK } from "@/shared/constants/kinds";
import { signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

import type { TaskPriority } from "../use-agent-tasks";
import type { TaskSource } from "./task-source";
import { taskDeliveryTags } from "./task-delivery";

/** What a person fills in to create a task. */
export interface NewTaskInput {
  /** A fixed task id, so sending the same task twice writes one task, not two. */
  id?: string;
  title: string;
  description?: string;
  assignee?: string;
  channelId?: string;
  parentEventId?: string;
  priority?: TaskPriority;
  due?: number | null;
  labels?: string[];
  /** Left out of the row when undefined; `null` writes an explicit "none". */
  milestone?: string | null;
  reward?: number | null;
  /** The board post this task was made from. */
  source?: TaskSource;
}

/** Sign `tags` + `body` as the user and publish them; throws `failure` text when refused. */
export async function publishTaskEvent(
  tags: string[][],
  body: Record<string, unknown>,
  failure: string,
): Promise<void> {
  const signed = await signAsUser({
    kind: KIND_AGENT_TASK,
    tags: taskDeliveryTags(tags, body.delivery),
    content: JSON.stringify(body),
  });
  const result = await publishEvent(relayWsUrl(), signed, {
    signAuth: signAsUser,
  });
  if (!result.accepted) throw new Error(result.message ?? failure);
}

/** Create a task: a new `d`, assigned when it names an assignee, open otherwise. */
export async function publishNewTask(input: NewTaskInput): Promise<void> {
  const id =
    input.id ??
    `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tags: string[][] = [["d", id]];
  if (input.assignee) tags.push(["p", input.assignee]);
  if (input.parentEventId) tags.push(["e", input.parentEventId]);
  if (input.channelId) tags.push(["h", input.channelId]);
  await publishTaskEvent(
    tags,
    {
      title: input.title,
      description: input.description ?? "",
      status: input.assignee ? "assigned" : "open",
      priority: input.priority ?? "normal",
      due: input.due ?? null,
      labels: input.labels ?? [],
      ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
      ...(input.reward !== undefined ? { reward: input.reward } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
    "task publish rejected",
  );
}
