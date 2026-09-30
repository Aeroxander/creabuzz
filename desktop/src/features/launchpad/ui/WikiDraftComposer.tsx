/**
 * One-tap wiki → proposal drafts (persona-drafting-loop B1) — the desktop
 * twin of web's `WikiDraftComposer`. Pick a wiki page from a dropdown (no
 * hashes anywhere), preview the decision blocks the deterministic composer
 * extracts, and land them as `agent-draft` records for counter-sign. The
 * extraction is `lib/draftProposal` — the same pure core as the CLI loop
 * (`buzz agwiki draft`) and web.
 */
import * as React from "react";

import { useWikiPages } from "@/features/wiki/useWikiPages";
import {
  humanPageCoordinate,
  type WikiPage,
} from "@/features/wiki/lib/pageIndex";
import {
  composeDraftEvent,
  decisionDrafts,
} from "@/features/launchpad/lib/draftProposal";
import { usePublishLaunchMirrorMutation } from "@/features/launchpad/hooks";
import type { Launch } from "@/features/launchpad/launchpadModels";
import { KIND_AGENT_WIKI_PAGE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

function pageCoordinate(page: WikiPage): string {
  return page.kind === "human"
    ? humanPageCoordinate(page.authorPubkey, page.slug)
    : `${KIND_AGENT_WIKI_PAGE}:${page.authorPubkey}:${page.d}`;
}

export function WikiDraftComposer({ launch }: { launch: Launch }) {
  const wiki = useWikiPages();
  const mirror = usePublishLaunchMirrorMutation();
  const [selected, setSelected] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);

  // D7 dedupe: live records carry their `wiki` source — a block already
  // drafted is never re-drafted.
  const landed = React.useMemo(() => {
    const set = new Set<string>();
    for (const p of launch.proposals) {
      if (p.source) set.add(`${p.source.page}#${p.source.anchor}`);
    }
    return set;
  }, [launch.proposals]);

  const pages = wiki.data ?? [];
  const page = pages.find((p) => p.key === selected) ?? null;
  const coordinate = page ? pageCoordinate(page) : null;
  const composed = React.useMemo(
    () => (page ? decisionDrafts(page.content) : null),
    [page],
  );
  const fresh = composed
    ? composed.drafts.filter((d) => !landed.has(`${coordinate}#${d.anchor}`))
    : [];

  const launchCoordinate = `37001:${launch.record.author}:${launch.record.id}`;

  const land = async () => {
    if (!coordinate || fresh.length === 0) return;
    setNote(null);
    try {
      for (const row of fresh) {
        const draft = composeDraftEvent(launchCoordinate, coordinate, row);
        await mirror.mutateAsync({
          kind: 47004,
          author: launch.record.author,
          launchId: launch.record.id,
          // The mutation supplies the `a` tag; the composer's wiki tag rides
          // along verbatim (D7/D8).
          extraTags: draft.tags.filter((tag) => tag[0] !== "a"),
          content: JSON.parse(draft.content) as Record<string, unknown>,
        });
      }
      setNote(
        `${fresh.length} draft(s) landed — counter-sign them in the list below.`,
      );
      setSelected("");
    } catch (error) {
      setNote(
        error instanceof Error ? error.message : "The drafts did not land.",
      );
    }
  };

  return (
    <Card className="p-3" data-testid="wiki-draft-composer">
      <h3 className="text-sm font-semibold">Draft proposals from the wiki</h3>
      <p className="text-2xs text-muted-foreground">
        Decision blocks in a wiki page become agent-drafts — verbatim evidence
        only, nothing invented. Land them here, then counter-sign.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Wiki page"
          className="rounded-md border bg-transparent px-2 py-1 text-2xs"
          onChange={(event) => {
            setSelected(event.target.value);
            setNote(null);
          }}
          value={selected}
        >
          <option value="">Choose a wiki page…</option>
          {pages.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key}
            </option>
          ))}
        </select>
        {fresh.length > 0 ? (
          <Button
            data-testid="wiki-draft-land"
            disabled={mirror.isPending}
            onClick={() => void land()}
            size="sm"
            type="button"
          >
            {mirror.isPending ? "Landing…" : `Land ${fresh.length} draft(s)`}
          </Button>
        ) : null}
        {note ? (
          <span className="text-2xs text-muted-foreground">{note}</span>
        ) : null}
      </div>
      {composed && coordinate ? (
        <ul className="mt-2 space-y-1 text-2xs">
          {composed.drafts.map((row) => (
            <li className="text-muted-foreground" key={row.anchor}>
              #{row.anchor} · {row.kind} · {row.title}
              {landed.has(`${coordinate}#${row.anchor}`)
                ? " · already drafted"
                : ""}
            </li>
          ))}
          {composed.skipped.map((skip) => (
            <li
              className="text-muted-foreground/60"
              key={`skip-${skip.anchor}`}
            >
              #{skip.anchor} skipped — {skip.reason}
            </li>
          ))}
          {composed.drafts.length === 0 && composed.skipped.length === 0 ? (
            <li className="text-muted-foreground/60">
              No decision blocks on this page.
            </li>
          ) : null}
        </ul>
      ) : null}
    </Card>
  );
}
