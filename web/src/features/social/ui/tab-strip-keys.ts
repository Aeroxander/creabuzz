/**
 * Which tab a key moves to in a row of tabs: Left/Right step and wrap, Home/End jump to the ends. `null` for a key the
 * tab row does not use, so the browser keeps its own meaning for it.
 *
 * Alias-free for `node --test`.
 */
export function tabKeyTarget(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
