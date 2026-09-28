/**
 * Read-only reader for one wiki page: markdown body plus the page's identity
 * line. Agent standup pages (kind:44002) additionally carry their provenance
 * (model · token cost · source events) — that record is part of the page on
 * this surface (docs/agent-wiki.md). No editing here by design: the
 * live-collab editing surface stays web-only.
 */
import { BookOpen, Bot } from "lucide-react";

import { formatItemTimestamp } from "@/shared/lib/datetime";
import { Markdown } from "@/shared/ui/markdown";

import type { WikiPage } from "../lib/pageIndex";
import { ProvenanceLine } from "./ProvenanceLine";

export function WikiPageReader({ page }: { page: WikiPage }) {
  return (
    <article
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      data-testid="wiki-reader"
    >
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {page.kind === "human" ? (
              <BookOpen
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
            ) : (
              <Bot
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
            )}
            <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">
              {page.key}
            </h2>
            <span
              className="shrink-0 rounded bg-muted px-1.5 text-3xs font-medium text-muted-foreground"
              data-testid="wiki-page-kind"
            >
              {page.kind === "human" ? "human wiki" : "agent standup"}
            </span>
          </div>
          {page.kind === "agent" ? <ProvenanceLine page={page} /> : null}
          <p className="text-2xs text-muted-foreground">
            Updated {formatItemTimestamp(page.updatedAt, { withTime: true })}
          </p>
        </div>
        <Markdown
          blockCode
          className="text-sm"
          content={page.content}
          hardLineBreaks={false}
          interactive={false}
        />
      </div>
    </article>
  );
}
