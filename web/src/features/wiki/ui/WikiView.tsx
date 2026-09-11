import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CloudUpload,
  Download,
  FilePlus2,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { extractLinks, useWikiPages, type WikiPage } from "../use-wiki-pages";
import { useLiveWikiDoc } from "../wiki-sync";
import { PageDialog } from "./PageDialog";
import { WikiEditor } from "./WikiEditor";
import { WikiGraph } from "./WikiGraph";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

type Tab = "edit" | "graph";

export function WikiView() {
  const { pages, isLoading, savePage, deletePage, renamePage, readFreshPages } =
    useWikiPages(true);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("edit");
  const [activeSlug, setActiveSlug] = useState<string | null>(
    () => pages[0]?.slug ?? null,
  );
  type EditMode = "wysiwyg" | "source" | "preview";
  const [mode, setMode] = useState<EditMode>("wysiwyg");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  /** Open naming dialog: `new` creates, otherwise it renames that page. */
  const [dialog, setDialog] = useState<null | "new" | { rename: string }>(null);
  const [pendingDelete, setPendingDelete] = useState<WikiPage | null>(null);
  /**
   * Slugs published in this tab. The relay's page list refreshes on a poll, so
   * until it does the page still looks unpublished — the badge would claim
   * "not published" for a page the relay just accepted.
   */
  const [publishedHere, setPublishedHere] = useState<Set<string>>(new Set());

  const published = pages.find((p) => p.slug === activeSlug) ?? null;
  const { content, setContent, mergeRemoteSnapshot, peers } = useLiveWikiDoc(
    activeSlug,
    published?.content ?? "",
  );
  /** The page being edited, including one that exists only in this editor. */
  const active: WikiPage | null =
    published ??
    (activeSlug
      ? { slug: activeSlug, content, updatedAt: 0, draft: true }
      : null);

  const selectPage = (page: WikiPage) => {
    setActiveSlug(page.slug);
    setMode("wysiwyg");
  };

  const createPage = (slug: string) => {
    const existing = pages.find((p) => p.slug === slug);
    if (existing) {
      selectPage(existing);
    } else {
      setActiveSlug(slug);
      setMode("wysiwyg");
    }
    setDialog(null);
  };

  /**
   * Pages to show in the list. A page created here exists only in the editor
   * until it is published, so it is listed as a draft — otherwise "New page"
   * appears to do nothing.
   */
  const visiblePages = useMemo(() => {
    const term = pageSearch.trim().toLowerCase();
    const matches = (slug: string) =>
      term.length === 0 || slug.toLowerCase().includes(term);
    const known = pages.filter((page) => matches(page.slug));
    if (!activeSlug || pages.some((page) => page.slug === activeSlug)) {
      return known;
    }
    if (!matches(activeSlug)) return known;
    const draft: WikiPage = {
      slug: activeSlug,
      content,
      updatedAt: 0,
      draft: true,
    };
    return [draft, ...known];
  }, [pages, pageSearch, activeSlug, content]);

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
    const fresh = await readFreshPages().catch(() => null);
    const latest = fresh?.find((page) => page.slug === activeSlug);
    const merged =
      latest && latest.content !== content
        ? mergeRemoteSnapshot(latest.content).content
        : content;
    await savePage(activeSlug, merged);
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

  const exportWiki = () => {
    const header = `# Buzz Wiki Export\n\nExported ${new Date().toISOString()} — ${pages.length} page${pages.length === 1 ? "" : "s"}.\n`;
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
        .catch((error) => {
          console.warn("[wiki] auto-save failed", error);
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
        {pages.length > 3 ? (
          <div className="px-2 pb-2">
            <input
              aria-label="Find a page"
              className="w-full rounded-md border border-black/10 bg-white px-2 py-1 text-sm text-black outline-none placeholder:text-black/60 focus:ring-1 focus:ring-black/20 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
              data-testid="wiki-page-search"
              onChange={(e) => setPageSearch(e.target.value)}
              placeholder="Find a page…"
              value={pageSearch}
            />
          </div>
        ) : null}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {isLoading && pages.length === 0 ? (
            <div className="space-y-2 p-2">
              {["a", "b", "c"].map((k) => (
                <div
                  key={k}
                  className="h-8 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
                />
              ))}
            </div>
          ) : visiblePages.length === 0 && pageSearch.trim().length > 0 ? (
            <p
              className="px-2 py-3 text-xs text-black/60 dark:text-white/60"
              data-testid="wiki-page-search-empty"
            >
              No page matches “{pageSearch.trim()}”.
            </p>
          ) : visiblePages.length === 0 ? (
            <p className="px-2 py-3 text-xs text-black/60 dark:text-white/60">
              No pages yet. Create the first one.
            </p>
          ) : (
            visiblePages.map((page) => (
              <button
                key={page.slug}
                type="button"
                onClick={() => selectPage(page)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  page.slug === activeSlug
                    ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                    : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
                }`}
                data-testid={`wiki-page-${page.slug}`}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{page.slug}</span>
                {page.draft && !publishedHere.has(page.slug) ? (
                  <span className="ml-auto shrink-0 text-2xs text-amber-700 dark:text-amber-400">
                    draft
                  </span>
                ) : null}
              </button>
            ))
          )}
        </nav>
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
              title={
                peers > 0
                  ? `${peers} other ${peers === 1 ? "editor" : "editors"} connected.`
                  : "Nobody else is connected. Live co-editing needs the relay to accept P2P signalling; without it, edits reach others when a page is saved."
              }
            >
              <Users className="h-3 w-3" aria-hidden="true" />
              {peers === 0 ? "Editing alone" : `${peers + 1} editing`}
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
            {active ? (
              <>
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
              </>
            ) : null}
            {activeSlug ? (
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
        ) : activeSlug ? (
          <div className="flex min-h-0 flex-1 flex-col">
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
            setActiveSlug(slug);
            // As with delete: ask the relay whether the old name is published,
            // or a page saved moments ago would keep living under its old slug.
            void readFreshPages()
              .catch(() => null)
              .then(async (fresh) => {
                const published = fresh?.find((p) => p.slug === from);
                if (!published) {
                  toast.success(`Renamed to ${slug}`);
                  return;
                }
                await renamePage(published, slug);
                toast.success(`Renamed to ${slug}`);
                void queryClient.invalidateQueries({
                  queryKey: ["wiki-pages"],
                });
              })
              .catch((error: unknown) =>
                toast.error("Couldn't rename page", {
                  description:
                    error instanceof Error ? error.message : String(error),
                }),
              );
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
            ? `“${pendingDelete.slug}” is removed for everyone in this community. Its content is not recoverable.`
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
          void readFreshPages()
            .catch(() => null)
            .then(async (fresh) => {
              const published = fresh?.find((p) => p.slug === page.slug);
              if (!published) {
                toast.success(`Discarded ${page.slug}`);
                return;
              }
              await deletePage(published);
              toast.success(`Deleted ${page.slug}`);
              void queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
            })
            .catch((error: unknown) =>
              toast.error("Couldn't delete page", {
                description:
                  error instanceof Error ? error.message : String(error),
              }),
            );
        }}
        open={pendingDelete !== null}
        title="Delete this page?"
      />
    </div>
  );
}
