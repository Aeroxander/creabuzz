import { Link } from "@tanstack/react-router";

/** One hashtag in a list: the tag and how many people are posting it. */
export function HashtagRow({
  tag,
  count,
  compact = false,
}: {
  tag: string;
  count: number;
  /** The narrow side rail packs its rows tighter than the Explore page. */
  compact?: boolean;
}) {
  return (
    <Link
      className={
        compact
          ? "block px-4 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          : "block px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }
      params={{ tag }}
      to="/social/tag/$tag"
    >
      <span
        className={`block font-bold text-black dark:text-white ${compact ? "text-sm" : "text-base"}`}
      >
        #{tag}
      </span>
      <span className="text-xs text-black/60 dark:text-white/60">
        {count} {count === 1 ? "person" : "people"} posting
      </span>
    </Link>
  );
}
