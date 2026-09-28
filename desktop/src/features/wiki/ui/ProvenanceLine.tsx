/**
 * The kind:44002 provenance line: `model · token cost · N source events`.
 *
 * Every distillation records what produced the standup (docs/agent-wiki.md),
 * and on this read surface that record is part of the page, not fine print.
 * Missing segments are dropped rather than rendered as "unknown"; with no
 * `model` tag the line names the author instead (never "unknown").
 */
import { truncatePubkey } from "@/shared/lib/pubkey";

import type { AgentWikiPage } from "../lib/pageIndex";

function costLabel(costTokens: number): string {
  return `${costTokens.toLocaleString()} token${costTokens === 1 ? "" : "s"}`;
}

function sourcesLabel(count: number): string {
  return `${count} source event${count === 1 ? "" : "s"}`;
}

export function ProvenanceLine({ page }: { page: AgentWikiPage }) {
  const { model, costTokens, sources } = page.provenance;
  const parts = [
    model ?? truncatePubkey(page.authorPubkey),
    ...(costTokens !== null ? [costLabel(costTokens)] : []),
    ...(sources.length > 0 ? [sourcesLabel(sources.length)] : []),
  ];
  return (
    <p
      className="truncate text-2xs text-muted-foreground"
      data-testid="wiki-provenance"
      title={
        sources.length > 0
          ? `Sources: ${sources.join(", ")}`
          : "This page carries no source event ids."
      }
    >
      {parts.join(" · ")}
    </p>
  );
}
