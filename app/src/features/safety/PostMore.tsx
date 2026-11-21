/**
 * The "More" press on a post anywhere outside a holder room: Report and Hide this person's posts. It reuses the room's own
 * menu, report sheet and words, so a post says the same thing wherever it is read. A reported post is hidden for the reporter
 * once the sheet is closed, with the offer to hide everything the person writes; hiding is the reader's own and nothing is
 * sent to the person.
 */
import { lazy, Suspense, useState } from "react";
import { useAccount } from "../../lib/account";
import { useMutes } from "../../lib/mutes";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import type { SignedEvent } from "../posts/use-posts";
import { type MenuChoice, PostMenu } from "../room/PostMenu";
import { HIDE_DONE, NOT_SAVED } from "../room/room-words";
import { REPORTED_HIDDEN, hideWords } from "./safety-words";
import { useReported } from "./reported";

// The report sheet loads when a report is first started: it is not needed to read a post.
const ReportSheet = lazy(() =>
  import("../room/RoomSheets").then((m) => ({ default: m.ReportSheet })),
);

export function PostMore({
  event,
  name,
}: {
  event: SignedEvent;
  /** The author's name, for the presses' names. */
  name: string;
}) {
  const { pubkey: me } = useAccount();
  const requireAccount = useRequireAccount();
  const mutes = useMutes();
  const reported = useReported();
  const toast = useToast();
  const [reporting, setReporting] = useState<SignedEvent | null>(null);
  // Once a report has been started its sheet stays drawn (closed), so it closes the way every sheet does.
  const [started, setStarted] = useState(false);

  const hide = () =>
    mutes
      .hide(event.pubkey)
      .then(() => toast(hideWords(HIDE_DONE(name)), "done"))
      .catch((error: Error) => toast(error.message || NOT_SAVED, "problem"));

  const onChoose = (choice: MenuChoice) => {
    if (choice === "report")
      requireAccount(() => {
        setStarted(true);
        setReporting(event);
      });
    else if (choice === "hide") requireAccount(() => void hide());
  };
  return (
    <>
      <PostMenu
        mine={me === event.pubkey}
        name={name}
        onChoose={onChoose}
        stopped={false}
        teamCanRemove={false}
        teamCanStop={false}
      />
      {started ? (
        <Suspense fallback={null}>
          <ReportSheet
            afterSent={(close) => (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted">{REPORTED_HIDDEN}</p>
                <div>
                  <Button
                    data-testid="report-hide-person"
                    onClick={() => {
                      close();
                      void hide();
                    }}
                    size="sm"
                    variant="secondary"
                  >{`Hide ${name}'s posts too`}</Button>
                </div>
              </div>
            )}
            onOpenChange={(open) => !open && setReporting(null)}
            onSent={(post) => reported.add(post.id)}
            post={reporting}
          />
        </Suspense>
      ) : null}
    </>
  );
}
