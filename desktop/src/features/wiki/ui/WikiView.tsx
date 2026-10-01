/**
 * The org knowledge-graph read surface: every community wiki page in one
 * place — human wiki pages (kind:44001) and agent standup pages (kind:44002,
 * read-side LWW) — rendered read-only, with the page-link graph as a second
 * view (docs/agent-wiki.md). Editing and live-collab (Yjs/Trystero) stay
 * web-only for now.
 */
import * as React from "react";
import { Pencil, Save, X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Spinner } from "@/shared/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { canManageCommunityMembers } from "@/shared/api/relayMembers";
import { useMyRelayMembershipLookupQuery } from "@/features/community-members/hooks";

import type { WikiPage } from "../lib/pageIndex";
import { buildPageSavePayload, canEditWikiPage } from "../lib/pageEdit";
import { useTeamSeats, useWikiPages } from "../useWikiPages";
import { WikiGraph } from "./WikiGraph";
import { WikiPageList } from "./WikiPageList";
import { WikiPageReader } from "./WikiPageReader";
import { RecentlyDeletedPanel } from "./RecentlyDeletedPanel";

type WikiTab = "page" | "graph";

export function WikiView() {
  const pagesQuery = useWikiPages(true);
  const [tab, setTab] = React.useState<WikiTab>("page");
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  // Team-page editing. Agent pages stay read-only; only a human page (kind
  // 44001) is editable here, published through the same event shape the web
  // client uses (`lib/pageEdit.ts`).
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // The relay's delete/edit rules, mirrored: community admins may purge and
  // re-scope; scoped pages need a team seat (or admin) — never open editing
  // where the relay would reject the edit.
  const myMembership = useMyRelayMembershipLookupQuery();
  const viewerIsAdmin = canManageCommunityMembers(myMembership.data);
  const viewerPubkey =
    myMembership.data?.membership?.pubkey?.trim().toLowerCase() ?? null;
  const seatsQuery = useTeamSeats(true);
  const resolveTeamSeats = seatsQuery.data ?? (() => null);

  // "Recently deleted" list + the admin scope editor.
  const [showTrash, setShowTrash] = React.useState(false);
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const [scopePick, setScopePick] = React.useState<string>("");
  const [scopeBusy, setScopeBusy] = React.useState(false);

  const pages = React.useMemo(() => pagesQuery.data ?? [], [pagesQuery.data]);
  const active: WikiPage | null =
    pages.find((page) => page.key === activeKey) ?? pages[0] ?? null;

  // Reset the editor whenever the open page changes.
  const activeRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = active?.key ?? null;
    if (key === activeRef.current) return;
    activeRef.current = key;
    setEditing(false);
    setDraft(active?.content ?? "");
    setSaveError(null);
  }, [active?.key, active?.content]);

  const activeScope = active?.kind === "human" ? active.scope : null;
  const editable =
    active !== null &&
    active.kind === "human" &&
    canEditWikiPage({
      scope: active.scope ?? null,
      resolveTeamSeats,
      viewerPubkey,
      viewerIsAdmin,
    });

  const save = async () => {
    if (active?.kind !== "human") return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildPageSavePayload({
        slug: active.slug,
        content: draft,
        now: Math.floor(Date.now() / 1000),
        // Sticky scope: an edit never silently re-scopes who may edit next.
        scope: active.scope ?? null,
      });
      const event = await signRelayEvent({
        kind: payload.kind,
        content: payload.content,
        tags: payload.tags,
        createdAt: payload.created_at,
      });
      await relayClient.publishEvent(
        event,
        "Timed out while saving the page.",
        "Failed to save the page.",
      );
      setEditing(false);
      await pagesQuery.refetch();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

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
            <div className="flex items-center gap-2">
              {viewerIsAdmin && active?.kind === "human" ? (
                scopeOpen ? (
                  <>
                    <label className="sr-only" htmlFor="wiki-scope-select">
                      Team this page is scoped to
                    </label>
                    <select
                      className="rounded border bg-background px-2 py-1 text-2xs"
                      data-testid="wiki-scope-select"
                      id="wiki-scope-select"
                      onChange={(e) => setScopePick(e.target.value)}
                      value={scopePick}
                    >
                      <option value="">No team — any member can edit</option>
                      {activeScope ? (
                        <option value={activeScope}>
                          {activeScope} (current)
                        </option>
                      ) : null}
                    </select>
                    <Button
                      data-testid="wiki-scope-save"
                      disabled={scopeBusy}
                      onClick={() => {
                        if (active?.kind !== "human") return;
                        setScopeBusy(true);
                        void (async () => {
                          try {
                            const payload = buildPageSavePayload({
                              slug: active.slug,
                              content: active.content,
                              now: Math.floor(Date.now() / 1000),
                              scope: scopePick === "" ? null : scopePick,
                            });
                            const event = await signRelayEvent({
                              kind: payload.kind,
                              content: payload.content,
                              tags: payload.tags,
                              createdAt: payload.created_at,
                            });
                            await relayClient.publishEvent(
                              event,
                              "Timed out while saving the page scope.",
                              "Failed to save the page scope.",
                            );
                            setScopeOpen(false);
                            await pagesQuery.refetch();
                          } catch (error) {
                            setSaveError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          } finally {
                            setScopeBusy(false);
                          }
                        })();
                      }}
                      size="sm"
                    >
                      Save scope
                    </Button>
                    <Button
                      data-testid="wiki-scope-cancel"
                      onClick={() => setScopeOpen(false)}
                      size="sm"
                      variant="outline"
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    data-testid="wiki-scope-open"
                    onClick={() => {
                      setScopePick(activeScope ?? "");
                      setScopeOpen(true);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Change scope
                  </Button>
                )
              ) : null}
              <Button
                aria-pressed={showTrash}
                data-testid="wiki-recently-deleted-open"
                onClick={() => setShowTrash((v) => !v)}
                size="sm"
                variant="outline"
              >
                Recently deleted
              </Button>
              {/* Agent pages are read-only; only a team page offers editing. */}
              {editable && !editing ? (
                <Button
                  data-testid="wiki-edit"
                  onClick={() => setEditing(true)}
                  size="sm"
                  variant="outline"
                >
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" /> Edit
                </Button>
              ) : null}
              {editable && editing ? (
                <>
                  <Button
                    data-testid="wiki-edit-cancel"
                    onClick={() => {
                      setDraft(active?.content ?? "");
                      setEditing(false);
                      setSaveError(null);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" /> Cancel
                  </Button>
                  <Button
                    data-testid="wiki-edit-save"
                    disabled={saving}
                    onClick={() => void save()}
                    size="sm"
                  >
                    <Save aria-hidden="true" className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : null}
              <TabsList aria-label="Wiki views">
                <TabsTrigger data-testid="wiki-tab-page" value="page">
                  Page
                </TabsTrigger>
                <TabsTrigger data-testid="wiki-tab-graph" value="graph">
                  Graph
                </TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent className="flex min-h-0 flex-1 flex-col" value="page">
            {showTrash ? (
              <RecentlyDeletedPanel isAdmin={viewerIsAdmin} />
            ) : active && editing && active.kind === "human" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {saveError ? (
                  <p
                    className="border-b bg-destructive/10 px-4 py-2 text-2xs text-destructive"
                    data-testid="wiki-edit-error"
                    role="status"
                  >
                    Couldn&apos;t save: {saveError}
                  </p>
                ) : null}
                <textarea
                  aria-label={`Edit ${active.slug}`}
                  className="min-h-0 w-full flex-1 resize-none border-none bg-background p-4 font-mono text-sm outline-none"
                  data-testid="wiki-edit-area"
                  onChange={(e) => setDraft(e.target.value)}
                  value={draft}
                />
              </div>
            ) : active ? (
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
