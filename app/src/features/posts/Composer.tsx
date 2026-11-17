import { MAX_POST_CHARS } from "@creaton/core/social/feed/feed-events.ts";
import { useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { usePublishPost } from "./use-posts";

/** Writing a post, in a sheet over the screen. About a project when `launch` is given. */
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
  const publish = usePublishPost();
  const toast = useToast();
  const tooLong = text.length > MAX_POST_CHARS;
  const send = () => {
    publish.mutate(
      { text, launch: launch ?? null },
      {
        onSuccess: () => {
          setText("");
          onOpenChange(false);
          toast("Posted", "done");
        },
        onError: (error) => toast(error.message, "problem"),
      },
    );
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
      <Button
        block
        data-testid="composer-send"
        disabled={!text.trim() || tooLong || publish.isPending}
        onClick={send}
      >
        Post
      </Button>
    </Sheet>
  );
}
