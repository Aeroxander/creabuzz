/**
 * The kind:44002 provenance line: `Published by Alice · glm-5.3` (signer
 * first, model second) plus optional token cost and source events.
 *
 * Every distillation records what produced the standup (docs/agent-wiki.md),
 * and on this read surface that record is part of the page, not fine print.
 * Missing segments are dropped rather than rendered as "unknown"; a signer
 * without a profile falls back to a truncated pubkey (never "unknown").
 */
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useUsersBatchQuery } from "@/features/profile/hooks";

import type { AgentWikiPage } from "../lib/pageIndex";
import { publishedByLabel } from "../lib/provenance";

function costLabel(costTokens: number): string {
  return `${costTokens.toLocaleString()} token${costTokens === 1 ? "" : "s"}`;
}

function sourcesLabel(count: number): string {
  return `${count} source event${count === 1 ? "" : "s"}`;
}

export function ProvenanceLine({ page }: { page: AgentWikiPage }) {
  const { model, costTokens, sources } = page.provenance;
  // The signer's profile name is the attribution; the model tag is secondary.
  const profiles = useUsersBatchQuery([page.authorPubkey]);
  const summary =
    profiles.data?.profiles[page.authorPubkey.trim().toLowerCase()];
  const parts = [
    publishedByLabel(
      summary?.displayName?.trim() || summary?.name?.trim() || null,
      model,
      truncatePubkey(page.authorPubkey),
    ),
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
