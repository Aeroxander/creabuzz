import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { reportRenderError } from "@/shared/lib/error-report";
import { errorMessage } from "@/shared/lib/readable-error";
import { TechnicalDetails } from "@/shared/ui/technical-details";

/**
 * Route-level failure and miss views.
 *
 * Without these, a render error anywhere in the client unmounts the whole SPA
 * and leaves a blank page with no way back — the app has no other error
 * boundary. Both views are reachable by URL, keep the layout intact, and give
 * the user an action.
 */
export function RouteErrorView({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  // The crash's own words are for whoever helps, under Technical details.
  const message = errorMessage(error);
  // A crash a screen caught never reaches the window's error event, so it is told here (and only when reporting is on).
  useEffect(() => {
    reportRenderError(error);
  }, [error]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-white/5"
        data-testid="route-error"
        role="alert"
      >
        <h1 className="text-lg font-semibold text-black dark:text-white">
          This page hit a problem
        </h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This page couldn&apos;t show its content. Try again, or reload the
          page.
        </p>
        <TechnicalDetails
          className="mt-2 text-left"
          detail={message}
          testId="route-error-details"
        />
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
            onClick={reset}
            type="button"
          >
            Try again
          </button>
          <button
            className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/15"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload
          </button>
          <Link
            className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/15"
            to="/c"
          >
            All communities
          </Link>
        </div>
      </div>
    </div>
  );
}

export function NotFoundView() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div
        className="w-full max-w-md text-center"
        data-testid="route-not-found"
      >
        <h1 className="text-lg font-semibold text-black dark:text-white">
          Page not found
        </h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This page doesn&apos;t exist. It may have moved, or the link may be
          wrong.
        </p>
        <Link
          className="mt-4 inline-block rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/15"
          to="/c"
        >
          All communities
        </Link>
      </div>
    </div>
  );
}
