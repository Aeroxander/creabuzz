import type { ProfileMetadata } from "../../../lib/profiles";
import type { ProjectNumbers } from "../../money/numbers";
import type { Project } from "../../project/project-record";
import type { ProjectTask } from "../task-record";
import type { ChainTask, ChainTasks } from "./types";

/**
 * What the three slots of a task card get (`slots.tsx`). Everything a card already knows, plus the network's row for this
 * task record, found by the record's id (`chainRowOf`). The slots read the chain themselves for anything a press needs.
 */
export interface TaskSlotProps {
  project: Project;
  /** The team's task record, as the Tasks tab reads it. */
  task: ProjectTask;
  /**
   * The row of the signed record whose `what` is this task record's id: the plan that binds, or else the latest one that
   * ended. Null when the task has no plan on the network. Whether it ties to this record is `tieOf(chain, task)`: a slot
   * decides that itself, so a card with no tie shows the network's numbers and not the record's words.
   */
  chain: ChainTask | null;
  /** The record's `tasks` section (limits, cap, next date); the slots mount only when the record has one. */
  tasks: ChainTasks;
  numbers: ProjectNumbers;
  /** The signed-in account's key, and the wallet's address when one is connected. */
  me: string | null;
  address: string | null;
  team: ReadonlySet<string>;
  agents: ReadonlySet<string>;
  operators: ReadonlyMap<string, string>;
  profiles: Record<string, ProfileMetadata> | undefined;
  /** `max(device time, the record's asOf.time)`: the one clock every phase and date test uses (`nowOf`). */
  now: number;
}
