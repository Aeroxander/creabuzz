import { Link } from "@tanstack/react-router";

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
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-white/5"
        data-testid="route-error"
        role="alert"
      >
        <h1 className="text-lg font-semibold text-black dark:text-white">
          Something went wrong
        </h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This view stopped responding to its data. Reloading usually clears it.
        </p>
        <p className="mt-2 break-words text-xs text-black/60 dark:text-white/60">
          {message}
        </p>
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
          Nothing here
        </h1>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          That address does not match a page in this workspace.
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
