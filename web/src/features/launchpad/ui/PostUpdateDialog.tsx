import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  HELP_SIZE_LABEL,
  HELP_SIZES,
  type HelpSize,
  PART_HEADINGS,
  UPDATE_LIMITS,
  type UpdateDraft,
} from "../lib/weekly-update";
import { Modal } from "./Modal";

const AREA_CLASS =
  "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white";

/**
 * Founder flow: one signed update into the project's feed. Three light prompts shape it (what happened, what's next,
 * help needed); they are only prompts, and "Write freely" swaps the first two for one open box. Asking for help adds a
 * card people can answer with "I can help".
 */
export function PostUpdateDialog({
  isPublishing,
  failed,
  onClose,
  onPublish,
}: {
  isPublishing: boolean;
  /** The last publish did not go through: said in the dialog, with what was written kept. */
  failed: boolean;
  onClose: () => void;
  onPublish: (draft: UpdateDraft) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [freely, setFreely] = useState(false);
  const [done, setDone] = useState("");
  const [next, setNext] = useState("");
  const [body, setBody] = useState("");
  const [help, setHelp] = useState("");
  const [helpSize, setHelpSize] = useState<HelpSize>("small");
  const [helpTime, setHelpTime] = useState("");
  const headingId = useId();
  const asksHelp = help.trim() !== "";

  const publish = () =>
    void onPublish({
      title: title.trim(),
      // Only the boxes on screen are sent: words left in the hidden ones are not published behind the founder's back.
      done: freely ? "" : done,
      next: freely ? "" : next,
      body: freely ? body : "",
      help,
      helpSize,
      helpTime: asksHelp ? helpTime : "",
    });

  return (
    <Modal label="Post update" labelledBy={headingId} onClose={onClose}>
      <h2
        className="text-lg font-semibold text-black dark:text-white"
        id={headingId}
      >
        Post update
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Everyone following the project can read this. A few lines each week is
        enough.
      </p>
      {/* Not a form: Enter in the title must not publish a half-written update. */}
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="update-title">
            Title
          </label>
          <Input
            id="update-title"
            className="mt-1"
            maxLength={UPDATE_LIMITS.title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="This week in one line"
            value={title}
          />
        </div>
        {freely ? (
          <div>
            <label className="text-sm font-medium" htmlFor="update-body">
              Your update
            </label>
            <textarea
              id="update-body"
              className={AREA_CLASS}
              maxLength={UPDATE_LIMITS.part * 2}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What you finished, who helped, and what's next."
              rows={5}
              value={body}
            />
          </div>
        ) : (
          <>
            <div>
              <label className="text-sm font-medium" htmlFor="update-done">
                {PART_HEADINGS.done}
              </label>
              <textarea
                id="update-done"
                className={AREA_CLASS}
                maxLength={UPDATE_LIMITS.part}
                onChange={(e) => setDone(e.target.value)}
                placeholder="What you finished, and who helped."
                rows={3}
                value={done}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="update-next">
                {PART_HEADINGS.next}
              </label>
              <textarea
                id="update-next"
                className={AREA_CLASS}
                maxLength={UPDATE_LIMITS.part}
                onChange={(e) => setNext(e.target.value)}
                placeholder="What you plan to do before the next update."
                rows={2}
                value={next}
              />
            </div>
          </>
        )}
        <div>
          {/* The label says what a press does next; it is not also a pressed state, which would say it twice. */}
          <Button
            className="h-auto p-0"
            data-testid="update-write-freely"
            onClick={() => setFreely((was) => !was)}
            size="sm"
            type="button"
            variant="link"
          >
            {freely ? "Use the weekly prompts" : "Write freely instead"}
          </Button>
        </div>
        <div className="rounded-xl border border-border p-3">
          <label className="text-sm font-medium" htmlFor="update-help">
            {PART_HEADINGS.help} (optional)
          </label>
          <p className="text-xs text-muted-foreground" id="update-help-hint">
            Say what you need. People can answer with "I can help", and you see
            who offered.
          </p>
          <textarea
            aria-describedby="update-help-hint"
            id="update-help"
            className={AREA_CLASS}
            maxLength={UPDATE_LIMITS.help}
            onChange={(e) => setHelp(e.target.value)}
            placeholder="For example: someone to test sign-up on an older phone."
            rows={2}
            value={help}
          />
          {asksHelp ? (
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <fieldset className="m-0 min-w-0 p-0">
                <legend className="text-sm font-medium">How big is it?</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {HELP_SIZES.map((size) => (
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      key={size}
                    >
                      <input
                        checked={helpSize === size}
                        name="update-help-size"
                        onChange={() => setHelpSize(size)}
                        type="radio"
                        value={size}
                      />
                      {HELP_SIZE_LABEL[size]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="min-w-0 flex-1">
                <label
                  className="text-sm font-medium"
                  htmlFor="update-help-time"
                >
                  Rough time (optional)
                </label>
                <Input
                  id="update-help-time"
                  className="mt-1"
                  maxLength={UPDATE_LIMITS.helpTime}
                  onChange={(e) => setHelpTime(e.target.value)}
                  placeholder="about 3 days"
                  value={helpTime}
                />
              </div>
            </div>
          ) : null}
        </div>
        {failed && !isPublishing ? (
          <p
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="update-publish-failed"
            role="alert"
          >
            Your update was not published. What you wrote is still here.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {title.trim() === "" ? (
            <p
              className="mr-auto text-xs text-muted-foreground"
              data-testid="update-needs-title"
            >
              Add a title to publish.
            </p>
          ) : null}
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={title.trim() === "" || isPublishing}
            onClick={publish}
            type="button"
          >
            {isPublishing
              ? "Publishing…"
              : failed
                ? "Try again"
                : "Publish update"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
