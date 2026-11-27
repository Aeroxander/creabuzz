import { MAX_POST_CHARS } from "@creaton/core/social/feed/feed-events.ts";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { UnlockPress } from "../account/UnlockPress";
import { POSTED_DONE } from "./post-words";
import { usePublishComposed } from "./use-posts";

/**
 * Writing a post, in a sheet over the screen: words, about a project when `launch` is given. A failure keeps what was
 * typed.
 */
export function ComposerSheet({
  open,
  onOpenChange,
  launch,
  title = "Write a post",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launch?: { pubkey: string; id: string } | null;
  title?: string;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { locked } = useAccount();
  const publish = usePublishComposed();
  const toast = useToast();
  const tooLong = text.length > MAX_POST_CHARS;

  const send = async () => {
    setProblem(null);
    try {
      await publish.mutateAsync({ text, launch: launch ?? null });
      setText("");
      onOpenChange(false);
      toast(POSTED_DONE, "done");
    } catch (error) {
      // Nothing typed is lost: the box stays as it is, with the reason.
      setProblem(
        error instanceof Error
          ? error.message
          : "Your post was not sent. Try again.",
      );
    }
  };

  return (
    <Sheet
      description="Posts are public."
      onOpenChange={onOpenChange}
      open={open}
      testId="composer"
      title={title}
    >
      <TextArea
        count={{ used: text.length, max: MAX_POST_CHARS }}
        data-testid="composer-text"
        label="What's new?"
        onChange={(e) => setText(e.target.value)}
        problem={tooLong ? "That is longer than a post can be." : null}
        rows={5}
        value={text}
      />
      {locked ? (
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm"
          data-testid="composer-locked"
        >
          <span>Unlock with your passkey to post. What you typed is kept.</span>
          <UnlockPress testId="composer-unlock" />
        </div>
      ) : null}
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="composer-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="composer-send"
        disabled={!text.trim() || tooLong || publish.isPending}
        onClick={() => void send()}
      >
        {publish.isPending ? "Sending…" : "Post"}
      </Button>
    </Sheet>
  );
}
