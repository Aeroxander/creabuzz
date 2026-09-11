/**
 * Kanban board — work moved through status columns by drag or menu.
 */

import { useState } from "react";
import { CircleDot, Flag, GitPullRequest, Plus } from "lucide-react";

import type { WorkItem } from "../use-work-board";
import type { AgentCapabilities } from "../use-agent-roster";
import { useAgentRoster } from "../use-agent-roster";
import { userPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { UserAvatar } from "@/shared/ui/UserAvatar";

export const ISSUE_MOVE_TARGETS = ["open", "done", "closed"];

export const STATUS_COLUMNS = [
  { key: "open", label: "Open" },
  { key: "assigned", label: "Assigned" },
  { key: "in_progress", label: "In progress" },
  { key: "needs_approval", label: "Approval" },
  { key: "done", label: "Done" },
  { key: "closed", label: "Closed" },
] as const;

const PRIORITY_STYLE: Record<string, string> = {
  low: "text-black/60 dark:text-white/60",
  normal: "text-black/55 dark:text-white/55",
  high: "text-amber-600 dark:text-amber-400",
  urgent: "text-red-600 dark:text-red-400",
};

function Card({
  item,
  onSetStatus,
  onAssignSelf,
  onUnassign,
  agents,
}: {
  item: WorkItem;
  onSetStatus: (item: WorkItem, status: string) => void;
  onAssignSelf: (item: WorkItem) => void;
  onUnassign: (item: WorkItem) => void;
  agents: AgentCapabilities[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const me = userPubkey();
  const agent = agents.find((a) => a.pubkey === item.assignee);
  const isMine = item.assignee === me;
  const displayAssignee = item.assignee
    ? (agent?.name ?? (isMine ? "Me" : truncatePubkey(item.assignee)))
    : "Unassigned";

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-buzz-task", item.key);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {}}
      className="group w-full cursor-grab rounded-lg border border-black/10 bg-white p-2.5 text-left shadow-xs active:cursor-grabbing dark:border-white/10 dark:bg-white/5"
      data-testid={`kanban-card-${item.key.slice(0, 8)}`}
    >
      <div className="flex items-start gap-1.5">
        {item.type === "task" ? (
          <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black/60 dark:text-white/60" />
        ) : (
          <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black/60 dark:text-white/60" />
        )}
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-black dark:text-white">
          {item.title}
        </p>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded p-0.5 text-black/60 opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-100 dark:text-white/60 dark:hover:bg-white/10"
          aria-label={`Actions for ${item.title}`}
          data-testid={`kanban-menu-${item.key.slice(0, 8)}`}
        >
          ⋯
        </button>
      </div>

      {menuOpen ? (
        <div className="mt-1.5 space-y-0.5 rounded-md bg-black/[0.03] p-1 dark:bg-white/5">
          {STATUS_COLUMNS.filter((c) => c.key !== item.status)
            .filter(
              (c) =>
                item.type !== "issue" || ISSUE_MOVE_TARGETS.includes(c.key),
            )
            .map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  onSetStatus(item, c.key);
                  setMenuOpen(false);
                }}
                className="block w-full rounded px-2 py-1 text-left text-xs text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
              >
                Move to {c.label}
              </button>
            ))}
          {item.type === "task" ? (
            <>
              {item.assignee !== me ? (
                <button
                  type="button"
                  onClick={() => {
                    onAssignSelf(item);
                    setMenuOpen(false);
                  }}
                  className="block w-full rounded px-2 py-1 text-left text-xs text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
                >
                  Assign to me
                </button>
              ) : null}
              {item.assignee ? (
                <button
                  type="button"
                  onClick={() => {
                    onUnassign(item);
                    setMenuOpen(false);
                  }}
                  className="block w-full rounded px-2 py-1 text-left text-xs text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
                >
                  Unassign
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {item.type === "task" ? (
          <span
            className={`flex items-center gap-0.5 text-2xs ${PRIORITY_STYLE[item.priority] ?? PRIORITY_STYLE.normal}`}
            title={`Priority: ${item.priority}`}
          >
            <Flag className="h-3 w-3" />
          </span>
        ) : null}
        {item.due ? (
          <Badge variant="outline" className="px-1 py-0 text-2xs">
            {new Date(item.due * 1000).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </Badge>
        ) : null}
        {item.labels.slice(0, 2).map((label) => (
          <Badge key={label} variant="secondary" className="px-1 py-0 text-2xs">
            {label}
          </Badge>
        ))}
        {item.type === "task" && item.approver ? (
          <Badge variant="secondary" className="px-1 py-0 text-2xs">
            ✓ approved
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {item.assignee ? (
            <>
              <UserAvatar
                avatarUrl={null}
                displayName={displayAssignee}
                size="xs"
                className="h-4 w-4"
              />
              <span className="max-w-[7rem] truncate text-2xs text-black/60 dark:text-white/60">
                {displayAssignee}
              </span>
            </>
          ) : (
            <span className="text-2xs text-black/60 dark:text-white/60">
              unassigned
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

export function KanbanBoard({
  items,
  onSetStatus,
  onAssignSelf,
  onUnassign,
  onQuickAdd,
}: {
  items: WorkItem[];
  onSetStatus: (item: WorkItem, status: string) => void;
  onAssignSelf: (item: WorkItem) => void;
  onUnassign: (item: WorkItem) => void;
  onQuickAdd: (status: string, title: string) => void;
}) {
  const { agents } = useAgentRoster();
  const [quickAdd, setQuickAdd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [overCol, setOverCol] = useState<string | null>(null);

  const dropped = (id: string | null, status: string) => {
    if (!id) return;
    const item = items.find((i) => i.key === id);
    if (!item || item.status === status) return;
    if (item.type === "issue" && !ISSUE_MOVE_TARGETS.includes(status)) return;
    onSetStatus(item, status);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto pb-1">
      {STATUS_COLUMNS.map((col) => {
        const columnItems = items.filter((i) => i.status === col.key);
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-drop targets are containers by design
          <div
            key={col.key}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverCol(col.key);
            }}
            onDragLeave={() => setOverCol((v) => (v === col.key ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("application/x-buzz-task");
              dropped(id, col.key);
              setOverCol(null);
            }}
            className={`flex min-h-0 w-60 shrink-0 flex-col rounded-lg border ${
              overCol === col.key
                ? "border-black/25 bg-black/[0.03] dark:border-white/25 dark:bg-white/10"
                : "border-black/10 bg-white/40 dark:border-white/10 dark:bg-white/5"
            }`}
            data-testid={`kanban-col-${col.key}`}
          >
            <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
                {col.label}
              </span>
              <span className="text-2xs text-black/60 dark:text-white/60">
                {columnItems.length}
              </span>
              <button
                type="button"
                onClick={() => {
                  setQuickAdd(col.key);
                  setDraft("");
                }}
                className="ml-auto rounded p-0.5 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
                aria-label={`Add to ${col.label}`}
                data-testid={`kanban-add-${col.key}`}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {quickAdd === col.key ? (
              <div className="mx-2 mb-1 flex items-center gap-1">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="New task…"
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                  data-testid="kanban-quick-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (draft.trim()) onQuickAdd(col.key, draft.trim());
                    setQuickAdd(null);
                    setDraft("");
                  }}
                  className="rounded-full bg-black px-2 py-1 text-2xs font-medium text-white dark:bg-white dark:text-black"
                >
                  Add
                </button>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-2">
              {columnItems.map((item) => (
                <div key={item.key}>
                  <Card
                    item={item}
                    onSetStatus={onSetStatus}
                    onAssignSelf={onAssignSelf}
                    onUnassign={onUnassign}
                    agents={agents}
                  />
                </div>
              ))}
              {columnItems.length === 0 ? (
                <p className="px-1 py-3 text-center text-2xs text-black/60 dark:text-white/60">
                  Drop tasks here
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
