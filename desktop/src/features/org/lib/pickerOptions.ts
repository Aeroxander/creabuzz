/**
 * Pure helpers behind the org entity picker: case-insensitive search
 * filtering and d-tag slug generation. Framework-free so node --test
 * units can cover them directly.
 */

export type PickerOptionLike = {
  label: string;
  sub?: string;
};

/** Case-insensitive substring match over `label` and `sub`. */
export function filterPickerOptions<T extends PickerOptionLike>(
  options: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.sub?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * Slugify a human name into an addressable-event d tag: lowercase,
 * non-alphanumerics collapsed to single dashes, edges trimmed.
 * Returns an empty string when nothing usable remains.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
