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

import { type NewTaskInput, newTaskRow, taskRowTags } from "./task-row";

export type { NewTaskInput };

/** Sign `tags` + `body` as the user and publish them; throws `failure` text when refused. */
export async function publishTaskEvent(
  tags: string[][],
  body: Record<string, unknown>,
  failure: string,
): Promise<void> {
  const signed = await signAsUser({
    kind: KIND_AGENT_TASK,
    tags: taskRowTags(tags, body),
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
  const row = newTaskRow(input, id);
  await publishTaskEvent(row.tags, row.body, "task publish rejected");
}
