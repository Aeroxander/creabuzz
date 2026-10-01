import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { useContacts, useToggleFollow } from "../use-social";

export function FollowButton({
  viewer,
  target,
  size,
}: {
  viewer: string;
  target: string;
  size?: "default" | "sm";
}) {
  const following = useContacts(viewer).data?.includes(target) ?? false;
  const toggle = useToggleFollow(viewer);
  const [hover, setHover] = useState(false);
  return (
    <Button
      size={size}
      variant={following ? "outline" : "default"}
      className={cn(
        "rounded-full px-4 font-bold",
        following &&
          hover &&
          "border-destructive/50 bg-destructive/10 text-destructive",
        !following && "bg-foreground text-background hover:bg-foreground/90",
      )}
      aria-pressed={following}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() =>
        toggle.mutate(
          { value: target, add: !following },
          { onError: (e) => toast.error(e.message) },
        )
      }
    >
      {following ? (hover ? "Unfollow" : "Following") : "Follow"}
    </Button>
  );
}
