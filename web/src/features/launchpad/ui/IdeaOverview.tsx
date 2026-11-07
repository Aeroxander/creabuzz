/**
 * The overview of an idea: what it is, in the founder's words, and what
 * happens next. No tables of empty sale terms: there are none yet.
 */

import { Card } from "@/shared/ui/card";

import { raisesOffered } from "../lib/raises-offered";
import type { LaunchRecord } from "../models";

export function IdeaOverview({ record }: { record: LaunchRecord }) {
  // A build that offers no raises has no sale to promise.
  const raises = raisesOffered();
  return (
    <div className="flex flex-col gap-4" data-testid="idea-overview">
      {record.longPitch ? (
        <Card className="p-4">
          <h2 className="text-sm font-bold">About</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{record.longPitch}</p>
        </Card>
      ) : null}
      <Card className="p-4">
        <h2 className="text-sm font-bold">This is an idea</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {raises
            ? "There is no token and no money involved yet. Say you would back it to join the supporters chat and help it get going."
            : "Say you're interested to join the supporters chat and help it get going."}
          {raises
            ? " If the founder opens a sale, you will be able to back it for real, and backers get their own room."
            : null}
        </p>
      </Card>
    </div>
  );
}
