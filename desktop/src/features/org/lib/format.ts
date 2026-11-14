/**
 * Count formatting for org surfaces (reference §5 typography: numbers read as
 * words next to their unit). One formatter so "1 agent seat" never ships as
 * "1 agent seats" again.
 */
export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
