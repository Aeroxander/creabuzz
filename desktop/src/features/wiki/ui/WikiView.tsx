/**
 * The org knowledge-graph read surface: every community wiki page in one
 * place — human wiki pages (kind:44001) and agent standup pages (kind:44002,
 * read-side LWW) — rendered read-only, with the page-link graph as a second
 * view (docs/agent-wiki.md). Editing and live-collab (Yjs/Trystero) stay
 * web-only for now.
 */
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import type { WikiPage } from "../lib/pageIndex";
import { useWikiPages } from "../useWikiPages";
import { WikiGraph } from "./WikiGraph";
import { WikiPageList } from "./WikiPageList";
import { WikiPageReader } from "./WikiPageReader";

type WikiTab = "page" | "graph";

export function WikiView() {
  const pagesQuery = useWikiPages(true);
  const [tab, setTab] = React.useState<WikiTab>("page");
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  const pages = React.useMemo(() => pagesQuery.data ?? [], [pagesQuery.data]);
  const active: WikiPage | null =
    pages.find((page) => page.key === activeKey) ?? pages[0] ?? null;

  let body: React.ReactNode;
  if (pagesQuery.isPending) {
    body = (
      <EmptyState
        icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
        testId="wiki-loading"
        title="Loading wiki…"
      />
    );
  } else if (pagesQuery.isError) {
    body = (
      <EmptyState
        action={
          <Button
            onClick={() => void pagesQuery.refetch()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        }
        description="The relay did not answer the wiki query. Check the connection, then retry."
        testId="wiki-error"
        title="Failed to load the wiki"
        variant="error"
      />
    );
  } else if (pages.length === 0) {
    body = (
      <EmptyState
        action={
          <Button
            onClick={() => void pagesQuery.refetch()}
            size="sm"
            variant="outline"
          >
            Check again
          </Button>
        }
        description="Human wiki pages published from the web client and agent standups published by distill runs (or the `buzz agwiki` CLI) show up here once the relay has any."
        testId="wiki-empty"
        title="No wiki pages yet"
      />
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r">
          <WikiPageList
            activeKey={active?.key ?? null}
            onSelect={(page) => setActiveKey(page.key)}
            pages={pages}
          />
        </aside>
        <Tabs
          className="flex min-h-0 flex-1 flex-col"
          onValueChange={(value) =>
            setTab(value === "graph" ? "graph" : "page")
          }
          value={tab}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
            <span
              className="min-w-0 truncate text-sm font-medium"
              data-testid="wiki-active-title"
            >
              {active?.key ?? "wiki"}
            </span>
            <TabsList aria-label="Wiki views">
              <TabsTrigger data-testid="wiki-tab-page" value="page">
                Page
              </TabsTrigger>
              <TabsTrigger data-testid="wiki-tab-graph" value="graph">
                Graph
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent className="flex min-h-0 flex-1 flex-col" value="page">
            {active ? (
              <WikiPageReader page={active} />
            ) : (
              <p className="p-4 text-xs text-muted-foreground">
                Select a page to read it.
              </p>
            )}
          </TabsContent>
          <TabsContent className="flex min-h-0 flex-1 flex-col" value="graph">
            <WikiGraph pages={pages} />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header
        className="flex shrink-0 items-center gap-3 border-b px-4 py-3"
        data-tauri-drag-region
      >
        <h1 className="text-sm font-semibold" data-tauri-drag-region>
          Wiki
        </h1>
      </header>
      {body}
    </div>
  );
}
