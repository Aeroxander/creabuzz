/**
 * One-tap wiki → proposal drafts (persona-drafting-loop B1): pick a wiki page
 * from a dropdown (no hashes anywhere), preview the decision blocks the
 * deterministic composer extracts, and land them as `agent-draft` records for
 * counter-sign. The extraction is `../lib/draft-proposal` — the same pure
 * core the CLI loop (`buzz agwiki draft`) and desktop run.
 */
import { useMemo, useState } from "react";

import { useWikiPages } from "@/features/wiki/use-wiki-pages";
import { pageCoordinate } from "@/features/wiki/lib/page-index";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { composeDraftEvent, decisionDrafts } from "../lib/draft-proposal";
import type { LaunchProposal } from "../models";
import { publishMirror } from "../use-launches";

export function WikiDraftComposer({
  launchCoordinate,
  proposals,
}: {
  launchCoordinate: string;
  proposals: LaunchProposal[];
}) {
  const wiki = useWikiPages(true);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Only published pages carry the coordinate a draft can point at (D8).
  const pages = useMemo(
    () => wiki.pages.filter((p) => !p.draft && p.authorPubkey),
    [wiki.pages],
  );

  // D7 dedupe: live records carry their `wiki` source — a block already
  // drafted is never re-drafted.
  const landed = useMemo(() => {
    const set = new Set<string>();
    for (const p of proposals) {
      if (p.source) set.add(`${p.source.page}#${p.source.anchor}`);
    }
    return set;
  }, [proposals]);

  const page = pages.find((p) => p.slug === selected) ?? null;
  const coordinate = page?.authorPubkey
    ? pageCoordinate(page.authorPubkey, page.slug)
    : null;
  const composed = useMemo(
    () => (page ? decisionDrafts(page.content) : null),
    [page],
  );
  const fresh = composed
    ? composed.drafts.filter((d) => !landed.has(`${coordinate}#${d.anchor}`))
    : [];

  const land = async () => {
    if (!coordinate || fresh.length === 0) return;
    setPending(true);
    setNote(null);
    try {
      for (const row of fresh) {
        await publishMirror(
          composeDraftEvent(launchCoordinate, coordinate, row),
        );
      }
      setNote(
        `${fresh.length} draft(s) landed — counter-sign them in the list below.`,
      );
      setSelected("");
    } catch (error) {
      setNote(
        error instanceof Error ? error.message : "The drafts did not land.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="p-3" data-testid="wiki-draft-composer">
      <h3 className="text-sm font-semibold">Draft proposals from the wiki</h3>
      <p className="text-xs text-black/60 dark:text-white/60">
        Decision blocks in a wiki page become agent-drafts — verbatim evidence
        only, nothing invented. Land them here, then counter-sign.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Wiki page"
          className="rounded-md border bg-transparent px-2 py-1 text-xs"
          onChange={(event) => {
            setSelected(event.target.value);
            setNote(null);
          }}
          value={selected}
        >
          <option value="">Choose a wiki page…</option>
          {pages.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.slug}
            </option>
          ))}
        </select>
        {fresh.length > 0 ? (
          <Button
            data-testid="wiki-draft-land"
            disabled={pending}
            onClick={() => void land()}
            size="sm"
            type="button"
          >
            {pending ? "Landing…" : `Land ${fresh.length} draft(s)`}
          </Button>
        ) : null}
        {note ? (
          <span className="text-xs text-black/70 dark:text-white/70">
            {note}
          </span>
        ) : null}
      </div>
      {composed && coordinate ? (
        <ul className="mt-2 space-y-1 text-xs">
          {composed.drafts.map((row) => (
            <li className="text-black/70 dark:text-white/70" key={row.anchor}>
              #{row.anchor} · {row.kind} · {row.title}
              {landed.has(`${coordinate}#${row.anchor}`)
                ? " · already drafted"
                : ""}
            </li>
          ))}
          {composed.skipped.map((skip) => (
            <li
              className="text-black/50 dark:text-white/50"
              key={`skip-${skip.anchor}`}
            >
              #{skip.anchor} skipped — {skip.reason}
            </li>
          ))}
          {composed.drafts.length === 0 && composed.skipped.length === 0 ? (
            <li className="text-black/50 dark:text-white/50">
              No decision blocks on this page.
            </li>
          ) : null}
        </ul>
      ) : null}
    </Card>
  );
}
