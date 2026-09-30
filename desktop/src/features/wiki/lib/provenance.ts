/**
 * Provenance extraction for kind:44002 agent wiki pages (docs/agent-wiki.md).
 *
 * Every distillation records `model`, `cost_tokens`, and `sources` tags,
 * bounded at ingest (at most one each: model ≤128 chars, cost_tokens a decimal
 * ≤16 chars, sources ≤64 comma-separated lowercase 64-hex event ids). Tags are
 * untrusted input, so the read side re-checks each bound instead of trusting
 * the envelope — a malformed value degrades to "no provenance", never to a
 * broken render.
 *
 * Alias-free on purpose: `provenance.test.mjs` drives it under `node --test`.
 */

export type WikiProvenance = {
  /** The `model` tag (e.g. "glm-5.3-flash"); null when absent. */
  model: string | null;
  /** The `cost_tokens` tag as a count; null when absent or malformed. */
  costTokens: number | null;
  /** The `sources` tag — valid source event ids, in order, deduplicated. */
  sources: string[];
};

/** Ingest bounds from docs/agent-wiki.md, mirrored read-side. */
export const PROVENANCE_MAX_MODEL_CHARS = 128;
export const PROVENANCE_MAX_COST_CHARS = 16;
export const PROVENANCE_MAX_SOURCES = 64;

const COST_PATTERN = /^\d{1,16}$/;
const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;

/** First non-empty value of a single-value tag, or null. */
function singleTagValue(
  tags: ReadonlyArray<readonly string[]>,
  name: string,
): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/**
 * Extract the provenance tags of one kind:44002 event. Malformed values are
 * dropped (not guessed at): a non-decimal cost is null, source ids that are
 * not 64-hex are skipped.
 */
export function extractProvenance(
  tags: ReadonlyArray<readonly string[]>,
): WikiProvenance {
  const rawModel = singleTagValue(tags, "model");
  const model =
    rawModel === null
      ? null
      : rawModel.trim().slice(0, PROVENANCE_MAX_MODEL_CHARS) || null;

  const rawCost = singleTagValue(tags, "cost_tokens");
  const costTokens =
    rawCost !== null && COST_PATTERN.test(rawCost.trim())
      ? Number(rawCost.trim())
      : null;

  const rawSources = singleTagValue(tags, "sources");
  const sources: string[] = [];
  if (rawSources !== null) {
    const seen = new Set<string>();
    for (const piece of rawSources.split(",")) {
      if (sources.length >= PROVENANCE_MAX_SOURCES) break;
      // Ids are lowercase 64-hex at ingest; normalise case defensively so an
      // uppercased mirror still counts as the same event id.
      const id = piece.trim().toLowerCase();
      if (!EVENT_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      sources.push(id);
    }
  }

  return { model, costTokens, sources };
}
