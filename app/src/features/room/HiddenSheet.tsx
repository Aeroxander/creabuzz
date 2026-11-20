/**
 * "Hidden people": the people this account has hidden for itself, with a way to show each again. Hiding is only the person's
 * own: nothing is sent to anyone, and the hidden person is never told.
 */
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { nameOf, useProfiles } from "../../lib/profiles";

export function HiddenSheet({
  open,
  onOpenChange,
  hidden,
  onShowAgain,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden: readonly string[];
  onShowAgain: (pubkey: string) => void;
  pending: boolean;
}) {
  const profiles = useProfiles(open ? hidden : []).data;
  return (
    <Sheet
      description="You do not see their posts. Only you stop seeing them."
      onOpenChange={onOpenChange}
      open={open}
      testId="hidden-sheet"
      title="Hidden people"
    >
      {hidden.length === 0 ? (
        <p className="text-sm text-muted">You have not hidden anyone.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {hidden.map((pubkey) => (
            <li
              className="flex min-h-11 items-center justify-between gap-3"
              key={pubkey}
            >
              <span className="min-w-0 truncate">
                {nameOf(profiles, pubkey)}
              </span>
              <Button
                disabled={pending}
                onClick={() => onShowAgain(pubkey)}
                size="sm"
                variant="secondary"
              >
                Show again
                <span className="sr-only"> {nameOf(profiles, pubkey)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
