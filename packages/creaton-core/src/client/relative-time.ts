/** Format a Unix timestamp (seconds) as a human-readable relative time string. */
export function relativeTime(unix: number): string {
  const diff = Date.now() - unix * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  if (days > 0) return days === 1 ? "1 day ago" : `${days} days ago`;
  if (hours > 0) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  if (minutes > 0)
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  return "just now";
}

/**
 * Compact timeline stamp: `now`, `5m`, `3h`, `2d`, then a calendar date
 * (`Mar 4`, or `Mar 4, 2024` once it is not this year). Takes seconds.
 */
export function shortRelativeTime(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(unix * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
