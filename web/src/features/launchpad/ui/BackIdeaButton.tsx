/**
 * "Follow": the free way to support a project that has no Shares yet. It follows the project (the signal the supporter
 * count reads, and what puts its updates in the person's Home) and joins the open supporters room, so a single click
 * puts a person in the conversation.
 */

import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

import { useJoinRoom } from "../use-launch-chat";

export function BackIdeaButton({
  supportersRoom,
  followed,
  disabled,
  onToggle,
}: {
  supportersRoom: string | null;
  followed: boolean;
  disabled: boolean;
  /** Follow or unfollow; `onDone` runs once the change was accepted. */
  onToggle(onDone?: () => void): void;
}) {
  const join = useJoinRoom(supportersRoom);
  const onClick = () => {
    if (followed) {
      onToggle();
      return;
    }
    onToggle(() => {
      if (!supportersRoom) return;
      join.mutate(undefined, {
        onError: () =>
          toast.error(
            "You follow the project, but the supporters room did not open. Use Join in the chat card.",
          ),
      });
    });
  };
  return (
    <Button
      data-testid="launch-back-idea"
      disabled={disabled}
      onClick={onClick}
      variant={followed ? "outline" : "default"}
    >
      {followed ? "Following" : "Follow"}
    </Button>
  );
}
