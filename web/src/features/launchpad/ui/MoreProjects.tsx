import { readableError } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";

import type { useLaunches } from "../use-launches";

/**
 * What stands under a list of projects that is read a page at a time: the button for the next page, the failure of
 * a page with its retry (the projects already shown stay), or, when no further page can be read, a line saying the
 * list is not everything. Nothing when the list is complete.
 */
export function MoreProjects({
  launches,
}: {
  launches: Pick<
    ReturnType<typeof useLaunches>,
    "hasMore" | "loadMore" | "loadingMore" | "moreError" | "cut" | "newsCut"
  >;
}) {
  const { hasMore, loadMore, loadingMore, moreError, cut, newsCut } = launches;
  if (!hasMore && !moreError && !cut && !newsCut) return null;
  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      {moreError ? (
        <p data-testid="more-projects-failed" role="alert">
          Couldn't load more projects. {readableError(moreError)} The ones above
          are still here.{" "}
          <Button
            data-testid="more-projects-retry"
            disabled={loadingMore}
            onClick={loadMore}
            size="sm"
            type="button"
            variant="outline"
          >
            {loadingMore ? "Loading…" : "Try again"}
          </Button>
        </p>
      ) : hasMore ? (
        <Button
          data-testid="more-projects"
          disabled={loadingMore}
          onClick={loadMore}
          size="sm"
          type="button"
          variant="outline"
        >
          {loadingMore ? "Loading…" : "Show more projects"}
        </Button>
      ) : cut ? (
        <p data-testid="more-projects-cut" role="status">
          There are more projects on this server than can be listed here. An
          older project still opens from its link.
        </p>
      ) : null}
      {newsCut ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="more-projects-news-cut"
          role="status"
        >
          This server has more project news than could be read at once, so a
          project here may be shown without its latest. Its own page has all of
          it.
        </p>
      ) : null}
    </div>
  );
}
