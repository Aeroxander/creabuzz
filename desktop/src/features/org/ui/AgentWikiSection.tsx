import * as React from "react";

import { BookOpen } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Markdown } from "@/shared/ui/markdown";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Spinner } from "@/shared/ui/spinner";
import { truncatePubkey } from "@/shared/lib/pubkey";

import {
  AGENT_WIKI_EMPTY_HINT,
  AGENT_WIKI_STANDUP_D,
  type AgentWikiPage,
} from "../lib/agentWiki";
import { relativeTimeLabel } from "../lib/dashboard";
import { fetchAgentWikiPage, useAgentWikiPagesQuery } from "../hooks";

type AgentWikiSectionProps = {
  /** Shared dashboard clock so relative labels stay live. */
  nowSeconds: number;
};

function provenanceLabel(page: AgentWikiPage, nowSeconds: number): string {
  // The model tag is the distillation loop's provenance; when a page carries
  // none, fall back to the author's truncated pubkey — never "unknown".
  const author = page.model ?? truncatePubkey(page.authorPubkey);
  return `Updated ${relativeTimeLabel(page.updatedAt, nowSeconds)} by ${author}`;
}

/** Full-page markdown view for one wiki page head, re-fetched by d. */
function AgentWikiPageSheet({
  d,
  onOpenChange,
}: {
  d: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const pageQuery = useQuery({
    queryKey: ["org", "agent-wiki-page", d],
    queryFn: ({ signal }) => fetchAgentWikiPage(d ?? "", signal),
    enabled: d !== null,
  });
  const page = pageQuery.data ?? null;
  return (
    <Sheet onOpenChange={onOpenChange} open={d !== null}>
      <SheetContent
        className="flex flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl"
        data-testid="org-wiki-sheet"
      >
        <SheetHeader className="border-b px-5 py-4 text-left">
          <SheetTitle className="text-sm">{d ?? ""}</SheetTitle>
          <SheetDescription className="text-2xs text-muted-foreground">
            {page
              ? provenanceLabel(page, Math.floor(Date.now() / 1000))
              : "Loading page…"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-w-0 px-5 py-4">
          {page ? (
            <Markdown
              blockCode
              className="text-sm"
              content={page.content}
              hardLineBreaks={false}
              interactive={false}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {pageQuery.isError ? "Failed to load this page." : "Loading…"}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Agent Wiki (kind:44002) read surface on the org dashboard: the standup
 * page rendered as markdown with provenance, plus every other page head
 * (read-side LWW) openable in a sheet. Wiki pages are agent-authored; this
 * surface is read-only by design (docs/agent-wiki.md).
 */
export function AgentWikiSection({ nowSeconds }: AgentWikiSectionProps) {
  const wikiQuery = useAgentWikiPagesQuery();
  const pages = wikiQuery.data ?? [];
  const standup = pages.find((page) => page.d === AGENT_WIKI_STANDUP_D);
  const others = pages.filter((page) => page.d !== AGENT_WIKI_STANDUP_D);
  const [selectedD, setSelectedD] = React.useState<string | null>(null);

  if (wikiQuery.isPending) {
    return (
      <div data-testid="org-wiki-section">
        <h3 className="mb-2 text-sm font-semibold">Agent wiki</h3>
        <EmptyState
          icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
          testId="org-wiki-loading"
          title="Loading agent wiki…"
        />
      </div>
    );
  }

  if (wikiQuery.isError) {
    return (
      <div data-testid="org-wiki-section">
        <h3 className="mb-2 text-sm font-semibold">Agent wiki</h3>
        <EmptyState
          action={
            <Button
              onClick={() => void wikiQuery.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          }
          description="The relay did not answer the wiki query. Check the connection, then retry."
          testId="org-wiki-error"
          title="Failed to load the agent wiki"
          variant="error"
        />
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div data-testid="org-wiki-section">
        <h3 className="mb-2 text-sm font-semibold">Agent wiki</h3>
        <EmptyState
          description={
            <>
              No agent wiki pages yet.{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-2xs">
                {AGENT_WIKI_EMPTY_HINT}
              </code>
            </>
          }
          icon={<BookOpen aria-hidden="true" className="h-5 w-5" />}
          testId="org-wiki-empty"
          title="No agent wiki pages yet"
        />
      </div>
    );
  }

  return (
    <div data-testid="org-wiki-section">
      <h3 className="mb-2 text-sm font-semibold">Agent wiki</h3>
      <div className="space-y-2">
        {standup ? (
          <Card className="p-3" data-testid="org-wiki-standup">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium">
                {standup.d}
              </p>
              <span
                className="shrink-0 text-2xs text-muted-foreground"
                data-testid="org-wiki-standup-provenance"
              >
                {provenanceLabel(standup, nowSeconds)}
              </span>
            </div>
            <div
              className="mt-2 max-h-64 overflow-y-auto"
              data-testid="org-wiki-standup-body"
            >
              <Markdown
                blockCode
                className="text-sm"
                content={standup.content}
                hardLineBreaks={false}
                interactive={false}
              />
            </div>
          </Card>
        ) : null}
        {others.length > 0 ? (
          <Card className="divide-y p-1" data-testid="org-wiki-pages">
            {others.map((page) => (
              <button
                aria-label={`Open wiki page ${page.d}`}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="org-wiki-page-row"
                key={page.d}
                onClick={() => setSelectedD(page.d)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {page.d}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {provenanceLabel(page, nowSeconds)}
                </span>
              </button>
            ))}
          </Card>
        ) : null}
      </div>
      <AgentWikiPageSheet
        d={selectedD}
        onOpenChange={(open) => {
          if (!open) setSelectedD(null);
        }}
      />
    </div>
  );
}
