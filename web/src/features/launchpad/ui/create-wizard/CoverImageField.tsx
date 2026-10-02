/**
 * A launch's cover image: upload a file to this server, or paste a link.
 *
 * The value is a web URL either way, so a record never carries image bytes.
 * A bad upload leaves the previous value alone and says what to do next.
 */

import { ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";

import { uploadBlob } from "@/shared/lib/upload-blob";
import { Button } from "@/shared/ui/button";

export function CoverImageField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadBlob(file);
      setBroken(false);
      onChange(uploaded.url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That upload did not go through. Try again, or paste a link.",
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div data-testid="launch-cover-field">
      <label className="text-sm font-medium" htmlFor="launch-cover-url">
        Cover image
      </label>
      <div className="mt-1 flex items-center gap-3">
        <div className="grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-border bg-foreground/[0.04]">
          {value && !broken ? (
            <img
              alt=""
              className="h-full w-full object-cover"
              onError={() => setBroken(true)}
              src={value}
            />
          ) : (
            <ImagePlus aria-hidden className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <input
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus:border-ring focus:outline-none"
            id="launch-cover-url"
            inputMode="url"
            onChange={(event) => {
              setBroken(false);
              onChange(event.target.value);
            }}
            placeholder="Paste an image link"
            type="url"
            value={value}
          />
          <div className="flex items-center gap-2">
            <input
              accept="image/*"
              className="sr-only"
              data-testid="launch-cover-file"
              onChange={(event) => void onFile(event.target.files?.[0])}
              ref={fileInput}
              tabIndex={-1}
              type="file"
            />
            <Button
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              {busy ? "Uploading…" : "Upload image"}
            </Button>
            {value ? (
              <Button
                onClick={() => {
                  setBroken(false);
                  onChange("");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden className="mr-1 h-3.5 w-3.5" /> Remove
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {broken ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          That link did not load as an image. Backers will see a generated cover
          instead.
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
