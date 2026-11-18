import { UserRound } from "lucide-react";

import { UserAvatar } from "@/shared/ui/UserAvatar";

/** A wallet's label is a short address when nobody on this server bound it to an account. */
const isAddressLabel = (label: string) => /^0x[0-9a-f]/i.test(label.trim());

/**
 * A person on a project page, as a small disc: their initials when they have a name here, a plain figure when all that
 * is known is a wallet. Decorative next to the name, which is always written beside it.
 */
function Face({ label }: { label: string }) {
  if (isAddressLabel(label)) {
    return (
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
      >
        <UserRound className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span aria-hidden className="shrink-0">
      <UserAvatar avatarUrl={null} displayName={label} size="sm" />
    </span>
  );
}

/** A person written as a face and their name. */
export function Person({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Face label={label} />
      <span className="truncate">{label}</span>
    </span>
  );
}
