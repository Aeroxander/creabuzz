/**
 * One document on the IP record: a title, a link, and a fingerprint of the
 * document's bytes. Choosing the file fingerprints it here in the browser (the
 * file is not uploaded), so nobody has to copy a long hash by hand; the link is
 * where readers will find it.
 */

import { useState } from "react";

import { sha256Hex } from "../lib/file-hash";
import type { IpDocumentDraft } from "../lib/ip-record";

const INPUT =
  "w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring dark:border-white/10 dark:bg-white/5";

export function IpDocumentField({
  slot,
  label,
  hint,
  value,
  onChange,
}: {
  /** Names the test ids, e.g. "assignment". */
  slot: string;
  label: string;
  hint: string;
  value: IpDocumentDraft;
  onChange: (next: IpDocumentDraft) => void;
}) {
  const [hashing, setHashing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const fingerprint = async (file: File | undefined) => {
    if (!file) return;
    setHashing(true);
    setProblem(null);
    try {
      onChange({
        ...value,
        title: value.title || file.name.replace(/\.[^.]+$/, ""),
        sha256: await sha256Hex(file),
      });
    } catch {
      setProblem("Couldn't read that file. Paste its fingerprint instead.");
    } finally {
      setHashing(false);
    }
  };

  return (
    <fieldset
      className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid={`ip-doc-${slot}`}
    >
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <p className="text-xs text-black/60 dark:text-white/60">{hint}</p>
      <label className="flex flex-col gap-1 text-xs">
        Title
        <input
          className={INPUT}
          data-testid={`ip-doc-${slot}-title`}
          onChange={(event) =>
            onChange({ ...value, title: event.target.value })
          }
          value={value.title}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Link (https)
        <input
          className={INPUT}
          data-testid={`ip-doc-${slot}-url`}
          inputMode="url"
          onChange={(event) => onChange({ ...value, url: event.target.value })}
          placeholder="https://"
          value={value.url}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Choose a file to fill in its fingerprint
        <input
          accept=".pdf,.txt,.md,.doc,.docx"
          data-testid={`ip-doc-${slot}-file`}
          disabled={hashing}
          onChange={(event) => void fingerprint(event.target.files?.[0])}
          type="file"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Fingerprint (SHA-256)
        <input
          className={`${INPUT} font-mono`}
          data-testid={`ip-doc-${slot}-hash`}
          onChange={(event) =>
            onChange({ ...value, sha256: event.target.value.trim() })
          }
          value={value.sha256}
        />
      </label>
      {problem ? (
        <p className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}
