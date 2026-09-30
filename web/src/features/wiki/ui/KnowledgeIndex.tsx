/**
 * The Knowledge index: one entry point listing every page, grouped into the two
 * product kinds — **Team pages** (the human wiki) and **Agent pages** (kept up
 * to date by an agent). Labels are product terms; the underlying kind numbers
 * are protocol internals and never appear in the copy.
 *
 * Agent pages are visually distinct (and read-only where rendered), so a reader
 * always knows which surface they are on. Selecting any entry is keyboard- and
 * pointer-reachable; each entry has exactly one accessible label owner.
 */

import { BookOpen, Bot, Search } from "lucide-react";

import type { KnowledgePage } from "../lib/knowledge";

function PageRow({
  page,
  active,
  onSelect,
}: {
  page: KnowledgePage;
  active: boolean;
  onSelect: (page: KnowledgePage) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(page)}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        active
          ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
          : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
      }`}
      data-testid={`knowledge-page-${page.slug}`}
    >
      {page.kind === "team" ? (
        <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{page.slug}</span>
      {page.kind === "agent" ? (
        <span className="ml-auto shrink-0 text-2xs text-black/50 dark:text-white/50">
          agent
        </span>
      ) : null}
    </button>
  );
}

function Group({
  label,
  testId,
  pages,
  activeSlug,
  onSelect,
  empty,
}: {
  label: string;
  testId: string;
  pages: KnowledgePage[];
  activeSlug: string | null;
  onSelect: (page: KnowledgePage) => void;
  empty: string;
}) {
  return (
    <div className="mb-2" data-testid={testId}>
      <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
        {label}{" "}
        <span className="text-black/40 dark:text-white/40">
          ({pages.length})
        </span>
      </p>
      {pages.length === 0 ? (
        <p className="px-2 py-1 text-2xs text-black/50 dark:text-white/50">
          {empty}
        </p>
      ) : (
        pages.map((page) => (
          <PageRow
            key={`${page.kind}:${page.slug}`}
            page={page}
            active={page.slug === activeSlug}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

export function KnowledgeIndex({
  team,
  agent,
  activeSlug,
  search,
  onSearchChange,
  onSelect,
}: {
  team: KnowledgePage[];
  agent: KnowledgePage[];
  activeSlug: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (page: KnowledgePage) => void;
}) {
  const term = search.trim().toLowerCase();
  const match = (page: KnowledgePage) =>
    term.length === 0 || page.slug.toLowerCase().includes(term);
  const teamMatch = team.filter(match);
  const agentMatch = agent.filter(match);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/40 dark:text-white/40"
            aria-hidden="true"
          />
          <input
            aria-label="Find a page"
            className="w-full rounded-md border border-black/10 bg-white py-1 pl-7 pr-2 text-sm text-black outline-none placeholder:text-black/60 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
            data-testid="knowledge-search"
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Find a page…"
            value={search}
          />
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <Group
          label="Team pages"
          testId="knowledge-group-team"
          pages={teamMatch}
          activeSlug={activeSlug}
          onSelect={onSelect}
          empty="No team pages yet."
        />
        <Group
          label="Agent pages"
          testId="knowledge-group-agent"
          pages={agentMatch}
          activeSlug={activeSlug}
          onSelect={onSelect}
          empty="No agent pages yet."
        />
      </nav>
    </div>
  );
}
