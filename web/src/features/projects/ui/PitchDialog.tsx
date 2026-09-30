/**
 * Pitch creation: name, one-line pitch, description, the role the founder
 * takes, and the open roles with their target stakes.
 *
 * Three sources, one record: a standalone project (org node + pitch), an
 * already-published org node (pitch only), or an existing launch (node id =
 * launch id, so the detail page can deep-link back to `/launchpad/$id`).
 *
 * Publishing is two writes for a new project (node, then pitch). A failure
 * between them is surfaced as exactly that — the node landed, the pitch did
 * not — with a pitch-only retry, never as success (`PitchPublishError`,
 * Review-Proven Rule 1).
 */

import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { existingUserPubkey, userPubkey } from "@/shared/lib/identity";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  MAX_ROLES,
  MAX_SUMMARY_LEN,
  PitchValidationError,
  POOL_PCT,
  buildPitchTemplate,
  slugify,
  type PitchInput,
  type RoleDeclaration,
} from "../lib/manifest";
import {
  PitchPublishError,
  useCreatePitch,
  useProjectEvents,
  type CreatePitchInput,
} from "../use-projects";

type Mode = "new" | "node" | "launch";

interface RoleRow {
  /** Stable React key — row identity survives adds and removes. */
  uid: number;
  label: string;
  pct: string;
}

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: "new",
    label: "New project",
    hint: "Creates the org node and the pitch.",
  },
  {
    id: "node",
    label: "Existing org node",
    hint: "Pins a pitch to a node that already exists.",
  },
  {
    id: "launch",
    label: "From a launch",
    hint: "The launch's id becomes the project id.",
  },
];

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        className="text-sm font-medium text-black dark:text-white"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p
          className="mt-1 text-xs text-red-600 dark:text-red-400"
          data-testid={`${id}-error`}
        >
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">{hint}</p>
      ) : null}
    </div>
  );
}

function RoleRowInputs({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: RoleRow;
  index: number;
  onChange: (next: RoleRow) => void;
  onRemove?: () => void;
}) {
  const slug = slugify(row.label);
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Field
          id={`role-label-${index}`}
          label={index === 0 ? "Your role" : `Role ${index}`}
        >
          <Input
            id={`role-label-${index}`}
            onChange={(e) => onChange({ ...row, label: e.target.value })}
            placeholder="The writer"
            value={row.label}
          />
        </Field>
        <p className="mt-1 text-2xs text-black/50 dark:text-white/50">
          {slug ? (
            <>
              id: <code className="font-mono">{slug}</code>
            </>
          ) : (
            "letters, digits and dashes become the id"
          )}
        </p>
      </div>
      <div className="w-24">
        <Field id={`role-pct-${index}`} label="Stake %">
          <Input
            id={`role-pct-${index}`}
            inputMode="numeric"
            max={100}
            min={1}
            onChange={(e) => onChange({ ...row, pct: e.target.value })}
            type="number"
            value={row.pct}
          />
        </Field>
      </div>
      {onRemove ? (
        <button
          aria-label={`Remove role ${row.label || index + 1}`}
          className="mb-2 rounded-md p-1.5 text-black/40 hover:bg-black/5 hover:text-black dark:text-white/40 dark:hover:bg-white/10"
          onClick={onRemove}
          type="button"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function PitchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreatePitch();
  const { data: events } = useProjectEvents();
  const launches = useLaunches();

  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const nextUid = useRef(2);
  const [myRole, setMyRole] = useState<RoleRow>({
    uid: 0,
    label: "The founder",
    pct: "40",
  });
  const [openRoles, setOpenRoles] = useState<RoleRow[]>([
    { uid: 1, label: "The writer", pct: "12" },
  ]);
  const [selectedNode, setSelectedNode] = useState("");
  const [selectedLaunch, setSelectedLaunch] = useState("");
  const [fieldError, setFieldError] = useState<{
    field: string;
    message: string;
  } | null>(null);
  const [lastInput, setLastInput] = useState<CreatePitchInput | null>(null);

  // Only your own nodes: the pitch's author becomes the project's founder,
  // so pinning a pitch to someone else's node would misattribute the seat
  // structure (node ids are unique per author, not globally). Read-side only —
  // `existingUserPubkey` never mints an identity just to filter a picker.
  const myPubkey = existingUserPubkey();
  const existingNodes = (events?.nodes ?? [])
    .filter((node) => node.pubkey === myPubkey)
    .map((node) => {
      const d = node.tags.find((t) => t[0] === "d")?.[1] ?? "";
      const nodeName = node.tags.find((t) => t[0] === "name")?.[1] ?? d;
      return { id: d, name: nodeName, author: node.pubkey };
    });

  const derivedId = idTouched ? nodeId : (slugify(name) ?? "");
  const effectiveId =
    mode === "node"
      ? selectedNode
      : mode === "launch"
        ? selectedLaunch
        : derivedId;
  const declaredPool =
    (Number(myRole.pct) || 0) +
    openRoles.reduce((total, role) => total + (Number(role.pct) || 0), 0);

  function pickLaunch(launchId: string) {
    setSelectedLaunch(launchId);
    const launch = launches.data?.find((l) => l.record.id === launchId);
    if (!launch) return;
    if (!name) setName(launch.record.name);
    if (!summary && launch.record.pitch) {
      setSummary(launch.record.pitch.slice(0, MAX_SUMMARY_LEN));
    }
    setNodeId(launch.record.id);
    setIdTouched(true);
  }

  function submit() {
    setFieldError(null);
    const founderSlug = slugify(myRole.label) ?? "";
    const roles: RoleDeclaration[] = [
      {
        slug: founderSlug,
        label: myRole.label.trim(),
        pct: Number(myRole.pct),
      },
      ...openRoles.map((role) => ({
        slug: slugify(role.label) ?? "",
        label: role.label.trim(),
        pct: Number(role.pct),
      })),
    ];
    const pitch: PitchInput = {
      nodeId: effectiveId.trim(),
      name: name.trim(),
      summary: summary.trim(),
      description,
      founderRole: founderSlug,
      roles,
    };
    // New project: publish the node too. Attach mode: the node exists.
    const node =
      mode === "node"
        ? null
        : { nodeId: pitch.nodeId, name: pitch.name, blurb: pitch.summary };
    try {
      // Validate before anything is published: a rejected pitch must not
      // leave a node behind.
      buildPitchTemplate(pitch);
    } catch (error) {
      if (error instanceof PitchValidationError) {
        setFieldError({ field: error.field, message: error.message });
        return;
      }
      throw error;
    }
    const input: CreatePitchInput = { pitch, node };
    setLastInput(input);
    create.mutate(input, {
      onSuccess: (result) => {
        onOpenChange(false);
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: result.nodeId },
          search: { action: undefined, author: userPubkey() },
        });
      },
      onError: (error) => {
        if (error instanceof PitchValidationError) {
          setFieldError({ field: error.field, message: error.message });
        }
      },
    });
  }

  const publishError = create.isError ? create.error : null;
  const partial =
    publishError instanceof PitchPublishError && publishError.nodePublished
      ? publishError
      : null;

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Pitch a project</AlertDialogTitle>
          <AlertDialogDescription>
            Say what it is, the role you take, and the roles you need. Declared
            stakes set the pool a joiner's recorded grant comes out of.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          className="flex flex-wrap gap-2"
          aria-label="Pitch source"
          role="tablist"
        >
          {MODES.map((option) => (
            <button
              aria-selected={mode === option.id}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium",
                mode === option.id
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "bg-black/5 text-black/60 hover:bg-black/10 dark:bg-white/10 dark:text-white/60 dark:hover:bg-white/15",
              )}
              key={option.id}
              onClick={() => setMode(option.id)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-2xs text-black/50 dark:text-white/50">
          {MODES.find((m) => m.id === mode)?.hint}
        </p>

        {mode === "node" ? (
          <Field
            error={fieldError?.field === "nodeId" ? fieldError.message : null}
            id="pitch-node"
            label="Org node"
          >
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              id="pitch-node"
              onChange={(e) => setSelectedNode(e.target.value)}
              value={selectedNode}
            >
              <option value="">Choose an org node…</option>
              {existingNodes.length === 0 ? (
                <option disabled value="__none">
                  No org node of yours yet — use “New project” first.
                </option>
              ) : (
                existingNodes.map((node) => (
                  <option key={`${node.author}:${node.id}`} value={node.id}>
                    {node.name} ({node.id})
                  </option>
                ))
              )}
            </select>
          </Field>
        ) : null}

        {mode === "launch" ? (
          <Field
            error={fieldError?.field === "nodeId" ? fieldError.message : null}
            id="pitch-launch"
            label="Launch"
            hint="Using the launch id keeps the project and the raise addressable as the same record."
          >
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              id="pitch-launch"
              onChange={(e) => pickLaunch(e.target.value)}
              value={selectedLaunch}
            >
              <option value="">Choose a launch…</option>
              {/* Your own launches only: the launch id becomes the project id,
                  so adopting a stranger's launch would bridge to their raise. */}
              {(launches.data ?? [])
                .filter((launch) => launch.record.author === myPubkey)
                .map((launch) => (
                  <option key={launch.record.id} value={launch.record.id}>
                    {launch.record.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}

        <Field
          error={fieldError?.field === "name" ? fieldError.message : null}
          id="pitch-name"
          label="Project name"
        >
          <Input
            id="pitch-name"
            maxLength={MAX_NAME_LEN}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
        </Field>

        {mode === "new" ? (
          <Field
            error={fieldError?.field === "nodeId" ? fieldError.message : null}
            hint="Stable id — it keys the project's org node, requests, and grants."
            id="pitch-id"
            label="Project id"
          >
            <Input
              id="pitch-id"
              onChange={(e) => {
                setIdTouched(true);
                setNodeId(e.target.value);
              }}
              value={derivedId}
            />
          </Field>
        ) : null}

        <Field
          error={fieldError?.field === "summary" ? fieldError.message : null}
          id="pitch-summary"
          label="One-line pitch"
          hint={`${summary.length}/${MAX_SUMMARY_LEN}`}
        >
          <Input
            id="pitch-summary"
            maxLength={MAX_SUMMARY_LEN}
            onChange={(e) => setSummary(e.target.value)}
            value={summary}
          />
        </Field>

        <Field
          error={
            fieldError?.field === "description" ? fieldError.message : null
          }
          id="pitch-description"
          label="Description"
          hint={`${description.length}/${MAX_DESCRIPTION_LEN} — plain text for now`}
        >
          <textarea
            className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            id="pitch-description"
            maxLength={MAX_DESCRIPTION_LEN}
            onChange={(e) => setDescription(e.target.value)}
            value={description}
          />
        </Field>

        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <RoleRowInputs index={0} onChange={setMyRole} row={myRole} />
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-black dark:text-white">
                Roles you need
              </span>
              <span
                className={`text-2xs ${declaredPool > POOL_PCT ? "font-semibold text-red-600 dark:text-red-400" : "text-black/50 dark:text-white/50"}`}
                data-testid="pitch-pool"
              >
                {declaredPool}% of the {POOL_PCT}% pool declared
              </span>
            </div>
            {openRoles.map((role, index) => (
              <RoleRowInputs
                index={index + 1}
                key={role.uid}
                onChange={(next) =>
                  setOpenRoles((current) =>
                    current.map((row) => (row.uid === role.uid ? next : row)),
                  )
                }
                onRemove={() =>
                  setOpenRoles((current) =>
                    current.filter((row) => row.uid !== role.uid),
                  )
                }
                row={role}
              />
            ))}
            {fieldError?.field === "roles" ? (
              <p
                className="text-xs text-red-600 dark:text-red-400"
                data-testid="pitch-roles-error"
              >
                {fieldError.message}
              </p>
            ) : null}
            {openRoles.length < MAX_ROLES - 1 ? (
              <Button
                onClick={() =>
                  setOpenRoles((current) => [
                    ...current,
                    { uid: nextUid.current++, label: "", pct: "5" },
                  ])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus className="mr-1 h-3 w-3" aria-hidden /> Add a role
              </Button>
            ) : null}
          </div>
        </div>

        {partial ? (
          <div
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            data-testid="pitch-partial-error"
            role="alert"
          >
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Your project's org node is on the relay, but the pitch didn't
                send — it isn't on the board yet.{" "}
                <span className="text-black/60 dark:text-white/60">
                  {partial.message}
                </span>
              </span>
            </p>
            <Button
              className="mt-2"
              disabled={create.isPending}
              onClick={() =>
                lastInput && create.mutate({ ...lastInput, skipNode: true })
              }
              size="sm"
              type="button"
            >
              Retry the pitch
            </Button>
          </div>
        ) : publishError ? (
          <div
            className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
            data-testid="pitch-error"
          >
            <SignRecovery
              message={publishError.message}
              messageTestId="pitch-error-message"
              onUnlocked={() => lastInput && create.mutate(lastInput)}
              testId="pitch-sign-recovery"
            />
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
          <Button
            disabled={
              create.isPending ||
              (mode === "node" && !selectedNode) ||
              (mode === "launch" && !selectedLaunch)
            }
            onClick={submit}
            type="button"
          >
            {create.isPending ? "Publishing…" : "Publish pitch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
