/**
 * The "More" press on a post anywhere outside a holder room. For someone else's post: Repost, Quote, Hide the pictures,
 * Report and Hide this person's posts. For the viewer's own post: Edit (while nobody has commented) and Delete, with what
 * deleting can and cannot do said before it is done. Report reuses the room's own report sheet and words, so a post says the
 * same thing wherever it is read. A reported post is hidden for the reporter once the sheet is closed, with the offer to hide
 * everything the person writes; hiding is the reader's own and nothing is sent to the person.
 */
import { postParts } from "@creaton/core/social/post-compose.ts";
import { parseNote } from "@creaton/core/social/feed/feed-events.ts";
import { lazy, Suspense, useMemo, useState } from "react";
import { LazyComposer } from "../posts/LazyComposer";
import { useAccount } from "../../lib/account";
import { useMutes } from "../../lib/mutes";
import { isServerPicture } from "../../lib/server-picture";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { pictureKey, useHiddenPictures } from "../pictures/hidden-pictures";
import {
  hidePicturesWords,
  PICTURES_HIDDEN_DONE,
} from "../pictures/picture-words";
import {
  DELETE,
  DELETE_CAN,
  DELETE_CANNOT,
  DELETE_TITLE,
  DELETED_DONE,
  EDIT,
  EDIT_HAS_COMMENTS,
  QUOTE,
  REPOST,
  REPOSTED_DONE,
  UNREPOST,
  UNREPOSTED_DONE,
} from "../posts/post-words";
import {
  type Engagement,
  type SignedEvent,
  useDeletePost,
  useRepost,
} from "../posts/use-posts";
import { type ExtraItem, type MenuChoice, PostMenu } from "../room/PostMenu";
import { HIDE_DONE, NOT_SAVED } from "../room/room-words";
import { useReported } from "./reported";
import { hideWords, REPORTED_HIDDEN } from "./safety-words";

// The report sheet loads when a report is first started: it is not needed to read a post.
const ReportSheet = lazy(() =>
  import("../room/RoomSheets").then((m) => ({ default: m.ReportSheet })),
);

export function PostMore({
  event,
  name,
  engagement,
}: {
  event: SignedEvent;
  /** The author's name, for the presses' names. */
  name: string;
  /** The post's counts: whether it has comments (no edit then) and the viewer's own repost (to take back). */
  engagement?: Pick<Engagement, "replies" | "viewerRepostId">;
}) {
  const { pubkey: me } = useAccount();
  const requireAccount = useRequireAccount();
  const mutes = useMutes();
  const reported = useReported();
  const hiddenPictures = useHiddenPictures();
  const repost = useRepost();
  const remove = useDeletePost();
  const toast = useToast();
  const [reporting, setReporting] = useState<SignedEvent | null>(null);
  // Once a report has been started its sheet stays drawn (closed), so it closes the way every sheet does.
  const [started, setStarted] = useState(false);
  // The writing box, once started, stays drawn (closed) so it closes the way every sheet does and focus goes back.
  const [writing, setWriting] = useState<"quote" | "edit" | null>(null);
  const [writingOpen, setWritingOpen] = useState(false);
  const write = (kind: "quote" | "edit") =>
    requireAccount(() => {
      setWriting(kind);
      setWritingOpen(true);
    });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const mine = me === event.pubkey;
  const pictures = useMemo(
    () => postParts(event, isServerPicture).pictures,
    [event],
  );
  const isReply = parseNote(event)?.rootId != null;
  const myRepost = engagement?.viewerRepostId ?? null;

  const hide = () =>
    mutes
      .hide(event.pubkey)
      .then(() => toast(hideWords(HIDE_DONE(name)), "done"))
      .catch((error: Error) => toast(error.message || NOT_SAVED, "problem"));

  const extra: ExtraItem[] = mine
    ? [
        ...(isReply
          ? []
          : [
              {
                choice: "edit" as const,
                label: EDIT,
                ...((engagement?.replies ?? 0) > 0
                  ? { unavailable: EDIT_HAS_COMMENTS }
                  : {}),
              },
            ]),
        { choice: "delete" as const, label: DELETE },
      ]
    : [
        myRepost
          ? { choice: "unrepost" as const, label: UNREPOST }
          : { choice: "repost" as const, label: REPOST },
        { choice: "quote" as const, label: QUOTE },
        ...(pictures.length > 0
          ? [
              {
                choice: "hide-pictures" as const,
                label: hidePicturesWords(pictures.length),
              },
            ]
          : []),
      ];

  const onChoose = (choice: MenuChoice) => {
    if (choice === "report")
      requireAccount(() => {
        setStarted(true);
        setReporting(event);
      });
    else if (choice === "hide") requireAccount(() => void hide());
    else if (choice === "quote") write("quote");
    else if (choice === "edit") write("edit");
    else if (choice === "delete") setConfirmingDelete(true);
    else if (choice === "repost" || choice === "unrepost")
      requireAccount(() =>
        repost.mutate(
          { post: event, undoId: choice === "unrepost" ? myRepost : null },
          {
            onSuccess: () =>
              toast(
                choice === "unrepost" ? UNREPOSTED_DONE : REPOSTED_DONE,
                "done",
              ),
            onError: (error) => toast(error.message, "problem"),
          },
        ),
      );
    else if (choice === "hide-pictures") {
      for (const picture of pictures) {
        const key = pictureKey(picture.url);
        if (key) hiddenPictures.hide(key);
      }
      toast(PICTURES_HIDDEN_DONE, "done");
    }
  };
  return (
    <>
      <PostMenu
        extra={extra}
        mine={mine}
        name={name}
        onChoose={onChoose}
        sheetTitle={mine ? "Your post" : undefined}
        stopped={false}
        teamCanRemove={false}
        teamCanStop={false}
      />
      {writing ? (
        <LazyComposer
          edit={writing === "edit" ? event : null}
          onOpenChange={setWritingOpen}
          open={writingOpen}
          quote={
            writing === "quote" ? { id: event.id, pubkey: event.pubkey } : null
          }
          title={writing === "edit" ? "Edit your post" : "Quote this post"}
        />
      ) : null}
      <Dialog
        description={DELETE_CAN}
        onOpenChange={setConfirmingDelete}
        open={confirmingDelete}
        testId="delete-dialog"
        title={DELETE_TITLE}
      >
        <p className="text-sm text-muted" data-testid="delete-cannot">
          {DELETE_CANNOT}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmingDelete(false)} variant="ghost">
            Keep post
          </Button>
          <Button
            data-testid="delete-confirm"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(event, {
                onSuccess: () => {
                  setConfirmingDelete(false);
                  toast(DELETED_DONE, "done");
                },
                onError: (error) => toast(error.message, "problem"),
              })
            }
            variant="secondary"
          >
            Delete post
          </Button>
        </div>
      </Dialog>
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
