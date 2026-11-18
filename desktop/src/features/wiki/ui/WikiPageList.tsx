/**
 * The wiki page list: human wiki pages (kind:44001) and agent standup pages
 * (kind:44002) in visually distinguished groups — the two wikis are separate
 * products (docs/agent-wiki.md) and the list is where that stays legible.
 */
import { BookOpen, Bot } from "lucide-react";

import { SubsectionLabel } from "@/shared/ui/PageHeader";
import { cn } from "@/shared/lib/cn";

import { groupWikiPages, WIKI_GROUP_LABELS } from "../lib/wikiGroups";
import type { WikiPage } from "../lib/pageIndex";

type WikiPageListProps = {
  pages: readonly WikiPage[];
  activeKey: string | null;
  onSelect: (page: WikiPage) => void;
};

function pageRow(
  page: WikiPage,
  activeKey: string | null,
  onSelect: (page: WikiPage) => void,
) {
  const active = page.key === activeKey;
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-muted font-medium",
      )}
      data-testid={`wiki-page-${page.key}`}
      key={page.key}
      onClick={() => onSelect(page)}
      type="button"
    >
      {page.kind === "human" ? (
        <BookOpen
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <Bot
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{page.key}</span>
      {page.kind === "agent" ? (
        <span
          className="shrink-0 rounded bg-primary/10 px-1 text-3xs font-medium text-primary"
          data-testid="wiki-agent-badge"
        >
          agent
        </span>
      ) : null}
    </button>
  );
}

export function WikiPageList({
  pages,
  activeKey,
  onSelect,
}: WikiPageListProps) {
  const groups = groupWikiPages(pages);
  return (
    <nav
      aria-label="Wiki pages"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3"
      data-testid="wiki-page-list"
    >
      {groups.team.length > 0 ? (
        <div>
          <SubsectionLabel className="px-2">
            {WIKI_GROUP_LABELS.team}
          </SubsectionLabel>
          <div className="mt-1 space-y-0.5">
            {groups.team.map((page) => pageRow(page, activeKey, onSelect))}
          </div>
        </div>
      ) : null}
      {groups.corrections.length > 0 ? (
        <div data-testid="wiki-corrections-group">
          <SubsectionLabel className="px-2">
            {WIKI_GROUP_LABELS.corrections}
          </SubsectionLabel>
          <div className="mt-1 space-y-0.5">
            {groups.corrections.map((page) =>
              pageRow(page, activeKey, onSelect),
            )}
          </div>
        </div>
      ) : null}
      {groups.agent.length > 0 ? (
        <div>
          <SubsectionLabel className="px-2">
            {WIKI_GROUP_LABELS.agent}
          </SubsectionLabel>
          <div className="mt-1 space-y-0.5">
            {groups.agent.map((page) => pageRow(page, activeKey, onSelect))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}
