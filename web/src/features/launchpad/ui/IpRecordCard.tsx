/**
 * Who holds the project's IP, on the launch page.
 *
 * Everyone sees where it stands, in plain words, and the documents the project
 * links for it. The project's author can change it. The wording comes from
 * `lib/ip-record.ts`, which only says what the documents on record support, and
 * this card adds who is saying it: the project, not the app and not a court.
 */

import { useState } from "react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  type IpDocument,
  type IpDraft,
  type IpHolder,
  type IpRecord,
  ipDraftFromRecord,
  ipRecordFromDraft,
  ipStanding,
  ipSummary,
} from "../lib/ip-record";
import { recordToInput } from "../lib/record-input";
import { effectiveStage, type Launch } from "../models";
import { useCreateLaunch } from "../use-launches";
import { IpDocumentField } from "./IpDocumentField";

const INPUT =
  "w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring dark:border-white/10 dark:bg-white/5";

const HOLDERS: { value: IpHolder; label: string; hint: string }[] = [
  {
    value: "founders",
    label: "No entity yet: the founders hold it",
    hint: "The usual start. You can sign a commitment to assign the IP to an entity once one is formed, and link it below.",
  },
  {
    value: "entity",
    label: "A legal entity holds it",
    hint: "Name the entity, and link the signed assignment of the IP to it.",
  },
  {
    value: "open",
    label: "Open: released under an open licence",
    hint: "Anyone may use the work. Nobody, holders included, holds exclusive rights.",
  },
];

const FINGERPRINT_NOTE =
  "A fingerprint is a short code made from a file. If the file changes, the code changes, so anyone can tell.";

const shortFingerprint = (sha256: string) =>
  `${sha256.slice(0, 8)}…${sha256.slice(-6)}`;

function DocumentLine({ label, doc }: { label: string; doc: IpDocument }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 text-sm">
      <span className="text-black/60 dark:text-white/60">{label}</span>
      <a
        className="break-all text-primary-ink underline-offset-4 hover:underline"
        href={doc.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {doc.title}
      </a>
      <span className="font-mono text-2xs text-black/60 dark:text-white/60">
        Fingerprint {shortFingerprint(doc.sha256)}
      </span>
    </li>
  );
}

function Standing({
  record,
  raised,
  explainFingerprint,
}: {
  record: IpRecord | null;
  raised: boolean;
  /** The editor already explains fingerprints, so the card says it once. */
  explainFingerprint: boolean;
}) {
  const standing = ipStanding(record, raised);
  const summary = ipSummary(standing, record);
  const strong = standing === "entity-assigned";
  return (
    <div data-testid="ip-standing" data-standing={standing}>
      <p
        className={`text-sm font-medium ${
          strong
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-amber-700 dark:text-amber-300"
        }`}
        data-testid="ip-headline"
      >
        {summary.headline}
      </p>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {summary.detail}
      </p>
      {record?.entity ? (
        <p className="mt-2 text-sm" data-testid="ip-entity">
          <span className="text-black/60 dark:text-white/60">Entity: </span>
          {record.entity.name}, {record.entity.jurisdiction}
          {record.entity.registration
            ? ` (registration ${record.entity.registration})`
            : ""}
        </p>
      ) : null}
      {record?.assignment || record?.operating || record?.contributorTerms ? (
        <ul
          className="mt-2 divide-y divide-black/10 dark:divide-white/10"
          data-testid="ip-documents"
        >
          {record.assignment ? (
            <DocumentLine
              doc={record.assignment}
              label={
                record.holder === "entity"
                  ? "Assignment of the IP to the entity"
                  : "Founders' commitment to assign the IP"
              }
            />
          ) : null}
          {record.operating ? (
            <DocumentLine
              doc={record.operating}
              label="How holders direct the entity"
            />
          ) : null}
          {record.contributorTerms ? (
            <DocumentLine
              doc={record.contributorTerms}
              label="Terms for contributors"
            />
          ) : null}
        </ul>
      ) : null}
      {(record?.assignment || record?.operating || record?.contributorTerms) &&
      explainFingerprint ? (
        <p className="mt-2 text-xs text-black/60 dark:text-white/60">
          {FINGERPRINT_NOTE}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-black/60 dark:text-white/60">
        This is the project's own statement. The documents are linked and pinned
        by a fingerprint so they cannot change quietly, but the app has not read
        them or checked who signed them, and none of this is legal advice. A
        token on its own does not carry IP.
      </p>
    </div>
  );
}

function Editor({ launch, onDone }: { launch: Launch; onDone: () => void }) {
  const save = useCreateLaunch();
  const [draft, setDraft] = useState<IpDraft>(() =>
    ipDraftFromRecord(launch.record.ipRecord),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const patch = (next: Partial<IpDraft>) =>
    setDraft((d) => ({ ...d, ...next }));

  const submit = async () => {
    const made = ipRecordFromDraft(draft);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    setProblem(null);
    try {
      // Every other field the record holds is carried through the save.
      await save.mutateAsync(
        recordToInput(launch.record, { ipRecord: made.record }),
      );
      toast.success("Saved");
      onDone();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Couldn't save that. Try again.",
      );
    }
  };

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      data-testid="ip-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Who holds the IP</legend>
        {HOLDERS.map((option) => (
          <label className="flex items-start gap-2 text-sm" key={option.value}>
            <input
              checked={draft.holder === option.value}
              className="mt-1"
              data-testid={`ip-holder-${option.value}`}
              name="ip-holder"
              onChange={() => patch({ holder: option.value })}
              type="radio"
            />
            <span>
              {option.label}
              <span className="block text-xs text-black/60 dark:text-white/60">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {draft.holder === "open" ? (
        <label className="flex flex-col gap-1 text-xs">
          Licence
          <input
            className={INPUT}
            data-testid="ip-licence"
            onChange={(event) => patch({ licence: event.target.value })}
            placeholder="MIT, Apache-2.0, CC-BY-4.0"
            value={draft.licence}
          />
        </label>
      ) : null}

      {draft.holder === "entity" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs">
            Entity name
            <input
              className={INPUT}
              data-testid="ip-entity-name"
              onChange={(event) => patch({ entityName: event.target.value })}
              value={draft.entityName}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Where it is registered
            <input
              className={INPUT}
              data-testid="ip-entity-place"
              onChange={(event) => patch({ entityPlace: event.target.value })}
              value={draft.entityPlace}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Registration number (optional)
            <input
              className={INPUT}
              data-testid="ip-entity-registration"
              onChange={(event) =>
                patch({ entityRegistration: event.target.value })
              }
              value={draft.entityRegistration}
            />
          </label>
        </div>
      ) : null}

      <p className="text-xs text-black/60 dark:text-white/60">
        {FINGERPRINT_NOTE}
      </p>
      {draft.holder !== "open" ? (
        <IpDocumentField
          hint={
            draft.holder === "entity"
              ? "The signed assignment of the project's IP to the entity. It can be written to take effect once the sale completes."
              : "The founders' signed commitment to assign the IP to an entity once one is formed."
          }
          label={
            draft.holder === "entity"
              ? "Assignment to the entity"
              : "Commitment to assign"
          }
          onChange={(assignment) => patch({ assignment })}
          slot="assignment"
          value={draft.assignment}
        />
      ) : null}
      {draft.holder === "entity" ? (
        <IpDocumentField
          hint="The entity's operating agreement: how it acts on holders' decisions."
          label="Operating agreement"
          onChange={(operating) => patch({ operating })}
          slot="operating"
          value={draft.operating}
        />
      ) : null}
      <IpDocumentField
        hint="What each contributor agrees to about their work, for example that it is assigned to the entity."
        label="Terms for contributors"
        onChange={(contributorTerms) => patch({ contributorTerms })}
        slot="terms"
        value={draft.contributorTerms}
      />

      {problem ? (
        <p
          className="text-xs text-destructive"
          data-testid="ip-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="ip-save"
          disabled={save.isPending}
          size="sm"
          type="submit"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function IpRecordCard({ launch }: { launch: Launch }) {
  const [editing, setEditing] = useState(false);
  const me = existingUserPubkey();
  const mine =
    me !== null && me.toLowerCase() === launch.record.author.toLowerCase();
  const raised = effectiveStage(launch) === "graduated";

  return (
    <Card className="p-4" data-testid="ip-card">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold">Who holds the IP</h2>
        {mine && !editing ? (
          <Button
            data-testid="ip-edit"
            onClick={() => setEditing(true)}
            size="sm"
            variant="outline"
          >
            Edit
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        IP means the rights to the project&apos;s work, such as its code, name
        and designs.
      </p>
      <div className="mt-2">
        <Standing
          explainFingerprint={!editing}
          raised={raised}
          record={launch.record.ipRecord}
        />
      </div>
      {editing ? (
        <Editor launch={launch} onDone={() => setEditing(false)} />
      ) : null}
    </Card>
  );
}
