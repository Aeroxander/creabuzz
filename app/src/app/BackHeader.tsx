import { useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A screen reached from another: Back on the left (to where the person came from, else Home), a title, an action.
 * The title is the screen's heading unless the screen has its own (`heading={false}`), so there is one h1 per screen.
 */
export function BackHeader({
  title,
  action,
  heading = true,
}: {
  title: string;
  action?: ReactNode;
  heading?: boolean;
}) {
  const Title = heading ? "h1" : "p";
  const router = useRouter();
  return (
    <header className="flex min-h-12 items-center justify-between gap-2">
      <button
        aria-label="Go back"
        className="btn btn-ghost btn-sm -ml-2 text-ink"
        data-testid="back"
        onClick={() => {
          if (window.history.length > 1) router.history.back();
          else void router.navigate({ to: "/" });
        }}
        type="button"
      >
        <ChevronLeft aria-hidden="true" size={20} />
        Back
      </button>
      <Title className="truncate text-base font-semibold">{title}</Title>
      <div className="min-w-16 text-right">{action}</div>
    </header>
  );
}

/** The top of a tab's own screen: its name in large type, and at most one action. */
export function ScreenHeader({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3 pt-2">
      <div className="min-w-0">
        {lead}
        <h1 className="headline text-3xl">{title}</h1>
      </div>
      {action ? <div className="shrink-0 pt-1">{action}</div> : null}
    </header>
  );
}
