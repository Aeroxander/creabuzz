/**
 * "I'd back this": the free way to support an idea. It follows the launch (the
 * signal the supporter count reads) and joins the open supporters room, so a
 * single click puts a person in the conversation.
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
            "You are in, but the supporters room did not open. Use Join in the chat card.",
          ),
      });
    });
  };
  return (
    <Button
      aria-pressed={followed}
      data-testid="launch-back-idea"
      disabled={disabled}
      onClick={onClick}
      variant={followed ? "outline" : "default"}
    >
      {followed ? "You're in ✓" : "I'd back this"}
    </Button>
  );
}
