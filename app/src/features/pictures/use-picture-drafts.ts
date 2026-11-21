/**
 * The pictures in a post being written: each is made ready on this phone as soon as it is picked (drawn again, shrunk,
 * cleaned of hidden details), described by the writer, and sent to the server only when the post is sent. A picture that
 * has been sent stays sent, so trying again after a failure never uploads it twice; a failure keeps every picture and every
 * description. Bounded: at most {@link MAX_PICTURES} pictures, each made ready once.
 */
import { uploadFailureWords } from "@creaton/core/client/media-refusal.ts";
import {
  cleanAlt,
  MAX_PICTURES,
  type PostPicture,
} from "@creaton/core/social/pictures.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type UploadedBlob, uploadPicture } from "../../lib/upload";
import { type CleanPicture, cleanPicture } from "./clean-picture";
import { UPLOAD_KEPT } from "./picture-words";

export interface DraftPicture {
  key: string;
  alt: string;
  /** Held on this phone, made ready, not sent yet. */
  local: (CleanPicture & { preview: string }) | null;
  /** Kept on the server (sent now, or already part of the post being edited). */
  sent: PostPicture | null;
}

let counter = 0;
const nextKey = () => `picture-${++counter}`;

/** The words for a picture that could not be made ready or sent. */
function pictureProblemWords(error: unknown): string {
  return uploadFailureWords(
    error,
    "That picture could not be used. Try another one.",
  ).text;
}

export function usePictureDrafts(initial: readonly PostPicture[] = []) {
  const [drafts, setDrafts] = useState<DraftPicture[]>(() =>
    initial.map((picture) => ({
      key: nextKey(),
      alt: picture.alt,
      local: null,
      sent: picture,
    })),
  );
  const [preparing, setPreparing] = useState(0);
  const latest = useRef(drafts);
  latest.current = drafts;
  const previews = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
      previews.current.clear();
    },
    [],
  );

  /** Make each file ready and add it; returns the words for the first one that could not be (or null). */
  const add = useCallback(
    async (files: readonly File[]): Promise<string | null> => {
      let problem: string | null = null;
      for (const file of files) {
        // Counted after each one is added, so a long pick never goes past the limit.
        if (latest.current.length >= MAX_PICTURES) {
          problem ??= `A post can have up to ${MAX_PICTURES} pictures.`;
          break;
        }
        setPreparing((n) => n + 1);
        try {
          const clean = await cleanPicture(file);
          if (latest.current.length >= MAX_PICTURES) {
            problem ??= `A post can have up to ${MAX_PICTURES} pictures.`;
            break;
          }
          const preview = URL.createObjectURL(
            new Blob([clean.bytes as BlobPart], { type: clean.mime }),
          );
          previews.current.add(preview);
          const draft: DraftPicture = {
            key: nextKey(),
            alt: "",
            local: { ...clean, preview },
            sent: null,
          };
          latest.current = [...latest.current, draft];
          setDrafts(latest.current);
        } catch (error) {
          problem ??=
            error instanceof Error ? error.message : pictureProblemWords(error);
        } finally {
          setPreparing((n) => n - 1);
        }
      }
      return problem;
    },
    [],
  );

  const remove = useCallback((key: string) => {
    const gone = latest.current.find((d) => d.key === key);
    if (gone?.local) {
      URL.revokeObjectURL(gone.local.preview);
      previews.current.delete(gone.local.preview);
    }
    latest.current = latest.current.filter((d) => d.key !== key);
    setDrafts(latest.current);
  }, []);

  /** Forget every picture (after the post was sent). */
  const clear = useCallback(() => {
    for (const draft of latest.current) {
      if (draft.local) {
        URL.revokeObjectURL(draft.local.preview);
        previews.current.delete(draft.local.preview);
      }
    }
    latest.current = [];
    setDrafts(latest.current);
  }, []);

  const setAlt = useCallback((key: string, alt: string) => {
    latest.current = latest.current.map((d) =>
      d.key === key ? { ...d, alt } : d,
    );
    setDrafts(latest.current);
  }, []);

  /**
   * Send every picture not yet on the server, one after another, and return them as the post carries them. A picture that
   * is sent is remembered at once, so a failure part way keeps what was sent; the failure throws the words to show.
   */
  const upload = useCallback(async (): Promise<PostPicture[]> => {
    const out: PostPicture[] = [];
    for (const draft of [...latest.current]) {
      let sent = draft.sent;
      if (!sent && draft.local) {
        let stored: UploadedBlob;
        try {
          stored = await uploadPicture(draft.local.bytes, draft.local.mime);
        } catch (error) {
          throw new Error(`${UPLOAD_KEPT} ${pictureProblemWords(error)}`);
        }
        sent = {
          url: stored.url,
          alt: "",
          mime: draft.local.mime,
          sha256: stored.sha256,
          width: draft.local.width,
          height: draft.local.height,
        };
        const kept = sent;
        latest.current = latest.current.map((d) =>
          d.key === draft.key ? { ...d, sent: kept } : d,
        );
        setDrafts(latest.current);
      }
      if (sent)
        out.push({
          ...sent,
          alt: cleanAlt(
            latest.current.find((d) => d.key === draft.key)?.alt ?? draft.alt,
          ),
        });
    }
    return out;
  }, []);

  return useMemo(
    () => ({ drafts, preparing, add, remove, clear, setAlt, upload }),
    [drafts, preparing, add, remove, clear, setAlt, upload],
  );
}
