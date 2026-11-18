import { useChannelsQuery } from "@/features/channels/hooks";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export type PostUpdateForm = {
  title: string;
  body: string;
  channelId: string | null;
};

/** Founder flow: signed update event, optionally cross-posted to a channel. */
export function PostUpdateDialog({
  isPublishing,
  onPublish,
  onOpenChange,
  open,
  channels,
}: {
  isPublishing: boolean;
  onPublish: (input: PostUpdateForm) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  channels: string[];
}) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [channelId, setChannelId] = React.useState<string>("");
  const channelsQuery = useChannelsQuery();

  React.useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setChannelId(channels[0] ?? "");
    }
  }, [open, channels]);

  const channelOptions = React.useMemo(() => {
    const joined = channelsQuery.data ?? [];
    const linked = new Set(channels);
    return joined.filter((c) => linked.size === 0 || linked.has(c.id));
  }, [channelsQuery.data, channels]);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && isPublishing) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent aria-label="Post update">
        <DialogHeader>
          <DialogTitle>Post update</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-1 py-2">
          <div>
            <label className="text-sm font-medium" htmlFor="update-title">
              Title
            </label>
            <span className="mt-1 block">
              <Input
                id="update-title"
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Milestone 1 verified"
                value={title}
              />
            </span>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="update-body">
              Body
            </label>
            <span className="mt-1 block">
              <Textarea
                id="update-body"
                onChange={(e) => setBody(e.target.value)}
                placeholder="What shipped, what unlocked, what is next?"
                rows={4}
                value={body}
              />
            </span>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="update-channel">
              Cross-post to channel
            </label>
            <span className="mt-1 block">
              <select
                id="update-channel"
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
                onChange={(e) => setChannelId(e.target.value)}
                value={channelId}
              >
                <option value="">Don&apos;t cross-post</option>
                {channelOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name ?? c.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </span>
            <span className="mt-1 block text-2xs text-muted-foreground">
              The signed update always lands in the launch feed; cross-posting
              also drops it into the community timeline.
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={title.trim() === "" || isPublishing}
            onClick={() =>
              void onPublish({
                title: title.trim(),
                body: body.trim(),
                channelId: channelId === "" ? null : channelId,
              })
            }
            type="button"
          >
            {isPublishing ? "Publishing…" : "Publish update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
