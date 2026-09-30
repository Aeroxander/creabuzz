/**
 * The kind:44002 standup front-matter block (docs/agent-wiki.md).
 *
 * Agent wiki pages are `front-matter + body`; the block is written
 * deterministically by the CLI:
 *
 * ```
 * ---
 * slug: default/standup
 * agwiki-cursor: 1750000000
 * model: glm-5.3-flash
 * generated-at: 1750000000
 * ---
 * ```
 *
 * This is a deliberately small parser, not a YAML implementation: the block is
 * flat `key: value` lines and markdown is data to every consumer. A missing or
 * unterminated block is not an error — the page renders unchanged — while the
 * typed fields stay null so the distill loop (the strict reader) is the only
 * component that fails loudly on a corrupt cursor.
 *
 * Alias-free on purpose: `frontMatter.test.mjs` drives it under `node --test`.
 */

export type StandupFrontMatter = {
  /** Every `key: value` line of the block, first occurrence winning. */
  fields: Record<string, string>;
  /** The `slug` field (should mirror the `d` tag). */
  slug: string | null;
  /** The `agwiki-cursor` distill cursor, when it is a plain integer. */
  cursor: number | null;
  /** The `model` field — provenance also travels in tags (see provenance.ts). */
  model: string | null;
  /** The `generated-at` field, when it is a plain integer (unix seconds). */
  generatedAt: number | null;
  /** Body markdown with the block stripped (or the content unchanged). */
  body: string;
};

const INTEGER_PATTERN = /^-?\d+$/;

/** `key: value` with YAML-style inline comments (`value  # note`) stripped. */
function parseFieldLine(line: string): { key: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  if (key.length === 0) return null;
  let value = line.slice(colon + 1).trim();
  const comment = value.search(/\s#/);
  if (comment >= 0) {
    value = value.slice(0, comment).trim();
  }
  return { key, value };
}

function intValue(fields: Record<string, string>, key: string): number | null {
  const raw = fields[key];
  if (raw === undefined || !INTEGER_PATTERN.test(raw)) return null;
  return Number(raw);
}

function stringValue(
  fields: Record<string, string>,
  key: string,
): string | null {
  const raw = fields[key];
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/**
 * Parse the deterministic front-matter block off a kind:44002 page body.
 * A content without a closed `---` … `---` block returns empty fields and the
 * content unchanged as the body.
 */
export function parseFrontMatter(content: string): StandupFrontMatter {
  const empty: StandupFrontMatter = {
    fields: {},
    slug: null,
    cursor: null,
    model: null,
    generatedAt: null,
    body: content,
  };
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return empty;

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  // Unterminated block: not front matter this reader may half-interpret.
  if (close === -1) return empty;

  const fields: Record<string, string> = {};
  for (let i = 1; i < close; i += 1) {
    const field = parseFieldLine(lines[i]);
    // First occurrence wins; blank lines and junk lines are skipped.
    if (field && fields[field.key] === undefined) {
      fields[field.key] = field.value;
    }
  }

  // Drop the blank line(s) between the closing fence and the body so the
  // renderer starts on the first prose line.
  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n+/, "");

  return {
    fields,
    slug: stringValue(fields, "slug"),
    cursor: intValue(fields, "agwiki-cursor"),
    model: stringValue(fields, "model"),
    generatedAt: intValue(fields, "generated-at"),
    body,
  };
}
