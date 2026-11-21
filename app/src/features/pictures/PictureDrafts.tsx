/**
 * The pictures in the writing box: each as a small preview, a labelled box to describe it (for people who use a screen
 * reader; it is asked for and can be left empty, with a plain note saying what that means) and a press to remove it.
 */
import { MAX_ALT_CHARS } from "@creaton/core/social/pictures.ts";
import { X } from "lucide-react";
import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { ServerPicture } from "./PostPictures";
import { ALT_HINT, ALT_MISSING } from "./picture-words";
import type { DraftPicture } from "./use-picture-drafts";

export function PictureDrafts({
  drafts,
  onAlt,
  onRemove,
}: {
  drafts: readonly DraftPicture[];
  onAlt: (key: string, alt: string) => void;
  onRemove: (key: string) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3" data-testid="draft-pictures">
      {drafts.map((draft, index) => (
        <li
          className="plain flex items-start gap-3 rounded-2xl p-3"
          data-testid="draft-picture"
          key={draft.key}
        >
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-white/10">
            {draft.local ? (
              <img
                alt=""
                className="h-full w-full object-cover"
                src={draft.local.preview}
              />
            ) : draft.sent ? (
              <ServerPicture
                alt=""
                className="h-20 w-20"
                url={draft.sent.url}
              />
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <Field
              data-testid="draft-picture-alt"
              hint={draft.alt.trim() ? ALT_HINT : ALT_MISSING}
              label={`Describe picture ${index + 1}`}
              maxLength={MAX_ALT_CHARS}
              onChange={(e) => onAlt(draft.key, e.target.value)}
              value={draft.alt}
            />
          </div>
          <Button
            aria-label={`Remove picture ${index + 1}`}
            data-testid="draft-picture-remove"
            onClick={() => onRemove(draft.key)}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </li>
      ))}
    </ul>
  );
}
