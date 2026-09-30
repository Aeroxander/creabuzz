import ReactMarkdown from "react-markdown";
import { APP_NAME } from "@/shared/constants/brand";
import remarkGfm from "remark-gfm";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CloudUpload,
  Download,
  FilePlus2,
  History,
  MessageSquarePlus,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  Users,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { QueryError, errorMessage } from "@/shared/ui/query-error";
import { existingUserPubkey } from "@/shared/lib/identity";
import { extractLinks, useWikiPages, type WikiPage } from "../use-wiki-pages";
import { useKnowledge } from "../use-knowledge";
import { provenanceLine, type KnowledgePage } from "../lib/knowledge";
import { canDeletePage } from "../lib/page-index";
import { describeLive } from "../lib/live-status";
import { useLiveWikiDoc } from "../wiki-sync";
import { PageDialog } from "./PageDialog";
import { KnowledgeIndex } from "./KnowledgeIndex";
import { VersionHistory } from "./VersionHistory";
import { SuggestCorrectionDialog } from "./SuggestCorrectionDialog";
import { WikiEditor } from "./WikiEditor";
import { WikiGraph } from "./WikiGraph";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

type Tab = "edit" | "graph";

/** Strip the agent page's leading front-matter block before rendering. */
function stripFrontMatter(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return content;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n+/, "");
    }
  }
  return content;
}

export function WikiView({
  initialSlug,
  onSlugChange,
}: {
  /** Page from the URL, so a page can be linked to and a reload returns to it. */
  initialSlug?: string;
  /** Reports the page now open, so the caller can put it in the URL. */
  onSlugChange?: (slug: string) => void;
} = {}) {
  const {
    pages,
    isLoading,
    savePage,
    deletePage,
    renamePage,
    readFreshPages,
    loadError,
    refetchPages,
  } = useWikiPages(true);
  const queryClient = useQueryClient();
  const knowledge = useKnowledge(true);
  const [tab, setTab] = useState<Tab>("edit");
  const [activeSlug, setActiveSlug] = useState<string | null>(
    () => initialSlug ?? pages[0]?.slug ?? null,
  );
  type EditMode = "wysiwyg" | "source" | "preview";
  const [mode, setMode] = useState<EditMode>("wysiwyg");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  /** Open naming dialog: `new` creates, otherwise it renames that page. */
  const [dialog, setDialog] = useState<null | "new" | { rename: string }>(null);
  const [pendingDelete, setPendingDelete] = useState<WikiPage | null>(null);
  /** Whether the version-history panel is showing for the active page. */
  const [showHistory, setShowHistory] = useState(false);
  /** Whether the "Suggest a correction" dialog is open. */
  const [suggestOpen, setSuggestOpen] = useState(false);
  /** In-flight flags for the Knowledge actions. */
  const [historyBusy, setHistoryBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  /**
   * Slugs published in this tab. The relay's page list refreshes on a poll, so
   * until it does the page still looks unpublished — the badge would claim
   * "not published" for a page the relay just accepted.
   */
  const [publishedHere, setPublishedHere] = useState<Set<string>>(new Set());

  // Knowledge classification of the active page. Agent pages are read-only and
  // never enter the live-edit document; team pages are the editable surface.
  const activeAgent: KnowledgePage | null =
    knowledge.agent.find((p) => p.slug === activeSlug) ?? null;
  const activeTeamMeta: KnowledgePage | null =
    knowledge.team.find((p) => p.slug === activeSlug) ?? null;
  const isAgentPage = activeAgent !== null;

  const published = pages.find((p) => p.slug === activeSlug) ?? null;
  const {
    content,
    setContent,
    mergeRemoteSnapshot,
    peers,
    strangers,
    rejected,
    live,
  } = useLiveWikiDoc(
    isAgentPage ? null : activeSlug,
    published?.content ?? "",
    published?.id ?? "",
  );
  const liveText = describeLive(live, { peers, strangers, rejected });
  /** The page being edited, including one that exists only in this editor. */
  const active: WikiPage | null =
    published ??
    (activeSlug
      ? { slug: activeSlug, content, updatedAt: 0, draft: true }
      : null);

  /** Open a page: local state plus the URL, so the page is linkable. */
  const openPage = (slug: string) => {
    setActiveSlug(slug);
    setMode("wysiwyg");
    onSlugChange?.(slug);
  };

  const selectPage = (page: WikiPage) => {
    openPage(page.slug);
  };

  const createPage = (slug: string) => {
    const existing = pages.find((p) => p.slug === slug);
    if (existing) {
      selectPage(existing);
    } else {
      openPage(slug);
    }
    setDialog(null);
  };

  /**
   * Team pages for the Knowledge index, with a local-only draft folded in so
   * "New page" is visible before its first save. Agent pages come straight from
   * the Knowledge read.
   */
  const teamForIndex = useMemo<KnowledgePage[]>(() => {
    const known = knowledge.team;
    const slug = activeSlug;
    if (!slug) return known;
    const represented =
      known.some((p) => p.slug === slug) ||
      knowledge.agent.some((p) => p.slug === slug);
    if (represented) return known;
    const draft: KnowledgePage = {
      kind: "team",
      slug,
      content,
      updatedAt: 0,
      authorPubkey: existingUserPubkey() ?? "",
      provenance: null,
      scope: null,
    };
    return [draft, ...known];
  }, [knowledge.team, knowledge.agent, activeSlug, content]);

  /**
   * The team-scope edit gate (lib/knowledge.ts). Agent pages are always
   * read-only, so they never grant edit. A scoped team page is editable only by
   * its team's seat holders; everyone else may only propose a correction.
   */
  const editVerdict = isAgentPage
    ? "propose"
    : knowledge.canEdit({ scope: activeTeamMeta?.scope ?? null });
  const canEditThis = editVerdict === "edit";

  /**
   * Publish the live document, folding in anything saved since we last looked.
   *
   * A snapshot is the whole page, so writing ours over a collaborator's would
   * discard their work — the auto-save made that a routine data loss rather
   * than a race. Reading the newest snapshot and merging before publishing
   * makes the write a read-modify-write, and the merged text is what the editor
   * shows afterwards.
   */
  const publishMerged = async () => {
    if (!activeSlug) return;
    // A snapshot is the whole page, so publishing without knowing the newest
    // version overwrites a collaborator's work. A failed read used to fall
    // through to publishing anyway, which turned the read-modify-write into a
    // blind write exactly when the relay was failing. Fail closed instead:
    // auto-save retries on the next edit, a manual save reports the error.
    const fresh = await readFreshPages();
    const latest = fresh.find((page) => page.slug === activeSlug);
    let text = content;
    let overlap = false;
    if (latest && latest.content !== content) {
      const merged = mergeRemoteSnapshot(latest.content);
      text = merged.content;
      overlap = merged.result === "replaced";
    }
    await savePage(activeSlug, text);
    if (overlap) {
      // The merge had to drop a collaborator's version of the same characters.
      // Silence here is how two people lose each other's paragraphs.
      toast.warning("Overlapping edit", {
        description:
          "Someone changed this text while you were typing. Both versions could not be kept — yours was saved.",
      });
    }
  };

  const save = async () => {
    if (!activeSlug) return;
    setSaving(true);
    try {
      await publishMerged();
      setDirty(false);
      setPublishedHere((prev) => new Set(prev).add(activeSlug));
      toast.success("Page saved");
    } catch (error) {
      console.error("[wiki]", error);
      toast.error("Couldn't save page", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const links = useMemo(() => extractLinks(content), [content]);

  /**
   * Copy a link to the page that is open.
   *
   * The URL carries `view=wiki&page=<slug>`, so the link opens the same page in
   * the same surface for whoever follows it. Before this, a page had no address
   * at all: a decision could not be linked to.
   */
  const copyPageLink = () => {
    const slug = activeSlug;
    if (!slug) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "wiki");
    url.searchParams.set("page", slug);
    if (navigator.clipboard) {
      void navigator.clipboard
        .writeText(url.toString())
        .then(() => toast.success("Page link copied"))
        .catch(() => toast.error("Couldn't copy the page link"));
    } else {
      toast.error("Couldn't copy the page link");
    }
  };

  const exportWiki = () => {
    const header = `# ${APP_NAME} Wiki Export\n\nExported ${new Date().toISOString()} — ${pages.length} page${pages.length === 1 ? "" : "s"}.\n`;
    const body = pages
      .map((page) => `\n---\n\n# Page: ${page.slug}\n\n${page.content}`)
      .join("\n");
    const blob = new Blob([header + body], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `wiki-export-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // Live multi-tab convergence: debounce auto-save to the relay so every tab
  // converges via snapshots even without a P2P signaling path; manual Save is
  // still available. (True CRDT P2P stays wired in wiki-sync for relays that
  // accept Trystero signaling.)
  // `publishMerged` is recreated per render; keep the dependency list on the
  // values that decide whether a save is due.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  useEffect(() => {
    if (!activeSlug || !dirty) return;
    const timer = setTimeout(() => {
      void publishMerged()
        .then(() => {
          setDirty(false);
          setPublishedHere((prev) => new Set(prev).add(activeSlug));
          void queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
        })
        .catch((error: unknown) => {
          // Still dirty, so the next edit retries; say so once rather than
          // silently leaving the page unsaved.
          console.warn("[wiki] auto-save failed", error);
          toast.error("Couldn't auto-save this page", {
            description: errorMessage(error),
            id: "wiki-autosave-failed",
          });
        });
    }, 4000);
    return () => clearTimeout(timer);
  }, [activeSlug, content, dirty, savePage, queryClient]);

  // Merge snapshots saved elsewhere (another tab, or another person on a relay
  // without P2P signalling). This used to be skipped whenever this tab had
  // typed anything, which meant an active editor never saw a collaborator's
  // saved work at all; the snapshot now arrives as a delta merged into the live
  // document, so both sets of edits survive.
  useEffect(() => {
    if (!published) return;
    mergeRemoteSnapshot(published.content);
  }, [published, mergeRemoteSnapshot]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col lg:flex-row">
      {/* Page list: a stacked strip on narrow screens, a column from `lg` up. */}
      <aside
        className="flex max-h-40 w-full shrink-0 flex-col border-b border-black/10 bg-[#F8F8F8] lg:max-h-none lg:w-56 lg:border-b-0 lg:border-r dark:border-white/10 dark:bg-[#1B1B1B]"
        data-testid="wiki-page-list"
      >
        <div className="flex items-center justify-between px-3 py-3">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-black/70 dark:text-white/70">
            <BookOpen className="h-4 w-4" /> Wiki
          </span>
          <button
            type="button"
            onClick={() => setDialog("new")}
            className="rounded p-1 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            aria-label="New page"
            data-testid="wiki-new-page"
          >
            <FilePlus2 className="h-4 w-4" />
          </button>
        </div>
        {loadError ? (
          <p
            className="mx-2 mb-1 rounded-md bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-700 dark:text-amber-300"
            data-testid="wiki-cache-warning"
            role="status"
          >
            Showing saved pages — the relay did not answer.
          </p>
        ) : null}
        {isLoading &&
        teamForIndex.length === 0 &&
        knowledge.agent.length === 0 ? (
          <div className="space-y-2 p-2">
            {["a", "b", "c"].map((k) => (
              <div
                key={k}
                className="h-8 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
              />
            ))}
          </div>
        ) : loadError &&
          teamForIndex.length === 0 &&
          knowledge.agent.length === 0 ? (
          <div className="p-2">
            <QueryError
              description="The relay did not answer the wiki page query, so there is no known list of pages."
              message={errorMessage(loadError)}
              onRetry={() => void refetchPages()}
              testId="wiki-load-error"
              title="Couldn't load pages"
            />
          </div>
        ) : (
          <KnowledgeIndex
            agent={knowledge.agent}
            activeSlug={activeSlug}
            onSearchChange={setPageSearch}
            onSelect={(page) => openPage(page.slug)}
            search={pageSearch}
            team={teamForIndex}
          />
        )}
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* One wrapping row: at 390px the old fixed row clipped "Source" off
            the card, leaving that mode unreachable. */}
        <div
          className="flex flex-wrap items-center gap-2 border-b border-black/10 px-2 py-2 sm:px-4 dark:border-white/10"
          data-testid="wiki-toolbar"
        >
          <div className="flex items-center gap-1 rounded-md bg-black/5 p-1 dark:bg-white/10">
            {(["edit", "graph"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-2 py-1 text-xs font-medium ${
                  tab === t
                    ? "bg-white text-black shadow-xs dark:bg-white/20 dark:text-white"
                    : "text-black/60 dark:text-white/60"
                }`}
                data-testid={`wiki-tab-${t}`}
              >
                {t === "edit" ? "Edit" : "Graph"}
              </button>
            ))}
          </div>
          <span className="min-w-0 truncate text-sm font-medium text-black/70 dark:text-white/70">
            {activeSlug ?? "wiki"}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
            {(["wysiwyg", "source", "preview"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md border px-2 py-1 ${
                  mode === m
                    ? "border-black/25 bg-black/5 dark:border-white/25 dark:bg-white/10"
                    : "border-black/15 dark:border-white/15"
                }`}
                data-testid={`wiki-mode-${m}`}
              >
                {m === "wysiwyg"
                  ? "WYSIWYG"
                  : m === "source"
                    ? "Source"
                    : "Preview"}
              </button>
            ))}
            <span
              className="flex items-center gap-1"
              data-testid="wiki-editors"
              title={liveText.detail}
            >
              <Users className="h-3 w-3" aria-hidden="true" />
              {liveText.editors}
            </span>
            <span
              className="flex items-center gap-1 rounded border border-black/15 px-1.5 py-0.5 dark:border-white/15"
              data-live-state={live.state}
              data-testid="wiki-live-status"
              role="status"
              title={liveText.detail}
            >
              {liveText.chip}
              <span className="sr-only">. {liveText.detail}</span>
            </span>
            <span
              className="flex items-center gap-1"
              data-testid="wiki-save-state"
            >
              <CloudUpload className="h-3 w-3" aria-hidden="true" />
              {saving
                ? "saving…"
                : dirty
                  ? "unsaved"
                  : active?.draft && !publishedHere.has(active.slug)
                    ? "not published"
                    : "saved"}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 dark:border-white/15"
              data-testid="wiki-copy-link"
              onClick={copyPageLink}
              title="Copy a link to this page"
            >
              <Link2 className="h-3 w-3" /> Copy link
            </button>
            <button
              type="button"
              onClick={exportWiki}
              className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 dark:border-white/15"
              aria-label="Export wiki as markdown"
              data-testid="wiki-export"
              title="Download all pages as one markdown file"
            >
              <Download className="h-3 w-3" /> Export
            </button>
            {links.length > 0 && (
              <span className="hidden items-center gap-1 sm:flex">
                <Sparkles className="h-3 w-3" /> {links.length} link
                {links.length === 1 ? "" : "s"}
              </span>
            )}
            {active && !isAgentPage ? (
              <button
                type="button"
                onClick={() => setDialog({ rename: active.slug })}
                key="rename"
                className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 dark:border-white/15"
                data-testid="wiki-rename"
                title="Rename this page"
              >
                <Pencil className="h-3 w-3" /> Rename
              </button>
            ) : null}
            {/* The relay only accepts a delete from the newest revision's
                author, so the button is not shown to anyone else — a control
                that always fails has no business being clickable. Agent pages
                are read-only, so they never offer delete. */}
            {active &&
            !isAgentPage &&
            canDeletePage(active, existingUserPubkey()) ? (
              <button
                type="button"
                key="delete"
                onClick={() => setPendingDelete(active)}
                className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 text-red-700 dark:border-white/15 dark:text-red-400"
                data-testid="wiki-delete"
                title="Delete this page"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            ) : null}
            {activeSlug ? (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                aria-pressed={showHistory}
                className={`inline-flex items-center gap-1 rounded border px-2 py-1 dark:border-white/15 ${
                  showHistory
                    ? "border-black/25 bg-black/5 dark:border-white/25 dark:bg-white/10"
                    : "border-black/15"
                }`}
                data-testid="wiki-history-toggle"
                title="Show this page's version history"
              >
                <History className="h-3 w-3" /> History
              </button>
            ) : null}
            {activeSlug && (isAgentPage || editVerdict === "propose") ? (
              <button
                type="button"
                onClick={() => setSuggestOpen(true)}
                className="inline-flex items-center gap-1 rounded border border-black/15 px-2 py-1 dark:border-white/15"
                data-testid="wiki-suggest"
                title={
                  isAgentPage
                    ? "Suggest a correction to this agent page"
                    : "Propose a change to this page"
                }
              >
                <MessageSquarePlus className="h-3 w-3" />
                {isAgentPage ? "Suggest a correction" : "Propose a change"}
              </button>
            ) : null}
            {activeSlug && canEditThis ? (
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1 rounded-md bg-black px-2.5 py-1 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                data-testid="wiki-save"
                title={
                  dirty
                    ? "Publish this page to the relay"
                    : "No unpublished changes"
                }
              >
                <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
        </div>

        {tab === "graph" ? (
          <WikiGraph pages={pages} />
        ) : showHistory && activeSlug ? (
          <VersionHistory
            revisions={knowledge.historyFor(activeSlug)}
            restoring={historyBusy}
            onRestore={(revision) => {
              setHistoryBusy(true);
              void knowledge
                .restoreRevision(activeSlug, revision)
                .then(() => toast.success("Version restored"))
                .catch((error: unknown) =>
                  toast.error("Couldn't restore that version", {
                    description: errorMessage(error),
                  }),
                )
                .finally(() => setHistoryBusy(false));
            }}
          />
        ) : activeAgent ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
              <div className="space-y-1">
                <p
                  className="text-2xs text-black/60 dark:text-white/60"
                  data-testid="wiki-agent-provenance"
                >
                  {activeAgent.provenance
                    ? provenanceLine(activeAgent.provenance)
                    : "Updated by an agent"}
                </p>
                <p className="text-2xs text-black/50 dark:text-white/50">
                  This page is kept up to date by an agent and can&apos;t be
                  edited here. Suggest a correction to propose a change.
                </p>
              </div>
              <article
                className="prose prose-sm max-w-none dark:prose-invert [&_pre]:overflow-x-auto"
                data-testid="wiki-agent-reader"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {stripFrontMatter(activeAgent.content)}
                </ReactMarkdown>
              </article>
            </div>
          </div>
        ) : activeSlug ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {!canEditThis ? (
              <>
                <p
                  className="border-b border-black/10 bg-amber-500/10 px-3 py-1.5 text-2xs text-amber-700 dark:border-white/10 dark:text-amber-300"
                  data-testid="wiki-edit-locked"
                  role="status"
                >
                  Only this team&apos;s seat holders can edit this page. You can
                  read it and propose a change.
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <article className="prose prose-sm max-w-none p-4 dark:prose-invert [&_pre]:overflow-x-auto">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {content}
                    </ReactMarkdown>
                  </article>
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {mode === "preview" ? (
                  <article className="prose prose-sm max-w-none p-4 dark:prose-invert [&_pre]:overflow-x-auto">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {content}
                    </ReactMarkdown>
                  </article>
                ) : mode === "source" ? (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setDirty(true);
                      setContent(e.target.value);
                    }}
                    className="h-full min-h-[60vh] w-full resize-none rounded-md border border-black/10 bg-white p-3 font-mono text-sm text-black outline-none focus:ring-1 focus:ring-black dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:ring-white"
                    placeholder="Write in markdown. [[Other Page]] links create the graph."
                    data-testid="wiki-editor"
                  />
                ) : (
                  <div
                    className="border-b border-black/10 dark:border-white/10"
                    data-testid="wiki-wysiwyg"
                  >
                    <WikiEditor
                      content={content}
                      onChange={(markdown) => {
                        setDirty(true);
                        setContent(markdown);
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/60 dark:text-white/60">
            Select a page or create one.
          </div>
        )}
      </div>

      {dialog ? (
        <PageDialog
          confirmLabel={dialog === "new" ? "Create page" : "Rename page"}
          description={
            dialog === "new"
              ? "Pages are addressable by name, so the name is permanent until you rename the page."
              : `Rename “${dialog.rename}”. The old name is deleted and its content moves to the new one.`
          }
          initialValue={dialog === "new" ? "" : dialog.rename}
          onCancel={() => setDialog(null)}
          onSubmit={(slug) => {
            if (dialog === "new") {
              createPage(slug);
              return;
            }
            const from = dialog.rename;
            setDialog(null);
            if (from === slug) return;
            openPage(slug);
            // As with delete: ask the relay whether the old name is published,
            // or a page saved moments ago would keep living under its old slug.
            void (async () => {
              try {
                const fresh = await readFreshPages();
                const published = fresh.find((p) => p.slug === from);
                if (published) {
                  await renamePage(published, slug);
                  void queryClient.invalidateQueries({
                    queryKey: ["wiki-pages"],
                  });
                }
                toast.success(`Renamed to ${slug}`);
              } catch (error) {
                // The read failed, so we do not know whether the old name is
                // published. Claiming a rename here left the relay holding the
                // old page while the tab showed the new one.
                toast.error("Couldn't rename page", {
                  description: `The relay did not answer, so nothing was renamed. ${errorMessage(error)}`,
                });
              }
            })();
          }}
          takenSlugs={pages
            .map((p) => p.slug)
            .filter((slug) => slug !== (dialog === "new" ? "" : dialog.rename))}
          title={dialog === "new" ? "New wiki page" : "Rename page"}
        />
      ) : null}

      <ConfirmDialog
        confirmLabel="Delete page"
        description={
          pendingDelete
            ? `“${pendingDelete.slug}” is removed from the wiki for everyone. Copies already on the server may remain there until server-side deletion is available.`
            : ""
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const page = pendingDelete;
          setPendingDelete(null);
          if (!page) return;
          if (activeSlug === page.slug) setActiveSlug(null);
          // Whether the page exists on the relay is decided from the relay, not
          // from this tab's list: a page created and saved moments ago is not in
          // the cached list yet, and treating it as local-only left a published
          // page live for everyone else.
          void (async () => {
            try {
              const fresh = await readFreshPages();
              const published = fresh.find((p) => p.slug === page.slug);
              if (!published) {
                toast.success(`Discarded ${page.slug}`);
                return;
              }
              await deletePage(published);
              toast.success(`Deleted ${page.slug}`);
              void queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
            } catch (error) {
              // "Discarded" and "Deleted" both say the page is gone; a failed
              // read tells us nothing about that, so say nothing was changed.
              toast.error("Couldn't delete page", {
                description: `The relay did not answer, so the page was not deleted. ${errorMessage(error)}`,
              });
            }
          })();
        }}
        open={pendingDelete !== null}
        title="Delete this page?"
      />

      {suggestOpen && activeSlug ? (
        <SuggestCorrectionDialog
          slug={activeSlug}
          submitting={suggestBusy}
          onCancel={() => setSuggestOpen(false)}
          onSubmit={(note) => {
            setSuggestBusy(true);
            void knowledge
              .fileSuggestion(activeSlug, note)
              .then(() => {
                toast.success("Correction suggested");
                setSuggestOpen(false);
              })
              .catch((error: unknown) =>
                toast.error("Couldn't send your suggestion", {
                  description: errorMessage(error),
                }),
              )
              .finally(() => setSuggestBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
