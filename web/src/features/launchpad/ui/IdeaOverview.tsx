/**
 * The overview of a project that has no Shares and no sale: what it is, in the founder's words, and what following it
 * gives. No tables of empty sale terms: there are none yet.
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
        <h2 className="text-sm font-bold">A project in the open</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {raises ? "There is no token and no money involved yet. " : null}
          {/* A chat is only promised where the project has one. */}
          {record.chat.supporters
            ? "Follow it to get its updates and join the supporters chat."
            : "Follow it to get its updates."}
          {raises
            ? " If the founder opens a sale, you will be able to back it for real, and backers get their own room."
            : null}
        </p>
      </Card>
    </div>
  );
}
