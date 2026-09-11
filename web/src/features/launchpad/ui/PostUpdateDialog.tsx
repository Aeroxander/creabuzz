import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Modal } from "./Modal";

/** Founder flow: signed update event into the launch feed. */
export function PostUpdateDialog({
  isPublishing,
  onClose,
  onPublish,
}: {
  isPublishing: boolean;
  onClose: () => void;
  onPublish: (input: { title: string; body: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  return (
    <Modal label="Post update" onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Post update
      </h2>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="update-title">
            Title
          </label>
          <Input
            id="update-title"
            className="mt-1"
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Milestone 1 verified"
            value={title}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="update-body">
            Body
          </label>
          <textarea
            id="update-body"
            className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
            onChange={(e) => setBody(e.target.value)}
            placeholder="What shipped, what unlocked, what is next?"
            rows={4}
            value={body}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          disabled={title.trim() === "" || isPublishing}
          onClick={() =>
            void onPublish({ title: title.trim(), body: body.trim() })
          }
          type="button"
        >
          {isPublishing ? "Publishing…" : "Publish update"}
        </Button>
      </div>
    </Modal>
  );
}
