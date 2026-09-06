import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, CloudUpload, FilePlus2, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { extractLinks, useWikiPages, type WikiPage } from "../use-wiki-pages";
import { useLiveWikiDoc } from "../wiki-sync";
import { WikiGraph } from "./WikiGraph";

type Tab = "edit" | "graph";

export function WikiView() {
  const { pages, isLoading, savePage } = useWikiPages(true);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("edit");
  const [activeSlug, setActiveSlug] = useState<string | null>(
    () => pages[0]?.slug ?? null,
  );
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const active = pages.find((p) => p.slug === activeSlug) ?? null;
  const { content, setContent, touched } = useLiveWikiDoc(
    activeSlug,
    active?.content ?? "",
  );

  const selectPage = (page: WikiPage) => {
    setActiveSlug(page.slug);
    setPreview(false);
  };

  const createPage = () => {
    const slug = prompt("Page slug (e.g. company-profile):");
    if (!slug || slug.trim().length === 0) return;
    const normalized = slug.trim().toLowerCase().replace(/\s+/g, "-");
    if (pages.some((p) => p.slug === normalized)) {
      selectPage(pages.find((p) => p.slug === normalized)!);
      return;
    }
    setActiveSlug(normalized);
    setPreview(false);
  };

  const save = async () => {
    if (!activeSlug) return;
    setSaving(true);
    try {
      await savePage(activeSlug, content);
      setDirty(false);
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

  // Live multi-tab convergence: debounce auto-save to the relay so every tab
  // converges via snapshots even without a P2P signaling path; manual Save is
  // still available. (True CRDT P2P stays wired in wiki-sync for relays that
  // accept Trystero signaling.)
  useEffect(() => {
    if (!activeSlug || !dirty) return;
    const timer = setTimeout(() => {
      void savePage(activeSlug, content)
        .then(() => {
          setDirty(false);
          void queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
        })
        .catch((error) => {
          console.warn("[wiki] auto-save failed", error);
        });
    }, 4000);
    return () => clearTimeout(timer);
  }, [activeSlug, content, dirty, savePage, queryClient]);

  // Pull in snapshots saved by other tabs only while the live doc is
  // untouched — once we've typed or received P2P edits, the live doc is
  // authoritative and must never be clobbered by a stale snapshot.
  useEffect(() => {
    if (!active || touched || content === active.content) return;
    setContent(active.content);
  }, [active, content, touched, setContent]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] dark:border-white/10 dark:bg-[#1B1B1B]">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-black/70 dark:text-white/70">
            <BookOpen className="h-4 w-4" /> Wiki
          </span>
          <button
            type="button"
            onClick={createPage}
            className="rounded p-1 text-black/50 hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10"
            aria-label="New page"
            data-testid="wiki-new-page"
          >
            <FilePlus2 className="h-4 w-4" />
          </button>
        </div>
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
          ) : pages.length === 0 ? (
            <p className="px-2 py-3 text-xs text-black/45 dark:text-white/45">
              No pages yet. Create the first one.
            </p>
          ) : (
            pages.map((page) => (
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
              </button>
            ))
          )}
        </nav>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10">
          <div className="flex items-center gap-1 rounded-md bg-black/5 p-1 dark:bg-white/10">
            <button
              type="button"
              onClick={() => setTab("edit")}
              className={`rounded px-2 py-1 text-xs font-medium ${
                tab === "edit"
                  ? "bg-white text-black shadow-xs dark:bg-white/20 dark:text-white"
                  : "text-black/60 dark:text-white/60"
              }`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setTab("graph")}
              className={`rounded px-2 py-1 text-xs font-medium ${
                tab === "graph"
                  ? "bg-white text-black shadow-xs dark:bg-white/20 dark:text-white"
                  : "text-black/60 dark:text-white/60"
              }`}
            >
              Graph
            </button>
          </div>
          <span className="truncate text-sm font-medium text-black/70 dark:text-white/70">
            {activeSlug ?? "wiki"}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-black/45 dark:text-white/45">
            <CloudUpload className="h-3 w-3" /> auto-saves
            {links.length > 0 && (
              <span className="flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> {links.length} link
                {links.length === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              onClick={() => setPreview((p) => !p)}
              className="rounded border border-black/15 px-2 py-1 dark:border-white/15"
              data-testid="wiki-preview-toggle"
            >
              {preview ? "Source" : "Preview"}
            </button>
          </span>
        </div>

        {tab === "graph" ? (
          <WikiGraph pages={pages} />
        ) : activeSlug ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {preview ? (
                <article className="prose prose-sm max-w-none dark:prose-invert [&_pre]:overflow-x-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content}
                  </ReactMarkdown>
                </article>
              ) : (
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
              )}
            </div>
            <div className="flex items-center justify-end border-t border-black/10 px-4 py-2 dark:border-white/10">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                data-testid="wiki-save"
              >
                <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save page"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/45 dark:text-white/45">
            Select a page or create one.
          </div>
        )}
      </div>
    </div>
  );
}
