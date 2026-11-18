/**
 * The room composer's mentions, as pure helpers so `composer-mentions.test.mjs` drives the code the composer runs.
 *
 * A chosen mention is written into the box as `@Name ` and remembered as {pubkey, name}. Who is told (a `p` tag) is
 * decided at send time from the words actually in the box: a mention whose label was deleted tags nobody (no ghost
 * ping). Labels are matched whole (`@Al` is not inside `@Alice`) and the longest label owns an occurrence (`@Al Smith`
 * is Al Smith, not Al). When several chosen people share one label, each occurrence left in the box keeps one of them,
 * newest choice first: the box cannot say which occurrence was deleted, so the oldest choices go first.
 */

export interface PickedMention {
  pubkey: string;
  name: string;
}

const LABEL_END = /[\p{L}\p{N}_]/u;

/** Start indexes of whole `@label` occurrences in `text`. */
function occurrences(text: string, label: string): number[] {
  const needle = `@${label}`;
  const found: number[] = [];
  if (label === "") return found;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text.slice(at + needle.length, at + needle.length + 1);
    if ((before === "" || /\s/.test(before)) && !LABEL_END.test(after)) {
      found.push(at);
    }
  }
  return found;
}

/** The people to tag: those chosen whose `@Name` is still in `draft`, each once, in the order chosen. */
export function mentionedPubkeys(
  draft: string,
  picked: readonly PickedMention[],
): string[] {
  const labels = [...new Set(picked.map((p) => p.name))].sort(
    (a, b) => b.length - a.length,
  );
  const claimed: Array<[number, number]> = [];
  const counts = new Map<string, number>();
  for (const label of labels) {
    let count = 0;
    for (const start of occurrences(draft, label)) {
      const end = start + label.length + 1;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      count += 1;
    }
    counts.set(label, count);
  }
  const keep = new Set<number>();
  // Newest choice first for each label, as many as there are occurrences left.
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const left = counts.get(picked[i].name) ?? 0;
    if (left <= 0) continue;
    counts.set(picked[i].name, left - 1);
    keep.add(i);
  }
  const out: string[] = [];
  picked.forEach((p, i) => {
    if (keep.has(i) && !out.includes(p.pubkey)) out.push(p.pubkey);
  });
  return out;
}

/** What a key press in the composer does. */
export type ComposerKey =
  | { type: "move"; index: number }
  | { type: "pick"; index: number }
  | { type: "close" }
  | { type: "send" }
  | null;

/**
 * While suggestions are open, arrows move, Enter or Tab picks the highlighted one and Escape closes the list: Enter
 * never sends a half-typed name. Otherwise Enter sends and Shift+Enter is a new line. Enter that confirms an input
 * method's composition (Japanese, Chinese, ...) is the input method's, never a send. Safari sends that Enter with
 * `isComposing` false but `keyCode` 229, so either one marks it.
 */
export function composerKey(press: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  /** The legacy `keyCode`: 229 is a key the input method is handling. */
  keyCode?: number;
  suggestions: number;
  active: number;
}): ComposerKey {
  if (press.isComposing || press.keyCode === 229) return null;
  const { suggestions } = press;
  if (suggestions > 0) {
    const active = Math.min(Math.max(press.active, 0), suggestions - 1);
    if (press.key === "ArrowDown")
      return { type: "move", index: (active + 1) % suggestions };
    if (press.key === "ArrowUp")
      return { type: "move", index: (active - 1 + suggestions) % suggestions };
    if ((press.key === "Enter" || press.key === "Tab") && !press.shiftKey)
      return { type: "pick", index: active };
    if (press.key === "Escape") return { type: "close" };
    return null;
  }
  if (press.key === "Enter" && !press.shiftKey) return { type: "send" };
  return null;
}

/** The id of a suggestion row, so the box can name the highlighted one to screen readers. */
export function mentionOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
